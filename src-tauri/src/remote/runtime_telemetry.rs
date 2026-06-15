use super::*;

use tokio::{io::AsyncWriteExt, sync::mpsc, task::JoinHandle};

const TELEMETRY_FRAME_CHANNEL_CAPACITY: usize = 4;
const TELEMETRY_STREAM_INIT_TIMEOUT_MS: u64 = 5_000;

/// One frame produced by the long-lived telemetry shell loop.
struct TelemetryFrame {
    tag: String,
    body: String,
}

/// Long-lived telemetry channel: one SSH `exec` channel running a shell loop
/// that reads tags from stdin and writes framed snapshots to stdout. Replaces
/// the old "open a fresh exec channel every tick" approach.
struct TelemetryStream {
    writer: ChannelWriteHalf<client::Msg>,
    rx: mpsc::Receiver<TelemetryFrame>,
    reader: JoinHandle<()>,
    closed: bool,
}

impl TelemetryStream {
    /// Open a fresh exec channel on `handle` and start the remote loop.
    async fn open(handle: &SshHandle) -> AppResult<Self> {
        let channel = open_session_channel(handle).await?;
        let (mut read_half, write_half) = channel.split();
        write_half
            .exec(true, TELEMETRY_LOOP_COMMAND)
            .await
            .map_err(remote_error)?;

        let (tx, rx) = mpsc::channel::<TelemetryFrame>(TELEMETRY_FRAME_CHANNEL_CAPACITY);
        let reader = tokio::spawn(async move {
            let mut buf: Vec<u8> = Vec::new();
            while let Some(message) = read_half.wait().await {
                match message {
                    ChannelMsg::Data { data } => {
                        buf.extend_from_slice(&data);
                        // Drain as many complete frames as the buffer currently holds.
                        loop {
                            let Some(boundary) = find_frame_boundary(&buf) else {
                                break;
                            };
                            let body =
                                String::from_utf8_lossy(&buf[..boundary.body_end]).into_owned();
                            let tag = boundary.tag;
                            let frame_end = boundary.frame_end;
                            buf.drain(..frame_end);
                            if tx.send(TelemetryFrame { tag, body }).await.is_err() {
                                return;
                            }
                        }
                    }
                    ChannelMsg::ExtendedData { .. } => {
                        // stderr from the remote loop is not parsed; drop silently.
                    }
                    ChannelMsg::Eof
                    | ChannelMsg::ExitStatus { .. }
                    | ChannelMsg::ExitSignal { .. } => break,
                    _ => {}
                }
            }
            // Reader task ends when the channel is closed by either side; the
            // mpsc receiver will observe `None` once `tx` drops here.
        });

        Ok(Self {
            writer: write_half,
            rx,
            reader,
            closed: false,
        })
    }

    /// Send a tag and await its matching frame. Sequential by design — the
    /// caller never overlaps samples, so capacity 4 is generous.
    async fn sample(&mut self, tag: &str, timeout_ms: u64) -> AppResult<String> {
        if self.closed {
            return Err(AppError::Remote("遥测通道已关闭".to_string()));
        }
        // Discard any stale frames from a prior failed/timed-out sample so we
        // never confuse them for the current one.
        while self.rx.try_recv().is_ok() {}

        let mut writer = self.writer.make_writer();
        let cmd = format!("{tag}\n");
        if let Err(error) = writer.write_all(cmd.as_bytes()).await {
            self.closed = true;
            return Err(remote_error(error));
        }
        if let Err(error) = writer.flush().await {
            self.closed = true;
            return Err(remote_error(error));
        }

        let timeout_dur = Duration::from_millis(timeout_ms.max(500));
        match timeout(timeout_dur, self.rx.recv()).await {
            Ok(Some(frame)) if frame.tag == tag => Ok(frame.body),
            Ok(Some(other)) => Err(AppError::Remote(format!(
                "遥测帧标签错位：期望 {tag}，收到 {}",
                other.tag
            ))),
            Ok(None) => {
                self.closed = true;
                Err(AppError::Remote("遥测通道已关闭".to_string()))
            }
            Err(_) => Err(AppError::Remote(format!("遥测采样超时（{tag}）"))),
        }
    }
}

impl Drop for TelemetryStream {
    fn drop(&mut self) {
        let mut writer = self.writer.make_writer();
        tokio::spawn(async move {
            if let Err(error) = writer.write_all(b"quit\n").await {
                log::debug!("failed to signal telemetry stream shutdown: {error}");
                return;
            }
            if let Err(error) = writer.flush().await {
                log::debug!("failed to flush telemetry stream shutdown signal: {error}");
            }
        });
        self.reader.abort();
    }
}

struct FrameBoundary {
    /// End of body bytes (exclusive). May include a trailing newline.
    body_end: usize,
    /// End of the whole frame including the sentinel line newline (exclusive).
    frame_end: usize,
    tag: String,
}

/// Locate the first `__HELM_TM_END__:<tag>\n` line in `buf`. Returns body
/// end / frame end offsets and the parsed tag, or `None` if not yet present.
fn find_frame_boundary(buf: &[u8]) -> Option<FrameBoundary> {
    let sentinel = TELEMETRY_FRAME_SENTINEL.as_bytes();
    let mut search_from = 0;
    while let Some(rel) = memchr_subslice(&buf[search_from..], sentinel) {
        let abs = search_from + rel;
        // Sentinel must start at the beginning of a line.
        if abs > 0 && buf[abs - 1] != b'\n' {
            search_from = abs + sentinel.len();
            continue;
        }
        // Find the newline that terminates the sentinel line.
        let tag_start = abs + sentinel.len();
        let nl_rel = buf[tag_start..].iter().position(|&b| b == b'\n')?;
        let tag_end_absolute = tag_start + nl_rel;
        let tag_bytes = &buf[tag_start..tag_end_absolute];
        // Strip trailing CR if any (tolerate CRLF).
        let tag_bytes = match tag_bytes.last() {
            Some(b'\r') => &tag_bytes[..tag_bytes.len() - 1],
            _ => tag_bytes,
        };
        let tag = String::from_utf8_lossy(tag_bytes).trim().to_string();
        return Some(FrameBoundary {
            body_end: abs,
            frame_end: tag_end_absolute + 1,
            tag,
        });
    }
    None
}

fn memchr_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

impl RemoteRuntime {
    pub async fn telemetry_snapshot(&self, connection_id: &str) -> AppResult<ServerTelemetry> {
        let connection = self.connection(connection_id).await?;
        let fallback_ip = connection.info.host;
        let mut snapshot = empty_telemetry(&fallback_ip, 0);
        let base = self
            .telemetry_sample(
                connection_id,
                TELEMETRY_BASE_COMMAND,
                TELEMETRY_FAST_TIMEOUT_MS,
                &fallback_ip,
            )
            .await?;
        let mut last_network: Option<(Vec<NetworkBytes>, Instant)> = None;
        merge_telemetry(&mut snapshot, base, true, &mut last_network);

        for (command, timeout_ms) in [
            (TELEMETRY_PROCESS_COMMAND, TELEMETRY_FAST_TIMEOUT_MS),
            (TELEMETRY_DISK_COMMAND, TELEMETRY_FAST_TIMEOUT_MS),
            (TELEMETRY_IP_COMMAND, TELEMETRY_SLOW_TIMEOUT_MS),
        ] {
            if let Ok(sample) = self
                .telemetry_sample(connection_id, command, timeout_ms, &fallback_ip)
                .await
            {
                merge_telemetry(&mut snapshot, sample, false, &mut last_network);
            }
        }

        Ok(snapshot)
    }

    pub(super) async fn telemetry_sample(
        &self,
        connection_id: &str,
        command: &str,
        timeout_ms: u64,
        fallback_ip: &str,
    ) -> AppResult<ParsedTelemetry> {
        let started = Instant::now();
        let result = self
            .exec_on_connection(connection_id, command.to_string(), Some(timeout_ms))
            .await?;
        Ok(parse_telemetry_body(
            &result.stdout,
            fallback_ip,
            started.elapsed().as_millis(),
        ))
    }

    pub async fn telemetry_start(
        &self,
        app: &AppHandle,
        connection_id: String,
        session_id: String,
        interval_ms: u64,
    ) -> AppResult<TelemetryJobInfo> {
        self.telemetry_stop_by_session(&session_id).await;
        let info = TelemetryJobInfo {
            job_id: Uuid::new_v4().to_string(),
            session_id,
            interval_ms: interval_ms.max(1_000),
            status: TaskStatus::Running,
            started_at: now(),
        };
        let app_handle = app.clone();
        let job_info = info.clone();
        let connection_record = self.connection(&connection_id).await?;
        let fallback_ip = connection_record.info.host.clone();
        let ssh_handle = connection_record.handle.clone();
        let telemetry_jobs_ref = self.telemetry_jobs.clone();

        let handle = tokio::spawn(async move {
            // Open the long-lived telemetry stream once. If this fails the job
            // emits a single error and exits — the user can restart telemetry.
            let mut stream = match timeout(
                Duration::from_millis(TELEMETRY_STREAM_INIT_TIMEOUT_MS),
                TelemetryStream::open(&ssh_handle),
            )
            .await
            {
                Ok(Ok(stream)) => stream,
                Ok(Err(error)) => {
                    emit_telemetry_error(&app_handle, &job_info, error.to_string());
                    telemetry_jobs_ref.write().await.remove(&job_info.job_id);
                    return;
                }
                Err(_) => {
                    emit_telemetry_error(&app_handle, &job_info, "遥测通道初始化超时".to_string());
                    telemetry_jobs_ref.write().await.remove(&job_info.job_id);
                    return;
                }
            };

            let mut snapshot = empty_telemetry(&fallback_ip, 0);
            let mut last_network: Option<(Vec<NetworkBytes>, Instant)> = None;
            let mut base_interval =
                tokio::time::interval(Duration::from_millis(job_info.interval_ms));
            let mut process_interval = tokio::time::interval(Duration::from_millis(
                (job_info.interval_ms * 3).max(TELEMETRY_PROCESS_MIN_INTERVAL_MS),
            ));
            let mut disk_interval = tokio::time::interval(Duration::from_millis(
                (job_info.interval_ms * 12).max(TELEMETRY_DISK_MIN_INTERVAL_MS),
            ));
            let mut ip_interval = tokio::time::interval(Duration::from_millis(
                (job_info.interval_ms * 120).max(TELEMETRY_IP_MIN_INTERVAL_MS),
            ));
            base_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
            process_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
            disk_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
            ip_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

            // Track consecutive failures so a remote that hangs (sshd alive but the
            // shell loop frozen, or repeated network blips) doesn't spam endless
            // error events forever. After this threshold we self-stop and let the
            // user / a session reconnect restart telemetry.
            const MAX_CONSECUTIVE_FAILURES: u32 = 5;
            let mut consecutive_failures: u32 = 0;

            loop {
                let (tag, timeout_ms, update_latency) = tokio::select! {
                    _ = base_interval.tick() => ("base", TELEMETRY_FAST_TIMEOUT_MS, true),
                    _ = process_interval.tick() => ("process", TELEMETRY_FAST_TIMEOUT_MS, false),
                    _ = disk_interval.tick() => ("disk", TELEMETRY_FAST_TIMEOUT_MS, false),
                    _ = ip_interval.tick() => ("ip", TELEMETRY_SLOW_TIMEOUT_MS, false),
                };

                let started = Instant::now();
                match stream.sample(tag, timeout_ms).await {
                    Ok(body) => {
                        consecutive_failures = 0;
                        let sample = parse_telemetry_body(
                            &body,
                            &fallback_ip,
                            started.elapsed().as_millis(),
                        );
                        merge_telemetry(&mut snapshot, sample, update_latency, &mut last_network);
                        emit_telemetry_snapshot(&app_handle, &job_info, snapshot.clone());
                    }
                    Err(error) => {
                        consecutive_failures = consecutive_failures.saturating_add(1);
                        emit_telemetry_error(&app_handle, &job_info, error.to_string());
                        // Stop on either: (a) the underlying channel is unrecoverable, or
                        // (b) we've hit the consecutive-failure ceiling. Continuing past
                        // (b) just produces a flood of error events without any chance of
                        // recovery on this stream.
                        if stream.closed || consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                            if !stream.closed {
                                emit_telemetry_error(
                                    &app_handle,
                                    &job_info,
                                    format!(
                                        "遥测连续 {} 次采样失败，已自动停止",
                                        consecutive_failures
                                    ),
                                );
                            }
                            telemetry_jobs_ref.write().await.remove(&job_info.job_id);
                            return;
                        }
                    }
                }
            }
        });
        self.telemetry_jobs.write().await.insert(
            info.job_id.clone(),
            TelemetryJobRecord {
                info: info.clone(),
                handle,
            },
        );
        Ok(info)
    }

    pub async fn telemetry_stop(&self, job_id: &str) -> AppResult<()> {
        let record = self
            .telemetry_jobs
            .write()
            .await
            .remove(job_id)
            .ok_or_else(|| AppError::missing_telemetry_job(job_id))?;
        record.handle.abort();
        Ok(())
    }
    pub(super) async fn telemetry_stop_by_session(&self, session_id: &str) -> usize {
        let job_ids: Vec<String> = self
            .telemetry_jobs
            .read()
            .await
            .iter()
            .filter(|(_, record)| record.info.session_id == session_id)
            .map(|(id, _)| id.clone())
            .collect();
        let mut jobs = self.telemetry_jobs.write().await;
        let mut stopped = 0usize;
        for id in job_ids {
            if let Some(record) = jobs.remove(&id) {
                record.handle.abort();
                stopped += 1;
            }
        }
        stopped
    }
    pub(super) async fn cancel_telemetry_for_session(
        &self,
        app: &AppHandle,
        session_id: &str,
        reason: &str,
    ) {
        let job_ids: Vec<String> = self
            .telemetry_jobs
            .read()
            .await
            .iter()
            .filter(|(_, record)| record.info.session_id == session_id)
            .map(|(id, _)| id.clone())
            .collect();
        let mut jobs = self.telemetry_jobs.write().await;
        for id in job_ids {
            if let Some(record) = jobs.remove(&id) {
                cancel_telemetry_record(app, record, reason);
            }
        }
    }
}

/// Parse a telemetry body string (output of one tagged collector) into a
/// `ParsedTelemetry`. Shared by the long-lived stream path and the legacy
/// per-tick exec path used by `telemetry_snapshot`.
pub(super) fn parse_telemetry_body(
    body: &str,
    fallback_ip: &str,
    latency_ms: u128,
) -> ParsedTelemetry {
    let snapshot = parse_linux_telemetry(body, fallback_ip, latency_ms);
    let network_bytes = parse_network_bytes(body);
    ParsedTelemetry {
        output: body.to_string(),
        snapshot,
        network_bytes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_complete_frame_boundary() {
        let buf = b"UPTIME 100\nMEM 1024 512\n__HELM_TM_END__:base\nleftover";
        let boundary = find_frame_boundary(buf).expect("frame found");
        assert_eq!(boundary.tag, "base");
        let body = std::str::from_utf8(&buf[..boundary.body_end]).unwrap();
        assert!(body.contains("UPTIME 100"));
        assert!(!body.contains("__HELM_TM_END__"));
        assert_eq!(&buf[boundary.frame_end..], b"leftover");
    }

    #[test]
    fn ignores_partial_frame_without_newline() {
        let buf = b"UPTIME 100\n__HELM_TM_END__:base"; // no trailing \n yet
        assert!(find_frame_boundary(buf).is_none());
    }

    #[test]
    fn ignores_sentinel_not_at_line_start() {
        let buf = b"prefix__HELM_TM_END__:base\n";
        assert!(find_frame_boundary(buf).is_none());
    }

    #[test]
    fn tolerates_crlf_in_sentinel_line() {
        let buf = b"DATA\n__HELM_TM_END__:disk\r\n";
        let boundary = find_frame_boundary(buf).expect("frame found");
        assert_eq!(boundary.tag, "disk");
    }
}
