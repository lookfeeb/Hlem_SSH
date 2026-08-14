use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::errors::{AppError, AppResult};

pub const VAULT_DATA_VERSION: u16 = 2;
pub const DEFAULT_GROUP_NAME: &str = "默认分组";
const GROUP_NAME_MAX_HAN_CHARS: usize = 8;
const GROUP_NAME_MAX_CHARS: usize = 10;
const GROUP_CUSTOM_MAX_COUNT: usize = 10;
const COLLAPSED_CONNECTION_SECTION_MAX_COUNT: usize = 32;
const CONNECTION_SECTION_ID_MAX_CHARS: usize = 128;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VaultData {
    pub version: u16,
    pub groups: Vec<SessionGroup>,
    pub sessions: Vec<SessionConfig>,
    #[serde(default)]
    pub known_hosts: Vec<KnownHostEntry>,
    #[serde(default)]
    pub settings: AppSettings,
    #[serde(default)]
    pub tunnels: Vec<TunnelConfig>,
    #[serde(default)]
    pub backup_records: Vec<BackupRecord>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionGroup {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub sort_order: u32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionConfig {
    pub id: String,
    pub name: String,
    pub group_id: Option<String>,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub last_connected_at: Option<String>,
    #[serde(default)]
    pub connection_count: u64,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthConfig,
    #[serde(default)]
    pub ssh: SshOptions,
    pub default_path: String,
    pub tags: Vec<String>,
    pub note: Option<String>,
    pub terminal: TerminalOptions,
    pub sftp: SftpOptions,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostEntry {
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint: String,
    pub trusted_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuthConfig {
    pub method: AuthMethod,
    pub password: Option<String>,
    pub private_key_path: Option<String>,
    pub imported_private_key: Option<String>,
    pub private_key_passphrase: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum AuthMethod {
    Password,
    PrivateKey,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOptions {
    pub encoding: String,
    pub theme: String,
    pub keepalive_interval_sec: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SshOptions {
    pub connect_timeout_ms: u64,
    pub keepalive_interval_sec: u16,
    pub host_key_fingerprint: Option<String>,
    pub proxy: Option<SshProxyOptions>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SshProxyOptions {
    pub kind: String,
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub proxy: Option<AppProxyOptions>,
    #[serde(default)]
    pub backup: BackupSettings,
    #[serde(default)]
    pub quick_commands: Vec<QuickCommand>,
    #[serde(default)]
    pub ignored_update_versions: Vec<String>,
    #[serde(default)]
    pub ai_api_key: Option<String>,
    #[serde(default)]
    pub ai_api_session_id: Option<String>,
    #[serde(default)]
    pub ai_api_session_ids: Vec<String>,
    #[serde(default)]
    pub ai_api_port: Option<u16>,
    #[serde(default)]
    pub ai_api_auto_start: bool,
    #[serde(default)]
    pub collapsed_connection_section_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuickCommand {
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppProxyOptions {
    pub enabled: bool,
    pub kind: String,
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupSettings {
    #[serde(default)]
    pub local_directory: Option<String>,
    #[serde(default)]
    pub auto_enabled: bool,
    #[serde(default = "default_backup_frequency")]
    pub frequency: String,
    #[serde(default = "default_backup_retention_count")]
    pub retention_count: u16,
    #[serde(default = "default_backup_retention_days")]
    pub retention_days: u16,
    #[serde(default)]
    pub cloud: CloudBackupSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudBackupSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub auto_enabled: bool,
    #[serde(default = "default_cloud_backup_kind")]
    pub kind: String,
    #[serde(default)]
    pub webdav: WebdavBackupConfig,
    #[serde(default)]
    pub s3: S3BackupConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct WebdavBackupConfig {
    #[serde(default)]
    pub endpoint: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub remote_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct S3BackupConfig {
    #[serde(default)]
    pub endpoint: String,
    #[serde(default = "default_s3_region")]
    pub region: String,
    #[serde(default)]
    pub bucket: String,
    #[serde(default)]
    pub access_key_id: String,
    #[serde(default)]
    pub secret_access_key: String,
    #[serde(default)]
    pub prefix: String,
    #[serde(default = "default_s3_path_style")]
    pub path_style: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupRecord {
    pub id: String,
    pub file_name: String,
    pub target_kind: String,
    pub target_path: String,
    pub size: u64,
    pub status: String,
    pub error: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TunnelConfig {
    pub id: String,
    pub name: String,
    pub session_id: String,
    pub forward_type: String,
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: String,
    pub target_port: u16,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelInput {
    pub name: String,
    pub session_id: String,
    pub forward_type: String,
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: String,
    pub target_port: u16,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SftpOptions {
    pub default_path: String,
    pub show_hidden: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSnapshot {
    pub data: VaultData,
    pub revision: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupInput {
    pub name: String,
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInput {
    pub name: String,
    pub group_id: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthConfig,
    #[serde(default)]
    pub ssh: SshOptions,
    pub default_path: String,
    pub tags: Vec<String>,
    pub note: Option<String>,
    pub terminal: TerminalOptions,
    pub sftp: SftpOptions,
}

impl VaultData {
    pub fn empty() -> Self {
        Self {
            version: VAULT_DATA_VERSION,
            groups: Vec::new(),
            sessions: Vec::new(),
            known_hosts: Vec::new(),
            settings: AppSettings::default(),
            tunnels: Vec::new(),
            backup_records: Vec::new(),
            updated_at: now(),
        }
    }

    pub fn with_default_group() -> Self {
        let mut data = Self::empty();
        let group = SessionGroup::new(
            GroupInput {
                name: DEFAULT_GROUP_NAME.to_string(),
                parent_id: None,
            },
            0,
        );
        data.groups.push(group);
        data.touch();
        data
    }

    pub fn touch(&mut self) {
        self.updated_at = now();
    }

    pub fn default_group_id(&self) -> Option<&str> {
        self.groups
            .iter()
            .find(|group| group.sort_order == 0)
            .or_else(|| self.groups.first())
            .map(|group| group.id.as_str())
    }

    pub fn is_default_group_id(&self, group_id: &str) -> bool {
        self.default_group_id() == Some(group_id)
    }
}

pub fn migrate_vault_data(data: &mut VaultData) -> bool {
    let mut changed = false;
    if data.version < VAULT_DATA_VERSION {
        data.version = VAULT_DATA_VERSION;
        changed = true;
    }
    // Older builds stored only one authorized AI API session. Keep that
    // authorization when the vector field is first introduced, then make the
    // legacy field follow the normalized vector as a compatibility mirror.
    if data.settings.ai_api_session_ids.is_empty() {
        if let Some(session_id) = data
            .settings
            .ai_api_session_id
            .as_deref()
            .map(str::trim)
            .filter(|session_id| !session_id.is_empty())
        {
            data.settings.ai_api_session_ids = vec![session_id.to_string()];
            changed = true;
        }
    }
    let normalized_legacy_id = data.settings.ai_api_session_ids.first().cloned();
    if data.settings.ai_api_session_id != normalized_legacy_id {
        data.settings.ai_api_session_id = normalized_legacy_id;
        changed = true;
    }
    if data.settings.ai_api_session_ids.is_empty() && data.settings.ai_api_auto_start {
        data.settings.ai_api_auto_start = false;
        changed = true;
    }
    if changed {
        data.touch();
    }
    changed
}

impl TunnelConfig {
    pub fn new(input: TunnelInput) -> Self {
        let timestamp = now();
        Self {
            id: Uuid::new_v4().to_string(),
            name: input.name.trim().to_string(),
            session_id: input.session_id,
            forward_type: input.forward_type,
            bind_host: input.bind_host.trim().to_string(),
            bind_port: input.bind_port,
            target_host: input.target_host.trim().to_string(),
            target_port: input.target_port,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        }
    }

    pub fn update(&mut self, input: TunnelInput) {
        self.name = input.name.trim().to_string();
        self.session_id = input.session_id;
        self.forward_type = input.forward_type;
        self.bind_host = input.bind_host.trim().to_string();
        self.bind_port = input.bind_port;
        self.target_host = input.target_host.trim().to_string();
        self.target_port = input.target_port;
        self.updated_at = now();
    }
}

impl SessionGroup {
    pub fn new(input: GroupInput, sort_order: u32) -> Self {
        let timestamp = now();
        Self {
            id: Uuid::new_v4().to_string(),
            name: input.name.trim().to_string(),
            parent_id: input.parent_id,
            sort_order,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        }
    }

    pub fn update(&mut self, input: GroupInput) {
        self.name = input.name.trim().to_string();
        self.parent_id = input.parent_id;
        self.updated_at = now();
    }
}

impl SessionConfig {
    pub fn new(input: SessionInput) -> Self {
        let timestamp = now();
        Self {
            id: Uuid::new_v4().to_string(),
            name: input.name.trim().to_string(),
            group_id: input.group_id,
            favorite: false,
            last_connected_at: None,
            connection_count: 0,
            host: input.host.trim().to_string(),
            port: input.port,
            username: input.username.trim().to_string(),
            auth: input.auth,
            ssh: input.ssh,
            default_path: normalize_remote_path(&input.default_path),
            tags: clean_tags(input.tags),
            note: input.note.filter(|note| !note.trim().is_empty()),
            terminal: input.terminal,
            sftp: input.sftp,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        }
    }

    pub fn update(&mut self, input: SessionInput) {
        self.name = input.name.trim().to_string();
        self.group_id = input.group_id;
        self.host = input.host.trim().to_string();
        self.port = input.port;
        self.username = input.username.trim().to_string();
        self.auth = input.auth;
        self.ssh = input.ssh;
        self.default_path = normalize_remote_path(&input.default_path);
        self.tags = clean_tags(input.tags);
        self.note = input.note.filter(|note| !note.trim().is_empty());
        self.terminal = input.terminal;
        self.sftp = input.sftp;
        self.updated_at = now();
    }
}

impl AuthConfig {
    #[cfg(test)]
    pub fn password(password: Option<String>) -> Self {
        Self {
            method: AuthMethod::Password,
            password,
            private_key_path: None,
            imported_private_key: None,
            private_key_passphrase: None,
        }
    }
}

impl Default for TerminalOptions {
    fn default() -> Self {
        Self {
            encoding: "utf-8".to_string(),
            theme: "default".to_string(),
            keepalive_interval_sec: 15,
        }
    }
}

impl Default for SshOptions {
    fn default() -> Self {
        Self {
            connect_timeout_ms: 10_000,
            keepalive_interval_sec: 15,
            host_key_fingerprint: None,
            proxy: None,
        }
    }
}

impl Default for BackupSettings {
    fn default() -> Self {
        Self {
            local_directory: None,
            auto_enabled: false,
            frequency: default_backup_frequency(),
            retention_count: default_backup_retention_count(),
            retention_days: default_backup_retention_days(),
            cloud: CloudBackupSettings::default(),
        }
    }
}

impl Default for CloudBackupSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            auto_enabled: false,
            kind: default_cloud_backup_kind(),
            webdav: WebdavBackupConfig::default(),
            s3: S3BackupConfig::default(),
        }
    }
}

impl Default for S3BackupConfig {
    fn default() -> Self {
        Self {
            endpoint: String::new(),
            region: default_s3_region(),
            bucket: String::new(),
            access_key_id: String::new(),
            secret_access_key: String::new(),
            prefix: String::new(),
            path_style: default_s3_path_style(),
        }
    }
}

impl BackupRecord {
    pub fn listed(
        file_name: String,
        target_kind: &str,
        target_path: String,
        size: u64,
        created_at: String,
    ) -> Self {
        Self {
            id: format!("{}:{}", target_kind, target_path),
            file_name,
            target_kind: target_kind.to_string(),
            target_path,
            size,
            status: "success".to_string(),
            error: None,
            created_at,
        }
    }

    pub fn success(file_name: String, target_kind: &str, target_path: String, size: u64) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            file_name,
            target_kind: target_kind.to_string(),
            target_path,
            size,
            status: "success".to_string(),
            error: None,
            created_at: now(),
        }
    }

    pub fn failed(
        file_name: String,
        target_kind: &str,
        target_path: String,
        error: String,
    ) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            file_name,
            target_kind: target_kind.to_string(),
            target_path,
            size: 0,
            status: "failed".to_string(),
            error: Some(error),
            created_at: now(),
        }
    }
}

pub fn validate_group_input(
    data: &VaultData,
    group_id: Option<&str>,
    input: &GroupInput,
) -> AppResult<()> {
    if let Some(group_id) = group_id {
        if data.is_default_group_id(group_id) {
            return Err(AppError::InvalidInput("默认分组不允许重命名".to_string()));
        }
    }

    if input.name.trim().is_empty() {
        return Err(AppError::InvalidInput("分组名称不能为空".to_string()));
    }
    validate_group_name_length(input.name.trim())?;
    if group_id.is_none() && custom_group_count(data) >= GROUP_CUSTOM_MAX_COUNT {
        return Err(AppError::InvalidInput(format!(
            "自定义分组最多 {} 个",
            GROUP_CUSTOM_MAX_COUNT
        )));
    }

    if let Some(parent_id) = input.parent_id.as_deref() {
        if Some(parent_id) == group_id {
            return Err(AppError::InvalidInput("分组不能把自己设为上级".to_string()));
        }
        if !data.groups.iter().any(|group| group.id == parent_id) {
            return Err(AppError::NotFound(format!("上级分组 {}", parent_id)));
        }
    }

    Ok(())
}

fn validate_group_name_length(name: &str) -> AppResult<()> {
    let char_count = name.chars().count();
    let han_count = name.chars().filter(|char| is_han_char(*char)).count();
    if han_count > GROUP_NAME_MAX_HAN_CHARS || char_count > GROUP_NAME_MAX_CHARS {
        return Err(AppError::InvalidInput(format!(
            "分组名称不能超过 {} 个汉字或 {} 个字符",
            GROUP_NAME_MAX_HAN_CHARS, GROUP_NAME_MAX_CHARS
        )));
    }
    Ok(())
}

fn custom_group_count(data: &VaultData) -> usize {
    let default_group_id = data.default_group_id();
    data.groups
        .iter()
        .filter(|group| Some(group.id.as_str()) != default_group_id)
        .count()
}

fn is_han_char(char: char) -> bool {
    let code_point = char as u32;
    matches!(
        code_point,
        0x3400..=0x4dbf
            | 0x4e00..=0x9fff
            | 0xf900..=0xfaff
            | 0x20000..=0x2a6df
            | 0x2a700..=0x2ebef
            | 0x30000..=0x3134f
    )
}

pub fn validate_session_input(
    data: &VaultData,
    session_id: Option<&str>,
    input: &SessionInput,
) -> AppResult<()> {
    if input.name.trim().is_empty() {
        return Err(AppError::InvalidInput("会话名称不能为空".to_string()));
    }
    if input.host.trim().is_empty() {
        return Err(AppError::InvalidInput("主机地址不能为空".to_string()));
    }
    if input.port == 0 {
        return Err(AppError::InvalidInput(
            "端口必须在 1-65535 之间".to_string(),
        ));
    }
    if input.username.trim().is_empty() {
        return Err(AppError::InvalidInput("用户名不能为空".to_string()));
    }
    if let Some(group_id) = input.group_id.as_deref() {
        if !data.groups.iter().any(|group| group.id == group_id) {
            return Err(AppError::NotFound(format!("分组 {}", group_id)));
        }
    }
    if data
        .sessions
        .iter()
        .any(|session| Some(session.id.as_str()) != session_id && session.name == input.name.trim())
    {
        return Err(AppError::InvalidInput("会话名称不能重复".to_string()));
    }
    if let Some(proxy) = &input.ssh.proxy {
        validate_ssh_proxy(proxy)?;
    }

    Ok(())
}

pub fn validate_settings(settings: &AppSettings) -> AppResult<()> {
    if let Some(proxy) = &settings.proxy {
        validate_proxy_fields(proxy.enabled, &proxy.kind, &proxy.host, proxy.port)?;
    }
    validate_backup_settings(&settings.backup)?;
    validate_quick_commands(&settings.quick_commands)?;
    validate_collapsed_connection_section_ids(&settings.collapsed_connection_section_ids)?;
    Ok(())
}

pub fn validate_collapsed_connection_section_ids(section_ids: &[String]) -> AppResult<()> {
    if section_ids.len() > COLLAPSED_CONNECTION_SECTION_MAX_COUNT {
        return Err(AppError::InvalidInput(format!(
            "连接分组折叠状态最多保留 {COLLAPSED_CONNECTION_SECTION_MAX_COUNT} 项"
        )));
    }
    for (index, section_id) in section_ids.iter().enumerate() {
        let trimmed = section_id.trim();
        if trimmed.is_empty() {
            return Err(AppError::InvalidInput("连接分组标识不能为空".to_string()));
        }
        if trimmed.chars().count() > CONNECTION_SECTION_ID_MAX_CHARS {
            return Err(AppError::InvalidInput("连接分组标识过长".to_string()));
        }
        if section_ids[..index]
            .iter()
            .any(|previous| previous.trim() == trimmed)
        {
            return Err(AppError::InvalidInput(
                "连接分组折叠状态不能重复".to_string(),
            ));
        }
    }
    Ok(())
}

fn validate_quick_commands(commands: &[QuickCommand]) -> AppResult<()> {
    if commands.len() > 100 {
        return Err(AppError::InvalidInput(
            "常用命令最多保留 100 条".to_string(),
        ));
    }
    for command in commands {
        if command.name.trim().is_empty() {
            return Err(AppError::InvalidInput("常用命令名称不能为空".to_string()));
        }
        if command.command.trim().is_empty() {
            return Err(AppError::InvalidInput("常用命令内容不能为空".to_string()));
        }
    }
    Ok(())
}

pub fn validate_backup_settings(settings: &BackupSettings) -> AppResult<()> {
    match settings.frequency.as_str() {
        "manual" | "hourly" | "daily" | "weekly" => {}
        _ => return Err(AppError::InvalidInput("自动备份频率无效".to_string())),
    }
    if settings.retention_count == 0 {
        return Err(AppError::InvalidInput("保留份数必须大于 0".to_string()));
    }
    if let Some(directory) = settings.local_directory.as_deref() {
        if directory.trim().is_empty() {
            return Err(AppError::InvalidInput("本地备份目录不能为空".to_string()));
        }
    }
    if !settings.cloud.enabled && !settings.cloud.auto_enabled {
        return Ok(());
    }
    match settings.cloud.kind.as_str() {
        "webdav" => {
            if settings.cloud.webdav.endpoint.trim().is_empty() {
                return Err(AppError::InvalidInput("WebDAV 地址不能为空".to_string()));
            }
        }
        "s3" => {
            let s3 = &settings.cloud.s3;
            if s3.endpoint.trim().is_empty()
                || s3.region.trim().is_empty()
                || s3.bucket.trim().is_empty()
                || s3.access_key_id.trim().is_empty()
                || s3.secret_access_key.trim().is_empty()
            {
                return Err(AppError::InvalidInput(
                    "S3 配置需要 endpoint、region、bucket、accessKeyId 和 secretAccessKey"
                        .to_string(),
                ));
            }
        }
        _ => return Err(AppError::InvalidInput("云端备份类型无效".to_string())),
    }
    Ok(())
}

pub fn validate_tunnel_input(data: &VaultData, input: &TunnelInput) -> AppResult<()> {
    if input.name.trim().is_empty() {
        return Err(AppError::InvalidInput("隧道名称不能为空".to_string()));
    }
    if !data
        .sessions
        .iter()
        .any(|session| session.id == input.session_id)
    {
        return Err(AppError::NotFound(format!("会话 {}", input.session_id)));
    }
    match input.forward_type.as_str() {
        "local" | "remote" | "dynamic" => {}
        _ => return Err(AppError::InvalidInput("隧道类型无效".to_string())),
    }
    if input.bind_host.trim().is_empty() {
        return Err(AppError::InvalidInput("监听地址不能为空".to_string()));
    }
    // 0 交给系统自动分配可用监听端口，运行态会返回实际端口。
    if input.forward_type != "dynamic" {
        if input.target_host.trim().is_empty() {
            return Err(AppError::InvalidInput("目标地址不能为空".to_string()));
        }
        if input.target_port == 0 {
            return Err(AppError::InvalidInput(
                "目标端口必须在 1-65535 之间".to_string(),
            ));
        }
    }
    Ok(())
}

pub fn validate_ssh_proxy(proxy: &SshProxyOptions) -> AppResult<()> {
    if proxy.kind == "direct" {
        return Ok(());
    }
    validate_proxy_fields(true, &proxy.kind, &proxy.host, proxy.port)
}

fn validate_proxy_fields(enabled: bool, kind: &str, host: &str, port: u16) -> AppResult<()> {
    if !enabled {
        return Ok(());
    }
    match kind {
        "socks5" | "httpConnect" => {}
        _ => return Err(AppError::InvalidInput("代理类型无效".to_string())),
    }
    if host.trim().is_empty() {
        return Err(AppError::InvalidInput("代理主机不能为空".to_string()));
    }
    if port == 0 {
        return Err(AppError::InvalidInput(
            "代理端口必须在 1-65535 之间".to_string(),
        ));
    }
    Ok(())
}

pub fn now() -> String {
    Utc::now().to_rfc3339()
}

fn default_backup_frequency() -> String {
    "daily".to_string()
}

fn default_backup_retention_count() -> u16 {
    10
}

fn default_backup_retention_days() -> u16 {
    30
}

fn default_cloud_backup_kind() -> String {
    "webdav".to_string()
}

fn default_s3_path_style() -> bool {
    false
}

fn default_s3_region() -> String {
    "us-east-1".to_string()
}

fn clean_tags(tags: Vec<String>) -> Vec<String> {
    let mut cleaned = Vec::new();
    for tag in tags {
        let value = tag.trim().to_string();
        if !value.is_empty() && !cleaned.contains(&value) {
            cleaned.push(value);
        }
    }
    cleaned
}

fn normalize_remote_path(path: &str) -> String {
    if path.trim().is_empty() {
        return String::new();
    }
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    if parts.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", parts.join("/"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_remote_paths_resolve_dot_segments() {
        assert_eq!(normalize_remote_path("/srv/./app/../logs"), "/srv/logs");
        assert_eq!(normalize_remote_path("/srv/.."), "/");
        assert_eq!(normalize_remote_path("   "), "");
    }

    fn session_input(name: &str) -> SessionInput {
        SessionInput {
            name: name.to_string(),
            group_id: None,
            host: "127.0.0.1".to_string(),
            port: 22,
            username: "root".to_string(),
            auth: AuthConfig::password(Some("secret".to_string())),
            ssh: SshOptions::default(),
            default_path: "/tmp".to_string(),
            tags: Vec::new(),
            note: None,
            terminal: TerminalOptions::default(),
            sftp: SftpOptions::default(),
        }
    }

    fn group_input(name: &str) -> GroupInput {
        GroupInput {
            name: name.to_string(),
            parent_id: None,
        }
    }

    #[test]
    fn validates_group_name_length_limits() {
        let data = VaultData::with_default_group();

        assert!(validate_group_input(&data, None, &group_input("一二三四五六七八")).is_ok());
        assert!(validate_group_input(&data, None, &group_input("abcdefghij")).is_ok());
        assert!(validate_group_input(&data, None, &group_input("一二三四五六七八九")).is_err());
        assert!(validate_group_input(&data, None, &group_input("abcdefghijk")).is_err());
    }

    #[test]
    fn validates_custom_group_count_limit() {
        let mut data = VaultData::with_default_group();
        for index in 0..GROUP_CUSTOM_MAX_COUNT {
            data.groups.push(SessionGroup::new(
                group_input(&format!("g{}", index)),
                (index + 1) as u32,
            ));
        }
        let group_id = data.groups[1].id.clone();

        assert!(validate_group_input(&data, None, &group_input("extra")).is_err());
        assert!(validate_group_input(&data, Some(&group_id), &group_input("rename")).is_ok());
    }

    #[test]
    fn deserializes_legacy_vault_without_settings_or_tunnels() {
        let data: VaultData = serde_json::from_str(
            r#"{
                "version": 1,
                "groups": [],
                "sessions": [],
                "knownHosts": [],
                "updatedAt": "2026-01-01T00:00:00Z"
            }"#,
        )
        .unwrap();

        assert_eq!(data.settings, AppSettings::default());
        assert!(data.tunnels.is_empty());
        assert!(data.backup_records.is_empty());
    }

    #[test]
    fn removes_legacy_quick_command_click_count_during_migration() {
        let mut data: VaultData = serde_json::from_str(
            r#"{
                "version": 1,
                "groups": [],
                "sessions": [],
                "knownHosts": [],
                "settings": {
                    "quickCommands": [{
                        "id": "legacy-command",
                        "name": "旧命令",
                        "command": "echo legacy",
                        "clickCount": 18
                    }]
                },
                "updatedAt": "2026-01-01T00:00:00Z"
            }"#,
        )
        .unwrap();

        assert!(migrate_vault_data(&mut data));
        assert_eq!(data.version, VAULT_DATA_VERSION);
        let value = serde_json::to_value(data).unwrap();
        assert!(value["settings"]["quickCommands"][0]
            .get("clickCount")
            .is_none());
    }

    #[test]
    fn migration_preserves_legacy_single_ai_api_authorization() {
        let mut data = VaultData::empty();
        data.settings.ai_api_session_id = Some(" session-a ".to_string());
        data.settings.ai_api_auto_start = true;

        assert!(migrate_vault_data(&mut data));
        assert_eq!(data.settings.ai_api_session_ids, vec!["session-a"]);
        assert_eq!(
            data.settings.ai_api_session_id.as_deref(),
            Some("session-a")
        );
        assert!(data.settings.ai_api_auto_start);
        assert!(!migrate_vault_data(&mut data));
    }

    #[test]
    fn migration_disables_ai_api_autostart_without_authorized_sessions() {
        let mut data = VaultData::empty();
        data.settings.ai_api_auto_start = true;

        assert!(migrate_vault_data(&mut data));
        assert!(!data.settings.ai_api_auto_start);
    }

    #[test]
    fn deserializes_legacy_session_without_connection_count() {
        let session = SessionConfig::new(session_input("旧节点"));
        let mut value = serde_json::to_value(session).unwrap();
        value.as_object_mut().unwrap().remove("connectionCount");

        let session: SessionConfig = serde_json::from_value(value).unwrap();
        assert_eq!(session.connection_count, 0);
    }

    #[test]
    fn validates_tunnel_template_session_and_ports() {
        let mut data = VaultData::empty();
        let session = SessionConfig::new(session_input("节点"));
        let session_id = session.id.clone();
        data.sessions.push(session);

        let valid = TunnelInput {
            name: "自动端口".to_string(),
            session_id: session_id.clone(),
            forward_type: "dynamic".to_string(),
            bind_host: "127.0.0.1".to_string(),
            bind_port: 0,
            target_host: "SOCKS5".to_string(),
            target_port: 0,
        };
        assert!(validate_tunnel_input(&data, &valid).is_ok());

        let missing_session = TunnelInput {
            session_id: "missing".to_string(),
            ..valid
        };
        assert!(matches!(
            validate_tunnel_input(&data, &missing_session),
            Err(AppError::NotFound(_))
        ));
    }
}
