use tauri::{AppHandle, State};

use super::{with_store, AppResult, AppState};
use crate::backup::{
    download_cloud_backup, merge_configured_backup_records, prepare_backup_run, run_auto_backup,
    run_configured_backup,
};
use crate::config::ConfigSnapshot;
use crate::errors::AppError;

#[tauri::command]
pub async fn backup_run_now(state: State<'_, AppState>) -> AppResult<ConfigSnapshot> {
    let plan = with_store(&state, |store| prepare_backup_run(store))?;
    let outcomes = run_configured_backup(&plan).await?;
    let records = merge_configured_backup_records(&plan.settings, outcomes).await;
    let (snapshot, delete_paths) =
        with_store(&state, |store| store.replace_backup_records(records))?;
    for path in delete_paths {
        let _ = tokio::fs::remove_file(path).await;
    }
    Ok(snapshot)
}

#[tauri::command]
pub async fn backup_run_auto(
    state: State<'_, AppState>,
    target_kinds: Vec<String>,
) -> AppResult<ConfigSnapshot> {
    let plan = with_store(&state, |store| prepare_backup_run(store))?;
    let outcomes = run_auto_backup(&plan, &target_kinds).await?;
    let records = merge_configured_backup_records(&plan.settings, outcomes).await;
    let (snapshot, delete_paths) =
        with_store(&state, |store| store.replace_backup_records(records))?;
    for path in delete_paths {
        let _ = tokio::fs::remove_file(path).await;
    }
    Ok(snapshot)
}

#[tauri::command]
pub async fn backup_record_restore(
    app: AppHandle,
    state: State<'_, AppState>,
    record_id: String,
) -> AppResult<ConfigSnapshot> {
    let (settings, record) = with_store(&state, |store| {
        let snapshot = store.snapshot()?;
        let record = snapshot
            .data
            .backup_records
            .iter()
            .find(|r| r.id == record_id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("备份记录 {}", record_id)))?;
        Ok((snapshot.data.settings.backup, record))
    })?;
    if record.status != "success" {
        return Err(AppError::InvalidInput("失败的备份记录不能恢复".to_string()));
    }
    let bytes = if record.target_kind == "local" {
        tokio::fs::read(&record.target_path)
            .await
            .map_err(|e| AppError::Io(e.to_string()))?
    } else {
        download_cloud_backup(&settings.cloud, &record).await?
    };
    with_store(&state, |store| store.validate_backup_bytes(&bytes))?;
    state.remote.shutdown_all(&app).await;
    with_store(&state, |store| store.backup_import_bytes(&bytes))
}

#[tauri::command]
pub async fn backup_record_delete(
    state: State<'_, AppState>,
    record_id: String,
    delete_file: bool,
) -> AppResult<ConfigSnapshot> {
    let (snapshot, delete_path) = with_store(&state, |store| {
        store.delete_backup_record(&record_id, delete_file)
    })?;
    if let Some(path) = delete_path {
        let _ = tokio::fs::remove_file(path).await;
    }
    Ok(snapshot)
}

#[tauri::command]
pub fn backup_records_clear(state: State<'_, AppState>) -> AppResult<ConfigSnapshot> {
    let (snapshot, _) = with_store(&state, |store| store.replace_backup_records(Vec::new()))?;
    Ok(snapshot)
}
