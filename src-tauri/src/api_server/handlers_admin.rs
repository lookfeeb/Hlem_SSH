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

use super::auth::{verify_auth, verify_session_access, verify_session_access_and_exists};
use super::{allowed_session_ids_snapshot, push_log, ApiError, ApiServerState};
use crate::errors::AppError;
use crate::{config::ConfigSnapshot, events};

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

fn map_config_mutation_error(error: AppError) -> (StatusCode, Json<ApiError>) {
    let status = match &error {
        AppError::InvalidInput(_) => StatusCode::BAD_REQUEST,
        AppError::NotFound(_) => StatusCode::NOT_FOUND,
        AppError::ConfigConflict(_) => StatusCode::CONFLICT,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (
        status,
        Json(ApiError {
            error: error.to_string(),
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

async fn vault_blocking<T, F>(
    state: &ApiServerState,
    operation: F,
) -> Result<T, (StatusCode, Json<ApiError>)>
where
    T: Send + 'static,
    F: FnOnce(&mut crate::vault::VaultStore) -> crate::errors::AppResult<T> + Send + 'static,
{
    let vault = state.vault.clone();
    tokio::task::spawn_blocking(move || {
        let mut store = vault
            .lock()
            .map_err(|_| AppError::Remote("内部锁错误".to_string()))?;
        operation(&mut store)
    })
    .await
    .map_err(|error| map_err_500(format!("Vault 工作线程异常: {error}")))?
    .map_err(map_config_mutation_error)
}

fn json_value(value: impl serde::Serialize) -> Json<JsonValue> {
    Json(serde_json::to_value(value).unwrap_or_default())
}

fn elapsed_ms(start: std::time::Instant) -> u64 {
    start.elapsed().as_millis() as u64
}

fn emit_config_changed(state: &ApiServerState, snapshot: &ConfigSnapshot) {
    events::emit(&state.app, events::CONFIG_CHANGED, snapshot.clone());
}

fn tunnel_allowed(allowed_session_ids: &[String], tunnel: &crate::config::TunnelConfig) -> bool {
    allowed_session_ids
        .iter()
        .any(|session_id| session_id == &tunnel.session_id)
}

fn allowed_tunnels(
    allowed_session_ids: &[String],
    tunnels: Vec<crate::config::TunnelConfig>,
) -> Vec<crate::config::TunnelConfig> {
    tunnels
        .into_iter()
        .filter(|tunnel| tunnel_allowed(allowed_session_ids, tunnel))
        .collect()
}

fn redact_backup_settings(
    mut settings: crate::config::BackupSettings,
) -> crate::config::BackupSettings {
    settings.cloud.webdav.password.clear();
    settings.cloud.s3.secret_access_key.clear();
    settings
}

fn preserve_blank_backup_secrets(
    mut incoming: crate::config::BackupSettings,
    current: &crate::config::BackupSettings,
) -> crate::config::BackupSettings {
    if incoming.cloud.webdav.password.is_empty() {
        incoming.cloud.webdav.password = current.cloud.webdav.password.clone();
    }
    if incoming.cloud.s3.secret_access_key.is_empty() {
        incoming.cloud.s3.secret_access_key = current.cloud.s3.secret_access_key.clone();
    }
    incoming
}

// ─── Tunnels ───────────────────────────────────────────────────────────────────

/// `GET /api/tunnels` — 列出全部隧道配置。
pub async fn rest_tunnels_list(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let start = std::time::Instant::now();
    let tunnels = {
        let store = state.vault.lock().map_err(|_| lock_poisoned())?;
        store.tunnels().map_err(map_err_500)?
    };
    let tunnels = allowed_tunnels(&allowed_session_ids_snapshot(&state), tunnels);
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
    let ticket = state.config_mutations.ticket();
    let _operation_guard = state.tunnel_operation.lock().await;
    let _mutation_guard = state
        .config_mutations
        .lock(ticket)
        .await
        .map_err(map_config_mutation_error)?;
    require_auth(&state, &headers).await?;
    let allowed_session_ids = allowed_session_ids_snapshot(&state);
    verify_session_access_in_snapshot(&allowed_session_ids, &input.session_id)?;
    let start = std::time::Instant::now();
    let snapshot = vault_blocking(&state, move |store| store.create_tunnel(input)).await?;
    emit_config_changed(&state, &snapshot);
    push_log(&state, "rest/tunnels.create", "OK", true, elapsed_ms(start)).await;
    Ok(json_value(allowed_tunnels(
        &allowed_session_ids_snapshot(&state),
        snapshot.data.tunnels,
    )))
}

/// `PATCH /api/tunnels/:tunnelId` body: TunnelPatch → 局部更新后返回隧道数组。
pub async fn rest_tunnels_update(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Path(tunnel_id): Path<String>,
    Json(patch): Json<crate::config::TunnelPatch>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let ticket = state.config_mutations.ticket();
    let _operation_guard = state.tunnel_operation.lock().await;
    let _mutation_guard = state
        .config_mutations
        .lock(ticket)
        .await
        .map_err(map_config_mutation_error)?;
    require_auth(&state, &headers).await?;
    let allowed_session_ids = allowed_session_ids_snapshot(&state);
    if patch.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiError {
                error: "PATCH 至少需要一个隧道字段".to_string(),
            }),
        ));
    }
    let start = std::time::Instant::now();
    let input = {
        let store = state.vault.lock().map_err(|_| lock_poisoned())?;
        let tunnels = store.tunnels().map_err(map_err_500)?;
        let tunnel = tunnels
            .iter()
            .find(|tunnel| tunnel.id == tunnel_id)
            .ok_or_else(|| {
                (
                    StatusCode::NOT_FOUND,
                    Json(ApiError {
                        error: format!("隧道 {} 不存在", tunnel_id),
                    }),
                )
            })?;
        // 更新既需要访问目标会话，也需要访问隧道原所属会话。否则只要知道
        // tunnel id，授权客户端就能把未授权会话的隧道迁移到自己的会话下。
        verify_session_access_in_snapshot(&allowed_session_ids, &tunnel.session_id)?;
        let input = patch.apply_to(tunnel);
        verify_session_access_in_snapshot(&allowed_session_ids, &input.session_id)?;
        store
            .validate_tunnel_update(&tunnel_id, &input)
            .map_err(map_err_500)?;
        input
    };
    state
        .remote
        .stop_forwards_for_tunnel(&state.app, &tunnel_id)
        .await
        .map_err(map_err_500)?;
    let update_tunnel_id = tunnel_id.clone();
    let snapshot = vault_blocking(&state, move |store| {
        store.update_tunnel(&update_tunnel_id, input)
    })
    .await?;
    emit_config_changed(&state, &snapshot);
    push_log(
        &state,
        "rest/tunnels.update",
        &tunnel_id,
        true,
        elapsed_ms(start),
    )
    .await;
    Ok(json_value(allowed_tunnels(
        &allowed_session_ids_snapshot(&state),
        snapshot.data.tunnels,
    )))
}

fn verify_session_access_in_snapshot(
    allowed_session_ids: &[String],
    session_id: &str,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if tunnel_session_allowed(allowed_session_ids, session_id) {
        return Ok(());
    }
    Err((
        StatusCode::FORBIDDEN,
        Json(ApiError {
            error: format!("无权访问会话 {}，仅允许访问指定会话", session_id),
        }),
    ))
}

fn tunnel_session_allowed(allowed_session_ids: &[String], session_id: &str) -> bool {
    allowed_session_ids
        .iter()
        .any(|allowed_session_id| allowed_session_id == session_id)
}

/// `DELETE /api/tunnels/:tunnelId` → 删除后返回隧道数组。
pub async fn rest_tunnels_delete(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Path(tunnel_id): Path<String>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let ticket = state.config_mutations.ticket();
    let _operation_guard = state.tunnel_operation.lock().await;
    let _mutation_guard = state
        .config_mutations
        .lock(ticket)
        .await
        .map_err(map_config_mutation_error)?;
    require_auth(&state, &headers).await?;
    let start = std::time::Instant::now();
    let allowed_session_ids = allowed_session_ids_snapshot(&state);
    {
        let store = state.vault.lock().map_err(|_| lock_poisoned())?;
        let tunnels = store.tunnels().map_err(map_err_500)?;
        let tunnel = tunnels.iter().find(|t| t.id == tunnel_id).ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ApiError {
                    error: format!("隧道 {} 不存在", tunnel_id),
                }),
            )
        })?;
        verify_session_access_in_snapshot(&allowed_session_ids, &tunnel.session_id)?;
    }
    state
        .remote
        .stop_forwards_for_tunnel(&state.app, &tunnel_id)
        .await
        .map_err(map_err_500)?;
    let delete_tunnel_id = tunnel_id.clone();
    let snapshot =
        vault_blocking(&state, move |store| store.delete_tunnel(&delete_tunnel_id)).await?;
    emit_config_changed(&state, &snapshot);
    push_log(
        &state,
        "rest/tunnels.delete",
        &tunnel_id,
        true,
        elapsed_ms(start),
    )
    .await;
    Ok(json_value(allowed_tunnels(
        &allowed_session_ids_snapshot(&state),
        snapshot.data.tunnels,
    )))
}

/// `POST /api/tunnels/:tunnelId/start` → `{forwardId, bindHost, bindPort}`。
pub async fn rest_tunnels_start(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Path(tunnel_id): Path<String>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let _operation_guard = state.tunnel_operation.lock().await;
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
    verify_session_access_and_exists(&state, &tunnel.session_id)?;
    let config_guard = state.connection_config_gate.read().await;
    let (session, known_host) = {
        let store = state.vault.lock().map_err(|_| lock_poisoned())?;
        crate::commands::build_session_for_connect(&store, &tunnel.session_id)
            .map_err(map_err_500)?
    };
    drop(config_guard);
    state
        .remote
        .api_connect_session(&state.app, session.clone(), known_host)
        .await
        .map_err(map_err_500)?;
    if verify_session_access(&state, &tunnel.session_id).is_err() {
        let _ = state
            .remote
            .api_disconnect_session(&state.app, &tunnel.session_id)
            .await;
        return Err((
            StatusCode::FORBIDDEN,
            Json(ApiError {
                error: format!("会话 {} 已不在 AI API 授权范围内", tunnel.session_id),
            }),
        ));
    }
    let still_valid = {
        let store = state.vault.lock().map_err(|_| lock_poisoned())?;
        crate::commands::session_matches_current_connection_config(&store, &session)
            .unwrap_or(false)
    };
    if !still_valid {
        let _ = state
            .remote
            .api_disconnect_session(&state.app, &tunnel.session_id)
            .await;
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError {
                error: "会话配置已变更，请重试".to_string(),
            }),
        ));
    }
    let info = state
        .remote
        .forward_start_for_tunnel(
            &state.app,
            &tunnel,
            crate::remote::ConnectionOrigin::Automation,
        )
        .await
        .map_err(map_err_500)?;
    if verify_session_access(&state, &tunnel.session_id).is_err() {
        let _ = state
            .remote
            .stop_forwards_for_tunnel_origin(
                &state.app,
                &tunnel.id,
                crate::remote::ConnectionOrigin::Automation,
            )
            .await;
        let _ = state
            .remote
            .api_disconnect_session(&state.app, &tunnel.session_id)
            .await;
        return Err((
            StatusCode::FORBIDDEN,
            Json(ApiError {
                error: format!("会话 {} 已不在 AI API 授权范围内", tunnel.session_id),
            }),
        ));
    }
    push_log(
        &state,
        "rest/tunnels.start",
        &tunnel_id,
        true,
        elapsed_ms(start),
    )
    .await;
    Ok(Json(serde_json::json!({
        "forwardId": info.forward_id,
        "bindHost": info.bind_host,
        "bindPort": info.bind_port,
    })))
}

/// `POST /api/tunnels/:tunnelId/stop` → `{success:true}`。
pub async fn rest_tunnels_stop(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Path(tunnel_id): Path<String>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let _operation_guard = state.tunnel_operation.lock().await;
    require_auth(&state, &headers).await?;
    let start = std::time::Instant::now();
    let (session_id, forward_id) = {
        let store = state.vault.lock().map_err(|_| lock_poisoned())?;
        let tunnel = store
            .tunnels()
            .map_err(map_err_500)?
            .into_iter()
            .find(|tunnel| tunnel.id == tunnel_id)
            .ok_or_else(|| {
                (
                    StatusCode::NOT_FOUND,
                    Json(ApiError {
                        error: format!("隧道 {} 不存在", tunnel_id),
                    }),
                )
            })?;
        (tunnel.session_id, tunnel.id)
    };
    verify_session_access(&state, &session_id)?;
    state
        .remote
        .stop_forwards_for_tunnel_origin(
            &state.app,
            &forward_id,
            crate::remote::ConnectionOrigin::Automation,
        )
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
    let settings = store.backup_settings().map_err(map_err_500)?;
    Ok(json_value(redact_backup_settings(settings)))
}

/// `PUT /api/backup/settings` body: BackupSettings → 写入后返回备份设置。
pub async fn rest_backup_settings_update(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Json(backup): Json<crate::config::BackupSettings>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    mutate_backup_settings(
        state,
        headers,
        BackupSettingsMutation::Replace(backup),
        "rest/backup.settings.update",
    )
    .await
}

/// `PATCH /api/backup/settings` — 按 JSON Merge Patch 语义局部更新备份设置。
pub async fn rest_backup_settings_patch(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Json(patch): Json<JsonValue>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    if !patch.is_object() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiError {
                error: "备份设置 PATCH 请求体必须是 JSON 对象".to_string(),
            }),
        ));
    }
    if let Err(error) = validate_backup_settings_patch(&patch) {
        return Err((StatusCode::BAD_REQUEST, Json(ApiError { error })));
    }
    mutate_backup_settings(
        state,
        headers,
        BackupSettingsMutation::Patch(patch),
        "rest/backup.settings.patch",
    )
    .await
}

fn validate_backup_settings_patch(patch: &JsonValue) -> Result<(), String> {
    let object = patch
        .as_object()
        .ok_or_else(|| "备份设置 PATCH 请求体必须是 JSON 对象".to_string())?;
    if object.is_empty() {
        return Err("备份设置 PATCH 至少需要一个字段".to_string());
    }
    validate_patch_keys(
        object,
        &[
            "localDirectory",
            "autoEnabled",
            "frequency",
            "retentionCount",
            "retentionDays",
            "cloud",
        ],
        "backup",
    )?;
    let Some(cloud) = object.get("cloud").and_then(JsonValue::as_object) else {
        return Ok(());
    };
    validate_patch_keys(
        cloud,
        &["enabled", "autoEnabled", "kind", "webdav", "s3"],
        "backup.cloud",
    )?;
    if let Some(webdav) = cloud.get("webdav").and_then(JsonValue::as_object) {
        validate_patch_keys(
            webdav,
            &["endpoint", "username", "password", "remotePath"],
            "backup.cloud.webdav",
        )?;
    }
    if let Some(s3) = cloud.get("s3").and_then(JsonValue::as_object) {
        validate_patch_keys(
            s3,
            &[
                "endpoint",
                "region",
                "bucket",
                "accessKeyId",
                "secretAccessKey",
                "prefix",
                "pathStyle",
            ],
            "backup.cloud.s3",
        )?;
    }
    Ok(())
}

fn validate_patch_keys(
    object: &serde_json::Map<String, JsonValue>,
    allowed: &[&str],
    path: &str,
) -> Result<(), String> {
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(format!("{path} 包含未知字段 {key}"));
    }
    Ok(())
}

enum BackupSettingsMutation {
    Replace(crate::config::BackupSettings),
    Patch(JsonValue),
}

async fn mutate_backup_settings(
    state: ApiServerState,
    headers: HeaderMap,
    mutation: BackupSettingsMutation,
    log_action: &'static str,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let ticket = state.config_mutations.ticket();
    let _operation_guard = state.backup_operation.lock().await;
    let _mutation_guard = state
        .config_mutations
        .lock(ticket)
        .await
        .map_err(map_config_mutation_error)?;
    require_auth(&state, &headers).await?;
    let start = std::time::Instant::now();
    let (snapshot, response, delete_paths) = vault_blocking(&state, move |store| {
        let current = store.backup_settings()?;
        let backup = match mutation {
            BackupSettingsMutation::Replace(backup) => backup,
            BackupSettingsMutation::Patch(patch) => {
                let mut merged = serde_json::to_value(&current)?;
                merge_json_patch(&mut merged, patch);
                serde_json::from_value(merged).map_err(|error| {
                    AppError::InvalidInput(format!("备份设置 PATCH 无效: {error}"))
                })?
            }
        };
        let backup = preserve_blank_backup_secrets(backup, &current);
        let (snapshot, delete_paths) = store.settings_backup_update(backup.clone())?;
        Ok((snapshot, redact_backup_settings(backup), delete_paths))
    })
    .await?;
    drop(_mutation_guard);
    for target in delete_paths {
        crate::backup::remove_backup_target_best_effort(
            target,
            "REST backup retention settings update",
        )
        .await;
    }
    emit_config_changed(&state, &snapshot);
    push_log(&state, log_action, "OK", true, elapsed_ms(start)).await;
    Ok(json_value(response))
}

fn merge_json_patch(target: &mut JsonValue, patch: JsonValue) {
    let JsonValue::Object(patch) = patch else {
        *target = patch;
        return;
    };
    if !target.is_object() {
        *target = JsonValue::Object(serde_json::Map::new());
    }
    let target = target
        .as_object_mut()
        .expect("target was converted to a JSON object");
    for (key, value) in patch {
        if value.is_null() {
            target.remove(&key);
        } else {
            merge_json_patch(target.entry(key).or_insert(JsonValue::Null), value);
        }
    }
}

/// `GET /api/backup/records` → 备份记录数组。
pub async fn rest_backup_records_list(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let store = state.vault.lock().map_err(|_| lock_poisoned())?;
    Ok(json_value(store.backup_records().map_err(map_err_500)?))
}

/// `POST /api/backup/run` → 立即执行一次备份并返回本次结果数组。
///
/// 写入到本地目录与配置的云端目标。要求至少配置一种。
pub async fn rest_backup_run(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let ticket = state.config_mutations.ticket();
    let _operation_guard = state.backup_operation.lock().await;
    let start = std::time::Instant::now();
    let validation_guard = state
        .config_mutations
        .lock(ticket)
        .await
        .map_err(map_config_mutation_error)?;
    require_auth(&state, &headers).await?;

    let plan = {
        let store = state.vault.lock().map_err(|_| lock_poisoned())?;
        crate::backup::prepare_backup_run(&store).map_err(map_err_500)?
    };
    drop(validation_guard);
    let outcomes = crate::backup::run_configured_backup(&plan)
        .await
        .map_err(map_err_500)?;
    let records = crate::backup::merge_configured_backup_records(&plan, outcomes.clone()).await;
    let mutation_guard = state
        .config_mutations
        .lock(ticket)
        .await
        .map_err(map_config_mutation_error)?;
    let (snapshot, delete_paths) =
        vault_blocking(&state, move |store| store.replace_backup_records(records)).await?;
    drop(mutation_guard);
    emit_config_changed(&state, &snapshot);
    for target in delete_paths {
        crate::backup::remove_backup_target_best_effort(target, "REST backup record replacement")
            .await;
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
    let ticket = state.config_mutations.ticket();
    let _operation_guard = state.backup_operation.lock().await;
    let mutation_guard = state
        .config_mutations
        .lock(ticket)
        .await
        .map_err(map_config_mutation_error)?;
    require_auth(&state, &headers).await?;
    let start = std::time::Instant::now();
    let delete_record_id = record_id.clone();
    let delete_file = query.delete_file;
    let (snap, delete_path) = vault_blocking(&state, move |store| {
        store.delete_backup_record(&delete_record_id, delete_file)
    })
    .await?;
    drop(mutation_guard);
    if let Some(target) = delete_path {
        crate::backup::remove_backup_target_best_effort(target, "REST backup record deletion")
            .await;
    }
    emit_config_changed(&state, &snap);
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

#[cfg(test)]
mod tests {
    use super::{
        allowed_tunnels, map_config_mutation_error, merge_json_patch,
        preserve_blank_backup_secrets, redact_backup_settings, tunnel_allowed,
        tunnel_session_allowed, validate_backup_settings_patch,
    };
    use crate::config::{BackupSettings, TunnelConfig, TunnelInput, TunnelPatch};
    use crate::errors::AppError;
    use axum::http::StatusCode;
    use serde_json::json;

    fn tunnel(session_id: &str) -> TunnelConfig {
        let mut tunnel = TunnelConfig::new(TunnelInput {
            name: "测试".to_string(),
            session_id: session_id.to_string(),
            forward_type: "local".to_string(),
            bind_host: "127.0.0.1".to_string(),
            bind_port: 0,
            target_host: "127.0.0.1".to_string(),
            target_port: 22,
        });
        tunnel.id = "tunnel-a".to_string();
        tunnel
    }

    #[test]
    fn tunnel_patch_preserves_omitted_fields() {
        let current = tunnel("session-a");
        let input = TunnelPatch {
            name: Some("新名称".to_string()),
            bind_port: Some(10022),
            ..TunnelPatch::default()
        }
        .apply_to(&current);
        assert_eq!(input.name, "新名称");
        assert_eq!(input.bind_port, 10022);
        assert_eq!(input.session_id, "session-a");
        assert_eq!(input.target_port, current.target_port);
    }

    #[test]
    fn backup_merge_patch_updates_nested_fields_and_removes_nulls() {
        let mut current = json!({
            "localDirectory": "C:/backup",
            "retentionCount": 10,
            "cloud": { "enabled": false, "kind": "webdav" }
        });
        merge_json_patch(
            &mut current,
            json!({
                "localDirectory": null,
                "retentionCount": 20,
                "cloud": { "enabled": true }
            }),
        );
        assert!(current.get("localDirectory").is_none());
        assert_eq!(current["retentionCount"], 20);
        assert_eq!(current["cloud"]["enabled"], true);
        assert_eq!(current["cloud"]["kind"], "webdav");
        assert!(validate_backup_settings_patch(&json!({
            "cloud": { "webdav": { "remotePath": "/backup" } }
        }))
        .is_ok());
        assert!(validate_backup_settings_patch(&json!({ "retentinCount": 20 })).is_err());
        assert!(validate_backup_settings_patch(&json!({})).is_err());
    }

    #[test]
    fn empty_api_allowlist_exposes_no_tunnels() {
        let tunnel = tunnel("session-a");
        assert!(!tunnel_allowed(&[], &tunnel));
        assert!(tunnel_allowed(&["session-a".to_string()], &tunnel));
        assert!(!tunnel_allowed(&["session-b".to_string()], &tunnel));
    }

    #[test]
    fn tunnel_update_requires_old_and_new_sessions_in_the_same_allowlist_snapshot() {
        let allowed = vec!["session-new".to_string()];
        assert!(!tunnel_session_allowed(&allowed, "session-old"));
        assert!(tunnel_session_allowed(&allowed, "session-new"));

        let allowed = vec!["session-old".to_string(), "session-new".to_string()];
        assert!(tunnel_session_allowed(&allowed, "session-old"));
        assert!(tunnel_session_allowed(&allowed, "session-new"));
    }

    #[test]
    fn tunnel_mutation_responses_only_include_authorized_sessions() {
        let visible = tunnel("session-a");
        let hidden = tunnel("session-b");
        let filtered = allowed_tunnels(&["session-a".to_string()], vec![visible, hidden]);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].session_id, "session-a");
    }

    #[test]
    fn backup_settings_responses_hide_cloud_secrets_and_blank_updates_preserve_them() {
        let mut current = BackupSettings::default();
        current.cloud.webdav.password = "webdav-secret".to_string();
        current.cloud.s3.secret_access_key = "s3-secret".to_string();

        let redacted = redact_backup_settings(current.clone());
        assert!(redacted.cloud.webdav.password.is_empty());
        assert!(redacted.cloud.s3.secret_access_key.is_empty());

        let mut incoming = current.clone();
        incoming.frequency = "weekly".to_string();
        incoming.cloud.webdav.password.clear();
        incoming.cloud.s3.secret_access_key.clear();
        let merged = preserve_blank_backup_secrets(incoming, &current);
        assert_eq!(merged.cloud.webdav.password, "webdav-secret");
        assert_eq!(merged.cloud.s3.secret_access_key, "s3-secret");
        assert_eq!(merged.frequency, "weekly");
    }

    #[test]
    fn stale_config_mutations_are_reported_as_http_conflicts() {
        let (status, body) =
            map_config_mutation_error(AppError::ConfigConflict("配置已被替换".to_string()));
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(body.0.error.contains("配置冲突"));
    }
}
