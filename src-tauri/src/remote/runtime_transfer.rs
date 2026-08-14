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
        resume: bool,
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
                resume,
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
            self.cleanup_transfer_record_staging(&record).await;
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
        request.resume = true;
        let next = self.start_transfer(app, request).await?;
        let removed = self.transfers.write().await.remove(transfer_id);
        if let Some(record) = removed {
            self.cleanup_transfer_record_staging(&record).await;
        }
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
        let (info, handle, direction, staging_path, worker_parts, cleanup_sftp) = {
            let mut transfers = self.transfers.write().await;
            let record = transfers
                .get_mut(transfer_id)
                .ok_or_else(|| AppError::missing_transfer(transfer_id))?;
            if !accepts_transfer_activity(&record.info.status) {
                return Ok(record.info.clone());
            }
            record.cancel.store(true, Ordering::Relaxed);
            record.info.status = TaskStatus::Canceled;
            record.info.speed_kbps = 0.0;
            record.info.error = Some(reason.to_string());
            record.info.updated_at = now();
            (
                record.info.clone(),
                record.handle.take(),
                record.request.direction.clone(),
                record.staging_path.clone(),
                record.worker_parts,
                record.cleanup_sftp.clone(),
            )
        };
        let forced_abort = cancel_and_join_transfer_task(handle, transfer_id).await;
        if forced_abort && worker_parts > 1 {
            cleanup_transfer_staging(&direction, &staging_path, cleanup_sftp.as_deref()).await;
        }
        events::emit(app, events::TRANSFER_FAILED, info.clone());
        Ok(info)
    }
    pub(super) async fn start_transfer(
        &self,
        app: &AppHandle,
        mut request: TransferRequest,
    ) -> AppResult<TransferInfo> {
        let lifecycle_guard = self.lifecycle_gate.read().await;
        request.remote_path = normalize_remote_path(&request.remote_path);
        let sftp_record = self.sftp_record(&request.sftp_id).await?;
        let connection = self.connection(&sftp_record.info.connection_id).await?;
        let sftp = sftp_record.session.clone();
        let cleanup_sftp = match request.direction {
            TransferDirection::Upload => Some(sftp.clone()),
            TransferDirection::Download => None,
        };
        ensure_transfer_overwrite(&sftp, &request).await?;
        let source = transfer_source_state(&sftp, &request).await?;
        let session_id = connection.info.session_id;
        let staging_path = transfer_staging_path(&request, &session_id, &source);
        let worker_parts = transfer_worker_parts(&request, source.bytes_total);
        // Waiting for capacity must not hold the lifecycle read lock; otherwise
        // SFTP shutdown cannot acquire the write lock to cancel active work.
        drop(lifecycle_guard);
        let permit = sftp_record
            .transfer_slots
            .clone()
            .acquire_many_owned(worker_parts as u32)
            .await
            .map_err(remote_error)?;
        if sftp_record.closed.load(Ordering::Acquire) {
            return Err(AppError::missing_sftp(&request.sftp_id));
        }
        let info = TransferInfo {
            transfer_id: Uuid::new_v4().to_string(),
            session_id,
            sftp_id: request.sftp_id.clone(),
            direction: request.direction.clone(),
            local_path: request.local_path.clone(),
            remote_path: request.remote_path.clone(),
            status: TaskStatus::Queued,
            bytes_done: 0,
            bytes_total: source.bytes_total,
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
        let task_source = source.clone();
        let task_staging_path = staging_path.clone();
        let task_cancel = cancel.clone();
        let task_paused = paused.clone();
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
                task_request,
                task_source,
                task_staging_path,
                worker_parts,
                permit,
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
        let mut record = TransferRecord {
            info: info.clone(),
            request,
            staging_path: staging_path.clone(),
            worker_parts,
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
        let mut transfers = self.transfers.write().await;
        if transfers.values().any(|existing| {
            existing.staging_path == staging_path
                && accepts_transfer_activity(&existing.info.status)
        }) {
            drop(transfers);
            drop(sftp_sessions);
            record.cancel.store(true, Ordering::Release);
            abort_and_join_transfer_task(record.handle.take(), &info.transfer_id).await;
            crate::errors::forget_resource_label(&info.transfer_id);
            return Err(AppError::InvalidInput(
                "相同源文件和目标路径的传输任务正在进行".to_string(),
            ));
        }
        transfers.insert(info.transfer_id.clone(), record);
        drop(transfers);
        drop(sftp_sessions);
        events::emit(app, events::TRANSFER_PROGRESS, info.clone());
        self.persist_transfer_history_best_effort("start transfer")
            .await;
        if start_sender.send(()).is_err() {
            let removed = self.transfers.write().await.remove(&info.transfer_id);
            if let Some(mut record) = removed {
                record.cancel.store(true, Ordering::Release);
                abort_and_join_transfer_task(record.handle.take(), &info.transfer_id).await;
                self.cleanup_transfer_record_staging(&record).await;
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

    pub(super) async fn mark_transfer_completed(
        &self,
        app: &AppHandle,
        transfer_id: &str,
        completed_bytes: u64,
    ) {
        if let Some(record) = self.transfers.write().await.get_mut(transfer_id) {
            if !accepts_transfer_activity(&record.info.status) {
                return;
            }
            record.info.status = TaskStatus::Completed;
            record.info.bytes_done = completed_bytes;
            record.info.bytes_total = completed_bytes;
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
        let removed = {
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
                Vec::new()
            } else {
                let remove_count = finished.len() - MAX_TRANSFER_HISTORY;
                finished.sort_by(|a, b| a.1.cmp(&b.1));
                finished
                    .into_iter()
                    .take(remove_count)
                    .filter_map(|(id, _)| transfers.remove(&id).map(|record| (id, record)))
                    .collect::<Vec<_>>()
            }
        };
        for (id, record) in removed {
            self.cleanup_transfer_record_staging(&record).await;
            crate::errors::forget_resource_label(&id);
        }
    }

    pub(super) async fn cleanup_transfer_record_staging(&self, record: &TransferRecord) {
        if record.staging_path.is_empty() {
            return;
        }
        // Keep the read lock through deletion so a retry using the same stable
        // staging path cannot be inserted between the sharing check and cleanup.
        let transfers = self.transfers.read().await;
        let staging_in_use = transfers.iter().any(|(id, existing)| {
            id != &record.info.transfer_id && existing.staging_path == record.staging_path
        });
        if staging_in_use {
            return;
        }
        cleanup_transfer_staging(
            &record.request.direction,
            &record.staging_path,
            record.cleanup_sftp.as_deref(),
        )
        .await;
    }
}

fn transfer_worker_parts(request: &TransferRequest, bytes_total: u64) -> u64 {
    if request.resume || bytes_total == 0 {
        return 1;
    }
    let configured = match request.direction {
        TransferDirection::Upload if bytes_total >= PARALLEL_UPLOAD_THRESHOLD => {
            PARALLEL_UPLOAD_PARTS
        }
        TransferDirection::Download if bytes_total >= PARALLEL_DOWNLOAD_THRESHOLD => {
            PARALLEL_DOWNLOAD_PARTS
        }
        _ => 1,
    };
    configured
        .min(MAX_SFTP_TRANSFER_CONCURRENCY as u64)
        .min(bytes_total.max(1))
        .max(1)
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

async fn cancel_and_join_transfer_task(handle: Option<JoinHandle<()>>, transfer_id: &str) -> bool {
    const GRACE_TIMEOUT: Duration = Duration::from_secs(3);

    let Some(mut handle) = handle else {
        return false;
    };
    match timeout(GRACE_TIMEOUT, &mut handle).await {
        Ok(Ok(())) => false,
        Ok(Err(error)) if error.is_cancelled() => false,
        Ok(Err(error)) => {
            eprintln!("[helm] transfer task failed while canceling {transfer_id}: {error}");
            false
        }
        Err(_) => {
            handle.abort();
            if let Err(error) = handle.await {
                if !error.is_cancelled() {
                    eprintln!(
                        "[helm] transfer task failed after forced cancellation {transfer_id}: {error}"
                    );
                }
            }
            true
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

    #[test]
    fn large_fresh_transfers_reserve_every_parallel_worker_slot() {
        let mut request = TransferRequest {
            sftp_id: "sftp-1".to_string(),
            direction: TransferDirection::Upload,
            local_path: "C:/tmp/source.bin".to_string(),
            remote_path: "/tmp/target.bin".to_string(),
            overwrite: false,
            accelerated: true,
            resume: false,
        };
        assert_eq!(
            transfer_worker_parts(&request, PARALLEL_UPLOAD_THRESHOLD),
            PARALLEL_UPLOAD_PARTS
        );

        request.direction = TransferDirection::Download;
        assert_eq!(
            transfer_worker_parts(&request, PARALLEL_DOWNLOAD_THRESHOLD),
            PARALLEL_DOWNLOAD_PARTS
        );

        request.resume = true;
        assert_eq!(transfer_worker_parts(&request, u64::MAX), 1);
    }
}
