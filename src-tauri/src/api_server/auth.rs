//! Bearer 鉴权与会话访问校验。
//!
//! 整个 HTTP API 只认一种凭据：`Authorization: Bearer <api_key>`。
//! 没有 ticket、没有 nonce、没有 session-side 状态——单租户本地服务，
//! API key 本身就是全权令牌。

use axum::http::{HeaderMap, StatusCode};
use axum::response::Json;

use super::{allowed_session_set_snapshot, ApiError, ApiServerState};

pub(super) fn verify_auth(
    headers: &HeaderMap,
    expected: &str,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let token = auth.strip_prefix("Bearer ").unwrap_or("");
    if expected.is_empty() || token != expected {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(ApiError {
                error: "无效的 API Key".to_string(),
            }),
        ));
    }
    Ok(())
}

pub(super) fn verify_session_access(
    state: &ApiServerState,
    session_id: &str,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let allowed_session_ids = allowed_session_set_snapshot(state);
    if !allowed_session_ids.contains(session_id) {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ApiError {
                error: format!("会话 {} 不存在或已删除", session_id),
            }),
        ));
    }
    Ok(())
}

pub(super) fn verify_session_access_and_exists(
    state: &ApiServerState,
    session_id: &str,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    verify_session_access(state, session_id)?;
    let store = state.vault.lock().map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: "内部锁错误".to_string(),
            }),
        )
    })?;
    store.ensure_session_exists(session_id).map_err(|_| {
        (
            StatusCode::NOT_FOUND,
            Json(ApiError {
                error: format!("会话 {} 不存在", session_id),
            }),
        )
    })
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderMap;

    use super::verify_auth;

    #[test]
    fn empty_api_key_never_authenticates() {
        assert!(verify_auth(&HeaderMap::new(), "").is_err());
    }

    #[test]
    fn bearer_key_is_required_even_without_session_bindings() {
        let mut headers = HeaderMap::new();
        assert!(verify_auth(&headers, "helm_test_key").is_err());
        headers.insert("authorization", "Bearer wrong_key".parse().unwrap());
        assert!(verify_auth(&headers, "helm_test_key").is_err());
        headers.insert("authorization", "Bearer helm_test_key".parse().unwrap());
        assert!(verify_auth(&headers, "helm_test_key").is_ok());
    }
}
