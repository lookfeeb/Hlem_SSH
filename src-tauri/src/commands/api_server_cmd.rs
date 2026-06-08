use tauri::{AppHandle, State};

use crate::api_server::{self, ApiLogEntry, ApiServerInfo};
use crate::errors::{AppError, AppResult};

use super::{ensure_vault_unlocked, with_store, AppState};

#[tauri::command]
pub async fn api_server_start(
    app: AppHandle,
    state: State<'_, AppState>,
    port: u16,
    allowed_session_id: Option<String>,
    allowed_session_ids: Option<Vec<String>>,
) -> AppResult<ApiServerInfo> {
    ensure_vault_unlocked(&state)?;
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
    let api_key = with_store(&state, |store| {
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
    let allowed_session_ids = normalize_allowed_session_ids(allowed_session_ids, allowed_session_id);
    let allowed_session_names = allowed_session_names_for_ids(&state, &allowed_session_ids)?;
    let log_file = state.data_dir.join("api_logs.json");
    let server_handle = api_server::start_server(
        app,
        state.remote.clone(),
        state.vault.clone(),
        port,
        api_key.clone(),
        allowed_session_ids.clone(),
        allowed_session_names,
        log_file,
    )
    .await
    .map_err(|e| AppError::Remote(e))?;
    let info = ApiServerInfo {
        running: true,
        port: server_handle.port,
        api_key: server_handle.api_key.clone(),
    };
    *handle_guard = Some(server_handle);
    Ok(info)
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
    let allowed_session_ids = normalize_allowed_session_ids(allowed_session_ids, allowed_session_id);
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
        let server_handle = api_server::start_server(
            app,
            state.remote.clone(),
            state.vault.clone(),
            port,
            new_key.clone(),
            allowed,
            allowed_names,
            log_file,
        )
        .await
        .map_err(|e| AppError::Remote(e))?;
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
            match std::fs::read_to_string(&log_file) {
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
        if ids.len() >= 3 {
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
