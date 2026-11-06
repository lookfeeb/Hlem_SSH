//! Update transport only. Signature and installer hash checks remain with the caller.
use std::time::Duration;

use reqwest::{header, Client, Url};
use serde::Deserialize;

use crate::{
    errors::{AppError, AppResult},
    http_client::http_client,
};

// The complete metadata fallback stays below the frontend's 45-second IPC timeout.
const DIRECT_METADATA_TIMEOUT: Duration = Duration::from_secs(8);
const RELEASE_TIMEOUT: Duration = Duration::from_secs(10);
const ASSET_METADATA_TIMEOUT: Duration = Duration::from_secs(15);
const INSTALLER_TIMEOUT: Duration = Duration::from_secs(300);
const MANIFEST_LIMIT: usize = 1024 * 1024;
const SIGNATURE_LIMIT: usize = 8192;

#[derive(Deserialize)]
struct Release {
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    id: u64,
    name: String,
}

struct GitHubDownload {
    repo: String,
    release: String,
    encoded_name: String,
}

pub(crate) struct UpdateDownloader {
    client: Client,
    web_origin: Url,
    api_origin: Url,
}

impl UpdateDownloader {
    pub(crate) fn new() -> AppResult<Self> {
        Ok(Self {
            client: http_client(INSTALLER_TIMEOUT)?,
            web_origin: Url::parse("https://github.com").expect("GitHub URL"),
            api_origin: Url::parse("https://api.github.com").expect("GitHub API URL"),
        })
    }

    pub(crate) async fn signed_manifest(&self, repo: &str) -> AppResult<(String, Vec<u8>)> {
        if !valid_repo(repo) {
            return Err(AppError::InvalidInput("GitHub 更新仓库格式无效".into()));
        }
        let manifest_url = self.web_url(&format!("/{repo}/releases/latest/download/latest.json"));
        let signature_url = self.web_url(&format!(
            "/{repo}/releases/latest/download/latest.json.sig.bin"
        ));
        let direct = tokio::try_join!(
            self.bytes(manifest_url, false, DIRECT_METADATA_TIMEOUT, MANIFEST_LIMIT),
            self.bytes(
                signature_url,
                false,
                DIRECT_METADATA_TIMEOUT,
                SIGNATURE_LIMIT
            ),
        );
        let (manifest, signature) = match direct {
            Ok(pair) => pair,
            Err(direct_error) => {
                log::warn!(
                    "Update metadata direct download failed; trying GitHub API: {direct_error}"
                );
                self.signed_manifest_from_api(repo)
                    .await
                    .map_err(|api_error| fallback_error(direct_error, api_error))?
            }
        };
        let manifest = String::from_utf8(manifest)
            .map_err(|error| AppError::Remote(format!("更新清单不是有效 UTF-8：{error}")))?;
        Ok((manifest, signature))
    }

    async fn signed_manifest_from_api(&self, repo: &str) -> AppResult<(Vec<u8>, Vec<u8>)> {
        // Resolve latest once so a concurrent release cannot mix two versions.
        let release = self.release(repo, "latest").await?;
        let manifest = self.asset_url(repo, &release, "latest.json")?;
        let signature = self.asset_url(repo, &release, "latest.json.sig.bin")?;
        tokio::try_join!(
            self.bytes(manifest, true, ASSET_METADATA_TIMEOUT, MANIFEST_LIMIT),
            self.bytes(signature, true, ASSET_METADATA_TIMEOUT, SIGNATURE_LIMIT),
        )
    }

    pub(crate) async fn installer(&self, url: &str) -> AppResult<Vec<u8>> {
        let url = Url::parse(url)
            .map_err(|error| AppError::InvalidInput(format!("更新包地址无效：{error}")))?;
        let direct_error = match self
            .bytes(url.clone(), false, INSTALLER_TIMEOUT, usize::MAX)
            .await
        {
            Ok(bytes) => return Ok(bytes),
            Err(error) => error,
        };
        let Some(download) = self.github_download(&url) else {
            return Err(direct_error);
        };
        log::warn!("Update installer direct download failed; trying GitHub API: {direct_error}");
        self.installer_from_api(download)
            .await
            .map_err(|api_error| fallback_error(direct_error, api_error))
    }

    async fn installer_from_api(&self, download: GitHubDownload) -> AppResult<Vec<u8>> {
        // A versioned installer must resolve its original tag, never a newer latest release.
        let release = self.release(&download.repo, &download.release).await?;
        let url = self.asset_url(&download.repo, &release, &download.encoded_name)?;
        self.bytes(url, true, INSTALLER_TIMEOUT, usize::MAX).await
    }

    async fn release(&self, repo: &str, release: &str) -> AppResult<Release> {
        let url = self.api_url(&format!("/repos/{repo}/releases/{release}"));
        let bytes = self
            .bytes(url, false, RELEASE_TIMEOUT, 2 * MANIFEST_LIMIT)
            .await?;
        serde_json::from_slice(&bytes)
            .map_err(|error| AppError::Remote(format!("解析 GitHub Release 失败：{error}")))
    }

    fn asset_url(&self, repo: &str, release: &Release, encoded_name: &str) -> AppResult<Url> {
        let asset = release
            .assets
            .iter()
            .find(|asset| {
                let mut encoded = self.web_origin.clone();
                encoded
                    .path_segments_mut()
                    .expect("base URL")
                    .clear()
                    .push(&asset.name);
                encoded.path().strip_prefix('/') == Some(encoded_name)
            })
            .ok_or_else(|| AppError::Remote(format!("GitHub Release 缺少文件：{encoded_name}")))?;
        // Construct the official API URL ourselves; do not trust URLs from release metadata.
        Ok(self.api_url(&format!("/repos/{repo}/releases/assets/{}", asset.id)))
    }

    fn github_download(&self, url: &Url) -> Option<GitHubDownload> {
        if url.origin() != self.web_origin.origin()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return None;
        }
        let parts: Vec<_> = url.path_segments()?.collect();
        let (owner, repo, release, name) = match parts.as_slice() {
            [owner, repo, "releases", "download", tag, name] if !tag.is_empty() => {
                (*owner, *repo, format!("tags/{tag}"), *name)
            }
            [owner, repo, "releases", "latest", "download", name] => {
                (*owner, *repo, "latest".to_string(), *name)
            }
            _ => return None,
        };
        let repo = format!("{owner}/{repo}");
        if !valid_repo(&repo) || name.is_empty() {
            return None;
        }
        Some(GitHubDownload {
            repo,
            release,
            encoded_name: name.to_string(),
        })
    }

    async fn bytes(
        &self,
        url: Url,
        asset: bool,
        timeout: Duration,
        limit: usize,
    ) -> AppResult<Vec<u8>> {
        // One bounded attempt per route: retrying the blocked domain delays the working fallback.
        let mut response = self
            .client
            .get(url)
            .header(header::USER_AGENT, "HelM-Updater")
            .header(
                header::ACCEPT,
                if asset {
                    "application/octet-stream"
                } else {
                    "application/json"
                },
            )
            .timeout(timeout)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(network_error)?;
        if !response.status().is_success() {
            return Err(AppError::Remote(format!(
                "更新文件请求失败：HTTP {}",
                response.status()
            )));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(network_error)? {
            if chunk.len() > limit.saturating_sub(bytes.len()) {
                return Err(AppError::Remote(format!(
                    "更新文件超过允许大小（{limit} 字节）"
                )));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }

    fn web_url(&self, path: &str) -> Url {
        let mut url = self.web_origin.clone();
        url.set_path(path);
        url
    }

    fn api_url(&self, path: &str) -> Url {
        let mut url = self.api_origin.clone();
        url.set_path(path);
        url
    }
}

fn valid_repo(repo: &str) -> bool {
    let parts: Vec<_> = repo.split('/').collect();
    parts.len() == 2
        && parts.iter().all(|part| {
            !part.is_empty()
                && *part != "."
                && *part != ".."
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
        })
}

fn network_error(error: reqwest::Error) -> AppError {
    let kind = if error.is_timeout() {
        "请求超时"
    } else if error.is_connect() {
        "连接失败"
    } else {
        "请求失败"
    };
    // Display on reqwest::Error omits the underlying DNS/TLS/connection failure.
    let mut detail = format!("{kind}：{error}");
    let mut source = std::error::Error::source(&error);
    while let Some(cause) = source {
        detail.push_str(&format!("；{cause}"));
        source = cause.source();
    }
    AppError::Remote(detail)
}

fn fallback_error(direct: AppError, api: AppError) -> AppError {
    AppError::Remote(format!(
        "GitHub 直接下载失败：{direct}；官方 API 回退也失败：{api}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, extract::Request, http::StatusCode, response::Response, Router};
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };

    struct Server {
        downloader: UpdateDownloader,
        requests: Arc<Mutex<Vec<(String, String)>>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for Server {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn server(routes: Vec<(&str, Vec<u8>)>) -> Server {
        let routes: HashMap<String, Vec<u8>> = routes
            .into_iter()
            .map(|(path, bytes)| (path.into(), bytes))
            .collect();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let record = requests.clone();
        let app = Router::new().fallback(move |request: Request| {
            let path = request.uri().path().to_string();
            let accept = request
                .headers()
                .get(header::ACCEPT)
                .unwrap()
                .to_str()
                .unwrap()
                .to_string();
            record.lock().unwrap().push((path.clone(), accept));
            let body = routes.get(&path).cloned();
            async move {
                match body {
                    Some(body) => Response::new(Body::from(body)),
                    None => Response::builder()
                        .status(StatusCode::BAD_GATEWAY)
                        .body(Body::from("blocked route"))
                        .unwrap(),
                }
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Server {
            downloader: UpdateDownloader {
                client: Client::builder().no_proxy().build().unwrap(),
                web_origin: origin.clone(),
                api_origin: origin,
            },
            requests,
            task,
        }
    }

    #[tokio::test]
    async fn direct_manifest_success_does_not_call_api() {
        let signature = vec![0, 128, 255, 1];
        let server = server(vec![
            (
                "/owner/repo/releases/latest/download/latest.json",
                b"signed manifest".to_vec(),
            ),
            (
                "/owner/repo/releases/latest/download/latest.json.sig.bin",
                signature.clone(),
            ),
        ])
        .await;
        let pair = server
            .downloader
            .signed_manifest("owner/repo")
            .await
            .unwrap();
        assert_eq!(pair, ("signed manifest".into(), signature));
        assert_eq!(server.requests.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn manifest_fallback_pairs_assets_from_one_release_and_requests_binary_bytes() {
        let signature = vec![0, 128, 255, 1];
        let server = server(vec![
            ("/repos/owner/repo/releases/latest", br#"{"assets":[{"id":11,"name":"latest.json"},{"id":12,"name":"latest.json.sig.bin"}]}"#.to_vec()),
            ("/repos/owner/repo/releases/assets/11", b"signed manifest".to_vec()),
            ("/repos/owner/repo/releases/assets/12", signature.clone()),
        ]).await;
        let pair = server
            .downloader
            .signed_manifest("owner/repo")
            .await
            .unwrap();
        assert_eq!(pair, ("signed manifest".into(), signature));
        let requests = server.requests.lock().unwrap();
        assert_eq!(
            requests
                .iter()
                .filter(|(path, _)| path == "/repos/owner/repo/releases/latest")
                .count(),
            1
        );
        let assets: Vec<_> = requests
            .iter()
            .filter(|(path, _)| path.contains("/assets/"))
            .collect();
        assert_eq!(assets.len(), 2);
        assert!(assets
            .iter()
            .all(|(_, accept)| accept == "application/octet-stream"));
    }

    #[tokio::test]
    async fn installer_fallback_preserves_original_tag_and_encoded_filename() {
        let server = server(vec![
            (
                "/repos/owner/repo/releases/tags/v1.2.3%2Ffix",
                "{\"assets\":[{\"id\":21,\"name\":\"HelM 安装+包.exe\"}]}"
                    .as_bytes()
                    .to_vec(),
            ),
            (
                "/repos/owner/repo/releases/assets/21",
                b"installer bytes".to_vec(),
            ),
        ])
        .await;
        let mut url = server
            .downloader
            .web_url("/owner/repo/releases/download/v1.2.3%2Ffix/");
        url.path_segments_mut()
            .unwrap()
            .pop_if_empty()
            .push("HelM 安装+包.exe");
        assert_eq!(
            server.downloader.installer(url.as_str()).await.unwrap(),
            b"installer bytes"
        );
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert!(!requests.iter().any(|(path, _)| path.ends_with("/latest")));
        assert_eq!(requests.last().unwrap().1, "application/octet-stream");
    }

    #[tokio::test]
    async fn failed_api_reports_both_routes_without_downgrading_to_unsigned_update() {
        let server = server(vec![]).await;
        let error = server
            .downloader
            .signed_manifest("owner/repo")
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("直接下载失败"));
        assert!(error.contains("官方 API 回退也失败"));
        assert!(error.contains("502"));
    }

    #[tokio::test]
    async fn api_signature_size_limit_is_enforced() {
        let server = server(vec![
            ("/repos/owner/repo/releases/latest", br#"{"assets":[{"id":11,"name":"latest.json"},{"id":12,"name":"latest.json.sig.bin"}]}"#.to_vec()),
            ("/repos/owner/repo/releases/assets/11", b"manifest".to_vec()),
            ("/repos/owner/repo/releases/assets/12", vec![0; SIGNATURE_LIMIT + 1]),
        ]).await;
        assert!(server
            .downloader
            .signed_manifest("owner/repo")
            .await
            .unwrap_err()
            .to_string()
            .contains("8192"));
    }

    #[test]
    fn fallback_is_restricted_to_official_github_release_urls() {
        let downloader = UpdateDownloader::new().unwrap();
        for url in [
            "https://github.com.evil.example/owner/repo/releases/download/v1/setup.exe",
            "https://github.com@evil.example/owner/repo/releases/download/v1/setup.exe",
            "https://user:pass@github.com/owner/repo/releases/download/v1/setup.exe",
            "http://github.com/owner/repo/releases/download/v1/setup.exe",
            "https://github.com:8443/owner/repo/releases/download/v1/setup.exe",
            "https://github.com/owner/repo/blob/main/setup.exe",
        ] {
            assert!(
                downloader
                    .github_download(&Url::parse(url).unwrap())
                    .is_none(),
                "{url}"
            );
        }
        let download = downloader
            .github_download(
                &Url::parse("https://github.com/owner/repo/releases/latest/download/setup.exe")
                    .unwrap(),
            )
            .unwrap();
        assert_eq!(download.release, "latest");
        assert_eq!(download.repo, "owner/repo");
        assert_eq!(download.encoded_name, "setup.exe");
    }
}
