use tauri::{AppHandle, State};

use super::{connect_session, ensure_vault_unlocked, AppResult, AppState};
use crate::remote::{ExecResult, TerminalInfo};

#[tauri::command]
pub async fn terminal_open(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    cols: u16,
    rows: u16,
) -> AppResult<TerminalInfo> {
    ensure_vault_unlocked(&state)?;
    state
        .remote
        .open_terminal(&app, &connection_id, cols, rows)
        .await
}

#[tauri::command]
pub async fn terminal_write(
    state: State<'_, AppState>,
    terminal_id: String,
    data: String,
) -> AppResult<()> {
    ensure_vault_unlocked(&state)?;
    state.remote.terminal_write(&terminal_id, data).await
}

#[tauri::command]
pub async fn terminal_resize(
    state: State<'_, AppState>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> AppResult<()> {
    ensure_vault_unlocked(&state)?;
    state.remote.terminal_resize(&terminal_id, cols, rows).await
}

#[tauri::command]
pub async fn terminal_close(
    app: AppHandle,
    state: State<'_, AppState>,
    terminal_id: String,
) -> AppResult<()> {
    ensure_vault_unlocked(&state)?;
    state.remote.terminal_close(&app, &terminal_id).await
}

#[tauri::command]
pub async fn ssh_exec(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    command: String,
    timeout_ms: Option<u64>,
) -> AppResult<ExecResult> {
    let connection = connect_session(&app, &state, &session_id).await?;
    state
        .remote
        .exec_on_connection(&connection.connection_id, command, timeout_ms)
        .await
}

#[tauri::command]
pub async fn ssh_exec_on_connection(
    state: State<'_, AppState>,
    connection_id: String,
    command: String,
    timeout_ms: Option<u64>,
) -> AppResult<ExecResult> {
    ensure_vault_unlocked(&state)?;
    state
        .remote
        .exec_on_connection(&connection_id, command, timeout_ms)
        .await
}
