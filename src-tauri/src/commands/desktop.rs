use std::{
    env,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use base64::{engine::general_purpose, Engine as _};
use rsa::{
    pkcs8::DecodePublicKey,
    pss::{Signature as PssSignature, VerifyingKey},
    signature::Verifier,
    RsaPublicKey,
};
use serde::Deserialize;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use super::{resolve_vault_path, AppError, AppResult};
use crate::http_client::{http_client, send_with_retry};

const UPDATE_FETCH_TIMEOUT: Duration = Duration::from_secs(30);
const UPDATE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);
const DEFAULT_UPDATE_REPO: &str = "lookfeeb/Hlem_SSH";
const HELM_UPDATE_REPO_ENV: &str = "HELM_UPDATE_REPO";
const VITE_UPDATE_REPO_ENV: &str = "VITE_HELM_UPDATE_REPO";
const HELM_UPDATE_PUBLIC_KEY_ENV: &str = "HELM_UPDATE_PUBLIC_KEY_PEM";
const VITE_UPDATE_PUBLIC_KEY_ENV: &str = "VITE_HELM_UPDATE_PUBLIC_KEY_PEM";
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalExpandedEntry {
    pub local_path: String,
    pub relative_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAsset {
    pub name: String,
    pub download_url: String,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub tag_name: String,
    pub html_url: String,
    pub body: String,
    pub published_at: String,
    pub asset: Option<UpdateAsset>,
    pub has_update: bool,
    pub signature_verified: bool,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: Option<String>,
    name: Option<String>,
    html_url: Option<String>,
    body: Option<String>,
    published_at: Option<String>,
    assets: Option<Vec<GitHubAsset>>,
}

#[derive(Debug, Deserialize)]
struct GitHubAsset {
    name: Option<String>,
    browser_download_url: Option<String>,
    size: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignedUpdateManifest {
    app_version: Option<String>,
    latest_version: Option<String>,
    tag_name: Option<String>,
    html_url: Option<String>,
    body: Option<String>,
    published_at: Option<String>,
    assets: Option<Vec<SignedUpdateAsset>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignedUpdateAsset {
    platform: Option<String>,
    arch: Option<String>,
    name: Option<String>,
    url: Option<String>,
    download_url: Option<String>,
    size: Option<u64>,
    sha256: Option<String>,
}

/// Expand local paths: if a path is a directory, recursively list all files inside it
/// with their relative paths preserved. If a path is a file, return it as-is.
#[tauri::command]
pub async fn local_expand_paths(paths: Vec<String>) -> AppResult<Vec<LocalExpandedEntry>> {
    let mut results = Vec::new();
    for root in paths {
        let root_path = PathBuf::from(&root);
        let metadata = tokio::fs::metadata(&root_path)
            .await
            .map_err(|error| AppError::Io(format!("无法读取路径 {root}: {error}")))?;
        if metadata.is_file() {
            let file_name = root_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            results.push(LocalExpandedEntry {
                local_path: root.clone(),
                relative_path: file_name,
            });
        } else if metadata.is_dir() {
            let root_name = root_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let mut stack = vec![(root_path.clone(), root_name.clone())];
            while let Some((dir, prefix)) = stack.pop() {
                let mut entries = tokio::fs::read_dir(&dir).await.map_err(|error| {
                    AppError::Io(format!("无法读取目录 {}: {error}", dir.display()))
                })?;
                while let Some(entry) = entries
                    .next_entry()
                    .await
                    .map_err(|error| AppError::Io(format!("读取目录条目失败: {error}")))?
                {
                    let entry_path = entry.path();
                    let entry_name = entry.file_name().to_string_lossy().to_string();
                    let relative = format!("{}/{}", prefix, entry_name);
                    let ft = entry
                        .file_type()
                        .await
                        .map_err(|error| AppError::Io(format!("读取文件类型失败: {error}")))?;
                    if ft.is_file() {
                        results.push(LocalExpandedEntry {
                            local_path: entry_path.to_string_lossy().to_string(),
                            relative_path: relative,
                        });
                    } else if ft.is_dir() {
                        stack.push((entry_path, relative));
                    }
                }
            }
        }
    }
    Ok(results)
}

#[tauri::command]
pub async fn local_create_directories(paths: Vec<String>) -> AppResult<()> {
    for path in paths {
        if path.trim().is_empty() {
            return Err(AppError::InvalidInput("本地目录路径不能为空".to_string()));
        }
        tokio::fs::create_dir_all(&path)
            .await
            .map_err(|error| AppError::Io(format!("创建本地目录 {path} 失败：{error}")))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn check_update(
    current_version: String,
    current_arch: String,
) -> AppResult<Option<UpdateInfo>> {
    let Some(repo) = configured_update_repo() else {
        return Ok(None);
    };
    let public_key = configured_update_public_key();
    if let Some(public_key) = public_key.as_deref() {
        check_signed_manifest(&repo, public_key, current_version, current_arch)
            .await
            .map(Some)
    } else {
        check_github_release(&repo, current_version, current_arch)
            .await
            .map(Some)
    }
}

async fn fetch_text_url_inner(url: &str) -> AppResult<String> {
    let trimmed = validate_http_url(url)?;
    let client = http_client(UPDATE_FETCH_TIMEOUT)?;
    let response = send_with_retry("读取远程内容", || {
        client
            .get(trimmed)
            .header(reqwest::header::USER_AGENT, "HelM-Updater")
    })
    .await?;
    if !response.status().is_success() {
        return Err(AppError::Remote(format!(
            "读取远程内容失败：HTTP {}",
            response.status()
        )));
    }
    response
        .text()
        .await
        .map_err(|error| AppError::Remote(format!("解析远程内容失败：{error}")))
}

async fn check_signed_manifest(
    repo: &str,
    public_key: &str,
    current_version: String,
    current_arch: String,
) -> AppResult<UpdateInfo> {
    let manifest_url = format!("https://github.com/{repo}/releases/latest/download/latest.json");
    let signature_url = format!("{manifest_url}.sig");
    let (manifest_text, signature) = tokio::try_join!(
        fetch_text_url_inner(&manifest_url),
        fetch_text_url_inner(&signature_url)
    )?;
    if !verify_manifest_signature(&manifest_text, signature.trim(), public_key)? {
        return Err(AppError::Crypto("更新清单签名验证失败".to_string()));
    }
    let manifest: SignedUpdateManifest = serde_json::from_str(&manifest_text)?;
    let tag_name = manifest.tag_name.unwrap_or_default();
    let latest_version = normalize_version(
        manifest
            .app_version
            .as_deref()
            .or(manifest.latest_version.as_deref())
            .unwrap_or(&tag_name),
    );
    if latest_version.is_empty() {
        return Err(AppError::InvalidInput("最新版本号无效".to_string()));
    }
    let asset = select_manifest_asset(manifest.assets.unwrap_or_default(), &current_arch)?;
    Ok(UpdateInfo {
        has_update: compare_versions(&latest_version, &current_version) > 0,
        current_version,
        latest_version: latest_version.clone(),
        tag_name: if tag_name.is_empty() {
            format!("v{latest_version}")
        } else {
            tag_name
        },
        html_url: manifest
            .html_url
            .unwrap_or_else(|| format!("https://github.com/{repo}/releases/latest")),
        body: manifest.body.unwrap_or_default(),
        published_at: manifest.published_at.unwrap_or_default(),
        asset,
        signature_verified: true,
    })
}

async fn check_github_release(
    repo: &str,
    current_version: String,
    current_arch: String,
) -> AppResult<UpdateInfo> {
    let url = format!("https://api.github.com/repos/{repo}/releases/latest");
    let release: GitHubRelease = serde_json::from_str(&fetch_text_url_inner(&url).await?)?;
    let tag_name = release.tag_name.or(release.name).unwrap_or_default();
    let latest_version = normalize_version(&tag_name);
    if latest_version.is_empty() {
        return Err(AppError::InvalidInput("最新版本号无效".to_string()));
    }
    Ok(UpdateInfo {
        has_update: compare_versions(&latest_version, &current_version) > 0,
        current_version,
        latest_version,
        tag_name,
        html_url: release
            .html_url
            .unwrap_or_else(|| format!("https://github.com/{repo}/releases/latest")),
        body: release.body.unwrap_or_default(),
        published_at: release.published_at.unwrap_or_default(),
        asset: select_windows_asset(release.assets.unwrap_or_default(), &current_arch),
        signature_verified: false,
    })
}

#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    url: String,
    file_name: Option<String>,
    sha256: Option<String>,
) -> AppResult<String> {
    let trimmed = validate_http_url(&url)?;
    let client = http_client(UPDATE_DOWNLOAD_TIMEOUT)?;
    let response = send_with_retry("下载更新", || {
        client
            .get(trimmed)
            .header(reqwest::header::USER_AGENT, "HelM-Updater")
    })
    .await?;
    if !response.status().is_success() {
        return Err(AppError::Remote(format!(
            "下载更新失败：HTTP {}",
            response.status()
        )));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| AppError::Remote(format!("读取更新包失败：{error}")))?;
    if let Some(expected) = sha256
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let actual = hex::encode(Sha256::digest(&bytes));
        if !actual.eq_ignore_ascii_case(expected) {
            return Err(AppError::Crypto("更新包 SHA256 校验失败".to_string()));
        }
    }
    let downloads = app
        .path()
        .download_dir()
        .or_else(|_| app.path().app_cache_dir())
        .map_err(|error| AppError::Io(error.to_string()))?;
    tokio::fs::create_dir_all(&downloads)
        .await
        .map_err(|error| AppError::Io(error.to_string()))?;
    let name = file_name
        .as_deref()
        .map(sanitize_download_name)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "HelM-update.exe".to_string());
    let target = downloads.join(name);
    crate::atomic_file::write_atomic_async(&target, &bytes).await?;
    Ok(target.display().to_string())
}

#[tauri::command]
pub fn install_update(app: AppHandle, installer_path: String) -> AppResult<()> {
    let trimmed = installer_path.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput("安装包路径为空".to_string()));
    }
    let path = PathBuf::from(trimmed);
    if !path.exists() {
        return Err(AppError::InvalidInput(format!(
            "安装包不存在：{}",
            path.display()
        )));
    }
    launch_update_installer(&app, &path)
}

#[tauri::command]
pub fn open_database_dir(app: AppHandle) -> AppResult<()> {
    let vault_path = resolve_vault_path(&app)?;
    let directory = vault_path
        .parent()
        .map(|path| path.to_path_buf())
        .unwrap_or(vault_path);
    open_directory(&directory)
}

#[tauri::command]
pub fn open_path_dir(path: String) -> AppResult<()> {
    let target = PathBuf::from(path.trim());
    let directory = if target.is_dir() {
        target
    } else {
        target
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| AppError::InvalidInput("路径没有上级目录".to_string()))?
    };
    open_directory(&directory)
}

#[tauri::command]
pub fn local_path_exists(path: String) -> bool {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return false;
    }
    PathBuf::from(trimmed).exists()
}

#[tauri::command]
pub fn open_external_url(url: String) -> AppResult<()> {
    let trimmed = validate_http_url(&url)?;
    open_url(trimmed)
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

fn configured_update_repo() -> Option<String> {
    env_value(HELM_UPDATE_REPO_ENV)
        .or_else(|| env_value(VITE_UPDATE_REPO_ENV))
        .or_else(|| build_env_value(option_env!("HELM_UPDATE_REPO")))
        .or_else(|| build_env_value(option_env!("VITE_HELM_UPDATE_REPO")))
        .or_else(|| Some(DEFAULT_UPDATE_REPO.to_string()))
}

fn configured_update_public_key() -> Option<String> {
    env_value(HELM_UPDATE_PUBLIC_KEY_ENV)
        .or_else(|| env_value(VITE_UPDATE_PUBLIC_KEY_ENV))
        .or_else(|| build_env_value(option_env!("HELM_UPDATE_PUBLIC_KEY_PEM")))
        .or_else(|| build_env_value(option_env!("VITE_HELM_UPDATE_PUBLIC_KEY_PEM")))
}

fn env_value(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn build_env_value(value: Option<&'static str>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn select_manifest_asset(
    assets: Vec<SignedUpdateAsset>,
    current_arch: &str,
) -> AppResult<Option<UpdateAsset>> {
    let arch = normalize_arch(current_arch);
    let candidates: Vec<_> = assets
        .into_iter()
        .filter(|asset| {
            asset
                .platform
                .as_deref()
                .unwrap_or("windows")
                .eq_ignore_ascii_case("windows")
        })
        .filter(|asset| {
            asset
                .name
                .as_deref()
                .is_some_and(|name| name.ends_with(".exe"))
        })
        .filter(|asset| asset.url.is_some() || asset.download_url.is_some())
        .collect();
    let selected = candidates
        .iter()
        .find(|asset| normalize_arch(asset.arch.as_deref().unwrap_or_default()) == arch)
        .or_else(|| candidates.first());
    let Some(asset) = selected else {
        return Ok(None);
    };
    let Some(name) = asset.name.clone() else {
        return Ok(None);
    };
    let Some(download_url) = asset.url.clone().or_else(|| asset.download_url.clone()) else {
        return Ok(None);
    };
    let Some(sha256) = asset
        .sha256
        .clone()
        .filter(|value| !value.trim().is_empty())
    else {
        return Err(AppError::InvalidInput(
            "更新清单缺少安装包 SHA256".to_string(),
        ));
    };
    Ok(Some(UpdateAsset {
        name,
        download_url,
        size: asset.size.unwrap_or(0),
        sha256: Some(sha256),
    }))
}

fn select_windows_asset(assets: Vec<GitHubAsset>, current_arch: &str) -> Option<UpdateAsset> {
    let arch = normalize_arch(current_arch);
    let mut candidates: Vec<_> = assets
        .into_iter()
        .filter(|asset| {
            asset
                .name
                .as_deref()
                .is_some_and(|name| name.ends_with(".exe"))
        })
        .filter(|asset| asset.browser_download_url.is_some())
        .collect();
    candidates.sort_by_key(|asset| {
        let name = asset.name.as_deref().unwrap_or_default();
        (asset_arch_rank(name, &arch), asset_rank(name))
    });
    let asset = candidates.into_iter().next()?;
    Some(UpdateAsset {
        name: asset.name?,
        download_url: asset.browser_download_url?,
        size: asset.size.unwrap_or(0),
        sha256: None,
    })
}

fn asset_arch_rank(name: &str, current_arch: &str) -> u8 {
    match asset_name_arch(name).as_deref() {
        Some(arch) if arch == current_arch => 0,
        None => 1,
        Some(_) => 9,
    }
}

fn asset_rank(name: &str) -> u8 {
    let lower = name.to_lowercase();
    if lower.contains("setup") {
        0
    } else if lower.ends_with(".exe") {
        1
    } else {
        9
    }
}

fn asset_name_arch(name: &str) -> Option<String> {
    let lower = name.to_lowercase();
    if contains_arch_alias(&lower, &["arm64", "aarch64"]) {
        return Some("arm64".to_string());
    }
    if contains_arch_alias(&lower, &["x86_64", "amd64", "x64"]) {
        return Some("x64".to_string());
    }
    if contains_arch_alias(&lower, &["i686", "ia32", "win32", "x86"]) {
        return Some("x86".to_string());
    }
    None
}

fn contains_arch_alias(name: &str, aliases: &[&str]) -> bool {
    aliases.iter().any(|alias| {
        let alias = alias.to_lowercase();
        let variants = if alias.contains('_') {
            vec![alias.clone(), alias.replace('_', "-")]
        } else {
            vec![alias.clone()]
        };
        variants
            .iter()
            .any(|variant| contains_token_like(name, variant))
    })
}

fn contains_token_like(value: &str, token: &str) -> bool {
    let mut start = 0;
    while let Some(index) = value[start..].find(token) {
        let absolute = start + index;
        let before = value[..absolute]
            .chars()
            .next_back()
            .is_none_or(|ch| !ch.is_ascii_alphanumeric());
        let after_index = absolute + token.len();
        let after = value[after_index..]
            .chars()
            .next()
            .is_none_or(|ch| !ch.is_ascii_alphanumeric());
        if before && after {
            return true;
        }
        start = after_index;
    }
    false
}

fn normalize_arch(value: &str) -> String {
    match value.to_lowercase().as_str() {
        "x64" | "x86_64" | "amd64" => "x64".to_string(),
        "x86" | "i686" | "ia32" => "x86".to_string(),
        "arm64" | "aarch64" => "arm64".to_string(),
        other => other.to_string(),
    }
}

fn normalize_version(value: &str) -> String {
    let trimmed = value.trim().trim_start_matches(['v', 'V']);
    let mut started = false;
    let mut version = String::new();
    for ch in trimmed.chars() {
        if !started && !ch.is_ascii_digit() {
            continue;
        }
        started = true;
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '+') {
            version.push(ch);
        } else {
            break;
        }
    }
    if version
        .split(['+', '-'])
        .next()
        .unwrap_or_default()
        .matches('.')
        .count()
        >= 2
    {
        version
    } else {
        String::new()
    }
}

fn compare_versions(left: &str, right: &str) -> i32 {
    let left_parts = version_numbers(left);
    let right_parts = version_numbers(right);
    for index in 0..left_parts.len().max(right_parts.len()) {
        let diff = left_parts.get(index).copied().unwrap_or(0)
            - right_parts.get(index).copied().unwrap_or(0);
        if diff != 0 {
            return diff;
        }
    }
    0
}

fn version_numbers(value: &str) -> Vec<i32> {
    value
        .split(['+', '-'])
        .next()
        .unwrap_or_default()
        .split('.')
        .map(|part| part.parse::<i32>().unwrap_or(0))
        .collect()
}

fn verify_manifest_signature(
    manifest_text: &str,
    signature_base64: &str,
    public_key_pem: &str,
) -> AppResult<bool> {
    let public_key = RsaPublicKey::from_public_key_pem(&public_key_pem.replace("\\n", "\n"))
        .map_err(|error| AppError::Crypto(format!("更新公钥无效：{error}")))?;
    let signature_bytes = general_purpose::STANDARD
        .decode(signature_base64)
        .map_err(|error| AppError::Crypto(format!("更新签名无效：{error}")))?;
    let signature = PssSignature::try_from(signature_bytes.as_slice())
        .map_err(|error| AppError::Crypto(format!("更新签名无效：{error}")))?;
    let verifying_key = VerifyingKey::<Sha256>::new(public_key);
    Ok(verifying_key
        .verify(manifest_text.as_bytes(), &signature)
        .is_ok())
}

fn launch_update_installer(_app: &AppHandle, installer: &Path) -> AppResult<()> {
    #[cfg(target_os = "windows")]
    {
        let current_pid = std::process::id();
        let process_name = env::current_exe()
            .ok()
            .and_then(|path| {
                path.file_stem()
                    .map(|value| value.to_string_lossy().to_string())
            })
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "HelM".to_string())
            .replace('\'', "''");
        let installer_path = installer.display().to_string().replace('\'', "''");
        let script = format!(
            r#"
$installer = '{installer_path}'
$currentPid = {current_pid}
$processName = '{process_name}'
Start-Sleep -Milliseconds 800
Get-Process -Name $processName -ErrorAction SilentlyContinue |
  Where-Object {{ $_.Id -ne $PID }} |
  Stop-Process -Force -ErrorAction SilentlyContinue
Start-Process -FilePath $installer -ArgumentList '{installer_args}' -Wait
"#,
            installer_args = windows_update_installer_args().replace('\'', "''")
        );
        let encoded = general_purpose::STANDARD.encode(
            script
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );
        let mut command = Command::new("powershell");
        command.args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-EncodedCommand",
            &encoded,
        ]);
        #[cfg(target_os = "windows")]
        command.creation_flags(CREATE_NO_WINDOW);
        command
            .spawn()
            .map_err(|error| AppError::Io(error.to_string()))?;
        _app.exit(0);
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new(installer)
            .spawn()
            .map_err(|error| AppError::Io(error.to_string()))?;
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn windows_update_installer_args() -> &'static str {
    "/S /R"
}

fn validate_http_url(value: &str) -> AppResult<&str> {
    let trimmed = value.trim();
    if !trimmed.starts_with("https://") && !trimmed.starts_with("http://") {
        return Err(AppError::InvalidInput("链接地址无效".to_string()));
    }
    Ok(trimmed)
}

fn open_directory(path: &PathBuf) -> AppResult<()> {
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|error| AppError::Io(error.to_string()))?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|error| AppError::Io(error.to_string()))?;
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|error| AppError::Io(error.to_string()))?;
        Ok(())
    }
}

fn open_url(url: &str) -> AppResult<()> {
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("explorer");
        command.arg(url);
        command
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|error| AppError::Io(error.to_string()))?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|error| AppError::Io(error.to_string()))?;
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|error| AppError::Io(error.to_string()))?;
        Ok(())
    }
}

pub fn friendly_os_name() -> String {
    #[cfg(target_os = "windows")]
    {
        windows_version_name()
    }
    #[cfg(target_os = "macos")]
    {
        return command_output("sw_vers", &["-productVersion"])
            .map(|version| format!("macOS {version}"))
            .unwrap_or_else(|| "macOS".to_string());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        return linux_pretty_name().unwrap_or_else(|| "Linux".to_string());
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", unix)))]
    {
        env::consts::OS.to_string()
    }
}

#[cfg(target_os = "windows")]
fn windows_version_name() -> String {
    let version = command_output("cmd", &["/C", "ver"]).unwrap_or_default();
    let build = version
        .split(|ch: char| !ch.is_ascii_digit() && ch != '.')
        .find(|part| part.matches('.').count() >= 2)
        .and_then(|part| part.split('.').nth(2))
        .and_then(|part| part.parse::<u32>().ok());
    match build {
        Some(value) if value >= 22_000 => "Windows 11".to_string(),
        Some(_) => "Windows 10".to_string(),
        None => "Windows".to_string(),
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn linux_pretty_name() -> Option<String> {
    let content = std::fs::read_to_string("/etc/os-release").ok()?;
    content.lines().find_map(|line| {
        line.strip_prefix("PRETTY_NAME=")
            .map(|value| value.trim_matches('"').replace("\\\"", "\""))
    })
}

fn command_output(command: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(command).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn sanitize_download_name(value: &str) -> String {
    value
        .chars()
        .filter(|char| !matches!(char, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
        .collect::<String>()
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::OsRng;
    use rsa::{
        pkcs8::{EncodePublicKey, LineEnding},
        RsaPrivateKey,
    };
    use tempfile::tempdir;

    #[tokio::test]
    async fn creates_local_directories_recursively() {
        let root = tempdir().expect("temp directory");
        let nested = root.path().join("download").join("empty").join("nested");
        local_create_directories(vec![nested.to_string_lossy().to_string()])
            .await
            .expect("create directories");
        assert!(nested.is_dir());
    }

    #[tokio::test]
    async fn reports_local_directory_creation_path() {
        let root = tempdir().expect("temp directory");
        let blocking_file = root.path().join("blocking-file");
        std::fs::write(&blocking_file, b"file").expect("write blocking file");
        let nested = blocking_file.join("child");
        let error = local_create_directories(vec![nested.to_string_lossy().to_string()])
            .await
            .unwrap_err();
        assert!(error
            .to_string()
            .contains(&nested.to_string_lossy().to_string()));
    }

    #[test]
    fn compares_semver_like_versions() {
        assert!(compare_versions("1.2.4", "1.2.3") > 0);
        assert_eq!(compare_versions("1.2.3", "1.2.3"), 0);
        assert!(compare_versions("1.2.3", "1.3.0") < 0);
        assert_eq!(normalize_version("v1.2.3-beta.1"), "1.2.3-beta.1");
    }

    #[test]
    fn selects_setup_exe_from_github_assets() {
        let asset = select_windows_asset(
            vec![
                GitHubAsset {
                    name: Some("HelM-portable.exe".to_string()),
                    browser_download_url: Some("https://example.com/portable.exe".to_string()),
                    size: Some(1),
                },
                GitHubAsset {
                    name: Some("HelM-setup.exe".to_string()),
                    browser_download_url: Some("https://example.com/setup.exe".to_string()),
                    size: Some(2),
                },
            ],
            "x64",
        )
        .expect("asset");
        assert_eq!(asset.name, "HelM-setup.exe");
    }

    #[test]
    fn selects_matching_arch_from_github_assets() {
        let asset = select_windows_asset(
            vec![
                GitHubAsset {
                    name: Some("HelM-0.0.40-arm64-setup.exe".to_string()),
                    browser_download_url: Some("https://example.com/arm64.exe".to_string()),
                    size: Some(1),
                },
                GitHubAsset {
                    name: Some("HelM-0.0.40-x64-setup.exe".to_string()),
                    browser_download_url: Some("https://example.com/x64.exe".to_string()),
                    size: Some(2),
                },
            ],
            "x86_64",
        )
        .expect("asset");
        assert_eq!(asset.name, "HelM-0.0.40-x64-setup.exe");
    }

    #[test]
    fn falls_back_to_arch_agnostic_github_asset() {
        let asset = select_windows_asset(
            vec![
                GitHubAsset {
                    name: Some("HelM-0.0.40-arm64-setup.exe".to_string()),
                    browser_download_url: Some("https://example.com/arm64.exe".to_string()),
                    size: Some(1),
                },
                GitHubAsset {
                    name: Some("HelM-setup.exe".to_string()),
                    browser_download_url: Some("https://example.com/setup.exe".to_string()),
                    size: Some(2),
                },
            ],
            "x86_64",
        )
        .expect("asset");
        assert_eq!(asset.name, "HelM-setup.exe");
    }

    #[test]
    fn signed_manifest_asset_requires_sha256() {
        let error = select_manifest_asset(
            vec![SignedUpdateAsset {
                platform: Some("windows".to_string()),
                arch: Some("x64".to_string()),
                name: Some("HelM-setup.exe".to_string()),
                url: Some("https://example.com/setup.exe".to_string()),
                download_url: None,
                size: Some(2),
                sha256: None,
            }],
            "x64",
        )
        .unwrap_err();
        assert!(error.to_string().contains("SHA256"));
    }

    #[test]
    fn invalid_pss_signature_fails_verification() {
        let mut rng = OsRng;
        let private_key = RsaPrivateKey::new(&mut rng, 2048).expect("private key");
        let public_key = RsaPublicKey::from(&private_key)
            .to_public_key_pem(LineEnding::LF)
            .expect("public key pem");
        let invalid_signature = general_purpose::STANDARD.encode(vec![0_u8; 256]);
        let verified = verify_manifest_signature("manifest", &invalid_signature, &public_key)
            .expect("verification result");
        assert!(!verified);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_update_installer_args_restart_after_silent_install() {
        let args = windows_update_installer_args();
        assert!(args
            .split_whitespace()
            .any(|arg| arg.eq_ignore_ascii_case("/S")));
        assert!(args
            .split_whitespace()
            .any(|arg| arg.eq_ignore_ascii_case("/R")));
    }
}
