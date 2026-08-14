use std::{io::ErrorKind, path::PathBuf};

use tauri::{AppHandle, State};

use super::{
    api_server_cmd::{
        reconcile_api_server_with_snapshot, restore_api_server_after_config_replacement,
        stop_api_server_for_config_replacement,
    },
    with_store, AppError, AppResult, AppState,
};
use crate::backup::build_backup_package;
use crate::config::{AppProxyOptions, BackupSettings, ConfigSnapshot, QuickCommand, TunnelInput};
use crate::vault::{AiApiSettingsUpdate, VaultStore, AUTO_PASSWORD};

#[tauri::command]
pub fn vault_needs_migration(state: State<'_, AppState>) -> bool {
    state.needs_migration()
}

#[tauri::command]
pub async fn vault_migrate(
    state: State<'_, AppState>,
    old_password: String,
) -> AppResult<ConfigSnapshot> {
    let _replacement_guard = state.config_mutations.begin_replacement().await;
    let snapshot = with_store(&state, |store| store.migrate(&old_password))?;
    state.clear_migration_needed();
    Ok(snapshot)
}

#[tauri::command]
pub async fn vault_skip_migration(state: State<'_, AppState>) -> AppResult<ConfigSnapshot> {
    let _replacement_guard = state.config_mutations.begin_replacement().await;
    let mut store = state.vault.lock().map_err(super::lock_poisoned)?;
    let path = store.vault_file_path();
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => {
            return Err(AppError::Io(format!(
                "删除旧本机数据失败: {}: {error}",
                path.display()
            )));
        }
    }
    *store = VaultStore::new(path);
    let snapshot = store.create(AUTO_PASSWORD)?;
    state.clear_migration_needed();
    Ok(snapshot)
}

#[tauri::command]
pub fn config_snapshot(state: State<'_, AppState>) -> AppResult<ConfigSnapshot> {
    with_store(&state, |store| store.snapshot())
}

#[tauri::command]
pub async fn settings_proxy_update(
    app: AppHandle,
    state: State<'_, AppState>,
    proxy: Option<AppProxyOptions>,
) -> AppResult<ConfigSnapshot> {
    let ticket = state.config_mutations.ticket();
    let _tunnel_guard = state.tunnel_operation.lock().await;
    let _config_guard = state.connection_config_gate.write().await;
    let _mutation_guard = state.config_mutations.lock(ticket).await?;
    let snapshot = with_store(&state, |store| store.settings_proxy_update(proxy))?;
    drop(_mutation_guard);
    state.remote.shutdown_all(&app).await;
    crate::events::emit(&app, crate::events::CONFIG_CHANGED, snapshot.clone());
    Ok(snapshot)
}

#[tauri::command]
pub async fn settings_backup_update(
    state: State<'_, AppState>,
    backup: BackupSettings,
) -> AppResult<ConfigSnapshot> {
    let ticket = state.config_mutations.ticket();
    let _operation_guard = state.backup_operation.lock().await;
    let _mutation_guard = state.config_mutations.lock(ticket).await?;
    let (snapshot, delete_paths) =
        with_store(&state, |store| store.settings_backup_update(backup))?;
    drop(_mutation_guard);
    for target in delete_paths {
        crate::backup::remove_backup_target_best_effort(target, "backup retention settings update")
            .await;
    }
    Ok(snapshot)
}

#[tauri::command]
pub async fn quick_command_upsert(
    state: State<'_, AppState>,
    command: QuickCommand,
) -> AppResult<ConfigSnapshot> {
    let ticket = state.config_mutations.ticket();
    let _mutation_guard = state.config_mutations.lock(ticket).await?;
    with_store(&state, |store| store.quick_command_upsert(command))
}

#[tauri::command]
pub async fn quick_command_delete(
    state: State<'_, AppState>,
    command_id: String,
) -> AppResult<ConfigSnapshot> {
    let ticket = state.config_mutations.ticket();
    let _mutation_guard = state.config_mutations.lock(ticket).await?;
    with_store(&state, |store| store.quick_command_delete(&command_id))
}

#[tauri::command]
pub async fn settings_ai_api_update(
    app: AppHandle,
    state: State<'_, AppState>,
    session_ids: Vec<String>,
    port: Option<u16>,
    auto_start: bool,
) -> AppResult<ConfigSnapshot> {
    let ticket = state.config_mutations.ticket();
    let _mutation_guard = state.config_mutations.lock(ticket).await?;
    let snapshot = with_store(&state, |store| {
        store.settings_ai_api_update(AiApiSettingsUpdate {
            session_ids,
            port,
            auto_start,
        })
    })?;
    drop(_mutation_guard);
    reconcile_api_server_with_snapshot(&app, &state).await;
    crate::events::emit(&app, crate::events::CONFIG_CHANGED, snapshot.clone());
    Ok(snapshot)
}

#[tauri::command]
pub async fn settings_ignore_update_version(
    state: State<'_, AppState>,
    version: String,
) -> AppResult<ConfigSnapshot> {
    let ticket = state.config_mutations.ticket();
    let _mutation_guard = state.config_mutations.lock(ticket).await?;
    with_store(&state, |store| {
        store.settings_ignore_update_version(version)
    })
}

#[tauri::command]
pub async fn connection_section_state_update(
    state: State<'_, AppState>,
    collapsed_section_ids: Vec<String>,
) -> AppResult<ConfigSnapshot> {
    let ticket = state.config_mutations.ticket();
    let _mutation_guard = state.config_mutations.lock(ticket).await?;
    with_store(&state, |store| {
        store.connection_section_state_update(collapsed_section_ids)
    })
}

#[tauri::command]
pub async fn tunnel_create(
    state: State<'_, AppState>,
    input: TunnelInput,
) -> AppResult<ConfigSnapshot> {
    let ticket = state.config_mutations.ticket();
    let _operation_guard = state.tunnel_operation.lock().await;
    let _mutation_guard = state.config_mutations.lock(ticket).await?;
    with_store(&state, |store| store.create_tunnel(input))
}

#[tauri::command]
pub async fn tunnel_update(
    app: AppHandle,
    state: State<'_, AppState>,
    tunnel_id: String,
    input: TunnelInput,
) -> AppResult<ConfigSnapshot> {
    let ticket = state.config_mutations.ticket();
    let _operation_guard = state.tunnel_operation.lock().await;
    let _mutation_guard = state.config_mutations.lock(ticket).await?;
    with_store(&state, |store| {
        store.validate_tunnel_update(&tunnel_id, &input)
    })?;
    state
        .remote
        .stop_forwards_for_tunnel(&app, &tunnel_id)
        .await?;
    with_store(&state, |store| store.update_tunnel(&tunnel_id, input))
}

#[tauri::command]
pub async fn tunnel_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    tunnel_id: String,
) -> AppResult<ConfigSnapshot> {
    let ticket = state.config_mutations.ticket();
    let _operation_guard = state.tunnel_operation.lock().await;
    let _mutation_guard = state.config_mutations.lock(ticket).await?;
    state
        .remote
        .stop_forwards_for_tunnel(&app, &tunnel_id)
        .await?;
    with_store(&state, |store| store.delete_tunnel(&tunnel_id))
}

#[tauri::command]
pub async fn vault_backup_export(state: State<'_, AppState>, path: String) -> AppResult<()> {
    let _operation_guard = state.backup_operation.lock().await;
    let vault_path = with_store(&state, |store| {
        store.ensure_unlocked()?;
        Ok(store.vault_file_path())
    })?;
    let bytes = tokio::fs::read(&vault_path)
        .await
        .map_err(|e| AppError::Io(e.to_string()))?;
    let package = build_backup_package(bytes).await?;
    let path = PathBuf::from(path);
    crate::atomic_file::write_atomic_async(&path, &package).await?;
    Ok(())
}

#[tauri::command]
pub async fn vault_backup_import(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> AppResult<ConfigSnapshot> {
    let path = PathBuf::from(path);
    with_store(&state, |store| store.validate_backup(&path))?;
    let (api_guard, api_was_running) = stop_api_server_for_config_replacement(&app, &state).await;
    let _operation_guard = state.backup_operation.lock().await;
    let _tunnel_guard = state.tunnel_operation.lock().await;
    let _config_guard = state.connection_config_gate.write().await;
    let _replacement_guard = state.config_mutations.begin_replacement().await;
    state.remote.shutdown_all(&app).await;
    let result = with_store(&state, |store| store.backup_import(&path));
    if let Ok(snapshot) = &result {
        crate::events::emit(&app, crate::events::CONFIG_CHANGED, snapshot.clone());
    }
    drop(_replacement_guard);
    drop(_config_guard);
    drop(_tunnel_guard);
    drop(_operation_guard);
    drop(api_guard);
    restore_api_server_after_config_replacement(&app, &state, api_was_running).await;
    result
}
