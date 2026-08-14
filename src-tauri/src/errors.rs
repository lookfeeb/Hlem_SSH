use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};

use serde::Serialize;
use thiserror::Error;

/// Global registry mapping runtime resource UUIDs (connection, terminal, sftp, transfer,
/// telemetry, forward ids) to a human-readable session name. Populated when a resource is
/// created and consulted when building error logs so stderr shows the session the user knows
/// about instead of an opaque UUID.
fn label_registry() -> &'static RwLock<HashMap<String, String>> {
    static REGISTRY: OnceLock<RwLock<HashMap<String, String>>> = OnceLock::new();
    REGISTRY.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Associate a resource id with a friendly session name. Safe to call repeatedly.
pub fn register_resource_label(id: &str, name: &str) {
    if id.is_empty() || name.is_empty() {
        return;
    }
    if let Ok(mut guard) = label_registry().write() {
        guard.insert(id.to_string(), name.to_string());
    }
}

/// Forget a resource id. Called when the resource is removed so the registry doesn't grow
/// unbounded.
pub fn forget_resource_label(id: &str) {
    if id.is_empty() {
        return;
    }
    if let Ok(mut guard) = label_registry().write() {
        guard.remove(id);
    }
}

/// Look up the friendly label for a resource id, if any was registered.
pub fn resource_label(id: &str) -> Option<String> {
    label_registry().read().ok()?.get(id).cloned()
}

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyVerification {
    pub session_id: String,
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint: String,
    pub expected_fingerprint: Option<String>,
}

#[derive(Debug, Error, Serialize)]
#[serde(tag = "code", content = "message", rename_all = "camelCase")]
pub enum AppError {
    #[error("本机数据尚未初始化")]
    VaultNotFound,
    #[error("本机数据已存在")]
    VaultAlreadyExists,
    #[error("工作区已锁定")]
    VaultLocked,
    #[error("主密码错误或本机数据已损坏")]
    InvalidMasterPassword,
    #[error("配置项不存在: {0}")]
    NotFound(String),
    #[error("参数无效: {0}")]
    InvalidInput(String),
    #[error("配置冲突: {0}")]
    ConfigConflict(String),
    #[error("主机密钥未信任")]
    HostKeyUntrusted(Box<HostKeyVerification>),
    #[error("主机密钥已变更")]
    HostKeyChanged(Box<HostKeyVerification>),
    #[error("传输需要覆盖确认: {0}")]
    TransferNeedsOverwrite(String),
    #[error("远程错误: {0}")]
    Remote(String),
    #[error("文件错误: {0}")]
    Io(String),
    #[error("加密错误: {0}")]
    Crypto(String),
    #[error("序列化错误: {0}")]
    Serde(String),
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(error: serde_json::Error) -> Self {
        Self::Serde(error.to_string())
    }
}

impl AppError {
    /// User-friendly NotFound for a runtime resource. The raw `id` (typically a UUID) is
    /// written to stderr so it stays available for debugging, while the toast in the UI
    /// only sees `friendly`. If a session name has been registered for the id via
    /// [`register_resource_label`], the log line uses that name instead of the UUID.
    fn runtime_missing(kind: &str, id: &str, friendly: &str) -> Self {
        match resource_label(id) {
            Some(label) => eprintln!("[helm] {} not found: {}", kind, label),
            None => eprintln!("[helm] {} not found: {}", kind, id),
        }
        AppError::NotFound(friendly.to_string())
    }

    pub fn missing_connection(id: &str) -> Self {
        Self::runtime_missing("connection", id, "连接已断开，请重新连接")
    }

    pub fn missing_terminal(id: &str) -> Self {
        Self::runtime_missing("terminal", id, "终端会话已失效，请重新连接")
    }

    pub fn missing_sftp(id: &str) -> Self {
        Self::runtime_missing("sftp", id, "SFTP 会话已失效，请重新连接")
    }

    pub fn missing_transfer(id: &str) -> Self {
        Self::runtime_missing("transfer", id, "传输任务已失效")
    }

    pub fn missing_telemetry_job(id: &str) -> Self {
        Self::runtime_missing("telemetry job", id, "监控任务已失效")
    }

    pub fn missing_forward(id: &str) -> Self {
        Self::runtime_missing("forward", id, "端口转发已失效")
    }
}
