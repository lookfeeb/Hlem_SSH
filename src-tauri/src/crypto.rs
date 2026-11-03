use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use rand::{rngs::OsRng, RngCore};

use crate::{
    config::VaultData,
    errors::{AppError, AppResult},
};

const VAULT_FORMAT_VERSION: u16 = 2;
const BINARY_MAGIC: &[u8; 8] = b"RPVAULT\0";
const BINARY_HEADER_LEN: usize = 70;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const KEY_LEN: usize = 32;

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

#[derive(Debug, Clone, Copy)]
struct KdfParams {
    m_cost_kib: u32,
    t_cost: u32,
    parallelism: u32,
}

impl KdfParams {
    fn argon2(&self) -> AppResult<Argon2<'static>> {
        if self.m_cost_kib > 256 * 1024 || self.t_cost > 10 || self.parallelism > 16 {
            return Err(AppError::Crypto("Argon2 参数超出支持范围".into()));
        }
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

#[derive(Debug, Clone)]
pub struct EncryptedVault {
    params: KdfParams,
    salt: [u8; SALT_LEN],
    nonce: [u8; NONCE_LEN],
    ciphertext: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct CryptoSession {
    pub key: [u8; KEY_LEN],
    pub salt: [u8; SALT_LEN],
    /// 当前 vault 派生 key 时使用的 KDF 参数。
    /// 后续写入必须使用同一组参数，否则下一次解锁会派生出不同 key。
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
    let mut encrypted = EncryptedVault {
        params: session.params,
        salt: session.salt,
        nonce,
        ciphertext: Vec::new(),
    };
    let header = binary_header(&encrypted, plaintext.len() + 16);
    encrypted.ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &plaintext,
                aad: &header,
            },
        )
        .map_err(|_| AppError::Crypto("加密本机数据失败".into()))?;
    Ok(encrypted)
}

pub fn decrypt_with_password(
    master_password: &str,
    encrypted: &EncryptedVault,
) -> AppResult<(VaultData, CryptoSession)> {
    let salt = encrypted.salt;
    let nonce = encrypted.nonce;
    let ciphertext = &encrypted.ciphertext;
    let aad = binary_header(encrypted, ciphertext.len());
    let params = encrypted.params;
    let key = derive_key(master_password, &salt, &params)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&key)
        .map_err(|error| AppError::Crypto(format!("初始化解密器失败: {error}")))?;
    let plaintext = cipher
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: ciphertext,
                aad: &aad,
            },
        )
        .map_err(|_| AppError::InvalidMasterPassword)?;
    let data = serde_json::from_slice(&plaintext).map_err(|_| AppError::InvalidMasterPassword)?;
    Ok((data, CryptoSession { key, salt, params }))
}

pub fn decrypt_with_key(key: &[u8; KEY_LEN], encrypted: &EncryptedVault) -> AppResult<VaultData> {
    let nonce = encrypted.nonce;
    let ciphertext = &encrypted.ciphertext;
    let aad = binary_header(encrypted, ciphertext.len());
    let cipher = XChaCha20Poly1305::new_from_slice(key)
        .map_err(|error| AppError::Crypto(format!("初始化解密器失败: {error}")))?;
    let plaintext = cipher
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: ciphertext,
                aad: &aad,
            },
        )
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

fn binary_header(encrypted: &EncryptedVault, ciphertext_len: usize) -> Vec<u8> {
    let params = encrypted.params;
    let mut header = Vec::with_capacity(BINARY_HEADER_LEN);
    header.extend_from_slice(BINARY_MAGIC);
    header.extend_from_slice(&VAULT_FORMAT_VERSION.to_le_bytes());
    for value in [params.m_cost_kib, params.t_cost, params.parallelism] {
        header.extend_from_slice(&value.to_le_bytes());
    }
    header.extend_from_slice(&encrypted.salt);
    header.extend_from_slice(&encrypted.nonce);
    header.extend_from_slice(&(ciphertext_len as u64).to_le_bytes());
    header
}

pub fn encode_vault(encrypted: &EncryptedVault) -> AppResult<Vec<u8>> {
    let mut bytes = binary_header(encrypted, encrypted.ciphertext.len());
    bytes.extend_from_slice(&encrypted.ciphertext);
    Ok(bytes)
}

pub fn decode_vault(bytes: &[u8]) -> AppResult<EncryptedVault> {
    if !bytes.starts_with(BINARY_MAGIC) {
        return Err(AppError::Crypto(
            "仅支持二进制 v2 工作区，请使用已迁移的数据文件".into(),
        ));
    }
    if bytes.len() < BINARY_HEADER_LEN + 16
        || u16::from_le_bytes(bytes[8..10].try_into().unwrap()) != VAULT_FORMAT_VERSION
    {
        return Err(AppError::Crypto("二进制工作区版本无效或数据不完整".into()));
    }
    let read_u32 = |at| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
    let params = KdfParams {
        m_cost_kib: read_u32(10),
        t_cost: read_u32(14),
        parallelism: read_u32(18),
    };
    params.argon2()?;
    let length = u64::from_le_bytes(bytes[62..70].try_into().unwrap());
    if length != (bytes.len() - BINARY_HEADER_LEN) as u64 {
        return Err(AppError::Crypto("二进制工作区长度不匹配".into()));
    }
    Ok(EncryptedVault {
        params,
        salt: bytes[22..38].try_into().unwrap(),
        nonce: bytes[38..62].try_into().unwrap(),
        ciphertext: bytes[BINARY_HEADER_LEN..].to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_vault_authenticates_header_and_rejects_truncation() {
        let data = VaultData::with_default_group();
        let (encrypted, _) = encrypt_with_password_fast("pass-123456", &data).unwrap();
        let bytes = encode_vault(&encrypted).unwrap();
        assert!(bytes.starts_with(BINARY_MAGIC));
        let decoded = decode_vault(&bytes).unwrap();
        assert_eq!(
            decrypt_with_password("pass-123456", &decoded).unwrap().0,
            data
        );
        for index in [10, 22, 38, 70] {
            let mut tampered = bytes.clone();
            tampered[index] ^= 1;
            if let Ok(decoded) = decode_vault(&tampered) {
                assert!(decrypt_with_password("pass-123456", &decoded).is_err());
            }
        }
        for length in [0, 8, 69, 70, bytes.len() - 1] {
            assert!(decode_vault(&bytes[..length]).is_err());
        }
        let mut extended = bytes.clone();
        extended.push(0);
        assert!(decode_vault(&extended).is_err());
    }

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
        encrypted.ciphertext.push(b'A');
        assert!(decrypt_with_password("pass-123456", &encrypted).is_err());
    }

    #[test]
    fn decrypts_with_current_key() {
        let data = VaultData::with_default_group();
        let (encrypted, session) = encrypt_with_password("pass-123456", &data).unwrap();
        let decrypted = decrypt_with_key(&session.key, &encrypted).unwrap();
        assert_eq!(decrypted, data);
    }

    #[test]
    fn rejects_unsupported_vault_versions_and_invalid_kdf_parameters() {
        assert!(decode_vault(br#"{"magic":"RPVAULT","version":1}"#).is_err());
        let (encrypted, _) =
            encrypt_with_password_fast("pass-123456", &VaultData::with_default_group()).unwrap();
        let bytes = encode_vault(&encrypted).unwrap();
        for version in [0_u16, 1, 3, u16::MAX] {
            let mut invalid = bytes.clone();
            invalid[8..10].copy_from_slice(&version.to_le_bytes());
            assert!(decode_vault(&invalid).is_err());
        }
        for (offset, value) in [
            (10, 0_u32),
            (10, 256 * 1024 + 1),
            (14, 0),
            (14, 11),
            (18, 0),
            (18, 17),
        ] {
            let mut invalid = bytes.clone();
            invalid[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
            assert!(decode_vault(&invalid).is_err());
        }
    }
}
