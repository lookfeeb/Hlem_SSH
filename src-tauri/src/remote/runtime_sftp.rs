use super::*;

impl RemoteRuntime {
    pub async fn open_sftp(&self, connection_id: &str) -> AppResult<SftpInfo> {
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
        let record = SftpRecord {
            info: info.clone(),
            session: sftp,
            transfer_sessions: transfer_sessions.clone(),
            transfer_cursor: Arc::new(Mutex::new(0)),
            transfer_slots: Arc::new(Semaphore::new(MAX_SFTP_TRANSFER_CONCURRENCY)),
        };
        self.sftp_sessions
            .write()
            .await
            .insert(info.sftp_id.clone(), record);

        // Expand the transfer pool in the background (non-blocking)
        let conn = connection.clone();
        let pool = transfer_sessions;
        tokio::spawn(async move {
            let extra_count = SFTP_TRANSFER_POOL_SIZE - 1;
            let mut futures = Vec::with_capacity(extra_count);
            for _ in 0..extra_count {
                let c = conn.clone();
                futures.push(tokio::spawn(async move { open_sftp_channel(&c).await }));
            }
            for future in futures {
                if let Ok(Ok(session)) = future.await {
                    pool.write().await.push(Arc::new(session));
                }
            }
        });

        Ok(info)
    }

    pub async fn sftp_list(&self, sftp_id: &str, path: String) -> AppResult<Vec<RemoteFileEntry>> {
        let sftp_record = self.sftp_record(sftp_id).await?;
        let sftp = sftp_record.session.clone();
        let normalized = normalize_remote_path(&path);
        let entries = sftp
            .read_dir(normalized.clone())
            .await
            .map_err(remote_error)?;
        let entries: Vec<_> = entries.collect();
        let owner_lookup =
            if let Ok(connection) = self.connection(&sftp_record.info.connection_id).await {
                resolve_owner_lookup(&connection.handle, &entries)
                    .await
                    .unwrap_or_default()
            } else {
                OwnerLookup::default()
            };
        Ok(entries
            .into_iter()
            .map(|entry| {
                remote_entry(
                    &normalized,
                    entry.file_name(),
                    entry.metadata(),
                    &owner_lookup,
                )
            })
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
            let mut handles = Vec::new();
            while handles.len() < MAX_SFTP_SEARCH_CONCURRENCY {
                let Some(directory) = queue.pop_front() else {
                    break;
                };
                if visited.contains(&directory) {
                    continue;
                }
                visited.insert(directory.clone());
                let sftp = sftp.clone();
                handles.push(tokio::spawn(async move {
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
                }));
            }

            if handles.is_empty() {
                continue;
            }

            for handle in handles {
                let Ok((directory, entries)) = handle.await else {
                    continue;
                };
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
        self.run_sftp_file_command(
            sftp_id,
            build_remote_create_file_command(&path),
            "创建文件",
        )
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
        self.run_sftp_file_command(
            sftp_id,
            build_remote_rename_command(&from, &to),
            "移动",
        )
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
        let remote = sftp.open(path).await.map_err(remote_error)?;
        let mut data = Vec::with_capacity(size as usize);
        remote
            .take(size)
            .read_to_end(&mut data)
            .await
            .map_err(remote_error)?;
        String::from_utf8(data)
            .map_err(|_| AppError::InvalidInput("只支持 UTF-8 文本文件编辑".to_string()))
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
        let mut remote = sftp
            .open_with_flags(
                path.clone(),
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            )
            .await
            .map_err(remote_error)?;
        remote
            .write_all(content.as_bytes())
            .await
            .map_err(remote_error)?;
        remote.flush().await.map_err(remote_error)?;
        emit_sftp_changed(app, sftp_id, &path);
        Ok(())
    }

    async fn run_sftp_file_command(
        &self,
        sftp_id: &str,
        command: String,
        action: &str,
    ) -> AppResult<()> {
        let connection_id = self.sftp_record(sftp_id).await?.info.connection_id;
        let result = self
            .exec_on_connection(&connection_id, command, Some(SFTP_FILE_OPERATION_TIMEOUT_MS))
            .await?;
        ensure_remote_file_command_success(result, action)
    }
}

async fn open_sftp_channel(connection: &ConnectionRecord) -> AppResult<SftpSession> {
    let channel = open_session_channel(&connection.handle).await?;
    open_sftp_channel_from_channel(channel).await
}

async fn open_sftp_channel_from_channel(channel: Channel<client::Msg>) -> AppResult<SftpSession> {
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(remote_error)?;
    SftpSession::new(channel.into_stream())
        .await
        .map_err(remote_error)
}
