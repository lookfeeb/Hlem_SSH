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

    pub(super) async fn connection_lock(
        &self,
        session_id: &str,
        origin: ConnectionOrigin,
    ) -> Arc<Mutex<()>> {
        shared_operation_lock(&self.connection_locks, &format!("{origin:?}:{session_id}")).await
    }

    pub(super) async fn sftp_open_lock(&self, connection_id: &str) -> Arc<Mutex<()>> {
        shared_operation_lock(&self.sftp_open_locks, connection_id).await
    }

    pub(super) async fn find_connection_by_session(
        &self,
        session_id: &str,
        origin: ConnectionOrigin,
    ) -> Option<ConnectionRecord> {
        self.connections
            .read()
            .await
            .values()
            .find(|record| record.info.session_id == session_id && record.origin == origin)
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
        let record = self
            .sftp_sessions
            .read()
            .await
            .get(sftp_id)
            .cloned()
            .ok_or_else(|| AppError::missing_sftp(sftp_id))?;
        if record.closed.load(Ordering::Acquire) {
            return Err(AppError::missing_sftp(sftp_id));
        }
        Ok(record.session)
    }

    pub(super) async fn sftp_record(&self, sftp_id: &str) -> AppResult<SftpRecord> {
        let record = self
            .sftp_sessions
            .read()
            .await
            .get(sftp_id)
            .cloned()
            .ok_or_else(|| AppError::missing_sftp(sftp_id))?;
        if record.closed.load(Ordering::Acquire) {
            return Err(AppError::missing_sftp(sftp_id));
        }
        Ok(record)
    }

    pub(super) async fn open_session_channel_for_connection(
        &self,
        connection: &ConnectionRecord,
        reclaim_telemetry: bool,
    ) -> AppResult<Channel<client::Msg>> {
        clear_channel_open_failure(connection);
        match open_session_channel(&connection.handle).await {
            Ok(channel) => Ok(channel),
            Err(first_error) => {
                let mut final_error = first_error;
                if self
                    .compact_sftp_transfer_pool_for_connection(&connection.info.connection_id)
                    .await
                    > 0
                {
                    clear_channel_open_failure(connection);
                    match open_session_channel(&connection.handle).await {
                        Ok(channel) => return Ok(channel),
                        Err(error) => final_error = error,
                    }
                }

                if reclaim_telemetry
                    && self
                        .telemetry_stop_by_connection(&connection.info.connection_id)
                        .await
                        > 0
                {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    clear_channel_open_failure(connection);
                    match open_session_channel(&connection.handle).await {
                        Ok(channel) => return Ok(channel),
                        Err(error) => final_error = error,
                    }
                }

                match take_channel_open_failure(connection) {
                    Some(detail) => Err(AppError::Remote(format!("打开 SSH 通道失败：{detail}"))),
                    None => Err(final_error),
                }
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
            let removed = {
                let mut sessions = record.transfer_sessions.write().await;
                take_idle_extra_sessions(&mut sessions)
            };
            released += removed.len();
            for session in removed {
                if let Err(error) = session.close().await {
                    log::debug!("failed to close reclaimed SFTP session: {error}");
                }
            }
        }
        released
    }

    pub(super) async fn close_children_for_connection(
        &self,
        app: &AppHandle,
        connection: &ConnectionRecord,
        disconnect_reason: Option<&str>,
    ) {
        let connection_id = connection.info.connection_id.as_str();
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

        let sftp_records = self
            .remove_sftp_sessions_for_connection(connection_id)
            .await;
        let sftp_ids: Vec<String> = sftp_records.iter().map(|(id, _)| id.clone()).collect();
        let cleanup_reason = disconnect_reason
            .map(|reason| format!("连接已断开：{reason}"))
            .unwrap_or_else(|| "连接已断开".to_string());
        self.cancel_transfers_for_sftp_ids(app, &sftp_ids, &cleanup_reason)
            .await;
        for (id, record) in sftp_records {
            record.close().await;
            crate::errors::forget_resource_label(&id);
        }
        self.cancel_telemetry_for_connection(app, connection_id, &cleanup_reason)
            .await;
        self.cancel_forwards_for_connection(app, connection).await;
    }

    pub(super) async fn close_all_orphans(&self, app: &AppHandle, cleanup_reason: &str) {
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

        let sftp_records: Vec<(String, SftpRecord)> =
            self.sftp_sessions.write().await.drain().collect();
        for (_, record) in &sftp_records {
            record.begin_close();
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
                .cancel_transfer_in_place(app, &id, cleanup_reason)
                .await
            {
                eprintln!("[helm] failed to cancel orphan transfer: {id}: {error}");
            }
        }
        self.prune_transfer_history().await;
        self.persist_transfer_history_best_effort("clear orphans")
            .await;

        for (id, record) in sftp_records {
            record.close().await;
            crate::errors::forget_resource_label(&id);
        }

        let telemetry_records: Vec<TelemetryJobRecord> = self
            .telemetry_jobs
            .write()
            .await
            .drain()
            .map(|(_, record)| record)
            .collect();
        for record in telemetry_records {
            cancel_telemetry_record(app, record, "工作区已锁定").await;
        }

        let forward_records: Vec<ForwardRecord> = self
            .forwards
            .write()
            .await
            .drain()
            .map(|(_, record)| record)
            .collect();
        for record in forward_records {
            if matches!(record.info.forward_type, ForwardType::Remote) {
                if let Some(connection) = self
                    .connections
                    .read()
                    .await
                    .get(&record.connection_id)
                    .cloned()
                {
                    if let Err(error) = cancel_remote_forward(
                        &connection.handle,
                        &record.info.bind_host,
                        record.info.bind_port as u32,
                    )
                    .await
                    {
                        eprintln!(
                            "[helm] failed to cancel orphan remote forward: {}:{}: {error}",
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

        let connection_records: Vec<ConnectionRecord> = self
            .connections
            .write()
            .await
            .drain()
            .map(|(_, record)| record)
            .collect();
        for record in connection_records {
            let connection_id = record.info.connection_id.clone();
            if let Err(error) = disconnect_connection_handle(&record.handle, "HelM shutdown").await
            {
                eprintln!(
                    "[helm] failed to disconnect orphan connection: {connection_id}: {error}"
                );
            }
            if record.origin.notifies_desktop() {
                let mut info = record.info;
                info.status = RuntimeStatus::Disconnected;
                info.disconnect_reason = None;
                events::emit(app, events::SSH_STATUS, info);
            }
            crate::errors::forget_resource_label(&connection_id);
        }
    }

    pub(super) async fn remove_sftp_sessions_for_connection(
        &self,
        connection_id: &str,
    ) -> Vec<(String, SftpRecord)> {
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
        let mut removed_records = Vec::with_capacity(sftp_ids.len());
        for id in sftp_ids {
            if let Some(record) = sessions.remove(&id) {
                record.begin_close();
                removed_records.push((id, record));
            }
        }
        removed_records
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

fn take_idle_extra_sessions<T>(sessions: &mut Vec<Arc<T>>) -> Vec<Arc<T>> {
    if sessions.len() <= 1 {
        return Vec::new();
    }

    let mut retained = Vec::with_capacity(sessions.len());
    let mut removed = Vec::new();
    for (index, session) in std::mem::take(sessions).into_iter().enumerate() {
        // The first entry is the primary transfer session. Extra sessions are
        // reclaimable only while the pool owns their sole Arc; an active
        // transfer holds another Arc clone and must be allowed to finish.
        if index == 0 || Arc::strong_count(&session) > 1 {
            retained.push(session);
        } else {
            removed.push(session);
        }
    }
    *sessions = retained;
    removed
}

pub(super) async fn shared_operation_lock(
    registry: &Mutex<HashMap<String, Weak<Mutex<()>>>>,
    key: &str,
) -> Arc<Mutex<()>> {
    let mut locks = registry.lock().await;
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(key).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(key.to_string(), Arc::downgrade(&lock));
    lock
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sftp_pool_compaction_keeps_primary_and_borrowed_sessions() {
        let primary = Arc::new(());
        let borrowed = Arc::new(());
        let borrowed_by_transfer = borrowed.clone();
        let idle = Arc::new(());
        let mut sessions = vec![primary.clone(), borrowed.clone(), idle.clone()];
        drop(idle);

        let removed = take_idle_extra_sessions(&mut sessions);

        assert_eq!(sessions.len(), 2);
        assert!(Arc::ptr_eq(&sessions[0], &primary));
        assert!(Arc::ptr_eq(&sessions[1], &borrowed_by_transfer));
        assert_eq!(removed.len(), 1);
        assert!(!Arc::ptr_eq(&removed[0], &primary));
        assert!(!Arc::ptr_eq(&removed[0], &borrowed_by_transfer));
    }

    #[tokio::test]
    async fn operation_lock_registries_prune_released_keys() {
        let runtime = RemoteRuntime::default();
        let first = runtime
            .connection_lock("session-a", ConnectionOrigin::Desktop)
            .await;
        let shared = runtime
            .connection_lock("session-a", ConnectionOrigin::Desktop)
            .await;
        assert!(Arc::ptr_eq(&first, &shared));
        let automation = runtime
            .connection_lock("session-a", ConnectionOrigin::Automation)
            .await;
        assert!(!Arc::ptr_eq(&first, &automation));
        drop(first);
        drop(shared);
        drop(automation);

        let next = runtime
            .connection_lock("session-b", ConnectionOrigin::Desktop)
            .await;
        assert_eq!(runtime.connection_locks.lock().await.len(), 1);
        drop(next);

        let sftp = runtime.sftp_open_lock("connection-a").await;
        drop(sftp);
        let next_sftp = runtime.sftp_open_lock("connection-b").await;
        assert_eq!(runtime.sftp_open_locks.lock().await.len(), 1);
        drop(next_sftp);
    }

    #[test]
    fn automation_connections_are_hidden_from_desktop_events() {
        assert!(ConnectionOrigin::Desktop.notifies_desktop());
        assert!(!ConnectionOrigin::Automation.notifies_desktop());
    }
}
