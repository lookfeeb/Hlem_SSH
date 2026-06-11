use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const SSH_STATUS: &str = "ssh://status";
pub const TERMINAL_OUTPUT: &str = "terminal://output";
pub const TERMINAL_CLOSED: &str = "terminal://closed";
pub const SFTP_CHANGED: &str = "sftp://changed";
pub const TRANSFER_PROGRESS: &str = "transfer://progress";
pub const TRANSFER_COMPLETED: &str = "transfer://completed";
pub const TRANSFER_FAILED: &str = "transfer://failed";
pub const TELEMETRY_SNAPSHOT: &str = "telemetry://snapshot";
pub const FORWARD_STATUS: &str = "forward://status";
pub const HOST_KEY_VERIFY: &str = "host-key://verify";
pub const TRAY_ACTION: &str = "tray://action";
pub const API_LOG: &str = "api://log";
pub const CONFIG_CHANGED: &str = "config://changed";

pub fn emit<T: Serialize + Clone>(app: &AppHandle, event: &str, payload: T) {
    let _ = app.emit(event, payload);
}
