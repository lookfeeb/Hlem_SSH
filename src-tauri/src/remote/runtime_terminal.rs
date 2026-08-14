use super::*;

impl RemoteRuntime {
    pub async fn open_terminal(
        &self,
        app: &AppHandle,
        connection_id: &str,
        cols: u16,
        rows: u16,
    ) -> AppResult<TerminalInfo> {
        let _lifecycle_guard = self.lifecycle_gate.read().await;
        let started = Instant::now();
        let connection = self.connection(connection_id).await?;
        let channel_started = Instant::now();
        let channel = self
            .open_session_channel_for_connection(&connection, true)
            .await?;
        let channel_ms = channel_started.elapsed().as_millis();
        let (mut read_half, write_half) = channel.split();
        let pty_started = Instant::now();
        run_ssh_channel_control(
            "申请终端 PTY",
            write_half.request_pty(true, "xterm-256color", cols as u32, rows as u32, 0, 0, &[]),
        )
        .await?;
        let pty_ms = pty_started.elapsed().as_millis();

        let terminal_id = Uuid::new_v4().to_string();
        // Inherit the friendly session label from the parent connection so "terminal not
        // found" logs show the session name instead of a UUID.
        if let Some(label) = crate::errors::resource_label(connection_id) {
            crate::errors::register_resource_label(&terminal_id, &label);
        }
        let writer = Arc::new(Mutex::new(write_half));
        let output_gate = Arc::new(Mutex::new(TerminalOutputGate::default()));
        let reader = Arc::new(StdMutex::new(None));
        let closed = Arc::new(AtomicBool::new(false));
        let info = TerminalInfo {
            terminal_id: terminal_id.clone(),
            connection_id: connection_id.to_string(),
            cols,
            rows,
            opened_at: now(),
        };

        {
            let writer = writer.lock().await;
            if let Err(error) =
                run_ssh_channel_control("设置终端环境变量", writer.set_env(false, "TMOUT", ""))
                    .await
            {
                log::debug!("remote refused TMOUT environment override: {error}");
            }
        }

        // Request shell BEFORE spawning the reader task to avoid a race where
        // the reader sees EOF (channel rejected) and removes the terminal from
        // the registry before we even register it.
        let shell_started = Instant::now();
        {
            let writer = writer.lock().await;
            run_ssh_channel_control("启动远程 Shell", writer.request_shell(true)).await?;
        }
        let shell_ms = shell_started.elapsed().as_millis();
        // Do not inject prompt hooks into the interactive PTY. Even invisible
        // OSC markers can be split across SSH output chunks; filtering those
        // chunks on the frontend risks desynchronizing xterm's parser/cursor
        // state. Keep terminal output as the remote shell actually produced it.

        let app_handle = app.clone();
        let terminals = self.terminals.clone();
        let closed_terminal_id = terminal_id.clone();
        let task_closed = closed.clone();
        let reader_connection_id = connection_id.to_string();
        let reader_handle = connection.handle.clone();
        let reader_runtime = self.clone();
        let reader_output_gate = output_gate.clone();
        let (reader_start_sender, reader_start_receiver) = oneshot::channel();
        let task = tokio::spawn(async move {
            if reader_start_receiver.await.is_err() {
                return;
            }
            while let Some(message) = read_half.wait().await {
                if task_closed.load(Ordering::Acquire) {
                    return;
                }
                match message {
                    ChannelMsg::Data { data } => {
                        emit_or_buffer_terminal_output(
                            &app_handle,
                            &reader_output_gate,
                            &closed_terminal_id,
                            "output",
                            &data,
                        )
                        .await;
                    }
                    ChannelMsg::ExtendedData { data, .. } => {
                        emit_or_buffer_terminal_output(
                            &app_handle,
                            &reader_output_gate,
                            &closed_terminal_id,
                            "error",
                            &data,
                        )
                        .await;
                    }
                    ChannelMsg::ExitStatus { exit_status } => {
                        events::emit(
                            &app_handle,
                            events::TERMINAL_OUTPUT,
                            TerminalOutputPayload {
                                terminal_id: closed_terminal_id.clone(),
                                kind: "system".to_string(),
                                data: format!("进程退出，状态码 {exit_status}"),
                                data_base64: String::new(),
                            },
                        );
                    }
                    _ => {}
                }
            }
            let removed = terminals
                .write()
                .await
                .remove(&closed_terminal_id)
                .is_some();
            if removed {
                task_closed.store(true, Ordering::Release);
                crate::errors::forget_resource_label(&closed_terminal_id);
                emit_terminal_closed(&app_handle, closed_terminal_id);
            }

            // 终端 reader 退出后，判断 SSH handle 是否也已经死亡（被 russh 内部
            // 的 keepalive_max 机制标记关闭）。如果是，主动清理整个连接并发
            // Disconnected 事件，让前端状态回到已断开。
            // 仅当 shell 正常退出（如用户 `exit`）时 handle 仍存活，此时只清
            // 理终端，不动连接。
            let ssh_dead = match reader_handle.try_lock() {
                Ok(guard) => guard.is_closed(),
                Err(_) => false,
            };
            if ssh_dead {
                let removed_record = reader_runtime
                    .connections
                    .write()
                    .await
                    .remove(&reader_connection_id);
                if let Some(record) = removed_record {
                    let disconnect_reason = observed_disconnect_reason(&record).await;
                    log::warn!(
                        "终端通道结束后检测到 SSH 连接已断开: connection={} host={} reason={}",
                        reader_connection_id,
                        record.info.host,
                        disconnect_reason
                    );
                    reader_runtime
                        .close_children_for_connection(
                            &app_handle,
                            &record,
                            Some(&disconnect_reason),
                        )
                        .await;
                    if record.origin.notifies_desktop() {
                        let mut info = record.info;
                        info.status = RuntimeStatus::Disconnected;
                        info.disconnect_reason = Some(disconnect_reason);
                        events::emit(&app_handle, events::SSH_STATUS, info);
                    }
                    crate::errors::forget_resource_label(&reader_connection_id);
                }
            }
        });
        {
            let mut reader_slot = lock_unpoisoned(&reader, "terminal reader registry");
            *reader_slot = Some(task);
        }

        // The reader handle must be attached before the terminal becomes visible in the
        // registry. Otherwise a concurrent close can remove a record whose reader slot is
        // still empty, after which the newly spawned reader would no longer be owned by any
        // lifecycle record.
        let terminal_record = TerminalRecord {
            info: info.clone(),
            writer: writer.clone(),
            output_gate: output_gate.clone(),
            reader: reader.clone(),
            closed: closed.clone(),
        };
        let connections = self.connections.read().await;
        if !connections.contains_key(connection_id) {
            drop(connections);
            if let Err(error) = close_terminal_record(terminal_record).await {
                eprintln!(
                    "[helm] failed to close terminal opened after connection closed: {terminal_id}: {error}"
                );
            }
            crate::errors::forget_resource_label(&terminal_id);
            return Err(AppError::missing_connection(connection_id));
        }
        self.terminals
            .write()
            .await
            .insert(terminal_id.clone(), terminal_record);
        drop(connections);

        if reader_start_sender.send(()).is_err() {
            if let Some(record) = self.terminals.write().await.remove(&terminal_id) {
                let _ = close_terminal_record(record).await;
            }
            crate::errors::forget_resource_label(&terminal_id);
            return Err(AppError::Remote("终端读取任务启动失败".to_string()));
        }

        log::info!(
            "SSH terminal ready: connection_id={} channel_ms={} pty_ms={} shell_ms={} total_ms={}",
            connection_id,
            channel_ms,
            pty_ms,
            shell_ms,
            started.elapsed().as_millis()
        );

        Ok(info)
    }

    pub async fn terminal_start(&self, app: &AppHandle, terminal_id: &str) -> AppResult<()> {
        let record = self
            .terminals
            .read()
            .await
            .get(terminal_id)
            .cloned()
            .ok_or_else(|| AppError::missing_terminal(terminal_id))?;

        // 前端订阅建立前先缓存 PTY 输出，收到 start 后按原始顺序一次性放行。
        // 不执行额外命令、不拼接主机信息，也不按连接名称区分；AList、CTO
        // 以及其他会话看到的都只会是远端交互式 shell 实际发送的内容。
        let mut output_gate = record.output_gate.lock().await;
        if output_gate.streaming {
            return Ok(());
        }
        for output in output_gate.start() {
            emit_terminal_output(app, terminal_id, &output.kind, &output.data);
        }
        Ok(())
    }

    pub async fn terminal_write(&self, terminal_id: &str, data: String) -> AppResult<()> {
        let writer = self.terminal_writer(terminal_id).await?;
        timeout(CHANNEL_SHUTDOWN_TIMEOUT, async {
            let writer = writer.lock().await;
            let mut stream = writer.make_writer();
            stream
                .write_all(data.as_bytes())
                .await
                .map_err(remote_error)?;
            stream.flush().await.map_err(remote_error)
        })
        .await
        .map_err(|_| AppError::Remote("写入终端超时（连接可能已断开）".to_string()))??;
        Ok(())
    }

    pub async fn terminal_resize(&self, terminal_id: &str, cols: u16, rows: u16) -> AppResult<()> {
        let record = self
            .terminals
            .read()
            .await
            .get(terminal_id)
            .cloned()
            .ok_or_else(|| AppError::missing_terminal(terminal_id))?;
        if record.info.cols == cols && record.info.rows == rows {
            return Ok(());
        }
        let result = timeout(CHANNEL_SHUTDOWN_TIMEOUT, async {
            let writer = record.writer.lock().await;
            writer.window_change(cols as u32, rows as u32, 0, 0).await
        })
        .await
        .map_err(|_| AppError::Remote("调整终端窗口超时（连接可能已断开）".to_string()))?;
        result.map_err(remote_error)?;

        if let Some(record) = self.terminals.write().await.get_mut(terminal_id) {
            record.info.cols = cols;
            record.info.rows = rows;
        }
        Ok(())
    }

    pub async fn terminal_close(&self, app: &AppHandle, terminal_id: &str) -> AppResult<()> {
        let record = self
            .terminals
            .write()
            .await
            .remove(terminal_id)
            .ok_or_else(|| AppError::missing_terminal(terminal_id))?;
        let result = close_terminal_record(record).await;
        crate::errors::forget_resource_label(terminal_id);
        emit_terminal_closed(app, terminal_id.to_string());
        result
    }

    pub async fn exec_on_connection(
        &self,
        connection_id: &str,
        command: String,
        timeout_ms: Option<u64>,
    ) -> AppResult<ExecResult> {
        let connection = self.connection(connection_id).await?;
        let channel = self
            .open_session_channel_for_connection(&connection, true)
            .await?;
        exec_with_channel(
            channel,
            command,
            timeout_ms.unwrap_or(DEFAULT_EXEC_TIMEOUT_MS),
        )
        .await
    }
}

async fn emit_or_buffer_terminal_output(
    app: &AppHandle,
    output_gate: &Arc<Mutex<TerminalOutputGate>>,
    terminal_id: &str,
    kind: &str,
    data: &[u8],
) {
    let mut output_gate = output_gate.lock().await;
    if let Some(output) = output_gate.route(kind, data) {
        emit_terminal_output(app, terminal_id, &output.kind, &output.data);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_output_gate_preserves_startup_output_order() {
        let mut gate = TerminalOutputGate::new(1024);
        assert!(gate.route("output", b"Welcome to Ubuntu\r\n").is_none());
        assert!(gate
            .route("output", b"System information as of now\r\n")
            .is_none());

        let pending = gate.start().into_iter().collect::<Vec<_>>();
        assert_eq!(pending.len(), 2);
        assert_eq!(pending[0].data, b"Welcome to Ubuntu\r\n");
        assert_eq!(pending[1].data, b"System information as of now\r\n");
        assert_eq!(gate.pending_bytes, 0);
    }

    #[test]
    fn terminal_output_gate_streams_new_output_after_start() {
        let mut gate = TerminalOutputGate::new(1024);
        assert!(gate.start().is_empty());

        let output = gate.route("output", b"root@host:~# ").unwrap();
        assert_eq!(output.kind, "output");
        assert_eq!(output.data, b"root@host:~# ");
        assert!(gate.pending.is_empty());
    }

    #[test]
    fn terminal_output_gate_enforces_pending_byte_limit() {
        let mut gate = TerminalOutputGate::new(5);
        assert!(gate.route("output", b"abc").is_none());
        assert!(gate.route("error", b"def").is_none());

        let pending = gate.start().into_iter().collect::<Vec<_>>();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].kind, "error");
        assert_eq!(pending[0].data, b"def");

        let mut oversized = TerminalOutputGate::new(5);
        assert!(oversized.route("output", b"1234567").is_none());
        let pending = oversized.start().into_iter().collect::<Vec<_>>();
        assert_eq!(pending[0].data, b"34567");
    }

    #[test]
    fn terminal_output_gate_start_is_idempotent() {
        let mut gate = TerminalOutputGate::new(1024);
        assert!(gate.route("output", b"motd").is_none());
        assert_eq!(gate.start().len(), 1);
        assert!(gate.start().is_empty());
    }

    #[test]
    fn terminal_output_gate_is_connection_agnostic_and_preserves_raw_bytes() {
        for (connection_name, output) in [
            ("AList", b"Welcome to Ubuntu\r\nroot@alist:~# ".as_slice()),
            ("CTO", b"Last login: today\r\nroot@cto:~# ".as_slice()),
        ] {
            let mut gate = TerminalOutputGate::new(1024);
            assert!(gate.route("output", output).is_none(), "{connection_name}");
            let pending = gate.start().into_iter().collect::<Vec<_>>();
            assert_eq!(pending.len(), 1, "{connection_name}");
            assert_eq!(pending[0].data, output, "{connection_name}");
        }
    }
}
