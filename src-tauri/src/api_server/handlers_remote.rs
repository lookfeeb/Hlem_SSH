use std::ops::Bound;

use axum::{
    body::Body,
    extract::{Query, State as AxumState},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{Json, Response},
};
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::{ReaderStream, StreamReader};

use super::auth::{verify_auth, verify_session_access};
use super::field_catalog;
use super::guard::check_dangerous_command;
use super::{
    allowed_session_ids_snapshot, friendly_error_detail, map_remote_error, push_log,
    push_log_with_response, take_chars, truncate_for_log, ApiError, ApiServerState,
};

const MAX_API_EXEC_TIMEOUT_MS: u64 = 5 * 60_000;

// ─── Public types (re-exported from mod.rs) ────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionItem {
    pub session_id: String,
    pub name: String,
    pub host: String,
    pub connected: bool,
    pub sftp_available: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub file_type: String,
    pub size: u64,
}

// ─── Private types ─────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UploadResponse {
    success: bool,
    remote_path: String,
    size: u64,
}

/// raw PUT 上传 query。Content-Range 头可选，用于并发分块。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UploadRawQuery {
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    remote_path: String,
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
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FilesQuery {
    session_id: String,
    path: String,
}

async fn require_auth(
    state: &ApiServerState,
    headers: &HeaderMap,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let key = state.api_key.read().await;
    verify_auth(headers, &key)
}

fn bad_request(message: &str) -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::BAD_REQUEST,
        Json(ApiError {
            error: message.to_string(),
        }),
    )
}

fn internal_error(message: impl std::fmt::Display) -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ApiError {
            error: message.to_string(),
        }),
    )
}

fn elapsed_ms(start: std::time::Instant) -> u64 {
    start.elapsed().as_millis() as u64
}

// ─── Auth probe ────────────────────────────────────────────────────────────────

/// 鉴权探活 + 端点目录。
pub async fn auth_check(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    Ok(Json(serde_json::json!({
        "authenticated": true,
        "auth": "Authorization: Bearer <api_key>",
        "rest": {
            "GET /api/fields": "field catalog",
            "GET /api/sessions": "list connected sessions",
            "POST /api/connect": "{sessionId} → ConnectionInfo",
            "POST /api/disconnect": "{sessionId} → {success}",
            "POST /api/exec": "{sessionId, command, timeoutMs?} → ExecResult",
            "GET /api/files?sessionId=&path=": "list files",
            "PUT /api/upload?sessionId=&remotePath=": "raw bytes body, → {success, remotePath, size}",
            "GET /api/download?sessionId=&path=": "supports Range",
            "GET /api/tunnels": "list tunnels",
            "POST /api/tunnels": "{input} create tunnel, return list",
            "PATCH /api/tunnels/{id}": "{input} update tunnel, return list",
            "DELETE /api/tunnels/{id}": "delete tunnel, return list",
            "POST /api/tunnels/{id}/start": "→ {forwardId, bindHost, bindPort}",
            "POST /api/tunnels/{id}/stop": "→ {success}",
            "GET /api/backup/settings": "get backup settings",
            "PUT /api/backup/settings": "{settings} update backup settings",
            "GET /api/backup/records": "list backup records",
            "POST /api/backup/run": "run backup now → result array",
            "DELETE /api/backup/records/{id}?deleteFile=true": "delete record, return list"
        }
    })))
}

/// `GET /api/fields` — 返回同一份字段库 JSON，供 AI 或外部工具动态读取。
pub async fn rest_fields(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let start = std::time::Instant::now();
    let catalog = field_catalog::catalog_json()
        .map_err(|e| internal_error(format!("字段库解析失败: {}", e)))?;
    push_log(&state, "rest/fields", "字段库", true, elapsed_ms(start)).await;
    Ok(Json(catalog))
}

// ─── REST: 会话生命周期 / 命令执行 / 文件列出 ───────────────────────────────────

/// `GET /api/sessions` — 列出已连接会话。
pub async fn rest_sessions(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
) -> Result<Json<Vec<SessionItem>>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;

    let start = std::time::Instant::now();
    let mut sessions = state.remote.list_connected_sessions().await;
    let allowed_session_ids = allowed_session_ids_snapshot(&state);
    if !allowed_session_ids.is_empty() {
        sessions.retain(|session| allowed_session_ids.contains(&session.session_id));
    }
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

    if body.session_id.is_empty() {
        return Err(bad_request("缺少 sessionId"));
    }
    verify_session_access(&state, &body.session_id)?;

    let start = std::time::Instant::now();
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

    match state
        .remote
        .api_connect_session(&state.app, session, known_host)
        .await
    {
        Ok(info) => {
            let elapsed = elapsed_ms(start);
            push_log(&state, "rest/connect", &body.session_id, true, elapsed).await;
            Ok(Json(serde_json::to_value(info).unwrap_or_default()))
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
            Err(internal_error(msg))
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

    if body.session_id.is_empty() {
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
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;

    if body.session_id.is_empty() || body.command.is_empty() {
        return Err(bad_request("缺少 sessionId 或 command"));
    }
    if let Some(reason) = check_dangerous_command(&body.command) {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ApiError {
                error: format!("命令被拒绝: {}", reason),
            }),
        ));
    }
    verify_session_access(&state, &body.session_id)?;

    let timeout_ms = body
        .timeout_ms
        .unwrap_or(30_000)
        .clamp(1, MAX_API_EXEC_TIMEOUT_MS);
    let start = std::time::Instant::now();
    let detail = truncate_for_log(&body.command, 77);

    match state
        .remote
        .api_exec(&body.session_id, &body.command, timeout_ms)
        .await
    {
        Ok(result) => {
            let elapsed = elapsed_ms(start);
            let success = !result.timed_out && result.exit_status.unwrap_or(1) == 0;
            // 日志里只截一段输出当预览
            let preview: String = {
                let mut buf = String::new();
                buf.push_str(&result.stdout);
                buf = take_chars(&buf, 2000);
                if buf.is_empty() { None } else { Some(buf) }.unwrap_or_default()
            };
            push_log_with_response(
                &state,
                "rest/exec",
                &detail,
                success,
                elapsed,
                if preview.is_empty() {
                    None
                } else {
                    Some(preview)
                },
            )
            .await;
            Ok(Json(serde_json::to_value(result).unwrap_or_default()))
        }
        Err(e) => {
            let elapsed = elapsed_ms(start);
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

/// `GET /api/files?sessionId=&path=` — 列出远端目录。
pub async fn rest_files(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Query(query): Query<FilesQuery>,
) -> Result<Json<Vec<FileEntry>>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;

    if query.session_id.is_empty() {
        return Err(bad_request("缺少 sessionId"));
    }
    verify_session_access(&state, &query.session_id)?;

    let start = std::time::Instant::now();
    match state
        .remote
        .api_list_files(&query.session_id, &query.path)
        .await
    {
        Ok(entries) => {
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

// ─── 文件传输（Bearer 鉴权） ──────────────────────────────────────────────────

/// raw PUT 上传：流式直写 SFTP，零 temp 文件。
pub async fn upload_file_raw(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Query(query): Query<UploadRawQuery>,
    body: Body,
) -> Result<Json<UploadResponse>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;

    if query.session_id.is_empty() {
        return Err(bad_request("缺少 sessionId 查询参数"));
    }
    if query.remote_path.is_empty() {
        return Err(bad_request("缺少 remotePath 查询参数"));
    }

    verify_session_access(&state, &query.session_id)?;

    let start = std::time::Instant::now();

    let stream = body.into_data_stream().map_err(std::io::Error::other);
    let mut reader = StreamReader::new(stream);

    let bytes_written = match state
        .remote
        .api_upload_stream(&query.session_id, &query.remote_path, &mut reader)
        .await
    {
        Ok(n) => n,
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
            return Err(map_remote_error(e, &state));
        }
    };

    let elapsed = elapsed_ms(start);
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
    }))
}

/// 下载：支持 Range 请求 → 206 Partial Content + Content-Range + Accept-Ranges。
pub async fn download_file(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Query(query): Query<DownloadQuery>,
) -> Result<Response<Body>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;

    verify_session_access(&state, &query.session_id)?;
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
    let total_size = metadata.len();

    let range = parse_range_header(headers.get(header::RANGE), total_size);
    let (status, start_offset, end_offset) = match range {
        ParsedRange::Full => (StatusCode::OK, 0u64, total_size.saturating_sub(1)),
        ParsedRange::Satisfiable { start, end } => (StatusCode::PARTIAL_CONTENT, start, end),
        ParsedRange::Unsatisfiable => {
            return Err((
                StatusCode::RANGE_NOT_SATISFIABLE,
                Json(ApiError {
                    error: format!("Range 越界：文件大小 {} 字节", total_size),
                }),
            ));
        }
        ParsedRange::Invalid => (StatusCode::OK, 0u64, total_size.saturating_sub(1)),
    };
    let send_len = if total_size == 0 {
        0
    } else {
        end_offset - start_offset + 1
    };

    // 大段范围（≥ 32MB）走并行多 File handle，与 UI 下载共用阈值和缓冲常量。
    let body = if send_len >= crate::remote::PARALLEL_DOWNLOAD_THRESHOLD
        && crate::remote::PARALLEL_DOWNLOAD_PARTS >= 2
    {
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
            Ok(stream) => Body::from_stream(stream),
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
                return Err(internal_error(format!("并行下载初始化失败: {}", e)));
            }
        }
    } else {
        let mut remote_file = match sftp.open(query.path.clone()).await {
            Ok(f) => f,
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
                return Err(internal_error(format!("打开远程文件失败: {}", e)));
            }
        };

        if start_offset > 0 {
            if let Err(e) = remote_file
                .seek(std::io::SeekFrom::Start(start_offset))
                .await
            {
                let elapsed = elapsed_ms(start);
                push_log(
                    &state,
                    "download",
                    &friendly_error_detail(
                        &format!("{} → seek {}: {}", query.path, start_offset, e),
                        &state,
                    ),
                    false,
                    elapsed,
                )
                .await;
                return Err(internal_error(format!("seek 远程文件失败: {}", e)));
            }
        }

        let limited = remote_file.take(send_len);
        let stream = ReaderStream::with_capacity(limited, 1024 * 1024);
        Body::from_stream(stream)
    };

    let elapsed = elapsed_ms(start);
    let parallel_used = send_len >= crate::remote::PARALLEL_DOWNLOAD_THRESHOLD
        && crate::remote::PARALLEL_DOWNLOAD_PARTS >= 2;
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
    push_log(&state, "download", &log_detail, true, elapsed).await;

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
    Invalid,
}

fn parse_range_header(header_value: Option<&HeaderValue>, total: u64) -> ParsedRange {
    let Some(raw) = header_value.and_then(|v| v.to_str().ok()) else {
        return ParsedRange::Full;
    };
    let raw = raw.trim();
    let Some(spec) = raw.strip_prefix("bytes=") else {
        return ParsedRange::Invalid;
    };
    let first = spec.split(',').next().unwrap_or("").trim();
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
