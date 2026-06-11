use tauri::{AppHandle, State};

use crate::errors::AppResult;
use crate::remote::{RemoteFileEntry, SftpInfo, TransferHistorySnapshot, TransferInfo};

use super::{ensure_vault_unlocked, AppState};

#[tauri::command]
pub async fn sftp_open(state: State<'_, AppState>, connection_id: String) -> AppResult<SftpInfo> {
    ensure_vault_unlocked(&state)?;
    state.remote.open_sftp(&connection_id).await
}

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
) -> AppResult<Vec<RemoteFileEntry>> {
    ensure_vault_unlocked(&state)?;
    state.remote.sftp_list(&sftp_id, path).await
}

#[tauri::command]
pub async fn sftp_search(
    state: State<'_, AppState>,
    sftp_id: String,
    base_path: String,
    query: String,
) -> AppResult<Option<String>> {
    ensure_vault_unlocked(&state)?;
    state
        .remote
        .sftp_search_file(&sftp_id, base_path, query)
        .await
}

#[tauri::command]
pub async fn sftp_resolve_target(
    state: State<'_, AppState>,
    sftp_id: String,
    current_path: String,
    source_path: String,
    value: String,
) -> AppResult<String> {
    ensure_vault_unlocked(&state)?;
    state
        .remote
        .sftp_resolve_target(&sftp_id, current_path, source_path, value)
        .await
}

#[tauri::command]
pub async fn sftp_mkdir(
    app: AppHandle,
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
) -> AppResult<()> {
    ensure_vault_unlocked(&state)?;
    state.remote.sftp_mkdir(&app, &sftp_id, path).await
}

#[tauri::command]
pub async fn sftp_create_file(
    app: AppHandle,
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
) -> AppResult<()> {
    ensure_vault_unlocked(&state)?;
    state.remote.sftp_create_file(&app, &sftp_id, path).await
}

#[tauri::command]
pub async fn sftp_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
    recursive: bool,
) -> AppResult<()> {
    ensure_vault_unlocked(&state)?;
    state
        .remote
        .sftp_delete(&app, &sftp_id, path, recursive)
        .await
}

#[tauri::command]
pub async fn sftp_rename(
    app: AppHandle,
    state: State<'_, AppState>,
    sftp_id: String,
    from: String,
    to: String,
) -> AppResult<()> {
    ensure_vault_unlocked(&state)?;
    state.remote.sftp_rename(&app, &sftp_id, from, to).await
}

#[tauri::command]
pub async fn sftp_copy(
    app: AppHandle,
    state: State<'_, AppState>,
    sftp_id: String,
    from: String,
    to: String,
) -> AppResult<()> {
    ensure_vault_unlocked(&state)?;
    state.remote.sftp_copy(&app, &sftp_id, from, to).await
}

#[tauri::command]
pub async fn sftp_read_text(
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
) -> AppResult<String> {
    ensure_vault_unlocked(&state)?;
    state.remote.sftp_read_text(&sftp_id, path).await
}

#[tauri::command]
pub async fn sftp_write_text(
    app: AppHandle,
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
    content: String,
) -> AppResult<()> {
    ensure_vault_unlocked(&state)?;
    state
        .remote
        .sftp_write_text(&app, &sftp_id, path, content)
        .await
}

#[tauri::command]
pub async fn transfer_upload(
    app: AppHandle,
    state: State<'_, AppState>,
    sftp_id: String,
    local_path: String,
    remote_path: String,
    overwrite: bool,
    accelerated: Option<bool>,
    resume: Option<bool>,
) -> AppResult<TransferInfo> {
    ensure_vault_unlocked(&state)?;
    state
        .remote
        .transfer_upload(
            &app,
            sftp_id,
            local_path,
            remote_path,
            overwrite,
            accelerated.unwrap_or(false),
            resume.unwrap_or(false),
        )
        .await
}

#[tauri::command]
pub async fn transfer_download(
    app: AppHandle,
    state: State<'_, AppState>,
    sftp_id: String,
    remote_path: String,
    local_path: String,
    overwrite: bool,
) -> AppResult<TransferInfo> {
    ensure_vault_unlocked(&state)?;
    state
        .remote
        .transfer_download(&app, sftp_id, remote_path, local_path, overwrite)
        .await
}

#[tauri::command]
pub async fn transfer_cancel(
    app: AppHandle,
    state: State<'_, AppState>,
    transfer_id: String,
) -> AppResult<()> {
    ensure_vault_unlocked(&state)?;
    state.remote.transfer_cancel(&app, &transfer_id).await
}

#[tauri::command]
pub async fn transfer_pause(
    app: AppHandle,
    state: State<'_, AppState>,
    transfer_id: String,
) -> AppResult<TransferInfo> {
    ensure_vault_unlocked(&state)?;
    state.remote.transfer_pause(&app, &transfer_id).await
}

#[tauri::command]
pub async fn transfer_resume(
    app: AppHandle,
    state: State<'_, AppState>,
    transfer_id: String,
) -> AppResult<TransferInfo> {
    ensure_vault_unlocked(&state)?;
    state.remote.transfer_resume(&app, &transfer_id).await
}

#[tauri::command]
pub async fn transfer_remove(
    app: AppHandle,
    state: State<'_, AppState>,
    transfer_id: String,
) -> AppResult<TransferHistorySnapshot> {
    ensure_vault_unlocked(&state)?;
    state.remote.transfer_remove(&app, &transfer_id).await
}

#[tauri::command]
pub async fn transfer_retry(
    app: AppHandle,
    state: State<'_, AppState>,
    transfer_id: String,
) -> AppResult<TransferInfo> {
    ensure_vault_unlocked(&state)?;
    state.remote.transfer_retry(&app, &transfer_id).await
}

#[tauri::command]
pub async fn transfer_history_snapshot(
    state: State<'_, AppState>,
) -> AppResult<TransferHistorySnapshot> {
    ensure_vault_unlocked(&state)?;
    state.remote.transfer_history_snapshot().await
}

#[tauri::command]
pub async fn transfer_history_clear_finished(
    state: State<'_, AppState>,
) -> AppResult<TransferHistorySnapshot> {
    ensure_vault_unlocked(&state)?;
    state.remote.clear_finished_transfer_history().await
}
