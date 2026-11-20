use tauri::{AppHandle, Manager, State};

use crate::api_server::{self, ApiLogEntry, ApiServerInfo};
use crate::config::ConfigSnapshot;
use crate::errors::{AppError, AppResult};
use crate::events;

use super::api_startup::{retry_api_start, API_STARTUP_MAX_WAIT, API_STARTUP_NORMAL_WAIT};
use super::{ensure_vault_unlocked, with_store, AppState};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiServerConfigureResult {
    info: ApiServerInfo,
    snapshot: ConfigSnapshot,
}

#[tauri::command]
pub async fn api_server_configure_and_start(
    app: AppHandle,
    state: State<'_, AppState>,
    port: u16,
) -> AppResult<ApiServerConfigureResult> {
    state.api_startup.cancel();
    let ticket = state.config_mutations.ticket();
    let _operation_guard = state.api_server_operation.lock().await;
    ensure_vault_unlocked(&state)?;
    let effective_port = {
        let handle = state.api_server.lock().await;
        handle
            .as_ref()
            .filter(|handle| !handle.is_finished())
            .map(|handle| handle.port)
            .unwrap_or(port)
    };
    let mutation_guard = state.config_mutations.lock(ticket).await?;
    let snapshot = with_store(&state, |store| {
        store.settings_ai_api_update(crate::vault::AiApiSettingsUpdate {
            port: Some(effective_port),
        })
    })?;
    sync_api_server_authorization_cache(&state, &snapshot).await;
    drop(mutation_guard);
    events::emit(&app, events::CONFIG_CHANGED, snapshot.clone());
    match start_api_server_inner(app.clone(), &state, effective_port).await {
        Ok(info) => {
            // Starting the server may generate and persist the API key, which
            // advances the config revision beyond the settings snapshot above.
            // Always return the latest committed snapshot to the caller.
            let snapshot = with_store(&state, |store| store.snapshot())?;
            Ok(ApiServerConfigureResult { info, snapshot })
        }
        Err(error) => {
            stop_api_server_after_reconcile_failure(&app, &state).await;
            Err(error)
        }
    }
}

async fn start_api_server_inner(
    app: AppHandle,
    state: &State<'_, AppState>,
    port: u16,
) -> AppResult<ApiServerInfo> {
    if state.is_shutting_down() {
        return Err(AppError::InvalidInput("应用正在退出".to_string()));
    }
    ensure_vault_unlocked(state)?;
    let (allowed_session_ids, allowed_session_names) = with_store(state, |store| {
        Ok(configured_api_sessions(&store.snapshot()?))
    })?;
    let mut handle_guard = state.api_server.lock().await;
    if handle_guard
        .as_ref()
        .map(|handle| handle.is_finished())
        .unwrap_or(false)
    {
        if let Some(handle) = handle_guard.take() {
            drop(handle_guard);
            handle.shutdown().await;
            handle_guard = state.api_server.lock().await;
        }
    }
    if let Some(existing) = handle_guard.as_ref() {
        existing
            .update_allowed_sessions(allowed_session_ids, allowed_session_names)
            .await;
        let info = ApiServerInfo {
            running: true,
            port: existing.port,
            api_key: existing.api_key.clone(),
            ..Default::default()
        };
        emit_api_status(&app, &info);
        return Ok(info);
    }
    let (existing_key, needs_key) = with_store(state, |store| {
        let key = store
            .snapshot()?
            .data
            .settings
            .ai_api_key
            .filter(|key| !key.is_empty());
        Ok((key.clone(), key.is_none()))
    })?;
    let (api_key, generated_snapshot) = if needs_key {
        let ticket = state.config_mutations.ticket();
        let mutation_guard = state.config_mutations.lock(ticket).await?;
        let result = with_store(state, |store| {
            let snapshot = store.snapshot()?;
            if let Some(key) = snapshot
                .data
                .settings
                .ai_api_key
                .filter(|key| !key.is_empty())
            {
                return Ok((key, None));
            }
            let new_key = generate_api_key();
            let snapshot = store.settings_ai_api_key_update(Some(new_key.clone()))?;
            Ok((new_key, Some(snapshot)))
        })?;
        drop(mutation_guard);
        result
    } else {
        (existing_key.unwrap_or_default(), None)
    };
    if let Some(snapshot) = generated_snapshot {
        events::emit(&app, events::CONFIG_CHANGED, snapshot);
    }
    let log_file = state.data_dir.join("api_logs.json");
    let server_handle = api_server::start_server(api_server::ApiServerStartOptions {
        app: app.clone(),
        remote: state.remote.clone(),
        vault: state.vault.clone(),
        port,
        api_key: api_key.clone(),
        allowed_session_ids: allowed_session_ids.clone(),
        allowed_session_names,
        log_file,
        backup_operation: state.backup_operation.clone(),
        tunnel_operation: state.tunnel_operation.clone(),
        connection_config_gate: state.connection_config_gate.clone(),
        config_mutations: state.config_mutations.clone(),
    })
    .await?;
    let info = ApiServerInfo {
        running: true,
        port: server_handle.port,
        api_key: server_handle.api_key.clone(),
        ..Default::default()
    };
    *handle_guard = Some(server_handle);
    emit_api_status(&app, &info);
    Ok(info)
}

/// 在 Rust 主进程启动后默认启动 AI API，不依赖前端操作或 WebView 初始化时序。
/// 未配置端口时使用默认端口，已有配置继续沿用。
pub fn spawn_api_server_autostart(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        if let Err(error) = state.initialize_vault().await {
            log::error!("Vault initialization failed: {error}");
            return;
        }
        let result = retry_api_start(
            || async {
                let _operation_guard = state.api_server_operation.lock().await;
                if state.is_shutting_down() || state.api_startup.is_cancelled() {
                    return Ok(None);
                }
                if state.needs_migration() {
                    return Ok(None);
                }
                // Every attempt uses current settings, not a snapshot captured
                // before waiting for the outgoing process to release its port.
                let snapshot = with_store(&state, |store| store.snapshot())?;
                let port = snapshot.data.settings.ai_api_listen_port();
                if state.api_startup.waiting(port) {
                    emit_api_status(&app, &stopped_api_server_info());
                }
                start_api_server_inner(app.clone(), &state, port)
                    .await
                    .map(Some)
            },
            state.api_startup.cancellation(),
            state.shutdown_receiver(),
            API_STARTUP_NORMAL_WAIT,
            API_STARTUP_MAX_WAIT,
        )
        .await;
        let _operation_guard = state.api_server_operation.lock().await;
        if state.is_shutting_down() || state.api_startup.is_cancelled() {
            return;
        }
        match result {
            Ok(Some(_)) => state.api_startup.finish(None),
            Ok(None) => {
                state.api_startup.finish(None);
                emit_api_status(&app, &stopped_api_server_info());
            }
            Err(error) => {
                log::warn!("AI API autostart failed: {error}");
                state.api_startup.finish(Some(error.to_string()));
                emit_api_status(&app, &stopped_api_server_info());
            }
        }
    });
}

#[tauri::command]
pub async fn api_server_stop(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    state.api_startup.cancel();
    if let Some(handle) = state.api_server.lock().await.as_ref() {
        handle.request_shutdown();
    }
    let _operation_guard = state.api_server_operation.lock().await;
    let handle = {
        let mut handle_guard = state.api_server.lock().await;
        handle_guard.take()
    };
    if let Some(handle) = handle {
        handle.shutdown().await;
    }
    emit_api_status(&app, &stopped_api_server_info());
    Ok(())
}

#[tauri::command]
pub async fn api_server_status(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<ApiServerInfo> {
    let _operation_guard = state.api_server_operation.lock().await;
    let mut handle_guard = state.api_server.lock().await;
    if handle_guard
        .as_ref()
        .map(|handle| handle.is_finished())
        .unwrap_or(false)
    {
        if let Some(handle) = handle_guard.take() {
            drop(handle_guard);
            handle.shutdown().await;
            let info = stopped_api_server_info();
            emit_api_status(&app, &info);
            return Ok(info);
        }
    }
    let info = match handle_guard.as_ref() {
        Some(handle) => ApiServerInfo {
            running: true,
            port: handle.port,
            api_key: handle.api_key.clone(),
            ..Default::default()
        },
        None => stopped_api_server_info(),
    };
    Ok(state.api_startup.decorate(info))
}

#[tauri::command]
pub async fn api_server_regenerate_key(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<ApiServerInfo> {
    state.api_startup.cancel();
    let ticket = state.config_mutations.ticket();
    let _operation_guard = state.api_server_operation.lock().await;
    ensure_vault_unlocked(&state)?;
    let new_key = generate_api_key();
    let mutation_guard = state.config_mutations.lock(ticket).await?;
    let snapshot = with_store(&state, |store| {
        store.settings_ai_api_key_update(Some(new_key.clone()))
    })?;
    drop(mutation_guard);
    events::emit(&app, events::CONFIG_CHANGED, snapshot);
    let handle = {
        let mut handle_guard = state.api_server.lock().await;
        handle_guard.take()
    };
    if let Some(handle) = handle {
        let port = handle.port;
        let allowed = handle.allowed_session_ids_snapshot();
        let allowed_names = handle.allowed_session_names_snapshot();
        let log_file = handle.log_file.clone();
        handle.shutdown().await;
        let server_handle = api_server::start_server(api_server::ApiServerStartOptions {
            app: app.clone(),
            remote: state.remote.clone(),
            vault: state.vault.clone(),
            port,
            api_key: new_key.clone(),
            allowed_session_ids: allowed,
            allowed_session_names: allowed_names,
            log_file,
            backup_operation: state.backup_operation.clone(),
            tunnel_operation: state.tunnel_operation.clone(),
            connection_config_gate: state.connection_config_gate.clone(),
            config_mutations: state.config_mutations.clone(),
        })
        .await;
        let server_handle = match server_handle {
            Ok(handle) => handle,
            Err(error) => {
                let info = stopped_api_server_info();
                emit_api_status(&app, &info);
                return Err(error);
            }
        };
        let info = ApiServerInfo {
            running: true,
            port: server_handle.port,
            api_key: server_handle.api_key.clone(),
            ..Default::default()
        };
        let mut handle_guard = state.api_server.lock().await;
        *handle_guard = Some(server_handle);
        emit_api_status(&app, &info);
        Ok(info)
    } else {
        let info = ApiServerInfo {
            running: false,
            port: 0,
            api_key: new_key,
            ..Default::default()
        };
        emit_api_status(&app, &info);
        Ok(info)
    }
}

#[tauri::command]
pub async fn api_server_logs(state: State<'_, AppState>) -> AppResult<Vec<ApiLogEntry>> {
    let handle_guard = state.api_server.lock().await;
    match handle_guard.as_ref() {
        Some(handle) => {
            let logs = handle.logs.read().await;
            Ok(logs.clone())
        }
        None => {
            let log_file = state.data_dir.join("api_logs.json");
            Ok(crate::api_server::load_logs_from_file(&log_file).await)
        }
    }
}

fn generate_api_key() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let bytes: [u8; 32] = rng.gen();
    format!("helm_{}", hex::encode(bytes))
}

// Every saved host is available through the authenticated API. Keep this cache
// synchronized on create/update/delete; it is not a user-managed allowlist.
fn configured_api_sessions(snapshot: &ConfigSnapshot) -> (Vec<String>, Vec<(String, String)>) {
    let ids = snapshot
        .data
        .sessions
        .iter()
        .map(|session| session.id.clone())
        .collect();
    let names = snapshot
        .data
        .sessions
        .iter()
        .map(|session| {
            (
                session.id.clone(),
                format!("{} ({})", session.name, session.host),
            )
        })
        .collect();
    (ids, names)
}

pub(super) async fn sync_api_server_authorization_cache(
    state: &State<'_, AppState>,
    snapshot: &ConfigSnapshot,
) {
    let (allowed_session_ids, allowed_session_names) = configured_api_sessions(snapshot);
    let handle_guard = state.api_server.lock().await;
    if let Some(handle) = handle_guard.as_ref() {
        handle.replace_allowed_sessions_cache(allowed_session_ids, allowed_session_names);
    }
}

pub(super) async fn reconcile_api_server_with_snapshot(
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> ApiServerInfo {
    let _operation_guard = state.api_server_operation.lock().await;
    // The caller's snapshot can become stale while waiting for the API lifecycle
    // lock. Always reconcile from the latest committed vault state so an older
    // command cannot overwrite a newer authorization update.
    let latest_snapshot = match with_store(state, |store| store.snapshot()) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            log::error!("failed to read latest config while reconciling AI API: {error}");
            return stop_api_server_after_reconcile_failure(app, state).await;
        }
    };
    let info = match reconcile_api_server_with_snapshot_inner(state, &latest_snapshot).await {
        Ok(info) => info,
        Err(error) => {
            log::error!("failed to reconcile AI API authorization: {error}");
            return stop_api_server_after_reconcile_failure(app, state).await;
        }
    };
    emit_api_status(app, &info);
    info
}

async fn stop_api_server_after_reconcile_failure(
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> ApiServerInfo {
    let handle = state.api_server.lock().await.take();
    if let Some(handle) = handle {
        handle.shutdown().await;
    }
    let info = stopped_api_server_info();
    emit_api_status(app, &info);
    info
}

async fn reconcile_api_server_with_snapshot_inner(
    state: &State<'_, AppState>,
    snapshot: &ConfigSnapshot,
) -> AppResult<ApiServerInfo> {
    let (allowed_session_ids, allowed_session_names) = configured_api_sessions(snapshot);
    let mut handle_guard = state.api_server.lock().await;
    if handle_guard
        .as_ref()
        .map(|handle| handle.is_finished())
        .unwrap_or(false)
    {
        if let Some(handle) = handle_guard.take() {
            drop(handle_guard);
            handle.shutdown().await;
            handle_guard = state.api_server.lock().await;
        }
    }
    match handle_guard.as_ref() {
        Some(handle) => {
            handle
                .update_allowed_sessions(allowed_session_ids, allowed_session_names)
                .await;
            Ok(ApiServerInfo {
                running: true,
                port: handle.port,
                api_key: handle.api_key.clone(),
                ..Default::default()
            })
        }
        None => Ok(ApiServerInfo {
            running: false,
            port: snapshot.data.settings.ai_api_port.unwrap_or(0),
            api_key: snapshot
                .data
                .settings
                .ai_api_key
                .clone()
                .unwrap_or_default(),
            ..Default::default()
        }),
    }
}

pub(super) async fn stop_api_server_for_config_replacement<'a>(
    app: &AppHandle,
    state: &'a State<'_, AppState>,
) -> (tokio::sync::MutexGuard<'a, ()>, bool) {
    state.api_startup.cancel();
    let operation_guard = state.api_server_operation.lock().await;
    let handle = state.api_server.lock().await.take();
    let was_running = handle.as_ref().is_some_and(|handle| !handle.is_finished());
    if let Some(handle) = handle {
        handle.shutdown().await;
    }
    emit_api_status(app, &stopped_api_server_info());
    (operation_guard, was_running)
}

pub(super) async fn restore_api_server_after_config_replacement(
    app: &AppHandle,
    state: &State<'_, AppState>,
    was_running: bool,
) {
    if !was_running {
        return;
    }
    let settings = match with_store(state, |store| Ok(store.snapshot()?.data.settings)) {
        Ok(settings) => settings,
        Err(error) => {
            log::warn!("AI API restore skipped after config replacement: {error}");
            return;
        }
    };
    let port = settings.ai_api_listen_port();
    let _operation_guard = state.api_server_operation.lock().await;
    if let Err(error) = start_api_server_inner(app.clone(), state, port).await {
        log::warn!("AI API restore failed after config replacement: {error}");
    }
}

fn stopped_api_server_info() -> ApiServerInfo {
    ApiServerInfo::default()
}

fn emit_api_status(app: &AppHandle, info: &ApiServerInfo) {
    if app
        .state::<AppState>()
        .frontend_ready
        .load(std::sync::atomic::Ordering::Acquire)
    {
        let info = app.state::<AppState>().api_startup.decorate(info.clone());
        events::emit(app, events::API_STATUS, info);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session_input(name: &str, host: &str) -> crate::config::SessionInput {
        crate::config::SessionInput {
            name: name.to_string(),
            group_id: None,
            host: host.to_string(),
            port: 22,
            username: "root".to_string(),
            auth: crate::config::AuthConfig::password(Some("secret".to_string())),
            ssh: crate::config::SshOptions::default(),
            default_path: "/".to_string(),
            tags: Vec::new(),
            note: None,
            terminal: crate::config::TerminalOptions::default(),
            sftp: crate::config::SftpOptions::default(),
        }
    }

    #[test]
    fn all_saved_hosts_are_available_without_a_binding_or_count_limit() {
        let mut data = crate::config::VaultData::empty();
        for index in 0..25 {
            let mut session = crate::config::SessionConfig::new(session_input("节点", "10.0.0.1"));
            session.id = format!("session-{index}");
            data.sessions.push(session);
        }
        let mut snapshot = ConfigSnapshot { revision: 7, data };
        let (ids, names) = configured_api_sessions(&snapshot);
        assert_eq!(ids.len(), 25);
        assert_eq!(names.len(), 25);
        assert_eq!(ids.last().map(String::as_str), Some("session-24"));

        snapshot.data.sessions[0].name = "已重命名".to_string();
        snapshot.data.sessions.remove(24);
        let (ids, names) = configured_api_sessions(&snapshot);
        assert_eq!(ids.len(), 24);
        assert!(!ids.contains(&"session-24".to_string()));
        assert_eq!(names[0].1, "已重命名 (10.0.0.1)");
        snapshot.data.sessions.clear();
        assert_eq!(configured_api_sessions(&snapshot), (Vec::new(), Vec::new()));
    }
}
