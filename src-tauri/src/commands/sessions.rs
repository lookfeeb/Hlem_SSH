use tauri::{AppHandle, State};

use super::{
    api_server_cmd::{reconcile_api_server_with_snapshot, sync_api_server_authorization_cache},
    connect_session_new, ensure_vault_unlocked, with_store, AppResult, AppState,
};
use crate::config::{ConfigSnapshot, GroupInput, SessionInput};
use crate::remote::ConnectionInfo;

#[tauri::command]
pub async fn group_create(
    state: State<'_, AppState>,
    input: GroupInput,
) -> AppResult<ConfigSnapshot> {
    let ticket = state.config_mutations.ticket();
    let _mutation_guard = state.config_mutations.lock(ticket).await?;
    with_store(&state, |store| store.create_group(input))
}

#[tauri::command]
pub async fn group_update(
    state: State<'_, AppState>,
    group_id: String,
    input: GroupInput,
) -> AppResult<ConfigSnapshot> {
    let ticket = state.config_mutations.ticket();
    let _mutation_guard = state.config_mutations.lock(ticket).await?;
    with_store(&state, |store| store.update_group(&group_id, input))
}

#[tauri::command]
pub async fn group_delete(
    state: State<'_, AppState>,
    group_id: String,
) -> AppResult<ConfigSnapshot> {
    let ticket = state.config_mutations.ticket();
    let _mutation_guard = state.config_mutations.lock(ticket).await?;
    with_store(&state, |store| store.delete_group(&group_id))
}

#[tauri::command]
pub async fn session_create(
    state: State<'_, AppState>,
    input: SessionInput,
) -> AppResult<ConfigSnapshot> {
    let ticket = state.config_mutations.ticket();
    let _mutation_guard = state.config_mutations.lock(ticket).await?;
    with_store(&state, |store| store.create_session(input))
}

#[tauri::command]
pub async fn session_update(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    input: SessionInput,
) -> AppResult<ConfigSnapshot> {
    let ticket = state.config_mutations.ticket();
    let tunnel_guard = state.tunnel_operation.lock().await;
    let config_guard = state.connection_config_gate.write().await;
    let _mutation_guard = state.config_mutations.lock(ticket).await?;
    let (previous, snapshot) = with_store(&state, |store| {
        let previous = store.session(&session_id)?;
        let snapshot = store.update_session(&session_id, input)?;
        Ok((previous, snapshot))
    })?;
    drop(_mutation_guard);
    let current = snapshot
        .data
        .sessions
        .iter()
        .find(|session| session.id == session_id)
        .ok_or_else(|| {
            crate::errors::AppError::ConfigConflict(
                "会话更新完成后配置快照缺少目标会话".to_string(),
            )
        })?;
    if session_connection_config_changed(&previous, current) {
        state
            .remote
            .shutdown_session_connections(&app, &session_id)
            .await;
    }
    drop(config_guard);
    drop(tunnel_guard);
    reconcile_api_server_with_snapshot(&app, &state).await;
    crate::events::emit(&app, crate::events::CONFIG_CHANGED, snapshot.clone());
    Ok(snapshot)
}

#[tauri::command]
pub async fn session_favorite_update(
    state: State<'_, AppState>,
    session_id: String,
    favorite: bool,
) -> AppResult<ConfigSnapshot> {
    let ticket = state.config_mutations.ticket();
    let _mutation_guard = state.config_mutations.lock(ticket).await?;
    with_store(&state, |store| {
        store.set_session_favorite(&session_id, favorite)
    })
}

#[tauri::command]
pub async fn session_mark_recent(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<ConfigSnapshot> {
    let ticket = state.config_mutations.ticket();
    let _mutation_guard = state.config_mutations.lock(ticket).await?;
    with_store(&state, |store| store.mark_session_recent(&session_id))
}

#[tauri::command]
pub async fn session_clear_recent(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<ConfigSnapshot> {
    let ticket = state.config_mutations.ticket();
    let _mutation_guard = state.config_mutations.lock(ticket).await?;
    with_store(&state, |store| store.clear_session_recent(&session_id))
}

#[tauri::command]
pub async fn session_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<ConfigSnapshot> {
    let ticket = state.config_mutations.ticket();
    let api_guard = state.api_server_operation.lock().await;
    let tunnel_guard = state.tunnel_operation.lock().await;
    let config_guard = state.connection_config_gate.write().await;
    let _mutation_guard = state.config_mutations.lock(ticket).await?;
    let snapshot = with_store(&state, |store| store.delete_session(&session_id))?;
    sync_api_server_authorization_cache(&state, &snapshot).await;
    drop(_mutation_guard);
    state
        .remote
        .shutdown_session_connections(&app, &session_id)
        .await;
    drop(config_guard);
    drop(tunnel_guard);
    drop(api_guard);
    reconcile_api_server_with_snapshot(&app, &state).await;
    crate::events::emit(&app, crate::events::CONFIG_CHANGED, snapshot.clone());
    Ok(snapshot)
}

fn session_connection_config_changed(
    previous: &crate::config::SessionConfig,
    current: &crate::config::SessionConfig,
) -> bool {
    previous.host != current.host
        || previous.port != current.port
        || previous.username != current.username
        || previous.auth != current.auth
        || previous.ssh != current.ssh
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(input: SessionInput) -> crate::config::SessionConfig {
        crate::config::SessionConfig::new(input)
    }

    fn input() -> SessionInput {
        SessionInput {
            name: "节点".to_string(),
            group_id: None,
            host: "10.0.0.1".to_string(),
            port: 22,
            username: "root".to_string(),
            auth: crate::config::AuthConfig::password(Some("secret".to_string())),
            ssh: crate::config::SshOptions::default(),
            default_path: "/srv".to_string(),
            tags: vec!["prod".to_string()],
            note: Some("note".to_string()),
            terminal: crate::config::TerminalOptions::default(),
            sftp: crate::config::SftpOptions::default(),
        }
    }

    #[test]
    fn connection_changes_only_for_transport_relevant_fields() {
        let previous = session(input());

        let mut cosmetic = previous.clone();
        cosmetic.name = "新名称".to_string();
        cosmetic.default_path = "/opt".to_string();
        cosmetic.tags.push("blue".to_string());
        cosmetic.note = None;
        cosmetic.terminal.theme = "solarized".to_string();
        cosmetic.sftp.show_hidden = !cosmetic.sftp.show_hidden;
        assert!(!session_connection_config_changed(&previous, &cosmetic));

        let mut host = previous.clone();
        host.host = "10.0.0.2".to_string();
        assert!(session_connection_config_changed(&previous, &host));

        let mut port = previous.clone();
        port.port = 2222;
        assert!(session_connection_config_changed(&previous, &port));

        let mut username = previous.clone();
        username.username = "admin".to_string();
        assert!(session_connection_config_changed(&previous, &username));

        let mut auth = previous.clone();
        auth.auth = crate::config::AuthConfig::password(Some("changed".to_string()));
        assert!(session_connection_config_changed(&previous, &auth));

        let mut ssh = previous.clone();
        ssh.ssh.connect_timeout_ms += 1_000;
        assert!(session_connection_config_changed(&previous, &ssh));
    }
}

#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<ConnectionInfo> {
    connect_session_new(&app, &state, &session_id).await
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
pub async fn ssh_trust_host_key(
    state: State<'_, AppState>,
    session_id: String,
    host: String,
    port: u16,
    algorithm: String,
    fingerprint: String,
) -> AppResult<ConfigSnapshot> {
    let ticket = state.config_mutations.ticket();
    let _mutation_guard = state.config_mutations.lock(ticket).await?;
    with_store(&state, |store| {
        store.trust_host_key(&session_id, &host, port, algorithm, fingerprint)
    })
}
