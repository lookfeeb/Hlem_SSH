use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::Utc;
use futures_util::{stream::FuturesUnordered, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::{broadcast, watch, Mutex, RwLock};
use tokio::task::JoinHandle;
use tokio::time::timeout;
use uuid::Uuid;

use crate::remote::ExecResult;

const MAX_JOB_EVENTS: usize = 1_024;
const MAX_JOB_EVENT_BYTES: usize = 4 * 1024 * 1024;
const MAX_JOB_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_RETAINED_JOBS: usize = 100;
const MAX_ACTIVE_JOBS_PER_SESSION: usize = 4;
const COMPLETED_JOB_RETENTION: Duration = Duration::from_secs(30 * 60);
const JOB_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Default)]
pub struct JobRegistry {
    jobs: Arc<RwLock<HashMap<String, Arc<JobRecord>>>>,
    mutation_lock: Arc<Mutex<()>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum JobStatus {
    Queued,
    Connecting,
    Running,
    Canceling,
    Completed,
    Failed,
    Canceled,
    TimedOut,
}

impl JobStatus {
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Canceled | Self::TimedOut
        )
    }

    fn is_active(&self) -> bool {
        !self.is_terminal()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSummary {
    pub job_id: String,
    pub session_id: String,
    pub command_preview: String,
    pub status: JobStatus,
    pub timeout_ms: u64,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_status: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_open_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_ms: Option<u64>,
    pub timed_out: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
    pub output_truncated: bool,
    pub last_event_id: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSnapshot {
    pub job_id: String,
    pub session_id: String,
    pub command_preview: String,
    pub status: JobStatus,
    pub timeout_ms: u64,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_status: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_open_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_ms: Option<u64>,
    pub timed_out: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub stdout: String,
    pub stderr: String,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
    pub output_truncated: bool,
    pub last_event_id: u64,
}

impl From<&JobSnapshot> for JobSummary {
    fn from(snapshot: &JobSnapshot) -> Self {
        Self {
            job_id: snapshot.job_id.clone(),
            session_id: snapshot.session_id.clone(),
            command_preview: snapshot.command_preview.clone(),
            status: snapshot.status.clone(),
            timeout_ms: snapshot.timeout_ms,
            created_at: snapshot.created_at.clone(),
            started_at: snapshot.started_at.clone(),
            completed_at: snapshot.completed_at.clone(),
            exit_status: snapshot.exit_status,
            duration_ms: snapshot.duration_ms,
            queue_ms: snapshot.queue_ms,
            connection_ms: snapshot.connection_ms,
            channel_open_ms: snapshot.channel_open_ms,
            execution_ms: snapshot.execution_ms,
            timed_out: snapshot.timed_out,
            error: snapshot.error.clone(),
            stdout_bytes: snapshot.stdout_bytes,
            stderr_bytes: snapshot.stderr_bytes,
            output_truncated: snapshot.output_truncated,
            last_event_id: snapshot.last_event_id,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobEvent {
    pub id: u64,
    pub event: String,
    pub timestamp: String,
    pub data: Value,
}

pub struct JobSubscription {
    pub initial: Vec<JobEvent>,
    pub receiver: broadcast::Receiver<JobEvent>,
    pub terminal: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobRegistryError {
    NotFound,
    Capacity(String),
    Conflict(String),
}

pub struct JobRecord {
    state: RwLock<JobState>,
    event_tx: broadcast::Sender<JobEvent>,
    cancel_tx: watch::Sender<bool>,
    handle: Mutex<Option<JoinHandle<()>>>,
}

struct StoredJobEvent {
    event: JobEvent,
    bytes: usize,
}

struct JobState {
    snapshot: JobSnapshot,
    stdout: BoundedTextTail,
    stderr: BoundedTextTail,
    events: VecDeque<StoredJobEvent>,
    event_bytes: usize,
    next_event_id: u64,
    created_at_instant: Instant,
    completed_at_instant: Option<Instant>,
}

impl JobRegistry {
    pub async fn create(
        &self,
        session_id: String,
        command_preview: String,
        timeout_ms: u64,
    ) -> Result<Arc<JobRecord>, JobRegistryError> {
        let _guard = self.mutation_lock.lock().await;
        self.prune_expired().await;
        let records = self.jobs.read().await.values().cloned().collect::<Vec<_>>();
        if records.len() >= MAX_RETAINED_JOBS && !self.evict_oldest_terminal(&records).await {
            return Err(JobRegistryError::Capacity(format!(
                "任务记录已达到上限 {MAX_RETAINED_JOBS}"
            )));
        }
        let mut active_for_session = 0;
        for record in &records {
            if record.is_active_for_session(&session_id).await {
                active_for_session += 1;
            }
        }
        if active_for_session >= MAX_ACTIVE_JOBS_PER_SESSION {
            return Err(JobRegistryError::Capacity(format!(
                "会话同时最多运行 {MAX_ACTIVE_JOBS_PER_SESSION} 个任务"
            )));
        }

        let record = Arc::new(JobRecord::new(session_id, command_preview, timeout_ms));
        self.jobs
            .write()
            .await
            .insert(record.job_id().await, record.clone());
        Ok(record)
    }

    pub async fn get(&self, job_id: &str) -> Option<Arc<JobRecord>> {
        self.prune_expired().await;
        self.jobs.read().await.get(job_id).cloned()
    }

    pub async fn list(&self) -> Vec<JobSummary> {
        self.prune_expired().await;
        let records = self.jobs.read().await.values().cloned().collect::<Vec<_>>();
        let mut summaries = Vec::with_capacity(records.len());
        for record in records {
            summaries.push(record.summary().await);
        }
        summaries.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        summaries
    }

    pub async fn cancel(&self, job_id: &str) -> Result<JobSnapshot, JobRegistryError> {
        let record = self.get(job_id).await.ok_or(JobRegistryError::NotFound)?;
        if !record.request_cancel().await {
            return Err(JobRegistryError::Conflict("任务已经结束".to_string()));
        }
        Ok(record.snapshot().await)
    }

    pub async fn attach_handle(&self, job_id: &str, handle: JoinHandle<()>) {
        if let Some(record) = self.jobs.read().await.get(job_id).cloned() {
            *record.handle.lock().await = Some(handle);
        } else {
            handle.abort();
        }
    }

    pub async fn cancel_disallowed(&self, allowed_session_ids: &HashSet<String>) {
        let records = self.jobs.read().await.values().cloned().collect::<Vec<_>>();
        for record in records {
            let (session_id, active) = record.authorization_state().await;
            if active && !allowed_session_ids.contains(&session_id) {
                record.request_cancel().await;
            }
        }
    }

    pub async fn shutdown(&self) {
        let records = self.jobs.read().await.values().cloned().collect::<Vec<_>>();
        for record in &records {
            record.request_cancel().await;
        }
        let mut handles = FuturesUnordered::new();
        for record in records {
            if let Some(handle) = record.handle.lock().await.take() {
                handles.push(handle);
            } else {
                record.finish_canceled().await;
            }
        }
        if timeout(JOB_SHUTDOWN_TIMEOUT, async {
            while let Some(result) = handles.next().await {
                if let Err(error) = result {
                    if !error.is_cancelled() {
                        eprintln!("[helm] API job task failed during shutdown: {error}");
                    }
                }
            }
        })
        .await
        .is_err()
        {
            for handle in handles.iter() {
                handle.abort();
            }
            while handles.next().await.is_some() {}
        }
    }

    async fn evict_oldest_terminal(&self, records: &[Arc<JobRecord>]) -> bool {
        let mut candidate: Option<(String, String)> = None;
        for record in records {
            let state = record.state.read().await;
            if !state.snapshot.status.is_terminal() {
                continue;
            }
            let created_at = state.snapshot.created_at.clone();
            let job_id = state.snapshot.job_id.clone();
            if candidate
                .as_ref()
                .is_none_or(|(_, oldest)| created_at < *oldest)
            {
                candidate = Some((job_id, created_at));
            }
        }
        let Some((job_id, _)) = candidate else {
            return false;
        };
        self.jobs.write().await.remove(&job_id).is_some()
    }

    async fn prune_expired(&self) {
        let records = self
            .jobs
            .read()
            .await
            .iter()
            .map(|(id, record)| (id.clone(), record.clone()))
            .collect::<Vec<_>>();
        let mut expired = Vec::new();
        for (id, record) in records {
            let state = record.state.read().await;
            if state
                .completed_at_instant
                .is_some_and(|completed| completed.elapsed() >= COMPLETED_JOB_RETENTION)
            {
                expired.push(id);
            }
        }
        if !expired.is_empty() {
            let mut jobs = self.jobs.write().await;
            for id in expired {
                jobs.remove(&id);
            }
        }
    }
}

impl JobRecord {
    fn new(session_id: String, command_preview: String, timeout_ms: u64) -> Self {
        let job_id = format!("job_{}", Uuid::new_v4().simple());
        let created_at = Utc::now().to_rfc3339();
        let mut snapshot = JobSnapshot {
            job_id,
            session_id,
            command_preview,
            status: JobStatus::Queued,
            timeout_ms,
            created_at: created_at.clone(),
            started_at: None,
            completed_at: None,
            exit_status: None,
            duration_ms: None,
            queue_ms: None,
            connection_ms: None,
            channel_open_ms: None,
            execution_ms: None,
            timed_out: false,
            error: None,
            stdout: String::new(),
            stderr: String::new(),
            stdout_bytes: 0,
            stderr_bytes: 0,
            output_truncated: false,
            last_event_id: 1,
        };
        let initial_data = json!({ "job": JobSummary::from(&snapshot) });
        let initial_event = JobEvent {
            id: 1,
            event: "queued".to_string(),
            timestamp: created_at,
            data: initial_data,
        };
        snapshot.last_event_id = initial_event.id;
        let initial_bytes = estimate_event_bytes(&initial_event, None);
        let (event_tx, _) = broadcast::channel(256);
        let (cancel_tx, _) = watch::channel(false);
        Self {
            state: RwLock::new(JobState {
                snapshot,
                stdout: BoundedTextTail::new(MAX_JOB_OUTPUT_BYTES),
                stderr: BoundedTextTail::new(MAX_JOB_OUTPUT_BYTES),
                events: VecDeque::from([StoredJobEvent {
                    event: initial_event,
                    bytes: initial_bytes,
                }]),
                event_bytes: initial_bytes,
                next_event_id: 2,
                created_at_instant: Instant::now(),
                completed_at_instant: None,
            }),
            event_tx,
            cancel_tx,
            handle: Mutex::new(None),
        }
    }

    pub async fn job_id(&self) -> String {
        self.state.read().await.snapshot.job_id.clone()
    }

    pub fn cancel_receiver(&self) -> watch::Receiver<bool> {
        self.cancel_tx.subscribe()
    }

    pub fn cancel_requested(&self) -> bool {
        *self.cancel_tx.borrow()
    }

    pub async fn snapshot(&self) -> JobSnapshot {
        let state = self.state.read().await;
        snapshot_from_state(&state)
    }

    pub async fn summary(&self) -> JobSummary {
        JobSummary::from(&self.state.read().await.snapshot)
    }

    async fn is_active_for_session(&self, session_id: &str) -> bool {
        let state = self.state.read().await;
        state.snapshot.session_id == session_id && state.snapshot.status.is_active()
    }

    async fn authorization_state(&self) -> (String, bool) {
        let state = self.state.read().await;
        (
            state.snapshot.session_id.clone(),
            state.snapshot.status.is_active(),
        )
    }

    pub async fn subscribe(&self, after_event_id: u64) -> JobSubscription {
        let receiver = self.event_tx.subscribe();
        let state = self.state.read().await;
        JobSubscription {
            initial: state
                .events
                .iter()
                .filter(|stored| stored.event.id > after_event_id)
                .map(|stored| stored.event.clone())
                .collect(),
            receiver,
            terminal: state.snapshot.status.is_terminal(),
        }
    }

    pub async fn snapshot_event(&self) -> (JobEvent, bool) {
        let state = self.state.read().await;
        let terminal = state.snapshot.status.is_terminal();
        (
            JobEvent {
                id: state.snapshot.last_event_id,
                event: "snapshot".to_string(),
                timestamp: Utc::now().to_rfc3339(),
                data: json!({ "job": snapshot_from_state(&state) }),
            },
            terminal,
        )
    }

    pub async fn mark_running(&self) -> bool {
        if self.cancel_requested() {
            self.finish_canceled().await;
            return false;
        }
        let mut state = self.state.write().await;
        if self.cancel_requested() || state.snapshot.status == JobStatus::Canceling {
            drop(state);
            self.finish_canceled().await;
            return false;
        }
        if state.snapshot.status.is_terminal() {
            return false;
        }
        state.snapshot.status = JobStatus::Running;
        if state.snapshot.started_at.is_none() {
            state.snapshot.started_at = Some(Utc::now().to_rfc3339());
        }
        let event = push_event(&mut state, "running", None, None);
        drop(state);
        let _ = self.event_tx.send(event);
        true
    }

    pub async fn mark_connecting(&self) -> bool {
        if self.cancel_requested() {
            self.finish_canceled().await;
            return false;
        }
        let mut state = self.state.write().await;
        if self.cancel_requested() || state.snapshot.status == JobStatus::Canceling {
            drop(state);
            self.finish_canceled().await;
            return false;
        }
        if state.snapshot.status.is_terminal() {
            return false;
        }
        state.snapshot.status = JobStatus::Connecting;
        state.snapshot.started_at = Some(Utc::now().to_rfc3339());
        let event = push_event(&mut state, "connecting", None, None);
        drop(state);
        let _ = self.event_tx.send(event);
        true
    }

    pub async fn set_connection_ms(&self, value: u128) {
        let mut state = self.state.write().await;
        state.snapshot.connection_ms = Some(value.min(u64::MAX as u128) as u64);
    }

    pub async fn set_queue_ms(&self, value: u128) {
        let mut state = self.state.write().await;
        state.snapshot.queue_ms = Some(value.min(u64::MAX as u128) as u64);
    }

    pub async fn append_stdout(&self, text: String) {
        self.append_output("stdout", text).await;
    }

    pub async fn append_stderr(&self, text: String) {
        self.append_output("stderr", text).await;
    }

    async fn append_output(&self, kind: &str, text: String) {
        if text.is_empty() {
            return;
        }
        let text_bytes = text.len();
        let mut state = self.state.write().await;
        if self.cancel_requested() || state.snapshot.status == JobStatus::Canceling {
            drop(state);
            self.finish_canceled().await;
            return;
        }
        if state.snapshot.status.is_terminal() {
            return;
        }
        let truncated = if kind == "stdout" {
            state.snapshot.stdout_bytes = state
                .snapshot
                .stdout_bytes
                .saturating_add(text_bytes as u64);
            state.stdout.push(&text)
        } else {
            state.snapshot.stderr_bytes = state
                .snapshot
                .stderr_bytes
                .saturating_add(text_bytes as u64);
            state.stderr.push(&text)
        };
        state.snapshot.output_truncated |= truncated;
        let event = push_event(
            &mut state,
            kind,
            Some(json!({ "text": text })),
            Some(text_bytes.saturating_add(32)),
        );
        drop(state);
        let _ = self.event_tx.send(event);
    }

    pub async fn finish_result(&self, result: ExecResult) {
        if self.cancel_requested() {
            self.finish_canceled().await;
            return;
        }
        let mut state = self.state.write().await;
        if self.cancel_requested() || state.snapshot.status == JobStatus::Canceling {
            drop(state);
            self.finish_canceled().await;
            return;
        }
        if state.snapshot.status.is_terminal() {
            return;
        }
        state.snapshot.stdout_bytes = result.stdout_bytes;
        state.snapshot.stderr_bytes = result.stderr_bytes;
        state.snapshot.output_truncated |= result.output_truncated;
        state.snapshot.exit_status = result.exit_status;
        state.snapshot.duration_ms = Some(result.duration_ms.min(u64::MAX as u128) as u64);
        state.snapshot.queue_ms = Some(result.queue_ms.min(u64::MAX as u128) as u64);
        state.snapshot.connection_ms = Some(result.connection_ms.min(u64::MAX as u128) as u64);
        state.snapshot.channel_open_ms = Some(result.channel_open_ms.min(u64::MAX as u128) as u64);
        state.snapshot.execution_ms = Some(result.execution_ms.min(u64::MAX as u128) as u64);
        state.snapshot.timed_out = result.timed_out;
        state.snapshot.completed_at = Some(Utc::now().to_rfc3339());
        state.completed_at_instant = Some(Instant::now());
        let (status, event_name) = if result.timed_out {
            (JobStatus::TimedOut, "timedOut")
        } else if result.exit_status == Some(0) {
            (JobStatus::Completed, "completed")
        } else {
            (JobStatus::Failed, "failed")
        };
        state.snapshot.status = status;
        let event = push_event(&mut state, event_name, None, None);
        drop(state);
        let _ = self.event_tx.send(event);
    }

    pub async fn finish_error(&self, error: String) {
        if self.cancel_requested() {
            self.finish_canceled().await;
            return;
        }
        let mut state = self.state.write().await;
        if self.cancel_requested() || state.snapshot.status == JobStatus::Canceling {
            drop(state);
            self.finish_canceled().await;
            return;
        }
        if state.snapshot.status.is_terminal() {
            return;
        }
        state.snapshot.status = JobStatus::Failed;
        state.snapshot.error = Some(error);
        if state.snapshot.duration_ms.is_none() {
            state.snapshot.duration_ms = Some(
                state
                    .created_at_instant
                    .elapsed()
                    .as_millis()
                    .min(u64::MAX as u128) as u64,
            );
        }
        state.snapshot.completed_at = Some(Utc::now().to_rfc3339());
        state.completed_at_instant = Some(Instant::now());
        let event = push_event(&mut state, "failed", None, None);
        drop(state);
        let _ = self.event_tx.send(event);
    }

    pub async fn request_cancel(&self) -> bool {
        let mut state = self.state.write().await;
        if state.snapshot.status.is_terminal() || state.snapshot.status == JobStatus::Canceling {
            return false;
        }
        state.snapshot.status = JobStatus::Canceling;
        let event = push_event(&mut state, "canceling", None, None);
        drop(state);
        self.cancel_tx.send_replace(true);
        let _ = self.event_tx.send(event);
        true
    }

    pub async fn finish_canceled(&self) {
        let mut state = self.state.write().await;
        if state.snapshot.status.is_terminal() {
            return;
        }
        state.snapshot.status = JobStatus::Canceled;
        if state.snapshot.duration_ms.is_none() {
            state.snapshot.duration_ms = Some(
                state
                    .created_at_instant
                    .elapsed()
                    .as_millis()
                    .min(u64::MAX as u128) as u64,
            );
        }
        state.snapshot.completed_at = Some(Utc::now().to_rfc3339());
        state.completed_at_instant = Some(Instant::now());
        let event = push_event(&mut state, "canceled", None, None);
        drop(state);
        let _ = self.event_tx.send(event);
    }
}

fn snapshot_from_state(state: &JobState) -> JobSnapshot {
    let mut snapshot = state.snapshot.clone();
    snapshot.stdout = state.stdout.as_string();
    snapshot.stderr = state.stderr.as_string();
    snapshot
}

fn push_event(
    state: &mut JobState,
    event_name: &str,
    data: Option<Value>,
    data_bytes_hint: Option<usize>,
) -> JobEvent {
    let id = state.next_event_id;
    state.next_event_id = state.next_event_id.saturating_add(1);
    state.snapshot.last_event_id = id;
    let event = JobEvent {
        id,
        event: event_name.to_string(),
        timestamp: Utc::now().to_rfc3339(),
        data: data.unwrap_or_else(|| json!({ "job": JobSummary::from(&state.snapshot) })),
    };
    let bytes = estimate_event_bytes(&event, data_bytes_hint);
    state.event_bytes = state.event_bytes.saturating_add(bytes);
    state.events.push_back(StoredJobEvent {
        event: event.clone(),
        bytes,
    });
    while state.events.len() > MAX_JOB_EVENTS || state.event_bytes > MAX_JOB_EVENT_BYTES {
        let Some(removed) = state.events.pop_front() else {
            break;
        };
        state.event_bytes = state.event_bytes.saturating_sub(removed.bytes);
    }
    event
}

fn estimate_event_bytes(event: &JobEvent, data_bytes_hint: Option<usize>) -> usize {
    event
        .event
        .len()
        .saturating_add(event.timestamp.len())
        .saturating_add(data_bytes_hint.unwrap_or_else(|| {
            serde_json::to_vec(&event.data)
                .map(|value| value.len())
                .unwrap_or_default()
        }))
        .saturating_add(64)
}

struct BoundedTextTail {
    bytes: VecDeque<u8>,
    max_bytes: usize,
}

impl BoundedTextTail {
    fn new(max_bytes: usize) -> Self {
        Self {
            bytes: VecDeque::new(),
            max_bytes: max_bytes.max(1),
        }
    }

    fn push(&mut self, text: &str) -> bool {
        let bytes = text.as_bytes();
        if bytes.len() >= self.max_bytes {
            let mut keep_from = bytes.len() - self.max_bytes;
            while keep_from < bytes.len() && !text.is_char_boundary(keep_from) {
                keep_from += 1;
            }
            self.bytes.clear();
            self.bytes.extend(bytes[keep_from..].iter().copied());
            return true;
        }
        self.bytes.extend(bytes.iter().copied());
        let overflow = self.bytes.len().saturating_sub(self.max_bytes);
        if overflow == 0 {
            return false;
        }
        self.bytes.drain(..overflow);
        while self
            .bytes
            .front()
            .is_some_and(|byte| byte & 0b1100_0000 == 0b1000_0000)
        {
            self.bytes.pop_front();
        }
        true
    }

    fn as_string(&self) -> String {
        let bytes = self.bytes.iter().copied().collect::<Vec<_>>();
        String::from_utf8(bytes)
            .unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        JobRegistry, JobRegistryError, JobStatus, MAX_ACTIVE_JOBS_PER_SESSION, MAX_JOB_EVENT_BYTES,
        MAX_JOB_OUTPUT_BYTES,
    };

    #[tokio::test]
    async fn job_events_are_replayable_and_cancel_transitions_are_explicit() {
        let registry = JobRegistry::default();
        let record = registry
            .create("session-a".to_string(), "echo ok".to_string(), 30_000)
            .await
            .unwrap();
        assert!(record.mark_running().await);
        record.append_stdout("ok\n".to_string()).await;
        let subscription = record.subscribe(1).await;
        assert_eq!(
            subscription
                .initial
                .iter()
                .map(|event| event.event.as_str())
                .collect::<Vec<_>>(),
            ["running", "stdout"]
        );
        assert!(record.request_cancel().await);
        assert_eq!(record.snapshot().await.status, JobStatus::Canceling);
        record.finish_error("命令执行已取消".to_string()).await;
        assert_eq!(record.snapshot().await.status, JobStatus::Canceled);
    }

    #[tokio::test]
    async fn active_jobs_are_limited_per_session() {
        let registry = JobRegistry::default();
        for index in 0..MAX_ACTIVE_JOBS_PER_SESSION {
            registry
                .create("session-a".to_string(), format!("command-{index}"), 30_000)
                .await
                .unwrap();
        }
        assert!(matches!(
            registry
                .create("session-a".to_string(), "overflow".to_string(), 30_000)
                .await,
            Err(JobRegistryError::Capacity(_))
        ));
        assert!(registry
            .create("session-b".to_string(), "allowed".to_string(), 30_000)
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn job_output_and_event_history_are_byte_bounded() {
        let registry = JobRegistry::default();
        let record = registry
            .create("session-a".to_string(), "noisy".to_string(), 30_000)
            .await
            .unwrap();
        assert!(record.mark_running().await);
        for _ in 0..300 {
            record.append_stdout("x".repeat(16 * 1024)).await;
        }
        let snapshot = record.snapshot().await;
        assert!(snapshot.stdout.len() <= MAX_JOB_OUTPUT_BYTES);
        assert!(snapshot.output_truncated);
        let state = record.state.read().await;
        assert!(state.event_bytes <= MAX_JOB_EVENT_BYTES);
    }

    #[tokio::test]
    async fn job_list_uses_summaries_without_output_payloads() {
        let registry = JobRegistry::default();
        let record = registry
            .create("session-a".to_string(), "echo ok".to_string(), 30_000)
            .await
            .unwrap();
        record.append_stdout("large output".repeat(1024)).await;
        let summaries = registry.list().await;
        let serialized = serde_json::to_value(&summaries).unwrap();
        assert!(serialized[0].get("stdout").is_none());
        assert!(serialized[0]["stdoutBytes"].as_u64().unwrap() > 0);
    }

    #[tokio::test]
    async fn shutdown_cancels_and_drains_attached_jobs() {
        let registry = JobRegistry::default();
        let record = registry
            .create("session-a".to_string(), "sleep 30".to_string(), 30_000)
            .await
            .unwrap();
        assert!(record.mark_running().await);
        let job_id = record.job_id().await;
        let task_record = record.clone();
        let mut cancel = record.cancel_receiver();
        let handle = tokio::spawn(async move {
            cancel.wait_for(|requested| *requested).await.unwrap();
            task_record.finish_error("命令执行已取消".to_string()).await;
        });
        registry.attach_handle(&job_id, handle).await;

        registry.shutdown().await;

        assert_eq!(record.snapshot().await.status, JobStatus::Canceled);
    }

    #[tokio::test]
    async fn shutdown_finishes_a_queued_job_before_its_handle_is_attached() {
        let registry = JobRegistry::default();
        let record = registry
            .create("session-a".to_string(), "echo queued".to_string(), 30_000)
            .await
            .unwrap();

        registry.shutdown().await;

        assert_eq!(record.snapshot().await.status, JobStatus::Canceled);
    }
}
