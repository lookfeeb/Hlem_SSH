use tauri::{AppHandle, Manager, State};

use super::{with_store, AppResult, AppState};
use crate::{
    config::{ConfigSnapshot, TunnelConfig},
    remote::ConnectionInfo,
};

/// Persist intent first: neither disconnect cleanup nor a failed restore disables a tunnel.
#[tauri::command]
pub async fn tunnel_set_enabled(
    app: AppHandle,
    state: State<'_, AppState>,
    tunnel_id: String,
    enabled: bool,
) -> AppResult<ConfigSnapshot> {
    let ticket = state.config_mutations.ticket();
    let _operation_guard = state.tunnel_operation.lock().await;
    let _config_guard = state.connection_config_gate.read().await;
    let mutation_guard = state.config_mutations.lock(ticket).await?;
    let snapshot = with_store(&state, |store| {
        store.set_tunnel_enabled(&tunnel_id, enabled)
    })?;
    drop(mutation_guard);
    crate::events::emit(&app, crate::events::CONFIG_CHANGED, snapshot.clone());
    if enabled {
        if let Some(tunnel) = snapshot
            .data
            .tunnels
            .iter()
            .find(|tunnel| tunnel.id == tunnel_id)
        {
            // Only reuse an existing desktop SSH connection. Enabling never connects SSH.
            if let Some(connection) = state
                .remote
                .connection_list()
                .await
                .into_iter()
                .find(|connection| connection.session_id == tunnel.session_id)
            {
                restore_tunnel(&app, &state, tunnel, &connection.connection_id).await?;
            }
        }
    } else {
        state
            .remote
            .stop_forwards_for_tunnel(&app, &tunnel_id)
            .await?;
    }
    // Runtime work can take time; return the latest config, not a stale snapshot.
    with_store(&state, |store| store.snapshot())
}

/// Called only after the desktop's explicit SSH connect command has succeeded.
pub(super) fn spawn_tunnel_restore(app: AppHandle, connection: ConnectionInfo) {
    // Remote forwarding can be slow. Do not hold up SSH connection completion.
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        if let Err(error) = restore_tunnels_after_connect(&app, &state, &connection).await {
            log::warn!("Failed to restore tunnels after SSH connect: {error}");
        }
    });
}

async fn restore_tunnels_after_connect(
    app: &AppHandle,
    state: &State<'_, AppState>,
    connection: &ConnectionInfo,
) -> AppResult<()> {
    let _operation_guard = state.tunnel_operation.lock().await;
    let _config_guard = state.connection_config_gate.read().await;
    if !state
        .remote
        .connection_list()
        .await
        .iter()
        .any(|current| current.connection_id == connection.connection_id)
    {
        return Ok(());
    }
    let tunnels = with_store(state, |store| store.tunnels())?;
    for tunnel in tunnels
        .iter()
        .filter(|tunnel| should_restore_tunnel(tunnel, &connection.session_id))
    {
        if let Err(error) = restore_tunnel(app, state, tunnel, &connection.connection_id).await {
            // A failed listener must not turn a successful SSH connection into a failure
            // or prevent other enabled tunnels from being restored.
            log::warn!("Failed to restore tunnel {}: {error}", tunnel.id);
        }
    }
    Ok(())
}

fn should_restore_tunnel(tunnel: &TunnelConfig, session_id: &str) -> bool {
    tunnel.enabled && tunnel.session_id == session_id
}

pub(super) async fn restore_tunnel(
    app: &AppHandle,
    state: &State<'_, AppState>,
    tunnel: &TunnelConfig,
    connection_id: &str,
) -> AppResult<()> {
    if state
        .remote
        .desktop_forward_for_tunnel(&tunnel.id)
        .await
        .is_some()
    {
        return Ok(());
    }
    // Remove old failed records before retrying. A failed remote cancellation is
    // retained by the runtime and must be resolved before opening another listener.
    state
        .remote
        .stop_forwards_for_tunnel(app, &tunnel.id)
        .await?;
    if let Err(error) = state
        .remote
        .forward_start_for_tunnel_on_connection(app, tunnel, connection_id.to_string())
        .await
    {
        state
            .remote
            .record_tunnel_start_failure(app, tunnel, connection_id, error.to_string())
            .await;
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{AuthConfig, SessionInput, TunnelInput};
    use crate::vault::VAULT_FILE_NAME;

    #[tokio::test]
    async fn restart_keeps_tunnels_dormant_and_restoration_scoped_to_bound_ssh() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(VAULT_FILE_NAME);
        let state = AppState::new(path.clone());
        state.initialize_vault().await.unwrap();
        let session_id;
        {
            let mut store = state.vault.lock().unwrap();
            let snapshot = store
                .create_session(SessionInput {
                    name: "SSH".into(),
                    group_id: None,
                    host: "127.0.0.1".into(),
                    port: 22,
                    username: "test".into(),
                    auth: AuthConfig::password(None),
                    ssh: Default::default(),
                    default_path: String::new(),
                    tags: vec![],
                    note: None,
                    terminal: Default::default(),
                    sftp: Default::default(),
                })
                .unwrap();
            session_id = snapshot.data.sessions[0].id.clone();
            for (name, enabled) in [("remembered", true), ("stopped", false)] {
                let snapshot = store
                    .create_tunnel(TunnelInput {
                        name: name.into(),
                        session_id: session_id.clone(),
                        forward_type: "local".into(),
                        bind_host: "127.0.0.1".into(),
                        bind_port: 13389,
                        target_host: "192.168.153.10".into(),
                        target_port: 3389,
                    })
                    .unwrap();
                let tunnel_id = snapshot.data.tunnels.last().unwrap().id.clone();
                store.set_tunnel_enabled(&tunnel_id, enabled).unwrap();
            }
        }
        drop(state);

        let restarted = AppState::new(path);
        restarted.initialize_vault().await.unwrap();
        assert!(restarted.remote.connection_list().await.is_empty());
        assert!(restarted.remote.forward_list().await.is_empty());
        let tunnels = restarted.vault.lock().unwrap().tunnels().unwrap();
        let eligible: Vec<_> = tunnels
            .iter()
            .filter(|tunnel| should_restore_tunnel(tunnel, &session_id))
            .map(|tunnel| tunnel.name.as_str())
            .collect();
        assert_eq!(eligible, ["remembered"]);
        assert!(!tunnels
            .iter()
            .any(|tunnel| should_restore_tunnel(tunnel, "another-ssh")));
    }
}
