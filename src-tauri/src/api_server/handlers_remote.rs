use std::ops::Bound;

use std::io;
use std::pin::Pin;
use std::sync::OnceLock;
use std::task::{Context, Poll};

use axum::{
    body::Body,
    extract::{Query, State as AxumState},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{Json, Response},
};
use bytes::Bytes;
use futures_util::{stream, Stream, StreamExt, TryStreamExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio_util::io::StreamReader;

use crate::remote::{ExecResult, LatencyProbeResult, RuntimeStatus};

use super::auth::{verify_auth, verify_session_access, verify_session_access_and_exists};
use super::field_catalog;
use super::guard::check_dangerous_command;
use super::openapi;
use super::{
    allowed_session_ids_snapshot, command_log_detail, friendly_error_detail, map_remote_error,
    push_log, push_log_with_response, response_log_preview, ApiError, ApiExecutionPermit,
    ApiServerState, MAX_UPLOAD_BODY,
};

pub(super) const MAX_API_EXEC_TIMEOUT_MS: u64 = 5 * 60_000;
pub(super) const MAX_API_COMMAND_BYTES: usize = 64 * 1024;
const MAX_API_BATCH_RETAINED_OUTPUT_BYTES: usize = 16 * 1024 * 1024;
static FIELD_CATALOG_CACHE: OnceLock<Result<CachedJsonDocument, String>> = OnceLock::new();
static OPENAPI_DOCUMENT_CACHE: OnceLock<Result<CachedJsonDocument, String>> = OnceLock::new();

// ─── Public types (re-exported from mod.rs) ────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionItem {
    pub session_id: String,
    pub name: String,
    pub host: String,
    pub connected: bool,
    pub sftp_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<RuntimeStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connected_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub file_type: String,
    pub size: u64,
    pub modified_at: String,
    pub permissions: String,
    pub owner: String,
}

// ─── Private types ─────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UploadResponse {
    success: bool,
    remote_path: String,
    size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    sha256: Option<String>,
}

type BoxDownloadStream = Pin<Box<dyn Stream<Item = Result<Bytes, io::Error>> + Send + 'static>>;

struct DownloadLogStream {
    inner: BoxDownloadStream,
    state: ApiServerState,
    detail: String,
    started: std::time::Instant,
    bytes_sent: u64,
    finished: bool,
}

impl DownloadLogStream {
    fn new(
        inner: BoxDownloadStream,
        state: ApiServerState,
        detail: String,
        started: std::time::Instant,
    ) -> Self {
        Self {
            inner,
            state,
            detail,
            started,
            bytes_sent: 0,
            finished: false,
        }
    }

    fn finish(&mut self, success: bool, suffix: Option<String>) {
        if self.finished {
            return;
        }
        self.finished = true;
        let state = self.state.clone();
        let detail = match suffix {
            Some(suffix) => format!("{} · {}", self.detail, suffix),
            None => format!("{} · 实际发送 {}B", self.detail, self.bytes_sent),
        };
        let duration_ms = elapsed_ms(self.started);
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                push_log(&state, "download", &detail, success, duration_ms).await;
            });
        }
    }
}

impl Stream for DownloadLogStream {
    type Item = Result<Bytes, io::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match self.inner.as_mut().poll_next(cx) {
            Poll::Ready(Some(Ok(chunk))) => {
                self.bytes_sent = self.bytes_sent.saturating_add(chunk.len() as u64);
                Poll::Ready(Some(Ok(chunk)))
            }
            Poll::Ready(Some(Err(error))) => {
                self.finish(false, Some(format!("传输失败: {error}")));
                Poll::Ready(Some(Err(error)))
            }
            Poll::Ready(None) => {
                self.finish(true, None);
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Drop for DownloadLogStream {
    fn drop(&mut self) {
        if !self.finished {
            self.finish(false, Some("客户端中断".to_string()));
        }
    }
}

/// raw PUT 上传 query。请求体必须是完整文件内容。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UploadRawQuery {
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    remote_path: String,
    #[serde(default)]
    sha256: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DownloadQuery {
    session_id: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionIdBody {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ExecBody {
    session_id: String,
    command: String,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    safety_mode: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LatencyBody {
    session_id: String,
    #[serde(default)]
    samples: Option<u8>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchExecItem {
    #[serde(default)]
    id: Option<String>,
    command: String,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BatchExecBody {
    session_id: String,
    commands: Vec<BatchExecItem>,
    #[serde(default)]
    parallel: bool,
    #[serde(default = "default_stop_on_error")]
    stop_on_error: bool,
    #[serde(default)]
    safety_mode: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchExecItemResult {
    index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<ExecResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn default_stop_on_error() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FilesQuery {
    session_id: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FilesPageQuery {
    session_id: String,
    path: String,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<u16>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FilesPageResponse {
    items: Vec<FileEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_cursor: Option<String>,
    has_more: bool,
}

pub(super) async fn require_auth(
    state: &ApiServerState,
    headers: &HeaderMap,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let key = state.api_key.read().await;
    verify_auth(headers, &key)
}

pub(super) async fn acquire_execution_permit(
    state: &ApiServerState,
    session_id: &str,
) -> Result<ApiExecutionPermit, (StatusCode, Json<ApiError>)> {
    let permit = state
        .execution_limiter
        .acquire(session_id)
        .await
        .map_err(|error| (StatusCode::TOO_MANY_REQUESTS, Json(ApiError { error })))?;
    verify_session_access(state, session_id)?;
    Ok(permit)
}

pub(super) fn bad_request(message: &str) -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::BAD_REQUEST,
        Json(ApiError {
            error: message.to_string(),
        }),
    )
}

fn payload_too_large(message: impl Into<String>) -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::PAYLOAD_TOO_LARGE,
        Json(ApiError {
            error: message.into(),
        }),
    )
}

fn reject_unsupported_upload_headers(
    headers: &HeaderMap,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if headers.contains_key(header::CONTENT_RANGE) {
        return Err(bad_request(
            "暂不支持 Content-Range 分块上传，请在单次 PUT 中提交完整文件",
        ));
    }
    Ok(())
}

pub(super) fn internal_error(message: impl std::fmt::Display) -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ApiError {
            error: message.to_string(),
        }),
    )
}

pub(super) fn elapsed_ms(start: std::time::Instant) -> u64 {
    start.elapsed().as_millis() as u64
}

pub(super) fn strict_safety_mode(
    value: Option<&str>,
) -> Result<bool, (StatusCode, Json<ApiError>)> {
    match value
        .unwrap_or("balanced")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "balanced" | "standard" => Ok(false),
        "strict" => Ok(true),
        _ => Err(bad_request("safetyMode 仅支持 balanced 或 strict")),
    }
}

pub(super) fn validate_exec_request(
    session_id: &str,
    command: &str,
    safety_mode: Option<&str>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if session_id.trim().is_empty() || command.trim().is_empty() {
        return Err(bad_request("缺少 sessionId 或 command"));
    }
    if command.len() > MAX_API_COMMAND_BYTES {
        return Err(bad_request("command 不能超过 64 KiB"));
    }
    let strict = strict_safety_mode(safety_mode)?;
    if let Some(reason) = check_dangerous_command(command, strict) {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ApiError {
                error: format!("命令被拒绝: {reason}"),
            }),
        ));
    }
    Ok(())
}

pub(super) async fn ensure_api_session_ready(
    state: &ApiServerState,
    session_id: &str,
    require_sftp: bool,
) -> Result<u128, (StatusCode, Json<ApiError>)> {
    verify_session_access_and_exists(state, session_id)?;
    let (connected, sftp_available) = state.remote.api_session_status(session_id).await;
    let mut connection_ms = 0;
    if !connected {
        let connection_started = std::time::Instant::now();
        let config_guard = state.connection_config_gate.read().await;
        let (session, known_host) = {
            let store = state
                .vault
                .lock()
                .map_err(|_| internal_error("内部锁错误"))?;
            crate::commands::build_session_for_connect(&store, session_id)
                .map_err(internal_error)?
        };
        drop(config_guard);
        state
            .remote
            .api_connect_session(&state.app, session.clone(), known_host)
            .await
            .map_err(|error| map_remote_error(error.to_string(), state))?;
        connection_ms = connection_started.elapsed().as_millis();
        if verify_session_access(state, session_id).is_err() {
            let _ = state
                .remote
                .api_disconnect_session(&state.app, session_id)
                .await;
            return Err((
                StatusCode::FORBIDDEN,
                Json(ApiError {
                    error: format!("会话 {} 已不在 AI API 授权范围内", session_id),
                }),
            ));
        }
        let still_valid = {
            let store = state
                .vault
                .lock()
                .map_err(|_| internal_error("内部锁错误"))?;
            crate::commands::session_matches_current_connection_config(&store, &session)
                .unwrap_or(false)
        };
        if !still_valid {
            let _ = state
                .remote
                .api_disconnect_session(&state.app, session_id)
                .await;
            return Err((
                StatusCode::CONFLICT,
                Json(ApiError {
                    error: "会话配置已变更，请重试".to_string(),
                }),
            ));
        }
    }
    if require_sftp && (!connected || !sftp_available) {
        state
            .remote
            .api_ensure_sftp(session_id)
            .await
            .map_err(|error| map_remote_error(error, state))?;
    }
    Ok(connection_ms)
}

pub(super) fn exec_success(result: &ExecResult) -> bool {
    !result.timed_out && result.exit_status.unwrap_or(1) == 0
}

async fn run_batch_exec_item(
    state: &ApiServerState,
    session_id: &str,
    index: usize,
    item: BatchExecItem,
) -> BatchExecItemResult {
    let started = std::time::Instant::now();
    let timeout_ms = item
        .timeout_ms
        .unwrap_or(30_000)
        .clamp(1, MAX_API_EXEC_TIMEOUT_MS);
    let queue_started = std::time::Instant::now();
    let _permit = match state.execution_limiter.acquire(session_id).await {
        Ok(permit) => permit,
        Err(error) => {
            return BatchExecItemResult {
                index,
                id: item.id,
                success: false,
                result: None,
                error: Some(error),
            };
        }
    };
    let queue_ms = queue_started.elapsed().as_millis();
    if let Err((_, Json(error))) = verify_session_access(state, session_id) {
        return BatchExecItemResult {
            index,
            id: item.id,
            success: false,
            result: None,
            error: Some(error.error),
        };
    }
    match state
        .remote
        .api_exec(session_id, &item.command, timeout_ms)
        .await
    {
        Ok(mut result) => {
            result.queue_ms = queue_ms;
            result.duration_ms = started.elapsed().as_millis();
            BatchExecItemResult {
                index,
                id: item.id,
                success: exec_success(&result),
                result: Some(result),
                error: None,
            }
        }
        Err(error) => BatchExecItemResult {
            index,
            id: item.id,
            success: false,
            result: None,
            error: Some(error),
        },
    }
}

fn apply_batch_output_budget(result: &mut BatchExecItemResult, remaining: &mut usize) {
    let Some(exec_result) = result.result.as_mut() else {
        return;
    };
    let retained = exec_result
        .stdout
        .len()
        .saturating_add(exec_result.stderr.len());
    if retained <= *remaining {
        *remaining -= retained;
        return;
    }
    exec_result.output_truncated = true;
    let stdout_budget = (*remaining).min(exec_result.stdout.len());
    truncate_text_tail(&mut exec_result.stdout, stdout_budget);
    *remaining = remaining.saturating_sub(exec_result.stdout.len());
    let stderr_budget = (*remaining).min(exec_result.stderr.len());
    truncate_text_tail(&mut exec_result.stderr, stderr_budget);
    *remaining = remaining.saturating_sub(exec_result.stderr.len());
}

fn truncate_text_tail(value: &mut String, max_bytes: usize) {
    if value.len() <= max_bytes {
        return;
    }
    if max_bytes == 0 {
        value.clear();
        return;
    }
    let mut keep_from = value.len() - max_bytes;
    while keep_from < value.len() && !value.is_char_boundary(keep_from) {
        keep_from += 1;
    }
    value.drain(..keep_from);
}

// ─── Auth probe ────────────────────────────────────────────────────────────────

/// 鉴权探活 + 端点目录。
pub async fn auth_check(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let catalog = field_catalog::catalog_json().map_err(internal_error)?;
    let mut rest = serde_json::Map::new();
    if let Some(endpoints) = catalog["endpoints"].as_array() {
        for endpoint in endpoints {
            let Some(method) = endpoint["method"].as_str() else {
                continue;
            };
            let Some(path) = endpoint["path"].as_str() else {
                continue;
            };
            rest.insert(
                format!("{} {}", method.to_ascii_uppercase(), path),
                serde_json::Value::String(
                    endpoint["summary"]
                        .as_str()
                        .unwrap_or("AI API 端点")
                        .to_string(),
                ),
            );
        }
    }
    Ok(Json(serde_json::json!({
        "authenticated": true,
        "auth": "Authorization: Bearer <api_key>",
        "fieldCatalogVersion": catalog["version"],
        "serverInstanceId": state.server_instance_id.as_ref(),
        "rest": rest
    })))
}

struct CachedJsonDocument {
    body: Bytes,
    etag: String,
}

impl CachedJsonDocument {
    fn new(value: &serde_json::Value) -> Result<Self, String> {
        let serialized = serde_json::to_vec(value).map_err(|error| error.to_string())?;
        let etag = format!("\"{}\"", hex::encode(Sha256::digest(&serialized)));
        Ok(Self {
            body: Bytes::from(serialized),
            etag,
        })
    }
}

fn cached_json_response(
    headers: &HeaderMap,
    document: &CachedJsonDocument,
) -> Result<Response<Body>, (StatusCode, Json<ApiError>)> {
    let not_modified = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value.split(',').any(|candidate| {
                let candidate = candidate.trim();
                candidate == "*"
                    || candidate == document.etag.as_str()
                    || candidate
                        .strip_prefix("W/")
                        .is_some_and(|value| value == document.etag.as_str())
            })
        });
    let mut builder = Response::builder()
        .status(if not_modified {
            StatusCode::NOT_MODIFIED
        } else {
            StatusCode::OK
        })
        .header(header::ETAG, &document.etag)
        .header(header::CACHE_CONTROL, "private, max-age=0, must-revalidate");
    if not_modified {
        return builder
            .body(Body::empty())
            .map_err(|error| internal_error(format!("构建缓存响应失败: {error}")));
    }
    builder = builder
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CONTENT_LENGTH, document.body.len());
    builder
        .body(Body::from(document.body.clone()))
        .map_err(|error| internal_error(format!("构建 JSON 响应失败: {error}")))
}

/// `GET /api/fields` — 返回同一份字段库 JSON，供 AI 或外部工具动态读取。
pub async fn rest_fields(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
) -> Result<Response<Body>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let start = std::time::Instant::now();
    let catalog = field_catalog::catalog_json().map_err(internal_error)?;
    let document = FIELD_CATALOG_CACHE
        .get_or_init(|| CachedJsonDocument::new(catalog))
        .as_ref()
        .map_err(internal_error)?;
    push_log(&state, "rest/fields", "字段库", true, elapsed_ms(start)).await;
    cached_json_response(&headers, document)
}

/// `GET /openapi.json` — 返回由字段库生成的 OpenAPI 3.1 文档。
pub async fn rest_openapi(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
) -> Result<Response<Body>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let start = std::time::Instant::now();
    let document = openapi::document_json().map_err(internal_error)?;
    let cached = OPENAPI_DOCUMENT_CACHE
        .get_or_init(|| CachedJsonDocument::new(document))
        .as_ref()
        .map_err(internal_error)?;
    push_log(
        &state,
        "rest/openapi",
        "OpenAPI 3.1",
        true,
        elapsed_ms(start),
    )
    .await;
    cached_json_response(&headers, cached)
}

// ─── REST: 会话生命周期 / 命令执行 / 文件列出 ───────────────────────────────────

/// `GET /api/sessions` — 列出已授权的配置会话及实时连接状态。
pub async fn rest_sessions(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
) -> Result<Json<Vec<SessionItem>>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;

    let start = std::time::Instant::now();
    let allowed_session_ids = allowed_session_ids_snapshot(&state);
    let configured_sessions = {
        let store = state
            .vault
            .lock()
            .map_err(|_| internal_error("内部锁错误"))?;
        store.sessions().map_err(internal_error)?
    };
    let session_statuses = state.remote.api_session_statuses().await;
    let mut sessions = Vec::new();
    for session in configured_sessions {
        if !allowed_session_ids.contains(&session.id) {
            continue;
        }
        let runtime_status = session_statuses.get(&session.id);
        sessions.push(SessionItem {
            session_id: session.id,
            name: session.name,
            host: format!("{}:{}", session.host, session.port),
            connected: runtime_status.is_some_and(|status| status.connected),
            sftp_available: runtime_status.is_some_and(|status| status.sftp_available),
            connection_id: runtime_status.map(|status| status.connection_id.clone()),
            status: runtime_status.map(|status| status.status.clone()),
            connected_at: runtime_status.map(|status| status.connected_at.clone()),
        });
    }
    let latest_allowed_session_ids = allowed_session_ids_snapshot(&state);
    sessions.retain(|session| latest_allowed_session_ids.contains(&session.session_id));
    let elapsed = elapsed_ms(start);
    push_log(
        &state,
        "rest/sessions",
        &format!("{} 项", sessions.len()),
        true,
        elapsed,
    )
    .await;
    Ok(Json(sessions))
}

/// `POST /api/connect` — 拉起 SSH 连接（幂等，已连接即返回当前 ConnectionInfo）。
pub async fn rest_connect(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Json(body): Json<SessionIdBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;

    if body.session_id.trim().is_empty() {
        return Err(bad_request("缺少 sessionId"));
    }
    verify_session_access(&state, &body.session_id)?;
    let reused = state.remote.api_session_status(&body.session_id).await.0;

    let start = std::time::Instant::now();
    let config_guard = state.connection_config_gate.read().await;
    // VaultStore 是 std Mutex，把同步读取局限在一个块里释放锁后再 await。
    let bundle = {
        let store = state
            .vault
            .lock()
            .map_err(|_| internal_error("内部锁错误"))?;
        crate::commands::build_session_for_connect(&store, &body.session_id)
            .map_err(internal_error)?
    };
    let (session, known_host) = bundle;
    drop(config_guard);

    match state
        .remote
        .api_connect_session(&state.app, session.clone(), known_host)
        .await
    {
        Ok(info) => {
            if verify_session_access(&state, &body.session_id).is_err() {
                let _ = state
                    .remote
                    .api_disconnect_session(&state.app, &body.session_id)
                    .await;
                return Err((
                    StatusCode::FORBIDDEN,
                    Json(ApiError {
                        error: format!("会话 {} 已不在 AI API 授权范围内", body.session_id),
                    }),
                ));
            }
            let still_valid = {
                let store = state
                    .vault
                    .lock()
                    .map_err(|_| internal_error("内部锁错误"))?;
                crate::commands::session_matches_current_connection_config(&store, &session)
                    .unwrap_or(false)
            };
            if !still_valid {
                let _ = state
                    .remote
                    .api_disconnect_session(&state.app, &body.session_id)
                    .await;
                return Err((
                    StatusCode::CONFLICT,
                    Json(ApiError {
                        error: "会话配置已变更，请重新连接".to_string(),
                    }),
                ));
            }
            let elapsed = elapsed_ms(start);
            push_log(&state, "rest/connect", &body.session_id, true, elapsed).await;
            let mut response = serde_json::to_value(info).unwrap_or_default();
            if let Some(response) = response.as_object_mut() {
                response.insert("reused".to_string(), serde_json::Value::Bool(reused));
            }
            Ok(Json(response))
        }
        Err(error) => {
            let elapsed = elapsed_ms(start);
            let msg = error.to_string();
            push_log(
                &state,
                "rest/connect",
                &friendly_error_detail(&format!("{} → {}", body.session_id, msg), &state),
                false,
                elapsed,
            )
            .await;
            Err(map_remote_error(msg, &state))
        }
    }
}

/// `POST /api/disconnect` — 断开会话（按 sessionId 反查 connectionId）。
pub async fn rest_disconnect(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Json(body): Json<SessionIdBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;

    if body.session_id.trim().is_empty() {
        return Err(bad_request("缺少 sessionId"));
    }
    verify_session_access(&state, &body.session_id)?;

    let start = std::time::Instant::now();
    match state
        .remote
        .api_disconnect_session(&state.app, &body.session_id)
        .await
    {
        Ok(_) => {
            let elapsed = elapsed_ms(start);
            push_log(&state, "rest/disconnect", &body.session_id, true, elapsed).await;
            Ok(Json(serde_json::json!({ "success": true })))
        }
        Err(e) => {
            let elapsed = elapsed_ms(start);
            push_log(
                &state,
                "rest/disconnect",
                &friendly_error_detail(&format!("{} → {}", body.session_id, e), &state),
                false,
                elapsed,
            )
            .await;
            Err(internal_error(e))
        }
    }
}

/// `POST /api/exec` — 运行命令并一次性返回 stdout/stderr/exitCode。
pub async fn rest_exec(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Json(body): Json<ExecBody>,
) -> Result<Json<ExecResult>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let request_started = std::time::Instant::now();

    validate_exec_request(&body.session_id, &body.command, body.safety_mode.as_deref())?;
    verify_session_access(&state, &body.session_id)?;
    let connection_ms = ensure_api_session_ready(&state, &body.session_id, false).await?;
    let queue_started = std::time::Instant::now();
    let _execution_permit = acquire_execution_permit(&state, &body.session_id).await?;
    let queue_ms = queue_started.elapsed().as_millis();

    let timeout_ms = body
        .timeout_ms
        .unwrap_or(30_000)
        .clamp(1, MAX_API_EXEC_TIMEOUT_MS);
    let detail = command_log_detail(&body.command, 77);

    let execution_result = state
        .remote
        .api_exec(&body.session_id, &body.command, timeout_ms)
        .await;
    drop(_execution_permit);
    match execution_result {
        Ok(mut result) => {
            verify_session_access(&state, &body.session_id)?;
            result.queue_ms = queue_ms;
            result.connection_ms = connection_ms;
            result.duration_ms = request_started.elapsed().as_millis();
            let elapsed = elapsed_ms(request_started);
            let success = exec_success(&result);
            let preview = response_log_preview(&body.command, &result.stdout, 2_000);
            push_log_with_response(&state, "rest/exec", &detail, success, elapsed, preview).await;
            Ok(Json(result))
        }
        Err(e) => {
            let elapsed = elapsed_ms(request_started);
            push_log(
                &state,
                "rest/exec",
                &friendly_error_detail(&format!("{} → {}", body.command, e), &state),
                false,
                elapsed,
            )
            .await;
            Err(map_remote_error(e, &state))
        }
    }
}

/// `POST /api/latency` — 使用 SSH 原生 ping 测量应用到终端的真实往返延迟。
pub async fn rest_latency(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Json(body): Json<LatencyBody>,
) -> Result<Json<LatencyProbeResult>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    if body.session_id.trim().is_empty() {
        return Err(bad_request("缺少 sessionId"));
    }
    verify_session_access(&state, &body.session_id)?;
    ensure_api_session_ready(&state, &body.session_id, false).await?;

    let start = std::time::Instant::now();
    match state
        .remote
        .api_probe_latency(&body.session_id, body.samples)
        .await
    {
        Ok(result) => {
            verify_session_access(&state, &body.session_id)?;
            push_log(
                &state,
                "rest/latency",
                &format!("{} → {:.1}ms", body.session_id, result.median_ms),
                true,
                elapsed_ms(start),
            )
            .await;
            Ok(Json(result))
        }
        Err(error) => {
            push_log(
                &state,
                "rest/latency",
                &friendly_error_detail(&format!("{} → {}", body.session_id, error), &state),
                false,
                elapsed_ms(start),
            )
            .await;
            Err(map_remote_error(error, &state))
        }
    }
}

/// `POST /api/exec/batch` — 一次请求执行多条命令，支持最多 4 路并行。
pub async fn rest_exec_batch(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Json(body): Json<BatchExecBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let request_started = std::time::Instant::now();
    if body.session_id.trim().is_empty() {
        return Err(bad_request("缺少 sessionId"));
    }
    if body.commands.is_empty() || body.commands.len() > 32 {
        return Err(bad_request("commands 数量必须在 1–32 之间"));
    }
    let strict = strict_safety_mode(body.safety_mode.as_deref())?;
    for item in &body.commands {
        if item.command.trim().is_empty() {
            return Err(bad_request("commands 中存在空命令"));
        }
        if item.command.len() > MAX_API_COMMAND_BYTES {
            return Err(bad_request("commands 中的单条命令不能超过 64 KiB"));
        }
        if let Some(reason) = check_dangerous_command(&item.command, strict) {
            return Err((
                StatusCode::FORBIDDEN,
                Json(ApiError {
                    error: format!("批量命令被拒绝: {}", reason),
                }),
            ));
        }
    }
    verify_session_access(&state, &body.session_id)?;
    let connection_ms = ensure_api_session_ready(&state, &body.session_id, false).await?;

    let session_id = body.session_id.clone();
    let mut remaining_output_bytes = MAX_API_BATCH_RETAINED_OUTPUT_BYTES;
    let mut results = if body.parallel {
        let mut executions =
            stream::iter(body.commands.into_iter().enumerate().map(|(index, item)| {
                let task_state = state.clone();
                let session_id = session_id.clone();
                async move { run_batch_exec_item(&task_state, &session_id, index, item).await }
            }))
            .buffer_unordered(4);
        let mut results = Vec::new();
        while let Some(mut result) = executions.next().await {
            apply_batch_output_budget(&mut result, &mut remaining_output_bytes);
            results.push(result);
        }
        results
    } else {
        let mut results = Vec::with_capacity(body.commands.len());
        for (index, item) in body.commands.into_iter().enumerate() {
            let mut result = run_batch_exec_item(&state, &session_id, index, item).await;
            apply_batch_output_budget(&mut result, &mut remaining_output_bytes);
            let should_stop = body.stop_on_error && !result.success;
            results.push(result);
            if should_stop {
                break;
            }
        }
        results
    };
    results.sort_by_key(|item| item.index);
    verify_session_access(&state, &session_id)?;
    let success = results.iter().all(|item| item.success);
    let output_truncated = results
        .iter()
        .filter_map(|item| item.result.as_ref())
        .any(|result| result.output_truncated);
    let duration_ms = elapsed_ms(request_started);
    push_log(
        &state,
        "rest/exec-batch",
        &format!(
            "{} 条 / {}",
            results.len(),
            if body.parallel { "并行" } else { "顺序" }
        ),
        success,
        duration_ms,
    )
    .await;
    Ok(Json(serde_json::json!({
        "success": success,
        "parallel": body.parallel,
        "outputTruncated": output_truncated,
        "connectionMs": connection_ms,
        "durationMs": duration_ms,
        "results": results
    })))
}

/// `GET /api/files?sessionId=&path=` — 列出远端目录。
pub async fn rest_files(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Query(query): Query<FilesQuery>,
) -> Result<Json<Vec<FileEntry>>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;

    if query.session_id.trim().is_empty() {
        return Err(bad_request("缺少 sessionId"));
    }
    if query.path.trim().is_empty() {
        return Err(bad_request("缺少 path"));
    }
    verify_session_access(&state, &query.session_id)?;
    ensure_api_session_ready(&state, &query.session_id, true).await?;

    let start = std::time::Instant::now();
    match state
        .remote
        .api_list_files(&query.session_id, &query.path)
        .await
    {
        Ok(entries) => {
            verify_session_access(&state, &query.session_id)?;
            let elapsed = elapsed_ms(start);
            push_log(
                &state,
                "rest/files",
                &format!("{} ({} 项)", query.path, entries.len()),
                true,
                elapsed,
            )
            .await;
            Ok(Json(entries))
        }
        Err(e) => {
            let elapsed = elapsed_ms(start);
            push_log(
                &state,
                "rest/files",
                &friendly_error_detail(&format!("{} → {}", query.path, e), &state),
                false,
                elapsed,
            )
            .await;
            Err(map_remote_error(e, &state))
        }
    }
}

const DEFAULT_FILES_PAGE_LIMIT: usize = 100;
const MAX_FILES_PAGE_LIMIT: usize = 500;

pub async fn rest_files_page(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Query(query): Query<FilesPageQuery>,
) -> Result<Json<FilesPageResponse>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    if query.session_id.trim().is_empty() || query.path.trim().is_empty() {
        return Err(bad_request("缺少 sessionId 或 path"));
    }
    let limit = query
        .limit
        .map(usize::from)
        .unwrap_or(DEFAULT_FILES_PAGE_LIMIT);
    if !(1..=MAX_FILES_PAGE_LIMIT).contains(&limit) {
        return Err(bad_request("limit 必须在 1–500 之间"));
    }
    let offset = decode_files_cursor(query.cursor.as_deref(), &query.path)?;
    verify_session_access(&state, &query.session_id)?;
    ensure_api_session_ready(&state, &query.session_id, true).await?;
    let start = std::time::Instant::now();
    let (items, has_more) = state
        .remote
        .api_list_files_page(&query.session_id, &query.path, offset, limit)
        .await
        .map_err(|error| map_remote_error(error, &state))?;
    verify_session_access(&state, &query.session_id)?;
    let next_cursor =
        has_more.then(|| encode_files_cursor(&query.path, offset.saturating_add(items.len())));
    push_log(
        &state,
        "rest/files.page",
        &format!("{} ({} 项)", query.path, items.len()),
        true,
        elapsed_ms(start),
    )
    .await;
    Ok(Json(FilesPageResponse {
        items,
        next_cursor,
        has_more,
    }))
}

pub async fn rest_file_stat(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Query(query): Query<FilesQuery>,
) -> Result<Json<FileEntry>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    if query.session_id.trim().is_empty() || query.path.trim().is_empty() {
        return Err(bad_request("缺少 sessionId 或 path"));
    }
    verify_session_access(&state, &query.session_id)?;
    ensure_api_session_ready(&state, &query.session_id, true).await?;
    let start = std::time::Instant::now();
    let entry = state
        .remote
        .api_file_stat(&query.session_id, &query.path)
        .await
        .map_err(|error| map_remote_error(error, &state))?;
    verify_session_access(&state, &query.session_id)?;
    push_log(
        &state,
        "rest/files.stat",
        &query.path,
        true,
        elapsed_ms(start),
    )
    .await;
    Ok(Json(entry))
}

fn files_cursor_tag(path: &str) -> String {
    let digest = hex::encode(Sha256::digest(path.trim().as_bytes()));
    digest[..16].to_string()
}

fn encode_files_cursor(path: &str, offset: usize) -> String {
    format!("v1:{}:{offset}", files_cursor_tag(path))
}

fn decode_files_cursor(
    cursor: Option<&str>,
    path: &str,
) -> Result<usize, (StatusCode, Json<ApiError>)> {
    let Some(cursor) = cursor else {
        return Ok(0);
    };
    let mut parts = cursor.split(':');
    let valid = parts.next() == Some("v1") && parts.next() == Some(files_cursor_tag(path).as_str());
    let offset = parts.next().and_then(|value| value.parse::<usize>().ok());
    if !valid || parts.next().is_some() || offset.is_none() {
        return Err(bad_request("cursor 无效或不属于当前目录"));
    }
    Ok(offset.unwrap_or_default())
}

// ─── 文件传输（Bearer 鉴权） ──────────────────────────────────────────────────

/// raw PUT 上传：流式写入同目录临时文件，完成后原子替换目标。
pub async fn upload_file_raw(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Query(query): Query<UploadRawQuery>,
    body: Body,
) -> Result<Json<UploadResponse>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    reject_unsupported_upload_headers(&headers)?;

    if query.session_id.trim().is_empty() {
        return Err(bad_request("缺少 sessionId 查询参数"));
    }
    if query.remote_path.trim().is_empty() || query.remote_path.trim() == "/" {
        return Err(bad_request("缺少 remotePath 查询参数"));
    }
    let expected_sha256 = query
        .sha256
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase);
    if expected_sha256.as_deref().is_some_and(|value| {
        value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
    }) {
        return Err(bad_request("sha256 必须是 64 位十六进制摘要"));
    }
    if let Some(content_length) = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
    {
        if content_length > MAX_UPLOAD_BODY {
            return Err(payload_too_large(format!(
                "上传文件不能超过 {} MB",
                MAX_UPLOAD_BODY / 1024 / 1024
            )));
        }
    }

    verify_session_access(&state, &query.session_id)?;
    ensure_api_session_ready(&state, &query.session_id, true).await?;

    let start = std::time::Instant::now();

    let stream = body.into_data_stream().map_err(std::io::Error::other);
    let mut reader = StreamReader::new(stream);

    let (bytes_written, actual_sha256) = match state
        .remote
        .api_upload_stream(
            &query.session_id,
            &query.remote_path,
            &mut reader,
            expected_sha256.as_deref(),
            MAX_UPLOAD_BODY,
        )
        .await
    {
        Ok(n) => n,
        Err(crate::errors::AppError::InvalidInput(message)) => {
            let elapsed = elapsed_ms(start);
            push_log(
                &state,
                "upload",
                &friendly_error_detail(&format!("{} → {}", query.remote_path, message), &state),
                false,
                elapsed,
            )
            .await;
            return Err(if message.contains("超过") {
                payload_too_large(message)
            } else {
                bad_request(&message)
            });
        }
        Err(e) => {
            let elapsed = elapsed_ms(start);
            push_log(
                &state,
                "upload",
                &friendly_error_detail(&format!("{} → {}", query.remote_path, e), &state),
                false,
                elapsed,
            )
            .await;
            return Err(map_remote_error(e.to_string(), &state));
        }
    };

    let elapsed = elapsed_ms(start);
    verify_session_access(&state, &query.session_id)?;
    push_log(
        &state,
        "upload",
        &format!("{} ({}B, raw)", query.remote_path, bytes_written),
        true,
        elapsed,
    )
    .await;

    Ok(Json(UploadResponse {
        success: true,
        remote_path: query.remote_path,
        size: bytes_written,
        sha256: actual_sha256,
    }))
}

/// 下载：支持 Range 请求 → 206 Partial Content + Content-Range + Accept-Ranges。
pub async fn download_file(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Query(query): Query<DownloadQuery>,
) -> Result<Response<Body>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;

    if query.session_id.trim().is_empty() {
        return Err(bad_request("缺少 sessionId 查询参数"));
    }
    if query.path.trim().is_empty() || query.path.trim() == "/" {
        return Err(bad_request("缺少 path 查询参数"));
    }

    verify_session_access(&state, &query.session_id)?;
    ensure_api_session_ready(&state, &query.session_id, true).await?;
    let start = std::time::Instant::now();

    let sftp = match state.remote.find_sftp_for_session(&query.session_id).await {
        Ok(sftp) => sftp,
        Err(e) => return Err(map_remote_error(e, &state)),
    };

    let metadata = match sftp.metadata(query.path.clone()).await {
        Ok(m) => m,
        Err(e) => {
            let elapsed = elapsed_ms(start);
            push_log(
                &state,
                "download",
                &friendly_error_detail(&format!("{} → {}", query.path, e), &state),
                false,
                elapsed,
            )
            .await;
            return Err((
                StatusCode::NOT_FOUND,
                Json(ApiError {
                    error: format!("无法读取远程文件: {}", e),
                }),
            ));
        }
    };
    if metadata.file_type().is_dir() {
        return Err(bad_request("path 必须指向文件，不能是目录"));
    }
    let total_size = metadata.len();
    verify_session_access(&state, &query.session_id)?;

    let range = parse_range_header(headers.get(header::RANGE), total_size);
    let (status, start_offset, end_offset) = match range {
        ParsedRange::Full => (StatusCode::OK, 0u64, total_size.saturating_sub(1)),
        ParsedRange::Satisfiable { start, end } => (StatusCode::PARTIAL_CONTENT, start, end),
        ParsedRange::Unsatisfiable => return range_not_satisfiable_response(total_size),
        ParsedRange::Multiple => {
            return range_not_satisfiable_response_with_message(
                total_size,
                "不支持多段 Range，请拆分为多个单段请求".to_string(),
            )
        }
        ParsedRange::Invalid => return Err(bad_request("Range 格式无效，仅支持单段 bytes 范围")),
    };
    let send_len = if total_size == 0 {
        0
    } else {
        end_offset - start_offset + 1
    };

    // 大段范围走并行多 File handle，与 UI 下载共用阈值和缓冲常量。
    let parallel_used = send_len >= crate::remote::PARALLEL_DOWNLOAD_THRESHOLD
        && crate::remote::PARALLEL_DOWNLOAD_PARTS >= 2;
    let download_stream: BoxDownloadStream = if parallel_used {
        match state
            .remote
            .parallel_download_stream(
                &query.session_id,
                query.path.clone(),
                start_offset,
                send_len,
                crate::remote::PARALLEL_DOWNLOAD_PARTS,
                crate::remote::TRANSFER_BUFFER_BYTES,
            )
            .await
        {
            Ok(stream) => Box::pin(stream),
            Err(e) => {
                let elapsed = elapsed_ms(start);
                push_log(
                    &state,
                    "download",
                    &friendly_error_detail(
                        &format!("{} → 并行下载初始化失败: {}", query.path, e),
                        &state,
                    ),
                    false,
                    elapsed,
                )
                .await;
                return Err(map_remote_error(
                    format!("并行下载初始化失败: {}", e),
                    &state,
                ));
            }
        }
    } else {
        match state
            .remote
            .download_stream(
                &query.session_id,
                query.path.clone(),
                start_offset,
                send_len,
                crate::remote::TRANSFER_BUFFER_BYTES,
            )
            .await
        {
            Ok(stream) => Box::pin(stream),
            Err(e) => {
                let elapsed = elapsed_ms(start);
                push_log(
                    &state,
                    "download",
                    &friendly_error_detail(&format!("{} → {}", query.path, e), &state),
                    false,
                    elapsed,
                )
                .await;
                return Err(map_remote_error(e, &state));
            }
        }
    };

    let log_detail = if status == StatusCode::PARTIAL_CONTENT {
        format!(
            "{} ({}B, range {}-{}/{}{})",
            query.path,
            send_len,
            start_offset,
            end_offset,
            total_size,
            if parallel_used { ", 并行" } else { "" }
        )
    } else if parallel_used {
        format!("{} ({}B, 并行流式)", query.path, send_len)
    } else {
        format!("{} ({}B, 流式)", query.path, send_len)
    };
    let body = Body::from_stream(DownloadLogStream::new(
        download_stream,
        state.clone(),
        log_detail,
        start,
    ));

    let file_name = query.path.rsplit('/').next().unwrap_or("file");
    let safe_name: String = file_name
        .chars()
        .filter(|c| !c.is_control() && *c != '"' && *c != '\\')
        .collect();
    let disposition = format!("attachment; filename=\"{}\"", safe_name);

    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, send_len);
    if status == StatusCode::PARTIAL_CONTENT {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {}-{}/{}", start_offset, end_offset, total_size),
        );
    }
    let mut response = builder
        .body(body)
        .map_err(|e| internal_error(format!("构建响应失败: {}", e)))?;
    if let Ok(value) = HeaderValue::from_str(&disposition) {
        response
            .headers_mut()
            .insert(header::CONTENT_DISPOSITION, value);
    }
    Ok(response)
}

// ─── Range / Content-Range parsing ────────────────────────────────────────────

enum ParsedRange {
    Full,
    Satisfiable { start: u64, end: u64 },
    Unsatisfiable,
    Multiple,
    Invalid,
}

fn range_not_satisfiable_response(
    total_size: u64,
) -> Result<Response<Body>, (StatusCode, Json<ApiError>)> {
    range_not_satisfiable_response_with_message(
        total_size,
        format!("Range 越界：文件大小 {} 字节", total_size),
    )
}

fn range_not_satisfiable_response_with_message(
    total_size: u64,
    message: String,
) -> Result<Response<Body>, (StatusCode, Json<ApiError>)> {
    let body = serde_json::to_vec(&ApiError { error: message }).map_err(internal_error)?;
    Response::builder()
        .status(StatusCode::RANGE_NOT_SATISFIABLE)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_RANGE, format!("bytes */{total_size}"))
        .header(header::CONTENT_LENGTH, body.len())
        .body(Body::from(body))
        .map_err(|error| internal_error(format!("构建 Range 响应失败: {error}")))
}

fn parse_range_header(header_value: Option<&HeaderValue>, total: u64) -> ParsedRange {
    let Some(header_value) = header_value else {
        return ParsedRange::Full;
    };
    let Ok(raw) = header_value.to_str() else {
        return ParsedRange::Invalid;
    };
    let raw = raw.trim();
    let Some(spec) = raw.strip_prefix("bytes=") else {
        return ParsedRange::Invalid;
    };
    if spec.contains(',') {
        return ParsedRange::Multiple;
    }
    let first = spec.trim();
    let (start_s, end_s) = match first.split_once('-') {
        Some(parts) => parts,
        None => return ParsedRange::Invalid,
    };

    if total == 0 {
        return ParsedRange::Unsatisfiable;
    }

    let (start, end) = if start_s.is_empty() {
        let suffix: u64 = match end_s.parse() {
            Ok(v) if v > 0 => v,
            _ => return ParsedRange::Invalid,
        };
        let len = suffix.min(total);
        let start = total - len;
        let end = total - 1;
        (Bound::Included(start), Bound::Included(end))
    } else {
        let start: u64 = match start_s.parse() {
            Ok(v) => v,
            Err(_) => return ParsedRange::Invalid,
        };
        let end: u64 = if end_s.is_empty() {
            total - 1
        } else {
            match end_s.parse::<u64>() {
                Ok(v) => v.min(total - 1),
                Err(_) => return ParsedRange::Invalid,
            }
        };
        (Bound::Included(start), Bound::Included(end))
    };

    let (Bound::Included(start), Bound::Included(end)) = (start, end) else {
        return ParsedRange::Invalid;
    };
    if start >= total || end < start {
        return ParsedRange::Unsatisfiable;
    }
    ParsedRange::Satisfiable { start, end }
}

#[cfg(test)]
mod tests {
    use super::{
        cached_json_response, decode_files_cursor, encode_files_cursor, parse_range_header,
        range_not_satisfiable_response, reject_unsupported_upload_headers, CachedJsonDocument,
        ParsedRange,
    };
    use axum::http::{header, HeaderMap, HeaderValue, StatusCode};

    #[test]
    fn byte_ranges_handle_full_open_and_suffix_forms() {
        assert!(matches!(parse_range_header(None, 10), ParsedRange::Full));
        assert!(matches!(
            parse_range_header(Some(&HeaderValue::from_static("bytes=2-4")), 10),
            ParsedRange::Satisfiable { start: 2, end: 4 }
        ));
        assert!(matches!(
            parse_range_header(Some(&HeaderValue::from_static("bytes=7-")), 10),
            ParsedRange::Satisfiable { start: 7, end: 9 }
        ));
        assert!(matches!(
            parse_range_header(Some(&HeaderValue::from_static("bytes=-3")), 10),
            ParsedRange::Satisfiable { start: 7, end: 9 }
        ));
    }

    #[test]
    fn byte_ranges_distinguish_unsatisfiable_multi_and_invalid_forms() {
        assert!(matches!(
            parse_range_header(Some(&HeaderValue::from_static("bytes=10-")), 10),
            ParsedRange::Unsatisfiable
        ));
        assert!(matches!(
            parse_range_header(Some(&HeaderValue::from_static("bytes=0-1,4-5")), 10),
            ParsedRange::Multiple
        ));
        assert!(matches!(
            parse_range_header(Some(&HeaderValue::from_static("items=0-1")), 10),
            ParsedRange::Invalid
        ));
        let non_ascii = HeaderValue::from_bytes(b"bytes=\xff").unwrap();
        assert!(matches!(
            parse_range_header(Some(&non_ascii), 10),
            ParsedRange::Invalid
        ));
    }

    #[test]
    fn unsatisfiable_range_response_includes_required_content_range() {
        let response = match range_not_satisfiable_response(42) {
            Ok(response) => response,
            Err(_) => panic!("range response should build"),
        };
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(
            response.headers().get(header::CONTENT_RANGE).unwrap(),
            "bytes */42"
        );
        assert_eq!(
            response.headers().get(header::ACCEPT_RANGES).unwrap(),
            "bytes"
        );
    }

    #[test]
    fn content_range_uploads_are_rejected_instead_of_overwriting_with_one_chunk() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_RANGE,
            HeaderValue::from_static("bytes 0-9/100"),
        );
        let (status, body) = reject_unsupported_upload_headers(&headers).unwrap_err();
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body.0.error.contains("完整文件"));
        assert!(reject_unsupported_upload_headers(&HeaderMap::new()).is_ok());
    }

    #[test]
    fn cached_documents_return_etag_and_support_not_modified() {
        let document = CachedJsonDocument::new(&serde_json::json!({ "v": 1 })).unwrap();
        let first = cached_json_response(&HeaderMap::new(), &document).expect("first response");
        assert_eq!(first.status(), StatusCode::OK);
        let etag = first.headers().get(header::ETAG).unwrap().clone();
        let mut headers = HeaderMap::new();
        headers.insert(header::IF_NONE_MATCH, etag.clone());
        let second = cached_json_response(&headers, &document).expect("cached response");
        assert_eq!(second.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(second.headers().get(header::ETAG), Some(&etag));
    }

    #[test]
    fn file_page_cursor_is_bound_to_its_directory() {
        let cursor = encode_files_cursor("/var/log", 100);
        assert_eq!(decode_files_cursor(Some(&cursor), "/var/log").unwrap(), 100);
        assert!(decode_files_cursor(Some(&cursor), "/tmp").is_err());
        assert!(decode_files_cursor(Some("invalid"), "/var/log").is_err());
    }
}
