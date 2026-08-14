use super::*;

pub(super) async fn close_terminal_record(record: TerminalRecord) -> AppResult<()> {
    record.closed.store(true, Ordering::Release);
    let reader = lock_unpoisoned(&record.reader, "terminal reader registry").take();
    abort_and_join_task(reader, "terminal reader").await;
    let result = {
        let writer = record.writer.lock().await;
        timeout(CHANNEL_SHUTDOWN_TIMEOUT, writer.close()).await
    };
    match result {
        Ok(result) => result.map_err(remote_error),
        Err(_) => Err(AppError::Remote("关闭终端通道超时".to_string())),
    }
}

pub(super) async fn cancel_telemetry_record(
    app: &AppHandle,
    record: TelemetryJobRecord,
    reason: &str,
) {
    let info = record.info.clone();
    shutdown_telemetry_record(record, "telemetry job").await;
    events::emit(
        app,
        events::TELEMETRY_SNAPSHOT,
        TelemetryErrorPayload {
            job_id: info.job_id,
            connection_id: info.connection_id,
            session_id: info.session_id,
            error: reason.to_string(),
            terminal: true,
        },
    );
}

pub(super) async fn shutdown_telemetry_record(mut record: TelemetryJobRecord, context: &str) {
    if let Some(shutdown) = record.shutdown.take() {
        let _ = shutdown.send(());
    }
    match timeout(TELEMETRY_JOB_SHUTDOWN_TIMEOUT, &mut record.handle).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) if error.is_cancelled() => {}
        Ok(Err(error)) => eprintln!("[helm] {context} failed while stopping: {error}"),
        Err(_) => {
            record.handle.abort();
            if let Err(error) = record.handle.await {
                if !error.is_cancelled() {
                    eprintln!("[helm] {context} failed after abort: {error}");
                }
            }
        }
    }
}

pub(super) async fn abort_and_join_task(handle: Option<JoinHandle<()>>, context: &str) {
    let Some(handle) = handle else {
        return;
    };
    handle.abort();
    if let Err(error) = handle.await {
        if !error.is_cancelled() {
            eprintln!("[helm] {context} failed while stopping: {error}");
        }
    }
}

pub(super) async fn disconnect_connection_handle(
    handle: &SshHandle,
    message: &'static str,
) -> AppResult<()> {
    let result = timeout(CONNECTION_SHUTDOWN_TIMEOUT, async {
        handle
            .lock()
            .await
            .disconnect(Disconnect::ByApplication, message, "zh-CN")
            .await
    })
    .await;
    match result {
        Ok(result) => result.map_err(remote_error),
        Err(_) => Err(AppError::Remote("关闭 SSH 连接超时".to_string())),
    }
}

pub(super) async fn cancel_forward_record(app: &AppHandle, mut record: ForwardRecord) {
    abort_forward_tasks(&mut record).await;
    record.info.status = TaskStatus::Canceled;
    record.info.error = Some("已停止".to_string());
    if record.origin.notifies_desktop() {
        events::emit(app, events::FORWARD_STATUS, record.info);
    }
}
