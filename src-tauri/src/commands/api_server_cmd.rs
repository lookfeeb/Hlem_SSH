use tauri::{AppHandle, Manager, State};

use crate::api_server::{self, ApiLogEntry, ApiServerInfo};
use crate::config::ConfigSnapshot;
use crate::errors::{AppError, AppResult};
use crate::events;

use super::{ensure_vault_unlocked, with_store, AppState};

const MAX_ALLOWED_API_SESSIONS: usize = 20;

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
    allowed_session_ids: Vec<String>,
    auto_start: bool,
) -> AppResult<ApiServerConfigureResult> {
    let ticket = state.config_mutations.ticket();
    let _operation_guard = state.api_server_operation.lock().await;
    ensure_vault_unlocked(&state)?;
    let allowed_session_ids = normalize_allowed_session_ids(Some(allowed_session_ids), None);
    if allowed_session_ids.is_empty() {
        return Err(AppError::InvalidInput(
            "AI API 至少需要一个授权会话".to_string(),
        ));
    }
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
            session_ids: allowed_session_ids.clone(),
            port: Some(effective_port),
            auto_start,
        })
    })?;
    drop(mutation_guard);
    events::emit(&app, events::CONFIG_CHANGED, snapshot.clone());
    match start_api_server_inner(app.clone(), &state, effective_port, allowed_session_ids).await {
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
    allowed_session_ids: Vec<String>,
) -> AppResult<ApiServerInfo> {
    if state.is_shutting_down() {
        return Err(AppError::InvalidInput("应用正在退出".to_string()));
    }
    ensure_vault_unlocked(state)?;
    if allowed_session_ids.is_empty() {
        return Err(AppError::InvalidInput(
            "AI API 至少需要一个授权会话".to_string(),
        ));
    }
    let allowed_session_names = allowed_session_names_for_ids(state, &allowed_session_ids)?;
    if allowed_session_names.len() != allowed_session_ids.len() {
        return Err(AppError::InvalidInput(
            "AI API 授权会话包含不存在的配置".to_string(),
        ));
    }
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
            .await
            .map_err(AppError::Remote)?;
        let info = ApiServerInfo {
            running: true,
            port: existing.port,
            api_key: existing.api_key.clone(),
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
    .await
    .map_err(AppError::Remote)?;
    let info = ApiServerInfo {
        running: true,
        port: server_handle.port,
        api_key: server_handle.api_key.clone(),
    };
    *handle_guard = Some(server_handle);
    emit_api_status(&app, &info);
    Ok(info)
}

/// 在 Rust 主进程启动后直接恢复 AI API，不依赖 WebView 初始化时序。
/// 前端仍会查询运行状态，但即使页面加载失败，IDE/AI 也能使用已配置的 API。
pub fn spawn_api_server_autostart(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        if state.is_shutting_down() {
            return;
        }
        let settings = match with_store(&state, |store| Ok(store.snapshot()?.data.settings)) {
            Ok(settings) => settings,
            Err(error) => {
                log::debug!("AI API autostart skipped: {error}");
                return;
            }
        };
        let Some(port) = settings.ai_api_port else {
            return;
        };
        let allowed_session_ids = normalize_allowed_session_ids(
            Some(settings.ai_api_session_ids),
            settings.ai_api_session_id,
        );
        if !settings.ai_api_auto_start || allowed_session_ids.is_empty() {
            return;
        }
        let _operation_guard = state.api_server_operation.lock().await;
        if state.is_shutting_down() {
            return;
        }
        if let Err(error) =
            start_api_server_inner(app.clone(), &state, port, allowed_session_ids).await
        {
            log::warn!("AI API autostart failed: {error}");
        }
    });
}

#[tauri::command]
pub async fn api_server_stop(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
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
    match handle_guard.as_ref() {
        Some(handle) => Ok(ApiServerInfo {
            running: true,
            port: handle.port,
            api_key: handle.api_key.clone(),
        }),
        None => Ok(ApiServerInfo {
            running: false,
            port: 0,
            api_key: String::new(),
        }),
    }
}

#[tauri::command]
pub async fn api_server_regenerate_key(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<ApiServerInfo> {
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
                return Err(AppError::Remote(error));
            }
        };
        let info = ApiServerInfo {
            running: true,
            port: server_handle.port,
            api_key: server_handle.api_key.clone(),
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

fn normalize_allowed_session_ids(
    allowed_session_ids: Option<Vec<String>>,
    allowed_session_id: Option<String>,
) -> Vec<String> {
    let mut ids = Vec::new();
    for id in allowed_session_ids
        .unwrap_or_default()
        .into_iter()
        .chain(allowed_session_id)
    {
        let value = id.trim().to_string();
        if value.is_empty() || ids.contains(&value) {
            continue;
        }
        ids.push(value);
        if ids.len() >= MAX_ALLOWED_API_SESSIONS {
            break;
        }
    }
    ids
}

fn allowed_session_names_for_ids(
    state: &State<'_, AppState>,
    allowed_session_ids: &[String],
) -> AppResult<Vec<(String, String)>> {
    with_store(state, |store| {
        let snapshot = store.snapshot()?;
        let names = allowed_session_ids
            .iter()
            .filter_map(|sid| {
                snapshot
                    .data
                    .sessions
                    .iter()
                    .find(|s| s.id == *sid)
                    .map(|s| (sid.clone(), format!("{} ({})", s.name, s.host)))
            })
            .collect::<Vec<_>>();
        Ok(names)
    })
}

fn configured_allowed_sessions(snapshot: &ConfigSnapshot) -> (Vec<String>, Vec<(String, String)>) {
    let existing_sessions = snapshot
        .data
        .sessions
        .iter()
        .map(|session| (session.id.as_str(), session))
        .collect::<std::collections::HashMap<_, _>>();
    let mut ids = Vec::new();
    let mut names = Vec::new();
    for id in normalize_allowed_session_ids(
        Some(snapshot.data.settings.ai_api_session_ids.clone()),
        snapshot.data.settings.ai_api_session_id.clone(),
    ) {
        let Some(session) = existing_sessions.get(id.as_str()) else {
            continue;
        };
        names.push((id.clone(), format!("{} ({})", session.name, session.host)));
        ids.push(id);
    }
    (ids, names)
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
    let (allowed_session_ids, allowed_session_names) = configured_allowed_sessions(snapshot);
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
    if allowed_session_ids.is_empty() {
        let handle = handle_guard.take();
        drop(handle_guard);
        if let Some(handle) = handle {
            handle.shutdown().await;
        }
        return Ok(ApiServerInfo {
            running: false,
            port: 0,
            api_key: String::new(),
        });
    }
    match handle_guard.as_ref() {
        Some(handle) => {
            handle
                .update_allowed_sessions(allowed_session_ids, allowed_session_names)
                .await
                .map_err(AppError::Remote)?;
            Ok(ApiServerInfo {
                running: true,
                port: handle.port,
                api_key: handle.api_key.clone(),
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
        }),
    }
}

pub(super) async fn stop_api_server_for_config_replacement<'a>(
    app: &AppHandle,
    state: &'a State<'_, AppState>,
) -> (tokio::sync::MutexGuard<'a, ()>, bool) {
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
    let Some(port) = settings.ai_api_port else {
        return;
    };
    let allowed_session_ids = normalize_allowed_session_ids(
        Some(settings.ai_api_session_ids),
        settings.ai_api_session_id,
    );
    if allowed_session_ids.is_empty() {
        return;
    }
    let _operation_guard = state.api_server_operation.lock().await;
    if let Err(error) = start_api_server_inner(app.clone(), state, port, allowed_session_ids).await
    {
        log::warn!("AI API restore failed after config replacement: {error}");
    }
}

fn stopped_api_server_info() -> ApiServerInfo {
    ApiServerInfo {
        running: false,
        port: 0,
        api_key: String::new(),
    }
}

fn emit_api_status(app: &AppHandle, info: &ApiServerInfo) {
    if app
        .state::<AppState>()
        .frontend_ready
        .load(std::sync::atomic::Ordering::Acquire)
    {
        events::emit(app, events::API_STATUS, info.clone());
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
    fn allowed_api_sessions_are_trimmed_deduplicated_and_limited_to_twenty() {
        let mut input = (0..25)
            .map(|index| format!(" session-{index} "))
            .collect::<Vec<_>>();
        input.insert(1, "session-0".to_string());
        input.insert(2, String::new());

        let result = normalize_allowed_session_ids(Some(input), Some("session-3".to_string()));

        assert_eq!(result.len(), 20);
        assert_eq!(result.first().map(String::as_str), Some("session-0"));
        assert_eq!(result.last().map(String::as_str), Some("session-19"));
        assert_eq!(
            result
                .iter()
                .filter(|id| id.as_str() == "session-3")
                .count(),
            1
        );
    }

    #[test]
    fn configured_api_sessions_drop_missing_ids_and_refresh_names() {
        let mut data = crate::config::VaultData::empty();
        let mut session = crate::config::SessionConfig::new(session_input("节点 A", "10.0.0.1"));
        session.id = "session-a".to_string();
        data.sessions.push(session);
        data.settings.ai_api_session_id = Some("missing".to_string());
        data.settings.ai_api_session_ids = vec!["session-a".to_string(), "missing".to_string()];
        let snapshot = ConfigSnapshot { revision: 7, data };

        let (ids, names) = configured_allowed_sessions(&snapshot);
        assert_eq!(ids, vec!["session-a"]);
        assert_eq!(
            names,
            vec![("session-a".to_string(), "节点 A (10.0.0.1)".to_string())]
        );
    }
}
