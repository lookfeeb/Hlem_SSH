use tauri::{AppHandle, State};

use super::{connect_session, ensure_vault_unlocked, with_store, AppResult, AppState};
use crate::config::{ConfigSnapshot, GroupInput, SessionInput};
use crate::remote::ConnectionInfo;

#[tauri::command]
pub fn group_create(state: State<'_, AppState>, input: GroupInput) -> AppResult<ConfigSnapshot> {
    with_store(&state, |store| store.create_group(input))
}

#[tauri::command]
pub fn group_update(
    state: State<'_, AppState>,
    group_id: String,
    input: GroupInput,
) -> AppResult<ConfigSnapshot> {
    with_store(&state, |store| store.update_group(&group_id, input))
}

#[tauri::command]
pub fn group_delete(state: State<'_, AppState>, group_id: String) -> AppResult<ConfigSnapshot> {
    with_store(&state, |store| store.delete_group(&group_id))
}

#[tauri::command]
pub fn session_create(
    state: State<'_, AppState>,
    input: SessionInput,
) -> AppResult<ConfigSnapshot> {
    with_store(&state, |store| store.create_session(input))
}

#[tauri::command]
pub fn session_update(
    state: State<'_, AppState>,
    session_id: String,
    input: SessionInput,
) -> AppResult<ConfigSnapshot> {
    with_store(&state, |store| store.update_session(&session_id, input))
}

#[tauri::command]
pub fn session_favorite_update(
    state: State<'_, AppState>,
    session_id: String,
    favorite: bool,
) -> AppResult<ConfigSnapshot> {
    with_store(&state, |store| {
        store.set_session_favorite(&session_id, favorite)
    })
}

#[tauri::command]
pub fn session_mark_recent(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<ConfigSnapshot> {
    with_store(&state, |store| store.mark_session_recent(&session_id))
}

#[tauri::command]
pub fn session_delete(state: State<'_, AppState>, session_id: String) -> AppResult<ConfigSnapshot> {
    with_store(&state, |store| store.delete_session(&session_id))
}

#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<ConnectionInfo> {
    connect_session(&app, &state, &session_id).await
}

#[tauri::command]
pub async fn ssh_disconnect(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<()> {
    ensure_vault_unlocked(&state)?;
    state.remote.disconnect(&app, &connection_id).await
}

#[tauri::command]
pub fn ssh_trust_host_key(
    state: State<'_, AppState>,
    session_id: String,
    algorithm: String,
    fingerprint: String,
) -> AppResult<ConfigSnapshot> {
    with_store(&state, |store| {
        store.trust_host_key(&session_id, algorithm, fingerprint)
    })
}
