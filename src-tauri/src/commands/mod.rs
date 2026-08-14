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
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc, Mutex,
    },
};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tokio::sync::{watch, Mutex as TokioMutex, RwLock as TokioRwLock};

use crate::{
    api_server::ApiServerHandle,
    config::{AppSettings, KnownHostEntry, SessionConfig, SshProxyOptions},
    config_mutation::ConfigMutationCoordinator,
    errors::{AppError, AppResult},
    remote::{ConnectionInfo, RemoteRuntime},
    vault::{VaultStore, VAULT_FILE_NAME},
};

// ─── Re-exports (used by lib.rs invoke_handler) ────────────────────────────────

pub use api_server_cmd::{
    api_server_configure_and_start, api_server_logs, api_server_regenerate_key, api_server_status,
    api_server_stop, spawn_api_server_autostart,
};
pub use backup::{
    backup_record_delete, backup_record_restore, backup_records_clear, backup_run_now,
    spawn_auto_backup_scheduler,
};
pub use desktop::{
    check_update, download_update, install_update, local_create_directories, local_expand_paths,
    local_path_exists, open_database_dir, open_external_url, open_path_dir,
};
pub use remote::{
    connection_list, forward_list, forward_start_dynamic, forward_start_local,
    forward_start_remote, forward_stop, latency_probe, telemetry_snapshot, telemetry_start,
    telemetry_stop,
};
pub use sessions::{
    group_create, group_delete, group_update, session_clear_recent, session_create, session_delete,
    session_favorite_update, session_mark_recent, session_update, ssh_connect, ssh_disconnect,
    ssh_trust_host_key,
};
pub use sftp::{
    sftp_close, sftp_copy, sftp_create_file, sftp_delete, sftp_exists, sftp_list, sftp_mkdir,
    sftp_open, sftp_read_text, sftp_rename, sftp_resolve_target, sftp_search, sftp_write_text,
    transfer_cancel, transfer_download, transfer_history_clear_finished, transfer_history_snapshot,
    transfer_pause, transfer_remove, transfer_resume, transfer_retry, transfer_upload,
};
pub use terminal::{
    ssh_exec, ssh_exec_on_connection, terminal_close, terminal_open, terminal_resize,
    terminal_start, terminal_write,
};
pub use vault::{
    config_snapshot, connection_section_state_update, quick_command_delete, quick_command_upsert,
    settings_ai_api_update, settings_backup_update, settings_ignore_update_version,
    settings_proxy_update, tunnel_create, tunnel_delete, tunnel_update, vault_backup_export,
    vault_backup_import, vault_migrate, vault_needs_migration, vault_skip_migration,
};

// ─── Constants ─────────────────────────────────────────────────────────────────

const VAULT_PATH_ENV: &str = "HELM_VAULT_PATH";
const PROXY_KIND_DIRECT: &str = "direct";
const TRANSFER_HISTORY_FILE_NAME: &str = "transfer-history.json";
const SHUTDOWN_NOT_STARTED: u8 = 0;
const SHUTDOWN_IN_PROGRESS: u8 = 1;
const SHUTDOWN_COMPLETE: u8 = 2;

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
    pub(super) api_server_operation: TokioMutex<()>,
    pub(super) backup_operation: Arc<TokioMutex<()>>,
    pub(super) tunnel_operation: Arc<TokioMutex<()>>,
    pub(super) connection_config_gate: Arc<TokioRwLock<()>>,
    pub(super) config_mutations: ConfigMutationCoordinator,
    pub(super) frontend_ready: AtomicBool,
    pub(super) data_dir: PathBuf,
    pub(super) needs_migration: AtomicBool,
    pub(super) auto_backup_scheduler_started: Arc<AtomicBool>,
    pub(super) shutdown_tx: watch::Sender<bool>,
    shutdown_phase: AtomicU8,
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
        let (shutdown_tx, _) = watch::channel(false);
        Self {
            vault,
            remote,
            api_server: TokioMutex::new(None),
            api_server_operation: TokioMutex::new(()),
            backup_operation: Arc::new(TokioMutex::new(())),
            tunnel_operation: Arc::new(TokioMutex::new(())),
            connection_config_gate: Arc::new(TokioRwLock::new(())),
            config_mutations: ConfigMutationCoordinator::default(),
            frontend_ready: AtomicBool::new(false),
            data_dir,
            needs_migration: AtomicBool::new(needs_migration),
            auto_backup_scheduler_started: Arc::new(AtomicBool::new(false)),
            shutdown_tx,
            shutdown_phase: AtomicU8::new(SHUTDOWN_NOT_STARTED),
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

    pub(super) fn shutdown_receiver(&self) -> watch::Receiver<bool> {
        self.shutdown_tx.subscribe()
    }

    pub(super) fn request_shutdown(&self) {
        let _ = self.shutdown_tx.send(true);
    }

    pub(super) fn begin_shutdown(&self) -> bool {
        self.shutdown_phase
            .compare_exchange(
                SHUTDOWN_NOT_STARTED,
                SHUTDOWN_IN_PROGRESS,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    pub(super) fn shutdown_complete(&self) -> bool {
        self.shutdown_phase.load(Ordering::Acquire) == SHUTDOWN_COMPLETE
    }

    pub(super) fn is_shutting_down(&self) -> bool {
        self.shutdown_phase.load(Ordering::Acquire) != SHUTDOWN_NOT_STARTED
    }

    pub(super) fn finish_shutdown(&self) {
        self.shutdown_phase
            .store(SHUTDOWN_COMPLETE, Ordering::Release);
    }

    pub(super) async fn shutdown_runtime(&self, app: &AppHandle) {
        self.request_shutdown();

        // Stop accepting API work before draining shared operations and remote
        // resources. Keep the operation guard so a queued start cannot race the
        // final cleanup pass.
        let _api_guard = self.api_server_operation.lock().await;
        let api_server = self.api_server.lock().await.take();
        if let Some(handle) = api_server {
            handle.shutdown().await;
        }

        // Let an in-flight backup finish its atomic write, then block new tunnel
        // and connection work while all SSH-owned resources are torn down.
        let _backup_guard = self.backup_operation.lock().await;
        let _tunnel_guard = self.tunnel_operation.lock().await;
        let _config_guard = self.connection_config_gate.write().await;
        self.remote.shutdown_all_for_exit(app).await;
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
    let _config_guard = state.connection_config_gate.read().await;
    let (session, known_host) = session_bundle(state, session_id)?;
    let connection = state
        .remote
        .connect(app, session.clone(), known_host)
        .await?;
    let still_valid = with_store(state, |store| {
        session_matches_current_connection_config(store, &session)
    })
    .unwrap_or(false);
    if !still_valid {
        let _ = state
            .remote
            .shutdown_connection(app, &connection.connection_id)
            .await;
        return Err(AppError::InvalidInput(
            "会话配置已变更，请重新连接".to_string(),
        ));
    }
    Ok(connection)
}

async fn connect_session_new(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: &str,
) -> AppResult<ConnectionInfo> {
    let _config_guard = state.connection_config_gate.read().await;
    let (session, known_host) = session_bundle(state, session_id)?;
    let connection = state
        .remote
        .connect_new(app, session.clone(), known_host)
        .await?;
    let still_valid = with_store(state, |store| {
        session_matches_current_connection_config(store, &session)
    })
    .unwrap_or(false);
    if !still_valid {
        let _ = state
            .remote
            .shutdown_connection(app, &connection.connection_id)
            .await;
        return Err(AppError::InvalidInput(
            "会话配置已变更，请重新连接".to_string(),
        ));
    }
    Ok(connection)
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

pub(crate) fn session_matches_current_connection_config(
    store: &VaultStore,
    expected: &SessionConfig,
) -> AppResult<bool> {
    let (current, _) = build_session_for_connect(store, &expected.id)?;
    Ok(current.host == expected.host
        && current.port == expected.port
        && current.username == expected.username
        && current.auth == expected.auth
        && current.ssh == expected.ssh)
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{VaultData, VAULT_DATA_VERSION};
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
        assert_eq!(data.version, VAULT_DATA_VERSION);
        assert_eq!(data.groups.len(), 1);
        assert!(data.sessions.is_empty());
    }

    #[test]
    fn shutdown_can_only_start_once_and_then_completes() {
        let (state, _temp) = fresh_state();
        assert!(state.begin_shutdown());
        assert!(!state.begin_shutdown());
        assert!(state.is_shutting_down());
        assert!(!state.shutdown_complete());

        state.finish_shutdown();
        assert!(state.shutdown_complete());
        assert!(!state.begin_shutdown());
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
