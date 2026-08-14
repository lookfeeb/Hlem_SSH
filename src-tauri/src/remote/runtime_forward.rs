use super::runtime_registry::shared_operation_lock;
use super::*;

impl RemoteRuntime {
    pub async fn forward_start_for_tunnel(
        &self,
        app: &AppHandle,
        tunnel: &crate::config::TunnelConfig,
        origin: ConnectionOrigin,
    ) -> AppResult<ForwardInfo> {
        let connection_id = self
            .find_connection_for_session(&tunnel.session_id, origin)
            .await
            .map_err(AppError::Remote)?;
        match tunnel.forward_type.as_str() {
            "local" => {
                self.forward_start_local(
                    app,
                    ForwardLocalOptions {
                        tunnel_id: Some(tunnel.id.clone()),
                        session_id: tunnel.session_id.clone(),
                        connection_id,
                        bind_host: tunnel.bind_host.clone(),
                        bind_port: tunnel.bind_port,
                        remote_host: tunnel.target_host.clone(),
                        remote_port: tunnel.target_port,
                    },
                )
                .await
            }
            "remote" => {
                self.forward_start_remote(
                    app,
                    ForwardRemoteOptions {
                        tunnel_id: Some(tunnel.id.clone()),
                        session_id: tunnel.session_id.clone(),
                        connection_id,
                        remote_bind_host: tunnel.bind_host.clone(),
                        remote_bind_port: tunnel.bind_port,
                        local_host: tunnel.target_host.clone(),
                        local_port: tunnel.target_port,
                    },
                )
                .await
            }
            "dynamic" => {
                self.forward_start_dynamic(
                    app,
                    tunnel.session_id.clone(),
                    connection_id,
                    tunnel.bind_host.clone(),
                    tunnel.bind_port,
                    Some(tunnel.id.clone()),
                )
                .await
            }
            other => Err(AppError::InvalidInput(format!("不支持的隧道类型: {other}"))),
        }
    }

    pub async fn forward_start_local(
        &self,
        app: &AppHandle,
        options: ForwardLocalOptions,
    ) -> AppResult<ForwardInfo> {
        let connection = self.connection(&options.connection_id).await?;
        ensure_connection_session(&connection, &options.session_id)?;
        if let Some(tunnel_id) = options.tunnel_id.clone() {
            let tunnel_lock = self.tunnel_forward_lock(&tunnel_id).await;
            let _tunnel_guard = tunnel_lock.lock().await;
            if let Some(existing) = self.forward_for_tunnel(&tunnel_id, connection.origin).await {
                return Ok(existing);
            }
            return self.forward_start_local_unlocked(app, options).await;
        }
        self.forward_start_local_unlocked(app, options).await
    }

    async fn forward_start_local_unlocked(
        &self,
        app: &AppHandle,
        options: ForwardLocalOptions,
    ) -> AppResult<ForwardInfo> {
        let _lifecycle_guard = self.lifecycle_gate.read().await;
        let connection = self.connection(&options.connection_id).await?;
        ensure_connection_session(&connection, &options.session_id)?;
        let connection_id = options.connection_id.clone();
        let listener = TcpListener::bind((options.bind_host.as_str(), options.bind_port))
            .await
            .map_err(remote_error)?;
        let actual_port = listener.local_addr().map_err(remote_error)?.port();
        let info = ForwardInfo {
            forward_id: Uuid::new_v4().to_string(),
            tunnel_id: options.tunnel_id.clone(),
            session_id: options.session_id,
            forward_type: ForwardType::Local,
            bind_host: options.bind_host,
            bind_port: actual_port,
            target_host: options.remote_host.clone(),
            target_port: options.remote_port,
            status: TaskStatus::Running,
            started_at: now(),
            error: None,
        };
        let app_handle = app.clone();
        let event_info = info.clone();
        let origin = connection.origin;
        let handle = connection.handle.clone();
        let remote_host = options.remote_host;
        let remote_port = options.remote_port;
        let forwards = self.forwards.clone();
        let forward_id = info.forward_id.clone();
        let child_tasks = Arc::new(ForwardChildTasks::default());
        let task_child_tasks = child_tasks.clone();
        let (start_tx, start_rx) = oneshot::channel();
        let task = tokio::spawn(async move {
            if start_rx.await.is_err() {
                return;
            }
            if origin.notifies_desktop() {
                events::emit(&app_handle, events::FORWARD_STATUS, event_info.clone());
            }
            loop {
                match listener.accept().await {
                    Ok((stream, _)) => {
                        let handle = handle.clone();
                        let host = remote_host.clone();
                        let child = tokio::spawn(async move {
                            if let Err(error) =
                                pipe_local_to_ssh(stream, handle, host.clone(), remote_port).await
                            {
                                eprintln!(
                                    "[helm] local forward connection failed: {host}:{remote_port}: {error}"
                                );
                            }
                        });
                        task_child_tasks.register(child);
                    }
                    Err(error) => {
                        mark_forward_failed(&forwards, &app_handle, &forward_id, error.to_string())
                            .await;
                        break;
                    }
                }
            }
        });
        let record = ForwardRecord {
            connection_id: connection_id.clone(),
            origin,
            info: info.clone(),
            handle: Some(task),
            child_tasks,
        };
        let connections = self.connections.read().await;
        if !connections.contains_key(&connection_id) {
            drop(connections);
            cancel_forward_record(app, record).await;
            return Err(AppError::missing_connection(&connection_id));
        }
        self.forwards
            .write()
            .await
            .insert(info.forward_id.clone(), record);
        drop(connections);
        if start_tx.send(()).is_err() {
            let record = self.forwards.write().await.remove(&info.forward_id);
            if let Some(record) = record {
                cancel_forward_record(app, record).await;
            }
            return Err(AppError::Remote("本地端口转发任务启动失败".to_string()));
        }
        Ok(info)
    }

    pub async fn forward_start_dynamic(
        &self,
        app: &AppHandle,
        session_id: String,
        connection_id: String,
        bind_host: String,
        bind_port: u16,
        tunnel_id: Option<String>,
    ) -> AppResult<ForwardInfo> {
        let connection = self.connection(&connection_id).await?;
        ensure_connection_session(&connection, &session_id)?;
        if let Some(tunnel_id) = tunnel_id.clone() {
            let tunnel_lock = self.tunnel_forward_lock(&tunnel_id).await;
            let _tunnel_guard = tunnel_lock.lock().await;
            if let Some(existing) = self.forward_for_tunnel(&tunnel_id, connection.origin).await {
                return Ok(existing);
            }
            return self
                .forward_start_dynamic_unlocked(
                    app,
                    session_id,
                    connection_id,
                    bind_host,
                    bind_port,
                    Some(tunnel_id),
                )
                .await;
        }
        self.forward_start_dynamic_unlocked(
            app,
            session_id,
            connection_id,
            bind_host,
            bind_port,
            None,
        )
        .await
    }

    async fn forward_start_dynamic_unlocked(
        &self,
        app: &AppHandle,
        session_id: String,
        connection_id: String,
        bind_host: String,
        bind_port: u16,
        tunnel_id: Option<String>,
    ) -> AppResult<ForwardInfo> {
        let _lifecycle_guard = self.lifecycle_gate.read().await;
        let connection = self.connection(&connection_id).await?;
        ensure_connection_session(&connection, &session_id)?;
        let parent_connection_id = connection_id.clone();
        let listener = TcpListener::bind((bind_host.as_str(), bind_port))
            .await
            .map_err(remote_error)?;
        let actual_port = listener.local_addr().map_err(remote_error)?.port();
        let info = ForwardInfo {
            forward_id: Uuid::new_v4().to_string(),
            tunnel_id: tunnel_id.clone(),
            session_id,
            forward_type: ForwardType::Dynamic,
            bind_host,
            bind_port: actual_port,
            target_host: "SOCKS5".to_string(),
            target_port: 0,
            status: TaskStatus::Running,
            started_at: now(),
            error: None,
        };
        let app_handle = app.clone();
        let event_info = info.clone();
        let origin = connection.origin;
        let handle = connection.handle.clone();
        let forwards = self.forwards.clone();
        let forward_id = info.forward_id.clone();
        let child_tasks = Arc::new(ForwardChildTasks::default());
        let task_child_tasks = child_tasks.clone();
        let (start_tx, start_rx) = oneshot::channel();
        let task = tokio::spawn(async move {
            if start_rx.await.is_err() {
                return;
            }
            if origin.notifies_desktop() {
                events::emit(&app_handle, events::FORWARD_STATUS, event_info.clone());
            }
            loop {
                match listener.accept().await {
                    Ok((stream, _)) => {
                        let handle = handle.clone();
                        let child = tokio::spawn(async move {
                            if let Err(error) = handle_socks5(stream, handle).await {
                                eprintln!("[helm] dynamic forward connection failed: {error}");
                            }
                        });
                        task_child_tasks.register(child);
                    }
                    Err(error) => {
                        mark_forward_failed(&forwards, &app_handle, &forward_id, error.to_string())
                            .await;
                        break;
                    }
                }
            }
        });
        let record = ForwardRecord {
            connection_id: parent_connection_id.clone(),
            origin,
            info: info.clone(),
            handle: Some(task),
            child_tasks,
        };
        let connections = self.connections.read().await;
        if !connections.contains_key(&parent_connection_id) {
            drop(connections);
            cancel_forward_record(app, record).await;
            return Err(AppError::missing_connection(&parent_connection_id));
        }
        self.forwards
            .write()
            .await
            .insert(info.forward_id.clone(), record);
        drop(connections);
        if start_tx.send(()).is_err() {
            let record = self.forwards.write().await.remove(&info.forward_id);
            if let Some(record) = record {
                cancel_forward_record(app, record).await;
            }
            return Err(AppError::Remote("动态端口转发任务启动失败".to_string()));
        }
        Ok(info)
    }

    pub async fn forward_start_remote(
        &self,
        app: &AppHandle,
        options: ForwardRemoteOptions,
    ) -> AppResult<ForwardInfo> {
        let connection = self.connection(&options.connection_id).await?;
        ensure_connection_session(&connection, &options.session_id)?;
        if let Some(tunnel_id) = options.tunnel_id.clone() {
            let tunnel_lock = self.tunnel_forward_lock(&tunnel_id).await;
            let _tunnel_guard = tunnel_lock.lock().await;
            if let Some(existing) = self.forward_for_tunnel(&tunnel_id, connection.origin).await {
                return Ok(existing);
            }
            return self.forward_start_remote_unlocked(app, options).await;
        }
        self.forward_start_remote_unlocked(app, options).await
    }

    async fn forward_start_remote_unlocked(
        &self,
        app: &AppHandle,
        options: ForwardRemoteOptions,
    ) -> AppResult<ForwardInfo> {
        let _lifecycle_guard = self.lifecycle_gate.read().await;
        let connection = self.connection(&options.connection_id).await?;
        ensure_connection_session(&connection, &options.session_id)?;
        let requested_key = forward_key(&options.remote_bind_host, options.remote_bind_port);
        let forward_lock = self
            .remote_forward_lock(&format!("{}:{requested_key}", options.connection_id))
            .await;
        let _forward_guard = forward_lock.lock().await;
        let duplicate = {
            let forwards = self.forwards.read().await;
            has_active_remote_forward(
                &forwards,
                &options.connection_id,
                &options.remote_bind_host,
                options.remote_bind_port,
            )
        };
        if duplicate {
            return Err(AppError::InvalidInput(
                "该连接上的远程监听地址已存在".to_string(),
            ));
        }
        let connection_id = options.connection_id.clone();
        let child_tasks = Arc::new(ForwardChildTasks::default());
        let target = RemoteForwardTarget {
            local_host: options.local_host,
            local_port: options.local_port,
            child_tasks: child_tasks.clone(),
        };
        connection
            .remote_forwards
            .write()
            .await
            .insert(requested_key.clone(), target.clone());
        let assigned_port_result = request_remote_forward(
            &connection.handle,
            &options.remote_bind_host,
            options.remote_bind_port as u32,
        )
        .await;
        let assigned_port = match assigned_port_result {
            Ok(port) => match normalize_remote_forward_port(options.remote_bind_port, port) {
                Ok(port) => port,
                Err(error) => {
                    connection
                        .remote_forwards
                        .write()
                        .await
                        .remove(&requested_key);
                    if port != 0 {
                        let _ = cancel_remote_forward(
                            &connection.handle,
                            &options.remote_bind_host,
                            port,
                        )
                        .await;
                    }
                    return Err(error);
                }
            },
            Err(error) => {
                connection
                    .remote_forwards
                    .write()
                    .await
                    .remove(&requested_key);
                return Err(remote_error(error));
            }
        };
        if assigned_port != options.remote_bind_port {
            let mut forwards = connection.remote_forwards.write().await;
            forwards.remove(&requested_key);
            forwards.insert(
                forward_key(&options.remote_bind_host, assigned_port),
                target.clone(),
            );
        }
        let info = ForwardInfo {
            forward_id: Uuid::new_v4().to_string(),
            tunnel_id: options.tunnel_id.clone(),
            session_id: options.session_id,
            forward_type: ForwardType::Remote,
            bind_host: options.remote_bind_host,
            bind_port: assigned_port,
            target_host: "local".to_string(),
            target_port: target.local_port,
            status: TaskStatus::Running,
            started_at: now(),
            error: None,
        };
        let record = ForwardRecord {
            connection_id: connection_id.clone(),
            origin: connection.origin,
            info: info.clone(),
            handle: None,
            child_tasks,
        };
        let connections = self.connections.read().await;
        if !connections.contains_key(&connection_id) {
            drop(connections);
            let _ =
                cancel_remote_forward(&connection.handle, &info.bind_host, info.bind_port as u32)
                    .await;
            connection
                .remote_forwards
                .write()
                .await
                .remove(&forward_key(&info.bind_host, info.bind_port));
            cancel_forward_record(app, record).await;
            return Err(AppError::missing_connection(&connection_id));
        }
        self.forwards
            .write()
            .await
            .insert(info.forward_id.clone(), record);
        drop(connections);
        if connection.origin.notifies_desktop() {
            events::emit(app, events::FORWARD_STATUS, info.clone());
        }
        Ok(info)
    }

    pub async fn forward_stop_for_origin(
        &self,
        app: &AppHandle,
        forward_id: &str,
        origin: ConnectionOrigin,
    ) -> AppResult<()> {
        let tunnel_id = self
            .forwards
            .read()
            .await
            .get(forward_id)
            .filter(|record| record.origin == origin)
            .and_then(|record| record.info.tunnel_id.clone());
        let tunnel_lock = match tunnel_id.as_deref() {
            Some(tunnel_id) => Some(self.tunnel_forward_lock(tunnel_id).await),
            None => None,
        };
        let _tunnel_guard = match tunnel_lock.as_ref() {
            Some(lock) => Some(lock.lock().await),
            None => None,
        };
        if !self
            .forward_stop_if_present(app, forward_id, Some(origin))
            .await?
        {
            return Err(AppError::missing_forward(forward_id));
        }
        Ok(())
    }

    async fn forward_stop_if_present(
        &self,
        app: &AppHandle,
        forward_id: &str,
        expected_origin: Option<ConnectionOrigin>,
    ) -> AppResult<bool> {
        let Some(mut record) = ({
            let mut forwards = self.forwards.write().await;
            let matches_origin = forwards
                .get(forward_id)
                .is_some_and(|record| expected_origin.is_none_or(|origin| record.origin == origin));
            matches_origin
                .then(|| forwards.remove(forward_id))
                .flatten()
        }) else {
            return Ok(false);
        };
        if matches!(record.info.forward_type, ForwardType::Remote) {
            let remote_key = format!(
                "{}:{}",
                record.connection_id,
                forward_key(&record.info.bind_host, record.info.bind_port)
            );
            let forward_lock = self.remote_forward_lock(&remote_key).await;
            let _forward_guard = forward_lock.lock().await;
            if let Some(connection) = self
                .connections
                .read()
                .await
                .get(&record.connection_id)
                .cloned()
            {
                let cancel_error = cancel_remote_forward(
                    &connection.handle,
                    &record.info.bind_host,
                    record.info.bind_port as u32,
                )
                .await
                .err()
                .map(|error| error.to_string());
                if let Some(error) = cancel_error {
                    record.info.error = Some(error);
                    record.info.status = TaskStatus::Failed;
                    let failed = record.info.clone();
                    let notify_desktop = record.origin.notifies_desktop();
                    self.forwards
                        .write()
                        .await
                        .insert(forward_id.to_string(), record);
                    if notify_desktop {
                        events::emit(app, events::FORWARD_STATUS, failed);
                    }
                    return Err(AppError::Remote(
                        "取消远程端口转发失败，可重试停止".to_string(),
                    ));
                }
                connection
                    .remote_forwards
                    .write()
                    .await
                    .remove(&forward_key(&record.info.bind_host, record.info.bind_port));
            }
        }
        cancel_forward_record(app, record).await;
        Ok(true)
    }

    pub async fn forward_list(&self) -> Vec<ForwardInfo> {
        self.refresh_finished_forward_records().await;
        self.forwards
            .read()
            .await
            .values()
            .filter(|record| record.origin == ConnectionOrigin::Desktop)
            .map(|record| record.info.clone())
            .collect()
    }

    pub async fn forward_for_tunnel(
        &self,
        tunnel_id: &str,
        origin: ConnectionOrigin,
    ) -> Option<ForwardInfo> {
        self.refresh_finished_forward_records().await;
        self.forwards
            .read()
            .await
            .values()
            .find(|record| {
                record.info.tunnel_id.as_deref() == Some(tunnel_id)
                    && record.origin == origin
                    && is_active_forward_status(&record.info.status)
            })
            .map(|record| record.info.clone())
    }

    async fn refresh_finished_forward_records(&self) {
        let mut forwards = self.forwards.write().await;
        for record in forwards.values_mut() {
            let unexpectedly_finished = is_active_forward_status(&record.info.status)
                && record.handle.as_ref().is_some_and(JoinHandle::is_finished);
            if unexpectedly_finished {
                record.info.status = TaskStatus::Failed;
                record
                    .info
                    .error
                    .get_or_insert_with(|| "端口转发任务已意外结束".to_string());
            }
        }
    }

    async fn tunnel_forward_lock(&self, tunnel_id: &str) -> Arc<Mutex<()>> {
        shared_operation_lock(&self.forward_locks, &format!("tunnel:{tunnel_id}")).await
    }

    async fn remote_forward_lock(&self, key: &str) -> Arc<Mutex<()>> {
        shared_operation_lock(&self.remote_forward_start_locks, key).await
    }

    pub async fn stop_forwards_for_tunnel(
        &self,
        app: &AppHandle,
        tunnel_id: &str,
    ) -> AppResult<usize> {
        self.stop_forwards_for_tunnel_inner(app, tunnel_id, None)
            .await
    }

    pub async fn stop_forwards_for_tunnel_origin(
        &self,
        app: &AppHandle,
        tunnel_id: &str,
        origin: ConnectionOrigin,
    ) -> AppResult<usize> {
        self.stop_forwards_for_tunnel_inner(app, tunnel_id, Some(origin))
            .await
    }

    async fn stop_forwards_for_tunnel_inner(
        &self,
        app: &AppHandle,
        tunnel_id: &str,
        origin: Option<ConnectionOrigin>,
    ) -> AppResult<usize> {
        let tunnel_lock = self.tunnel_forward_lock(tunnel_id).await;
        let _tunnel_guard = tunnel_lock.lock().await;
        let forward_ids = {
            let forwards = self.forwards.read().await;
            matching_forward_ids(&forwards, tunnel_id, origin)
        };
        let mut stopped = 0;
        for forward_id in &forward_ids {
            if self
                .forward_stop_if_present(app, forward_id, origin)
                .await?
            {
                stopped += 1;
            }
        }
        Ok(stopped)
    }

    pub(super) async fn cancel_forwards_for_connection(
        &self,
        app: &AppHandle,
        connection: &ConnectionRecord,
    ) {
        let connection_id = connection.info.connection_id.as_str();
        let forward_ids: Vec<String> = self
            .forwards
            .read()
            .await
            .iter()
            .filter(|(_, record)| record.connection_id == connection_id)
            .map(|(id, _)| id.clone())
            .collect();
        let mut records = Vec::new();
        let mut forwards = self.forwards.write().await;
        for id in forward_ids {
            if let Some(record) = forwards.remove(&id) {
                records.push(record);
            }
        }
        drop(forwards);

        for record in records {
            if matches!(record.info.forward_type, ForwardType::Remote) {
                if let Err(error) = cancel_remote_forward(
                    &connection.handle,
                    &record.info.bind_host,
                    record.info.bind_port as u32,
                )
                .await
                {
                    eprintln!(
                        "[helm] failed to cancel remote forward: {}:{}: {error}",
                        record.info.bind_host, record.info.bind_port
                    );
                }
                connection
                    .remote_forwards
                    .write()
                    .await
                    .remove(&forward_key(&record.info.bind_host, record.info.bind_port));
            }
            cancel_forward_record(app, record).await;
        }
    }
}

fn matching_forward_ids(
    forwards: &HashMap<String, ForwardRecord>,
    tunnel_id: &str,
    origin: Option<ConnectionOrigin>,
) -> Vec<String> {
    forwards
        .iter()
        .filter(|(_, record)| {
            record.info.tunnel_id.as_deref() == Some(tunnel_id)
                && origin.is_none_or(|origin| record.origin == origin)
        })
        .map(|(forward_id, _)| forward_id.clone())
        .collect()
}

fn ensure_connection_session(connection: &ConnectionRecord, session_id: &str) -> AppResult<()> {
    if connection.info.session_id == session_id {
        return Ok(());
    }
    Err(AppError::InvalidInput(
        "连接与会话不匹配，请重新连接".to_string(),
    ))
}

fn is_active_forward_status(status: &TaskStatus) -> bool {
    matches!(status, TaskStatus::Queued | TaskStatus::Running)
}

async fn mark_forward_failed(
    forwards: &RwLock<HashMap<String, ForwardRecord>>,
    app: &AppHandle,
    forward_id: &str,
    error: String,
) {
    let failed = {
        let mut forwards = forwards.write().await;
        let Some(record) = forwards.get_mut(forward_id) else {
            return;
        };
        if !is_active_forward_status(&record.info.status) {
            return;
        }
        record.info.status = TaskStatus::Failed;
        record.info.error = Some(error);
        (record.info.clone(), record.origin.notifies_desktop())
    };
    if failed.1 {
        events::emit(app, events::FORWARD_STATUS, failed.0);
    }
}

fn normalize_remote_forward_port(requested_port: u16, returned_port: u32) -> AppResult<u16> {
    // russh represents a successful fixed-port request with an empty SSH reply
    // as 0. Only an auto-port request must receive an explicit non-zero port.
    if returned_port == 0 {
        return if requested_port == 0 {
            Err(AppError::Remote(
                "SSH 服务器未返回自动分配的远程转发端口".to_string(),
            ))
        } else {
            Ok(requested_port)
        };
    }
    u16::try_from(returned_port).map_err(|_| {
        AppError::Remote(format!(
            "SSH 服务器返回了无效的远程转发端口: {returned_port}"
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_forward_record(
        forward_id: &str,
        tunnel_id: &str,
        origin: ConnectionOrigin,
    ) -> ForwardRecord {
        ForwardRecord {
            connection_id: format!("connection-{forward_id}"),
            origin,
            info: ForwardInfo {
                forward_id: forward_id.to_string(),
                tunnel_id: Some(tunnel_id.to_string()),
                session_id: "session-a".to_string(),
                forward_type: ForwardType::Local,
                bind_host: "127.0.0.1".to_string(),
                bind_port: 19880,
                target_host: "127.0.0.1".to_string(),
                target_port: 22,
                status: TaskStatus::Running,
                started_at: now(),
                error: None,
            },
            handle: None,
            child_tasks: Arc::new(ForwardChildTasks::default()),
        }
    }

    #[test]
    fn remote_forward_port_handles_fixed_and_auto_assignments() {
        assert_eq!(normalize_remote_forward_port(2200, 0).unwrap(), 2200);
        assert_eq!(normalize_remote_forward_port(0, 32000).unwrap(), 32000);
        assert!(normalize_remote_forward_port(0, 0).is_err());
        assert!(normalize_remote_forward_port(0, u16::MAX as u32 + 1).is_err());
    }

    #[test]
    fn tunnel_cleanup_can_be_scoped_to_connection_origin() {
        let forwards = HashMap::from([
            (
                "desktop-a".to_string(),
                test_forward_record("desktop-a", "tunnel-a", ConnectionOrigin::Desktop),
            ),
            (
                "automation-a".to_string(),
                test_forward_record("automation-a", "tunnel-a", ConnectionOrigin::Automation),
            ),
            (
                "automation-b".to_string(),
                test_forward_record("automation-b", "tunnel-b", ConnectionOrigin::Automation),
            ),
        ]);

        let mut desktop_ids =
            matching_forward_ids(&forwards, "tunnel-a", Some(ConnectionOrigin::Desktop));
        desktop_ids.sort();
        assert_eq!(desktop_ids, ["desktop-a"]);

        let mut automation_ids =
            matching_forward_ids(&forwards, "tunnel-a", Some(ConnectionOrigin::Automation));
        automation_ids.sort();
        assert_eq!(automation_ids, ["automation-a"]);

        let mut all_ids = matching_forward_ids(&forwards, "tunnel-a", None);
        all_ids.sort();
        assert_eq!(all_ids, ["automation-a", "desktop-a"]);
    }
}
