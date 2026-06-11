use super::*;

pub(super) async fn close_terminal_record(record: TerminalRecord) -> AppResult<()> {
    let result = {
        let writer = record.writer.lock().await;
        writer.close().await
    };
    result.map_err(remote_error)
}

pub(super) fn cancel_telemetry_record(app: &AppHandle, record: TelemetryJobRecord, reason: &str) {
    record.handle.abort();
    events::emit(
        app,
        events::TELEMETRY_SNAPSHOT,
        TelemetryErrorPayload {
            job_id: record.info.job_id,
            session_id: record.info.session_id,
            error: reason.to_string(),
        },
    );
}

pub(super) async fn cancel_forward_record(app: &AppHandle, mut record: ForwardRecord) {
    if let Some(handle) = record.handle.take() {
        handle.abort();
    }
    record.info.status = TaskStatus::Canceled;
    record.info.error = Some("已停止".to_string());
    events::emit(app, events::FORWARD_STATUS, record.info);
}
