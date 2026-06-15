use super::*;

impl RemoteRuntime {
    pub async fn forward_start_local(
        &self,
        app: &AppHandle,
        options: ForwardLocalOptions,
    ) -> AppResult<ForwardInfo> {
        let connection = self.connection(&options.connection_id).await?;
        let listener = TcpListener::bind((options.bind_host.as_str(), options.bind_port))
            .await
            .map_err(remote_error)?;
        let actual_port = listener.local_addr().map_err(remote_error)?.port();
        let info = ForwardInfo {
            forward_id: Uuid::new_v4().to_string(),
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
        let handle = connection.handle.clone();
        let remote_host = options.remote_host;
        let remote_port = options.remote_port;
        let task = tokio::spawn(async move {
            events::emit(&app_handle, events::FORWARD_STATUS, event_info.clone());
            loop {
                match listener.accept().await {
                    Ok((stream, _)) => {
                        let handle = handle.clone();
                        let host = remote_host.clone();
                        tokio::spawn(async move {
                            if let Err(error) =
                                pipe_local_to_ssh(stream, handle, host.clone(), remote_port).await
                            {
                                eprintln!(
                                    "[helm] local forward connection failed: {host}:{remote_port}: {error}"
                                );
                            }
                        });
                    }
                    Err(error) => {
                        let mut failed = event_info.clone();
                        failed.status = TaskStatus::Failed;
                        failed.error = Some(error.to_string());
                        events::emit(&app_handle, events::FORWARD_STATUS, failed);
                        break;
                    }
                }
            }
        });
        self.forwards.write().await.insert(
            info.forward_id.clone(),
            ForwardRecord {
                info: info.clone(),
                handle: Some(task),
            },
        );
        Ok(info)
    }

    pub async fn forward_start_dynamic(
        &self,
        app: &AppHandle,
        session_id: String,
        connection_id: String,
        bind_host: String,
        bind_port: u16,
    ) -> AppResult<ForwardInfo> {
        let connection = self.connection(&connection_id).await?;
        let listener = TcpListener::bind((bind_host.as_str(), bind_port))
            .await
            .map_err(remote_error)?;
        let actual_port = listener.local_addr().map_err(remote_error)?.port();
        let info = ForwardInfo {
            forward_id: Uuid::new_v4().to_string(),
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
        let handle = connection.handle.clone();
        let task = tokio::spawn(async move {
            events::emit(&app_handle, events::FORWARD_STATUS, event_info.clone());
            loop {
                match listener.accept().await {
                    Ok((stream, _)) => {
                        let handle = handle.clone();
                        tokio::spawn(async move {
                            if let Err(error) = handle_socks5(stream, handle).await {
                                eprintln!("[helm] dynamic forward connection failed: {error}");
                            }
                        });
                    }
                    Err(error) => {
                        let mut failed = event_info.clone();
                        failed.status = TaskStatus::Failed;
                        failed.error = Some(error.to_string());
                        events::emit(&app_handle, events::FORWARD_STATUS, failed);
                        break;
                    }
                }
            }
        });
        self.forwards.write().await.insert(
            info.forward_id.clone(),
            ForwardRecord {
                info: info.clone(),
                handle: Some(task),
            },
        );
        Ok(info)
    }

    pub async fn forward_start_remote(
        &self,
        app: &AppHandle,
        options: ForwardRemoteOptions,
    ) -> AppResult<ForwardInfo> {
        let connection = self.connection(&options.connection_id).await?;
        let target = RemoteForwardTarget {
            local_host: options.local_host,
            local_port: options.local_port,
        };
        connection.remote_forwards.write().await.insert(
            forward_key(&options.remote_bind_host, options.remote_bind_port),
            target.clone(),
        );
        let assigned_port = {
            let handle = connection.handle.lock().await;
            handle
                .tcpip_forward(
                    options.remote_bind_host.clone(),
                    options.remote_bind_port as u32,
                )
                .await
                .map_err(remote_error)? as u16
        };
        if assigned_port != options.remote_bind_port {
            let mut forwards = connection.remote_forwards.write().await;
            forwards.remove(&forward_key(
                &options.remote_bind_host,
                options.remote_bind_port,
            ));
            forwards.insert(
                forward_key(&options.remote_bind_host, assigned_port),
                target.clone(),
            );
        }
        let info = ForwardInfo {
            forward_id: Uuid::new_v4().to_string(),
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
        events::emit(app, events::FORWARD_STATUS, info.clone());
        self.forwards.write().await.insert(
            info.forward_id.clone(),
            ForwardRecord {
                info: info.clone(),
                handle: None,
            },
        );
        Ok(info)
    }

    pub async fn forward_stop(&self, app: &AppHandle, forward_id: &str) -> AppResult<()> {
        let mut record = self
            .forwards
            .write()
            .await
            .remove(forward_id)
            .ok_or_else(|| AppError::missing_forward(forward_id))?;
        if let Some(handle) = record.handle.take() {
            handle.abort();
        }
        if matches!(record.info.forward_type, ForwardType::Remote) {
            if let Some(connection) = self
                .find_connection_by_session(&record.info.session_id)
                .await
            {
                let cancel_error = {
                    let handle = connection.handle.lock().await;
                    handle
                        .cancel_tcpip_forward(
                            record.info.bind_host.clone(),
                            record.info.bind_port as u32,
                        )
                        .await
                        .err()
                        .map(|error| error.to_string())
                };
                if let Some(error) = cancel_error {
                    record.info.error = Some(error);
                }
                connection
                    .remote_forwards
                    .write()
                    .await
                    .remove(&forward_key(&record.info.bind_host, record.info.bind_port));
            }
        }
        record.info.status = TaskStatus::Canceled;
        events::emit(app, events::FORWARD_STATUS, record.info);
        Ok(())
    }

    pub async fn forward_list(&self) -> Vec<ForwardInfo> {
        self.forwards
            .read()
            .await
            .values()
            .map(|record| record.info.clone())
            .collect()
    }
    pub(super) async fn cancel_forwards_for_session(
        &self,
        app: &AppHandle,
        session_id: &str,
        connection: Option<&ConnectionRecord>,
    ) {
        let forward_ids: Vec<String> = self
            .forwards
            .read()
            .await
            .iter()
            .filter(|(_, record)| record.info.session_id == session_id)
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
                if let Some(connection) = connection {
                    let handle = connection.handle.lock().await;
                    if let Err(error) = handle
                        .cancel_tcpip_forward(
                            record.info.bind_host.clone(),
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
            }
            cancel_forward_record(app, record).await;
        }
    }
}
