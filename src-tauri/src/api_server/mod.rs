mod auth;
mod field_catalog;
mod guard;
mod handlers_admin;
mod handlers_remote;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock as StdRwLock};

use axum::{
    extract::DefaultBodyLimit,
    http::{header, HeaderValue, Method, StatusCode},
    response::Json,
    routing::{delete, get, patch, post, put},
    Router,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use tokio::{
    net::TcpListener,
    sync::{watch, Notify, RwLock},
    task::JoinHandle,
    time::{timeout, Duration},
};
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::events as app_events;
use crate::remote::RemoteRuntime;
use crate::vault::VaultStore;

use tauri::{AppHandle, Emitter};

pub use handlers_remote::{FileEntry, SessionItem};

// ─── Constants ─────────────────────────────────────────────────────────────────

const MAX_UPLOAD_BODY: usize = 512 * 1024 * 1024;
const MAX_LOG_ENTRIES: usize = 100;
const LOG_FLUSH_DEBOUNCE: Duration = Duration::from_secs(1);
const SERVER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);

// ─── Public types ──────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct ApiServerState {
    pub api_key: Arc<RwLock<String>>,
    pub app: AppHandle,
    pub remote: RemoteRuntime,
    pub vault: Arc<Mutex<VaultStore>>,
    pub allowed_session_ids: Arc<StdRwLock<Vec<String>>>,
    pub allowed_session_names: Arc<StdRwLock<Vec<(String, String)>>>,
    pub logs: Arc<RwLock<Vec<ApiLogEntry>>>,
    pub log_dirty: Arc<Notify>,
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
    pub port: u16,
    pub api_key: String,
    pub allowed_session_ids: Arc<StdRwLock<Vec<String>>>,
    pub allowed_session_names: Arc<StdRwLock<Vec<(String, String)>>>,
    pub log_file: PathBuf,
    pub logs: Arc<RwLock<Vec<ApiLogEntry>>>,
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
}

impl ApiServerHandle {
    pub fn is_finished(&self) -> bool {
        self.server_task.is_finished()
    }

    pub async fn shutdown(self) {
        if let Err(error) = self.shutdown_tx.send(true) {
            eprintln!("[helm] failed to signal API server shutdown: {error}");
        }
        shutdown_task(self.server_task, "API server").await;
        shutdown_task(self.log_task, "API log flusher").await;
    }

    pub fn update_allowed_sessions(
        &self,
        allowed_session_ids: Vec<String>,
        allowed_session_names: Vec<(String, String)>,
    ) -> Result<(), String> {
        *self
            .allowed_session_ids
            .write()
            .map_err(|_| "更新 API 会话限制失败：内部锁错误".to_string())? = allowed_session_ids;
        *self
            .allowed_session_names
            .write()
            .map_err(|_| "更新 API 会话名称失败：内部锁错误".to_string())? = allowed_session_names;
        Ok(())
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

#[derive(Serialize)]
struct ApiError {
    error: String,
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

async fn load_logs_from_file(path: &PathBuf) -> Vec<ApiLogEntry> {
    match tokio::fs::read_to_string(path).await {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

async fn flush_logs_to_file(logs: &Arc<RwLock<Vec<ApiLogEntry>>>, path: &PathBuf) {
    let snapshot = logs.read().await.clone();
    if let Ok(json) = serde_json::to_string(&snapshot) {
        if let Err(error) = tokio::fs::write(path, json).await {
            eprintln!("[helm] failed to flush api logs: {error}");
        }
    }
}

fn map_remote_error(e: String, state: &ApiServerState) -> (StatusCode, Json<ApiError>) {
    if e.contains("未连接") {
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
                    "「{}」未连接。请在 HelM 主窗口中手动连接该会话后重试。",
                    display_name
                ),
            }),
        )
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

fn allowed_session_names_snapshot(state: &ApiServerState) -> Vec<(String, String)> {
    state
        .allowed_session_names
        .read()
        .map(|items| items.clone())
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
    } = options;
    let existing_logs = load_logs_from_file(&log_file).await;
    let logs = Arc::new(RwLock::new(existing_logs));
    let log_dirty = Arc::new(Notify::new());
    let allowed_session_ids = Arc::new(StdRwLock::new(allowed_session_ids));
    let allowed_session_names = Arc::new(StdRwLock::new(allowed_session_names));
    let state = ApiServerState {
        api_key: Arc::new(RwLock::new(api_key.clone())),
        app: app.clone(),
        remote,
        vault,
        allowed_session_ids: allowed_session_ids.clone(),
        allowed_session_names: allowed_session_names.clone(),
        logs: logs.clone(),
        log_dirty: log_dirty.clone(),
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
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]);

    let app_router = Router::new()
        // 鉴权探活
        .route("/api/auth", get(handlers_remote::auth_check))
        .route("/api/fields", get(handlers_remote::rest_fields))
        // ─── REST：会话生命周期 + 命令执行 + 文件列表 ──────────────────────────
        .route("/api/sessions", get(handlers_remote::rest_sessions))
        .route("/api/connect", post(handlers_remote::rest_connect))
        .route("/api/disconnect", post(handlers_remote::rest_disconnect))
        .route("/api/exec", post(handlers_remote::rest_exec))
        .route("/api/files", get(handlers_remote::rest_files))
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
                .put(handlers_admin::rest_backup_settings_update),
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
        .layer(DefaultBodyLimit::max(MAX_UPLOAD_BODY))
        .layer(cors)
        .with_state(state);

    let listener = TcpListener::bind(format!("127.0.0.1:{}", port))
        .await
        .map_err(|e| format!("无法绑定端口 {}: {}", port, e))?;

    let actual_port = listener
        .local_addr()
        .map_err(|e| format!("获取端口失败: {}", e))?
        .port();

    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);

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

    let server_task = tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, app_router)
            .with_graceful_shutdown(async move {
                while !*shutdown_rx.borrow_and_update() {
                    if shutdown_rx.changed().await.is_err() {
                        break;
                    }
                }
            })
            .await
        {
            eprintln!("[helm] api server stopped with error: {error}");
        }
    });

    Ok(ApiServerHandle {
        shutdown_tx,
        server_task,
        log_task,
        port: actual_port,
        api_key,
        allowed_session_ids,
        allowed_session_names,
        log_file,
        logs,
    })
}

fn is_allowed_local_origin(origin: &HeaderValue) -> bool {
    let Ok(origin_str) = origin.to_str() else {
        return false;
    };
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
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}
