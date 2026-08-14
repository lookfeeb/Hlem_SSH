use super::*;

impl RemoteRuntime {
    pub async fn transfer_upload(
        &self,
        app: &AppHandle,
        options: TransferUploadOptions,
    ) -> AppResult<TransferInfo> {
        self.start_transfer(
            app,
            TransferRequest {
                sftp_id: options.sftp_id,
                direction: TransferDirection::Upload,
                local_path: options.local_path,
                remote_path: options.remote_path,
                overwrite: options.overwrite,
                accelerated: options.accelerated,
                resume: options.resume,
            },
        )
        .await
    }

    pub async fn transfer_download(
        &self,
        app: &AppHandle,
        sftp_id: String,
        remote_path: String,
        local_path: String,
        overwrite: bool,
    ) -> AppResult<TransferInfo> {
        self.start_transfer(
            app,
            TransferRequest {
                sftp_id,
                direction: TransferDirection::Download,
                local_path,
                remote_path,
                overwrite,
                accelerated: false,
                resume: false,
            },
        )
        .await
    }

    pub async fn transfer_cancel(&self, app: &AppHandle, transfer_id: &str) -> AppResult<()> {
        self.cancel_transfer_in_place(app, transfer_id, "传输已取消")
            .await?;
        self.prune_transfer_history().await;
        self.persist_transfer_history_best_effort("cancel transfer")
            .await;
        Ok(())
    }

    pub async fn transfer_pause(
        &self,
        app: &AppHandle,
        transfer_id: &str,
    ) -> AppResult<TransferInfo> {
        let mut transfers = self.transfers.write().await;
        let record = transfers
            .get_mut(transfer_id)
            .ok_or_else(|| AppError::missing_transfer(transfer_id))?;
        if !matches!(record.info.status, TaskStatus::Queued | TaskStatus::Running) {
            return Ok(record.info.clone());
        }
        record.paused.store(true, Ordering::Relaxed);
        record.info.status = TaskStatus::Paused;
        record.info.speed_kbps = 0.0;
        record.info.updated_at = now();
        let info = record.info.clone();
        events::emit(app, events::TRANSFER_PROGRESS, info.clone());
        drop(transfers);
        self.persist_transfer_history_best_effort("pause transfer")
            .await;
        Ok(info)
    }

    pub async fn transfer_resume(
        &self,
        app: &AppHandle,
        transfer_id: &str,
    ) -> AppResult<TransferInfo> {
        let mut transfers = self.transfers.write().await;
        let record = transfers
            .get_mut(transfer_id)
            .ok_or_else(|| AppError::missing_transfer(transfer_id))?;
        if !matches!(record.info.status, TaskStatus::Paused) {
            return Ok(record.info.clone());
        }
        record.paused.store(false, Ordering::Relaxed);
        record.info.status = TaskStatus::Running;
        record.info.updated_at = now();
        let info = record.info.clone();
        events::emit(app, events::TRANSFER_PROGRESS, info.clone());
        drop(transfers);
        self.persist_transfer_history_best_effort("resume transfer")
            .await;
        Ok(info)
    }

    pub async fn transfer_remove(
        &self,
        _app: &AppHandle,
        transfer_id: &str,
    ) -> AppResult<TransferHistorySnapshot> {
        let record = {
            let mut transfers = self.transfers.write().await;
            match transfers.get(transfer_id) {
                Some(record) if !is_removable_transfer_state(&record.info.status) => {
                    return Err(AppError::InvalidInput(
                        "运行中的传输请先停止，再删除记录".to_string(),
                    ));
                }
                Some(_) => transfers.remove(transfer_id),
                None => None,
            }
        };
        if let Some(record) = record {
            cleanup_transfer_staging(&record.request, transfer_id, record.cleanup_sftp.as_deref())
                .await;
            crate::errors::forget_resource_label(transfer_id);
        }
        self.persist_transfer_history().await
    }

    pub async fn transfer_retry(
        &self,
        app: &AppHandle,
        transfer_id: &str,
    ) -> AppResult<TransferInfo> {
        let mut request = {
            let transfers = self.transfers.read().await;
            let record = transfers
                .get(transfer_id)
                .ok_or_else(|| AppError::missing_transfer(transfer_id))?;
            if !is_retryable_transfer_state(&record.info.status) {
                return Err(AppError::InvalidInput(
                    "只有失败或已取消的传输可以重试".to_string(),
                ));
            }
            record.request.clone()
        };
        request.resume = false;
        let next = self.start_transfer(app, request).await?;
        self.transfers.write().await.remove(transfer_id);
        crate::errors::forget_resource_label(transfer_id);
        self.persist_transfer_history_best_effort("retry transfer")
            .await;
        Ok(next)
    }

    pub(super) async fn cancel_transfer_in_place(
        &self,
        app: &AppHandle,
        transfer_id: &str,
        reason: &str,
    ) -> AppResult<TransferInfo> {
        let (info, request, cleanup_sftp, handle) = {
            let mut transfers = self.transfers.write().await;
            let record = transfers
                .get_mut(transfer_id)
                .ok_or_else(|| AppError::missing_transfer(transfer_id))?;
            record.cancel.store(true, Ordering::Relaxed);
            record.info.status = TaskStatus::Canceled;
            record.info.speed_kbps = 0.0;
            record.info.error = Some(reason.to_string());
            record.info.updated_at = now();
            (
                record.info.clone(),
                record.request.clone(),
                record.cleanup_sftp.clone(),
                record.handle.take(),
            )
        };
        abort_and_join_transfer_task(handle, transfer_id).await;
        cleanup_transfer_staging(&request, transfer_id, cleanup_sftp.as_deref()).await;
        events::emit(app, events::TRANSFER_FAILED, info.clone());
        crate::errors::forget_resource_label(transfer_id);
        Ok(info)
    }
    pub(super) async fn start_transfer(
        &self,
        app: &AppHandle,
        mut request: TransferRequest,
    ) -> AppResult<TransferInfo> {
        let _lifecycle_guard = self.lifecycle_gate.read().await;
        request.remote_path = normalize_remote_path(&request.remote_path);
        let sftp_record = self.sftp_record(&request.sftp_id).await?;
        let connection = self.connection(&sftp_record.info.connection_id).await?;
        let sftp = sftp_record.session.clone();
        let cleanup_sftp = match request.direction {
            TransferDirection::Upload => Some(sftp.clone()),
            TransferDirection::Download => None,
        };
        ensure_transfer_overwrite(&sftp, &request).await?;
        let bytes_total = transfer_total_bytes(&sftp, &request).await.unwrap_or(0);
        let info = TransferInfo {
            transfer_id: Uuid::new_v4().to_string(),
            session_id: connection.info.session_id,
            sftp_id: request.sftp_id.clone(),
            direction: request.direction.clone(),
            local_path: request.local_path.clone(),
            remote_path: request.remote_path.clone(),
            status: TaskStatus::Queued,
            bytes_done: 0,
            bytes_total,
            speed_kbps: 0.0,
            error: None,
            created_at: now(),
            updated_at: now(),
        };
        // Inherit the friendly session label from the parent SFTP session so "transfer not
        // found" logs show the session name instead of a UUID.
        if let Some(label) = crate::errors::resource_label(&info.sftp_id) {
            crate::errors::register_resource_label(&info.transfer_id, &label);
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let paused = Arc::new(AtomicBool::new(false));
        let runtime = self.clone();
        let app_handle = app.clone();
        let task_info = info.clone();
        let task_request = request.clone();
        let task_cancel = cancel.clone();
        let task_paused = paused.clone();
        let task_cleanup_sftp = cleanup_sftp.clone();
        let (start_sender, start_receiver) = oneshot::channel::<()>();
        let task = tokio::spawn(async move {
            // The record and its JoinHandle must be visible before any progress or
            // completion event can be emitted. Tiny files can otherwise finish in
            // the gap between spawn() and insertion and remain queued forever.
            if start_receiver.await.is_err() {
                return;
            }
            let result = run_transfer(
                &runtime,
                &app_handle,
                task_info.clone(),
                task_request.clone(),
                task_cancel,
                task_paused,
            )
            .await;
            if let Err(error) = result {
                cleanup_transfer_staging(
                    &task_request,
                    &task_info.transfer_id,
                    task_cleanup_sftp.as_deref(),
                )
                .await;
                runtime
                    .mark_transfer_failed(&app_handle, &task_info.transfer_id, error.to_string())
                    .await;
            }
        });
        let mut record = TransferRecord {
            info: info.clone(),
            request,
            cleanup_sftp,
            cancel,
            paused,
            handle: Some(task),
        };
        let sftp_sessions = self.sftp_sessions.read().await;
        let sftp_live = sftp_sessions
            .get(&info.sftp_id)
            .map(|record| !record.closed.load(Ordering::Acquire))
            .unwrap_or(false);
        if !sftp_live {
            drop(sftp_sessions);
            record.cancel.store(true, Ordering::Release);
            abort_and_join_transfer_task(record.handle.take(), &info.transfer_id).await;
            crate::errors::forget_resource_label(&info.transfer_id);
            return Err(AppError::missing_sftp(&info.sftp_id));
        }
        self.transfers
            .write()
            .await
            .insert(info.transfer_id.clone(), record);
        drop(sftp_sessions);
        events::emit(app, events::TRANSFER_PROGRESS, info.clone());
        self.persist_transfer_history_best_effort("start transfer")
            .await;
        if start_sender.send(()).is_err() {
            if let Some(mut record) = self.transfers.write().await.remove(&info.transfer_id) {
                record.cancel.store(true, Ordering::Release);
                abort_and_join_transfer_task(record.handle.take(), &info.transfer_id).await;
                cleanup_transfer_staging(
                    &record.request,
                    &info.transfer_id,
                    record.cleanup_sftp.as_deref(),
                )
                .await;
            }
            crate::errors::forget_resource_label(&info.transfer_id);
            self.persist_transfer_history_best_effort("rollback failed transfer start")
                .await;
            return Err(AppError::Remote("传输任务启动失败".to_string()));
        }
        Ok(info)
    }

    pub(super) async fn mark_transfer_progress(
        &self,
        app: &AppHandle,
        transfer_id: &str,
        bytes_done: u64,
        speed_kbps: f64,
    ) {
        if let Some(record) = self.transfers.write().await.get_mut(transfer_id) {
            if !accepts_transfer_activity(&record.info.status) {
                return;
            }
            let paused = record.paused.load(Ordering::Relaxed);
            record.info.status = if paused {
                TaskStatus::Paused
            } else {
                TaskStatus::Running
            };
            record.info.bytes_done = bytes_done;
            record.info.speed_kbps = if paused { 0.0 } else { speed_kbps };
            record.info.updated_at = now();
            events::emit(app, events::TRANSFER_PROGRESS, record.info.clone());
        }
    }

    pub(super) async fn mark_transfer_running(&self, app: &AppHandle, transfer_id: &str) {
        if let Some(record) = self.transfers.write().await.get_mut(transfer_id) {
            if !accepts_transfer_start(&record.info.status) {
                return;
            }
            let paused = record.paused.load(Ordering::Relaxed);
            record.info.status = if paused {
                TaskStatus::Paused
            } else {
                TaskStatus::Running
            };
            record.info.speed_kbps = 0.0;
            record.info.updated_at = now();
            events::emit(app, events::TRANSFER_PROGRESS, record.info.clone());
        }
    }

    pub(super) async fn mark_transfer_completed(&self, app: &AppHandle, transfer_id: &str) {
        if let Some(record) = self.transfers.write().await.get_mut(transfer_id) {
            if !accepts_transfer_activity(&record.info.status) {
                return;
            }
            record.info.status = TaskStatus::Completed;
            record.info.bytes_done = record.info.bytes_total;
            record.info.speed_kbps = 0.0;
            record.info.updated_at = now();
            events::emit(app, events::TRANSFER_COMPLETED, record.info.clone());
        }
        self.prune_transfer_history().await;
        self.persist_transfer_history_best_effort("complete transfer")
            .await;
    }

    pub(super) async fn mark_transfer_failed(
        &self,
        app: &AppHandle,
        transfer_id: &str,
        error: String,
    ) {
        if let Some(record) = self.transfers.write().await.get_mut(transfer_id) {
            if !accepts_transfer_activity(&record.info.status) {
                return;
            }
            record.info.status = TaskStatus::Failed;
            record.info.speed_kbps = 0.0;
            record.info.error = Some(error);
            record.info.updated_at = now();
            events::emit(app, events::TRANSFER_FAILED, record.info.clone());
        }
        self.prune_transfer_history().await;
        self.persist_transfer_history_best_effort("fail transfer")
            .await;
    }

    pub(super) async fn prune_transfer_history(&self) {
        let mut transfers = self.transfers.write().await;
        let mut finished: Vec<(String, String)> = transfers
            .iter()
            .filter(|(_, record)| {
                matches!(
                    record.info.status,
                    TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Canceled
                )
            })
            .map(|(id, record)| (id.clone(), record.info.updated_at.clone()))
            .collect();
        if finished.len() <= MAX_TRANSFER_HISTORY {
            return;
        }
        let remove_count = finished.len() - MAX_TRANSFER_HISTORY;
        finished.sort_by(|a, b| a.1.cmp(&b.1));
        for (id, _) in finished.into_iter().take(remove_count) {
            transfers.remove(&id);
            crate::errors::forget_resource_label(&id);
        }
    }
}

async fn abort_and_join_transfer_task(handle: Option<JoinHandle<()>>, transfer_id: &str) {
    let Some(handle) = handle else {
        return;
    };
    handle.abort();
    if let Err(error) = handle.await {
        if !error.is_cancelled() {
            eprintln!("[helm] transfer task failed while stopping {transfer_id}: {error}");
        }
    }
}

fn accepts_transfer_start(status: &TaskStatus) -> bool {
    matches!(status, TaskStatus::Queued | TaskStatus::Running)
}

fn accepts_transfer_activity(status: &TaskStatus) -> bool {
    matches!(
        status,
        TaskStatus::Queued | TaskStatus::Running | TaskStatus::Paused
    )
}

fn is_retryable_transfer_state(status: &TaskStatus) -> bool {
    matches!(status, TaskStatus::Failed | TaskStatus::Canceled)
}

fn is_removable_transfer_state(status: &TaskStatus) -> bool {
    matches!(
        status,
        TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Canceled
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_transfer_states_reject_late_activity_callbacks() {
        for status in [
            TaskStatus::Completed,
            TaskStatus::Failed,
            TaskStatus::Canceled,
        ] {
            assert!(!accepts_transfer_start(&status));
            assert!(!accepts_transfer_activity(&status));
        }
        assert!(accepts_transfer_start(&TaskStatus::Queued));
        assert!(accepts_transfer_activity(&TaskStatus::Paused));
    }

    #[test]
    fn only_failed_or_canceled_transfers_can_be_retried() {
        assert!(is_retryable_transfer_state(&TaskStatus::Failed));
        assert!(is_retryable_transfer_state(&TaskStatus::Canceled));
        assert!(!is_retryable_transfer_state(&TaskStatus::Queued));
        assert!(!is_retryable_transfer_state(&TaskStatus::Running));
        assert!(!is_retryable_transfer_state(&TaskStatus::Paused));
        assert!(!is_retryable_transfer_state(&TaskStatus::Completed));
    }

    #[test]
    fn only_finished_transfers_can_be_removed() {
        assert!(is_removable_transfer_state(&TaskStatus::Completed));
        assert!(is_removable_transfer_state(&TaskStatus::Failed));
        assert!(is_removable_transfer_state(&TaskStatus::Canceled));
        assert!(!is_removable_transfer_state(&TaskStatus::Queued));
        assert!(!is_removable_transfer_state(&TaskStatus::Running));
        assert!(!is_removable_transfer_state(&TaskStatus::Paused));
    }
}
