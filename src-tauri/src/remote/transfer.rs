use super::*;

pub(super) async fn cleanup_transfer_staging(
    request: &TransferRequest,
    transfer_id: &str,
    cleanup_sftp: Option<&SftpSession>,
) {
    match request.direction {
        TransferDirection::Upload => {
            if let Some(sftp) = cleanup_sftp {
                let path = format!("{}.helm-{}.part", request.remote_path, transfer_id);
                let _ = sftp.remove_file(path).await;
            }
        }
        TransferDirection::Download => {
            let path = format!("{}.helm-{}.part", request.local_path, transfer_id);
            let _ = tokio::fs::remove_file(path).await;
        }
    }
}

async fn sync_and_replace_local(staging: &str, target: &str) -> AppResult<()> {
    let file = File::open(staging).await.map_err(remote_error)?;
    file.sync_all().await.map_err(remote_error)?;
    drop(file);
    crate::atomic_file::replace_file_async(Path::new(staging), Path::new(target)).await
}

struct AbortOnDropTask<T>(Option<JoinHandle<T>>);

impl<T> AbortOnDropTask<T> {
    fn new(handle: JoinHandle<T>) -> Self {
        Self(Some(handle))
    }

    async fn join(mut self) -> Option<Result<T, tokio::task::JoinError>> {
        let handle = self.0.take()?;
        Some(handle.await)
    }
}

impl<T> Drop for AbortOnDropTask<T> {
    fn drop(&mut self) {
        if let Some(handle) = self.0.take() {
            handle.abort();
        }
    }
}

async fn await_progress_ticker(handle: AbortOnDropTask<()>, transfer_id: &str) {
    match handle.join().await {
        Some(Err(error)) if !error.is_cancelled() => {
            eprintln!("[helm] transfer progress ticker failed: {transfer_id}: {error}");
        }
        Some(_) => {}
        None => log::warn!("transfer progress ticker handle missing: {transfer_id}"),
    }
}

struct ParallelTransferOptions<'a> {
    runtime: &'a RemoteRuntime,
    app: &'a AppHandle,
    info: &'a TransferInfo,
    request: &'a TransferRequest,
    sftp_record: &'a SftpRecord,
    total_size: u64,
    buffer_size: usize,
    cancel: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
}

pub(super) async fn ensure_transfer_overwrite(
    sftp: &SftpSession,
    request: &TransferRequest,
) -> AppResult<()> {
    if request.overwrite {
        return Ok(());
    }
    let target_exists = match request.direction {
        TransferDirection::Upload => sftp
            .try_exists(request.remote_path.clone())
            .await
            .map_err(remote_error)?,
        TransferDirection::Download => Path::new(&request.local_path).exists(),
    };
    if target_exists {
        Err(AppError::TransferNeedsOverwrite(match request.direction {
            TransferDirection::Upload => request.remote_path.clone(),
            TransferDirection::Download => request.local_path.clone(),
        }))
    } else {
        Ok(())
    }
}

pub(super) async fn transfer_total_bytes(
    sftp: &SftpSession,
    request: &TransferRequest,
) -> AppResult<u64> {
    match request.direction {
        TransferDirection::Upload => Ok(tokio::fs::metadata(&request.local_path)
            .await
            .map_err(remote_error)?
            .len()),
        TransferDirection::Download => Ok(sftp
            .metadata(request.remote_path.clone())
            .await
            .map_err(remote_error)?
            .len()),
    }
}

pub(super) async fn run_transfer(
    runtime: &RemoteRuntime,
    app: &AppHandle,
    info: TransferInfo,
    request: TransferRequest,
    cancel: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
) -> AppResult<()> {
    let sftp_record = runtime.sftp_record(&request.sftp_id).await?;
    let _permit = sftp_record
        .transfer_slots
        .clone()
        .acquire_owned()
        .await
        .map_err(remote_error)?;
    let sftp = sftp_record.next_transfer_session().await;
    runtime.mark_transfer_running(app, &info.transfer_id).await;
    let buffer_size = if request.accelerated {
        TRANSFER_ACCELERATED_BUFFER_BYTES
    } else {
        TRANSFER_BUFFER_BYTES
    };
    let staging_remote_path = format!("{}.helm-{}.part", request.remote_path, info.transfer_id);
    let staging_local_path = format!("{}.helm-{}.part", request.local_path, info.transfer_id);
    match request.direction {
        TransferDirection::Upload => {
            let local_size = tokio::fs::metadata(&request.local_path)
                .await
                .map_err(remote_error)?
                .len();
            let resume_from = 0;
            let _ = sftp.remove_file(staging_remote_path.clone()).await;
            let mut staged_request = request.clone();
            staged_request.remote_path = staging_remote_path.clone();
            staged_request.resume = false;

            let should_parallel = local_size >= PARALLEL_UPLOAD_THRESHOLD
                && resume_from == 0
                && PARALLEL_UPLOAD_PARTS >= 2;

            if should_parallel {
                run_parallel_upload(ParallelTransferOptions {
                    runtime,
                    app,
                    info: &info,
                    request: &staged_request,
                    sftp_record: &sftp_record,
                    total_size: local_size,
                    buffer_size,
                    cancel: cancel.clone(),
                    paused: paused.clone(),
                })
                .await?;
            } else {
                let mut local = File::open(&request.local_path)
                    .await
                    .map_err(remote_error)?;
                if resume_from > 0 {
                    local
                        .seek(SeekFrom::Start(resume_from))
                        .await
                        .map_err(remote_error)?;
                }
                let remote_flags = if resume_from > 0 {
                    OpenFlags::CREATE | OpenFlags::WRITE
                } else {
                    OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE
                };
                let mut remote = sftp
                    .open_with_flags(staging_remote_path.clone(), remote_flags)
                    .await
                    .map_err(remote_error)?;
                if resume_from > 0 {
                    remote
                        .seek(SeekFrom::Start(resume_from))
                        .await
                        .map_err(remote_error)?;
                }

                let bytes_done = Arc::new(AtomicU64::new(resume_from));
                if resume_from > 0 {
                    emit_transfer_progress(runtime, app, &info.transfer_id, resume_from, 0.0).await;
                }

                let stop_progress = Arc::new(AtomicBool::new(false));
                let progress_handle = spawn_progress_ticker(
                    runtime.clone(),
                    app.clone(),
                    info.transfer_id.clone(),
                    bytes_done.clone(),
                    cancel.clone(),
                    paused.clone(),
                    stop_progress.clone(),
                );

                let result = copy_async(
                    &mut local,
                    &mut remote,
                    buffer_size,
                    &cancel,
                    &paused,
                    &bytes_done,
                )
                .await;

                stop_progress.store(true, Ordering::Relaxed);
                await_progress_ticker(progress_handle, &info.transfer_id).await;

                result?;
                remote.shutdown().await.map_err(remote_error)?;

                let final_bytes = bytes_done.load(Ordering::Relaxed);
                emit_transfer_progress(runtime, app, &info.transfer_id, final_bytes, 0.0).await;
            }
            let remote_size = sftp
                .metadata(staging_remote_path.clone())
                .await
                .map_err(remote_error)?
                .len();
            if remote_size != local_size {
                return Err(AppError::Remote(format!(
                    "上传校验失败：远端大小 {} 字节，本地大小 {} 字节",
                    remote_size, local_size
                )));
            }
            runtime
                .replace_remote_file(&request.sftp_id, &staging_remote_path, &request.remote_path)
                .await?;
        }
        TransferDirection::Download => {
            let remote_size = sftp
                .metadata(request.remote_path.clone())
                .await
                .map_err(remote_error)?
                .len();
            if let Some(parent) = Path::new(&request.local_path).parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(remote_error)?;
            }
            let resume_from = 0;
            let _ = tokio::fs::remove_file(&staging_local_path).await;
            let mut staged_request = request.clone();
            staged_request.local_path = staging_local_path.clone();
            staged_request.resume = false;

            // 大文件 + 非续传：走多 File handle 并行下载以提升高延迟链路吞吐。
            let should_parallel = remote_size >= PARALLEL_DOWNLOAD_THRESHOLD
                && resume_from == 0
                && PARALLEL_DOWNLOAD_PARTS >= 2;

            if should_parallel {
                run_parallel_download(ParallelTransferOptions {
                    runtime,
                    app,
                    info: &info,
                    request: &staged_request,
                    sftp_record: &sftp_record,
                    total_size: remote_size,
                    buffer_size,
                    cancel: cancel.clone(),
                    paused: paused.clone(),
                })
                .await?;
            } else {
                let mut remote = sftp
                    .open(request.remote_path.clone())
                    .await
                    .map_err(remote_error)?;
                let mut local = if resume_from > 0 {
                    OpenOptions::new()
                        .create(true)
                        .truncate(false)
                        .write(true)
                        .open(&staging_local_path)
                        .await
                        .map_err(remote_error)?
                } else {
                    File::create(&staging_local_path)
                        .await
                        .map_err(remote_error)?
                };
                if resume_from > 0 {
                    remote
                        .seek(SeekFrom::Start(resume_from))
                        .await
                        .map_err(remote_error)?;
                    local
                        .seek(SeekFrom::Start(resume_from))
                        .await
                        .map_err(remote_error)?;
                }

                let bytes_done = Arc::new(AtomicU64::new(resume_from));
                if resume_from > 0 {
                    emit_transfer_progress(runtime, app, &info.transfer_id, resume_from, 0.0).await;
                }

                let stop_progress = Arc::new(AtomicBool::new(false));
                let progress_handle = spawn_progress_ticker(
                    runtime.clone(),
                    app.clone(),
                    info.transfer_id.clone(),
                    bytes_done.clone(),
                    cancel.clone(),
                    paused.clone(),
                    stop_progress.clone(),
                );

                let result = copy_async(
                    &mut remote,
                    &mut local,
                    buffer_size,
                    &cancel,
                    &paused,
                    &bytes_done,
                )
                .await;

                stop_progress.store(true, Ordering::Relaxed);
                await_progress_ticker(progress_handle, &info.transfer_id).await;

                result?;
                remote.shutdown().await.map_err(remote_error)?;

                let final_bytes = bytes_done.load(Ordering::Relaxed);
                emit_transfer_progress(runtime, app, &info.transfer_id, final_bytes, 0.0).await;
            }
            let local_size = tokio::fs::metadata(&staging_local_path)
                .await
                .map_err(remote_error)?
                .len();
            if local_size != remote_size {
                return Err(AppError::Remote(format!(
                    "下载校验失败：本地大小 {} 字节，远端大小 {} 字节",
                    local_size, remote_size
                )));
            }
            sync_and_replace_local(&staging_local_path, &request.local_path).await?;
        }
    }
    runtime
        .mark_transfer_completed(app, &info.transfer_id)
        .await;
    Ok(())
}

pub(super) async fn wait_while_paused(paused: &AtomicBool, cancel: &AtomicBool) -> AppResult<bool> {
    if !paused.load(Ordering::Relaxed) {
        return Ok(false);
    }
    while paused.load(Ordering::Relaxed) {
        if cancel.load(Ordering::Relaxed) {
            return Err(AppError::Remote("传输已取消".to_string()));
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    if cancel.load(Ordering::Relaxed) {
        return Err(AppError::Remote("传输已取消".to_string()));
    }
    Ok(true)
}

pub(super) async fn emit_transfer_progress(
    runtime: &RemoteRuntime,
    app: &AppHandle,
    transfer_id: &str,
    bytes_done: u64,
    speed_kbps: f64,
) {
    runtime
        .mark_transfer_progress(app, transfer_id, bytes_done, speed_kbps)
        .await;
}

/// 共享底层字节搬运循环。SFTP 上传、UI 下载和 API 上传复用这套缓冲、
/// pause/cancel 与计数字节逻辑；进度上报由调用方负责。
pub(super) async fn copy_async<R, W>(
    src: &mut R,
    dst: &mut W,
    buffer_size: usize,
    cancel: &AtomicBool,
    paused: &AtomicBool,
    bytes_done: &AtomicU64,
) -> AppResult<()>
where
    R: tokio::io::AsyncRead + Unpin + ?Sized,
    W: tokio::io::AsyncWrite + Unpin + ?Sized,
{
    let mut buffer = vec![0u8; buffer_size];
    loop {
        ensure_transfer_not_canceled(cancel)?;
        wait_while_paused(paused, cancel).await?;
        let read = src.read(&mut buffer).await.map_err(remote_error)?;
        if read == 0 {
            break;
        }
        ensure_transfer_not_canceled(cancel)?;
        wait_while_paused(paused, cancel).await?;
        dst.write_all(&buffer[..read]).await.map_err(remote_error)?;
        bytes_done.fetch_add(read as u64, Ordering::Relaxed);
    }
    dst.flush().await.map_err(remote_error)?;
    Ok(())
}

pub(super) async fn copy_async_limited<R, W>(
    src: &mut R,
    dst: &mut W,
    buffer_size: usize,
    cancel: &AtomicBool,
    paused: &AtomicBool,
    bytes_done: &AtomicU64,
    max_bytes: u64,
) -> AppResult<()>
where
    R: tokio::io::AsyncRead + Unpin + ?Sized,
    W: tokio::io::AsyncWrite + Unpin + ?Sized,
{
    let mut buffer = vec![0u8; buffer_size];
    loop {
        ensure_transfer_not_canceled(cancel)?;
        wait_while_paused(paused, cancel).await?;
        let read = src.read(&mut buffer).await.map_err(remote_error)?;
        if read == 0 {
            break;
        }
        let current = bytes_done.load(Ordering::Relaxed);
        if current.saturating_add(read as u64) > max_bytes {
            return Err(AppError::InvalidInput(format!(
                "上传文件不能超过 {} MB",
                max_bytes / 1024 / 1024
            )));
        }
        ensure_transfer_not_canceled(cancel)?;
        wait_while_paused(paused, cancel).await?;
        dst.write_all(&buffer[..read]).await.map_err(remote_error)?;
        bytes_done.fetch_add(read as u64, Ordering::Relaxed);
    }
    dst.flush().await.map_err(remote_error)?;
    Ok(())
}

fn ensure_transfer_not_canceled(cancel: &AtomicBool) -> AppResult<()> {
    if cancel.load(Ordering::Relaxed) {
        Err(AppError::Remote("传输已取消".to_string()))
    } else {
        Ok(())
    }
}

/// UI 层定期 ticker：每 250ms 读 bytes_done 原子，按 1MB 阈值节流上报进度。
/// 速度值做 EWMA 平滑；低速链路超过 2 秒也上报一次，避免 UI 长时间停在旧速度。
/// 配合 copy_async 使用：调用方先 spawn 这个 ticker，再调 copy_async；
/// copy_async 返回后 abort 或让其自然退出（cancel 置位时也会退）。
fn spawn_progress_ticker(
    runtime: RemoteRuntime,
    app: AppHandle,
    transfer_id: String,
    bytes_done: Arc<AtomicU64>,
    cancel: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
) -> AbortOnDropTask<()> {
    AbortOnDropTask::new(tokio::spawn(async move {
        let mut last_bytes: u64 = bytes_done.load(Ordering::Relaxed);
        let mut last_time = Instant::now();
        let mut smoothed_speed = 0.0;
        let mut emitted_moving_speed = false;
        let mut interval = tokio::time::interval(TRANSFER_PROGRESS_MIN_INTERVAL);
        loop {
            interval.tick().await;
            if stop.load(Ordering::Relaxed) || cancel.load(Ordering::Relaxed) {
                break;
            }
            let now = Instant::now();
            let cur = bytes_done.load(Ordering::Relaxed);
            let elapsed = now.duration_since(last_time).as_secs_f64();
            let delta = cur.saturating_sub(last_bytes);
            let silent_for = now.duration_since(last_time);
            let should_emit = delta >= TRANSFER_PROGRESS_MIN_BYTES
                || (delta > 0 && silent_for >= TRANSFER_PROGRESS_MAX_SILENCE);
            if !should_emit {
                if delta == 0 && emitted_moving_speed && silent_for >= TRANSFER_PROGRESS_MAX_SILENCE
                {
                    smoothed_speed = 0.0;
                    emitted_moving_speed = false;
                    emit_transfer_progress(&runtime, &app, &transfer_id, cur, 0.0).await;
                    last_time = now;
                    last_bytes = cur;
                }
                continue;
            }

            let instant_speed = if elapsed > 0.0 && !paused.load(Ordering::Relaxed) {
                bytes_per_second_to_kib(delta, elapsed)
            } else {
                0.0
            };
            let speed = if instant_speed <= 0.0 {
                0.0
            } else if smoothed_speed <= 0.0 {
                instant_speed
            } else {
                smoothed_speed * (1.0 - TRANSFER_SPEED_SMOOTHING_ALPHA)
                    + instant_speed * TRANSFER_SPEED_SMOOTHING_ALPHA
            };
            smoothed_speed = speed;
            emitted_moving_speed = speed > 0.0;
            emit_transfer_progress(&runtime, &app, &transfer_id, cur, speed).await;
            last_time = now;
            last_bytes = cur;
        }
    }))
}

/// `copy_async` 的有界版本：从 `src` 读取 **恰好 `limit` 字节** 写入 `dst`。
/// 与 copy_async 共享同一组 cancel / paused / bytes_done 信号，便于多任务协作。
///
/// 用于并行下载场景：每个 part task 只搬运分配给自己的字节范围。
/// 提前遇到 EOF（远端文件比期望短）会返回错误，避免静默生成损坏文件。
pub(super) async fn copy_n_async<R, W>(
    src: &mut R,
    dst: &mut W,
    limit: u64,
    buffer_size: usize,
    cancel: &AtomicBool,
    paused: &AtomicBool,
    bytes_done: &AtomicU64,
) -> AppResult<()>
where
    R: tokio::io::AsyncRead + Unpin + ?Sized,
    W: tokio::io::AsyncWrite + Unpin + ?Sized,
{
    copy_n_async_inner(
        src,
        dst,
        limit,
        CopyAsyncOptions {
            buffer_size,
            cancel,
            paused,
            bytes_done,
            flush_destination: true,
        },
    )
    .await
}

pub(super) async fn copy_n_async_without_flush<R, W>(
    src: &mut R,
    dst: &mut W,
    limit: u64,
    buffer_size: usize,
    cancel: &AtomicBool,
    paused: &AtomicBool,
    bytes_done: &AtomicU64,
) -> AppResult<()>
where
    R: tokio::io::AsyncRead + Unpin + ?Sized,
    W: tokio::io::AsyncWrite + Unpin + ?Sized,
{
    copy_n_async_inner(
        src,
        dst,
        limit,
        CopyAsyncOptions {
            buffer_size,
            cancel,
            paused,
            bytes_done,
            flush_destination: false,
        },
    )
    .await
}

struct CopyAsyncOptions<'a> {
    buffer_size: usize,
    cancel: &'a AtomicBool,
    paused: &'a AtomicBool,
    bytes_done: &'a AtomicU64,
    flush_destination: bool,
}

async fn copy_n_async_inner<R, W>(
    src: &mut R,
    dst: &mut W,
    limit: u64,
    options: CopyAsyncOptions<'_>,
) -> AppResult<()>
where
    R: tokio::io::AsyncRead + Unpin + ?Sized,
    W: tokio::io::AsyncWrite + Unpin + ?Sized,
{
    let CopyAsyncOptions {
        buffer_size,
        cancel,
        paused,
        bytes_done,
        flush_destination,
    } = options;
    let mut buffer = vec![0u8; buffer_size];
    let mut remaining = limit;
    while remaining > 0 {
        // wait_while_paused 仅在 paused 时才检查 cancel；这里加一次直查
        // 让外部 task 因兄弟任务失败而被 cancel 的场景能快速退出。
        if cancel.load(Ordering::Relaxed) {
            return Err(AppError::Remote("传输已取消".to_string()));
        }
        wait_while_paused(paused, cancel).await?;

        let to_read = std::cmp::min(remaining as usize, buffer.len());
        let read = src
            .read(&mut buffer[..to_read])
            .await
            .map_err(remote_error)?;
        if read == 0 {
            return Err(AppError::Remote(format!(
                "远端文件提前结束：还差 {} 字节",
                remaining
            )));
        }
        wait_while_paused(paused, cancel).await?;
        dst.write_all(&buffer[..read]).await.map_err(remote_error)?;
        bytes_done.fetch_add(read as u64, Ordering::Relaxed);
        remaining -= read as u64;
    }
    if flush_destination {
        dst.flush().await.map_err(remote_error)?;
    }
    Ok(())
}

/// 多 File handle 并行上传，用于提升大文件上传吞吐。
///
/// 限制：只用于 `resume_from == 0` 的完整上传。调用方已负责 overwrite 检查；
/// 这里先把远端文件截断到 0，再由每个 part 按范围 seek 写入。
async fn run_parallel_upload(options: ParallelTransferOptions<'_>) -> AppResult<()> {
    let ParallelTransferOptions {
        runtime,
        app,
        info,
        request,
        sftp_record,
        total_size: local_size,
        buffer_size,
        cancel,
        paused,
    } = options;
    sftp_record.wait_for_transfer_pool().await;
    {
        let init_sftp = sftp_record.next_transfer_session().await;
        let mut remote = init_sftp
            .open_with_flags(
                request.remote_path.clone(),
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            )
            .await
            .map_err(remote_error)?;
        remote.shutdown().await.map_err(remote_error)?;
    }

    let bytes_done = Arc::new(AtomicU64::new(0));
    let stop_progress = Arc::new(AtomicBool::new(false));
    let progress_handle = spawn_progress_ticker(
        runtime.clone(),
        app.clone(),
        info.transfer_id.clone(),
        bytes_done.clone(),
        cancel.clone(),
        paused.clone(),
        stop_progress.clone(),
    );

    let chunk_size = local_size / PARALLEL_UPLOAD_PARTS;
    let mut workers = Vec::with_capacity(PARALLEL_UPLOAD_PARTS as usize);

    log::info!(
        "并行上传启动：{} 字节 / {} 路 (chunk≈{} 字节)",
        local_size,
        PARALLEL_UPLOAD_PARTS,
        chunk_size
    );

    for i in 0..PARALLEL_UPLOAD_PARTS {
        let start = i * chunk_size;
        let len = if i == PARALLEL_UPLOAD_PARTS - 1 {
            local_size - start
        } else {
            chunk_size
        };

        let task_sftp = sftp_record.next_transfer_session().await;
        let task_local_path = request.local_path.clone();
        let task_remote_path = request.remote_path.clone();
        let task_cancel = cancel.clone();
        let task_paused = paused.clone();
        let task_bytes_done = bytes_done.clone();

        workers.push(async move {
            let result: AppResult<()> = async {
                let mut local_file = File::open(&task_local_path).await.map_err(remote_error)?;
                if start > 0 {
                    local_file
                        .seek(SeekFrom::Start(start))
                        .await
                        .map_err(remote_error)?;
                }

                let mut remote_file = task_sftp
                    .open_with_flags(task_remote_path, OpenFlags::CREATE | OpenFlags::WRITE)
                    .await
                    .map_err(remote_error)?;
                if start > 0 {
                    remote_file
                        .seek(SeekFrom::Start(start))
                        .await
                        .map_err(remote_error)?;
                }

                copy_n_async_without_flush(
                    &mut local_file,
                    &mut remote_file,
                    len,
                    buffer_size,
                    &task_cancel,
                    &task_paused,
                    &task_bytes_done,
                )
                .await?;
                remote_file.shutdown().await.map_err(remote_error)
            }
            .await;

            if result.is_err() {
                task_cancel.store(true, Ordering::Relaxed);
            }
            result
        });
    }

    let mut first_error: Option<AppError> = None;
    for result in futures_util::future::join_all(workers).await {
        if let Err(error) = result {
            if first_error.is_none() {
                first_error = Some(error);
            }
        }
    }

    stop_progress.store(true, Ordering::Relaxed);
    await_progress_ticker(progress_handle, &info.transfer_id).await;

    if let Some(error) = first_error {
        return Err(error);
    }

    // 各分片 shutdown 只等待 WRITE ACK 并关闭 handle；所有分片结束后统一
    // 做一次 fsync，避免 OpenSSH 上每个分片各触发一次昂贵的整文件落盘。
    let sync_sftp = sftp_record.next_transfer_session().await;
    let mut sync_file = sync_sftp
        .open_with_flags(request.remote_path.clone(), OpenFlags::WRITE)
        .await
        .map_err(remote_error)?;
    sync_file.sync_all().await.map_err(remote_error)?;
    sync_file.shutdown().await.map_err(remote_error)?;

    let verify_sftp = sftp_record.next_transfer_session().await;
    let remote_size = verify_sftp
        .metadata(request.remote_path.clone())
        .await
        .map_err(remote_error)?
        .len();
    if remote_size != local_size {
        return Err(AppError::Remote(format!(
            "并行上传校验失败：远端大小 {} 字节，本地大小 {} 字节",
            remote_size, local_size
        )));
    }

    let final_bytes = bytes_done.load(Ordering::Relaxed);
    emit_transfer_progress(runtime, app, &info.transfer_id, final_bytes, 0.0).await;
    Ok(())
}

/// 多 File handle 并行下载，用于提升大文件下载吞吐。
///
/// 限制：调用方需保证 `remote_size > 0` 且无续传需求（resume_from == 0）。
/// 任一 part 失败会立即 `cancel.store(true)` 让兄弟 task 自然退出，
/// 主线程汇总并返回首个真实错误。
async fn run_parallel_download(options: ParallelTransferOptions<'_>) -> AppResult<()> {
    let ParallelTransferOptions {
        runtime,
        app,
        info,
        request,
        sftp_record,
        total_size: remote_size,
        buffer_size,
        cancel,
        paused,
    } = options;
    sftp_record.wait_for_transfer_pool().await;
    // 1) 预分配本地文件：File::create 截断 + set_len 拓展到目标长度。
    //    随后 drop 原始 handle，每个 task 用 OpenOptions 各自重新打开
    //    （Windows 默认 share_mode 允许多写者，每 handle 自带 seek 位置）。
    {
        let local = File::create(&request.local_path)
            .await
            .map_err(remote_error)?;
        local.set_len(remote_size).await.map_err(remote_error)?;
        // 显式 drop：关闭 handle，避免后续 OpenOptions 与之竞争。
        drop(local);
    }

    let bytes_done = Arc::new(AtomicU64::new(0));
    let stop_progress = Arc::new(AtomicBool::new(false));
    let progress_handle = spawn_progress_ticker(
        runtime.clone(),
        app.clone(),
        info.transfer_id.clone(),
        bytes_done.clone(),
        cancel.clone(),
        paused.clone(),
        stop_progress.clone(),
    );

    let chunk_size = remote_size / PARALLEL_DOWNLOAD_PARTS;
    let mut workers = Vec::with_capacity(PARALLEL_DOWNLOAD_PARTS as usize);

    log::info!(
        "并行下载启动：{} 字节 / {} 路 (chunk≈{} 字节)",
        remote_size,
        PARALLEL_DOWNLOAD_PARTS,
        chunk_size
    );

    for i in 0..PARALLEL_DOWNLOAD_PARTS {
        let start = i * chunk_size;
        let len = if i == PARALLEL_DOWNLOAD_PARTS - 1 {
            remote_size - start
        } else {
            chunk_size
        };

        // 每个 task 抓一个 transfer 池里的 SftpSession（轮询）。
        // 池里只有 1 个时多 task 共用同一 session，仍可借多 File handle 并行；
        // 池满（4 个）时各 task 拿到独立 session，并行更彻底。
        let task_sftp = sftp_record.next_transfer_session().await;
        let task_remote_path = request.remote_path.clone();
        let task_local_path = request.local_path.clone();
        let task_cancel = cancel.clone();
        let task_paused = paused.clone();
        let task_bytes_done = bytes_done.clone();

        workers.push(async move {
            let result: AppResult<()> = async {
                let mut remote_file = task_sftp
                    .open(task_remote_path)
                    .await
                    .map_err(remote_error)?;
                if start > 0 {
                    remote_file
                        .seek(SeekFrom::Start(start))
                        .await
                        .map_err(remote_error)?;
                }
                remote_file.set_read_limit(len).map_err(remote_error)?;

                let mut local_file = OpenOptions::new()
                    .write(true)
                    .open(&task_local_path)
                    .await
                    .map_err(remote_error)?;
                if start > 0 {
                    local_file
                        .seek(SeekFrom::Start(start))
                        .await
                        .map_err(remote_error)?;
                }

                copy_n_async(
                    &mut remote_file,
                    &mut local_file,
                    len,
                    buffer_size,
                    &task_cancel,
                    &task_paused,
                    &task_bytes_done,
                )
                .await?;
                remote_file.shutdown().await.map_err(remote_error)
            }
            .await;

            // 任一 task 出错 → 拉取 cancel，让兄弟 task 在下次循环检测时自然退出。
            if result.is_err() {
                task_cancel.store(true, Ordering::Relaxed);
            }
            result
        });
    }

    let mut first_error: Option<AppError> = None;
    for result in futures_util::future::join_all(workers).await {
        if let Err(error) = result {
            if first_error.is_none() {
                first_error = Some(error);
            }
        }
    }

    stop_progress.store(true, Ordering::Relaxed);
    await_progress_ticker(progress_handle, &info.transfer_id).await;

    if let Some(error) = first_error {
        return Err(error);
    }

    let final_bytes = bytes_done.load(Ordering::Relaxed);
    emit_transfer_progress(runtime, app, &info.transfer_id, final_bytes, 0.0).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{cleanup_transfer_staging, copy_async, copy_async_limited};
    use crate::errors::AppError;
    use crate::remote::{TransferDirection, TransferRequest};
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use tempfile::tempdir;
    use tokio::io::{repeat, sink, AsyncReadExt};

    #[tokio::test]
    async fn limited_copy_accepts_exact_limit_and_counts_bytes() {
        let mut source = repeat(1).take(4);
        let mut destination = sink();
        let cancel = AtomicBool::new(false);
        let paused = AtomicBool::new(false);
        let bytes_done = AtomicU64::new(0);

        copy_async_limited(
            &mut source,
            &mut destination,
            2,
            &cancel,
            &paused,
            &bytes_done,
            4,
        )
        .await
        .unwrap();

        assert_eq!(bytes_done.load(Ordering::Relaxed), 4);
    }

    #[tokio::test]
    async fn limited_copy_rejects_chunked_input_beyond_limit_before_writing_extra_bytes() {
        let mut source = repeat(1).take(5);
        let mut destination = sink();
        let cancel = AtomicBool::new(false);
        let paused = AtomicBool::new(false);
        let bytes_done = AtomicU64::new(0);

        let error = copy_async_limited(
            &mut source,
            &mut destination,
            2,
            &cancel,
            &paused,
            &bytes_done,
            4,
        )
        .await
        .unwrap_err();

        assert!(matches!(error, AppError::InvalidInput(_)));
        assert_eq!(bytes_done.load(Ordering::Relaxed), 4);
    }

    #[tokio::test]
    async fn copy_stops_when_canceled_even_if_not_paused() {
        let mut source = repeat(1).take(4);
        let mut destination = sink();
        let cancel = AtomicBool::new(true);
        let paused = AtomicBool::new(false);
        let bytes_done = AtomicU64::new(0);

        let error = copy_async(
            &mut source,
            &mut destination,
            2,
            &cancel,
            &paused,
            &bytes_done,
        )
        .await
        .unwrap_err();

        assert!(matches!(error, AppError::Remote(message) if message == "传输已取消"));
        assert_eq!(bytes_done.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn download_staging_cleanup_does_not_require_a_live_sftp_record() {
        let directory = tempdir().unwrap();
        let target = directory.path().join("download.bin");
        let staging = format!("{}.helm-transfer-1.part", target.display());
        tokio::fs::write(&staging, b"partial").await.unwrap();
        let request = TransferRequest {
            sftp_id: "already-closed".to_string(),
            direction: TransferDirection::Download,
            local_path: target.to_string_lossy().into_owned(),
            remote_path: "/tmp/download.bin".to_string(),
            overwrite: true,
            accelerated: false,
            resume: false,
        };

        cleanup_transfer_staging(&request, "transfer-1", None).await;

        assert!(!Path::new(&staging).exists());
    }
}
