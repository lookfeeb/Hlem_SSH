use super::*;

impl RemoteRuntime {
    pub async fn open_terminal(
        &self,
        app: &AppHandle,
        connection_id: &str,
        cols: u16,
        rows: u16,
    ) -> AppResult<TerminalInfo> {
        let connection = self.connection(connection_id).await?;
        let channel = self
            .open_session_channel_for_connection(&connection, true)
            .await?;
        let (mut read_half, write_half) = channel.split();
        write_half
            .request_pty(true, "xterm-256color", cols as u32, rows as u32, 0, 0, &[])
            .await
            .map_err(remote_error)?;

        let terminal_id = Uuid::new_v4().to_string();
        // Inherit the friendly session label from the parent connection so "terminal not
        // found" logs show the session name instead of a UUID.
        if let Some(label) = crate::errors::resource_label(connection_id) {
            crate::errors::register_resource_label(&terminal_id, &label);
        }
        let writer = Arc::new(Mutex::new(write_half));
        let info = TerminalInfo {
            terminal_id: terminal_id.clone(),
            connection_id: connection_id.to_string(),
            cols,
            rows,
            opened_at: now(),
        };

        // 尝试通过 SSH 协议层把 TMOUT 置空（zero echo，shell 启动前生效）。
        // 多数 sshd 因 AcceptEnv 白名单会拒绝，失败静默忽略；不要再向 PTY
        // 注入隐藏字节保活，否则某些 shell/readline 会把 NUL 显示成 @ 或 ^@。
        {
            let writer = writer.lock().await;
            let _ = writer.set_env(false, "TMOUT", "").await;
        }

        // Request shell BEFORE spawning the reader task to avoid a race where
        // the reader sees EOF (channel rejected) and removes the terminal from
        // the registry before we even register it.
        {
            let writer = writer.lock().await;
            writer.request_shell(true).await.map_err(remote_error)?;
        }
        // Do not inject prompt hooks into the interactive PTY. Even invisible
        // OSC markers can be split across SSH output chunks; filtering those
        // chunks on the frontend risks desynchronizing xterm's parser/cursor
        // state. Keep terminal output as the remote shell actually produced it.

        self.terminals.write().await.insert(
            terminal_id.clone(),
            TerminalRecord {
                info: info.clone(),
                writer: writer.clone(),
            },
        );

        let app_handle = app.clone();
        let terminals = self.terminals.clone();
        let closed_terminal_id = terminal_id.clone();
        let reader_connection_id = connection_id.to_string();
        let reader_handle = connection.handle.clone();
        let reader_runtime = self.clone();
        tokio::spawn(async move {
            while let Some(message) = read_half.wait().await {
                match message {
                    ChannelMsg::Data { data } => {
                        emit_terminal_output(&app_handle, &closed_terminal_id, "output", &data)
                    }
                    ChannelMsg::ExtendedData { data, .. } => {
                        emit_terminal_output(&app_handle, &closed_terminal_id, "error", &data)
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
                    reader_runtime
                        .close_children_for_connection(&app_handle, &record)
                        .await;
                    let mut info = record.info;
                    info.status = RuntimeStatus::Disconnected;
                    events::emit(&app_handle, events::SSH_STATUS, info);
                    crate::errors::forget_resource_label(&reader_connection_id);
                }
            }
        });

        Ok(info)
    }

    pub async fn terminal_write(&self, terminal_id: &str, data: String) -> AppResult<()> {
        let writer = self.terminal_writer(terminal_id).await?;
        let writer = writer.lock().await;
        let mut stream = writer.make_writer();
        stream
            .write_all(data.as_bytes())
            .await
            .map_err(remote_error)?;
        stream.flush().await.map_err(remote_error)?;
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
        let result = {
            let writer = record.writer.lock().await;
            writer.window_change(cols as u32, rows as u32, 0, 0).await
        };
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
        close_terminal_record(record).await?;
        emit_terminal_closed(app, terminal_id.to_string());
        Ok(())
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
