use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};

use crate::{
    config::VaultData,
    errors::{AppError, AppResult},
};

const MAGIC: &str = "RPVAULT";
const VAULT_FORMAT_VERSION: u16 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const KEY_LEN: usize = 32;

const KDF_ALGORITHM: &str = "argon2id";
const AEAD_ALGORITHM: &str = "xchacha20poly1305";
const MIN_MASTER_PASSWORD_LEN: usize = 6;

/// Argon2id 参数（new vault 的默认强度，~64 MiB / 3 轮）。
const KDF_PARAMS_CURRENT: KdfParams = KdfParams {
    m_cost_kib: 64 * 1024,
    t_cost: 3,
    parallelism: 1,
};

/// 快速 KDF 参数，用于内置密钥加密的 vault（无需抗暴力破解）。
/// 启动解密几乎零延迟。
const KDF_PARAMS_FAST: KdfParams = KdfParams {
    m_cost_kib: 1024,
    t_cost: 1,
    parallelism: 1,
};

/// 兼容历史：早期版本写入的是 `"argon2-default"` 占位字符串，
/// 实际派生用的是 `Argon2::default()`，对应这组参数。
/// 升级 KDF 后必须用这组参数解开旧 vault，否则用户被锁死。
const KDF_PARAMS_LEGACY_DEFAULT: KdfParams = KdfParams {
    m_cost_kib: 19_456,
    t_cost: 2,
    parallelism: 1,
};
const KDF_PARAMS_LEGACY_TAG: &str = "argon2-default";

#[derive(Debug, Clone, Copy)]
struct KdfParams {
    m_cost_kib: u32,
    t_cost: u32,
    parallelism: u32,
}

impl KdfParams {
    fn encode(&self) -> String {
        format!(
            "m={},t={},p={}",
            self.m_cost_kib, self.t_cost, self.parallelism
        )
    }

    /// Header 里写的是 `"m=N,t=N,p=N"` 或老格式 `"argon2-default"`；
    /// 解析失败（任何未知格式）一律退回 legacy 默认，保证旧文件能继续打开。
    fn parse(raw: &str) -> Self {
        let raw = raw.trim();
        if raw.eq_ignore_ascii_case(KDF_PARAMS_LEGACY_TAG) || raw.is_empty() {
            return KDF_PARAMS_LEGACY_DEFAULT;
        }
        let mut m_cost: Option<u32> = None;
        let mut t_cost: Option<u32> = None;
        let mut parallelism: Option<u32> = None;
        for part in raw.split(',') {
            let mut it = part.splitn(2, '=');
            let key = it.next().unwrap_or("").trim();
            let value = it.next().unwrap_or("").trim();
            let parsed = value.parse::<u32>().ok();
            match key {
                "m" | "m_cost" => m_cost = parsed,
                "t" | "t_cost" | "iterations" => t_cost = parsed,
                "p" | "parallelism" => parallelism = parsed,
                _ => {}
            }
        }
        match (m_cost, t_cost, parallelism) {
            (Some(m), Some(t), Some(p)) if m > 0 && t > 0 && p > 0 => KdfParams {
                m_cost_kib: m,
                t_cost: t,
                parallelism: p,
            },
            _ => KDF_PARAMS_LEGACY_DEFAULT,
        }
    }

    fn argon2(&self) -> AppResult<Argon2<'static>> {
        let params = Params::new(
            self.m_cost_kib,
            self.t_cost,
            self.parallelism,
            Some(KEY_LEN),
        )
        .map_err(|error| AppError::Crypto(format!("Argon2 参数无效: {error}")))?;
        Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedVault {
    pub magic: String,
    pub version: u16,
    pub kdf: KdfHeader,
    pub aead: String,
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KdfHeader {
    pub algorithm: String,
    pub params: String,
}

#[derive(Debug, Clone)]
pub struct CryptoSession {
    pub key: [u8; KEY_LEN],
    pub salt: [u8; SALT_LEN],
    /// 当前 vault 派生 key 时使用的 KDF 参数。
    /// mutate 写盘时 header 的 params 字段必须用同一组，否则下一次解锁会派生出不同 key。
    params: KdfParams,
}

impl CryptoSession {
    /// Returns true if this session uses KDF params significantly slower than the fast preset.
    pub fn is_slow(&self) -> bool {
        self.params.m_cost_kib > KDF_PARAMS_FAST.m_cost_kib * 2
            || self.params.t_cost > KDF_PARAMS_FAST.t_cost * 2
    }
}

pub fn encrypt_with_password(
    master_password: &str,
    data: &VaultData,
) -> AppResult<(EncryptedVault, CryptoSession)> {
    validate_master_password(master_password)?;
    let mut salt = [0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);
    let params = KDF_PARAMS_CURRENT;
    let key = derive_key(master_password, &salt, &params)?;
    let session = CryptoSession { key, salt, params };
    let encrypted = encrypt_with_session(&session, data)?;
    Ok((encrypted, session))
}

/// Encrypt with minimal KDF cost — used for internal auto-key vaults
/// where brute-force resistance is unnecessary.
pub fn encrypt_with_password_fast(
    master_password: &str,
    data: &VaultData,
) -> AppResult<(EncryptedVault, CryptoSession)> {
    validate_master_password(master_password)?;
    let mut salt = [0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);
    let params = KDF_PARAMS_FAST;
    let key = derive_key(master_password, &salt, &params)?;
    let session = CryptoSession { key, salt, params };
    let encrypted = encrypt_with_session(&session, data)?;
    Ok((encrypted, session))
}

pub fn encrypt_with_session(
    session: &CryptoSession,
    data: &VaultData,
) -> AppResult<EncryptedVault> {
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);

    let plaintext = serde_json::to_vec(data)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&session.key)
        .map_err(|error| AppError::Crypto(format!("初始化加密器失败: {error}")))?;
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), plaintext.as_ref())
        .map_err(|_| AppError::Crypto("加密本机数据失败".to_string()))?;

    Ok(EncryptedVault {
        magic: MAGIC.to_string(),
        version: VAULT_FORMAT_VERSION,
        kdf: KdfHeader {
            algorithm: KDF_ALGORITHM.to_string(),
            params: session.params.encode(),
        },
        aead: AEAD_ALGORITHM.to_string(),
        salt: STANDARD.encode(session.salt),
        nonce: STANDARD.encode(nonce),
        ciphertext: STANDARD.encode(ciphertext),
    })
}

pub fn decrypt_with_password(
    master_password: &str,
    encrypted: &EncryptedVault,
) -> AppResult<(VaultData, CryptoSession)> {
    validate_header(encrypted)?;
    let salt = decode_fixed::<SALT_LEN>(&encrypted.salt)?;
    let nonce = decode_fixed::<NONCE_LEN>(&encrypted.nonce)?;
    let ciphertext = STANDARD
        .decode(&encrypted.ciphertext)
        .map_err(|_| AppError::InvalidMasterPassword)?;
    let params = KdfParams::parse(&encrypted.kdf.params);
    let key = derive_key(master_password, &salt, &params)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&key)
        .map_err(|error| AppError::Crypto(format!("初始化解密器失败: {error}")))?;
    let plaintext = cipher
        .decrypt(XNonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| AppError::InvalidMasterPassword)?;
    let data = serde_json::from_slice(&plaintext).map_err(|_| AppError::InvalidMasterPassword)?;
    Ok((data, CryptoSession { key, salt, params }))
}

pub fn decrypt_with_key(key: &[u8; KEY_LEN], encrypted: &EncryptedVault) -> AppResult<VaultData> {
    validate_header(encrypted)?;
    let nonce = decode_fixed::<NONCE_LEN>(&encrypted.nonce)?;
    let ciphertext = STANDARD
        .decode(&encrypted.ciphertext)
        .map_err(|_| AppError::InvalidMasterPassword)?;
    let cipher = XChaCha20Poly1305::new_from_slice(key)
        .map_err(|error| AppError::Crypto(format!("初始化解密器失败: {error}")))?;
    let plaintext = cipher
        .decrypt(XNonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| AppError::InvalidMasterPassword)?;
    serde_json::from_slice(&plaintext).map_err(|_| AppError::InvalidMasterPassword)
}

pub fn validate_master_password(master_password: &str) -> AppResult<()> {
    if master_password.chars().count() < MIN_MASTER_PASSWORD_LEN {
        return Err(AppError::InvalidInput(format!(
            "主密码长度至少 {MIN_MASTER_PASSWORD_LEN} 个字符"
        )));
    }
    Ok(())
}

fn derive_key(
    master_password: &str,
    salt: &[u8; SALT_LEN],
    params: &KdfParams,
) -> AppResult<[u8; KEY_LEN]> {
    let argon2 = params.argon2()?;
    let mut key = [0u8; KEY_LEN];
    argon2
        .hash_password_into(master_password.as_bytes(), salt, &mut key)
        .map_err(|error| AppError::Crypto(format!("派生加密密钥失败: {error}")))?;
    Ok(key)
}

fn validate_header(encrypted: &EncryptedVault) -> AppResult<()> {
    if encrypted.magic != MAGIC || encrypted.version != VAULT_FORMAT_VERSION {
        return Err(AppError::Crypto("不支持的本机数据格式".to_string()));
    }
    if encrypted.kdf.algorithm != KDF_ALGORITHM || encrypted.aead != AEAD_ALGORITHM {
        return Err(AppError::Crypto("不支持的加密算法".to_string()));
    }
    Ok(())
}

fn decode_fixed<const N: usize>(value: &str) -> AppResult<[u8; N]> {
    let decoded = STANDARD
        .decode(value)
        .map_err(|_| AppError::InvalidMasterPassword)?;
    decoded
        .try_into()
        .map_err(|_| AppError::InvalidMasterPassword)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decrypts_with_correct_master_password() {
        let data = VaultData::with_default_group();
        let (encrypted, _) = encrypt_with_password("pass-123456", &data).unwrap();
        let (decrypted, _) = decrypt_with_password("pass-123456", &encrypted).unwrap();
        assert_eq!(decrypted, data);
    }

    #[test]
    fn rejects_wrong_master_password() {
        let data = VaultData::with_default_group();
        let (encrypted, _) = encrypt_with_password("pass-123456", &data).unwrap();
        assert!(matches!(
            decrypt_with_password("wrong-password", &encrypted),
            Err(AppError::InvalidMasterPassword)
        ));
    }

    #[test]
    fn rejects_tampered_ciphertext() {
        let data = VaultData::with_default_group();
        let (mut encrypted, _) = encrypt_with_password("pass-123456", &data).unwrap();
        encrypted.ciphertext.push('A');
        assert!(decrypt_with_password("pass-123456", &encrypted).is_err());
    }

    #[test]
    fn decrypts_with_current_key() {
        let data = VaultData::with_default_group();
        let (encrypted, session) = encrypt_with_password("pass-123456", &data).unwrap();
        let decrypted = decrypt_with_key(&session.key, &encrypted).unwrap();
        assert_eq!(decrypted, data);
    }

    /// 历史 vault：header 写的是 `"argon2-default"` 占位，实际用 Argon2::default 派生。
    /// 这是用户机器上现存格式，必须能继续打开。
    #[test]
    fn opens_legacy_default_argon2_vault() {
        use argon2::Argon2;

        let password = "pass-123456";
        let data = VaultData::with_default_group();
        let mut salt = [0u8; SALT_LEN];
        OsRng.fill_bytes(&mut salt);

        // 构造早期版本写出的 Argon2::default 派生 key
        let mut legacy_key = [0u8; KEY_LEN];
        Argon2::default()
            .hash_password_into(password.as_bytes(), &salt, &mut legacy_key)
            .unwrap();

        // 构造早期版本写出的 header
        let mut nonce = [0u8; NONCE_LEN];
        OsRng.fill_bytes(&mut nonce);
        let cipher = XChaCha20Poly1305::new_from_slice(&legacy_key).unwrap();
        let plaintext = serde_json::to_vec(&data).unwrap();
        let ciphertext = cipher
            .encrypt(XNonce::from_slice(&nonce), plaintext.as_ref())
            .unwrap();
        let legacy_vault = EncryptedVault {
            magic: MAGIC.to_string(),
            version: VAULT_FORMAT_VERSION,
            kdf: KdfHeader {
                algorithm: KDF_ALGORITHM.to_string(),
                params: KDF_PARAMS_LEGACY_TAG.to_string(),
            },
            aead: AEAD_ALGORITHM.to_string(),
            salt: STANDARD.encode(salt),
            nonce: STANDARD.encode(nonce),
            ciphertext: STANDARD.encode(ciphertext),
        };

        let (decrypted, session) = decrypt_with_password(password, &legacy_vault).unwrap();
        assert_eq!(decrypted, data);

        // 解锁后用 session 重新写盘：header 必须仍能再次解锁（参数自洽）。
        let rewritten = encrypt_with_session(&session, &data).unwrap();
        let (decrypted_again, _) = decrypt_with_password(password, &rewritten).unwrap();
        assert_eq!(decrypted_again, data);
    }

    #[test]
    fn parses_known_kdf_param_strings() {
        let p = KdfParams::parse("m=65536,t=3,p=1");
        assert_eq!(p.m_cost_kib, 65536);
        assert_eq!(p.t_cost, 3);
        assert_eq!(p.parallelism, 1);

        let legacy = KdfParams::parse("argon2-default");
        assert_eq!(legacy.m_cost_kib, KDF_PARAMS_LEGACY_DEFAULT.m_cost_kib);

        let unknown = KdfParams::parse("garbage-tag");
        assert_eq!(unknown.m_cost_kib, KDF_PARAMS_LEGACY_DEFAULT.m_cost_kib);
    }
}
