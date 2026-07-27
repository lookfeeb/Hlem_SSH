use super::*;

async fn close_terminal_record_best_effort(
    record: TerminalRecord,
    terminal_id: &str,
    context: &str,
) {
    if let Err(error) = close_terminal_record(record).await {
        eprintln!("[helm] failed to close terminal during {context}: {terminal_id}: {error}");
    }
}

impl RemoteRuntime {
    pub(super) async fn connection(&self, connection_id: &str) -> AppResult<ConnectionRecord> {
        self.connections
            .read()
            .await
            .get(connection_id)
            .cloned()
            .ok_or_else(|| AppError::missing_connection(connection_id))
    }

    pub(super) async fn connection_lock(&self, session_id: &str) -> Arc<Mutex<()>> {
        let mut locks = self.connection_locks.lock().await;
        locks
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    pub(super) async fn sftp_open_lock(&self, connection_id: &str) -> Arc<Mutex<()>> {
        let mut locks = self.sftp_open_locks.lock().await;
        locks
            .entry(connection_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    pub(super) async fn find_connection_by_session(
        &self,
        session_id: &str,
    ) -> Option<ConnectionRecord> {
        self.connections
            .read()
            .await
            .values()
            .find(|record| record.info.session_id == session_id)
            .cloned()
    }

    pub(super) async fn terminal_writer(
        &self,
        terminal_id: &str,
    ) -> AppResult<Arc<Mutex<TerminalWriter>>> {
        self.terminals
            .read()
            .await
            .get(terminal_id)
            .map(|record| record.writer.clone())
            .ok_or_else(|| AppError::missing_terminal(terminal_id))
    }

    pub(super) async fn sftp_session(&self, sftp_id: &str) -> AppResult<Arc<SftpSession>> {
        self.sftp_sessions
            .read()
            .await
            .get(sftp_id)
            .map(|record| record.session.clone())
            .ok_or_else(|| AppError::missing_sftp(sftp_id))
    }

    pub(super) async fn sftp_record(&self, sftp_id: &str) -> AppResult<SftpRecord> {
        self.sftp_sessions
            .read()
            .await
            .get(sftp_id)
            .cloned()
            .ok_or_else(|| AppError::missing_sftp(sftp_id))
    }

    pub(super) async fn open_session_channel_for_connection(
        &self,
        connection: &ConnectionRecord,
        reclaim_telemetry: bool,
    ) -> AppResult<Channel<client::Msg>> {
        match open_session_channel(&connection.handle).await {
            Ok(channel) => Ok(channel),
            Err(first_error) => {
                if self
                    .compact_sftp_transfer_pool_for_connection(&connection.info.connection_id)
                    .await
                    > 0
                {
                    if let Ok(channel) = open_session_channel(&connection.handle).await {
                        return Ok(channel);
                    }
                }

                if reclaim_telemetry
                    && self
                        .telemetry_stop_by_session(&connection.info.session_id)
                        .await
                        > 0
                {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    if let Ok(channel) = open_session_channel(&connection.handle).await {
                        return Ok(channel);
                    }
                }

                Err(first_error)
            }
        }
    }

    async fn compact_sftp_transfer_pool_for_connection(&self, connection_id: &str) -> usize {
        let records: Vec<SftpRecord> = self
            .sftp_sessions
            .read()
            .await
            .values()
            .filter(|record| record.info.connection_id == connection_id)
            .cloned()
            .collect();

        let mut released = 0usize;
        for record in records {
            let mut sessions = record.transfer_sessions.write().await;
            let keep = usize::from(!sessions.is_empty());
            if sessions.len() > keep {
                released += sessions.len() - keep;
                sessions.truncate(keep);
            }
        }
        released
    }

    pub(super) async fn close_children_for_connection(
        &self,
        app: &AppHandle,
        connection: &ConnectionRecord,
    ) {
        let connection_id = connection.info.connection_id.as_str();
        let session_id = connection.info.session_id.as_str();
        let terminal_ids: Vec<String> = self
            .terminals
            .read()
            .await
            .iter()
            .filter(|(_, record)| record.info.connection_id == connection_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in terminal_ids {
            if let Some(record) = self.terminals.write().await.remove(&id) {
                let terminal_id = record.info.terminal_id.clone();
                close_terminal_record_best_effort(record, &terminal_id, "connection cleanup").await;
                crate::errors::forget_resource_label(&terminal_id);
                emit_terminal_closed(app, terminal_id);
            }
        }

        let sftp_ids = self
            .remove_sftp_sessions_for_connection(connection_id)
            .await;
        self.cancel_transfers_for_sftp_ids(app, &sftp_ids, "连接已断开")
            .await;
        self.cancel_telemetry_for_session(app, session_id, "连接已断开")
            .await;
        self.cancel_forwards_for_session(app, session_id, Some(connection))
            .await;
    }

    pub(super) async fn close_all_orphans(&self, app: &AppHandle) {
        let terminal_records: Vec<TerminalRecord> = self
            .terminals
            .write()
            .await
            .drain()
            .map(|(_, record)| record)
            .collect();
        for record in terminal_records {
            let terminal_id = record.info.terminal_id.clone();
            close_terminal_record_best_effort(record, &terminal_id, "orphan cleanup").await;
            crate::errors::forget_resource_label(&terminal_id);
            emit_terminal_closed(app, terminal_id);
        }

        let sftp_ids: Vec<String> = self
            .sftp_sessions
            .write()
            .await
            .drain()
            .map(|(id, _)| id)
            .collect();
        for id in sftp_ids {
            crate::errors::forget_resource_label(&id);
        }

        let transfer_ids: Vec<String> = self
            .transfers
            .read()
            .await
            .iter()
            .filter(|(_, record)| {
                matches!(
                    record.info.status,
                    TaskStatus::Queued | TaskStatus::Running | TaskStatus::Paused
                )
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in transfer_ids {
            if let Err(error) = self
                .cancel_transfer_in_place(app, &id, "工作区已锁定")
                .await
            {
                eprintln!("[helm] failed to cancel orphan transfer: {id}: {error}");
            }
        }
        self.prune_transfer_history().await;
        self.persist_transfer_history_best_effort("clear orphans")
            .await;

        let telemetry_records: Vec<TelemetryJobRecord> = self
            .telemetry_jobs
            .write()
            .await
            .drain()
            .map(|(_, record)| record)
            .collect();
        for record in telemetry_records {
            cancel_telemetry_record(app, record, "工作区已锁定");
        }

        let forward_records: Vec<ForwardRecord> = self
            .forwards
            .write()
            .await
            .drain()
            .map(|(_, record)| record)
            .collect();
        for record in forward_records {
            cancel_forward_record(app, record).await;
        }

        let connection_records: Vec<ConnectionRecord> = self
            .connections
            .write()
            .await
            .drain()
            .map(|(_, record)| record)
            .collect();
        for record in connection_records {
            let connection_id = record.info.connection_id.clone();
            if let Err(error) = record
                .handle
                .lock()
                .await
                .disconnect(Disconnect::ByApplication, "HelM shutdown", "zh-CN")
                .await
            {
                eprintln!(
                    "[helm] failed to disconnect orphan connection: {connection_id}: {error}"
                );
            }
            let mut info = record.info;
            info.status = RuntimeStatus::Disconnected;
            events::emit(app, events::SSH_STATUS, info);
            crate::errors::forget_resource_label(&connection_id);
        }
    }

    pub(super) async fn remove_sftp_sessions_for_connection(
        &self,
        connection_id: &str,
    ) -> Vec<String> {
        // Serialize cleanup with `open_sftp`: if an open is already in flight,
        // wait for it to publish the session and then remove it. If cleanup won
        // the race, a later open observes the missing SSH connection and fails.
        let open_lock = self.sftp_open_lock(connection_id).await;
        let _open_guard = open_lock.lock().await;
        let sftp_ids: Vec<String> = self
            .sftp_sessions
            .read()
            .await
            .iter()
            .filter(|(_, record)| record.info.connection_id == connection_id)
            .map(|(id, _)| id.clone())
            .collect();
        let mut sessions = self.sftp_sessions.write().await;
        for id in &sftp_ids {
            sessions.remove(id);
            crate::errors::forget_resource_label(id);
        }
        drop(sessions);
        self.sftp_open_locks.lock().await.remove(connection_id);
        sftp_ids
    }

    pub(super) async fn cancel_transfers_for_sftp_ids(
        &self,
        app: &AppHandle,
        sftp_ids: &[String],
        reason: &str,
    ) {
        let transfer_ids: Vec<String> = self
            .transfers
            .read()
            .await
            .iter()
            .filter(|(_, record)| {
                sftp_ids.contains(&record.info.sftp_id)
                    && matches!(
                        record.info.status,
                        TaskStatus::Queued | TaskStatus::Running | TaskStatus::Paused
                    )
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in transfer_ids {
            if let Err(error) = self.cancel_transfer_in_place(app, &id, reason).await {
                eprintln!("[helm] failed to cancel transfer for removed sftp: {id}: {error}");
            }
        }
        self.prune_transfer_history().await;
        self.persist_transfer_history_best_effort("cancel transfers for sftp")
            .await;
    }
}
