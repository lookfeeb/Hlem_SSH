mod api_server_cmd;
mod backup;
mod desktop;
mod remote;
mod sessions;
mod sftp;
mod terminal;
mod vault;

use std::{
    env,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex as TokioMutex;

use crate::{
    api_server::ApiServerHandle,
    config::{AppSettings, KnownHostEntry, SessionConfig, SshProxyOptions},
    errors::{AppError, AppResult},
    remote::{ConnectionInfo, RemoteRuntime},
    vault::{VaultStore, VAULT_FILE_NAME},
};

// ─── Re-exports (used by lib.rs invoke_handler) ────────────────────────────────

pub use api_server_cmd::{
    api_server_logs, api_server_regenerate_key, api_server_start, api_server_status,
    api_server_stop, api_server_update_sessions,
};
pub use backup::{
    backup_record_delete, backup_record_restore, backup_records_clear, backup_run_now,
    spawn_auto_backup_scheduler,
};
pub use desktop::{
    check_update, download_update, fetch_text_url, install_update, local_expand_paths,
    local_path_exists, open_database_dir, open_external_url, open_log_dir, open_path_dir,
};
pub use remote::{
    forward_list, forward_start_dynamic, forward_start_local, forward_start_remote, forward_stop,
    telemetry_snapshot, telemetry_start, telemetry_stop,
};
pub use sessions::{
    group_create, group_delete, group_update, session_create, session_delete, session_duplicate,
    session_update, ssh_connect, ssh_disconnect, ssh_trust_host_key,
};
pub use sftp::{
    sftp_copy, sftp_create_file, sftp_delete, sftp_list, sftp_mkdir, sftp_open, sftp_read_text,
    sftp_rename, sftp_resolve_target, sftp_search, sftp_write_text, transfer_cancel,
    transfer_download, transfer_history_clear_finished, transfer_history_snapshot, transfer_pause,
    transfer_remove, transfer_resume, transfer_retry, transfer_upload,
};
pub use terminal::{
    ssh_exec, ssh_exec_on_connection, terminal_close, terminal_open, terminal_resize,
    terminal_write,
};
pub use vault::{
    config_snapshot, settings_update, tunnel_create, tunnel_delete, tunnel_list, tunnel_update,
    vault_backup_export, vault_backup_import, vault_migrate, vault_needs_migration,
    vault_skip_migration,
};

// ─── Constants ─────────────────────────────────────────────────────────────────

const VAULT_PATH_ENV: &str = "HELM_VAULT_PATH";
const PROXY_KIND_DIRECT: &str = "direct";
const TRANSFER_HISTORY_FILE_NAME: &str = "transfer-history.json";

// ─── Public types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub os: String,
    pub arch: String,
    pub database_path: String,
}

pub struct AppState {
    pub(super) vault: Arc<Mutex<VaultStore>>,
    pub(super) remote: RemoteRuntime,
    pub(super) api_server: TokioMutex<Option<ApiServerHandle>>,
    pub(super) data_dir: PathBuf,
    pub(super) needs_migration: AtomicBool,
}

impl AppState {
    pub fn new(vault_path: PathBuf) -> Self {
        let data_dir = vault_path
            .parent()
            .unwrap_or(vault_path.as_path())
            .to_path_buf();
        let (vault, needs_migration) = {
            let mut store = VaultStore::new(vault_path);
            let result = store
                .auto_open()
                .unwrap_or(crate::vault::AutoOpenResult::NeedsMigration);
            let needs_migration = result == crate::vault::AutoOpenResult::NeedsMigration;
            (Arc::new(Mutex::new(store)), needs_migration)
        };
        let remote =
            RemoteRuntime::with_transfer_history_path(data_dir.join(TRANSFER_HISTORY_FILE_NAME));
        Self {
            vault,
            remote,
            api_server: TokioMutex::new(None),
            data_dir,
            needs_migration: AtomicBool::new(needs_migration),
        }
    }

    fn ensure_vault_unlocked(&self) -> AppResult<()> {
        let store = self.vault.lock().map_err(lock_poisoned)?;
        store.ensure_unlocked()
    }

    pub fn remote(&self) -> &RemoteRuntime {
        &self.remote
    }

    pub(super) fn needs_migration(&self) -> bool {
        self.needs_migration.load(Ordering::Relaxed)
    }

    pub(super) fn clear_migration_needed(&self) {
        self.needs_migration.store(false, Ordering::Relaxed);
    }
}

// ─── Public commands defined here (too small to warrant a sub-file) ────────────

pub fn resolve_vault_path(app: &AppHandle) -> AppResult<PathBuf> {
    if let Ok(path) = env::var(VAULT_PATH_ENV) {
        return Ok(PathBuf::from(path));
    }
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| AppError::Io(error.to_string()))?;
    Ok(config_dir.join(VAULT_FILE_NAME))
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> AppResult<AppInfo> {
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        os: desktop::friendly_os_name(),
        arch: env::consts::ARCH.to_string(),
        database_path: resolve_vault_path(&app)?.display().to_string(),
    })
}

// ─── Internal helpers (shared by sub-modules via super::) ──────────────────────

fn with_store<T>(
    state: &State<'_, AppState>,
    action: impl FnOnce(&mut VaultStore) -> AppResult<T>,
) -> AppResult<T> {
    let mut store = state.vault.lock().map_err(lock_poisoned)?;
    action(&mut store)
}

fn ensure_vault_unlocked(state: &State<'_, AppState>) -> AppResult<()> {
    state.ensure_vault_unlocked()
}

fn lock_poisoned<T>(_: T) -> AppError {
    AppError::Crypto("工作区状态锁已损坏".to_string())
}

async fn connect_session(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: &str,
) -> AppResult<ConnectionInfo> {
    let (session, known_host) = session_bundle(state, session_id)?;
    state.remote.connect(app, session, known_host).await
}

fn session_bundle(
    state: &State<'_, AppState>,
    session_id: &str,
) -> AppResult<(SessionConfig, Option<KnownHostEntry>)> {
    with_store(state, |store| build_session_for_connect(store, session_id))
}

/// Resolve a session's full connection bundle from a vault store: SessionConfig
/// (with the global proxy already applied) plus any matching known-host entry.
///
/// Exposed `pub(crate)` so the AI API server can reuse the exact same logic
/// when its `connect-session` command brings a session online without UI
/// interaction. Keeping this in `commands::` ensures both call sites observe
/// identical proxy / known-host semantics.
pub(crate) fn build_session_for_connect(
    store: &VaultStore,
    session_id: &str,
) -> AppResult<(SessionConfig, Option<KnownHostEntry>)> {
    let mut session = store.session(session_id)?;
    let known_host = store.known_host(&session.host, session.port)?;
    let settings = store.snapshot()?.data.settings;
    apply_global_proxy(&mut session, &settings);
    Ok((session, known_host))
}

fn apply_global_proxy(session: &mut SessionConfig, settings: &AppSettings) {
    if let Some(proxy) = session.ssh.proxy.as_ref() {
        if proxy.kind == PROXY_KIND_DIRECT {
            session.ssh.proxy = None;
        }
        return;
    }
    if let Some(proxy) = settings.proxy.as_ref() {
        if !proxy.enabled {
            return;
        }
        session.ssh.proxy = Some(SshProxyOptions {
            kind: proxy.kind.clone(),
            host: proxy.host.clone(),
            port: proxy.port,
        });
    }
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::VaultData;
    use tempfile::TempDir;

    fn fresh_state() -> (AppState, TempDir) {
        let dir = tempfile::tempdir().expect("create tempdir for AppState test");
        let state = AppState::new(dir.path().join("test.rpvault"));
        (state, dir)
    }

    #[test]
    fn auto_open_unlocks_a_fresh_vault() {
        let (state, _guard) = fresh_state();
        let store = state.vault.lock().expect("vault mutex");
        assert!(store.status().exists);
        assert!(store.status().unlocked);
        assert!(!state.needs_migration());
    }

    #[test]
    fn vault_data_defaults_have_one_group_and_no_sessions() {
        let data = VaultData::with_default_group();
        assert_eq!(data.version, 1);
        assert_eq!(data.groups.len(), 1);
        assert!(data.sessions.is_empty());
    }

    #[test]
    fn runtime_command_guard_rejects_a_locked_vault() {
        let (state, _guard) = fresh_state();
        state.vault.lock().expect("vault mutex").lock();
        assert!(matches!(
            state.ensure_vault_unlocked(),
            Err(AppError::VaultLocked)
        ));
    }

    #[test]
    fn runtime_command_guard_accepts_an_unlocked_vault() {
        let (state, _guard) = fresh_state();
        assert!(state.ensure_vault_unlocked().is_ok());
    }
}
