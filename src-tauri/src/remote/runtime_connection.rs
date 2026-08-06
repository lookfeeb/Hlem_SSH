use super::*;

impl RemoteRuntime {
    pub fn connect(
        &self,
        app: &AppHandle,
        session: SessionConfig,
        trusted: Option<KnownHostEntry>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = AppResult<ConnectionInfo>> + Send + '_>>
    {
        let app = app.clone();
        let this = self.clone();
        Box::pin(async move { this.connect_inner(&app, session, trusted, true, true).await })
    }

    pub fn connect_new(
        &self,
        app: &AppHandle,
        session: SessionConfig,
        trusted: Option<KnownHostEntry>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = AppResult<ConnectionInfo>> + Send + '_>>
    {
        let app = app.clone();
        let this = self.clone();
        Box::pin(async move {
            this.connect_inner(&app, session, trusted, false, true)
                .await
        })
    }

    pub(super) fn connect_automation(
        &self,
        app: &AppHandle,
        session: SessionConfig,
        trusted: Option<KnownHostEntry>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = AppResult<ConnectionInfo>> + Send + '_>>
    {
        let app = app.clone();
        let this = self.clone();
        Box::pin(async move {
            this.connect_inner(&app, session, trusted, true, false)
                .await
        })
    }

    async fn connect_inner(
        &self,
        app: &AppHandle,
        session: SessionConfig,
        trusted: Option<KnownHostEntry>,
        reuse_existing: bool,
        notify_ui: bool,
    ) -> AppResult<ConnectionInfo> {
        let connection_started = Instant::now();
        let session_lock = self.connection_lock(&session.id).await;
        let _session_guard = session_lock.lock().await;
        let lock_wait_ms = connection_started.elapsed().as_millis();
        if reuse_existing {
            if let Some(existing) = self.find_connection_by_session(&session.id).await {
                log::info!(
                    "SSH connection reused: session={} host={} lock_wait_ms={} total_ms={}",
                    session.name,
                    session.host,
                    lock_wait_ms,
                    connection_started.elapsed().as_millis()
                );
                return Ok(existing.info);
            }
        }

        let connection_id = Uuid::new_v4().to_string();
        let remote_forwards = Arc::new(RwLock::new(HashMap::new()));
        let verification = HostKeyVerification {
            session_id: session.id.clone(),
            host: session.host.clone(),
            port: session.port,
            algorithm: String::new(),
            fingerprint: String::new(),
            expected_fingerprint: trusted
                .as_ref()
                .map(|entry| entry.fingerprint.clone())
                .or_else(|| session.ssh.host_key_fingerprint.clone()),
        };
        let trusted = trusted.or_else(|| {
            session
                .ssh
                .host_key_fingerprint
                .as_ref()
                .map(|fingerprint| KnownHostEntry {
                    host: session.host.clone(),
                    port: session.port,
                    algorithm: String::new(),
                    fingerprint: fingerprint.clone(),
                    trusted_at: String::new(),
                })
        });
        let observed = Arc::new(StdMutex::new(None));
        let diagnostics = Arc::new(StdMutex::new(RemoteClientDiagnostics::default()));
        let client = RemoteClient {
            verification: verification.clone(),
            trusted,
            observed: observed.clone(),
            remote_forwards: remote_forwards.clone(),
            diagnostics: diagnostics.clone(),
        };
        let connection_route = if session.ssh.proxy.is_some() {
            "proxy"
        } else {
            "direct"
        };
        log::info!(
            "SSH connecting: session={} host={} port={} user={} route={}",
            session.name,
            session.host,
            session.port,
            session.username,
            connection_route
        );
        if notify_ui {
            events::emit(
                app,
                events::SSH_STATUS,
                ConnectionInfo {
                    connection_id: connection_id.clone(),
                    session_id: session.id.clone(),
                    host: session.host.clone(),
                    port: session.port,
                    username: session.username.clone(),
                    status: RuntimeStatus::Connecting,
                    connected_at: now(),
                    disconnect_reason: None,
                },
            );
        }

        // inactivity_timeout 交给 keepalive 机制统一判断，避免空闲但健康的连接被提前回收。
        let config = client::Config {
            inactivity_timeout: None,
            keepalive_interval: Some(Duration::from_secs(
                session.ssh.keepalive_interval_sec.max(1) as u64,
            )),
            keepalive_max: 3,
            nodelay: true,
            window_size: 16 * 1024 * 1024,
            maximum_packet_size: 65535,
            channel_buffer_size: 256,
            ..Default::default()
        };
        let connect_timeout = Duration::from_millis(session.ssh.connect_timeout_ms.max(1_000));
        let server_host = session.host.clone();
        let server_port = session.port;
        let proxy = session.ssh.proxy.clone();
        let config = Arc::new(config);
        let observed_for_connect = observed.clone();
        let diagnostics_for_connect = diagnostics.clone();
        let session_name_for_connect = session.name.clone();
        let server_host_for_log = server_host.clone();
        let (mut handle, successful_attempt, tcp_ms, handshake_ms) = match timeout(connect_timeout, async move {
            for attempt in 1..=2 {
                if attempt > 1 {
                    tokio::time::sleep(Duration::from_millis(150)).await;
                }

                if let Ok(mut guard) = observed_for_connect.lock() {
                    *guard = None;
                }
                if let Ok(mut guard) = diagnostics_for_connect.lock() {
                    *guard = RemoteClientDiagnostics::default();
                }

                let attempt_started = Instant::now();
                let tcp_started = Instant::now();
                let socket =
                    connect_tcp_for_ssh(&server_host, server_port, proxy.as_ref()).await?;
                let tcp_ms = tcp_started.elapsed().as_millis();
                let local_address = socket
                    .local_addr()
                    .map(|address| address.to_string())
                    .unwrap_or_else(|error| format!("unknown ({error})"));
                let peer_address = socket
                    .peer_addr()
                    .map(|address| address.to_string())
                    .unwrap_or_else(|error| format!("unknown ({error})"));
                log::info!(
                    "SSH TCP connected: session={} attempt={} target={}:{} local={} transport_peer={} tcp_ms={}",
                    session_name_for_connect,
                    attempt,
                    server_host_for_log,
                    server_port,
                    local_address,
                    peer_address,
                    tcp_ms
                );
                if config.as_ref().nodelay {
                    if let Err(error) = socket.set_nodelay(true) {
                        return Err(AppError::Remote(format!(
                            "设置 SSH TCP_NODELAY 失败：{error}"
                        )));
                    }
                }
                let handshake_started = Instant::now();
                match client::connect_stream(config.clone(), socket, client.clone()).await {
                    Ok(handle) => {
                        let handshake_ms = handshake_started.elapsed().as_millis();
                        log::info!(
                            "SSH handshake complete: session={} attempt={} tcp_ms={} handshake_ms={} attempt_total_ms={}",
                            session_name_for_connect,
                            attempt,
                            tcp_ms,
                            handshake_ms,
                            attempt_started.elapsed().as_millis()
                        );
                        return Ok((handle, attempt, tcp_ms, handshake_ms));
                    }
                    Err(error) if attempt == 1 && is_transient_connect_error(&error) => {
                        log::warn!(
                            "SSH transient handshake failure, retrying once: session={} host={} port={} error={}",
                            session_name_for_connect,
                            server_host_for_log,
                            server_port,
                            format_ssh_transport_error(&error)
                        );
                    }
                    Err(error) => {
                        return Err(map_connect_error(
                            error,
                            &observed_for_connect,
                            &diagnostics_for_connect,
                        ));
                    }
                }
            }
            unreachable!("SSH handshake retry loop always returns")
        })
        .await
        {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => {
                log::warn!(
                    "SSH connect failed: session={} host={} port={} user={} route={} error={}",
                    session.name,
                    session.host,
                    session.port,
                    session.username,
                    connection_route,
                    error
                );
                if let AppError::HostKeyUntrusted(payload) | AppError::HostKeyChanged(payload) =
                    &error
                {
                    events::emit(app, events::HOST_KEY_VERIFY, payload.clone());
                }
                return Err(error);
            }
            Err(_) => {
                let error = AppError::Remote(format!(
                    "SSH 连接超时：TCP、协议协商或密钥交换未在 {} 毫秒内完成",
                    session.ssh.connect_timeout_ms.max(1_000)
                ));
                log::warn!(
                    "SSH connect timed out: session={} host={} port={} user={} route={} timeout_ms={}",
                    session.name,
                    session.host,
                    session.port,
                    session.username,
                    connection_route,
                    session.ssh.connect_timeout_ms.max(1_000)
                );
                return Err(error);
            }
        };

        let authentication_started = Instant::now();
        if let Err(error) = authenticate(&mut handle, &session).await {
            let diagnostic = observed_disconnect_reason_from_diagnostics(&diagnostics).await;
            let error = match diagnostic {
                Some(reason) => AppError::Remote(format!("SSH 认证阶段失败：{reason}")),
                None => error,
            };
            log::warn!(
                "SSH authentication failed: session={} host={} port={} user={} error={}",
                session.name,
                session.host,
                session.port,
                session.username,
                error
            );
            return Err(error);
        }
        let authentication_ms = authentication_started.elapsed().as_millis();
        log::info!(
            "SSH authentication complete: session={} attempt={} auth_ms={}",
            session.name,
            successful_attempt,
            authentication_ms
        );
        let handle = Arc::new(Mutex::new(handle));
        let info = ConnectionInfo {
            connection_id: connection_id.clone(),
            session_id: session.id.clone(),
            host: session.host.clone(),
            port: session.port,
            username: session.username.clone(),
            status: RuntimeStatus::Connected,
            connected_at: now(),
            disconnect_reason: None,
        };
        crate::errors::register_resource_label(&connection_id, &session.name);
        self.connections.write().await.insert(
            connection_id.clone(),
            ConnectionRecord {
                info: info.clone(),
                handle: handle.clone(),
                remote_forwards,
                diagnostics,
            },
        );
        if notify_ui {
            events::emit(app, events::SSH_STATUS, info.clone());
        }
        log::info!(
            "SSH connected: session={} host={} port={} user={} route={} attempt={} lock_wait_ms={} tcp_ms={} handshake_ms={} auth_ms={} total_ms={}",
            session.name,
            session.host,
            session.port,
            session.username,
            connection_route,
            successful_attempt,
            lock_wait_ms,
            tcp_ms,
            handshake_ms,
            authentication_ms,
            connection_started.elapsed().as_millis()
        );

        Ok(info)
    }

    pub async fn disconnect(&self, app: &AppHandle, connection_id: &str) -> AppResult<()> {
        self.shutdown_connection(app, connection_id).await
    }

    pub(super) async fn disconnect_automation(
        &self,
        app: &AppHandle,
        connection_id: &str,
    ) -> AppResult<()> {
        self.shutdown_connection_with_reason(
            app,
            connection_id,
            Some("AI API 主动断开".to_string()),
        )
        .await
    }

    pub async fn shutdown_connection(&self, app: &AppHandle, connection_id: &str) -> AppResult<()> {
        self.shutdown_connection_with_reason(app, connection_id, None)
            .await
    }

    async fn shutdown_connection_with_reason(
        &self,
        app: &AppHandle,
        connection_id: &str,
        disconnect_reason: Option<String>,
    ) -> AppResult<()> {
        let record = self
            .connections
            .write()
            .await
            .remove(connection_id)
            .ok_or_else(|| AppError::missing_connection(connection_id))?;

        self.close_children_for_connection(app, &record, None).await;
        let disconnect_result = record
            .handle
            .lock()
            .await
            .disconnect(Disconnect::ByApplication, "HelM disconnect", "zh-CN")
            .await
            .map_err(remote_error);

        let mut info = record.info;
        info.status = RuntimeStatus::Disconnected;
        info.disconnect_reason = disconnect_reason;
        events::emit(app, events::SSH_STATUS, info);
        crate::errors::forget_resource_label(connection_id);
        disconnect_result
    }

    pub async fn shutdown_all(&self, app: &AppHandle) {
        let connection_ids: Vec<String> = self.connections.read().await.keys().cloned().collect();
        for connection_id in connection_ids {
            if let Err(error) = self.shutdown_connection(app, &connection_id).await {
                eprintln!("[helm] failed to shutdown connection: {connection_id}: {error}");
            }
        }
        self.close_all_orphans(app).await;
    }

    /// 启动死连接巡检后台任务。每 30s 扫描一次 `connections`，对每个 Connected 状态的
    /// 记录尝试 `try_lock + is_closed()`：如果 russh 已经把 handle 标记 closed
    /// （keepalive_max 触发后），则把它当作"假死连接"清理掉并 emit Disconnected
    /// 事件，让前端的"重新连接"按钮能正常出现。
    ///
    /// 覆盖只使用 API、不打开终端的场景，确保 keepalive 标记关闭后的连接能被统一清理。
    pub fn spawn_dead_connection_reaper(&self, app: AppHandle) {
        let runtime = self.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs(30));
            ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
            // 跳过启动时立即触发的第一次 tick。
            ticker.tick().await;
            loop {
                ticker.tick().await;
                runtime.reap_dead_connections(&app).await;
            }
        });
    }

    async fn reap_dead_connections(&self, app: &AppHandle) {
        // Phase 1: 在 read 锁内只做识别，不持有任何 handle Mutex 太久。
        // 用 try_lock，拿不到说明此刻有人在用（活的），下轮再查；不会和正常请求打架。
        let dead_ids: Vec<String> = {
            let connections = self.connections.read().await;
            let mut victims = Vec::new();
            for (id, record) in connections.iter() {
                if record.info.status != RuntimeStatus::Connected {
                    continue;
                }
                let dead = match record.handle.try_lock() {
                    Ok(guard) => guard.is_closed(),
                    Err(_) => false,
                };
                if dead {
                    victims.push(id.clone());
                }
            }
            victims
        };
        if dead_ids.is_empty() {
            return;
        }

        // Phase 2: 逐个 remove + emit。和 runtime_terminal 末尾的死连接清理路径保持一致。
        for id in dead_ids {
            let removed = self.connections.write().await.remove(&id);
            if let Some(record) = removed {
                let label =
                    crate::errors::resource_label(&id).unwrap_or_else(|| record.info.host.clone());
                log::warn!("连接已断开，正在清理: {label} ({})", record.info.host);
                let disconnect_reason = observed_disconnect_reason(&record).await;
                self.close_children_for_connection(app, &record, Some(&disconnect_reason))
                    .await;
                let mut info = record.info;
                info.status = RuntimeStatus::Disconnected;
                info.disconnect_reason = Some(disconnect_reason);
                events::emit(app, events::SSH_STATUS, info);
                crate::errors::forget_resource_label(&id);
            }
        }
    }

    #[cfg(test)]
    pub async fn ensure_no_stale_handles(&self) -> bool {
        self.connections.read().await.is_empty()
            && self.terminals.read().await.is_empty()
            && self.sftp_sessions.read().await.is_empty()
            && self.transfers.read().await.is_empty()
            && self.telemetry_jobs.read().await.is_empty()
            && self.forwards.read().await.is_empty()
    }
}
