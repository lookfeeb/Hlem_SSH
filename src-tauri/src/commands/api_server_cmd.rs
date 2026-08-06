use tauri::{AppHandle, Manager, State};

use crate::api_server::{self, ApiLogEntry, ApiServerInfo};
use crate::errors::{AppError, AppResult};

use super::{ensure_vault_unlocked, with_store, AppState};

const MAX_ALLOWED_API_SESSIONS: usize = 20;

#[tauri::command]
pub async fn api_server_start(
    app: AppHandle,
    state: State<'_, AppState>,
    port: u16,
    allowed_session_id: Option<String>,
    allowed_session_ids: Option<Vec<String>>,
) -> AppResult<ApiServerInfo> {
    start_api_server_inner(app, &state, port, allowed_session_id, allowed_session_ids).await
}

async fn start_api_server_inner(
    app: AppHandle,
    state: &State<'_, AppState>,
    port: u16,
    allowed_session_id: Option<String>,
    allowed_session_ids: Option<Vec<String>>,
) -> AppResult<ApiServerInfo> {
    ensure_vault_unlocked(state)?;
    let allowed_session_ids =
        normalize_allowed_session_ids(allowed_session_ids, allowed_session_id);
    if allowed_session_ids.is_empty() {
        return Err(AppError::InvalidInput(
            "AI API 至少需要一个授权会话".to_string(),
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
        return Ok(ApiServerInfo {
            running: true,
            port: existing.port,
            api_key: existing.api_key.clone(),
        });
    }
    let api_key = with_store(state, |store| {
        let snapshot = store.snapshot()?;
        if let Some(key) = snapshot.data.settings.ai_api_key.as_ref() {
            if !key.is_empty() {
                return Ok(key.clone());
            }
        }
        let new_key = generate_api_key();
        let mut settings = snapshot.data.settings.clone();
        settings.ai_api_key = Some(new_key.clone());
        store.settings_update(settings)?;
        Ok(new_key)
    })?;
    let allowed_session_names = allowed_session_names_for_ids(state, &allowed_session_ids)?;
    let log_file = state.data_dir.join("api_logs.json");
    let server_handle = api_server::start_server(api_server::ApiServerStartOptions {
        app,
        remote: state.remote.clone(),
        vault: state.vault.clone(),
        port,
        api_key: api_key.clone(),
        allowed_session_ids: allowed_session_ids.clone(),
        allowed_session_names,
        log_file,
    })
    .await
    .map_err(AppError::Remote)?;
    let info = ApiServerInfo {
        running: true,
        port: server_handle.port,
        api_key: server_handle.api_key.clone(),
    };
    *handle_guard = Some(server_handle);
    Ok(info)
}

/// 在 Rust 主进程启动后直接恢复 AI API，不依赖 WebView 初始化时序。
/// 前端仍会查询运行状态，但即使页面加载失败，IDE/AI 也能使用已配置的 API。
pub fn spawn_api_server_autostart(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
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
        if let Err(error) =
            start_api_server_inner(app.clone(), &state, port, None, Some(allowed_session_ids)).await
        {
            log::warn!("AI API autostart failed: {error}");
        }
    });
}

#[tauri::command]
pub async fn api_server_stop(state: State<'_, AppState>) -> AppResult<()> {
    let handle = {
        let mut handle_guard = state.api_server.lock().await;
        handle_guard.take()
    };
    if let Some(handle) = handle {
        handle.shutdown().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn api_server_update_sessions(
    state: State<'_, AppState>,
    allowed_session_id: Option<String>,
    allowed_session_ids: Option<Vec<String>>,
) -> AppResult<ApiServerInfo> {
    ensure_vault_unlocked(&state)?;
    let allowed_session_ids =
        normalize_allowed_session_ids(allowed_session_ids, allowed_session_id);
    if allowed_session_ids.is_empty() {
        let handle = {
            let mut handle_guard = state.api_server.lock().await;
            handle_guard.take()
        };
        if let Some(handle) = handle {
            handle.shutdown().await;
        }
        return Ok(ApiServerInfo {
            running: false,
            port: 0,
            api_key: String::new(),
        });
    }
    let allowed_session_names = allowed_session_names_for_ids(&state, &allowed_session_ids)?;
    let mut handle_guard = state.api_server.lock().await;
    if handle_guard
        .as_ref()
        .map(|handle| handle.is_finished())
        .unwrap_or(false)
    {
        if let Some(handle) = handle_guard.take() {
            drop(handle_guard);
            handle.shutdown().await;
            return Ok(ApiServerInfo {
                running: false,
                port: 0,
                api_key: String::new(),
            });
        }
    }
    match handle_guard.as_ref() {
        Some(handle) => {
            handle
                .update_allowed_sessions(allowed_session_ids, allowed_session_names)
                .map_err(AppError::Remote)?;
            Ok(ApiServerInfo {
                running: true,
                port: handle.port,
                api_key: handle.api_key.clone(),
            })
        }
        None => Ok(ApiServerInfo {
            running: false,
            port: 0,
            api_key: String::new(),
        }),
    }
}

#[tauri::command]
pub async fn api_server_status(state: State<'_, AppState>) -> AppResult<ApiServerInfo> {
    let mut handle_guard = state.api_server.lock().await;
    if handle_guard
        .as_ref()
        .map(|handle| handle.is_finished())
        .unwrap_or(false)
    {
        if let Some(handle) = handle_guard.take() {
            drop(handle_guard);
            handle.shutdown().await;
            return Ok(ApiServerInfo {
                running: false,
                port: 0,
                api_key: String::new(),
            });
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
    ensure_vault_unlocked(&state)?;
    let new_key = generate_api_key();
    with_store(&state, |store| {
        let snapshot = store.snapshot()?;
        let mut settings = snapshot.data.settings.clone();
        settings.ai_api_key = Some(new_key.clone());
        store.settings_update(settings)?;
        Ok(())
    })?;
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
            app,
            remote: state.remote.clone(),
            vault: state.vault.clone(),
            port,
            api_key: new_key.clone(),
            allowed_session_ids: allowed,
            allowed_session_names: allowed_names,
            log_file,
        })
        .await
        .map_err(AppError::Remote)?;
        let info = ApiServerInfo {
            running: true,
            port: server_handle.port,
            api_key: server_handle.api_key.clone(),
        };
        let mut handle_guard = state.api_server.lock().await;
        *handle_guard = Some(server_handle);
        Ok(info)
    } else {
        Ok(ApiServerInfo {
            running: false,
            port: 0,
            api_key: new_key,
        })
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
            match tokio::fs::read_to_string(&log_file).await {
                Ok(content) => Ok(serde_json::from_str(&content).unwrap_or_default()),
                Err(_) => Ok(Vec::new()),
            }
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
