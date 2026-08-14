use super::*;

impl RemoteRuntime {
    pub async fn open_sftp(&self, connection_id: &str) -> AppResult<SftpInfo> {
        let _lifecycle_guard = self.lifecycle_gate.read().await;
        let open_lock = self.sftp_open_lock(connection_id).await;
        let _open_guard = open_lock.lock().await;
        if let Some(info) = self
            .sftp_sessions
            .read()
            .await
            .values()
            .find(|record| {
                record.info.connection_id == connection_id && !record.closed.load(Ordering::Acquire)
            })
            .map(|record| record.info.clone())
        {
            log::info!(
                "SFTP reuse: sftp_id={} connection_id={}",
                info.sftp_id,
                connection_id
            );
            return Ok(info);
        }

        let connection = self.connection(connection_id).await?;
        // Open only 1 SFTP channel immediately for fast startup
        let channel = self
            .open_session_channel_for_connection(&connection, true)
            .await?;
        let sftp = Arc::new(open_sftp_channel_from_channel(channel).await?);
        let info = SftpInfo {
            sftp_id: Uuid::new_v4().to_string(),
            connection_id: connection_id.to_string(),
            opened_at: now(),
        };
        if let Some(label) = crate::errors::resource_label(connection_id) {
            crate::errors::register_resource_label(&info.sftp_id, &label);
        }
        let transfer_sessions = Arc::new(RwLock::new(vec![sftp.clone()]));
        let closed = Arc::new(AtomicBool::new(false));
        let transfer_pool_ready = Arc::new(AtomicBool::new(false));
        let transfer_pool_notify = Arc::new(Notify::new());
        let transfer_pool_builder = Arc::new(StdMutex::new(None));
        let active_api_uploads = Arc::new(AtomicU64::new(0));
        let api_upload_notify = Arc::new(Notify::new());
        let (pool_start_tx, pool_start_rx) = oneshot::channel();
        let record = SftpRecord {
            info: info.clone(),
            session: sftp,
            transfer_sessions: transfer_sessions.clone(),
            transfer_cursor: Arc::new(Mutex::new(0)),
            transfer_slots: Arc::new(Semaphore::new(MAX_SFTP_TRANSFER_CONCURRENCY)),
            transfer_pool_ready: transfer_pool_ready.clone(),
            transfer_pool_notify: transfer_pool_notify.clone(),
            transfer_pool_builder: transfer_pool_builder.clone(),
            closed: closed.clone(),
            active_api_uploads,
            api_upload_notify,
        };

        // Register the builder before publishing the SFTP record. This closes
        // the window where close_sftp could remove the record while the
        // background task was not yet reachable for cancellation.
        let conn = connection.clone();
        let pool = transfer_sessions;
        let builder_closed = closed.clone();
        let builder_ready = transfer_pool_ready.clone();
        let builder_notify = transfer_pool_notify.clone();
        let pool_builder = tokio::spawn(async move {
            if pool_start_rx.await.is_err() {
                return;
            }
            let extra_count = SFTP_TRANSFER_POOL_SIZE - 1;
            let futures = (0..extra_count).map(|_| {
                let connection = conn.clone();
                async move { open_sftp_channel(&connection).await }
            });
            // These are ordinary futures, not detached Tokio tasks. Aborting
            // the builder therefore also drops every in-flight channel open.
            for result in futures_util::future::join_all(futures).await {
                if builder_closed.load(Ordering::Acquire) {
                    break;
                }
                if let Ok(session) = result {
                    let mut sessions = pool.write().await;
                    // Closing can win while this task waits for the pool lock.
                    // Re-check before publishing so a closed record never
                    // regains background transfer channels.
                    if builder_closed.load(Ordering::Acquire) {
                        break;
                    }
                    sessions.push(Arc::new(session));
                }
            }
            builder_ready.store(true, Ordering::Release);
            builder_notify.notify_waiters();
        });
        if !install_sftp_pool_builder(
            transfer_pool_builder.as_ref(),
            closed.as_ref(),
            pool_builder,
        ) {
            return Err(AppError::Remote(
                "SFTP 传输通道池已在启动期间关闭".to_string(),
            ));
        }
        self.sftp_sessions
            .write()
            .await
            .insert(info.sftp_id.clone(), record);
        log::info!(
            "SFTP opened: sftp_id={} connection_id={}",
            info.sftp_id,
            connection_id
        );

        // Let the already-registered task start only after the record is
        // visible. A concurrent close can now always find and abort it.
        if pool_start_tx.send(()).is_err() {
            if let Some(record) = self.sftp_sessions.write().await.remove(&info.sftp_id) {
                record.close().await;
            }
            crate::errors::forget_resource_label(&info.sftp_id);
            return Err(AppError::Remote(
                "SFTP 传输通道池启动任务异常结束".to_string(),
            ));
        }

        Ok(info)
    }

    pub async fn close_sftp(&self, app: &AppHandle, sftp_id: &str) -> AppResult<()> {
        let record = self
            .sftp_sessions
            .write()
            .await
            .remove(sftp_id)
            .ok_or_else(|| AppError::missing_sftp(sftp_id))?;
        record.begin_close();
        self.cancel_transfers_for_sftp_ids(app, &[sftp_id.to_string()], "SFTP 已关闭")
            .await;
        record.close().await;
        crate::errors::forget_resource_label(sftp_id);
        Ok(())
    }

    pub async fn sftp_list(&self, sftp_id: &str, path: String) -> AppResult<Vec<RemoteFileEntry>> {
        let sftp_record = self.sftp_record(sftp_id).await?;
        let sftp = sftp_record.session.clone();
        let normalized = normalize_remote_path(&path);
        let entries = sftp
            .read_dir(normalized.clone())
            .await
            .map_err(remote_error)?;
        Ok(entries
            .map(|entry| remote_entry(&normalized, entry.file_name(), entry.metadata()))
            .collect())
    }

    pub async fn sftp_search_file(
        &self,
        sftp_id: &str,
        base_path: String,
        query: String,
    ) -> AppResult<Option<String>> {
        let keyword = query.trim().to_lowercase();
        if keyword.is_empty() {
            return Ok(None);
        }

        let sftp_record = self.sftp_record(sftp_id).await?;
        let base_path = normalize_remote_path(&base_path);
        if let Ok(connection) = self.connection(&sftp_record.info.connection_id).await {
            if let Ok(Some(path)) =
                search_remote_file_with_find(&connection.handle, &base_path, &keyword).await
            {
                return Ok(Some(path));
            }
        }

        let sftp = sftp_record.session;
        let mut queue = VecDeque::from([base_path]);
        let mut visited = HashSet::new();
        let mut scanned_entries = 0usize;

        while !queue.is_empty()
            && visited.len() < MAX_SFTP_SEARCH_DIRS
            && scanned_entries < MAX_SFTP_SEARCH_ENTRIES
        {
            let mut requests = Vec::new();
            while requests.len() < MAX_SFTP_SEARCH_CONCURRENCY {
                let Some(directory) = queue.pop_front() else {
                    break;
                };
                if visited.contains(&directory) {
                    continue;
                }
                visited.insert(directory.clone());
                let sftp = sftp.clone();
                requests.push(async move {
                    let entries = sftp
                        .read_dir(directory.clone())
                        .await
                        .map_err(remote_error)
                        .map(|entries| {
                            entries
                                .map(|entry| {
                                    search_entry(&directory, entry.file_name(), entry.metadata())
                                })
                                .collect::<Vec<_>>()
                        });
                    (directory, entries)
                });
            }

            if requests.is_empty() {
                continue;
            }

            // Keep directory reads concurrent without detaching Tokio tasks.
            // Returning early after a match now drops no background work.
            for (directory, entries) in futures_util::future::join_all(requests).await {
                let Ok(entries) = entries else {
                    continue;
                };
                for entry in entries {
                    scanned_entries += 1;
                    if entry.name.to_lowercase().contains(&keyword) {
                        return Ok(Some(entry.path));
                    }
                    if entry.is_directory
                        && entry.path != directory
                        && !visited.contains(&entry.path)
                    {
                        queue.push_back(entry.path);
                    }
                    if scanned_entries >= MAX_SFTP_SEARCH_ENTRIES {
                        break;
                    }
                }
            }
        }

        Ok(None)
    }

    pub async fn sftp_resolve_target(
        &self,
        sftp_id: &str,
        current_path: String,
        source_path: String,
        value: String,
    ) -> AppResult<String> {
        let sftp = self.sftp_session(sftp_id).await?;
        let target = resolve_remote_target_path(&current_path, &value);
        let is_directory = target == "/"
            || sftp
                .symlink_metadata(target.clone())
                .await
                .map(|metadata| metadata.file_type().is_dir())
                .unwrap_or(false);
        if is_directory {
            let name = remote_base_name(&source_path);
            if name.is_empty() {
                return Ok(target);
            }
            return Ok(normalize_remote_path(&join_remote_path(&target, &name)));
        }
        Ok(target)
    }

    pub async fn sftp_mkdir(&self, app: &AppHandle, sftp_id: &str, path: String) -> AppResult<()> {
        let path = normalize_remote_path(&path);
        self.run_sftp_file_command(sftp_id, build_remote_mkdir_command(&path), "创建目录")
            .await?;
        emit_sftp_changed(app, sftp_id, &path);
        Ok(())
    }

    pub async fn sftp_create_file(
        &self,
        app: &AppHandle,
        sftp_id: &str,
        path: String,
    ) -> AppResult<()> {
        let path = normalize_remote_path(&path);
        self.run_sftp_file_command(sftp_id, build_remote_create_file_command(&path), "创建文件")
            .await?;
        emit_sftp_changed(app, sftp_id, &path);
        Ok(())
    }

    pub async fn sftp_delete(
        &self,
        app: &AppHandle,
        sftp_id: &str,
        path: String,
        recursive: bool,
    ) -> AppResult<()> {
        let path = normalize_remote_path(&path);
        ensure_not_root_path(&path, "不能删除根目录")?;
        self.run_sftp_file_command(
            sftp_id,
            build_remote_delete_command(&path, recursive),
            "删除",
        )
        .await?;
        emit_sftp_changed(app, sftp_id, &path);
        Ok(())
    }

    pub async fn sftp_rename(
        &self,
        app: &AppHandle,
        sftp_id: &str,
        from: String,
        to: String,
    ) -> AppResult<()> {
        let from = normalize_remote_path(&from);
        let to = normalize_remote_path(&to);
        ensure_not_root_path(&from, "不能移动根目录")?;
        if from == to {
            return Ok(());
        }
        ensure_not_same_or_child_path(&from, &to, "不能把目录移动到自身或子目录")?;
        self.run_sftp_file_command(sftp_id, build_remote_rename_command(&from, &to), "移动")
            .await?;
        emit_sftp_changed(app, sftp_id, &from);
        emit_sftp_changed(app, sftp_id, &to);
        Ok(())
    }

    pub async fn sftp_copy(
        &self,
        app: &AppHandle,
        sftp_id: &str,
        from: String,
        to: String,
    ) -> AppResult<()> {
        let from = normalize_remote_path(&from);
        let to = normalize_remote_path(&to);
        ensure_not_root_path(&from, "不能复制根目录")?;
        if from == to {
            return Ok(());
        }
        ensure_not_same_or_child_path(&from, &to, "不能把目录复制到自身或子目录")?;
        self.run_sftp_file_command(sftp_id, build_remote_copy_command(&from, &to), "复制")
            .await?;
        emit_sftp_changed(app, sftp_id, &from);
        emit_sftp_changed(app, sftp_id, &to);
        Ok(())
    }

    pub async fn sftp_read_text(&self, sftp_id: &str, path: String) -> AppResult<String> {
        let sftp = self.sftp_session(sftp_id).await?;
        let path = normalize_remote_path(&path);
        let metadata = sftp.metadata(path.clone()).await.map_err(remote_error)?;
        let size = metadata.len();
        if size > MAX_TEXT_EDIT_BYTES {
            return Err(AppError::InvalidInput(
                "文件超过 10MB，暂不支持直接编辑".to_string(),
            ));
        }
        let mut remote = sftp.open(path).await.map_err(remote_error)?;
        remote.set_read_limit(size).map_err(remote_error)?;
        let mut data = Vec::with_capacity(size as usize);
        remote.read_to_end(&mut data).await.map_err(remote_error)?;
        remote.shutdown().await.map_err(remote_error)?;
        String::from_utf8(data)
            .map_err(|_| AppError::InvalidInput("只支持 UTF-8 文本文件编辑".to_string()))
    }

    pub async fn sftp_exists(&self, sftp_id: &str, path: String) -> AppResult<bool> {
        let sftp = self.sftp_session(sftp_id).await?;
        sftp.try_exists(normalize_remote_path(&path))
            .await
            .map_err(remote_error)
    }

    pub async fn sftp_write_text(
        &self,
        app: &AppHandle,
        sftp_id: &str,
        path: String,
        content: String,
    ) -> AppResult<()> {
        let sftp = self.sftp_session(sftp_id).await?;
        let path = normalize_remote_path(&path);
        if content.len() as u64 > MAX_TEXT_EDIT_BYTES {
            return Err(AppError::InvalidInput(
                "文件超过 10MB，暂不支持直接编辑".to_string(),
            ));
        }
        let temp_path = format!("{path}.helm-{}.part", Uuid::new_v4());
        let result = async {
            let mut remote = sftp
                .open_with_flags(
                    temp_path.clone(),
                    OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
                )
                .await
                .map_err(remote_error)?;
            remote
                .write_all(content.as_bytes())
                .await
                .map_err(remote_error)?;
            remote.flush().await.map_err(remote_error)?;
            remote.shutdown().await.map_err(remote_error)?;
            let size = sftp
                .metadata(temp_path.clone())
                .await
                .map_err(remote_error)?
                .len();
            if size != content.len() as u64 {
                return Err(AppError::Remote("编辑内容写入校验失败".to_string()));
            }
            self.replace_remote_file(sftp_id, &temp_path, &path).await
        }
        .await;
        if result.is_err() {
            let _ = sftp.remove_file(temp_path.clone()).await;
        }
        result?;
        emit_sftp_changed(app, sftp_id, &path);
        Ok(())
    }

    pub(super) async fn replace_remote_file(
        &self,
        sftp_id: &str,
        from: &str,
        to: &str,
    ) -> AppResult<()> {
        let connection_id = self.sftp_record(sftp_id).await?.info.connection_id;
        let result = self
            .exec_on_connection(
                &connection_id,
                build_remote_replace_command(from, to),
                Some(SFTP_FILE_OPERATION_TIMEOUT_MS),
            )
            .await?;
        ensure_remote_file_command_success(result, "替换远端文件")
    }

    async fn run_sftp_file_command(
        &self,
        sftp_id: &str,
        command: String,
        action: &str,
    ) -> AppResult<()> {
        let connection_id = self.sftp_record(sftp_id).await?.info.connection_id;
        let result = self
            .exec_on_connection(
                &connection_id,
                command,
                Some(SFTP_FILE_OPERATION_TIMEOUT_MS),
            )
            .await?;
        ensure_remote_file_command_success(result, action)
    }
}

async fn open_sftp_channel(connection: &ConnectionRecord) -> AppResult<SftpSession> {
    let channel = open_session_channel(&connection.handle).await?;
    open_sftp_channel_from_channel(channel).await
}

fn install_sftp_pool_builder(
    slot: &StdMutex<Option<JoinHandle<()>>>,
    closed: &AtomicBool,
    builder: JoinHandle<()>,
) -> bool {
    let mut slot = lock_unpoisoned(slot, "SFTP transfer pool task registry");
    if closed.load(Ordering::Acquire) {
        builder.abort();
        return false;
    }
    if let Some(previous) = slot.replace(builder) {
        previous.abort();
    }
    true
}

async fn open_sftp_channel_from_channel(channel: Channel<client::Msg>) -> AppResult<SftpSession> {
    run_ssh_channel_control("启动 SFTP 子系统", channel.request_subsystem(true, "sftp")).await?;
    match timeout(
        Duration::from_secs(SFTP_REQUEST_TIMEOUT_SECS),
        SftpSession::new_with_config(
            channel.into_stream(),
            SftpClientConfig {
                request_timeout_secs: SFTP_REQUEST_TIMEOUT_SECS,
                ..Default::default()
            },
        ),
    )
    .await
    {
        Ok(result) => result.map_err(remote_error),
        Err(_) => Err(AppError::Remote("初始化 SFTP 会话超时".to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn pool_builder_registered_after_close_is_aborted() {
        let slot = StdMutex::new(None);
        let closed = AtomicBool::new(true);
        let task = tokio::spawn(std::future::pending::<()>());
        let abort_handle = task.abort_handle();

        assert!(!install_sftp_pool_builder(&slot, &closed, task));
        tokio::task::yield_now().await;

        assert!(abort_handle.is_finished());
        assert!(slot.lock().unwrap().is_none());
    }
}
