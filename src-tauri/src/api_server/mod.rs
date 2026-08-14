mod auth;
mod field_catalog;
mod guard;
mod handlers_admin;
mod handlers_jobs;
mod handlers_remote;
mod jobs;
mod openapi;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock as StdRwLock};

use axum::{
    http::{header, HeaderName, HeaderValue, Method, StatusCode},
    response::Json,
    routing::{delete, get, patch, post, put},
    Router,
};
use chrono::Utc;
use serde::{ser::SerializeStruct, Deserialize, Serialize, Serializer};
use tokio::{
    net::TcpListener,
    sync::{watch, Mutex as TokioMutex, Notify, OwnedSemaphorePermit, RwLock, Semaphore},
    task::JoinHandle,
    time::{timeout, Duration},
};
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::config_mutation::ConfigMutationCoordinator;
use crate::events as app_events;
use crate::remote::RemoteRuntime;
use crate::vault::VaultStore;

use tauri::{AppHandle, Emitter};

pub use handlers_remote::FileEntry;

// ─── Constants ─────────────────────────────────────────────────────────────────

pub(super) const MAX_UPLOAD_BODY: u64 = 512 * 1024 * 1024;
const MAX_LOG_ENTRIES: usize = 100;
const LOG_FLUSH_DEBOUNCE: Duration = Duration::from_secs(1);
const SERVER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);
const API_EXEC_QUEUE_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_API_EXEC_CONCURRENCY: usize = 16;
const MAX_API_EXEC_CONCURRENCY_PER_SESSION: usize = 4;

#[derive(Clone)]
pub(super) struct ApiExecutionLimiter {
    global: Arc<Semaphore>,
    sessions: Arc<TokioMutex<HashMap<String, Arc<Semaphore>>>>,
}

pub(super) struct ApiExecutionPermit {
    _session: OwnedSemaphorePermit,
    _global: OwnedSemaphorePermit,
}

impl ApiExecutionLimiter {
    fn new(allowed_session_ids: &[String]) -> Self {
        let sessions = allowed_session_ids
            .iter()
            .map(|session_id| {
                (
                    session_id.clone(),
                    Arc::new(Semaphore::new(MAX_API_EXEC_CONCURRENCY_PER_SESSION)),
                )
            })
            .collect();
        Self {
            global: Arc::new(Semaphore::new(MAX_API_EXEC_CONCURRENCY)),
            sessions: Arc::new(TokioMutex::new(sessions)),
        }
    }

    pub async fn acquire(&self, session_id: &str) -> Result<ApiExecutionPermit, String> {
        let session = {
            let mut sessions = self.sessions.lock().await;
            sessions
                .entry(session_id.to_string())
                .or_insert_with(|| Arc::new(Semaphore::new(MAX_API_EXEC_CONCURRENCY_PER_SESSION)))
                .clone()
        };
        timeout(API_EXEC_QUEUE_TIMEOUT, async {
            let session = session
                .acquire_owned()
                .await
                .map_err(|_| "会话执行队列已关闭".to_string())?;
            let global = self
                .global
                .clone()
                .acquire_owned()
                .await
                .map_err(|_| "全局执行队列已关闭".to_string())?;
            Ok(ApiExecutionPermit {
                _session: session,
                _global: global,
            })
        })
        .await
        .map_err(|_| "执行队列繁忙，请稍后重试".to_string())?
    }

    async fn update_sessions(&self, allowed_session_ids: &[String]) {
        let allowed = allowed_session_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let mut sessions = self.sessions.lock().await;
        // A revoked session can still have in-flight or queued permits. Keep its
        // semaphore until every owner releases it so a quick re-authorization
        // cannot create a second semaphore and bypass the per-session limit.
        sessions.retain(|session_id, semaphore| {
            allowed.contains(session_id.as_str()) || Arc::strong_count(semaphore) > 1
        });
        for session_id in allowed_session_ids {
            sessions
                .entry(session_id.clone())
                .or_insert_with(|| Arc::new(Semaphore::new(MAX_API_EXEC_CONCURRENCY_PER_SESSION)));
        }
    }
}

// ─── Public types ──────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct ApiServerState {
    pub api_key: Arc<RwLock<String>>,
    pub app: AppHandle,
    pub remote: RemoteRuntime,
    pub vault: Arc<Mutex<VaultStore>>,
    pub allowed_session_ids: Arc<StdRwLock<Vec<String>>>,
    pub allowed_session_set: Arc<StdRwLock<Arc<HashSet<String>>>>,
    pub allowed_session_names: Arc<StdRwLock<Vec<(String, String)>>>,
    pub logs: Arc<RwLock<Vec<ApiLogEntry>>>,
    pub log_dirty: Arc<Notify>,
    pub backup_operation: Arc<TokioMutex<()>>,
    pub tunnel_operation: Arc<TokioMutex<()>>,
    pub connection_config_gate: Arc<RwLock<()>>,
    pub config_mutations: ConfigMutationCoordinator,
    pub jobs: jobs::JobRegistry,
    pub execution_limiter: ApiExecutionLimiter,
    pub server_instance_id: Arc<str>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiLogEntry {
    pub timestamp: String,
    pub action: String,
    pub detail: String,
    pub success: bool,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiServerInfo {
    pub running: bool,
    pub port: u16,
    pub api_key: String,
}

pub struct ApiServerHandle {
    shutdown_tx: watch::Sender<bool>,
    server_task: JoinHandle<()>,
    log_task: JoinHandle<()>,
    app: AppHandle,
    remote: RemoteRuntime,
    pub port: u16,
    pub api_key: String,
    pub allowed_session_ids: Arc<StdRwLock<Vec<String>>>,
    allowed_session_set: Arc<StdRwLock<Arc<HashSet<String>>>>,
    pub allowed_session_names: Arc<StdRwLock<Vec<(String, String)>>>,
    pub log_file: PathBuf,
    pub logs: Arc<RwLock<Vec<ApiLogEntry>>>,
    jobs: jobs::JobRegistry,
    execution_limiter: ApiExecutionLimiter,
}

pub struct ApiServerStartOptions {
    pub app: AppHandle,
    pub remote: RemoteRuntime,
    pub vault: Arc<Mutex<VaultStore>>,
    pub port: u16,
    pub api_key: String,
    pub allowed_session_ids: Vec<String>,
    pub allowed_session_names: Vec<(String, String)>,
    pub log_file: PathBuf,
    pub backup_operation: Arc<TokioMutex<()>>,
    pub tunnel_operation: Arc<TokioMutex<()>>,
    pub connection_config_gate: Arc<RwLock<()>>,
    pub config_mutations: ConfigMutationCoordinator,
}

fn replace_allowed_session_cache(
    ids_cache: &StdRwLock<Vec<String>>,
    set_cache: &StdRwLock<Arc<HashSet<String>>>,
    names_cache: &StdRwLock<Vec<(String, String)>>,
    allowed_session_ids: Vec<String>,
    allowed_session_names: Vec<(String, String)>,
) {
    let mut ids = ids_cache
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut set = set_cache
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut names = names_cache
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *set = Arc::new(allowed_session_ids.iter().cloned().collect());
    *ids = allowed_session_ids;
    *names = allowed_session_names;
}

impl ApiServerHandle {
    pub fn is_finished(&self) -> bool {
        self.server_task.is_finished()
    }

    pub async fn shutdown(self) {
        self.shutdown_tx.send_replace(true);
        self.jobs.shutdown().await;
        tokio::join!(
            shutdown_task(self.server_task, "API server"),
            shutdown_task(self.log_task, "API log flusher")
        );
        self.remote
            .shutdown_automation_connections(&self.app, None)
            .await;
    }

    pub async fn update_allowed_sessions(
        &self,
        allowed_session_ids: Vec<String>,
        allowed_session_names: Vec<(String, String)>,
    ) {
        self.replace_allowed_sessions_cache(allowed_session_ids.clone(), allowed_session_names);
        self.execution_limiter
            .update_sessions(&allowed_session_ids)
            .await;
        let allowed_session_set = allowed_session_ids.iter().cloned().collect();
        self.jobs.cancel_disallowed(&allowed_session_set).await;
        self.remote
            .shutdown_automation_connections(&self.app, Some(&allowed_session_ids))
            .await;
    }

    pub(crate) fn replace_allowed_sessions_cache(
        &self,
        allowed_session_ids: Vec<String>,
        allowed_session_names: Vec<(String, String)>,
    ) {
        replace_allowed_session_cache(
            &self.allowed_session_ids,
            &self.allowed_session_set,
            &self.allowed_session_names,
            allowed_session_ids,
            allowed_session_names,
        );
    }

    pub fn allowed_session_ids_snapshot(&self) -> Vec<String> {
        self.allowed_session_ids
            .read()
            .map(|items| items.clone())
            .unwrap_or_default()
    }

    pub fn allowed_session_names_snapshot(&self) -> Vec<(String, String)> {
        self.allowed_session_names
            .read()
            .map(|items| items.clone())
            .unwrap_or_default()
    }
}

async fn shutdown_task(mut task: JoinHandle<()>, label: &str) {
    match timeout(SERVER_SHUTDOWN_TIMEOUT, &mut task).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) if error.is_cancelled() => {}
        Ok(Err(error)) => eprintln!("[helm] {label} task failed during shutdown: {error}"),
        Err(_) => {
            task.abort();
            if let Err(error) = task.await {
                if !error.is_cancelled() {
                    eprintln!("[helm] {label} task failed after abort: {error}");
                }
            }
        }
    }
}

#[derive(Debug)]
struct ApiError {
    error: String,
}

impl Serialize for ApiError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let (code, retryable) = classify_api_error(&self.error);
        let mut state = serializer.serialize_struct("ApiError", 5)?;
        state.serialize_field("error", &self.error)?;
        state.serialize_field("code", code)?;
        state.serialize_field("message", &self.error)?;
        state.serialize_field("retryable", &retryable)?;
        state.serialize_field(
            "requestId",
            &format!("req_{}", uuid::Uuid::new_v4().simple()),
        )?;
        state.end()
    }
}

fn classify_api_error(message: &str) -> (&'static str, bool) {
    let lower = message.to_ascii_lowercase();
    if message.contains("无效的 API Key") {
        ("AUTH_INVALID", false)
    } else if message.contains("无权访问") || message.contains("授权范围") {
        ("SESSION_FORBIDDEN", false)
    } else if message.contains("命令被拒绝") || message.contains("批量命令被拒绝") {
        ("COMMAND_REJECTED", false)
    } else if message.contains("队列繁忙")
        || message.contains("达到上限")
        || message.contains("同时最多")
    {
        ("RATE_LIMITED", true)
    } else if message.contains("Range 越界") || message.contains("多段 Range") {
        ("RANGE_NOT_SATISFIABLE", false)
    } else if message.contains("主机密钥") {
        ("HOST_KEY_CONFLICT", false)
    } else if message.contains("认证失败") || message.contains("身份验证") {
        ("REMOTE_AUTH_FAILED", false)
    } else if message.contains("SHA-256 校验失败") {
        ("CHECKSUM_MISMATCH", false)
    } else if message.contains("不存在") || message.contains("无法读取远程文件") {
        ("NOT_FOUND", false)
    } else if message.contains("配置已变更") || message.contains("已经结束") {
        ("CONFLICT", true)
    } else if message.contains("超过")
        && (message.contains("MiB") || message.contains("KiB") || message.contains("MB"))
    {
        ("PAYLOAD_TOO_LARGE", false)
    } else if message.contains("缺少")
        || message.contains("必须")
        || message.contains("仅支持")
        || message.contains("不能")
        || message.contains("无效")
        || message.contains("至少")
        || message.contains("格式")
        || message.contains("未知字段")
    {
        ("INVALID_ARGUMENT", false)
    } else if message.contains("未连接")
        || message.contains("不可用")
        || message.contains("连接")
        || lower.contains("ssh")
        || lower.contains("sftp")
        || lower.contains("timeout")
        || message.contains("超时")
    {
        ("REMOTE_UNAVAILABLE", true)
    } else {
        ("INTERNAL_ERROR", true)
    }
}

// ─── Shared helpers (used by handler sub-modules) ──────────────────────────────

async fn push_log(
    state: &ApiServerState,
    action: &str,
    detail: &str,
    success: bool,
    duration_ms: u64,
) {
    push_log_with_response(state, action, detail, success, duration_ms, None).await;
}

async fn push_log_with_response(
    state: &ApiServerState,
    action: &str,
    detail: &str,
    success: bool,
    duration_ms: u64,
    response: Option<String>,
) {
    let entry = ApiLogEntry {
        timestamp: Utc::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        action: action.to_string(),
        detail: detail.to_string(),
        success,
        duration_ms,
        response,
    };
    {
        let mut logs = state.logs.write().await;
        logs.push(entry.clone());
        if logs.len() > MAX_LOG_ENTRIES {
            let remove_count = logs.len() - MAX_LOG_ENTRIES;
            logs.drain(0..remove_count);
        }
    }
    if let Err(error) = state.app.emit(app_events::API_LOG, &entry) {
        eprintln!("[helm] failed to emit api log event: {error}");
    }
    state.log_dirty.notify_one();
}

pub(crate) async fn load_logs_from_file(path: &Path) -> Vec<ApiLogEntry> {
    let content = match tokio::fs::read(path).await {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(error) => {
            eprintln!("[helm] failed to read api logs {}: {error}", path.display());
            return Vec::new();
        }
    };
    match serde_json::from_slice(&content) {
        Ok(logs) => logs,
        Err(error) => {
            quarantine_invalid_api_logs(path, &error).await;
            Vec::new()
        }
    }
}

async fn quarantine_invalid_api_logs(path: &Path, error: &serde_json::Error) {
    let file_stem = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("api_logs");
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("json");
    let quarantine_path = path.with_file_name(format!(
        "{file_stem}.corrupt-{}.{extension}",
        uuid::Uuid::new_v4()
    ));
    match tokio::fs::rename(path, &quarantine_path).await {
        Ok(()) => eprintln!(
            "[helm] invalid api logs moved to {}: {error}",
            quarantine_path.display()
        ),
        Err(rename_error) => eprintln!(
            "[helm] invalid api logs ignored; failed to quarantine {}: {rename_error}; parse error: {error}",
            path.display()
        ),
    }
}

async fn flush_logs_to_file(logs: &Arc<RwLock<Vec<ApiLogEntry>>>, path: &Path) {
    let snapshot = logs.read().await.clone();
    if let Ok(json) = serde_json::to_string(&snapshot) {
        if let Err(error) = crate::atomic_file::write_atomic_async(path, json.as_bytes()).await {
            eprintln!("[helm] failed to flush api logs: {error}");
        }
    }
}

fn map_remote_error(e: String, state: &ApiServerState) -> (StatusCode, Json<ApiError>) {
    let lower = e.to_ascii_lowercase();
    if e.contains("队列繁忙") {
        (StatusCode::TOO_MANY_REQUESTS, Json(ApiError { error: e }))
    } else if e.contains("参数无效") || e.contains("必须") || e.contains("格式无效") {
        (StatusCode::BAD_REQUEST, Json(ApiError { error: e }))
    } else if e.contains("不存在") || e.contains("no such file") {
        (StatusCode::NOT_FOUND, Json(ApiError { error: e }))
    } else if e.contains("主机密钥") || e.contains("配置已变更") {
        (StatusCode::CONFLICT, Json(ApiError { error: e }))
    } else if e.contains("未连接") {
        let allowed_session_names = allowed_session_names_snapshot(state);
        let display_name = if allowed_session_names.is_empty() {
            "目标会话".to_string()
        } else {
            allowed_session_names
                .iter()
                .map(|(_, name)| name.as_str())
                .collect::<Vec<_>>()
                .join("、")
        };
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ApiError {
                error: format!(
                    "「{}」当前不可用，自动连接未成功；请检查主机密钥、认证信息或网络后重试。",
                    display_name
                ),
            }),
        )
    } else if e.contains("连接")
        || e.contains("网络")
        || e.contains("超时")
        || lower.contains("timeout")
        || lower.contains("connection")
        || lower.contains("handshake")
        || lower.contains("refused")
        || lower.contains("unreachable")
        || lower.contains("ssh")
        || lower.contains("sftp")
    {
        (StatusCode::SERVICE_UNAVAILABLE, Json(ApiError { error: e }))
    } else {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError { error: e }),
        )
    }
}

fn friendly_error_detail(detail: &str, state: &ApiServerState) -> String {
    let mut output = detail.to_string();
    for (sid, name) in allowed_session_names_snapshot(state) {
        output = output.replace(sid.as_str(), name.as_str());
    }
    output
}

fn allowed_session_ids_snapshot(state: &ApiServerState) -> Vec<String> {
    state
        .allowed_session_ids
        .read()
        .map(|items| items.clone())
        .unwrap_or_default()
}

fn allowed_session_set_snapshot(state: &ApiServerState) -> Arc<HashSet<String>> {
    state
        .allowed_session_set
        .read()
        .map(|items| items.clone())
        .unwrap_or_else(|_| Arc::new(HashSet::new()))
}

fn allowed_session_names_snapshot(state: &ApiServerState) -> Vec<(String, String)> {
    let allowed_ids = allowed_session_set_snapshot(state);
    state
        .allowed_session_names
        .read()
        .map(|items| {
            items
                .iter()
                .filter(|(id, _)| allowed_ids.contains(id))
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

fn truncate_for_log(value: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for (idx, ch) in value.chars().enumerate() {
        if idx >= max_chars {
            out.push_str("...");
            return out;
        }
        out.push(ch);
    }
    out
}

fn take_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn command_log_detail(command: &str, max_chars: usize) -> String {
    if contains_sensitive_log_marker(command) {
        let executable = command.split_whitespace().next().unwrap_or("命令");
        return format!(
            "{} [敏感参数已隐藏]",
            truncate_for_log(executable, max_chars.saturating_sub(12).max(1))
        );
    }
    truncate_for_log(command, max_chars)
}

fn response_log_preview(command: &str, response: &str, max_chars: usize) -> Option<String> {
    if response.is_empty() {
        return None;
    }
    if contains_sensitive_log_marker(command) {
        return Some("[响应已隐藏：命令可能包含敏感信息]".to_string());
    }

    let candidate = take_chars(response, max_chars.saturating_mul(2).max(max_chars));
    let mut redacted_lines = Vec::new();
    let mut private_key_block = false;
    for line in candidate.lines() {
        let lower = line.to_ascii_lowercase();
        if lower.contains("-----begin ") && lower.contains("private key-----") {
            private_key_block = true;
            redacted_lines.push("[私钥内容已隐藏]");
            continue;
        }
        if private_key_block {
            if lower.contains("-----end ") && lower.contains("private key-----") {
                private_key_block = false;
            }
            continue;
        }
        if contains_sensitive_log_marker(line) {
            redacted_lines.push("[敏感内容已隐藏]");
        } else {
            redacted_lines.push(line);
        }
    }
    let preview = take_chars(&redacted_lines.join("\n"), max_chars);
    (!preview.is_empty()).then_some(preview)
}

fn contains_sensitive_log_marker(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    [
        "password",
        "passwd",
        "passphrase",
        "secret",
        "token",
        "authorization",
        "bearer ",
        "api_key",
        "apikey",
        "access_key",
        "private_key",
        "private key",
        "id_rsa",
        "id_ed25519",
        "/etc/shadow",
        ".env",
        "credential",
        "cookie",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

// ─── Server startup ────────────────────────────────────────────────────────────

pub async fn start_server(options: ApiServerStartOptions) -> Result<ApiServerHandle, String> {
    let ApiServerStartOptions {
        app,
        remote,
        vault,
        port,
        api_key,
        allowed_session_ids,
        allowed_session_names,
        log_file,
        backup_operation,
        tunnel_operation,
        connection_config_gate,
        config_mutations,
    } = options;
    let existing_logs = load_logs_from_file(&log_file).await;
    let logs = Arc::new(RwLock::new(existing_logs));
    let log_dirty = Arc::new(Notify::new());
    let allowed_session_ids = Arc::new(StdRwLock::new(allowed_session_ids));
    let allowed_session_set = Arc::new(StdRwLock::new(Arc::new(
        allowed_session_ids
            .read()
            .map(|items| items.iter().cloned().collect::<HashSet<_>>())
            .unwrap_or_default(),
    )));
    let allowed_session_names = Arc::new(StdRwLock::new(allowed_session_names));
    let jobs = jobs::JobRegistry::default();
    let execution_limiter = ApiExecutionLimiter::new(
        &allowed_session_ids
            .read()
            .map(|items| items.clone())
            .unwrap_or_default(),
    );
    let handle_remote = remote.clone();
    let state = ApiServerState {
        api_key: Arc::new(RwLock::new(api_key.clone())),
        app: app.clone(),
        remote,
        vault,
        allowed_session_ids: allowed_session_ids.clone(),
        allowed_session_set: allowed_session_set.clone(),
        allowed_session_names: allowed_session_names.clone(),
        logs: logs.clone(),
        log_dirty: log_dirty.clone(),
        backup_operation,
        tunnel_operation,
        connection_config_gate,
        config_mutations,
        jobs: jobs.clone(),
        execution_limiter: execution_limiter.clone(),
        server_instance_id: Arc::from(format!("srv_{}", uuid::Uuid::new_v4().simple())),
    };

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|origin: &HeaderValue, _| {
            is_allowed_local_origin(origin)
        }))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::ACCEPT,
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::RANGE,
            header::IF_NONE_MATCH,
            HeaderName::from_static("last-event-id"),
        ])
        .expose_headers([
            header::ACCEPT_RANGES,
            header::CONTENT_DISPOSITION,
            header::CONTENT_RANGE,
            header::ETAG,
            header::CACHE_CONTROL,
        ]);

    let app_router = Router::new()
        // 鉴权探活
        .route("/api/auth", get(handlers_remote::auth_check))
        .route("/api/fields", get(handlers_remote::rest_fields))
        .route("/openapi.json", get(handlers_remote::rest_openapi))
        // ─── REST：会话生命周期 + 命令执行 + 文件列表 ──────────────────────────
        .route("/api/sessions", get(handlers_remote::rest_sessions))
        .route("/api/connect", post(handlers_remote::rest_connect))
        .route("/api/disconnect", post(handlers_remote::rest_disconnect))
        .route("/api/exec", post(handlers_remote::rest_exec))
        .route("/api/exec/batch", post(handlers_remote::rest_exec_batch))
        .route(
            "/api/jobs",
            get(handlers_jobs::rest_jobs_list).post(handlers_jobs::rest_jobs_create),
        )
        .route("/api/jobs/{job_id}", get(handlers_jobs::rest_job_get))
        .route(
            "/api/jobs/{job_id}/events",
            get(handlers_jobs::rest_job_events),
        )
        .route(
            "/api/jobs/{job_id}/cancel",
            post(handlers_jobs::rest_job_cancel),
        )
        .route("/api/latency", post(handlers_remote::rest_latency))
        .route("/api/files", get(handlers_remote::rest_files))
        .route("/api/files/page", get(handlers_remote::rest_files_page))
        .route("/api/files/stat", get(handlers_remote::rest_file_stat))
        // ─── REST：隧道管理（CRUD + start/stop） ───────────────────────────────
        .route(
            "/api/tunnels",
            get(handlers_admin::rest_tunnels_list).post(handlers_admin::rest_tunnels_create),
        )
        .route(
            "/api/tunnels/{tunnel_id}",
            patch(handlers_admin::rest_tunnels_update).delete(handlers_admin::rest_tunnels_delete),
        )
        .route(
            "/api/tunnels/{tunnel_id}/start",
            post(handlers_admin::rest_tunnels_start),
        )
        .route(
            "/api/tunnels/{tunnel_id}/stop",
            post(handlers_admin::rest_tunnels_stop),
        )
        // ─── REST：备份管理 ────────────────────────────────────────────────────
        .route(
            "/api/backup/settings",
            get(handlers_admin::rest_backup_settings_get)
                .put(handlers_admin::rest_backup_settings_update)
                .patch(handlers_admin::rest_backup_settings_patch),
        )
        .route(
            "/api/backup/records",
            get(handlers_admin::rest_backup_records_list),
        )
        .route(
            "/api/backup/records/{record_id}",
            delete(handlers_admin::rest_backup_record_delete),
        )
        .route("/api/backup/run", post(handlers_admin::rest_backup_run))
        // ─── 文件传输（Bearer 鉴权 + 流式） ────────────────────────────────────
        // PUT body 是文件原始字节，服务端流式直写 SFTP，无 temp 文件。
        .route("/api/upload", put(handlers_remote::upload_file_raw))
        .route("/api/download", get(handlers_remote::download_file))
        .layer(cors)
        .with_state(state);

    let listener = TcpListener::bind(format!("127.0.0.1:{}", port))
        .await
        .map_err(|e| format!("无法绑定端口 {}: {}", port, e))?;

    let actual_port = listener
        .local_addr()
        .map_err(|e| format!("获取端口失败: {}", e))?
        .port();

    let (shutdown_tx, shutdown_rx) = watch::channel(false);

    let log_task = {
        let logs_for_flusher = logs.clone();
        let log_file_for_flusher = log_file.clone();
        let dirty = log_dirty.clone();
        let mut flusher_shutdown = shutdown_tx.subscribe();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = dirty.notified() => {
                        tokio::time::sleep(LOG_FLUSH_DEBOUNCE).await;
                        flush_logs_to_file(&logs_for_flusher, &log_file_for_flusher).await;
                    }
                    _ = flusher_shutdown.changed() => {
                        if *flusher_shutdown.borrow_and_update() {
                            flush_logs_to_file(&logs_for_flusher, &log_file_for_flusher).await;
                            break;
                        }
                    }
                }
            }
        })
    };

    let server_shutdown = shutdown_tx.clone();
    let server_remote = handle_remote.clone();
    let server_app = app.clone();
    let server_jobs = jobs.clone();
    let server_task = tokio::spawn(async move {
        let result = serve_router_until_shutdown(listener, app_router, shutdown_rx).await;
        if let Err(error) = &result {
            eprintln!("[helm] api server stopped with error: {error}");
        }
        // The listener can terminate without a command-driven shutdown (for
        // example after an accept-loop failure). Wake the log flusher and tear
        // down automation resources even if no later status query observes it.
        server_shutdown.send_replace(true);
        server_jobs.shutdown().await;
        server_remote
            .shutdown_automation_connections(&server_app, None)
            .await;
        if result.is_err() {
            crate::events::emit(
                &server_app,
                crate::events::API_STATUS,
                ApiServerInfo {
                    running: false,
                    port: 0,
                    api_key: String::new(),
                },
            );
        }
    });

    Ok(ApiServerHandle {
        shutdown_tx,
        server_task,
        log_task,
        app,
        remote: handle_remote,
        port: actual_port,
        api_key,
        allowed_session_ids,
        allowed_session_set,
        allowed_session_names,
        log_file,
        logs,
        jobs,
        execution_limiter,
    })
}

async fn serve_router_until_shutdown(
    listener: TcpListener,
    app_router: Router,
    mut shutdown_rx: watch::Receiver<bool>,
) -> std::io::Result<()> {
    axum::serve(listener, app_router)
        .with_graceful_shutdown(async move {
            while !*shutdown_rx.borrow_and_update() {
                if shutdown_rx.changed().await.is_err() {
                    break;
                }
            }
        })
        .await
}

fn is_allowed_local_origin(origin: &HeaderValue) -> bool {
    let Ok(origin_str) = origin.to_str() else {
        return false;
    };
    if origin_str == "tauri://localhost" {
        return true;
    }
    let stripped = origin_str
        .strip_prefix("http://")
        .or_else(|| origin_str.strip_prefix("https://"));
    let Some(host_with_port) = stripped else {
        return false;
    };
    let authority = host_with_port.split('/').next().unwrap_or("");
    let host = if let Some(ipv6) = authority.strip_prefix('[') {
        ipv6.split(']').next().unwrap_or("")
    } else {
        authority
            .rsplit_once(':')
            .map(|(host, _)| host)
            .unwrap_or(authority)
    };
    matches!(host, "localhost" | "127.0.0.1" | "::1" | "tauri.localhost")
}

#[cfg(test)]
mod tests {
    use super::{
        command_log_detail, is_allowed_local_origin, load_logs_from_file,
        replace_allowed_session_cache, response_log_preview, serve_router_until_shutdown, ApiError,
        ApiExecutionLimiter, MAX_API_EXEC_CONCURRENCY, MAX_API_EXEC_CONCURRENCY_PER_SESSION,
    };
    use axum::http::HeaderValue;
    use axum::Router;
    use std::{
        collections::HashSet,
        sync::{Arc, RwLock},
    };
    use tempfile::tempdir;
    use tokio::{net::TcpListener, sync::watch};

    #[test]
    fn api_logs_hide_sensitive_command_arguments_and_output() {
        let detail = command_log_detail("curl -H 'Authorization: Bearer top-secret'", 77);
        assert!(detail.contains("敏感参数已隐藏"));
        assert!(!detail.contains("top-secret"));

        let preview = response_log_preview(
            "cat ~/.ssh/id_rsa",
            "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----",
            2_000,
        )
        .unwrap();
        assert!(preview.contains("响应已隐藏"));
        assert!(!preview.contains("OPENSSH PRIVATE KEY"));
    }

    #[test]
    fn api_errors_keep_legacy_text_and_add_machine_readable_fields() {
        let value = serde_json::to_value(ApiError {
            error: "执行队列繁忙，请稍后重试".to_string(),
        })
        .unwrap();
        assert_eq!(value["error"], "执行队列繁忙，请稍后重试");
        assert_eq!(value["message"], value["error"]);
        assert_eq!(value["code"], "RATE_LIMITED");
        assert_eq!(value["retryable"], true);
        assert!(value["requestId"]
            .as_str()
            .is_some_and(|request_id| request_id.starts_with("req_")));

        let checksum = serde_json::to_value(ApiError {
            error: "SHA-256 校验失败：摘要不一致".to_string(),
        })
        .unwrap();
        assert_eq!(checksum["code"], "CHECKSUM_MISMATCH");
        assert_eq!(checksum["retryable"], false);
    }

    #[test]
    fn api_logs_keep_normal_output_preview() {
        assert_eq!(
            response_log_preview("uname -a", "Linux helm", 2_000).as_deref(),
            Some("Linux helm")
        );
    }

    #[test]
    fn api_cors_accepts_browser_and_tauri_loopback_origins_only() {
        for origin in [
            "http://127.0.0.1:1420",
            "http://localhost:1420",
            "https://tauri.localhost",
            "tauri://localhost",
        ] {
            assert!(is_allowed_local_origin(
                &HeaderValue::from_str(origin).unwrap()
            ));
        }
        assert!(!is_allowed_local_origin(&HeaderValue::from_static(
            "https://example.com"
        )));
    }

    #[test]
    fn authorization_cache_replaces_ids_names_and_membership_together() {
        let ids = RwLock::new(vec!["session-old".to_string()]);
        let set = RwLock::new(Arc::new(HashSet::from(["session-old".to_string()])));
        let names = RwLock::new(vec![("session-old".to_string(), "旧会话".to_string())]);

        replace_allowed_session_cache(
            &ids,
            &set,
            &names,
            vec!["session-new".to_string()],
            vec![("session-new".to_string(), "新会话".to_string())],
        );

        assert_eq!(*ids.read().unwrap(), ["session-new"]);
        assert_eq!(
            *names.read().unwrap(),
            [("session-new".to_string(), "新会话".to_string())]
        );
        let allowed = set.read().unwrap();
        assert!(allowed.contains("session-new"));
        assert!(!allowed.contains("session-old"));
    }

    #[tokio::test]
    async fn execution_limiter_preserves_busy_session_across_reauthorization() {
        let session_id = "session-a".to_string();
        let limiter = ApiExecutionLimiter::new(std::slice::from_ref(&session_id));
        let original = limiter
            .sessions
            .lock()
            .await
            .get(&session_id)
            .unwrap()
            .clone();
        let mut permits = Vec::new();
        for _ in 0..MAX_API_EXEC_CONCURRENCY_PER_SESSION {
            permits.push(limiter.acquire(&session_id).await.unwrap());
        }
        assert_eq!(original.available_permits(), 0);

        limiter.update_sessions(&[]).await;
        limiter
            .update_sessions(std::slice::from_ref(&session_id))
            .await;
        let current = limiter
            .sessions
            .lock()
            .await
            .get(&session_id)
            .unwrap()
            .clone();
        assert!(Arc::ptr_eq(&original, &current));

        drop(current);
        drop(original);
        drop(permits);
        limiter.update_sessions(&[]).await;
        assert!(!limiter.sessions.lock().await.contains_key(&session_id));
    }

    #[tokio::test]
    async fn execution_limiter_caps_total_concurrency() {
        let session_ids = (0..MAX_API_EXEC_CONCURRENCY)
            .map(|index| format!("session-{index}"))
            .collect::<Vec<_>>();
        let limiter = ApiExecutionLimiter::new(&session_ids);
        let mut permits = Vec::new();
        for session_id in &session_ids {
            permits.push(limiter.acquire(session_id).await.unwrap());
        }
        assert_eq!(limiter.global.available_permits(), 0);
        drop(permits);
    }

    #[tokio::test]
    async fn corrupt_api_logs_are_quarantined() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("api_logs.json");
        tokio::fs::write(&path, b"{not-json").await.unwrap();

        assert!(load_logs_from_file(&path).await.is_empty());
        assert!(!path.exists());
        let names = std::fs::read_dir(directory.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(names.len(), 1);
        assert!(names[0].starts_with("api_logs.corrupt-"));
        assert!(names[0].ends_with(".json"));
    }

    #[tokio::test]
    async fn graceful_shutdown_releases_the_api_port_before_returning() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let server = tokio::spawn(serve_router_until_shutdown(
            listener,
            Router::new(),
            shutdown_rx,
        ));

        shutdown_tx.send_replace(true);
        server.await.unwrap().unwrap();

        let rebound = TcpListener::bind(("127.0.0.1", port)).await.unwrap();
        drop(rebound);
    }
}
