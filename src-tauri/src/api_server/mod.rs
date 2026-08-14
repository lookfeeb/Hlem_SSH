mod auth;
mod field_catalog;
mod guard;
mod handlers_admin;
mod handlers_remote;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock as StdRwLock};

use axum::{
    http::{header, HeaderValue, Method, StatusCode},
    response::Json,
    routing::{delete, get, patch, post, put},
    Router,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use tokio::{
    net::TcpListener,
    sync::{watch, Mutex as TokioMutex, Notify, RwLock},
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
    pub backup_operation: Arc<TokioMutex<()>>,
    pub tunnel_operation: Arc<TokioMutex<()>>,
    pub connection_config_gate: Arc<RwLock<()>>,
    pub config_mutations: ConfigMutationCoordinator,
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
    pub backup_operation: Arc<TokioMutex<()>>,
    pub tunnel_operation: Arc<TokioMutex<()>>,
    pub connection_config_gate: Arc<RwLock<()>>,
    pub config_mutations: ConfigMutationCoordinator,
}

impl ApiServerHandle {
    pub fn is_finished(&self) -> bool {
        self.server_task.is_finished()
    }

    pub async fn shutdown(self) {
        if let Err(error) = self.shutdown_tx.send(true) {
            eprintln!("[helm] failed to signal API server shutdown: {error}");
        }
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
    ) -> Result<(), String> {
        {
            let mut ids = self
                .allowed_session_ids
                .write()
                .map_err(|_| "更新 API 会话限制失败：内部锁错误".to_string())?;
            let mut names = self
                .allowed_session_names
                .write()
                .map_err(|_| "更新 API 会话名称失败：内部锁错误".to_string())?;
            *ids = allowed_session_ids.clone();
            *names = allowed_session_names;
        }
        self.remote
            .shutdown_automation_connections(&self.app, Some(&allowed_session_ids))
            .await;
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
                    "「{}」当前不可用，自动连接未成功；请检查主机密钥、认证信息或网络后重试。",
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
    let runtime_ids = state
        .allowed_session_ids
        .read()
        .map(|items| items.clone())
        .unwrap_or_default();
    let configured_ids = state
        .vault
        .lock()
        .ok()
        .and_then(|store| store.snapshot().ok())
        .map(|snapshot| {
            let settings = snapshot.data.settings;
            let mut ids = settings.ai_api_session_ids;
            if let Some(legacy_id) = settings.ai_api_session_id {
                if !legacy_id.is_empty() && !ids.contains(&legacy_id) {
                    ids.push(legacy_id);
                }
            }
            ids
        })
        .unwrap_or_default();
    intersect_allowed_session_ids(&runtime_ids, &configured_ids)
}

fn allowed_session_names_snapshot(state: &ApiServerState) -> Vec<(String, String)> {
    let allowed_ids = allowed_session_ids_snapshot(state);
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

fn intersect_allowed_session_ids(runtime_ids: &[String], configured_ids: &[String]) -> Vec<String> {
    runtime_ids
        .iter()
        .filter(|id| configured_ids.contains(id))
        .cloned()
        .collect()
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
    let allowed_session_names = Arc::new(StdRwLock::new(allowed_session_names));
    let handle_remote = remote.clone();
    let state = ApiServerState {
        api_key: Arc::new(RwLock::new(api_key.clone())),
        app: app.clone(),
        remote,
        vault,
        allowed_session_ids: allowed_session_ids.clone(),
        allowed_session_names: allowed_session_names.clone(),
        logs: logs.clone(),
        log_dirty: log_dirty.clone(),
        backup_operation,
        tunnel_operation,
        connection_config_gate,
        config_mutations,
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
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE, header::RANGE])
        .expose_headers([
            header::ACCEPT_RANGES,
            header::CONTENT_DISPOSITION,
            header::CONTENT_RANGE,
        ]);

    let app_router = Router::new()
        // 鉴权探活
        .route("/api/auth", get(handlers_remote::auth_check))
        .route("/api/fields", get(handlers_remote::rest_fields))
        // ─── REST：会话生命周期 + 命令执行 + 文件列表 ──────────────────────────
        .route("/api/sessions", get(handlers_remote::rest_sessions))
        .route("/api/connect", post(handlers_remote::rest_connect))
        .route("/api/disconnect", post(handlers_remote::rest_disconnect))
        .route("/api/exec", post(handlers_remote::rest_exec))
        .route("/api/exec/batch", post(handlers_remote::rest_exec_batch))
        .route("/api/latency", post(handlers_remote::rest_latency))
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

    let server_shutdown = shutdown_tx.clone();
    let server_remote = handle_remote.clone();
    let server_app = app.clone();
    let server_task = tokio::spawn(async move {
        let result = axum::serve(listener, app_router)
            .with_graceful_shutdown(async move {
                while !*shutdown_rx.borrow_and_update() {
                    if shutdown_rx.changed().await.is_err() {
                        break;
                    }
                }
            })
            .await;
        if let Err(error) = &result {
            eprintln!("[helm] api server stopped with error: {error}");
        }
        // The listener can terminate without a command-driven shutdown (for
        // example after an accept-loop failure). Wake the log flusher and tear
        // down automation resources even if no later status query observes it.
        let _ = server_shutdown.send(true);
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

#[cfg(test)]
mod tests {
    use super::{
        command_log_detail, intersect_allowed_session_ids, load_logs_from_file,
        response_log_preview,
    };
    use tempfile::tempdir;

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
    fn api_logs_keep_normal_output_preview() {
        assert_eq!(
            response_log_preview("uname -a", "Linux helm", 2_000).as_deref(),
            Some("Linux helm")
        );
    }

    #[test]
    fn effective_api_authorization_is_the_runtime_and_persisted_intersection() {
        let runtime = vec!["session-a".to_string(), "session-b".to_string()];
        let configured = vec!["session-b".to_string(), "session-c".to_string()];
        assert_eq!(
            intersect_allowed_session_ids(&runtime, &configured),
            ["session-b"]
        );
        assert!(intersect_allowed_session_ids(&runtime, &[]).is_empty());
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
}
