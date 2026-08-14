use std::convert::Infallible;
use std::time::Duration;

use axum::{
    extract::{Path, Query, State as AxumState},
    http::{HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive},
        IntoResponse, Json, Response, Sse,
    },
};
use futures_util::{stream, StreamExt};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::{broadcast, mpsc};

use crate::remote::ExecStreamChunk;

use super::auth::verify_session_access;
use super::handlers_remote::{
    elapsed_ms, ensure_api_session_ready, require_auth, validate_exec_request,
};
use super::jobs::{JobEvent, JobRecord, JobRegistryError, JobSnapshot, JobStatus, JobSummary};
use super::{
    allowed_session_set_snapshot, command_log_detail, friendly_error_detail, push_log,
    push_log_with_response, response_log_preview, ApiError, ApiServerState,
};

const DEFAULT_API_JOB_TIMEOUT_MS: u64 = 30 * 60_000;
const MAX_API_JOB_TIMEOUT_MS: u64 = 24 * 60 * 60_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ExecJobBody {
    session_id: String,
    command: String,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    safety_mode: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct JobPath {
    job_id: String,
}

#[derive(Default, Deserialize)]
pub(super) struct JobEventsQuery {
    #[serde(default)]
    after: Option<u64>,
}

pub async fn rest_jobs_create(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Json(body): Json<ExecJobBody>,
) -> Result<(StatusCode, Json<JobSnapshot>), (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    validate_exec_request(&body.session_id, &body.command, body.safety_mode.as_deref())?;
    verify_session_access(&state, &body.session_id)?;

    let timeout_ms = body
        .timeout_ms
        .unwrap_or(DEFAULT_API_JOB_TIMEOUT_MS)
        .clamp(1, MAX_API_JOB_TIMEOUT_MS);
    let command_preview = command_log_detail(&body.command, 120);
    let record = state
        .jobs
        .create(body.session_id.clone(), command_preview.clone(), timeout_ms)
        .await
        .map_err(map_registry_error)?;
    let job_id = record.job_id().await;
    let snapshot = record.snapshot().await;

    let task_state = state.clone();
    let task_record = record.clone();
    let task_command = body.command;
    let task_session_id = body.session_id;
    let handle = tokio::spawn(async move {
        execute_job(
            task_state,
            task_record,
            task_session_id,
            task_command,
            timeout_ms,
        )
        .await;
    });
    state.jobs.attach_handle(&job_id, handle).await;
    push_log(
        &state,
        "rest/job-create",
        &format!("{job_id} · {command_preview}"),
        true,
        0,
    )
    .await;
    Ok((StatusCode::ACCEPTED, Json(snapshot)))
}

async fn execute_job(
    state: ApiServerState,
    record: std::sync::Arc<JobRecord>,
    session_id: String,
    command: String,
    timeout_ms: u64,
) {
    let started = std::time::Instant::now();
    async {
        if !record.mark_connecting().await {
            return;
        }

        let connection_started = std::time::Instant::now();
        let mut cancel = record.cancel_receiver();
        let connection_result = tokio::select! {
            biased;
            _ = cancel.wait_for(|requested| *requested) => None,
            result = ensure_api_session_ready(&state, &session_id, false) => Some(result),
        };
        let Some(connection_result) = connection_result else {
            record
                .set_connection_ms(connection_started.elapsed().as_millis())
                .await;
            record.finish_canceled().await;
            return;
        };
        let connection_ms = match connection_result {
            Ok(value) => value,
            Err((_, Json(error))) => {
                record
                    .set_connection_ms(connection_started.elapsed().as_millis())
                    .await;
                record.finish_error(error.error).await;
                return;
            }
        };
        record.set_connection_ms(connection_ms).await;
        if let Err((_, Json(error))) = verify_session_access(&state, &session_id) {
            record.finish_error(error.error).await;
            return;
        }

        let queue_started = std::time::Instant::now();
        let mut cancel = record.cancel_receiver();
        let permit_result = tokio::select! {
            biased;
            _ = cancel.wait_for(|requested| *requested) => None,
            result = state.execution_limiter.acquire(&session_id) => Some(result),
        };
        let queue_ms = queue_started.elapsed().as_millis();
        record.set_queue_ms(queue_ms).await;
        let Some(permit_result) = permit_result else {
            record.finish_canceled().await;
            return;
        };
        let _execution_permit = match permit_result {
            Ok(permit) => permit,
            Err(error) => {
                record.finish_error(error).await;
                return;
            }
        };
        if let Err((_, Json(error))) = verify_session_access(&state, &session_id) {
            record.finish_error(error.error).await;
            return;
        }
        if !record.mark_running().await {
            return;
        }

        let (output_tx, mut output_rx) = mpsc::channel(32);
        let output_record = record.clone();
        let output_task = tokio::spawn(async move {
            while let Some(chunk) = output_rx.recv().await {
                match chunk {
                    ExecStreamChunk::Stdout(text) => output_record.append_stdout(text).await,
                    ExecStreamChunk::Stderr(text) => output_record.append_stderr(text).await,
                }
            }
        });
        let result = state
            .remote
            .api_exec_stream(
                &session_id,
                command.clone(),
                timeout_ms,
                output_tx,
                record.cancel_receiver(),
            )
            .await;
        let _ = output_task.await;
        match result {
            Ok(mut result) => {
                result.queue_ms = queue_ms;
                result.connection_ms = connection_ms;
                result.duration_ms = started.elapsed().as_millis();
                record.finish_result(result).await;
            }
            Err(error) => record.finish_error(error).await,
        }
    }
    .await;

    let finished = record.snapshot().await;
    let success = finished.status == JobStatus::Completed;
    let preview = response_log_preview(&command, &finished.stdout, 2_000);
    let detail = if let Some(error) = &finished.error {
        friendly_error_detail(&format!("{} → {}", command, error), &state)
    } else {
        command_log_detail(&command, 120)
    };
    push_log_with_response(
        &state,
        "rest/job",
        &detail,
        success,
        elapsed_ms(started),
        preview,
    )
    .await;
}

pub async fn rest_jobs_list(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
) -> Result<Json<Vec<JobSummary>>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let allowed = allowed_session_set_snapshot(&state);
    let snapshots = state
        .jobs
        .list()
        .await
        .into_iter()
        .filter(|job| allowed.contains(&job.session_id))
        .collect();
    Ok(Json(snapshots))
}

pub async fn rest_job_get(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Path(path): Path<JobPath>,
) -> Result<Json<JobSnapshot>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let record = find_job(&state, &path.job_id).await?;
    let snapshot = record.snapshot().await;
    verify_session_access(&state, &snapshot.session_id)?;
    Ok(Json(snapshot))
}

pub async fn rest_job_cancel(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Path(path): Path<JobPath>,
) -> Result<Json<JobSnapshot>, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let record = find_job(&state, &path.job_id).await?;
    let snapshot = record.snapshot().await;
    verify_session_access(&state, &snapshot.session_id)?;
    let canceled = state
        .jobs
        .cancel(&path.job_id)
        .await
        .map_err(map_registry_error)?;
    push_log(&state, "rest/job-cancel", &path.job_id, true, 0).await;
    Ok(Json(canceled))
}

pub async fn rest_job_events(
    headers: HeaderMap,
    AxumState(state): AxumState<ApiServerState>,
    Path(path): Path<JobPath>,
    Query(query): Query<JobEventsQuery>,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    require_auth(&state, &headers).await?;
    let record = find_job(&state, &path.job_id).await?;
    let snapshot = record.snapshot().await;
    verify_session_access(&state, &snapshot.session_id)?;
    let header_after = headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    let subscription = record
        .subscribe(query.after.or(header_after).unwrap_or(0))
        .await;
    let initial = stream::iter(
        subscription
            .initial
            .into_iter()
            .map(|event| Ok::<Event, Infallible>(to_sse_event(event))),
    );
    let live = stream::unfold(
        (record, subscription.receiver, subscription.terminal),
        |(record, mut receiver, done)| async move {
            if done {
                return None;
            }
            match receiver.recv().await {
                Ok(event) => {
                    let terminal = is_terminal_event(&event.event);
                    Some((
                        Ok::<Event, Infallible>(to_sse_event(event)),
                        (record, receiver, terminal),
                    ))
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let (event, terminal) = record.snapshot_event().await;
                    Some((
                        Ok::<Event, Infallible>(to_sse_event(event)),
                        (record, receiver, terminal),
                    ))
                }
                Err(broadcast::error::RecvError::Closed) => None,
            }
        },
    );
    Ok(Sse::new(initial.chain(live).boxed())
        .keep_alive(
            KeepAlive::new()
                .interval(Duration::from_secs(15))
                .text("keepalive"),
        )
        .into_response())
}

async fn find_job(
    state: &ApiServerState,
    job_id: &str,
) -> Result<std::sync::Arc<JobRecord>, (StatusCode, Json<ApiError>)> {
    state.jobs.get(job_id).await.ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            Json(ApiError {
                error: format!("任务 {job_id} 不存在或已过期"),
            }),
        )
    })
}

fn map_registry_error(error: JobRegistryError) -> (StatusCode, Json<ApiError>) {
    let (status, message) = match error {
        JobRegistryError::NotFound => (StatusCode::NOT_FOUND, "任务不存在".to_string()),
        JobRegistryError::Capacity(message) => (StatusCode::TOO_MANY_REQUESTS, message),
        JobRegistryError::Conflict(message) => (StatusCode::CONFLICT, message),
    };
    (status, Json(ApiError { error: message }))
}

fn to_sse_event(event: JobEvent) -> Event {
    Event::default()
        .id(event.id.to_string())
        .event(event.event)
        .data(
            json!({
                "timestamp": event.timestamp,
                "payload": event.data
            })
            .to_string(),
        )
}

fn is_terminal_event(event: &str) -> bool {
    matches!(event, "completed" | "failed" | "canceled" | "timedOut")
}

#[cfg(test)]
mod tests {
    use super::is_terminal_event;

    #[test]
    fn only_final_job_events_close_the_sse_stream() {
        assert!(is_terminal_event("completed"));
        assert!(is_terminal_event("timedOut"));
        assert!(!is_terminal_event("stdout"));
        assert!(!is_terminal_event("canceling"));
    }
}
