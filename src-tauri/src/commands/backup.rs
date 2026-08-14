use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use tauri::{AppHandle, Manager, State};

use super::{
    api_server_cmd::{
        restore_api_server_after_config_replacement, stop_api_server_for_config_replacement,
    },
    with_store, AppResult, AppState,
};
use crate::backup::{
    auto_backup_due_target_kinds, download_cloud_backup, merge_configured_backup_records,
    prepare_backup_run, remove_backup_target_best_effort, run_auto_backup, run_configured_backup,
};
use crate::config::ConfigSnapshot;
use crate::errors::AppError;
use crate::events;

const AUTO_BACKUP_INITIAL_DELAY: Duration = Duration::from_secs(3);
const AUTO_BACKUP_INTERVAL: Duration = Duration::from_secs(60);

pub fn spawn_auto_backup_scheduler(app: AppHandle) {
    let state = app.state::<AppState>();
    let Some(registration) = claim_background_task(&state.auto_backup_scheduler_started) else {
        log::debug!("auto backup scheduler already started");
        return;
    };
    let mut shutdown = state.shutdown_receiver();
    tauri::async_runtime::spawn(async move {
        let _registration = registration;
        run_auto_backup_scheduler(&app, &mut shutdown).await;
    });
}

struct BackgroundTaskRegistration(Arc<AtomicBool>);

fn claim_background_task(started: &Arc<AtomicBool>) -> Option<BackgroundTaskRegistration> {
    started
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .ok()
        .map(|_| BackgroundTaskRegistration(started.clone()))
}

impl Drop for BackgroundTaskRegistration {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

async fn run_auto_backup_scheduler(
    app: &AppHandle,
    shutdown: &mut tokio::sync::watch::Receiver<bool>,
) {
    tokio::select! {
        _ = tokio::time::sleep(AUTO_BACKUP_INITIAL_DELAY) => {}
        _ = wait_for_shutdown(shutdown) => return,
    }
    loop {
        if let Err(error) = run_due_auto_backup(app).await {
            if !matches!(error, AppError::VaultLocked | AppError::VaultNotFound) {
                eprintln!("[helm] auto backup failed: {error}");
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(AUTO_BACKUP_INTERVAL) => {}
            _ = wait_for_shutdown(shutdown) => return,
        }
    }
}

async fn wait_for_shutdown(shutdown: &mut tokio::sync::watch::Receiver<bool>) {
    while !*shutdown.borrow_and_update() {
        if shutdown.changed().await.is_err() {
            break;
        }
    }
}

async fn run_due_auto_backup(app: &AppHandle) -> AppResult<()> {
    let state = app.state::<AppState>();
    if state.needs_migration() {
        return Ok(());
    }
    let target_kinds = with_store(&state, |store| {
        let snapshot = store.snapshot()?;
        Ok(auto_backup_due_target_kinds(
            &snapshot.data.settings.backup,
            &snapshot.data.backup_records,
        ))
    })?;
    if target_kinds.is_empty() {
        return Ok(());
    }
    let snapshot = backup_run_auto(state, target_kinds).await?;
    events::emit(app, events::CONFIG_CHANGED, snapshot);
    Ok(())
}

#[tauri::command]
pub async fn backup_run_now(state: State<'_, AppState>) -> AppResult<ConfigSnapshot> {
    let ticket = state.config_mutations.ticket();
    let _operation_guard = state.backup_operation.lock().await;
    let validation_guard = state.config_mutations.lock(ticket).await?;
    let plan = with_store(&state, |store| prepare_backup_run(store))?;
    drop(validation_guard);
    let outcomes = run_configured_backup(&plan).await?;
    let records = merge_configured_backup_records(&plan, outcomes).await;
    let _mutation_guard = state.config_mutations.lock(ticket).await?;
    let (snapshot, delete_paths) =
        with_store(&state, |store| store.replace_backup_records(records))?;
    drop(_mutation_guard);
    for target in delete_paths {
        remove_backup_target_best_effort(target, "manual backup record replacement").await;
    }
    Ok(snapshot)
}

async fn backup_run_auto(
    state: State<'_, AppState>,
    target_kinds: Vec<String>,
) -> AppResult<ConfigSnapshot> {
    let ticket = state.config_mutations.ticket();
    let _operation_guard = state.backup_operation.lock().await;
    let validation_guard = state.config_mutations.lock(ticket).await?;
    let plan = with_store(&state, |store| prepare_backup_run(store))?;
    drop(validation_guard);
    let outcomes = run_auto_backup(&plan, &target_kinds).await?;
    let records = merge_configured_backup_records(&plan, outcomes).await;
    let _mutation_guard = state.config_mutations.lock(ticket).await?;
    let (snapshot, delete_paths) =
        with_store(&state, |store| store.replace_backup_records(records))?;
    drop(_mutation_guard);
    for target in delete_paths {
        remove_backup_target_best_effort(target, "auto backup record replacement").await;
    }
    Ok(snapshot)
}

#[tauri::command]
pub async fn backup_record_restore(
    app: AppHandle,
    state: State<'_, AppState>,
    record_id: String,
) -> AppResult<ConfigSnapshot> {
    // Validate the selection before taking the API lifecycle lock so obvious
    // input errors do not stop the service. The record is loaded again after
    // the server has drained and the backup-operation lock is held; otherwise
    // a concurrent delete/settings update can invalidate the path or cloud
    // credentials while this restore is reading them.
    with_store(&state, |store| {
        let snapshot = store.snapshot()?;
        let record = snapshot
            .data
            .backup_records
            .iter()
            .find(|r| r.id == record_id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("备份记录 {}", record_id)))?;
        if record.status != "success" {
            return Err(AppError::InvalidInput("失败的备份记录不能恢复".to_string()));
        }
        Ok(())
    })?;
    let (api_guard, api_was_running) = stop_api_server_for_config_replacement(&app, &state).await;
    let _operation_guard = state.backup_operation.lock().await;
    let result = async {
        let (settings, record) = with_store(&state, |store| {
            let snapshot = store.snapshot()?;
            let record = snapshot
                .data
                .backup_records
                .iter()
                .find(|r| r.id == record_id)
                .cloned()
                .ok_or_else(|| AppError::NotFound(format!("备份记录 {}", record_id)))?;
            if record.status != "success" {
                return Err(AppError::InvalidInput("失败的备份记录不能恢复".to_string()));
            }
            Ok((snapshot.data.settings.backup, record))
        })?;
        let bytes = if record.target_kind == "local" {
            tokio::fs::read(&record.target_path)
                .await
                .map_err(|e| AppError::Io(e.to_string()))?
        } else {
            download_cloud_backup(&settings.cloud, &record).await?
        };
        with_store(&state, |store| store.validate_backup_bytes(&bytes))?;
        let _tunnel_guard = state.tunnel_operation.lock().await;
        let _config_guard = state.connection_config_gate.write().await;
        let _replacement_guard = state.config_mutations.begin_replacement().await;
        state.remote.shutdown_all(&app).await;
        let snapshot = with_store(&state, |store| store.backup_import_bytes(&bytes))?;
        events::emit(&app, events::CONFIG_CHANGED, snapshot.clone());
        Ok(snapshot)
    }
    .await;
    drop(_operation_guard);
    drop(api_guard);
    restore_api_server_after_config_replacement(&app, &state, api_was_running).await;
    result
}

#[tauri::command]
pub async fn backup_record_delete(
    state: State<'_, AppState>,
    record_id: String,
    delete_file: bool,
) -> AppResult<ConfigSnapshot> {
    let ticket = state.config_mutations.ticket();
    let _operation_guard = state.backup_operation.lock().await;
    let _mutation_guard = state.config_mutations.lock(ticket).await?;
    let (snapshot, delete_path) = with_store(&state, |store| {
        store.delete_backup_record(&record_id, delete_file)
    })?;
    drop(_mutation_guard);
    if let Some(target) = delete_path {
        remove_backup_target_best_effort(target, "backup record deletion").await;
    }
    Ok(snapshot)
}

#[tauri::command]
pub async fn backup_records_clear(state: State<'_, AppState>) -> AppResult<ConfigSnapshot> {
    let ticket = state.config_mutations.ticket();
    let _operation_guard = state.backup_operation.lock().await;
    let _mutation_guard = state.config_mutations.lock(ticket).await?;
    let (snapshot, _) = with_store(&state, |store| store.replace_backup_records(Vec::new()))?;
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_task_registration_is_single_owner_and_reusable_after_drop() {
        let started = Arc::new(AtomicBool::new(false));
        let registration = claim_background_task(&started).expect("first claim should succeed");
        assert!(claim_background_task(&started).is_none());
        drop(registration);
        assert!(!started.load(Ordering::Acquire));
        assert!(claim_background_task(&started).is_some());
    }
}
