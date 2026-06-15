use super::*;
use crate::api_server::{FileEntry, SessionItem};
use bytes::Bytes;
use futures_util::Stream;
use std::collections::VecDeque;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use tokio::io::AsyncRead;
use tokio::sync::mpsc;

/// 顺序拼接多个 worker 的 SFTP 字节流，用于 HTTP 并行下载响应。
/// 每个 worker 独立读取一个远端范围，主流按范围顺序输出并保留反压。
pub struct OrderedChunkStream {
    receivers: VecDeque<mpsc::Receiver<io::Result<Bytes>>>,
}

impl Stream for OrderedChunkStream {
    type Item = io::Result<Bytes>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        loop {
            match self.receivers.front_mut() {
                None => return Poll::Ready(None),
                Some(rx) => match rx.poll_recv(cx) {
                    Poll::Ready(Some(item)) => return Poll::Ready(Some(item)),
                    Poll::Ready(None) => {
                        // 当前 worker 通道关闭（正常完成或出错），切到下一个
                        self.receivers.pop_front();
                    }
                    Poll::Pending => return Poll::Pending,
                },
            }
        }
    }
}

/// 每个 worker 的 mpsc 通道深度（以 chunk 计，每 chunk 至多 buffer_size 字节）。
/// 4 worker × 4 槽 × 1MB = 最多 16MB 飞行内存，给客户端慢消费的反压预留空间。
const PER_WORKER_QUEUE_DEPTH: usize = 4;

async fn send_download_worker_error(
    tx: &mpsc::Sender<io::Result<Bytes>>,
    message: impl Into<String>,
) -> bool {
    let message = message.into();
    if tx
        .send(Err(io::Error::other(message.clone())))
        .await
        .is_ok()
    {
        true
    } else {
        log::debug!("parallel download worker could not report error: {message}");
        false
    }
}

impl RemoteRuntime {
    /// 由 AI API `connect-session` 调用：根据 vault 中的 SessionConfig 拉起 SSH
    /// 主连接，连接成功后顺手开 SFTP 子系统（与 UI 行为对齐）。
    ///
    /// **幂等**：底层 `connect_inner` 持 session 级锁并复用已存在的连接；
    /// SFTP 也只在该连接下还没开过的情况下才打开。重复调用是安全的。
    ///
    /// SFTP 打开失败不会让整个调用失败——SSH 已经连上，AI 仍然可以走 exec。
    /// SFTP 失败会落到 log::warn，让运维侧能看到。
    pub async fn api_connect_session(
        &self,
        app: &AppHandle,
        session: SessionConfig,
        known_host: Option<KnownHostEntry>,
    ) -> AppResult<ConnectionInfo> {
        let info = self.connect(app, session, known_host).await?;

        let already_has_sftp = {
            let sftp_sessions = self.sftp_sessions.read().await;
            sftp_sessions
                .values()
                .any(|record| record.info.connection_id == info.connection_id)
        };
        if !already_has_sftp {
            if let Err(error) = self.open_sftp(&info.connection_id).await {
                log::warn!(
                    "api_connect_session: SFTP 打开失败（SSH 仍连接）: {}",
                    error
                );
            }
        }
        Ok(info)
    }

    /// 由 AI API `disconnect-session` 调用：按 session_id 反查 connection_id
    /// 后走标准 disconnect 流程。会话本来就没连接 → 返回友好错误。
    pub async fn api_disconnect_session(
        &self,
        app: &AppHandle,
        session_id: &str,
    ) -> Result<(), String> {
        let connection_id = match self.find_connection_by_session(session_id).await {
            Some(record) => record.info.connection_id,
            None => return Err(format!("会话 {} 当前未连接", session_id)),
        };
        self.disconnect(app, &connection_id)
            .await
            .map_err(|e| e.to_string())
    }

    /// List all currently connected sessions with their SFTP availability.
    pub async fn list_connected_sessions(&self) -> Vec<SessionItem> {
        let connections = self.connections.read().await;
        let sftp_sessions = self.sftp_sessions.read().await;

        connections
            .values()
            .filter(|record| record.info.status == RuntimeStatus::Connected)
            .map(|record| {
                let has_sftp = sftp_sessions
                    .values()
                    .any(|sftp| sftp.info.connection_id == record.info.connection_id);
                SessionItem {
                    session_id: record.info.session_id.clone(),
                    name: record.info.username.clone() + "@" + &record.info.host,
                    host: format!("{}:{}", record.info.host, record.info.port),
                    connected: true,
                    sftp_available: has_sftp,
                }
            })
            .collect()
    }

    /// Execute a command on a connected session (by session_id). Used by HTTP REST `/api/exec`.
    pub async fn api_exec(
        &self,
        session_id: &str,
        command: &str,
        timeout_ms: u64,
    ) -> Result<ExecResult, String> {
        let connection_id = self.find_connection_for_session(session_id).await?;
        self.exec_on_connection(&connection_id, command.to_string(), Some(timeout_ms))
            .await
            .map_err(|e| e.to_string())
    }

    /// List files in a remote directory.
    pub async fn api_list_files(
        &self,
        session_id: &str,
        path: &str,
    ) -> Result<Vec<FileEntry>, String> {
        let sftp = self.find_sftp_for_session(session_id).await?;
        let entries = sftp
            .read_dir(path.to_string())
            .await
            .map_err(|e| format!("列出目录失败: {}", e))?;

        Ok(entries
            .into_iter()
            .filter(|e| {
                let name = e.file_name();
                name != "." && name != ".."
            })
            .map(|entry| {
                let name = entry.file_name();
                let file_type = entry.file_type();
                let size = entry.metadata().len();
                let ft = if file_type.is_dir() {
                    "directory"
                } else if file_type.is_symlink() {
                    "symlink"
                } else {
                    "file"
                };
                let entry_path = if path == "/" {
                    format!("/{}", name)
                } else {
                    format!("{}/{}", path.trim_end_matches('/'), name)
                };
                FileEntry {
                    name,
                    path: entry_path,
                    file_type: ft.to_string(),
                    size,
                }
            })
            .collect())
    }

    // ─── Internal helpers ──────────────────────────────────────────────────────

    async fn find_connection_for_session(&self, session_id: &str) -> Result<String, String> {
        let connections = self.connections.read().await;
        connections
            .values()
            .find(|record| {
                record.info.session_id == session_id
                    && record.info.status == RuntimeStatus::Connected
            })
            .map(|record| record.info.connection_id.clone())
            .ok_or_else(|| format!("会话 {} 未连接", session_id))
    }

    pub(crate) async fn find_sftp_for_session(
        &self,
        session_id: &str,
    ) -> Result<Arc<SftpSession>, String> {
        let connection_id = self.find_connection_for_session(session_id).await?;
        let sftp_sessions = self.sftp_sessions.read().await;
        let record = sftp_sessions
            .values()
            .find(|record| record.info.connection_id == connection_id)
            .ok_or_else(|| format!("会话 {} 没有可用的 SFTP 连接", session_id))?;
        Ok(record.next_transfer_session().await)
    }

    /// 流式上传：从任意 AsyncRead 直写到远端 SFTP 文件。
    ///
    /// 与 UI 的 `transfer_upload` 共用底层 `copy_async` 字节循环——同一份缓冲常量、
    /// 同一份 read/write 错误处理。这里不需要进度上报 / 暂停 / 历史，传 dummy 信号即可。
    ///
    /// 仍占用一个 `transfer_slots` 信号量名额，避免并发请求把 SFTP 通道打爆。
    pub async fn api_upload_stream<R: AsyncRead + Unpin + ?Sized>(
        &self,
        session_id: &str,
        remote_path: &str,
        reader: &mut R,
    ) -> Result<u64, String> {
        use std::sync::atomic::{AtomicBool, AtomicU64};
        let connection_id = self.find_connection_for_session(session_id).await?;
        let sftp_record = {
            let sftp_sessions = self.sftp_sessions.read().await;
            sftp_sessions
                .values()
                .find(|record| record.info.connection_id == connection_id)
                .cloned()
                .ok_or_else(|| format!("会话 {} 没有可用的 SFTP 连接", session_id))?
        };
        let _permit = sftp_record
            .transfer_slots
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| format!("获取传输配额失败: {}", e))?;
        let sftp = sftp_record.next_transfer_session().await;
        let normalized = normalize_remote_path(remote_path);
        let mut remote = sftp
            .open_with_flags(
                normalized,
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            )
            .await
            .map_err(|e| format!("打开远程文件失败: {}", e))?;

        // dummy 信号：API 路径没有 pause/cancel 概念（HTTP 请求生命周期已经覆盖了）
        let dummy_cancel = AtomicBool::new(false);
        let dummy_paused = AtomicBool::new(false);
        let bytes_done = AtomicU64::new(0);

        super::transfer::copy_async(
            reader,
            &mut remote,
            4 * 1024 * 1024,
            &dummy_cancel,
            &dummy_paused,
            &bytes_done,
        )
        .await
        .map_err(|e| e.to_string())?;

        Ok(bytes_done.load(std::sync::atomic::Ordering::Relaxed))
    }

    /// 多 File handle 并行流式下载。与 UI 拖拽下载共用阈值和缓冲策略，
    /// 这里的终点是 HTTP `Body::from_stream`。
    ///
    /// 调用方应在 `total_len >= PARALLEL_DOWNLOAD_THRESHOLD` 且 `parts >= 2` 时
    /// 才走这条路径；否则单 handle + ReaderStream 就够了。
    ///
    /// N 个 worker 各自读取一个范围，`OrderedChunkStream` 负责按范围顺序输出。
    pub async fn parallel_download_stream(
        &self,
        session_id: &str,
        path: String,
        start_offset: u64,
        total_len: u64,
        parts: u64,
        buffer_size: usize,
    ) -> Result<OrderedChunkStream, String> {
        if total_len == 0 {
            // 空 range（理论上调用方应避免走这里），返回空流即可
            return Ok(OrderedChunkStream {
                receivers: VecDeque::new(),
            });
        }

        let connection_id = self.find_connection_for_session(session_id).await?;
        let sftp_record = {
            let sftp_sessions = self.sftp_sessions.read().await;
            sftp_sessions
                .values()
                .find(|record| record.info.connection_id == connection_id)
                .cloned()
                .ok_or_else(|| format!("会话 {} 没有可用的 SFTP 连接", session_id))?
        };

        // 占用一个 transfer 配额，避免并行 worker 把通道挤爆。
        // 占用持续整个流式响应期间，由 worker 任务持有 permit；最后一个 worker
        // 退出后 permit 自动释放。
        let permit = sftp_record
            .transfer_slots
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| format!("获取传输配额失败: {}", e))?;
        let permit = Arc::new(permit);

        let parts = parts.max(2);
        let chunk_size = total_len / parts;
        let mut receivers: VecDeque<mpsc::Receiver<io::Result<Bytes>>> =
            VecDeque::with_capacity(parts as usize);

        log::info!(
            "API 并行下载启动：{} 字节 / {} 路 (chunk≈{} 字节)",
            total_len,
            parts,
            chunk_size
        );

        for i in 0..parts {
            let chunk_start = start_offset + i * chunk_size;
            let chunk_len = if i == parts - 1 {
                total_len - i * chunk_size
            } else {
                chunk_size
            };

            let (tx, rx) = mpsc::channel::<io::Result<Bytes>>(PER_WORKER_QUEUE_DEPTH);
            let task_sftp = sftp_record.next_transfer_session().await;
            let task_path = path.clone();
            let task_permit = permit.clone();

            tokio::spawn(async move {
                // permit 跟随 task 生命周期；最后一个 task 退出时 Arc 计数归零自动 drop。
                let _hold_permit = task_permit;

                let mut file = match task_sftp.open(task_path).await {
                    Ok(f) => f,
                    Err(e) => {
                        send_download_worker_error(&tx, format!("打开远程文件失败: {}", e)).await;
                        return;
                    }
                };

                if chunk_start > 0 {
                    use tokio::io::AsyncSeekExt;
                    if let Err(e) = file.seek(std::io::SeekFrom::Start(chunk_start)).await {
                        send_download_worker_error(&tx, format!("seek 远程文件失败: {}", e)).await;
                        return;
                    }
                }

                use tokio::io::AsyncReadExt;
                let mut remaining = chunk_len;
                let mut buf = vec![0u8; buffer_size];
                while remaining > 0 {
                    let to_read = std::cmp::min(remaining as usize, buf.len());
                    match file.read(&mut buf[..to_read]).await {
                        Ok(0) => {
                            if tx
                                .send(Err(io::Error::new(
                                    io::ErrorKind::UnexpectedEof,
                                    format!("远端文件提前结束：还差 {} 字节", remaining),
                                )))
                                .await
                                .is_err()
                            {
                                log::debug!(
                                    "parallel download worker could not report unexpected EOF"
                                );
                            }
                            return;
                        }
                        Ok(n) => {
                            let chunk = Bytes::copy_from_slice(&buf[..n]);
                            if tx.send(Ok(chunk)).await.is_err() {
                                log::debug!(
                                    "parallel download worker stopped because receiver closed"
                                );
                                return;
                            }
                            remaining -= n as u64;
                        }
                        Err(e) => {
                            send_download_worker_error(&tx, format!("读取远程文件失败: {}", e))
                                .await;
                            return;
                        }
                    }
                }
            });

            receivers.push_back(rx);
        }

        Ok(OrderedChunkStream { receivers })
    }

    /// Start a tunnel (port forward) based on a TunnelConfig. Returns (bind_host, bind_port, forward_id).
    pub async fn api_start_tunnel(
        &self,
        tunnel: &crate::config::TunnelConfig,
    ) -> Result<(String, u16, String), String> {
        let connection_id = self.find_connection_for_session(&tunnel.session_id).await?;
        let connection = self
            .connection(&connection_id)
            .await
            .map_err(|e| e.to_string())?;

        match tunnel.forward_type.as_str() {
            "local" => {
                let listener = TcpListener::bind((tunnel.bind_host.as_str(), tunnel.bind_port))
                    .await
                    .map_err(|e| format!("绑定端口失败: {}", e))?;
                let actual_port = listener
                    .local_addr()
                    .map_err(|e| format!("获取端口失败: {}", e))?
                    .port();
                let forward_id = Uuid::new_v4().to_string();
                let info = ForwardInfo {
                    forward_id: forward_id.clone(),
                    session_id: tunnel.session_id.clone(),
                    forward_type: ForwardType::Local,
                    bind_host: tunnel.bind_host.clone(),
                    bind_port: actual_port,
                    target_host: tunnel.target_host.clone(),
                    target_port: tunnel.target_port,
                    status: TaskStatus::Running,
                    started_at: now(),
                    error: None,
                };
                let handle = connection.handle.clone();
                let remote_host = tunnel.target_host.clone();
                let remote_port = tunnel.target_port;
                let task = tokio::spawn(async move {
                    while let Ok((stream, _)) = listener.accept().await {
                        let handle = handle.clone();
                        let host = remote_host.clone();
                        tokio::spawn(async move {
                            if let Err(error) =
                                pipe_local_to_ssh(stream, handle, host.clone(), remote_port).await
                            {
                                eprintln!(
                                    "[helm] API local tunnel connection failed: {host}:{remote_port}: {error}"
                                );
                            }
                        });
                    }
                });
                self.forwards.write().await.insert(
                    forward_id.clone(),
                    ForwardRecord {
                        info,
                        handle: Some(task),
                    },
                );
                Ok((tunnel.bind_host.clone(), actual_port, forward_id))
            }
            "dynamic" => {
                let listener = TcpListener::bind((tunnel.bind_host.as_str(), tunnel.bind_port))
                    .await
                    .map_err(|e| format!("绑定端口失败: {}", e))?;
                let actual_port = listener
                    .local_addr()
                    .map_err(|e| format!("获取端口失败: {}", e))?
                    .port();
                let forward_id = Uuid::new_v4().to_string();
                let info = ForwardInfo {
                    forward_id: forward_id.clone(),
                    session_id: tunnel.session_id.clone(),
                    forward_type: ForwardType::Dynamic,
                    bind_host: tunnel.bind_host.clone(),
                    bind_port: actual_port,
                    target_host: "SOCKS5".to_string(),
                    target_port: 0,
                    status: TaskStatus::Running,
                    started_at: now(),
                    error: None,
                };
                let handle = connection.handle.clone();
                let task = tokio::spawn(async move {
                    while let Ok((stream, _)) = listener.accept().await {
                        let handle = handle.clone();
                        tokio::spawn(async move {
                            if let Err(error) = handle_socks5(stream, handle).await {
                                eprintln!("[helm] API dynamic tunnel connection failed: {error}");
                            }
                        });
                    }
                });
                self.forwards.write().await.insert(
                    forward_id.clone(),
                    ForwardRecord {
                        info,
                        handle: Some(task),
                    },
                );
                Ok((tunnel.bind_host.clone(), actual_port, forward_id))
            }
            "remote" => {
                let target = RemoteForwardTarget {
                    local_host: tunnel.target_host.clone(),
                    local_port: tunnel.target_port,
                };
                connection
                    .remote_forwards
                    .write()
                    .await
                    .insert(forward_key(&tunnel.bind_host, tunnel.bind_port), target);
                let assigned_port = {
                    let handle = connection.handle.lock().await;
                    handle
                        .tcpip_forward(tunnel.bind_host.clone(), tunnel.bind_port as u32)
                        .await
                        .map_err(|e| format!("远程转发失败: {}", e))? as u16
                };
                let forward_id = Uuid::new_v4().to_string();
                let info = ForwardInfo {
                    forward_id: forward_id.clone(),
                    session_id: tunnel.session_id.clone(),
                    forward_type: ForwardType::Remote,
                    bind_host: tunnel.bind_host.clone(),
                    bind_port: assigned_port,
                    target_host: "local".to_string(),
                    target_port: tunnel.target_port,
                    status: TaskStatus::Running,
                    started_at: now(),
                    error: None,
                };
                self.forwards
                    .write()
                    .await
                    .insert(forward_id.clone(), ForwardRecord { info, handle: None });
                Ok((tunnel.bind_host.clone(), assigned_port, forward_id))
            }
            other => Err(format!("不支持的隧道类型: {}", other)),
        }
    }

    /// Stop a running tunnel by forward_id.
    pub async fn api_stop_tunnel(&self, forward_id: &str) -> Result<(), String> {
        let mut record = self
            .forwards
            .write()
            .await
            .remove(forward_id)
            .ok_or_else(|| format!("转发 {} 不存在或已停止", forward_id))?;
        if let Some(handle) = record.handle.take() {
            handle.abort();
        }
        if matches!(record.info.forward_type, ForwardType::Remote) {
            if let Some(connection) = self
                .find_connection_by_session(&record.info.session_id)
                .await
            {
                let handle = connection.handle.lock().await;
                if let Err(error) = handle
                    .cancel_tcpip_forward(
                        record.info.bind_host.clone(),
                        record.info.bind_port as u32,
                    )
                    .await
                {
                    eprintln!(
                        "[helm] failed to cancel API remote tunnel: {}:{}: {error}",
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
        record.info.status = TaskStatus::Canceled;
        Ok(())
    }
}
