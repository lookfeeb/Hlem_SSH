use super::*;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;

pub(super) fn map_connect_error(
    error: russh::Error,
    observed: &Arc<StdMutex<Option<HostKeyVerification>>>,
) -> AppError {
    if let Ok(guard) = observed.lock() {
        if let Some(verification) = guard.clone() {
            if verification.expected_fingerprint.is_some() {
                return AppError::HostKeyChanged(Box::new(verification));
            }
            return AppError::HostKeyUntrusted(Box::new(verification));
        }
    }
    remote_error(error)
}

pub(super) fn remote_error(error: impl std::fmt::Display) -> AppError {
    AppError::Remote(error.to_string())
}

pub(super) fn emit_terminal_output(app: &AppHandle, terminal_id: &str, kind: &str, data: &[u8]) {
    events::emit(
        app,
        events::TERMINAL_OUTPUT,
        TerminalOutputPayload {
            terminal_id: terminal_id.to_string(),
            kind: kind.to_string(),
            data: String::from_utf8_lossy(data).to_string(),
            data_base64: STANDARD.encode(data),
        },
    );
}

pub(super) fn emit_terminal_closed(app: &AppHandle, terminal_id: String) {
    events::emit(
        app,
        events::TERMINAL_CLOSED,
        TerminalClosedPayload { terminal_id },
    );
}

pub(super) fn emit_sftp_changed(app: &AppHandle, sftp_id: &str, path: &str) {
    events::emit(
        app,
        events::SFTP_CHANGED,
        SftpChangedPayload {
            sftp_id: sftp_id.to_string(),
            path: path.to_string(),
        },
    );
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TerminalOutputPayload {
    pub(super) terminal_id: String,
    pub(super) kind: String,
    pub(super) data: String,
    pub(super) data_base64: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TerminalClosedPayload {
    pub(super) terminal_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SftpChangedPayload {
    pub(super) sftp_id: String,
    pub(super) path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TelemetrySnapshotPayload {
    pub(super) job_id: String,
    pub(super) session_id: String,
    pub(super) snapshot: ServerTelemetry,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TelemetryErrorPayload {
    pub(super) job_id: String,
    pub(super) session_id: String,
    pub(super) error: String,
}
