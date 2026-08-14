use super::runtime_connection::connection_record_is_closed;
use super::*;
use crate::api_server::FileEntry;
use bytes::Bytes;
use futures_util::Stream;
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt, ReadBuf};
use tokio::sync::{mpsc, OwnedSemaphorePermit};
use tokio_util::io::ReaderStream;

pub struct SftpDownloadStream {
    inner: Pin<Box<dyn Stream<Item = io::Result<Bytes>> + Send>>,
    _permit: OwnedSemaphorePermit,
    closed: Arc<AtomicBool>,
    remaining: u64,
    stopped: bool,
}

struct Sha256Reader<'a, R: AsyncRead + Unpin + ?Sized> {
    inner: &'a mut R,
    hasher: Option<Sha256>,
}

impl<'a, R: AsyncRead + Unpin + ?Sized> Sha256Reader<'a, R> {
    fn new(inner: &'a mut R, enabled: bool) -> Self {
        Self {
            inner,
            hasher: enabled.then(Sha256::new),
        }
    }

    fn finish(self) -> Option<String> {
        self.hasher.map(|hasher| hex::encode(hasher.finalize()))
    }
}

impl<R: AsyncRead + Unpin + ?Sized> AsyncRead for Sha256Reader<'_, R> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let result = Pin::new(&mut *self.inner).poll_read(cx, buf);
        if matches!(result, Poll::Ready(Ok(()))) {
            if let Some(hasher) = self.hasher.as_mut() {
                hasher.update(&buf.filled()[before..]);
            }
        }
        result
    }
}

fn api_file_entry(parent: &str, name: String, metadata: FileAttributes) -> FileEntry {
    let entry = super::sftp::remote_entry(parent, name, metadata);
    let file_type = match entry.file_type {
        RemoteFileType::Directory => "directory",
        RemoteFileType::Symlink => "symlink",
        RemoteFileType::File => "file",
        RemoteFileType::Other => "other",
    };
    FileEntry {
        name: entry.name,
        path: entry.path,
        file_type: file_type.to_string(),
        size: entry.size,
        modified_at: entry.modified_at,
        permissions: entry.permissions,
        owner: entry.owner,
    }
}

impl Stream for SftpDownloadStream {
    type Item = io::Result<Bytes>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.stopped {
            return Poll::Ready(None);
        }
        if self.remaining == 0 {
            self.stopped = true;
            return Poll::Ready(None);
        }
        if self.closed.load(Ordering::Acquire) {
            self.stopped = true;
            return Poll::Ready(Some(Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "SFTP 已关闭，下载已取消",
            ))));
        }
        match self.inner.as_mut().poll_next(cx) {
            Poll::Ready(Some(Ok(bytes))) => {
                let read = bytes.len() as u64;
                if read > self.remaining {
                    self.stopped = true;
                    return Poll::Ready(Some(Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "远端下载流返回了超出请求范围的数据",
                    ))));
                }
                self.remaining -= read;
                Poll::Ready(Some(Ok(bytes)))
            }
            Poll::Ready(Some(Err(error))) => {
                self.stopped = true;
                Poll::Ready(Some(Err(error)))
            }
            Poll::Ready(None) if self.remaining > 0 => {
                let remaining = self.remaining;
                self.remaining = 0;
                self.stopped = true;
                Poll::Ready(Some(Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    format!("远端文件提前结束：还差 {remaining} 字节"),
                ))))
            }
            Poll::Ready(None) => {
                self.stopped = true;
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

/// 顺序拼接多个 worker 的 SFTP 字节流，用于 HTTP 并行下载响应。
/// 每个 worker 独立读取一个远端范围，主流按范围顺序输出并保留反压。
pub struct OrderedChunkStream {
    receivers: VecDeque<mpsc::Receiver<io::Result<Bytes>>>,
    workers: Vec<JoinHandle<()>>,
}

impl Stream for OrderedChunkStream {
    type Item = io::Result<Bytes>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        loop {
            match self.receivers.front_mut() {
                None => {
                    abort_download_workers(&mut self.workers);
                    return Poll::Ready(None);
                }
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

impl Drop for OrderedChunkStream {
    fn drop(&mut self) {
        abort_download_workers(&mut self.workers);
    }
}

fn abort_download_workers(workers: &mut Vec<JoinHandle<()>>) {
    for worker in workers.drain(..) {
        worker.abort();
    }
}

/// 每个 worker 的 mpsc 通道深度（以 chunk 计，每 chunk 至多 buffer_size 字节）。
/// 4 worker × 4 槽 × 1MB = 最多 16MB 飞行内存，给客户端慢消费的反压预留空间。
const PER_WORKER_QUEUE_DEPTH: usize = 4;
const API_TRANSFER_QUEUE_TIMEOUT: Duration = Duration::from_secs(3);

struct RemoteTempFileGuard {
    sftp: Arc<SftpSession>,
    path: Option<String>,
    active_upload: Option<ActiveApiUploadGuard>,
}

impl RemoteTempFileGuard {
    fn new(sftp: Arc<SftpSession>, path: String, active_upload: ActiveApiUploadGuard) -> Self {
        Self {
            sftp,
            path: Some(path),
            active_upload: Some(active_upload),
        }
    }

    fn disarm(&mut self) {
        self.path = None;
        self.active_upload = None;
    }

    async fn cleanup(&mut self) {
        let Some(path) = self.path.clone() else {
            self.active_upload = None;
            return;
        };
        let _ = self.sftp.remove_file(path).await;
        self.path = None;
        self.active_upload = None;
    }
}

impl Drop for RemoteTempFileGuard {
    fn drop(&mut self) {
        let Some(path) = self.path.take() else {
            return;
        };
        let sftp = self.sftp.clone();
        let active_upload = self.active_upload.take();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                // Keep the SFTP close barrier active until the best-effort
                // cleanup finishes. This matters when the HTTP request future
                // is dropped by a disconnected client.
                let _active_upload = active_upload;
                let _ = sftp.remove_file(path).await;
            });
        }
    }
}

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
    /// 主连接。自动化连接不触发 UI 的终端/SFTP 初始化，避免 IDE/AI 请求
    /// 与交互界面争用同一条 SSH 连接；文件端点会在真正需要时按需打开 SFTP。
    ///
    /// **幂等**：底层 `connect_inner` 持 session 级锁并复用已存在的连接；
    /// 重复调用会复用已存在的连接。
    pub async fn api_connect_session(
        &self,
        app: &AppHandle,
        session: SessionConfig,
        known_host: Option<KnownHostEntry>,
    ) -> AppResult<ConnectionInfo> {
        self.connect_automation(app, session, known_host).await
    }

    pub async fn api_session_status(&self, session_id: &str) -> (bool, bool) {
        let connection_id = {
            let connections = self.connections.read().await;
            connections
                .values()
                .find(|record| {
                    record.info.session_id == session_id
                        && record.origin == ConnectionOrigin::Automation
                        && record.info.status == RuntimeStatus::Connected
                        && !connection_record_is_closed(record)
                })
                .map(|record| record.info.connection_id.clone())
        };
        let Some(connection_id) = connection_id else {
            return (false, false);
        };
        let sftp_available = self.sftp_sessions.read().await.values().any(|record| {
            record.info.connection_id == connection_id && !record.closed.load(Ordering::Acquire)
        });
        (true, sftp_available)
    }

    pub async fn api_session_statuses(&self) -> HashMap<String, ApiSessionStatus> {
        let connections = {
            let connections = self.connections.read().await;
            connections
                .values()
                .filter(|record| {
                    record.origin == ConnectionOrigin::Automation
                        && !connection_record_is_closed(record)
                })
                .map(|record| record.info.clone())
                .collect::<Vec<_>>()
        };
        let sftp_connections = {
            let sessions = self.sftp_sessions.read().await;
            sessions
                .values()
                .filter(|record| !record.closed.load(Ordering::Acquire))
                .map(|record| record.info.connection_id.clone())
                .collect::<HashSet<_>>()
        };
        connections
            .into_iter()
            .map(|info| {
                let sftp_available = sftp_connections.contains(&info.connection_id);
                (
                    info.session_id.clone(),
                    ApiSessionStatus {
                        connected: info.status == RuntimeStatus::Connected,
                        sftp_available,
                        connection_id: info.connection_id,
                        status: info.status,
                        connected_at: info.connected_at,
                    },
                )
            })
            .collect()
    }

    pub async fn api_ensure_sftp(&self, session_id: &str) -> Result<(), String> {
        let connection_id = self
            .find_connection_for_session(session_id, ConnectionOrigin::Automation)
            .await?;
        self.open_sftp(&connection_id)
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    pub async fn api_probe_latency(
        &self,
        session_id: &str,
        samples: Option<u8>,
    ) -> Result<LatencyProbeResult, String> {
        let connection_id = self
            .find_connection_for_session(session_id, ConnectionOrigin::Automation)
            .await?;
        self.probe_latency(&connection_id, samples)
            .await
            .map_err(|error| error.to_string())
    }

    /// 由 AI API `disconnect-session` 调用：按 session_id 反查 connection_id
    /// 后走标准 disconnect 流程。会话本来就没连接 → 返回友好错误。
    pub async fn api_disconnect_session(
        &self,
        app: &AppHandle,
        session_id: &str,
    ) -> Result<(), String> {
        let connection_id = match self
            .find_connection_by_session(session_id, ConnectionOrigin::Automation)
            .await
        {
            Some(record) => record.info.connection_id,
            None => return Err(format!("会话 {} 当前未连接", session_id)),
        };
        self.disconnect_automation(app, &connection_id)
            .await
            .map_err(|e| e.to_string())
    }

    /// Execute a command on a connected session (by session_id). Used by HTTP REST `/api/exec`.
    pub async fn api_exec(
        &self,
        session_id: &str,
        command: &str,
        timeout_ms: u64,
    ) -> Result<ExecResult, String> {
        let started = Instant::now();
        let connection_id = self
            .find_connection_for_session(session_id, ConnectionOrigin::Automation)
            .await?;
        let connection = self
            .connection(&connection_id)
            .await
            .map_err(|error| error.to_string())?;
        let handle = connection.handle.clone();
        let tracker = connection.exec_process_tracker.clone();
        let (channel_result, tracked_process_groups) = tokio::join!(
            self.open_exec_channel_for_connection(&connection, true),
            tracker.supports_process_groups(&handle)
        );
        let (channel, channel_open_ms) = channel_result.map_err(|error| error.to_string())?;
        let execution = if tracked_process_groups {
            exec_tracked_with_channel_output_limit(
                channel,
                build_tracked_exec_command(handle, command.to_string()),
                timeout_ms,
                MAX_API_EXEC_OUTPUT_BYTES,
            )
            .await
        } else {
            exec_with_channel_output_limit(
                channel,
                command.to_string(),
                timeout_ms,
                MAX_API_EXEC_OUTPUT_BYTES,
            )
            .await
        };
        let mut result = execution.map_err(|error| error.to_string())?;
        result.channel_open_ms = channel_open_ms;
        result.duration_ms = started.elapsed().as_millis();
        Ok(result)
    }

    /// Execute a command while forwarding stdout/stderr chunks to the caller.
    /// Cancellation terminates the tracked remote process group without affecting
    /// the shared automation connection.
    pub async fn api_exec_stream(
        &self,
        session_id: &str,
        command: String,
        timeout_ms: u64,
        output: mpsc::Sender<ExecStreamChunk>,
        cancel: watch::Receiver<bool>,
    ) -> Result<ExecResult, String> {
        let started = Instant::now();
        let connection_id = self
            .find_connection_for_session(session_id, ConnectionOrigin::Automation)
            .await?;
        let connection = self
            .connection(&connection_id)
            .await
            .map_err(|error| error.to_string())?;
        let handle = connection.handle.clone();
        let tracker = connection.exec_process_tracker.clone();
        let (channel_result, tracked_process_groups) = tokio::join!(
            self.open_exec_channel_for_connection(&connection, true),
            tracker.supports_process_groups(&handle)
        );
        let (channel, channel_open_ms) = channel_result.map_err(|error| error.to_string())?;
        let execution = if tracked_process_groups {
            exec_tracked_stream_with_channel(
                channel,
                build_tracked_exec_command(handle, command),
                timeout_ms,
                output,
                cancel,
                MAX_API_EXEC_OUTPUT_BYTES,
            )
            .await
        } else {
            exec_stream_with_channel(
                channel,
                command,
                timeout_ms,
                output,
                cancel,
                MAX_API_EXEC_OUTPUT_BYTES,
            )
            .await
        };
        let mut result = execution.map_err(|error| error.to_string())?;
        result.channel_open_ms = channel_open_ms;
        result.duration_ms = started.elapsed().as_millis();
        Ok(result)
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
            .map(|entry| api_file_entry(path, entry.file_name(), entry.metadata()))
            .collect())
    }

    pub async fn api_list_files_page(
        &self,
        session_id: &str,
        path: &str,
        offset: usize,
        limit: usize,
    ) -> Result<(Vec<FileEntry>, bool), String> {
        let sftp = self.find_sftp_for_session(session_id).await?;
        let (entries, has_more) = sftp
            .read_dir_page(path.to_string(), offset, limit)
            .await
            .map_err(|error| format!("分页列出目录失败: {error}"))?;
        Ok((
            entries
                .into_iter()
                .map(|entry| api_file_entry(path, entry.file_name(), entry.metadata()))
                .collect(),
            has_more,
        ))
    }

    pub async fn api_file_stat(&self, session_id: &str, path: &str) -> Result<FileEntry, String> {
        let sftp = self.find_sftp_for_session(session_id).await?;
        let normalized = normalize_remote_path(path);
        let metadata = sftp
            .symlink_metadata(normalized.clone())
            .await
            .map_err(|error| format!("读取文件元数据失败: {error}"))?;
        let (parent, name) = if normalized == "/" {
            ("/", "/".to_string())
        } else {
            let (parent, name) = normalized.rsplit_once('/').unwrap_or(("/", &normalized));
            (
                if parent.is_empty() { "/" } else { parent },
                name.to_string(),
            )
        };
        let mut entry = api_file_entry(parent, name, metadata);
        entry.path = normalized;
        Ok(entry)
    }

    // ─── Internal helpers ──────────────────────────────────────────────────────

    pub(super) async fn find_connection_for_session(
        &self,
        session_id: &str,
        origin: ConnectionOrigin,
    ) -> Result<String, String> {
        let connections = self.connections.read().await;
        connections
            .values()
            .find(|record| {
                record.info.session_id == session_id
                    && record.origin == origin
                    && record.info.status == RuntimeStatus::Connected
                    && !connection_record_is_closed(record)
            })
            .map(|record| record.info.connection_id.clone())
            .ok_or_else(|| format!("会话 {} 未连接", session_id))
    }

    pub(crate) async fn find_sftp_for_session(
        &self,
        session_id: &str,
    ) -> Result<Arc<SftpSession>, String> {
        let connection_id = self
            .find_connection_for_session(session_id, ConnectionOrigin::Automation)
            .await?;
        let sftp_sessions = self.sftp_sessions.read().await;
        let record = sftp_sessions
            .values()
            .find(|record| {
                record.info.connection_id == connection_id && !record.closed.load(Ordering::Acquire)
            })
            .ok_or_else(|| format!("会话 {} 没有可用的 SFTP 连接", session_id))?;
        Ok(record.next_transfer_session().await)
    }

    pub async fn download_stream(
        &self,
        session_id: &str,
        path: String,
        start_offset: u64,
        total_len: u64,
        buffer_size: usize,
    ) -> Result<SftpDownloadStream, String> {
        let connection_id = self
            .find_connection_for_session(session_id, ConnectionOrigin::Automation)
            .await?;
        let sftp_record = {
            let sftp_sessions = self.sftp_sessions.read().await;
            sftp_sessions
                .values()
                .find(|record| {
                    record.info.connection_id == connection_id
                        && !record.closed.load(Ordering::Acquire)
                })
                .cloned()
                .ok_or_else(|| format!("会话 {} 没有可用的 SFTP 连接", session_id))?
        };
        let permit = timeout(
            API_TRANSFER_QUEUE_TIMEOUT,
            sftp_record.transfer_slots.clone().acquire_owned(),
        )
        .await
        .map_err(|_| "传输队列繁忙，请稍后重试".to_string())?
        .map_err(|error| format!("获取传输配额失败: {error}"))?;
        if sftp_record.closed.load(Ordering::Acquire) {
            return Err(format!("会话 {} 的 SFTP 连接已关闭", session_id));
        }
        let sftp = sftp_record.next_transfer_session().await;
        let mut file = sftp
            .open(path)
            .await
            .map_err(|error| format!("打开远程文件失败: {error}"))?;
        if start_offset > 0 {
            file.seek(std::io::SeekFrom::Start(start_offset))
                .await
                .map_err(|error| format!("seek 远程文件失败: {error}"))?;
        }
        file.set_read_limit(total_len)
            .map_err(|error| format!("设置读取范围失败: {error}"))?;
        let stream = ReaderStream::with_capacity(file.take(total_len), buffer_size.max(1));
        Ok(SftpDownloadStream {
            inner: Box::pin(stream),
            _permit: permit,
            closed: sftp_record.closed.clone(),
            remaining: total_len,
            stopped: false,
        })
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
        expected_sha256: Option<&str>,
        max_bytes: u64,
    ) -> AppResult<(u64, Option<String>)> {
        use std::sync::atomic::{AtomicBool, AtomicU64};
        let connection_id = self
            .find_connection_for_session(session_id, ConnectionOrigin::Automation)
            .await
            .map_err(AppError::Remote)?;
        let sftp_record = {
            let sftp_sessions = self.sftp_sessions.read().await;
            sftp_sessions
                .values()
                .find(|record| {
                    record.info.connection_id == connection_id
                        && !record.closed.load(Ordering::Acquire)
                })
                .cloned()
                .ok_or_else(|| {
                    AppError::Remote(format!("会话 {} 没有可用的 SFTP 连接", session_id))
                })?
        };
        let _permit = timeout(
            API_TRANSFER_QUEUE_TIMEOUT,
            sftp_record.transfer_slots.clone().acquire_owned(),
        )
        .await
        .map_err(|_| AppError::Remote("传输队列繁忙，请稍后重试".to_string()))?
        .map_err(|e| AppError::Remote(format!("获取传输配额失败: {}", e)))?;
        // Register only after acquiring the quota. If close began while this
        // request was queued, registration fails instead of letting an upload
        // start after close_sftp has already finished waiting for active work.
        let active_upload = sftp_record.register_api_upload()?;
        let sftp = sftp_record.next_transfer_session().await;
        let normalized = normalize_remote_path(remote_path);
        ensure_not_root_path(&normalized, "上传目标不能是根目录")?;
        let parent = normalized
            .rsplit_once('/')
            .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
            .unwrap_or("/");
        let temp_path = join_remote_path(parent, &format!(".helm-upload-{}.part", Uuid::new_v4()));
        let mut temp_guard =
            RemoteTempFileGuard::new(sftp.clone(), temp_path.clone(), active_upload);

        // dummy 信号：API 路径没有 pause/cancel 概念（HTTP 请求生命周期已经覆盖了）
        let dummy_cancel = AtomicBool::new(false);
        let dummy_paused = AtomicBool::new(false);
        let bytes_done = AtomicU64::new(0);
        let expected_sha256 = expected_sha256.map(str::to_ascii_lowercase);
        let result = async {
            let mut remote = sftp
                .open_with_flags(
                    temp_path.clone(),
                    OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
                )
                .await
                .map_err(remote_error)?;
            let wait_for_close = async {
                loop {
                    let notified = sftp_record.api_upload_notify.notified();
                    if sftp_record.closed.load(Ordering::Acquire) {
                        break;
                    }
                    notified.await;
                }
            };
            let mut hashing_reader = Sha256Reader::new(reader, expected_sha256.is_some());
            tokio::select! {
                result = super::transfer::copy_async_limited(
                    &mut hashing_reader,
                    &mut remote,
                    4 * 1024 * 1024,
                    &dummy_cancel,
                    &dummy_paused,
                    &bytes_done,
                    max_bytes,
                ) => result?,
                _ = wait_for_close => {
                    return Err(AppError::Remote("SFTP 已关闭，上传已取消".to_string()));
                }
            }
            remote.shutdown().await.map_err(remote_error)?;
            let written = bytes_done.load(std::sync::atomic::Ordering::Relaxed);
            let actual_sha256 = hashing_reader.finish();
            if let (Some(expected), Some(actual)) = (&expected_sha256, &actual_sha256) {
                if expected != actual {
                    return Err(AppError::InvalidInput(format!(
                        "SHA-256 校验失败：期望 {expected}，实际 {actual}"
                    )));
                }
            }
            let remote_size = sftp
                .metadata(temp_path.clone())
                .await
                .map_err(remote_error)?
                .len();
            if remote_size != written {
                return Err(AppError::Remote(format!(
                    "上传校验失败：远端大小 {} 字节，接收大小 {} 字节",
                    remote_size, written
                )));
            }
            self.replace_remote_file(&sftp_record.info.sftp_id, &temp_path, &normalized, true)
                .await?;
            temp_guard.disarm();
            Ok((written, actual_sha256))
        }
        .await;
        if result.is_err() {
            temp_guard.cleanup().await;
        }
        result
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
                workers: Vec::new(),
            });
        }

        let connection_id = self
            .find_connection_for_session(session_id, ConnectionOrigin::Automation)
            .await?;
        let sftp_record = {
            let sftp_sessions = self.sftp_sessions.read().await;
            sftp_sessions
                .values()
                .find(|record| {
                    record.info.connection_id == connection_id
                        && !record.closed.load(Ordering::Acquire)
                })
                .cloned()
                .ok_or_else(|| format!("会话 {} 没有可用的 SFTP 连接", session_id))?
        };
        sftp_record.wait_for_transfer_pool().await;

        let available_sessions = sftp_record.transfer_sessions.read().await.len().max(1) as u64;
        let parts = parts.max(1).min(available_sessions).min(total_len.max(1));
        // 每个 worker 占用一个传输配额。这样四路并行下载会一次性占满四个槽，
        // 不会与其他并行请求叠加成十几个 worker 争抢同一组 SFTP channel。
        let permit = timeout(
            API_TRANSFER_QUEUE_TIMEOUT,
            sftp_record
                .transfer_slots
                .clone()
                .acquire_many_owned(parts as u32),
        )
        .await
        .map_err(|_| "传输队列繁忙，请稍后重试".to_string())?
        .map_err(|e| format!("获取传输配额失败: {}", e))?;
        if sftp_record.closed.load(Ordering::Acquire) {
            return Err(format!("会话 {} 的 SFTP 连接已关闭", session_id));
        }
        let permit = Arc::new(permit);
        let chunk_size = total_len / parts;
        let mut receivers: VecDeque<mpsc::Receiver<io::Result<Bytes>>> =
            VecDeque::with_capacity(parts as usize);
        let mut workers = Vec::with_capacity(parts as usize);

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
            let task_closed = sftp_record.closed.clone();

            let worker = tokio::spawn(async move {
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
                if let Err(e) = file.set_read_limit(chunk_len) {
                    send_download_worker_error(&tx, format!("设置读取范围失败: {}", e)).await;
                    return;
                }

                use tokio::io::AsyncReadExt;
                let mut remaining = chunk_len;
                let mut buf = vec![0u8; buffer_size];
                while remaining > 0 {
                    if task_closed.load(Ordering::Acquire) {
                        send_download_worker_error(&tx, "SFTP 已关闭，下载已取消").await;
                        return;
                    }
                    let to_read = super::transfer::read_chunk_len(remaining, buf.len());
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
                if let Err(e) = file.shutdown().await {
                    send_download_worker_error(&tx, format!("关闭远程文件失败: {}", e)).await;
                }
            });

            receivers.push_back(rx);
            workers.push(worker);
        }

        Ok(OrderedChunkStream { receivers, workers })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn closed_sftp_download_stream_reports_cancellation_once() {
        let permit = Arc::new(Semaphore::new(1)).acquire_owned().await.unwrap();
        let closed = Arc::new(AtomicBool::new(true));
        let mut stream = SftpDownloadStream {
            inner: Box::pin(futures_util::stream::pending()),
            _permit: permit,
            closed,
            remaining: 1,
            stopped: false,
        };

        let error = futures_util::StreamExt::next(&mut stream)
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::ConnectionAborted);
        assert!(futures_util::StreamExt::next(&mut stream).await.is_none());
    }

    #[tokio::test]
    async fn short_sftp_download_stream_reports_unexpected_eof_once() {
        let permit = Arc::new(Semaphore::new(1)).acquire_owned().await.unwrap();
        let mut stream = SftpDownloadStream {
            inner: Box::pin(futures_util::stream::empty()),
            _permit: permit,
            closed: Arc::new(AtomicBool::new(false)),
            remaining: 8,
            stopped: false,
        };

        let error = futures_util::StreamExt::next(&mut stream)
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
        assert!(futures_util::StreamExt::next(&mut stream).await.is_none());
    }

    #[tokio::test]
    async fn completed_sftp_download_stream_ignores_a_late_close_signal() {
        let permit = Arc::new(Semaphore::new(1)).acquire_owned().await.unwrap();
        let closed = Arc::new(AtomicBool::new(false));
        let mut stream = SftpDownloadStream {
            inner: Box::pin(futures_util::stream::iter([Ok(Bytes::from_static(
                b"done",
            ))])),
            _permit: permit,
            closed: closed.clone(),
            remaining: 4,
            stopped: false,
        };

        let bytes = futures_util::StreamExt::next(&mut stream)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(bytes, Bytes::from_static(b"done"));
        closed.store(true, Ordering::Release);
        assert!(futures_util::StreamExt::next(&mut stream).await.is_none());
    }

    #[tokio::test]
    async fn dropping_ordered_stream_aborts_download_workers() {
        let (_tx, rx) = mpsc::channel(1);
        let worker = tokio::spawn(std::future::pending::<()>());
        let abort_handle = worker.abort_handle();
        let stream = OrderedChunkStream {
            receivers: VecDeque::from([rx]),
            workers: vec![worker],
        };

        drop(stream);
        tokio::task::yield_now().await;

        assert!(abort_handle.is_finished());
    }

    #[tokio::test]
    async fn sha256_reader_hashes_exact_stream_bytes() {
        let mut source = &b"abc"[..];
        let mut reader = Sha256Reader::new(&mut source, true);
        let mut output = Vec::new();
        reader.read_to_end(&mut output).await.unwrap();
        assert_eq!(output, b"abc");
        assert_eq!(
            reader.finish().as_deref(),
            Some("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        );
    }
}
