use std::{
    io::{Cursor, ErrorKind, Read, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use bytes::Bytes;
use chrono::{DateTime, Duration as ChronoDuration, FixedOffset, TimeZone, Utc};
use hmac::{Hmac, Mac};
use reqwest::{
    header::{HeaderMap, HeaderValue, AUTHORIZATION, HOST},
    Method,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use url::Url;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

use crate::{
    config::{
        BackupRecord, BackupSettings, CloudBackupSettings, S3BackupConfig, WebdavBackupConfig,
    },
    errors::{AppError, AppResult},
    http_client::{http_client, send_with_retry},
    vault::VaultStore,
};

type HmacSha256 = Hmac<Sha256>;
const BACKUP_PAYLOAD_NAME: &str = "vault.rpvault";
const BACKUP_MANIFEST_NAME: &str = "manifest.json";
const CLOUD_LIST_TIMEOUT: Duration = Duration::from_secs(30);
const CLOUD_TRANSFER_TIMEOUT: Duration = Duration::from_secs(120);

pub fn backup_file_name() -> String {
    let beijing = beijing_now();
    format!("HelM-backup-{}-BJT.zip", beijing.format("%Y%m%d-%H%M%S"))
}

pub async fn remove_backup_file_best_effort(path: impl AsRef<Path>, context: &str) {
    let path = path.as_ref();
    match tokio::fs::remove_file(path).await {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => {
            eprintln!(
                "[helm] failed to remove backup file after {context}: {}: {error}",
                path.display()
            );
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupManifest {
    app: &'static str,
    format: &'static str,
    version: u16,
    created_at: String,
    timezone: &'static str,
    payload: &'static str,
}

#[derive(Clone)]
pub struct BackupRunPlan {
    pub settings: BackupSettings,
    pub vault_path: PathBuf,
    pub file_name: String,
}

pub fn prepare_backup_run(store: &VaultStore) -> AppResult<BackupRunPlan> {
    store.ensure_unlocked()?;
    let snapshot = store.snapshot()?;
    Ok(BackupRunPlan {
        settings: snapshot.data.settings.backup,
        vault_path: store.vault_file_path(),
        file_name: backup_file_name(),
    })
}

pub async fn build_backup_package(vault_bytes: Vec<u8>) -> AppResult<Vec<u8>> {
    tokio::task::spawn_blocking(move || build_backup_package_sync(&vault_bytes))
        .await
        .map_err(|error| AppError::Io(format!("备份打包任务失败: {error}")))?
}

pub async fn run_configured_backup(plan: &BackupRunPlan) -> AppResult<Vec<BackupRecord>> {
    run_backup(plan, None, false).await
}

pub async fn run_auto_backup(
    plan: &BackupRunPlan,
    target_kinds: &[String],
) -> AppResult<Vec<BackupRecord>> {
    run_backup(plan, Some(target_kinds), true).await
}

async fn run_backup(
    plan: &BackupRunPlan,
    target_kinds: Option<&[String]>,
    automatic: bool,
) -> AppResult<Vec<BackupRecord>> {
    let bytes = tokio::fs::read(&plan.vault_path)
        .await
        .map_err(|e| AppError::Io(e.to_string()))?;
    let package = build_backup_package(bytes).await?;
    let size = package.len() as u64;
    let mut outcomes = Vec::new();

    if (!automatic || plan.settings.auto_enabled) && target_selected(target_kinds, "local") {
        if let Some(directory) = configured_local_backup_directory(&plan.settings) {
            outcomes.push(write_local_backup(&directory, &plan.file_name, &package, size).await);
        }
    }
    if (!automatic || plan.settings.cloud.auto_enabled)
        && target_selected(target_kinds, &plan.settings.cloud.kind)
        && configured_cloud_backup(&plan.settings.cloud)
    {
        outcomes.push(
            upload_cloud_backup(&plan.settings.cloud, &plan.file_name, package.clone()).await,
        );
    }
    if outcomes.is_empty() {
        return Err(AppError::InvalidInput(
            "请先配置本地备份目录或云端备份".to_string(),
        ));
    }

    Ok(outcomes)
}

pub async fn merge_configured_backup_records(
    settings: &BackupSettings,
    backup_outcomes: Vec<BackupRecord>,
) -> Vec<BackupRecord> {
    match list_configured_backup_records(settings).await {
        Ok(mut records) => {
            for outcome in backup_outcomes {
                let already_listed = records.iter().any(|r| {
                    r.target_kind == outcome.target_kind && r.target_path == outcome.target_path
                });
                if outcome.status != "success" || !already_listed {
                    records.push(outcome);
                }
            }
            records
        }
        Err(_) => backup_outcomes,
    }
}

pub fn configured_local_backup_directory(settings: &BackupSettings) -> Option<PathBuf> {
    settings
        .local_directory
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

pub fn configured_cloud_backup(cloud: &CloudBackupSettings) -> bool {
    match cloud.kind.as_str() {
        "webdav" => !cloud.webdav.endpoint.trim().is_empty(),
        "s3" => {
            !cloud.s3.endpoint.trim().is_empty()
                && !cloud.s3.region.trim().is_empty()
                && !cloud.s3.bucket.trim().is_empty()
                && !cloud.s3.access_key_id.trim().is_empty()
                && !cloud.s3.secret_access_key.trim().is_empty()
        }
        _ => false,
    }
}

pub fn auto_backup_due_target_kinds(
    settings: &BackupSettings,
    records: &[BackupRecord],
) -> Vec<String> {
    let Some(interval) = backup_frequency_duration(&settings.frequency) else {
        return Vec::new();
    };
    let mut target_kinds = Vec::new();
    if settings.auto_enabled && configured_local_backup_directory(settings).is_some() {
        target_kinds.push("local".to_string());
    }
    if settings.cloud.auto_enabled && configured_cloud_backup(&settings.cloud) {
        target_kinds.push(settings.cloud.kind.clone());
    }
    target_kinds
        .into_iter()
        .filter(|target_kind| should_run_target_auto_backup(target_kind, interval, records))
        .collect()
}

fn target_selected(target_kinds: Option<&[String]>, target_kind: &str) -> bool {
    target_kinds
        .map(|kinds| kinds.iter().any(|kind| kind == target_kind))
        .unwrap_or(true)
}

fn should_run_target_auto_backup(
    target_kind: &str,
    interval: ChronoDuration,
    records: &[BackupRecord],
) -> bool {
    let last_success = records
        .iter()
        .filter(|record| record.status == "success" && record.target_kind == target_kind)
        .filter_map(|record| DateTime::parse_from_rfc3339(&record.created_at).ok())
        .map(|datetime| datetime.with_timezone(&Utc))
        .max();
    match last_success {
        Some(last_success) => Utc::now().signed_duration_since(last_success) >= interval,
        None => true,
    }
}

fn backup_frequency_duration(frequency: &str) -> Option<ChronoDuration> {
    match frequency {
        "hourly" => Some(ChronoDuration::hours(1)),
        "daily" => Some(ChronoDuration::days(1)),
        "weekly" => Some(ChronoDuration::weeks(1)),
        _ => None,
    }
}

async fn write_local_backup(
    directory: &Path,
    file_name: &str,
    package: &[u8],
    size: u64,
) -> BackupRecord {
    let target = directory.join(file_name);
    let write_result = async {
        tokio::fs::create_dir_all(directory).await?;
        tokio::fs::write(&target, package).await?;
        Ok::<(), std::io::Error>(())
    }
    .await;
    match write_result {
        Ok(()) => BackupRecord::success(
            file_name.to_string(),
            "local",
            target.to_string_lossy().to_string(),
            size,
        ),
        Err(e) => BackupRecord::failed(
            file_name.to_string(),
            "local",
            target.to_string_lossy().to_string(),
            e.to_string(),
        ),
    }
}

fn build_backup_package_sync(vault_bytes: &[u8]) -> AppResult<Vec<u8>> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o600);
    let created_at = beijing_now().to_rfc3339();
    let manifest = BackupManifest {
        app: "HelM",
        format: "helm-backup-package",
        version: 1,
        created_at,
        timezone: "Asia/Shanghai",
        payload: BACKUP_PAYLOAD_NAME,
    };
    writer
        .start_file(BACKUP_MANIFEST_NAME, options)
        .map_err(|error| AppError::Io(error.to_string()))?;
    writer.write_all(&serde_json::to_vec_pretty(&manifest)?)?;
    writer
        .start_file(BACKUP_PAYLOAD_NAME, options)
        .map_err(|error| AppError::Io(error.to_string()))?;
    writer.write_all(vault_bytes)?;
    writer
        .finish()
        .map_err(|error| AppError::Io(error.to_string()))
        .map(|cursor| cursor.into_inner())
}

fn beijing_now() -> DateTime<FixedOffset> {
    let now = Utc::now();
    FixedOffset::east_opt(8 * 3600)
        .map(|offset| offset.from_utc_datetime(&now.naive_utc()))
        .unwrap_or_else(|| now.fixed_offset())
}

pub fn extract_backup_payload(bytes: &[u8]) -> AppResult<Vec<u8>> {
    if serde_json::from_slice::<serde_json::Value>(bytes).is_ok() {
        return Ok(bytes.to_vec());
    }
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| AppError::InvalidInput(format!("备份包无法打开: {error}")))?;
    let mut payload = archive
        .by_name(BACKUP_PAYLOAD_NAME)
        .map_err(|_| AppError::InvalidInput("备份包缺少 vault.rpvault".to_string()))?;
    let mut content = Vec::new();
    payload.read_to_end(&mut content)?;
    Ok(content)
}

pub async fn upload_cloud_backup(
    cloud: &CloudBackupSettings,
    file_name: &str,
    bytes: Vec<u8>,
) -> BackupRecord {
    let size = bytes.len() as u64;
    match cloud.kind.as_str() {
        "webdav" => match upload_webdav(&cloud.webdav, file_name, bytes).await {
            Ok(target) => BackupRecord::success(file_name.to_string(), "webdav", target, size),
            Err(error) => BackupRecord::failed(
                file_name.to_string(),
                "webdav",
                cloud.webdav.endpoint.clone(),
                error.to_string(),
            ),
        },
        "s3" => match upload_s3(&cloud.s3, file_name, bytes).await {
            Ok(target) => BackupRecord::success(file_name.to_string(), "s3", target, size),
            Err(error) => BackupRecord::failed(
                file_name.to_string(),
                "s3",
                cloud.s3.bucket.clone(),
                error.to_string(),
            ),
        },
        _ => BackupRecord::failed(
            file_name.to_string(),
            "cloud",
            String::new(),
            "云端备份类型无效".to_string(),
        ),
    }
}

pub async fn download_cloud_backup(
    cloud: &CloudBackupSettings,
    record: &BackupRecord,
) -> AppResult<Vec<u8>> {
    match record.target_kind.as_str() {
        "webdav" => download_webdav(&cloud.webdav, &record.target_path).await,
        "s3" => download_s3(&cloud.s3, &record.target_path).await,
        _ => Err(AppError::InvalidInput(
            "该备份记录不是可下载的云端备份".to_string(),
        )),
    }
}

pub async fn list_configured_backup_records(
    settings: &BackupSettings,
) -> AppResult<Vec<BackupRecord>> {
    let local_directory = configured_local_backup_directory(settings);
    let cloud = settings.cloud.clone();
    let cloud_configured = configured_cloud_backup(&cloud);

    let local_list = async move {
        match local_directory {
            Some(directory) => list_local_backup_records(directory).await,
            None => Ok(Vec::new()),
        }
    };
    let cloud_list = async move {
        if !cloud_configured {
            return Ok(Vec::new());
        }
        list_cloud_backup_records(&cloud).await
    };

    let (local_records, cloud_records) = tokio::join!(local_list, cloud_list);
    let mut records = local_records?;
    records.extend(cloud_records?);
    records.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(records)
}

async fn list_local_backup_records(directory: PathBuf) -> AppResult<Vec<BackupRecord>> {
    let mut entries = match tokio::fs::read_dir(&directory).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(AppError::Io(error.to_string())),
    };
    let mut records = Vec::new();
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|error| AppError::Io(error.to_string()))?
    {
        let metadata = entry
            .metadata()
            .await
            .map_err(|error| AppError::Io(error.to_string()))?;
        if !metadata.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().to_string();
        if !is_backup_file(&file_name) {
            continue;
        }
        let target_path = entry.path().to_string_lossy().to_string();
        let created_at = metadata
            .modified()
            .ok()
            .map(system_time_to_rfc3339)
            .unwrap_or_else(now_rfc3339);
        records.push(BackupRecord::listed(
            file_name,
            "local",
            target_path,
            metadata.len(),
            created_at,
        ));
    }
    Ok(records)
}

async fn list_cloud_backup_records(cloud: &CloudBackupSettings) -> AppResult<Vec<BackupRecord>> {
    match cloud.kind.as_str() {
        "webdav" => list_webdav_backups(&cloud.webdav).await,
        "s3" => list_s3_backups(&cloud.s3).await,
        _ => Err(AppError::InvalidInput("云端备份类型无效".to_string())),
    }
}

async fn upload_webdav(
    config: &WebdavBackupConfig,
    file_name: &str,
    bytes: Vec<u8>,
) -> AppResult<String> {
    let target = join_remote_url(&config.endpoint, &config.remote_path, file_name)?;
    let client = http_client(CLOUD_TRANSFER_TIMEOUT)?;
    let username = config.username.trim().to_string();
    let password = config.password.clone();
    let body = Bytes::from(bytes);
    let response = send_with_retry("WebDAV 上传", || {
        let request = client.put(&target).body(body.clone());
        if username.is_empty() {
            request
        } else {
            request.basic_auth(username.clone(), Some(password.clone()))
        }
    })
    .await?;
    if !response.status().is_success() {
        return Err(AppError::Remote(format!(
            "WebDAV 上传失败: HTTP {}",
            response.status()
        )));
    }
    Ok(target)
}

async fn download_webdav(config: &WebdavBackupConfig, target: &str) -> AppResult<Vec<u8>> {
    let client = http_client(CLOUD_TRANSFER_TIMEOUT)?;
    let target = target.trim().to_string();
    let username = config.username.trim().to_string();
    let password = config.password.clone();
    let response = send_with_retry("WebDAV 下载", || {
        let request = client.get(&target);
        if username.is_empty() {
            request
        } else {
            request.basic_auth(username.clone(), Some(password.clone()))
        }
    })
    .await?;
    if !response.status().is_success() {
        return Err(AppError::Remote(format!(
            "WebDAV 下载失败: HTTP {}",
            response.status()
        )));
    }
    response
        .bytes()
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(remote_error)
}

async fn list_webdav_backups(config: &WebdavBackupConfig) -> AppResult<Vec<BackupRecord>> {
    let target = webdav_collection_url(&config.endpoint, &config.remote_path)?;
    let client = http_client(CLOUD_LIST_TIMEOUT)?;
    let method =
        Method::from_bytes(b"PROPFIND").map_err(|error| AppError::Remote(error.to_string()))?;
    let username = config.username.trim().to_string();
    let password = config.password.clone();
    let response = send_with_retry("WebDAV 列表读取", || {
        let request = client
            .request(method.clone(), &target)
            .header("Depth", "1")
            .body(r#"<?xml version="1.0"?><propfind xmlns="DAV:"><prop><getcontentlength/><getlastmodified/></prop></propfind>"#);
        if username.is_empty() {
            request
        } else {
            request.basic_auth(username.clone(), Some(password.clone()))
        }
    })
    .await?;
    if !response.status().is_success() {
        return Err(AppError::Remote(format!(
            "WebDAV 列表读取失败: HTTP {}",
            response.status()
        )));
    }
    let text = response.text().await.map_err(remote_error)?;
    let mut records = Vec::new();
    for block in xml_blocks(&text, "response") {
        let Some(href) = xml_text(block, "href") else {
            continue;
        };
        let file_name = file_name_from_path(&href);
        if !is_backup_file(&file_name) {
            continue;
        }
        let size = xml_text(block, "getcontentlength")
            .and_then(|value| value.trim().parse::<u64>().ok())
            .unwrap_or(0);
        let created_at = xml_text(block, "getlastmodified")
            .and_then(|value| DateTime::parse_from_rfc2822(value.trim()).ok())
            .map(|value| value.with_timezone(&Utc).to_rfc3339())
            .unwrap_or_else(now_rfc3339);
        let target_path = if href.starts_with("http://") || href.starts_with("https://") {
            href
        } else {
            join_remote_url(&config.endpoint, &config.remote_path, &file_name)?
        };
        records.push(BackupRecord::listed(
            file_name,
            "webdav",
            target_path,
            size,
            created_at,
        ));
    }
    Ok(records)
}

async fn upload_s3(config: &S3BackupConfig, file_name: &str, bytes: Vec<u8>) -> AppResult<String> {
    let key = join_object_key(&config.prefix, file_name);
    let (url, canonical_uri, host) = s3_url(config, &key)?;
    let now = Utc::now();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let short_date = now.format("%Y%m%d").to_string();
    let body = Bytes::from(bytes);
    let payload_hash = hex::encode(Sha256::digest(&body));
    let canonical_headers = format!(
        "host:{}\nx-amz-content-sha256:{}\nx-amz-date:{}\n",
        host, payload_hash, amz_date
    );
    let signed_headers = "host;x-amz-content-sha256;x-amz-date";
    let canonical_request = format!(
        "PUT\n{}\n\n{}{}\n{}",
        canonical_uri, canonical_headers, signed_headers, payload_hash
    );
    let credential_scope = format!("{}/{}/s3/aws4_request", short_date, config.region.trim());
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{}\n{}",
        amz_date,
        credential_scope,
        hex::encode(Sha256::digest(canonical_request.as_bytes()))
    );
    let signing_key = s3_signing_key(&config.secret_access_key, &short_date, config.region.trim())?;
    let signature = hex::encode(hmac_sha256(&signing_key, string_to_sign.as_bytes())?);
    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
        config.access_key_id.trim(),
        credential_scope,
        signed_headers,
        signature
    );

    let mut headers = HeaderMap::new();
    headers.insert(
        HOST,
        HeaderValue::from_str(&host).map_err(|error| AppError::Remote(error.to_string()))?,
    );
    headers.insert(
        "x-amz-content-sha256",
        HeaderValue::from_str(&payload_hash)
            .map_err(|error| AppError::Remote(error.to_string()))?,
    );
    headers.insert(
        "x-amz-date",
        HeaderValue::from_str(&amz_date).map_err(|error| AppError::Remote(error.to_string()))?,
    );
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&authorization)
            .map_err(|error| AppError::Remote(error.to_string()))?,
    );

    let client = http_client(CLOUD_TRANSFER_TIMEOUT)?;
    let response = send_with_retry("S3 上传", || {
        client
            .put(url.as_str())
            .headers(headers.clone())
            .body(body.clone())
    })
    .await?;
    if !response.status().is_success() {
        return Err(AppError::Remote(format!(
            "S3 上传失败: HTTP {}",
            response.status()
        )));
    }
    Ok(format!("s3://{}/{}", config.bucket.trim(), key))
}

async fn download_s3(config: &S3BackupConfig, target_path: &str) -> AppResult<Vec<u8>> {
    let key = s3_key_from_target(config, target_path)?;
    let (url, canonical_uri, host) = s3_url(config, &key)?;
    let now = Utc::now();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let short_date = now.format("%Y%m%d").to_string();
    let payload_hash = hex::encode(Sha256::digest([]));
    let canonical_headers = format!(
        "host:{}\nx-amz-content-sha256:{}\nx-amz-date:{}\n",
        host, payload_hash, amz_date
    );
    let signed_headers = "host;x-amz-content-sha256;x-amz-date";
    let canonical_request = format!(
        "GET\n{}\n\n{}{}\n{}",
        canonical_uri, canonical_headers, signed_headers, payload_hash
    );
    let credential_scope = format!("{}/{}/s3/aws4_request", short_date, config.region.trim());
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{}\n{}",
        amz_date,
        credential_scope,
        hex::encode(Sha256::digest(canonical_request.as_bytes()))
    );
    let signing_key = s3_signing_key(&config.secret_access_key, &short_date, config.region.trim())?;
    let signature = hex::encode(hmac_sha256(&signing_key, string_to_sign.as_bytes())?);
    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
        config.access_key_id.trim(),
        credential_scope,
        signed_headers,
        signature
    );

    let mut headers = HeaderMap::new();
    headers.insert(
        HOST,
        HeaderValue::from_str(&host).map_err(|error| AppError::Remote(error.to_string()))?,
    );
    headers.insert(
        "x-amz-content-sha256",
        HeaderValue::from_str(&payload_hash)
            .map_err(|error| AppError::Remote(error.to_string()))?,
    );
    headers.insert(
        "x-amz-date",
        HeaderValue::from_str(&amz_date).map_err(|error| AppError::Remote(error.to_string()))?,
    );
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&authorization)
            .map_err(|error| AppError::Remote(error.to_string()))?,
    );

    let client = http_client(CLOUD_TRANSFER_TIMEOUT)?;
    let response = send_with_retry("S3 下载", || {
        client.get(url.as_str()).headers(headers.clone())
    })
    .await?;
    if !response.status().is_success() {
        return Err(AppError::Remote(format!(
            "S3 下载失败: HTTP {}",
            response.status()
        )));
    }
    response
        .bytes()
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(remote_error)
}

async fn list_s3_backups(config: &S3BackupConfig) -> AppResult<Vec<BackupRecord>> {
    let (mut url, canonical_uri, host) = s3_bucket_url(config)?;
    let prefix = config.prefix.trim().trim_matches('/');
    let prefix = if prefix.is_empty() {
        String::new()
    } else {
        format!("{}/", prefix)
    };
    url.query_pairs_mut()
        .append_pair("list-type", "2")
        .append_pair("prefix", &prefix);
    let canonical_query = url.query().unwrap_or_default().to_string();
    let now = Utc::now();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let short_date = now.format("%Y%m%d").to_string();
    let payload_hash = hex::encode(Sha256::digest([]));
    let canonical_headers = format!(
        "host:{}\nx-amz-content-sha256:{}\nx-amz-date:{}\n",
        host, payload_hash, amz_date
    );
    let signed_headers = "host;x-amz-content-sha256;x-amz-date";
    let canonical_request = format!(
        "GET\n{}\n{}\n{}{}\n{}",
        canonical_uri, canonical_query, canonical_headers, signed_headers, payload_hash
    );
    let credential_scope = format!("{}/{}/s3/aws4_request", short_date, config.region.trim());
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{}\n{}",
        amz_date,
        credential_scope,
        hex::encode(Sha256::digest(canonical_request.as_bytes()))
    );
    let signing_key = s3_signing_key(&config.secret_access_key, &short_date, config.region.trim())?;
    let signature = hex::encode(hmac_sha256(&signing_key, string_to_sign.as_bytes())?);
    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
        config.access_key_id.trim(),
        credential_scope,
        signed_headers,
        signature
    );

    let mut headers = HeaderMap::new();
    headers.insert(
        HOST,
        HeaderValue::from_str(&host).map_err(|error| AppError::Remote(error.to_string()))?,
    );
    headers.insert(
        "x-amz-content-sha256",
        HeaderValue::from_str(&payload_hash)
            .map_err(|error| AppError::Remote(error.to_string()))?,
    );
    headers.insert(
        "x-amz-date",
        HeaderValue::from_str(&amz_date).map_err(|error| AppError::Remote(error.to_string()))?,
    );
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&authorization)
            .map_err(|error| AppError::Remote(error.to_string()))?,
    );

    let client = http_client(CLOUD_LIST_TIMEOUT)?;
    let response = send_with_retry("S3 列表读取", || {
        client.get(url.as_str()).headers(headers.clone())
    })
    .await?;
    if !response.status().is_success() {
        return Err(AppError::Remote(format!(
            "S3 列表读取失败: HTTP {}",
            response.status()
        )));
    }
    let text = response.text().await.map_err(remote_error)?;
    let mut records = Vec::new();
    for block in xml_blocks(&text, "Contents") {
        let Some(key) = xml_text(block, "Key") else {
            continue;
        };
        let file_name = file_name_from_path(&key);
        if !is_backup_file(&file_name) {
            continue;
        }
        let size = xml_text(block, "Size")
            .and_then(|value| value.trim().parse::<u64>().ok())
            .unwrap_or(0);
        let created_at = xml_text(block, "LastModified")
            .and_then(|value| DateTime::parse_from_rfc3339(value.trim()).ok())
            .map(|value| value.with_timezone(&Utc).to_rfc3339())
            .unwrap_or_else(now_rfc3339);
        let target_path = format!("s3://{}/{}", config.bucket.trim(), key);
        records.push(BackupRecord::listed(
            file_name,
            "s3",
            target_path,
            size,
            created_at,
        ));
    }
    Ok(records)
}

fn join_remote_url(endpoint: &str, remote_path: &str, file_name: &str) -> AppResult<String> {
    let endpoint = endpoint.trim().trim_end_matches('/');
    if endpoint.is_empty() {
        return Err(AppError::InvalidInput("WebDAV 地址不能为空".to_string()));
    }
    let remote_path = remote_path.trim().trim_matches('/');
    if remote_path.is_empty() {
        Ok(format!("{}/{}", endpoint, file_name))
    } else {
        Ok(format!("{}/{}/{}", endpoint, remote_path, file_name))
    }
}

fn webdav_collection_url(endpoint: &str, remote_path: &str) -> AppResult<String> {
    let endpoint = endpoint.trim().trim_end_matches('/');
    if endpoint.is_empty() {
        return Err(AppError::InvalidInput("WebDAV 地址不能为空".to_string()));
    }
    let remote_path = remote_path.trim().trim_matches('/');
    if remote_path.is_empty() {
        Ok(format!("{}/", endpoint))
    } else {
        Ok(format!("{}/{}/", endpoint, remote_path))
    }
}

fn join_object_key(prefix: &str, file_name: &str) -> String {
    let prefix = prefix.trim().trim_matches('/');
    if prefix.is_empty() {
        file_name.to_string()
    } else {
        format!("{}/{}", prefix, file_name)
    }
}

fn s3_url(config: &S3BackupConfig, key: &str) -> AppResult<(Url, String, String)> {
    let mut url = Url::parse(config.endpoint.trim())
        .map_err(|error| AppError::InvalidInput(error.to_string()))?;
    let base_path = url.path().trim_end_matches('/').to_string();
    let encoded_key = encode_path(key);
    if config.path_style {
        let path = format!(
            "{}/{}/{}",
            base_path.trim_end_matches('/'),
            encode_segment(config.bucket.trim()),
            encoded_key
        );
        url.set_path(&path);
    } else {
        let host = url
            .host_str()
            .ok_or_else(|| AppError::InvalidInput("S3 endpoint 缺少主机名".to_string()))?;
        let virtual_host = format!("{}.{}", config.bucket.trim(), host);
        url.set_host(Some(&virtual_host))
            .map_err(|_| AppError::InvalidInput("S3 bucket 不能用于虚拟主机名".to_string()))?;
        let path = format!("{}/{}", base_path.trim_end_matches('/'), encoded_key);
        url.set_path(&path);
    }
    let canonical_uri = if url.path().is_empty() {
        "/".to_string()
    } else {
        url.path().to_string()
    };
    let host = host_header(&url)?;
    Ok((url, canonical_uri, host))
}

fn s3_bucket_url(config: &S3BackupConfig) -> AppResult<(Url, String, String)> {
    let mut url = Url::parse(config.endpoint.trim())
        .map_err(|error| AppError::InvalidInput(error.to_string()))?;
    let base_path = url.path().trim_end_matches('/').to_string();
    if config.path_style {
        let path = format!(
            "{}/{}",
            base_path.trim_end_matches('/'),
            encode_segment(config.bucket.trim())
        );
        url.set_path(&path);
    } else {
        let host = url
            .host_str()
            .ok_or_else(|| AppError::InvalidInput("S3 endpoint 缺少主机名".to_string()))?;
        let virtual_host = format!("{}.{}", config.bucket.trim(), host);
        url.set_host(Some(&virtual_host))
            .map_err(|_| AppError::InvalidInput("S3 bucket 不能用于虚拟主机名".to_string()))?;
        url.set_path(if base_path.is_empty() {
            "/"
        } else {
            &base_path
        });
    }
    let canonical_uri = if url.path().is_empty() {
        "/".to_string()
    } else {
        url.path().to_string()
    };
    let host = host_header(&url)?;
    Ok((url, canonical_uri, host))
}

fn host_header(url: &Url) -> AppResult<String> {
    let host = url
        .host_str()
        .ok_or_else(|| AppError::InvalidInput("S3 endpoint 缺少主机名".to_string()))?;
    Ok(match url.port() {
        Some(port) => format!("{}:{}", host, port),
        None => host.to_string(),
    })
}

fn s3_signing_key(secret: &str, short_date: &str, region: &str) -> AppResult<Vec<u8>> {
    let date = hmac_sha256(format!("AWS4{}", secret).as_bytes(), short_date.as_bytes())?;
    let region = hmac_sha256(&date, region.as_bytes())?;
    let service = hmac_sha256(&region, b"s3")?;
    hmac_sha256(&service, b"aws4_request")
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> AppResult<Vec<u8>> {
    let mut mac =
        HmacSha256::new_from_slice(key).map_err(|error| AppError::Crypto(error.to_string()))?;
    mac.update(message);
    Ok(mac.finalize().into_bytes().to_vec())
}

fn encode_path(path: &str) -> String {
    path.split('/')
        .map(encode_segment)
        .collect::<Vec<_>>()
        .join("/")
}

fn encode_segment(segment: &str) -> String {
    let mut encoded = String::new();
    for byte in segment.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(*byte as char);
            }
            _ => encoded.push_str(&format!("%{:02X}", byte)),
        }
    }
    encoded
}

fn remote_error(error: reqwest::Error) -> AppError {
    AppError::Remote(error.to_string())
}

fn is_backup_file(file_name: &str) -> bool {
    let lower = file_name.to_ascii_lowercase();
    lower.starts_with("helm-backup-") && (lower.ends_with(".zip") || lower.ends_with(".rpvault"))
}

fn s3_key_from_target(config: &S3BackupConfig, target_path: &str) -> AppResult<String> {
    let expected = format!("s3://{}/", config.bucket.trim());
    target_path
        .strip_prefix(&expected)
        .map(|value| value.to_string())
        .ok_or_else(|| AppError::InvalidInput("S3 备份路径与当前 Bucket 不匹配".to_string()))
}

fn system_time_to_rfc3339(value: SystemTime) -> String {
    DateTime::<Utc>::from(value).to_rfc3339()
}

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339()
}

fn file_name_from_path(path: &str) -> String {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(path)
        .replace("%20", " ")
}

fn xml_blocks<'a>(input: &'a str, local_name: &str) -> Vec<&'a str> {
    let mut blocks = Vec::new();
    let mut offset = 0;
    while let Some((start, raw_name, open_end)) = find_open_tag(input, local_name, offset) {
        let close_tag = format!("</{}>", raw_name);
        let search_start = open_end + 1;
        if let Some(close_rel) = input[search_start..].find(&close_tag) {
            let close = search_start + close_rel + close_tag.len();
            blocks.push(&input[start..close]);
            offset = close;
        } else {
            break;
        }
    }
    blocks
}

fn xml_text(input: &str, local_name: &str) -> Option<String> {
    let (_, _, open_end) = find_open_tag(input, local_name, 0)?;
    let body_start = open_end + 1;
    let close = input[body_start..].find("</")? + body_start;
    Some(xml_unescape(input[body_start..close].trim()))
}

fn find_open_tag(input: &str, local_name: &str, from: usize) -> Option<(usize, String, usize)> {
    let mut offset = from;
    while let Some(rel_start) = input[offset..].find('<') {
        let start = offset + rel_start;
        if input[start + 1..].starts_with('/') || input[start + 1..].starts_with('?') {
            offset = start + 1;
            continue;
        }
        let open_end = input[start..].find('>')? + start;
        let raw = input[start + 1..open_end]
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .trim_end_matches('/');
        let name = raw.rsplit(':').next().unwrap_or(raw);
        if name.eq_ignore_ascii_case(local_name) {
            return Some((start, raw.to_string(), open_end));
        }
        offset = open_end + 1;
    }
    None
}

fn xml_unescape(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn joins_backup_urls_and_keys() {
        assert_eq!(
            join_remote_url("https://dav.example/root/", "/helm", "a.rpvault").unwrap(),
            "https://dav.example/root/helm/a.rpvault"
        );
        assert_eq!(
            join_object_key("/helm/backups/", "a.rpvault"),
            "helm/backups/a.rpvault"
        );
    }

    #[test]
    fn builds_path_style_s3_url() {
        let config = S3BackupConfig {
            endpoint: "https://s3.example.com".to_string(),
            region: "us-east-1".to_string(),
            bucket: "helm".to_string(),
            access_key_id: "ak".to_string(),
            secret_access_key: "sk".to_string(),
            prefix: "backup".to_string(),
            path_style: true,
        };
        let (url, canonical, host) = s3_url(&config, "backup/a b.rpvault").unwrap();
        assert_eq!(
            url.as_str(),
            "https://s3.example.com/helm/backup/a%20b.rpvault"
        );
        assert_eq!(canonical, "/helm/backup/a%20b.rpvault");
        assert_eq!(host, "s3.example.com");
    }

    #[test]
    fn recognizes_zip_and_legacy_backup_files() {
        assert!(is_backup_file("HelM-backup-20260508-153012-BJT.zip"));
        assert!(is_backup_file("helm-backup-20260508-153012.rpvault"));
        assert!(!is_backup_file("notes.zip"));
    }

    #[test]
    fn packages_backup_payload_as_zip() {
        let payload = br#"{"magic":"RPVAULT"}"#.to_vec();
        let package = build_backup_package_sync(&payload).unwrap();
        assert!(package.len() > payload.len());
        assert_eq!(extract_backup_payload(&package).unwrap(), payload);
    }

    #[test]
    fn auto_backup_due_target_kinds_are_per_target() {
        let old = (Utc::now() - ChronoDuration::days(2)).to_rfc3339();
        let recent = Utc::now().to_rfc3339();
        let settings = BackupSettings {
            local_directory: Some("C:/backups".to_string()),
            auto_enabled: true,
            cloud: CloudBackupSettings {
                auto_enabled: true,
                kind: "webdav".to_string(),
                webdav: WebdavBackupConfig {
                    endpoint: "https://dav.example".to_string(),
                    ..WebdavBackupConfig::default()
                },
                ..CloudBackupSettings::default()
            },
            ..BackupSettings::default()
        };
        let due = auto_backup_due_target_kinds(
            &settings,
            &[
                BackupRecord {
                    created_at: recent,
                    ..BackupRecord::success(
                        "webdav.zip".to_string(),
                        "webdav",
                        "https://dav.example/webdav.zip".to_string(),
                        1,
                    )
                },
                BackupRecord {
                    created_at: old,
                    ..BackupRecord::success(
                        "local-old.zip".to_string(),
                        "local",
                        "C:/backups/local-old.zip".to_string(),
                        1,
                    )
                },
            ],
        );
        assert_eq!(due, vec!["local".to_string()]);
    }

    #[tokio::test]
    async fn rejects_backup_without_any_target() {
        let dir = tempdir().unwrap();
        let vault_path = dir.path().join("vault.rpvault");
        tokio::fs::write(&vault_path, b"vault").await.unwrap();
        let settings = BackupSettings {
            local_directory: None,
            cloud: CloudBackupSettings::default(),
            ..BackupSettings::default()
        };
        let plan = BackupRunPlan {
            settings,
            vault_path,
            file_name: "HelM-backup-test-BJT.zip".to_string(),
        };

        assert!(matches!(
            run_configured_backup(&plan).await,
            Err(AppError::InvalidInput(_))
        ));
    }

    #[tokio::test]
    async fn writes_local_backup_record() {
        let dir = tempdir().unwrap();
        let vault_path = dir.path().join("vault.rpvault");
        let backup_dir = dir.path().join("backups");
        tokio::fs::write(&vault_path, b"vault").await.unwrap();
        let settings = BackupSettings {
            local_directory: Some(backup_dir.to_string_lossy().to_string()),
            ..BackupSettings::default()
        };
        let plan = BackupRunPlan {
            settings,
            vault_path,
            file_name: "HelM-backup-test-BJT.zip".to_string(),
        };

        let records = run_configured_backup(&plan).await.unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].target_kind, "local");
        assert_eq!(records[0].status, "success");
        assert!(backup_dir.join("HelM-backup-test-BJT.zip").exists());
    }

    #[tokio::test]
    async fn auto_backup_respects_local_switch() {
        let dir = tempdir().unwrap();
        let vault_path = dir.path().join("vault.rpvault");
        let backup_dir = dir.path().join("backups");
        tokio::fs::write(&vault_path, b"vault").await.unwrap();
        let settings = BackupSettings {
            local_directory: Some(backup_dir.to_string_lossy().to_string()),
            auto_enabled: false,
            ..BackupSettings::default()
        };
        let mut plan = BackupRunPlan {
            settings,
            vault_path,
            file_name: "HelM-backup-test-BJT.zip".to_string(),
        };
        let targets = vec!["local".to_string()];

        assert!(matches!(
            run_auto_backup(&plan, &targets).await,
            Err(AppError::InvalidInput(_))
        ));

        plan.settings.auto_enabled = true;
        let records = run_auto_backup(&plan, &targets).await.unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].target_kind, "local");
    }

    #[tokio::test]
    async fn merge_configured_backup_records_skips_listed_successes() {
        let dir = tempdir().unwrap();
        let backup_dir = dir.path().join("backups");
        tokio::fs::create_dir_all(&backup_dir).await.unwrap();
        let existing_path = backup_dir.join("HelM-backup-old-BJT.zip");
        tokio::fs::write(
            &existing_path,
            build_backup_package(b"vault".to_vec()).await.unwrap(),
        )
        .await
        .unwrap();
        let settings = BackupSettings {
            local_directory: Some(backup_dir.to_string_lossy().to_string()),
            ..BackupSettings::default()
        };
        let duplicate = BackupRecord::success(
            "HelM-backup-old-BJT.zip".to_string(),
            "local",
            existing_path.to_string_lossy().to_string(),
            1,
        );
        let failed = BackupRecord::failed(
            "HelM-backup-new-BJT.zip".to_string(),
            "local",
            backup_dir
                .join("HelM-backup-new-BJT.zip")
                .to_string_lossy()
                .to_string(),
            "disk full".to_string(),
        );

        let merged = merge_configured_backup_records(&settings, vec![duplicate, failed]).await;
        assert_eq!(
            merged
                .iter()
                .filter(|record| record.file_name == "HelM-backup-old-BJT.zip")
                .count(),
            1
        );
        assert!(merged.iter().any(|record| record.status == "failed"));
    }
}
