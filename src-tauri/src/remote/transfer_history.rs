use super::*;

const TRANSFER_HISTORY_VERSION: u16 = 1;
const TRANSFER_HISTORY_STOPPED_ERROR: &str = "程序已关闭，传输已停止";

impl RemoteRuntime {
    pub fn with_transfer_history_path(path: PathBuf) -> Self {
        Self {
            transfer_history_path: Arc::new(RwLock::new(Some(path))),
            ..Self::default()
        }
    }

    pub async fn load_transfer_history(&self) -> AppResult<()> {
        self.ensure_transfer_history_loaded().await
    }

    pub async fn transfer_history_snapshot(&self) -> AppResult<TransferHistorySnapshot> {
        self.ensure_transfer_history_loaded().await?;
        Ok(self.transfer_history_snapshot_from_memory().await)
    }

    pub async fn clear_finished_transfer_history(&self) -> AppResult<TransferHistorySnapshot> {
        self.ensure_transfer_history_loaded().await?;
        self.transfers.write().await.retain(|_, record| {
            matches!(
                record.info.status,
                TaskStatus::Queued | TaskStatus::Running | TaskStatus::Paused
            )
        });
        self.persist_transfer_history().await
    }

    pub(super) async fn persist_transfer_history(&self) -> AppResult<TransferHistorySnapshot> {
        let snapshot = self.transfer_history_snapshot_from_memory().await;
        if let Some(path) = self.transfer_history_path.read().await.clone() {
            if let Some(parent) = path.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|error| AppError::Io(error.to_string()))?;
            }
            let bytes = serde_json::to_vec_pretty(&snapshot)?;
            tokio::fs::write(path, bytes)
                .await
                .map_err(|error| AppError::Io(error.to_string()))?;
        }
        Ok(snapshot)
    }

    pub(super) async fn persist_transfer_history_best_effort(&self, context: &str) {
        if let Err(error) = self.persist_transfer_history().await {
            eprintln!("[helm] failed to persist transfer history after {context}: {error}");
        }
    }

    async fn ensure_transfer_history_loaded(&self) -> AppResult<()> {
        if self.transfer_history_loaded.load(Ordering::Relaxed) {
            return Ok(());
        }
        let _guard = self.transfer_history_load_lock.lock().await;
        if self.transfer_history_loaded.load(Ordering::Relaxed) {
            return Ok(());
        }

        let Some(path) = self.transfer_history_path.read().await.clone() else {
            self.transfer_history_loaded.store(true, Ordering::Relaxed);
            return Ok(());
        };
        let bytes = match tokio::fs::read(&path).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.transfer_history_loaded.store(true, Ordering::Relaxed);
                return Ok(());
            }
            Err(error) => return Err(AppError::Io(error.to_string())),
        };
        let snapshot: TransferHistorySnapshot = serde_json::from_slice(&bytes)?;
        if snapshot.version != TRANSFER_HISTORY_VERSION {
            self.transfer_history_loaded.store(true, Ordering::Relaxed);
            return Ok(());
        }
        let mut transfers = self.transfers.write().await;
        for info in snapshot
            .transfers
            .into_iter()
            .map(normalize_loaded_transfer)
        {
            let request = request_from_transfer(&info);
            transfers
                .entry(info.transfer_id.clone())
                .or_insert_with(|| TransferRecord {
                    info,
                    request,
                    cancel: Arc::new(AtomicBool::new(false)),
                    paused: Arc::new(AtomicBool::new(false)),
                    handle: None,
                });
        }
        self.transfer_history_loaded.store(true, Ordering::Relaxed);
        Ok(())
    }

    async fn transfer_history_snapshot_from_memory(&self) -> TransferHistorySnapshot {
        let mut transfers: Vec<TransferInfo> = self
            .transfers
            .read()
            .await
            .values()
            .map(|record| record.info.clone())
            .collect();
        transfers.sort_by(|left, right| {
            transfer_timestamp(right)
                .cmp(transfer_timestamp(left))
                .then_with(|| right.transfer_id.cmp(&left.transfer_id))
        });
        transfers.truncate(MAX_TRANSFER_HISTORY);
        TransferHistorySnapshot {
            version: TRANSFER_HISTORY_VERSION,
            saved_at: now(),
            transfers,
        }
    }
}

fn normalize_loaded_transfer(mut info: TransferInfo) -> TransferInfo {
    if matches!(
        info.status,
        TaskStatus::Queued | TaskStatus::Running | TaskStatus::Paused
    ) {
        info.status = TaskStatus::Canceled;
        info.speed_kbps = 0.0;
        info.error = Some(TRANSFER_HISTORY_STOPPED_ERROR.to_string());
        info.updated_at = now();
    } else if matches!(info.status, TaskStatus::Completed) {
        info.speed_kbps = 0.0;
    }
    info
}

fn request_from_transfer(info: &TransferInfo) -> TransferRequest {
    TransferRequest {
        sftp_id: info.sftp_id.clone(),
        direction: info.direction.clone(),
        local_path: info.local_path.clone(),
        remote_path: info.remote_path.clone(),
        overwrite: true,
        accelerated: false,
        resume: false,
    }
}

fn transfer_timestamp(info: &TransferInfo) -> &str {
    if info.updated_at.is_empty() {
        &info.created_at
    } else {
        &info.updated_at
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn transfer(id: usize, status: TaskStatus) -> TransferInfo {
        TransferInfo {
            transfer_id: format!("transfer-{id}"),
            session_id: "session-1".to_string(),
            sftp_id: "sftp-1".to_string(),
            direction: TransferDirection::Upload,
            local_path: format!("C:/tmp/{id}.txt"),
            remote_path: format!("/tmp/{id}.txt"),
            status,
            bytes_done: 0,
            bytes_total: 100,
            speed_kbps: 12.0,
            error: None,
            created_at: format!("2026-01-01T00:00:{id:03}Z"),
            updated_at: format!("2026-01-01T00:00:{id:03}Z"),
        }
    }

    #[test]
    fn normalize_loaded_transfer_cancels_active_records() {
        let info = normalize_loaded_transfer(transfer(1, TaskStatus::Running));
        assert_eq!(info.status, TaskStatus::Canceled);
        assert_eq!(info.speed_kbps, 0.0);
        assert_eq!(info.error.as_deref(), Some(TRANSFER_HISTORY_STOPPED_ERROR));
    }

    #[tokio::test]
    async fn transfer_history_snapshot_keeps_latest_100() {
        let runtime = RemoteRuntime::default();
        {
            let mut records = runtime.transfers.write().await;
            for id in 0..105 {
                let info = transfer(id, TaskStatus::Completed);
                records.insert(
                    info.transfer_id.clone(),
                    TransferRecord {
                        request: request_from_transfer(&info),
                        info,
                        cancel: Arc::new(AtomicBool::new(false)),
                        paused: Arc::new(AtomicBool::new(false)),
                        handle: None,
                    },
                );
            }
        }
        let snapshot = runtime.transfer_history_snapshot_from_memory().await;
        assert_eq!(snapshot.transfers.len(), 100);
        assert_eq!(snapshot.transfers[0].transfer_id, "transfer-104");
    }
}
