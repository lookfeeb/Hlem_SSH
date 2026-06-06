use tauri::{AppHandle, State};

use super::{connect_session, ensure_vault_unlocked, AppResult, AppState};
use crate::remote::{ForwardInfo, ServerTelemetry, TelemetryJobInfo};

#[tauri::command]
pub async fn telemetry_start(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    session_id: String,
    interval_ms: u64,
) -> AppResult<TelemetryJobInfo> {
    ensure_vault_unlocked(&state)?;
    state
        .remote
        .telemetry_start(&app, connection_id, session_id, interval_ms)
        .await
}

#[tauri::command]
pub async fn telemetry_stop(state: State<'_, AppState>, job_id: String) -> AppResult<()> {
    ensure_vault_unlocked(&state)?;
    state.remote.telemetry_stop(&job_id).await
}

#[tauri::command]
pub async fn telemetry_snapshot(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<ServerTelemetry> {
    ensure_vault_unlocked(&state)?;
    state.remote.telemetry_snapshot(&connection_id).await
}

#[tauri::command]
pub async fn forward_start_local(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    bind_host: String,
    bind_port: u16,
    remote_host: String,
    remote_port: u16,
) -> AppResult<ForwardInfo> {
    let connection = connect_session(&app, &state, &session_id).await?;
    state
        .remote
        .forward_start_local(
            &app,
            session_id,
            connection.connection_id,
            bind_host,
            bind_port,
            remote_host,
            remote_port,
        )
        .await
}

#[tauri::command]
pub async fn forward_start_remote(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    remote_bind_host: String,
    remote_bind_port: u16,
    local_host: String,
    local_port: u16,
) -> AppResult<ForwardInfo> {
    let connection = connect_session(&app, &state, &session_id).await?;
    state
        .remote
        .forward_start_remote(
            &app,
            session_id,
            connection.connection_id,
            remote_bind_host,
            remote_bind_port,
            local_host,
            local_port,
        )
        .await
}

#[tauri::command]
pub async fn forward_start_dynamic(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    bind_host: String,
    bind_port: u16,
) -> AppResult<ForwardInfo> {
    let connection = connect_session(&app, &state, &session_id).await?;
    state
        .remote
        .forward_start_dynamic(
            &app,
            session_id,
            connection.connection_id,
            bind_host,
            bind_port,
        )
        .await
}

#[tauri::command]
pub async fn forward_stop(
    app: AppHandle,
    state: State<'_, AppState>,
    forward_id: String,
) -> AppResult<()> {
    ensure_vault_unlocked(&state)?;
    state.remote.forward_stop(&app, &forward_id).await
}

#[tauri::command]
pub async fn forward_list(state: State<'_, AppState>) -> AppResult<Vec<ForwardInfo>> {
    ensure_vault_unlocked(&state)?;
    Ok(state.remote.forward_list().await)
}
