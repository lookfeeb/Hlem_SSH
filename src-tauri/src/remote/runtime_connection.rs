use super::*;

impl RemoteRuntime {
    pub async fn connection_list(&self) -> Vec<ConnectionInfo> {
        self.connections
            .read()
            .await
            .values()
            .filter(|record| {
                record.origin == ConnectionOrigin::Desktop && !connection_record_is_closed(record)
            })
            .map(|record| record.info.clone())
            .collect()
    }

    pub fn connect(
        &self,
        app: &AppHandle,
        session: SessionConfig,
        trusted: Option<KnownHostEntry>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = AppResult<ConnectionInfo>> + Send + '_>>
    {
        let app = app.clone();
        let this = self.clone();
        Box::pin(async move {
            this.connect_inner(&app, session, trusted, true, ConnectionOrigin::Desktop)
                .await
        })
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
            this.connect_inner(&app, session, trusted, false, ConnectionOrigin::Desktop)
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
            this.connect_inner(&app, session, trusted, true, ConnectionOrigin::Automation)
                .await
        })
    }

    async fn connect_inner(
        &self,
        app: &AppHandle,
        session: SessionConfig,
        trusted: Option<KnownHostEntry>,
        reuse_existing: bool,
        origin: ConnectionOrigin,
    ) -> AppResult<ConnectionInfo> {
        let _lifecycle_guard = self.lifecycle_gate.read().await;
        let connection_started = Instant::now();
        let session_lock = self.connection_lock(&session.id, origin).await;
        let _session_guard = session_lock.lock().await;
        let lock_wait_ms = connection_started.elapsed().as_millis();
        if reuse_existing {
            if let Some(existing) = self.find_connection_by_session(&session.id, origin).await {
                if connection_record_is_closed(&existing) {
                    log::warn!(
                        "stale SSH connection found before reuse: session={} connection={} origin={origin:?}",
                        session.name,
                        existing.info.connection_id
                    );
                    let _ = self
                        .shutdown_connection_with_reason(
                            app,
                            &existing.info.connection_id,
                            Some("SSH 连接已失效，正在重新连接".to_string()),
                        )
                        .await;
                } else {
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
        }

        // 私钥读取、解密和 KDF 与网络建连并行执行，避免握手完成后才开始做
        // 本地准备工作。密码认证会直接返回，不会额外创建任务。
        let authentication_prepare_started = Instant::now();
        let authentication_preparation = prepare_authentication(&session)?;

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
        if origin.notifies_desktop() {
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
                if origin.notifies_desktop() {
                    if let AppError::HostKeyUntrusted(payload)
                    | AppError::HostKeyChanged(payload) = &error
                    {
                        events::emit(app, events::HOST_KEY_VERIFY, payload.clone());
                    }
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

        let authentication_prepare_wait_started = Instant::now();
        let prepared_authentication = match timeout(
            connect_timeout,
            authentication_preparation.resolve(),
        )
        .await
        {
            Ok(Ok(authentication)) => authentication,
            Ok(Err(error)) => {
                log::warn!(
                    "SSH authentication preparation failed: session={} host={} port={} user={} error={}",
                    session.name,
                    session.host,
                    session.port,
                    session.username,
                    error
                );
                return Err(error);
            }
            Err(_) => {
                let error = AppError::Remote(format!(
                    "SSH 认证材料准备超时：未在 {} 毫秒内完成",
                    session.ssh.connect_timeout_ms.max(1_000)
                ));
                log::warn!(
                    "SSH authentication preparation timed out: session={} host={} port={} user={} timeout_ms={}",
                    session.name,
                    session.host,
                    session.port,
                    session.username,
                    session.ssh.connect_timeout_ms.max(1_000)
                );
                return Err(error);
            }
        };
        let authentication_prepare_ms = authentication_prepare_started.elapsed().as_millis();
        let authentication_prepare_wait_ms =
            authentication_prepare_wait_started.elapsed().as_millis();
        let authentication_method = prepared_authentication.label();
        let authentication_started = Instant::now();
        let authentication = timeout(
            connect_timeout,
            authenticate(&mut handle, &session.username, &prepared_authentication),
        )
        .await;
        if let Err(error) = match authentication {
            Ok(result) => result,
            Err(_) => Err(AppError::Remote(format!(
                "SSH 认证超时：服务器未在 {} 毫秒内完成认证",
                session.ssh.connect_timeout_ms.max(1_000)
            ))),
        } {
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
            "SSH authentication complete: session={} attempt={} method={} prepare_ms={} prepare_wait_ms={} auth_ms={}",
            session.name,
            successful_attempt,
            authentication_method,
            authentication_prepare_ms,
            authentication_prepare_wait_ms,
            authentication_ms
        );
        let handle = Arc::new(handle);
        let exec_channel_pool = Arc::new(ExecChannelPool::default());
        let exec_process_tracker = Arc::new(ExecProcessTracker::default());
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
                origin,
                handle: handle.clone(),
                exec_channel_pool: exec_channel_pool.clone(),
                exec_process_tracker,
                remote_forwards,
                diagnostics,
            },
        );
        if origin == ConnectionOrigin::Automation {
            exec_channel_pool.schedule_refill(handle.clone());
        }
        if origin.notifies_desktop() {
            events::emit(app, events::SSH_STATUS, info.clone());
        }
        log::info!(
            "SSH connected: session={} host={} port={} user={} route={} attempt={} lock_wait_ms={} tcp_ms={} handshake_ms={} auth_prepare_ms={} auth_prepare_wait_ms={} auth_ms={} total_ms={}",
            session.name,
            session.host,
            session.port,
            session.username,
            connection_route,
            successful_attempt,
            lock_wait_ms,
            tcp_ms,
            handshake_ms,
            authentication_prepare_ms,
            authentication_prepare_wait_ms,
            authentication_ms,
            connection_started.elapsed().as_millis()
        );

        Ok(info)
    }

    pub async fn disconnect(&self, app: &AppHandle, connection_id: &str) -> AppResult<()> {
        let record = self.connection(connection_id).await?;
        if record.origin != ConnectionOrigin::Desktop {
            return Err(AppError::InvalidInput(
                "桌面界面不能断开 AI API 连接".to_string(),
            ));
        }
        self.shutdown_connection(app, connection_id).await
    }

    pub(super) async fn disconnect_automation(
        &self,
        app: &AppHandle,
        connection_id: &str,
    ) -> AppResult<()> {
        let record = self.connection(connection_id).await?;
        if record.origin != ConnectionOrigin::Automation {
            return Err(AppError::InvalidInput(
                "AI API 不能断开桌面连接".to_string(),
            ));
        }
        self.shutdown_connection_with_reason(app, connection_id, None)
            .await
    }

    pub async fn shutdown_connection(&self, app: &AppHandle, connection_id: &str) -> AppResult<()> {
        self.shutdown_connection_with_reason(app, connection_id, None)
            .await
    }

    pub async fn shutdown_session_connections(&self, app: &AppHandle, session_id: &str) {
        let desktop_lock = self
            .connection_lock(session_id, ConnectionOrigin::Desktop)
            .await;
        let automation_lock = self
            .connection_lock(session_id, ConnectionOrigin::Automation)
            .await;
        let _desktop_guard = desktop_lock.lock().await;
        let _automation_guard = automation_lock.lock().await;
        let connection_ids: Vec<String> = self
            .connections
            .read()
            .await
            .values()
            .filter(|record| record.info.session_id == session_id)
            .map(|record| record.info.connection_id.clone())
            .collect();
        for connection_id in connection_ids {
            if let Err(error) = self.shutdown_connection(app, &connection_id).await {
                if !matches!(error, AppError::NotFound(_)) {
                    eprintln!(
                        "[helm] failed to shutdown deleted session connection: {connection_id}: {error}"
                    );
                }
            }
        }
    }

    pub async fn shutdown_automation_connections(
        &self,
        app: &AppHandle,
        allowed_session_ids: Option<&[String]>,
    ) {
        let connection_ids: Vec<String> = self
            .connections
            .read()
            .await
            .values()
            .filter(|record| {
                should_shutdown_automation_connection(
                    record.origin,
                    &record.info.session_id,
                    allowed_session_ids,
                )
            })
            .map(|record| record.info.connection_id.clone())
            .collect();
        for connection_id in connection_ids {
            if let Err(error) = self.disconnect_automation(app, &connection_id).await {
                if !matches!(error, AppError::NotFound(_)) {
                    log::warn!("failed to shutdown automation connection {connection_id}: {error}");
                }
            }
        }
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

        self.close_children_for_connection(app, &record, disconnect_reason.as_deref())
            .await;
        let disconnect_result =
            disconnect_connection_handle(&record.handle, "HelM disconnect").await;

        if record.origin.notifies_desktop() {
            let mut info = record.info;
            info.status = RuntimeStatus::Disconnected;
            info.disconnect_reason = disconnect_reason;
            events::emit(app, events::SSH_STATUS, info);
        }
        crate::errors::forget_resource_label(connection_id);
        disconnect_result
    }

    pub async fn shutdown_all(&self, app: &AppHandle) {
        self.shutdown_all_with_reason(app, None, "工作区已锁定")
            .await;
    }

    pub async fn shutdown_all_for_exit(&self, app: &AppHandle) {
        self.shutdown_all_with_reason(app, Some("程序已关闭"), "程序已关闭，传输已停止")
            .await;
    }

    async fn shutdown_all_with_reason(
        &self,
        app: &AppHandle,
        disconnect_reason: Option<&str>,
        orphan_cleanup_reason: &str,
    ) {
        let _lifecycle_guard = self.lifecycle_gate.write().await;
        let connection_ids: Vec<String> = self.connections.read().await.keys().cloned().collect();
        for connection_id in connection_ids {
            if let Err(error) = self
                .shutdown_connection_with_reason(
                    app,
                    &connection_id,
                    disconnect_reason.map(str::to_owned),
                )
                .await
            {
                eprintln!("[helm] failed to shutdown connection: {connection_id}: {error}");
            }
        }
        self.close_all_orphans(app, orphan_cleanup_reason).await;
    }

    /// 启动死连接巡检后台任务。每 30s 扫描一次 `connections`，对每个 Connected 状态的
    /// 记录尝试 `try_lock + is_closed()`：如果 russh 已经把 handle 标记 closed
    /// （keepalive_max 触发后），则把它当作"假死连接"清理掉并 emit Disconnected
    /// 事件，让前端的"重新连接"按钮能正常出现。
    ///
    /// 覆盖只使用 API、不打开终端的场景，确保 keepalive 标记关闭后的连接能被统一清理。
    pub fn spawn_dead_connection_reaper(
        &self,
        app: AppHandle,
        mut shutdown: tokio::sync::watch::Receiver<bool>,
    ) {
        if self
            .dead_connection_reaper_started
            .swap(true, Ordering::AcqRel)
        {
            log::debug!("dead connection reaper already started");
            return;
        }
        let runtime = self.clone();
        let started = self.dead_connection_reaper_started.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs(30));
            ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
            // 跳过启动时立即触发的第一次 tick。
            ticker.tick().await;
            loop {
                tokio::select! {
                    _ = ticker.tick() => runtime.reap_dead_connections(&app).await,
                    result = shutdown.changed() => {
                        if result.is_err() || *shutdown.borrow_and_update() {
                            break;
                        }
                    }
                }
            }
            started.store(false, Ordering::Release);
        });
    }

    async fn reap_dead_connections(&self, app: &AppHandle) {
        // Phase 1: 在 read 锁内只做识别。认证后的 russh Handle 可并发只读，
        // is_closed 不会阻塞正常请求。
        let dead_ids: Vec<String> = {
            let connections = self.connections.read().await;
            let mut victims = Vec::new();
            for (id, record) in connections.iter() {
                if record.info.status != RuntimeStatus::Connected {
                    continue;
                }
                let dead = record.handle.is_closed();
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
                let disconnect_reason = observed_disconnect_reason(&record).await;
                log::warn!(
                    "连接已断开，正在清理: {label} ({})，原因: {disconnect_reason}",
                    record.info.host
                );
                self.close_children_for_connection(app, &record, Some(&disconnect_reason))
                    .await;
                if record.origin.notifies_desktop() {
                    let mut info = record.info;
                    info.status = RuntimeStatus::Disconnected;
                    info.disconnect_reason = Some(disconnect_reason);
                    events::emit(app, events::SSH_STATUS, info);
                }
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

pub(super) fn connection_record_is_closed(record: &ConnectionRecord) -> bool {
    record.handle.is_closed()
}

fn should_shutdown_automation_connection(
    origin: ConnectionOrigin,
    session_id: &str,
    allowed_session_ids: Option<&[String]>,
) -> bool {
    origin == ConnectionOrigin::Automation
        && allowed_session_ids
            .is_none_or(|allowed| !allowed.iter().any(|allowed_id| allowed_id == session_id))
}

#[cfg(test)]
mod tests {
    use super::{should_shutdown_automation_connection, ConnectionOrigin};

    #[test]
    fn automation_cleanup_never_selects_desktop_connections() {
        assert!(!should_shutdown_automation_connection(
            ConnectionOrigin::Desktop,
            "session-a",
            None,
        ));
        assert!(should_shutdown_automation_connection(
            ConnectionOrigin::Automation,
            "session-a",
            None,
        ));
    }

    #[test]
    fn authorization_reconcile_only_closes_removed_automation_sessions() {
        let allowed = vec!["session-a".to_string()];
        assert!(!should_shutdown_automation_connection(
            ConnectionOrigin::Automation,
            "session-a",
            Some(&allowed),
        ));
        assert!(should_shutdown_automation_connection(
            ConnectionOrigin::Automation,
            "session-b",
            Some(&allowed),
        ));
    }
}
