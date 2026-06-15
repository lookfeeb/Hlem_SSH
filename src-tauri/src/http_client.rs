use std::time::Duration;

use reqwest::{Client, RequestBuilder, Response, StatusCode};

use crate::errors::{AppError, AppResult};

const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const RETRY_DELAYS: [Duration; 2] = [Duration::from_millis(300), Duration::from_millis(900)];

pub(crate) fn http_client(timeout: Duration) -> AppResult<Client> {
    Client::builder()
        .connect_timeout(DEFAULT_CONNECT_TIMEOUT)
        .timeout(timeout)
        .build()
        .map_err(|error| AppError::Remote(error.to_string()))
}

pub(crate) async fn send_with_retry(
    operation: &str,
    mut request: impl FnMut() -> RequestBuilder,
) -> AppResult<Response> {
    let mut last_error = None;
    let mut last_status = None;

    for retry_delay in RETRY_DELAYS.iter().copied().map(Some).chain([None]) {
        match request().send().await {
            Ok(response) if should_retry_status(response.status()) && retry_delay.is_some() => {
                last_status = Some(response.status());
                if let Some(delay) = retry_delay {
                    tokio::time::sleep(delay).await;
                }
            }
            Ok(response) => return Ok(response),
            Err(error) if should_retry_error(&error) && retry_delay.is_some() => {
                last_error = Some(error.to_string());
                if let Some(delay) = retry_delay {
                    tokio::time::sleep(delay).await;
                }
            }
            Err(error) => {
                return Err(AppError::Remote(format!("{operation}失败: {error}")));
            }
        }
    }

    if let Some(status) = last_status {
        return Err(AppError::Remote(format!("{operation}失败: HTTP {status}")));
    }
    Err(AppError::Remote(format!(
        "{operation}失败: {}",
        last_error.unwrap_or_else(|| "网络请求失败".to_string())
    )))
}

fn should_retry_status(status: StatusCode) -> bool {
    status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

fn should_retry_error(error: &reqwest::Error) -> bool {
    error.is_timeout() || error.is_connect()
}
