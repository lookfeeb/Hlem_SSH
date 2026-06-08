//! Tunnel 与 Backup 的 REST 端点。
//!
//! 这些命令本质上都是 vault CRUD（list / create / update / delete / start / stop /
//! get / put settings / run），统一通过 HTTP REST 提供。

use axum::{
    extract::{Path, Query, State as AxumState},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use serde::Deserialize;
use serde_json::Value as JsonValue;

use super::auth::{verify_auth, verify_session_access};
use super::{allowed_session_ids_snapshot, push_log, ApiError, ApiServerState};

// ─── Helpers ───────────────────────────────────────────────────────────────────

async fn require_auth(
    state: &ApiServerState,
    headers: &HeaderMap,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let key = state.api_key.read().await;
    verify_auth(headers, &key)
}

fn map_err_500(e: impl std::fmt::Display) -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ApiError {
            error: e.to_string(),
        }),
    )
}

fn lock_poisoned() -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ApiError {
            error: "内部锁错误".into(),
        }),
    )
}

fn json_value(value: impl serde::Serialize) -> Json<JsonValue> {
    Json(serde_json::to_value(value).unwrap_or_default())
}

fn elapsed_ms(start: std::time::Instant) -> u64 {
    start.elapsed().as_millis() as u64
}

fn tunnel_allowed(allowed_session_ids: &[String], tunnel: &crate::config::TunnelConfig) -> bool {
    allowed_session_ids.is_empty()
        || allowed_session_ids
            .iter()
            .any(|session_id| session_id == &tunnel.session_id)
}

// ─── Tunnels ───────────────────────────────────────────────────────────────────

/// `GET /api/tunnels` — 列出全部隧道配置。
pub async fn rest_tunnels_list(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let start = std::time::Instant::now();
    let mut tunnels = {
        let store = state.vault.lock().map_err(|_| lock_poisoned())?;
        store.tunnels().map_err(map_err_500)?
    };
    let allowed_session_ids = allowed_session_ids_snapshot(&state);
    if !allowed_session_ids.is_empty() {
        tunnels.retain(|tunnel| tunnel_allowed(&allowed_session_ids, tunnel));
    }
    let count = tunnels.len();
    push_log(
        &state,
        "rest/tunnels.list",
        &format!("{} 项", count),
        true,
        elapsed_ms(start),
    )
    .await;
    Ok(json_value(tunnels))
}

/// `POST /api/tunnels` body: TunnelInput → 创建后返回隧道数组。
pub async fn rest_tunnels_create(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Json(input): Json<crate::config::TunnelInput>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    verify_session_access(&state, &input.session_id)?;
    let start = std::time::Instant::now();
    let snapshot = {
        let mut store = state.vault.lock().map_err(|_| lock_poisoned())?;
        store.create_tunnel(input).map_err(map_err_500)?
    };
    push_log(&state, "rest/tunnels.create", "OK", true, elapsed_ms(start)).await;
    Ok(json_value(snapshot.data.tunnels))
}

/// `PATCH /api/tunnels/:tunnelId` body: TunnelInput → 更新后返回隧道数组。
pub async fn rest_tunnels_update(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Path(tunnel_id): Path<String>,
    Json(input): Json<crate::config::TunnelInput>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    verify_session_access(&state, &input.session_id)?;
    let start = std::time::Instant::now();
    let snapshot = {
        let mut store = state.vault.lock().map_err(|_| lock_poisoned())?;
        store
            .update_tunnel(&tunnel_id, input)
            .map_err(map_err_500)?
    };
    push_log(
        &state,
        "rest/tunnels.update",
        &tunnel_id,
        true,
        elapsed_ms(start),
    )
    .await;
    Ok(json_value(snapshot.data.tunnels))
}

/// `DELETE /api/tunnels/:tunnelId` → 删除后返回隧道数组。
pub async fn rest_tunnels_delete(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Path(tunnel_id): Path<String>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let start = std::time::Instant::now();
    {
        let store = state.vault.lock().map_err(|_| lock_poisoned())?;
        let tunnels = store.tunnels().map_err(map_err_500)?;
        let tunnel = tunnels
            .iter()
            .find(|t| t.id == tunnel_id)
            .ok_or_else(|| {
                (
                    StatusCode::NOT_FOUND,
                    Json(ApiError {
                        error: format!("隧道 {} 不存在", tunnel_id),
                    }),
                )
            })?;
        verify_session_access(&state, &tunnel.session_id)?;
    }
    let snapshot = {
        let mut store = state.vault.lock().map_err(|_| lock_poisoned())?;
        store.delete_tunnel(&tunnel_id).map_err(map_err_500)?
    };
    push_log(
        &state,
        "rest/tunnels.delete",
        &tunnel_id,
        true,
        elapsed_ms(start),
    )
    .await;
    Ok(json_value(snapshot.data.tunnels))
}

/// `POST /api/tunnels/:tunnelId/start` → `{forwardId, bindHost, bindPort}`。
pub async fn rest_tunnels_start(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Path(tunnel_id): Path<String>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let start = std::time::Instant::now();
    let tunnel = {
        let store = state.vault.lock().map_err(|_| lock_poisoned())?;
        let tunnels = store.tunnels().map_err(map_err_500)?;
        tunnels
            .into_iter()
            .find(|t| t.id == tunnel_id)
            .ok_or_else(|| {
                (
                    StatusCode::NOT_FOUND,
                    Json(ApiError {
                        error: format!("隧道 {} 不存在", tunnel_id),
                    }),
                )
            })?
    };
    verify_session_access(&state, &tunnel.session_id)?;
    let (bind_host, bind_port, forward_id) = state
        .remote
        .api_start_tunnel(&tunnel)
        .await
        .map_err(map_err_500)?;
    push_log(
        &state,
        "rest/tunnels.start",
        &tunnel_id,
        true,
        elapsed_ms(start),
    )
    .await;
    Ok(Json(serde_json::json!({
        "forwardId": forward_id,
        "bindHost": bind_host,
        "bindPort": bind_port,
    })))
}

/// `POST /api/tunnels/:tunnelId/stop` → `{success:true}`。
pub async fn rest_tunnels_stop(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Path(tunnel_id): Path<String>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let start = std::time::Instant::now();
    let forward = state
        .remote
        .forward_list()
        .await
        .into_iter()
        .find(|forward| forward.forward_id == tunnel_id)
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ApiError {
                    error: format!("转发 {} 不存在或已停止", tunnel_id),
                }),
            )
        })?;
    verify_session_access(&state, &forward.session_id)?;
    state
        .remote
        .api_stop_tunnel(&tunnel_id)
        .await
        .map_err(map_err_500)?;
    push_log(
        &state,
        "rest/tunnels.stop",
        &tunnel_id,
        true,
        elapsed_ms(start),
    )
    .await;
    Ok(Json(serde_json::json!({ "success": true })))
}

// ─── Backup ────────────────────────────────────────────────────────────────────

/// `GET /api/backup/settings` → 备份设置。
pub async fn rest_backup_settings_get(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let store = state.vault.lock().map_err(|_| lock_poisoned())?;
    let snap = store.snapshot().map_err(map_err_500)?;
    Ok(json_value(snap.data.settings.backup))
}

/// `PUT /api/backup/settings` body: BackupSettings → 写入后返回备份设置。
pub async fn rest_backup_settings_update(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Json(backup): Json<crate::config::BackupSettings>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let start = std::time::Instant::now();
    {
        let mut store = state.vault.lock().map_err(|_| lock_poisoned())?;
        let snap = store.snapshot().map_err(map_err_500)?;
        let mut settings = snap.data.settings.clone();
        settings.backup = backup.clone();
        store.settings_update(settings).map_err(map_err_500)?;
    }
    push_log(
        &state,
        "rest/backup.settings.update",
        "OK",
        true,
        elapsed_ms(start),
    )
    .await;
    Ok(json_value(backup))
}

/// `GET /api/backup/records` → 备份记录数组。
pub async fn rest_backup_records_list(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let store = state.vault.lock().map_err(|_| lock_poisoned())?;
    let snap = store.snapshot().map_err(map_err_500)?;
    Ok(json_value(snap.data.backup_records))
}

/// `POST /api/backup/run` → 立即执行一次备份并返回本次结果数组。
///
/// 写入到本地目录与配置的云端目标。要求至少配置一种。
pub async fn rest_backup_run(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let start = std::time::Instant::now();

    let plan = {
        let store = state.vault.lock().map_err(|_| lock_poisoned())?;
        crate::backup::prepare_backup_run(&store).map_err(map_err_500)?
    };
    let outcomes = crate::backup::run_configured_backup(&plan)
        .await
        .map_err(map_err_500)?;
    let records =
        crate::backup::merge_configured_backup_records(&plan.settings, outcomes.clone()).await;
    let delete_paths = {
        let mut store = state.vault.lock().map_err(|_| lock_poisoned())?;
        let (_, delete_paths) = store.replace_backup_records(records).map_err(map_err_500)?;
        delete_paths
    };
    for path in delete_paths {
        let _ = tokio::fs::remove_file(path).await;
    }
    push_log(&state, "rest/backup.run", "OK", true, elapsed_ms(start)).await;
    Ok(json_value(outcomes))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DeleteRecordQuery {
    #[serde(default)]
    delete_file: bool,
}

/// `DELETE /api/backup/records/:recordId?deleteFile=true` → 删除后返回剩余记录数组。
pub async fn rest_backup_record_delete(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Path(record_id): Path<String>,
    Query(query): Query<DeleteRecordQuery>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let start = std::time::Instant::now();
    let (snap, delete_path) = {
        let mut store = state.vault.lock().map_err(|_| lock_poisoned())?;
        store
            .delete_backup_record(&record_id, query.delete_file)
            .map_err(map_err_500)?
    };
    if let Some(path) = delete_path {
        let _ = tokio::fs::remove_file(path).await;
    }
    push_log(
        &state,
        "rest/backup.record.delete",
        &record_id,
        true,
        elapsed_ms(start),
    )
    .await;
    Ok(json_value(snap.data.backup_records))
}
