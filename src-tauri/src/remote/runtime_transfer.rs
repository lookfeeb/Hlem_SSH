use super::*;

impl RemoteRuntime {
    pub async fn transfer_upload(
        &self,
        app: &AppHandle,
        sftp_id: String,
        local_path: String,
        remote_path: String,
        overwrite: bool,
        accelerated: bool,
        resume: bool,
    ) -> AppResult<TransferInfo> {
        self.start_transfer(
            app,
            TransferRequest {
                sftp_id,
                direction: TransferDirection::Upload,
                local_path,
                remote_path,
                overwrite,
                accelerated,
                resume,
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
        let _ = self.persist_transfer_history().await;
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
        let _ = self.persist_transfer_history().await;
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
        let _ = self.persist_transfer_history().await;
        Ok(info)
    }

    pub async fn transfer_remove(
        &self,
        _app: &AppHandle,
        transfer_id: &str,
    ) -> AppResult<TransferHistorySnapshot> {
        if let Some(mut record) = self.transfers.write().await.remove(transfer_id) {
            if !matches!(
                record.info.status,
                TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Canceled
            ) {
                record.cancel.store(true, Ordering::Relaxed);
                if let Some(handle) = record.handle.take() {
                    handle.abort();
                }
            }
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
            transfers
                .get(transfer_id)
                .ok_or_else(|| AppError::missing_transfer(transfer_id))?
                .request
                .clone()
        };
        request.resume = true;
        let next = self.start_transfer(app, request).await?;
        self.transfers.write().await.remove(transfer_id);
        let _ = self.persist_transfer_history().await;
        Ok(next)
    }

    pub(super) async fn cancel_transfer_in_place(
        &self,
        app: &AppHandle,
        transfer_id: &str,
        reason: &str,
    ) -> AppResult<TransferInfo> {
        let mut transfers = self.transfers.write().await;
        let record = transfers
            .get_mut(transfer_id)
            .ok_or_else(|| AppError::missing_transfer(transfer_id))?;
        record.cancel.store(true, Ordering::Relaxed);
        if let Some(handle) = record.handle.take() {
            handle.abort();
        }
        record.info.status = TaskStatus::Canceled;
        record.info.speed_kbps = 0.0;
        record.info.error = Some(reason.to_string());
        record.info.updated_at = now();
        let info = record.info.clone();
        events::emit(app, events::TRANSFER_FAILED, info.clone());
        crate::errors::forget_resource_label(transfer_id);
        Ok(info)
    }
    pub(super) async fn start_transfer(
        &self,
        app: &AppHandle,
        mut request: TransferRequest,
    ) -> AppResult<TransferInfo> {
        request.remote_path = normalize_remote_path(&request.remote_path);
        let sftp_record = self.sftp_record(&request.sftp_id).await?;
        let connection = self.connection(&sftp_record.info.connection_id).await?;
        let sftp = sftp_record.session.clone();
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
        let task = tokio::spawn(async move {
            let result = run_transfer(
                &runtime,
                &app_handle,
                task_info.clone(),
                task_request,
                task_cancel,
                task_paused,
            )
            .await;
            if let Err(error) = result {
                runtime
                    .mark_transfer_failed(&app_handle, &task_info.transfer_id, error.to_string())
                    .await;
            }
        });
        self.transfers.write().await.insert(
            info.transfer_id.clone(),
            TransferRecord {
                info: info.clone(),
                request,
                cancel,
                paused,
                handle: Some(task),
            },
        );
        events::emit(app, events::TRANSFER_PROGRESS, info.clone());
        let _ = self.persist_transfer_history().await;
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
            record.info.status = TaskStatus::Completed;
            record.info.bytes_done = record.info.bytes_total;
            record.info.speed_kbps = 0.0;
            record.info.updated_at = now();
            events::emit(app, events::TRANSFER_COMPLETED, record.info.clone());
        }
        self.prune_transfer_history().await;
        let _ = self.persist_transfer_history().await;
    }

    pub(super) async fn mark_transfer_failed(
        &self,
        app: &AppHandle,
        transfer_id: &str,
        error: String,
    ) {
        if let Some(record) = self.transfers.write().await.get_mut(transfer_id) {
            record.info.status = TaskStatus::Failed;
            record.info.speed_kbps = 0.0;
            record.info.error = Some(error);
            record.info.updated_at = now();
            events::emit(app, events::TRANSFER_FAILED, record.info.clone());
        }
        self.prune_transfer_history().await;
        let _ = self.persist_transfer_history().await;
    }

    pub(super) async fn prune_transfer_history(&self) {
        let mut transfers = self.transfers.write().await;
        let mut finished: Vec<(String, String)> = transfers
            .iter()
            .filter_map(|(id, record)| {
                matches!(
                    record.info.status,
                    TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Canceled
                )
                .then(|| (id.clone(), record.info.updated_at.clone()))
            })
            .collect();
        if finished.len() <= MAX_TRANSFER_HISTORY {
            return;
        }
        let remove_count = finished.len() - MAX_TRANSFER_HISTORY;
        finished.sort_by(|a, b| a.1.cmp(&b.1));
        for (id, _) in finished.into_iter().take(remove_count) {
            transfers.remove(&id);
        }
    }
}
