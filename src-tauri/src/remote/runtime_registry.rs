use super::*;

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
            Ok(channel) => return Ok(channel),
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
            .filter_map(|(id, record)| {
                (record.info.connection_id == connection_id).then(|| id.clone())
            })
            .collect();
        for id in terminal_ids {
            if let Some(record) = self.terminals.write().await.remove(&id) {
                let terminal_id = record.info.terminal_id.clone();
                let _ = close_terminal_record(record).await;
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
            let _ = close_terminal_record(record).await;
            emit_terminal_closed(app, terminal_id);
        }

        self.sftp_sessions.write().await.clear();

        let transfer_ids: Vec<String> = self
            .transfers
            .read()
            .await
            .iter()
            .filter_map(|(id, record)| {
                matches!(
                    record.info.status,
                    TaskStatus::Queued | TaskStatus::Running | TaskStatus::Paused
                )
                .then(|| id.clone())
            })
            .collect();
        for id in transfer_ids {
            let _ = self
                .cancel_transfer_in_place(app, &id, "工作区已锁定")
                .await;
        }
        self.prune_transfer_history().await;
        let _ = self.persist_transfer_history().await;

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
            let _ = record
                .handle
                .lock()
                .await
                .disconnect(Disconnect::ByApplication, "HelM shutdown", "zh-CN")
                .await;
            let mut info = record.info;
            info.status = RuntimeStatus::Disconnected;
            events::emit(app, events::SSH_STATUS, info);
        }
    }

    pub(super) async fn remove_sftp_sessions_for_connection(
        &self,
        connection_id: &str,
    ) -> Vec<String> {
        let sftp_ids: Vec<String> = self
            .sftp_sessions
            .read()
            .await
            .iter()
            .filter_map(|(id, record)| {
                (record.info.connection_id == connection_id).then(|| id.clone())
            })
            .collect();
        let mut sessions = self.sftp_sessions.write().await;
        for id in &sftp_ids {
            sessions.remove(id);
            crate::errors::forget_resource_label(id);
        }
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
            .filter_map(|(id, record)| {
                (sftp_ids.contains(&record.info.sftp_id)
                    && matches!(
                        record.info.status,
                        TaskStatus::Queued | TaskStatus::Running | TaskStatus::Paused
                    ))
                .then(|| id.clone())
            })
            .collect();
        for id in transfer_ids {
            let _ = self.cancel_transfer_in_place(app, &id, reason).await;
        }
        self.prune_transfer_history().await;
        let _ = self.persist_transfer_history().await;
    }
}
