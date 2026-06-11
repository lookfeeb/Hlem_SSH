use std::path::PathBuf;

use tauri::{AppHandle, State};

use super::{with_store, AppError, AppResult, AppState};
use crate::backup::build_backup_package;
use crate::config::{AppSettings, ConfigSnapshot, TunnelConfig, TunnelInput};
use crate::vault::{VaultStore, AUTO_PASSWORD};

#[tauri::command]
pub fn vault_needs_migration(state: State<'_, AppState>) -> bool {
    state.needs_migration()
}

#[tauri::command]
pub fn vault_migrate(
    state: State<'_, AppState>,
    old_password: String,
) -> AppResult<ConfigSnapshot> {
    let snapshot = with_store(&state, |store| store.migrate(&old_password))?;
    state.clear_migration_needed();
    Ok(snapshot)
}

#[tauri::command]
pub fn vault_skip_migration(state: State<'_, AppState>) -> AppResult<ConfigSnapshot> {
    let mut store = state.vault.lock().map_err(super::lock_poisoned)?;
    let path = store.vault_file_path();
    let _ = std::fs::remove_file(&path);
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
pub fn settings_update(
    state: State<'_, AppState>,
    settings: AppSettings,
) -> AppResult<ConfigSnapshot> {
    with_store(&state, |store| store.settings_update(settings))
}

#[tauri::command]
pub fn tunnel_create(state: State<'_, AppState>, input: TunnelInput) -> AppResult<ConfigSnapshot> {
    with_store(&state, |store| store.create_tunnel(input))
}

#[tauri::command]
pub fn tunnel_update(
    state: State<'_, AppState>,
    tunnel_id: String,
    input: TunnelInput,
) -> AppResult<ConfigSnapshot> {
    with_store(&state, |store| store.update_tunnel(&tunnel_id, input))
}

#[tauri::command]
pub fn tunnel_delete(state: State<'_, AppState>, tunnel_id: String) -> AppResult<ConfigSnapshot> {
    with_store(&state, |store| store.delete_tunnel(&tunnel_id))
}

#[tauri::command]
pub fn tunnel_list(state: State<'_, AppState>) -> AppResult<Vec<TunnelConfig>> {
    with_store(&state, |store| store.tunnels())
}

#[tauri::command]
pub async fn vault_backup_export(state: State<'_, AppState>, path: String) -> AppResult<()> {
    let vault_path = with_store(&state, |store| {
        store.ensure_unlocked()?;
        Ok(store.vault_file_path())
    })?;
    let bytes = tokio::fs::read(&vault_path)
        .await
        .map_err(|e| AppError::Io(e.to_string()))?;
    let package = build_backup_package(bytes).await?;
    let path = PathBuf::from(path);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(path, package).await?;
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
    state.remote.shutdown_all(&app).await;
    with_store(&state, |store| store.backup_import(&path))
}
