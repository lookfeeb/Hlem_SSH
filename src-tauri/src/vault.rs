use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

use chrono::{DateTime, Duration, Utc};
use zeroize::Zeroize;

use crate::{
    atomic_file::write_atomic,
    backup::{backup_cleanup_target, extract_backup_payload, BackupCleanupTarget},
    config::{
        migrate_vault_data, validate_group_input, validate_session_input, validate_settings,
        validate_tunnel_input, AppProxyOptions, BackupRecord, BackupSettings, ConfigSnapshot,
        GroupInput, KnownHostEntry, QuickCommand, SessionConfig, SessionGroup, SessionInput,
        TunnelConfig, TunnelInput, VaultData,
    },
    crypto::{self, CryptoSession, EncryptedVault},
    errors::{AppError, AppResult},
};

pub const VAULT_FILE_NAME: &str = "vault.rpvault";

#[derive(Debug, Clone)]
pub struct AiApiSettingsUpdate {
    pub session_ids: Vec<String>,
    pub port: Option<u16>,
    pub auto_start: bool,
}

#[cfg(test)]
pub struct VaultStatus {
    pub exists: bool,
    pub unlocked: bool,
}

pub struct VaultStore {
    path: PathBuf,
    unlocked: Option<UnlockedVault>,
    revision: u64,
}

struct UnlockedVault {
    data: VaultData,
    crypto: CryptoSession,
}

impl Drop for UnlockedVault {
    fn drop(&mut self) {
        self.crypto.key.zeroize();
        self.crypto.salt.zeroize();
    }
}

/// Internal fixed password used for transparent encryption (no user-facing password gate).
pub const AUTO_PASSWORD: &str = "helm-internal-auto-key-2024";

/// Result of attempting to auto-open the vault at startup.
#[derive(Debug, Clone, PartialEq)]
pub enum AutoOpenResult {
    /// Vault opened successfully (or freshly created).
    Ready,
    /// An existing vault was found but encrypted with a user password.
    /// Migration is needed: the user must provide their old password once.
    NeedsMigration,
}

impl VaultStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            unlocked: None,
            revision: 0,
        }
    }

    /// Automatically create or unlock the vault without user interaction.
    /// Returns `NeedsMigration` if an existing vault is encrypted with a user password.
    pub fn auto_open(&mut self) -> AppResult<AutoOpenResult> {
        if !self.path.exists() {
            self.create(AUTO_PASSWORD)?;
            return Ok(AutoOpenResult::Ready);
        }
        match self.unlock(AUTO_PASSWORD) {
            Ok(_) => {
                // Re-encrypt with fast KDF if currently using slow params
                self.upgrade_to_fast_kdf_if_needed();
                Ok(AutoOpenResult::Ready)
            }
            Err(_) => Ok(AutoOpenResult::NeedsMigration),
        }
    }

    /// If the vault is using slow KDF params (from a previous migration),
    /// re-encrypt with fast params for faster startup next time.
    fn upgrade_to_fast_kdf_if_needed(&mut self) {
        let needs_upgrade = self
            .unlocked
            .as_ref()
            .map(|u| u.crypto.is_slow())
            .unwrap_or(false);
        if !needs_upgrade {
            return;
        }
        let data = match self.unlocked.as_ref() {
            Some(u) => u.data.clone(),
            None => return,
        };
        if let Ok((encrypted, crypto)) = crypto::encrypt_with_password_fast(AUTO_PASSWORD, &data) {
            if write_encrypted(&self.path, &encrypted).is_ok() {
                self.unlocked = Some(UnlockedVault { data, crypto });
            }
        }
    }

    /// Migrate an existing vault from a user password to the internal auto-key.
    /// Called once when the user provides their old master password.
    pub fn migrate(&mut self, old_password: &str) -> AppResult<ConfigSnapshot> {
        // Decrypt with the user's old password
        self.unlock(old_password)?;
        // Re-encrypt with the internal auto-key (fast KDF)
        let data = self.unlocked()?.data.clone();
        let (encrypted, crypto) = crypto::encrypt_with_password_fast(AUTO_PASSWORD, &data)?;
        write_encrypted(&self.path, &encrypted)?;
        self.unlocked = Some(UnlockedVault {
            data: data.clone(),
            crypto,
        });
        Ok(self.snapshot_for(data))
    }

    pub fn vault_file_path(&self) -> PathBuf {
        self.path.clone()
    }

    #[cfg(test)]
    pub fn status(&self) -> VaultStatus {
        VaultStatus {
            exists: self.path.exists(),
            unlocked: self.unlocked.is_some(),
        }
    }

    pub fn create(&mut self, master_password: &str) -> AppResult<ConfigSnapshot> {
        if self.path.exists() {
            return Err(AppError::VaultAlreadyExists);
        }

        let data = VaultData::with_default_group();
        let (encrypted, crypto) = if master_password == AUTO_PASSWORD {
            crypto::encrypt_with_password_fast(master_password, &data)?
        } else {
            crypto::encrypt_with_password(master_password, &data)?
        };
        write_encrypted(&self.path, &encrypted)?;
        self.unlocked = Some(UnlockedVault {
            data: data.clone(),
            crypto,
        });
        Ok(self.snapshot_for(data))
    }

    pub fn unlock(&mut self, master_password: &str) -> AppResult<ConfigSnapshot> {
        let encrypted = read_encrypted(&self.path)?;
        let (mut data, crypto) = crypto::decrypt_with_password(master_password, &encrypted)?;
        if migrate_vault_data(&mut data) {
            let encrypted = crypto::encrypt_with_session(&crypto, &data)?;
            write_encrypted(&self.path, &encrypted)?;
        }
        self.unlocked = Some(UnlockedVault {
            data: data.clone(),
            crypto,
        });
        Ok(self.snapshot_for(data))
    }

    #[cfg(test)]
    pub fn lock(&mut self) {
        self.unlocked = None;
    }

    pub fn ensure_unlocked(&self) -> AppResult<()> {
        self.unlocked()?;
        Ok(())
    }

    pub fn snapshot(&self) -> AppResult<ConfigSnapshot> {
        Ok(self.snapshot_for(self.unlocked()?.data.clone()))
    }

    pub fn settings_proxy_update(
        &mut self,
        proxy: Option<AppProxyOptions>,
    ) -> AppResult<ConfigSnapshot> {
        self.mutate(|data| {
            data.settings.proxy = proxy;
            validate_settings(&data.settings)
        })
    }

    pub fn settings_backup_update(
        &mut self,
        backup: BackupSettings,
    ) -> AppResult<(ConfigSnapshot, Vec<BackupCleanupTarget>)> {
        let mut cleanup_targets = Vec::new();
        let snapshot = self.mutate(|data| {
            let previous = data.settings.backup.clone();
            data.settings.backup = backup;
            validate_settings(&data.settings)?;
            cleanup_targets = prune_backup_records(data, Some(&previous));
            Ok(())
        })?;
        Ok((snapshot, cleanup_targets))
    }

    pub fn quick_command_upsert(&mut self, mut command: QuickCommand) -> AppResult<ConfigSnapshot> {
        command.id = command.id.trim().to_string();
        command.name = command.name.trim().to_string();
        command.command = command.command.trim().to_string();
        if command.id.is_empty() {
            return Err(AppError::InvalidInput("常用命令 ID 不能为空".to_string()));
        }
        self.mutate(|data| {
            if let Some(existing) = data
                .settings
                .quick_commands
                .iter_mut()
                .find(|existing| existing.id == command.id)
            {
                *existing = command;
            } else {
                data.settings.quick_commands.push(command);
                if data.settings.quick_commands.len() > 100 {
                    let remove_count = data.settings.quick_commands.len() - 100;
                    data.settings.quick_commands.drain(0..remove_count);
                }
            }
            validate_settings(&data.settings)
        })
    }

    pub fn quick_command_delete(&mut self, command_id: &str) -> AppResult<ConfigSnapshot> {
        let command_id = command_id.trim();
        if command_id.is_empty() {
            return Err(AppError::InvalidInput("常用命令 ID 不能为空".to_string()));
        }
        self.mutate(|data| {
            let before_len = data.settings.quick_commands.len();
            data.settings
                .quick_commands
                .retain(|command| command.id != command_id);
            if data.settings.quick_commands.len() == before_len {
                return Err(AppError::NotFound(format!("常用命令 {command_id}")));
            }
            validate_settings(&data.settings)
        })
    }

    pub fn settings_ai_api_update(
        &mut self,
        settings: AiApiSettingsUpdate,
    ) -> AppResult<ConfigSnapshot> {
        self.mutate(|data| {
            if matches!(settings.port, Some(port) if port < 1024) {
                return Err(AppError::InvalidInput(
                    "AI API 端口必须在 1024-65535 之间".to_string(),
                ));
            }
            let mut session_ids: Vec<String> = Vec::new();
            for session_id in settings.session_ids {
                let session_id = session_id.trim();
                if session_id.is_empty() || session_ids.iter().any(|id| id.as_str() == session_id) {
                    continue;
                }
                if session_ids.len() >= 20 {
                    return Err(AppError::InvalidInput(
                        "AI API 最多允许 20 个会话".to_string(),
                    ));
                }
                if !data.sessions.iter().any(|session| session.id == session_id) {
                    return Err(AppError::NotFound(format!("会话 {session_id}")));
                }
                session_ids.push(session_id.to_string());
            }
            if settings.auto_start && (session_ids.is_empty() || settings.port.is_none()) {
                return Err(AppError::InvalidInput(
                    "AI API 自动启动需要端口和至少一个授权会话".to_string(),
                ));
            }
            data.settings.ai_api_session_id = session_ids.first().cloned();
            data.settings.ai_api_session_ids = session_ids;
            data.settings.ai_api_port = settings.port;
            data.settings.ai_api_auto_start = settings.auto_start;
            validate_settings(&data.settings)
        })
    }

    pub fn settings_ai_api_key_update(
        &mut self,
        api_key: Option<String>,
    ) -> AppResult<ConfigSnapshot> {
        self.mutate(|data| {
            data.settings.ai_api_key = api_key;
            validate_settings(&data.settings)
        })
    }

    pub fn settings_ignore_update_version(&mut self, version: String) -> AppResult<ConfigSnapshot> {
        let version = version.trim().trim_start_matches(['v', 'V']).to_string();
        if version.is_empty() {
            return Err(AppError::InvalidInput("忽略版本不能为空".to_string()));
        }
        self.mutate(|data| {
            if !data.settings.ignored_update_versions.contains(&version) {
                data.settings.ignored_update_versions.push(version);
            }
            validate_settings(&data.settings)
        })
    }

    pub fn connection_section_state_update(
        &mut self,
        collapsed_section_ids: Vec<String>,
    ) -> AppResult<ConfigSnapshot> {
        self.mutate(|data| {
            let allowed_builtin = ["favorites", "recent", "ungrouped", "all"];
            let mut normalized = Vec::new();
            for section_id in collapsed_section_ids {
                let section_id = section_id.trim();
                let allowed = allowed_builtin.contains(&section_id)
                    || data.groups.iter().any(|group| group.id == section_id);
                if allowed && !normalized.iter().any(|current| current == section_id) {
                    normalized.push(section_id.to_string());
                }
            }
            crate::config::validate_collapsed_connection_section_ids(&normalized)?;
            data.settings.collapsed_connection_section_ids = normalized;
            Ok(())
        })
    }

    pub fn create_tunnel(&mut self, input: TunnelInput) -> AppResult<ConfigSnapshot> {
        self.mutate(|data| {
            validate_tunnel_input(data, &input)?;
            data.tunnels.push(TunnelConfig::new(input));
            Ok(())
        })
    }

    pub fn tunnels(&self) -> AppResult<Vec<TunnelConfig>> {
        Ok(self.unlocked()?.data.tunnels.clone())
    }

    pub fn sessions(&self) -> AppResult<Vec<SessionConfig>> {
        Ok(self.unlocked()?.data.sessions.clone())
    }

    pub fn backup_settings(&self) -> AppResult<BackupSettings> {
        Ok(self.unlocked()?.data.settings.backup.clone())
    }

    pub fn backup_records(&self) -> AppResult<Vec<BackupRecord>> {
        Ok(self.unlocked()?.data.backup_records.clone())
    }

    pub fn validate_tunnel_update(&self, tunnel_id: &str, input: &TunnelInput) -> AppResult<()> {
        let data = &self.unlocked()?.data;
        if !data.tunnels.iter().any(|tunnel| tunnel.id == tunnel_id) {
            return Err(AppError::NotFound(format!("隧道 {}", tunnel_id)));
        }
        validate_tunnel_input(data, input)
    }

    pub fn update_tunnel(
        &mut self,
        tunnel_id: &str,
        input: TunnelInput,
    ) -> AppResult<ConfigSnapshot> {
        self.mutate(|data| {
            validate_tunnel_input(data, &input)?;
            let tunnel = data
                .tunnels
                .iter_mut()
                .find(|tunnel| tunnel.id == tunnel_id)
                .ok_or_else(|| AppError::NotFound(format!("隧道 {}", tunnel_id)))?;
            tunnel.update(input);
            Ok(())
        })
    }

    pub fn delete_tunnel(&mut self, tunnel_id: &str) -> AppResult<ConfigSnapshot> {
        self.mutate(|data| {
            let before_len = data.tunnels.len();
            data.tunnels.retain(|tunnel| tunnel.id != tunnel_id);
            if before_len == data.tunnels.len() {
                return Err(AppError::NotFound(format!("隧道 {}", tunnel_id)));
            }
            Ok(())
        })
    }

    pub fn validate_backup(&self, path: &Path) -> AppResult<ConfigSnapshot> {
        let payload = read_backup_payload(path)?;
        self.validate_backup_bytes(&payload)
    }

    pub fn validate_backup_bytes(&self, bytes: &[u8]) -> AppResult<ConfigSnapshot> {
        let payload = extract_backup_payload(bytes)?;
        let unlocked = self.unlocked()?;
        let encrypted = read_encrypted_bytes(&payload)?;
        let mut data = crypto::decrypt_with_key(&unlocked.crypto.key, &encrypted)
            .map_err(backup_decrypt_error)?;
        migrate_vault_data(&mut data);
        Ok(self.snapshot_for(data))
    }

    pub fn backup_import(&mut self, path: &Path) -> AppResult<ConfigSnapshot> {
        let payload = read_backup_payload(path)?;
        self.backup_import_bytes(&payload)
    }

    pub fn backup_import_bytes(&mut self, bytes: &[u8]) -> AppResult<ConfigSnapshot> {
        let payload = extract_backup_payload(bytes)?;
        let encrypted = read_encrypted_bytes(&payload)?;
        let vault_path = self.path.clone();
        let unlocked = self.unlocked_mut()?;
        let mut data = crypto::decrypt_with_key(&unlocked.crypto.key, &encrypted)
            .map_err(backup_decrypt_error)?;
        migrate_vault_data(&mut data);
        let encrypted = crypto::encrypt_with_session(&unlocked.crypto, &data)?;
        write_encrypted(&vault_path, &encrypted)?;
        unlocked.data = data.clone();
        self.revision = self.revision.saturating_add(1);
        Ok(self.snapshot_for(data))
    }

    #[cfg(test)]
    pub fn add_backup_records(
        &mut self,
        records: Vec<BackupRecord>,
    ) -> AppResult<(ConfigSnapshot, Vec<BackupCleanupTarget>)> {
        if records.is_empty() {
            return Ok((self.snapshot()?, Vec::new()));
        }
        let mut cleanup_targets = Vec::new();
        let snapshot = self.mutate(|data| {
            data.backup_records.extend(records);
            cleanup_targets = prune_backup_records(data, None);
            Ok(())
        })?;
        Ok((snapshot, cleanup_targets))
    }

    pub fn replace_backup_records(
        &mut self,
        records: Vec<BackupRecord>,
    ) -> AppResult<(ConfigSnapshot, Vec<BackupCleanupTarget>)> {
        let mut cleanup_targets = Vec::new();
        let snapshot = self.mutate(|data| {
            data.backup_records = records;
            cleanup_targets = prune_backup_records(data, None);
            Ok(())
        })?;
        Ok((snapshot, cleanup_targets))
    }

    pub fn delete_backup_record(
        &mut self,
        record_id: &str,
        delete_file: bool,
    ) -> AppResult<(ConfigSnapshot, Option<BackupCleanupTarget>)> {
        let mut cleanup_target = None;
        let snapshot = self.mutate(|data| {
            let index = data
                .backup_records
                .iter()
                .position(|record| record.id == record_id)
                .ok_or_else(|| AppError::NotFound(format!("备份记录 {}", record_id)))?;
            let record = data.backup_records.remove(index);
            if delete_file {
                cleanup_target = backup_cleanup_target(&data.settings.backup, &record);
            }
            Ok(())
        })?;
        Ok((snapshot, cleanup_target))
    }

    pub fn session(&self, session_id: &str) -> AppResult<SessionConfig> {
        self.unlocked()?
            .data
            .sessions
            .iter()
            .find(|session| session.id == session_id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("会话 {}", session_id)))
    }

    pub fn known_host(&self, host: &str, port: u16) -> AppResult<Option<KnownHostEntry>> {
        Ok(self
            .unlocked()?
            .data
            .known_hosts
            .iter()
            .find(|entry| entry.host == host && entry.port == port)
            .cloned())
    }

    pub fn trust_host_key(
        &mut self,
        session_id: &str,
        host: &str,
        port: u16,
        algorithm: String,
        fingerprint: String,
    ) -> AppResult<ConfigSnapshot> {
        self.mutate(|data| {
            let session = data
                .sessions
                .iter_mut()
                .find(|session| session.id == session_id)
                .ok_or_else(|| AppError::NotFound(format!("会话 {}", session_id)))?;
            if session.host != host || session.port != port {
                return Err(AppError::InvalidInput(
                    "会话地址已变化，请重新连接并确认主机密钥".to_string(),
                ));
            }
            let host = session.host.clone();
            session.ssh.host_key_fingerprint = Some(fingerprint.clone());

            let entry = KnownHostEntry {
                host: host.clone(),
                port,
                algorithm,
                fingerprint,
                trusted_at: crate::config::now(),
            };
            if let Some(existing) = data
                .known_hosts
                .iter_mut()
                .find(|known| known.host == host && known.port == port)
            {
                *existing = entry;
            } else {
                data.known_hosts.push(entry);
            }
            Ok(())
        })
    }

    pub fn create_group(&mut self, input: GroupInput) -> AppResult<ConfigSnapshot> {
        self.mutate(|data| {
            validate_group_input(data, None, &input)?;
            let sort_order = data.groups.len() as u32;
            data.groups.push(SessionGroup::new(input, sort_order));
            Ok(())
        })
    }

    pub fn update_group(&mut self, group_id: &str, input: GroupInput) -> AppResult<ConfigSnapshot> {
        self.mutate(|data| {
            validate_group_input(data, Some(group_id), &input)?;
            let group = data
                .groups
                .iter_mut()
                .find(|group| group.id == group_id)
                .ok_or_else(|| AppError::NotFound(format!("分组 {}", group_id)))?;
            group.update(input);
            Ok(())
        })
    }

    pub fn delete_group(&mut self, group_id: &str) -> AppResult<ConfigSnapshot> {
        self.mutate(|data| {
            if data.is_default_group_id(group_id) {
                return Err(AppError::InvalidInput("默认分组不允许删除".to_string()));
            }
            let default_group_id = data.default_group_id().map(str::to_string);
            let before_len = data.groups.len();
            data.groups.retain(|group| group.id != group_id);
            if before_len == data.groups.len() {
                return Err(AppError::NotFound(format!("分组 {}", group_id)));
            }
            for group in &mut data.groups {
                if group.parent_id.as_deref() == Some(group_id) {
                    group.parent_id = None;
                }
            }
            for session in &mut data.sessions {
                if session.group_id.as_deref() == Some(group_id) {
                    session.group_id = default_group_id.clone();
                }
            }
            data.settings
                .collapsed_connection_section_ids
                .retain(|section_id| section_id != group_id);
            Ok(())
        })
    }

    pub fn create_session(&mut self, input: SessionInput) -> AppResult<ConfigSnapshot> {
        self.mutate(|data| {
            validate_session_input(data, None, &input)?;
            data.sessions.push(SessionConfig::new(input));
            Ok(())
        })
    }

    pub fn update_session(
        &mut self,
        session_id: &str,
        input: SessionInput,
    ) -> AppResult<ConfigSnapshot> {
        self.mutate(|data| {
            validate_session_input(data, Some(session_id), &input)?;
            let session = data
                .sessions
                .iter_mut()
                .find(|session| session.id == session_id)
                .ok_or_else(|| AppError::NotFound(format!("会话 {}", session_id)))?;
            session.update(input);
            Ok(())
        })
    }

    pub fn set_session_favorite(
        &mut self,
        session_id: &str,
        favorite: bool,
    ) -> AppResult<ConfigSnapshot> {
        self.mutate(|data| {
            let session = data
                .sessions
                .iter_mut()
                .find(|session| session.id == session_id)
                .ok_or_else(|| AppError::NotFound(format!("会话 {}", session_id)))?;
            session.favorite = favorite;
            session.updated_at = crate::config::now();
            Ok(())
        })
    }

    pub fn mark_session_recent(&mut self, session_id: &str) -> AppResult<ConfigSnapshot> {
        self.mutate(|data| {
            let session = data
                .sessions
                .iter_mut()
                .find(|session| session.id == session_id)
                .ok_or_else(|| AppError::NotFound(format!("会话 {}", session_id)))?;
            session.last_connected_at = Some(crate::config::now());
            session.connection_count = session.connection_count.saturating_add(1);
            Ok(())
        })
    }

    pub fn clear_session_recent(&mut self, session_id: &str) -> AppResult<ConfigSnapshot> {
        self.mutate(|data| {
            let session = data
                .sessions
                .iter_mut()
                .find(|session| session.id == session_id)
                .ok_or_else(|| AppError::NotFound(format!("会话 {}", session_id)))?;
            session.last_connected_at = None;
            session.connection_count = 0;
            Ok(())
        })
    }

    pub fn delete_session(&mut self, session_id: &str) -> AppResult<ConfigSnapshot> {
        self.mutate(|data| {
            let before_len = data.sessions.len();
            data.sessions.retain(|session| session.id != session_id);
            if before_len == data.sessions.len() {
                return Err(AppError::NotFound(format!("会话 {}", session_id)));
            }
            data.tunnels
                .retain(|tunnel| tunnel.session_id != session_id);
            data.settings
                .ai_api_session_ids
                .retain(|id| id != session_id);
            if data.settings.ai_api_session_ids.is_empty()
                && data.settings.ai_api_session_id.as_deref() != Some(session_id)
            {
                if let Some(legacy_id) = data.settings.ai_api_session_id.take() {
                    if data.sessions.iter().any(|session| session.id == legacy_id) {
                        data.settings.ai_api_session_ids.push(legacy_id);
                    }
                }
            }
            data.settings.ai_api_session_id = data.settings.ai_api_session_ids.first().cloned();
            if data.settings.ai_api_session_ids.is_empty() {
                data.settings.ai_api_auto_start = false;
            }
            Ok(())
        })
    }

    fn mutate(
        &mut self,
        update: impl FnOnce(&mut VaultData) -> AppResult<()>,
    ) -> AppResult<ConfigSnapshot> {
        let unlocked = self.unlocked()?;
        let mut next_data = unlocked.data.clone();
        update(&mut next_data)?;
        next_data.touch();
        let encrypted = crypto::encrypt_with_session(&unlocked.crypto, &next_data)?;
        write_encrypted(&self.path, &encrypted)?;
        self.unlocked_mut()?.data = next_data.clone();
        self.revision = self.revision.saturating_add(1);
        Ok(self.snapshot_for(next_data))
    }

    fn snapshot_for(&self, data: VaultData) -> ConfigSnapshot {
        ConfigSnapshot {
            data,
            revision: self.revision,
        }
    }

    fn unlocked(&self) -> AppResult<&UnlockedVault> {
        self.unlocked.as_ref().ok_or(AppError::VaultLocked)
    }

    fn unlocked_mut(&mut self) -> AppResult<&mut UnlockedVault> {
        self.unlocked.as_mut().ok_or(AppError::VaultLocked)
    }
}

fn read_encrypted(path: &Path) -> AppResult<EncryptedVault> {
    if !path.exists() {
        return Err(AppError::VaultNotFound);
    }
    let content = fs::read(path)?;
    read_encrypted_bytes(&content)
}

fn read_backup_payload(path: &Path) -> AppResult<Vec<u8>> {
    if !path.exists() {
        return Err(AppError::VaultNotFound);
    }
    let content = fs::read(path)?;
    extract_backup_payload(&content)
}

fn read_encrypted_bytes(bytes: &[u8]) -> AppResult<EncryptedVault> {
    Ok(serde_json::from_slice(bytes)?)
}

fn write_encrypted(path: &Path, encrypted: &EncryptedVault) -> AppResult<()> {
    let content = serde_json::to_string_pretty(encrypted)?;
    write_atomic(path, content.as_bytes())
}

fn backup_decrypt_error(error: AppError) -> AppError {
    match error {
        AppError::InvalidMasterPassword => {
            AppError::InvalidInput("备份文件与当前工作区不匹配或已损坏".to_string())
        }
        other => other,
    }
}

fn prune_backup_records(
    data: &mut VaultData,
    previous_settings: Option<&BackupSettings>,
) -> Vec<BackupCleanupTarget> {
    let retention_count = usize::from(data.settings.backup.retention_count.max(1));
    let retention_days = i64::from(data.settings.backup.retention_days);
    let cutoff = if retention_days > 0 {
        Some(Utc::now() - Duration::days(retention_days))
    } else {
        None
    };

    data.backup_records
        .sort_by(|left, right| right.created_at.cmp(&left.created_at));

    let mut success_counts: HashMap<String, usize> = HashMap::new();
    let mut failure_counts: HashMap<String, usize> = HashMap::new();
    let mut remove_ids = HashSet::new();
    let mut cleanup_targets = Vec::new();

    for record in &data.backup_records {
        let counts = if record.status == "success" {
            &mut success_counts
        } else {
            &mut failure_counts
        };
        let count = counts.entry(record.target_kind.clone()).or_insert(0);
        *count += 1;
        let too_many = *count > retention_count;
        let too_old = cutoff
            .as_ref()
            .and_then(|cutoff| {
                DateTime::parse_from_rfc3339(&record.created_at)
                    .ok()
                    .map(|created| created.with_timezone(&Utc) < *cutoff)
            })
            .unwrap_or(false);
        if too_many || too_old {
            remove_ids.insert(record.id.clone());
            if let Some(target) =
                backup_cleanup_target(&data.settings.backup, record).or_else(|| {
                    previous_settings.and_then(|settings| backup_cleanup_target(settings, record))
                })
            {
                cleanup_targets.push(target);
            }
        }
    }

    data.backup_records
        .retain(|record| !remove_ids.contains(&record.id));
    cleanup_targets
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;
    use crate::config::AppSettings;
    use crate::config::{AuthConfig, TerminalOptions};

    fn store_path() -> PathBuf {
        tempdir().unwrap().keep().join(VAULT_FILE_NAME)
    }

    fn session_input(name: &str, group_id: Option<String>) -> SessionInput {
        SessionInput {
            name: name.to_string(),
            group_id,
            host: "127.0.0.1".to_string(),
            port: 22,
            username: "root".to_string(),
            auth: AuthConfig::password(Some("secret".to_string())),
            ssh: Default::default(),
            default_path: "/tmp".to_string(),
            tags: vec!["test".to_string()],
            note: None,
            terminal: TerminalOptions::default(),
            sftp: Default::default(),
        }
    }

    fn tunnel_input(name: &str, session_id: String) -> TunnelInput {
        TunnelInput {
            name: name.to_string(),
            session_id,
            forward_type: "local".to_string(),
            bind_host: "127.0.0.1".to_string(),
            bind_port: 0,
            target_host: "127.0.0.1".to_string(),
            target_port: 22,
        }
    }

    #[test]
    fn rejects_snapshot_before_unlock() {
        let store = VaultStore::new(store_path());
        assert!(matches!(store.snapshot(), Err(AppError::VaultLocked)));
    }

    #[test]
    fn persists_group_and_session_crud() {
        let path = store_path();
        let mut store = VaultStore::new(path.clone());
        store.create("pass-123456").unwrap();
        let snapshot = store
            .create_group(GroupInput {
                name: "生产".to_string(),
                parent_id: None,
            })
            .unwrap();
        let group_id = snapshot.data.groups.last().unwrap().id.clone();
        let snapshot = store
            .create_session(session_input("节点A", Some(group_id)))
            .unwrap();
        let session_id = snapshot.data.sessions.last().unwrap().id.clone();
        store.delete_session(&session_id).unwrap();
        store.lock();

        let snapshot = store.unlock("pass-123456").unwrap();
        assert!(snapshot
            .data
            .groups
            .iter()
            .any(|group| group.name == "生产"));
        assert!(!snapshot
            .data
            .sessions
            .iter()
            .any(|session| session.id == session_id || session.name == "节点A"));
    }

    #[test]
    fn migrates_vault_from_old_password() {
        let path = store_path();
        let mut store = VaultStore::new(path.clone());
        store.create("old-pass").unwrap();
        store.create_session(session_input("节点A", None)).unwrap();
        store.lock();

        // Simulate app restart: auto_open detects old password
        let mut store2 = VaultStore::new(path.clone());
        let result = store2.auto_open().unwrap();
        assert_eq!(result, AutoOpenResult::NeedsMigration);

        // User provides old password to migrate
        let snapshot = store2.migrate("old-pass").unwrap();
        assert!(snapshot.data.sessions.iter().any(|s| s.name == "节点A"));
        store2.lock();

        // After migration, auto_open works without password
        let mut store3 = VaultStore::new(path);
        let result = store3.auto_open().unwrap();
        assert_eq!(result, AutoOpenResult::Ready);
        let snapshot = store3.snapshot().unwrap();
        assert!(snapshot.data.sessions.iter().any(|s| s.name == "节点A"));
    }

    #[test]
    fn create_starts_with_default_group_and_no_sessions() {
        let path = store_path();
        let mut store = VaultStore::new(path);
        let snapshot = store.create("pass-123456").unwrap();

        assert_eq!(snapshot.data.groups.len(), 1);
        assert_eq!(snapshot.data.groups[0].name, "默认分组");
        assert!(snapshot.data.sessions.is_empty());
        assert!(snapshot.data.known_hosts.is_empty());
    }

    #[test]
    fn field_level_settings_updates_preserve_other_domains_and_advance_revision() {
        let path = store_path();
        let mut store = VaultStore::new(path);
        let initial = store.create("pass-123456").unwrap();
        let proxy = AppProxyOptions {
            enabled: true,
            kind: "socks5".to_string(),
            host: "127.0.0.1".to_string(),
            port: 1080,
        };
        let proxy_snapshot = store.settings_proxy_update(Some(proxy.clone())).unwrap();
        let backup = BackupSettings {
            retention_count: 3,
            ..BackupSettings::default()
        };
        let (backup_snapshot, delete_paths) = store.settings_backup_update(backup.clone()).unwrap();

        assert_eq!(proxy_snapshot.revision, initial.revision + 1);
        assert_eq!(backup_snapshot.revision, proxy_snapshot.revision + 1);
        assert_eq!(backup_snapshot.data.settings.proxy, Some(proxy));
        assert_eq!(backup_snapshot.data.settings.backup, backup);
        assert!(delete_paths.is_empty());
    }

    #[test]
    fn host_key_trust_rejects_a_stale_session_address() {
        let path = store_path();
        let mut store = VaultStore::new(path);
        store.create("pass-123456").unwrap();
        let snapshot = store.create_session(session_input("节点A", None)).unwrap();
        let session_id = snapshot.data.sessions[0].id.clone();
        let revision = snapshot.revision;

        assert!(store
            .trust_host_key(
                &session_id,
                "changed.example.com",
                22,
                "ssh-ed25519".to_string(),
                "SHA256:stale".to_string(),
            )
            .is_err());
        let unchanged = store.snapshot().unwrap();
        assert_eq!(unchanged.revision, revision);
        assert!(unchanged.data.known_hosts.is_empty());

        let trusted = store
            .trust_host_key(
                &session_id,
                "127.0.0.1",
                22,
                "ssh-ed25519".to_string(),
                "SHA256:current".to_string(),
            )
            .unwrap();
        assert_eq!(trusted.data.known_hosts.len(), 1);
        assert_eq!(trusted.data.known_hosts[0].fingerprint, "SHA256:current");
    }

    #[test]
    fn quick_command_upsert_and_delete_are_atomic_and_validated() {
        let path = store_path();
        let mut store = VaultStore::new(path);
        store.create("pass-123456").unwrap();
        let command = QuickCommand {
            id: " command-a ".to_string(),
            name: " 查看状态 ".to_string(),
            command: " systemctl status sshd ".to_string(),
            created_at: Some("2026-01-01T00:00:00Z".to_string()),
            updated_at: None,
        };

        let snapshot = store.quick_command_upsert(command).unwrap();
        assert_eq!(snapshot.data.settings.quick_commands.len(), 1);
        assert_eq!(snapshot.data.settings.quick_commands[0].id, "command-a");
        assert_eq!(snapshot.data.settings.quick_commands[0].name, "查看状态");

        let mut updated = snapshot.data.settings.quick_commands[0].clone();
        updated.command = "systemctl restart sshd".to_string();
        let snapshot = store.quick_command_upsert(updated).unwrap();
        assert_eq!(snapshot.data.settings.quick_commands.len(), 1);
        assert_eq!(
            snapshot.data.settings.quick_commands[0].command,
            "systemctl restart sshd"
        );

        let before_invalid = store.snapshot().unwrap();
        assert!(store
            .quick_command_upsert(QuickCommand {
                id: "command-b".to_string(),
                name: " ".to_string(),
                command: "echo bad".to_string(),
                created_at: None,
                updated_at: None,
            })
            .is_err());
        let after_invalid = store.snapshot().unwrap();
        assert_eq!(after_invalid.revision, before_invalid.revision);
        assert_eq!(after_invalid.data, before_invalid.data);

        let snapshot = store.quick_command_delete(" command-a ").unwrap();
        assert!(snapshot.data.settings.quick_commands.is_empty());
        assert!(store.quick_command_delete("command-a").is_err());
    }

    #[test]
    fn ai_api_settings_are_normalized_and_validated_against_sessions() {
        let path = store_path();
        let mut store = VaultStore::new(path);
        store.create("pass-123456").unwrap();
        let snapshot = store.create_session(session_input("节点A", None)).unwrap();
        let session_id = snapshot.data.sessions[0].id.clone();

        let snapshot = store
            .settings_ai_api_update(AiApiSettingsUpdate {
                session_ids: vec![session_id.clone(), session_id.clone(), " ".to_string()],
                port: Some(19880),
                auto_start: true,
            })
            .unwrap();
        assert_eq!(
            snapshot.data.settings.ai_api_session_id,
            Some(session_id.clone())
        );
        assert_eq!(snapshot.data.settings.ai_api_session_ids, vec![session_id]);
        assert!(snapshot.data.settings.ai_api_auto_start);

        assert!(store
            .settings_ai_api_update(AiApiSettingsUpdate {
                session_ids: vec!["missing".to_string()],
                port: Some(19880),
                auto_start: false,
            })
            .is_err());
        assert!(store
            .settings_ai_api_update(AiApiSettingsUpdate {
                session_ids: Vec::new(),
                port: Some(19880),
                auto_start: true,
            })
            .is_err());
    }

    #[test]
    fn deleting_session_prunes_ai_api_authorization_and_disables_empty_autostart() {
        let path = store_path();
        let mut store = VaultStore::new(path);
        store.create("pass-123456").unwrap();
        let first = store.create_session(session_input("节点A", None)).unwrap();
        let first_id = first.data.sessions[0].id.clone();
        let second = store.create_session(session_input("节点B", None)).unwrap();
        let second_id = second.data.sessions[1].id.clone();
        store
            .settings_ai_api_update(AiApiSettingsUpdate {
                session_ids: vec![first_id.clone(), second_id.clone()],
                port: Some(19880),
                auto_start: true,
            })
            .unwrap();

        let snapshot = store.delete_session(&first_id).unwrap();
        assert_eq!(
            snapshot.data.settings.ai_api_session_ids,
            vec![second_id.clone()]
        );
        assert_eq!(
            snapshot.data.settings.ai_api_session_id,
            Some(second_id.clone())
        );
        assert!(snapshot.data.settings.ai_api_auto_start);

        let snapshot = store.delete_session(&second_id).unwrap();
        assert!(snapshot.data.settings.ai_api_session_ids.is_empty());
        assert_eq!(snapshot.data.settings.ai_api_session_id, None);
        assert!(!snapshot.data.settings.ai_api_auto_start);
    }

    #[test]
    fn ignored_update_version_append_is_normalized_and_idempotent() {
        let path = store_path();
        let mut store = VaultStore::new(path);
        store.create("pass-123456").unwrap();

        store
            .settings_ignore_update_version(" v1.2.3 ".to_string())
            .unwrap();
        let snapshot = store
            .settings_ignore_update_version("1.2.3".to_string())
            .unwrap();

        assert_eq!(
            snapshot.data.settings.ignored_update_versions,
            vec!["1.2.3".to_string()]
        );
    }

    #[test]
    fn backup_records_are_pruned_by_retention_count() {
        let path = store_path();
        let mut store = VaultStore::new(path);
        store.create("pass-123456").unwrap();
        let mut settings = AppSettings::default();
        settings.backup.retention_count = 1;
        settings.backup.local_directory = Some("C:\\backup".to_string());
        store.settings_backup_update(settings.backup).unwrap();

        let first = BackupRecord::success(
            "HelM-backup-a.rpvault".to_string(),
            "local",
            "C:\\backup\\HelM-backup-a.rpvault".to_string(),
            10,
        );
        let second = BackupRecord::success(
            "HelM-backup-b.rpvault".to_string(),
            "local",
            "C:\\backup\\HelM-backup-b.rpvault".to_string(),
            10,
        );

        let (_snapshot, delete_paths) = store.add_backup_records(vec![first, second]).unwrap();
        assert_eq!(store.snapshot().unwrap().data.backup_records.len(), 1);
        assert_eq!(delete_paths.len(), 1);
    }

    #[test]
    fn lowering_backup_retention_prunes_existing_records_and_uses_previous_directory() {
        let path = store_path();
        let mut store = VaultStore::new(path);
        store.create("pass-123456").unwrap();
        let old_directory = PathBuf::from("C:\\backup-old");
        let initial = BackupSettings {
            local_directory: Some(old_directory.to_string_lossy().to_string()),
            retention_count: 10,
            retention_days: 3650,
            ..BackupSettings::default()
        };
        store.settings_backup_update(initial).unwrap();

        let older = BackupRecord {
            created_at: "2026-01-01T00:00:00Z".to_string(),
            ..BackupRecord::success(
                "HelM-backup-old.zip".to_string(),
                "local",
                old_directory
                    .join("HelM-backup-old.zip")
                    .to_string_lossy()
                    .to_string(),
                10,
            )
        };
        let newer = BackupRecord {
            created_at: "2026-01-02T00:00:00Z".to_string(),
            ..BackupRecord::success(
                "HelM-backup-new.zip".to_string(),
                "local",
                old_directory
                    .join("HelM-backup-new.zip")
                    .to_string_lossy()
                    .to_string(),
                10,
            )
        };
        store.add_backup_records(vec![older, newer]).unwrap();

        let updated = BackupSettings {
            local_directory: Some("C:\\backup-new".to_string()),
            retention_count: 1,
            retention_days: 3650,
            ..BackupSettings::default()
        };
        let (snapshot, delete_paths) = store.settings_backup_update(updated).unwrap();

        assert_eq!(snapshot.data.backup_records.len(), 1);
        assert_eq!(
            snapshot.data.backup_records[0].file_name,
            "HelM-backup-new.zip"
        );
        assert_eq!(
            delete_paths,
            vec![BackupCleanupTarget::Local(
                old_directory.join("HelM-backup-old.zip")
            )]
        );
    }

    #[test]
    fn failed_backups_do_not_displace_the_latest_successful_restore_point() {
        let path = store_path();
        let mut store = VaultStore::new(path);
        store.create("pass-123456").unwrap();
        let settings = BackupSettings {
            retention_count: 1,
            retention_days: 3650,
            ..BackupSettings::default()
        };
        store.settings_backup_update(settings).unwrap();
        let success = BackupRecord {
            created_at: "2026-01-01T00:00:00Z".to_string(),
            ..BackupRecord::success(
                "HelM-backup-success.zip".to_string(),
                "webdav",
                "https://dav.example/HelM-backup-success.zip".to_string(),
                10,
            )
        };
        let failure = BackupRecord {
            created_at: "2026-01-02T00:00:00Z".to_string(),
            ..BackupRecord::failed(
                "HelM-backup-failed.zip".to_string(),
                "webdav",
                "https://dav.example".to_string(),
                "network error".to_string(),
            )
        };

        let (snapshot, _) = store.add_backup_records(vec![success, failure]).unwrap();

        assert_eq!(snapshot.data.backup_records.len(), 2);
        assert!(snapshot
            .data
            .backup_records
            .iter()
            .any(|record| record.status == "success"));
        assert!(snapshot
            .data
            .backup_records
            .iter()
            .any(|record| record.status == "failed"));
    }

    #[test]
    fn deleting_a_tampered_backup_record_never_authorizes_an_external_file() {
        let path = store_path();
        let mut store = VaultStore::new(path);
        store.create("pass-123456").unwrap();
        let mut settings = AppSettings::default();
        settings.backup.local_directory = Some("C:\\backup".to_string());
        store.settings_backup_update(settings.backup).unwrap();
        let record = BackupRecord::success(
            "HelM-backup-safe.zip".to_string(),
            "local",
            "C:\\outside\\HelM-backup-safe.zip".to_string(),
            10,
        );
        let record_id = record.id.clone();
        store.add_backup_records(vec![record]).unwrap();

        let (snapshot, delete_path) = store.delete_backup_record(&record_id, true).unwrap();
        assert!(snapshot.data.backup_records.is_empty());
        assert!(delete_path.is_none());
    }

    #[test]
    fn connection_count_increments_once_per_mark_and_resets_with_recent_history() {
        let path = store_path();
        let mut store = VaultStore::new(path);
        store.create("pass-123456").unwrap();
        let snapshot = store.create_session(session_input("节点A", None)).unwrap();
        let session_id = snapshot.data.sessions[0].id.clone();

        let snapshot = store.mark_session_recent(&session_id).unwrap();
        assert_eq!(snapshot.data.sessions[0].connection_count, 1);
        assert!(snapshot.data.sessions[0].last_connected_at.is_some());

        let snapshot = store.mark_session_recent(&session_id).unwrap();
        assert_eq!(snapshot.data.sessions[0].connection_count, 2);

        store.lock();
        let snapshot = store.unlock("pass-123456").unwrap();
        assert_eq!(snapshot.data.sessions[0].connection_count, 2);

        let snapshot = store.clear_session_recent(&session_id).unwrap();
        assert_eq!(snapshot.data.sessions[0].connection_count, 0);
        assert!(snapshot.data.sessions[0].last_connected_at.is_none());
    }

    #[test]
    fn persists_connection_section_state_and_prunes_deleted_groups() {
        let path = store_path();
        let mut store = VaultStore::new(path);
        store.create("pass-123456").unwrap();
        let snapshot = store
            .create_group(GroupInput {
                name: "生产".to_string(),
                parent_id: None,
            })
            .unwrap();
        let group_id = snapshot.data.groups.last().unwrap().id.clone();

        let snapshot = store
            .connection_section_state_update(vec![
                "recent".to_string(),
                group_id.clone(),
                "recent".to_string(),
                "search".to_string(),
            ])
            .unwrap();
        assert_eq!(
            snapshot.data.settings.collapsed_connection_section_ids,
            vec!["recent".to_string(), group_id.clone()]
        );

        store.lock();
        let snapshot = store.unlock("pass-123456").unwrap();
        assert_eq!(
            snapshot.data.settings.collapsed_connection_section_ids,
            vec!["recent".to_string(), group_id.clone()]
        );

        let snapshot = store.delete_group(&group_id).unwrap();
        assert_eq!(
            snapshot.data.settings.collapsed_connection_section_ids,
            vec!["recent".to_string()]
        );
    }

    #[test]
    fn import_with_unrelated_key_does_not_overwrite_current_vault() {
        let path = store_path();
        let backup_path = path.with_file_name("foreign.rpvault");
        let mut store = VaultStore::new(path.clone());
        store.create("current-pass").unwrap();

        let mut foreign = VaultStore::new(backup_path.clone());
        foreign.create("backup-pass").unwrap();

        assert!(store.backup_import(&backup_path).is_err());
        store.lock();
        let snapshot = store.unlock("current-pass").unwrap();
        assert_eq!(snapshot.data.groups[0].name, "默认分组");
    }

    #[test]
    fn manages_tunnel_templates_and_rejects_missing_session() {
        let path = store_path();
        let mut store = VaultStore::new(path);
        store.create("pass-123456").unwrap();
        let snapshot = store.create_session(session_input("节点A", None)).unwrap();
        let session_id = snapshot.data.sessions[0].id.clone();

        let snapshot = store
            .create_tunnel(tunnel_input("数据库", session_id.clone()))
            .unwrap();
        let tunnel_id = snapshot.data.tunnels[0].id.clone();
        assert_eq!(snapshot.data.tunnels[0].name, "数据库");

        let snapshot = store
            .update_tunnel(&tunnel_id, tunnel_input("数据库新", session_id))
            .unwrap();
        assert_eq!(snapshot.data.tunnels[0].name, "数据库新");

        let snapshot = store.delete_tunnel(&tunnel_id).unwrap();
        assert!(snapshot.data.tunnels.is_empty());
        assert!(store
            .create_tunnel(tunnel_input("缺失会话", "missing".to_string()))
            .is_err());
    }

    #[test]
    fn tunnel_update_validation_does_not_mutate_existing_template() {
        let path = store_path();
        let mut store = VaultStore::new(path);
        store.create("pass-123456").unwrap();
        let snapshot = store.create_session(session_input("节点A", None)).unwrap();
        let session_id = snapshot.data.sessions[0].id.clone();
        let snapshot = store
            .create_tunnel(tunnel_input("数据库", session_id))
            .unwrap();
        let tunnel_id = snapshot.data.tunnels[0].id.clone();
        let before = store.snapshot().unwrap();

        let invalid = tunnel_input(" ", before.data.sessions[0].id.clone());
        assert!(store.validate_tunnel_update(&tunnel_id, &invalid).is_err());
        assert!(store
            .validate_tunnel_update(
                "missing",
                &tunnel_input("有效", before.data.sessions[0].id.clone())
            )
            .is_err());
        let after = store.snapshot().unwrap();
        assert_eq!(after.revision, before.revision);
        assert_eq!(after.data, before.data);
    }

    #[test]
    fn failed_persistence_does_not_mutate_in_memory_snapshot() {
        let path = store_path();
        let mut store = VaultStore::new(path.clone());
        store.create("pass-123456").unwrap();
        let before = store.snapshot().unwrap();

        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        let result = store.create_group(GroupInput {
            name: "不应保留".to_string(),
            parent_id: None,
        });

        assert!(result.is_err());
        assert_eq!(store.snapshot().unwrap().data, before.data);
    }
}
