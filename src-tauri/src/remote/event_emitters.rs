use super::*;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;

pub(super) fn map_connect_error(
    error: russh::Error,
    observed: &Arc<StdMutex<Option<HostKeyVerification>>>,
    diagnostics: &Arc<StdMutex<RemoteClientDiagnostics>>,
) -> AppError {
    if let Ok(guard) = observed.lock() {
        if let Some(verification) = guard.clone() {
            match verification.expected_fingerprint.as_deref() {
                Some(expected) if expected != verification.fingerprint => {
                    return AppError::HostKeyChanged(Box::new(verification));
                }
                None => return AppError::HostKeyUntrusted(Box::new(verification)),
                Some(_) => {}
            }
        }
    }

    let detail = diagnostics
        .lock()
        .ok()
        .and_then(|diagnostics| diagnostics.disconnect_reason.clone())
        .unwrap_or_else(|| format_ssh_transport_error(&error));
    AppError::Remote(format!("SSH 握手失败（协议协商或密钥交换阶段）：{detail}"))
}

pub(super) fn is_transient_connect_error(error: &russh::Error) -> bool {
    match error {
        russh::Error::HUP
        | russh::Error::Disconnect
        | russh::Error::ConnectionTimeout
        | russh::Error::KeepaliveTimeout => true,
        russh::Error::IO(error) => matches!(
            error.kind(),
            std::io::ErrorKind::ConnectionReset
                | std::io::ErrorKind::ConnectionAborted
                | std::io::ErrorKind::BrokenPipe
                | std::io::ErrorKind::UnexpectedEof
                | std::io::ErrorKind::TimedOut
        ),
        _ => false,
    }
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
    pub(super) connection_id: String,
    pub(super) session_id: String,
    pub(super) snapshot: ServerTelemetry,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TelemetryErrorPayload {
    pub(super) job_id: String,
    pub(super) connection_id: String,
    pub(super) session_id: String,
    pub(super) error: String,
    pub(super) terminal: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn verification(expected_fingerprint: Option<&str>) -> HostKeyVerification {
        HostKeyVerification {
            session_id: "session".to_string(),
            host: "127.0.0.1".to_string(),
            port: 22,
            algorithm: "ssh-ed25519".to_string(),
            fingerprint: "SHA256:current".to_string(),
            expected_fingerprint: expected_fingerprint.map(str::to_string),
        }
    }

    #[test]
    fn preserves_host_key_prompts_but_does_not_mislabel_later_handshake_errors() {
        let diagnostics = Arc::new(StdMutex::new(RemoteClientDiagnostics::default()));

        let untrusted = map_connect_error(
            russh::Error::Disconnect,
            &Arc::new(StdMutex::new(Some(verification(None)))),
            &diagnostics,
        );
        assert!(matches!(untrusted, AppError::HostKeyUntrusted(_)));

        let changed = map_connect_error(
            russh::Error::Disconnect,
            &Arc::new(StdMutex::new(Some(verification(Some("SHA256:old"))))),
            &diagnostics,
        );
        assert!(matches!(changed, AppError::HostKeyChanged(_)));

        let later_handshake_error = map_connect_error(
            russh::Error::Disconnect,
            &Arc::new(StdMutex::new(Some(verification(Some("SHA256:current"))))),
            &diagnostics,
        );
        assert!(
            matches!(later_handshake_error, AppError::Remote(message) if message.contains("SSH 握手失败") && message.contains("服务器未返回具体原因"))
        );
    }

    #[test]
    fn retries_only_transient_transport_failures() {
        assert!(is_transient_connect_error(&russh::Error::Disconnect));
        assert!(is_transient_connect_error(&russh::Error::HUP));
        assert!(!is_transient_connect_error(&russh::Error::UnknownKey));
    }
}
