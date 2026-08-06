use std::{
    collections::VecDeque,
    future::{self, Future},
    io::{self, SeekFrom},
    pin::Pin,
    sync::Arc,
    task::{ready, Context, Poll},
};
use tokio::{
    io::{AsyncRead, AsyncSeek, AsyncWrite, ReadBuf},
    runtime::Handle,
    sync::oneshot,
};

use super::Metadata;
use crate::{
    client::{error::Error, rawsession::SftpResult, session::Features, RawSftpSession},
    protocol::{Packet, StatusCode},
};

type StateFn<T> = Option<Pin<Box<dyn Future<Output = io::Result<T>> + Send + Sync + 'static>>>;

// read packet overhead: type(1) + id(4) + data_len(4)
const READ_OVERHEAD_LENGTH: u32 = 9;
// write packet overhead excluding handle: type(1) + id(4) + handle_len(4) + offset(8) + data_len(4)
const WRITE_OVERHEAD_LENGTH: u32 = 21;
// Initial in-flight READ depth before adaptive growth kicks in. Matches the
// historical fixed default so single-shot small reads pay no extra round-trips.
const INITIAL_READ_CONCURRENCY: usize = 8;

/// One in-flight READ request: keeps the response receiver alongside the
/// (offset, len) we asked for so the [`File`] state machine can detect short
/// reads and re-issue the missing tail at the front of the queue.
struct ReadInflight {
    rx: oneshot::Receiver<SftpResult<Packet>>,
    offset: u64,
    len: u32,
}

struct FileState {
    f_seek: StateFn<u64>,
    f_flush: StateFn<()>,
    f_shutdown: StateFn<()>,
    write_acks: VecDeque<oneshot::Receiver<SftpResult<Packet>>>,
    /// FIFO of in-flight READ requests sent at consecutive offsets.
    /// Mirrors the role of [`Self::write_acks`] for the write path.
    read_inflight: VecDeque<ReadInflight>,
    /// Bytes that arrived from a completed READ but did not fit in the most
    /// recent [`ReadBuf`]; drained by subsequent [`AsyncRead::poll_read`] calls
    /// before any newer data is consumed.
    read_buffered: Option<Vec<u8>>,
    /// Offset of the next byte to *request* from the server. Equals
    /// `pos + buffered.len() + sum(inflight.len)` outside of a short-read fix-up.
    read_offset_next: u64,
    /// Set once the server returns SSH_FX_EOF. Stops further pipelining and
    /// makes [`AsyncRead::poll_read`] report EOF.
    read_eof: bool,
    /// Optional exclusive end offset for pipelined READ requests. This keeps
    /// ranged/parallel downloads from prefetching beyond their assigned span.
    read_limit_end: Option<u64>,
    /// Adaptive in-flight depth: starts low and grows by 1 per completed READ
    /// response, capped at [`Features::max_concurrent_reads`]. Avoids blasting
    /// the SSH window with the full cap before TCP cwnd has expanded.
    read_concurrent_target: usize,
}

/// Provides high-level methods for interaction with a remote file.
///
/// In order to properly close the handle, [`shutdown`] on a file should be called.
/// Also implement [`AsyncSeek`] and other async i/o implementations.
///
/// # Weakness
/// Using [`SeekFrom::End`] is costly and time-consuming because we need to
/// request the actual file size from the remote server.
pub struct File {
    session: Arc<RawSftpSession>,
    handle: String,
    state: FileState,
    pos: u64,
    closed: bool,
    features: Features,
}

impl File {
    pub(crate) fn new(session: Arc<RawSftpSession>, handle: String, features: Features) -> Self {
        Self {
            session,
            handle,
            state: FileState {
                f_seek: None,
                f_flush: None,
                f_shutdown: None,
                write_acks: VecDeque::with_capacity(features.max_concurrent_writes),
                read_inflight: VecDeque::with_capacity(features.max_concurrent_reads),
                read_buffered: None,
                read_offset_next: 0,
                read_eof: false,
                read_limit_end: None,
                read_concurrent_target: INITIAL_READ_CONCURRENCY
                    .min(features.max_concurrent_reads.max(1)),
            },
            pos: 0,
            closed: false,
            features,
        }
    }

    /// Queries metadata about the remote file.
    pub async fn metadata(&self) -> SftpResult<Metadata> {
        Ok(self.session.fstat(self.handle.as_str()).await?.attrs)
    }

    /// Sets metadata for a remote file.
    pub async fn set_metadata(&self, metadata: Metadata) -> SftpResult<()> {
        self.session
            .fsetstat(self.handle.as_str(), metadata)
            .await
            .map(|_| ())
    }

    /// Attempts to sync all data.
    ///
    /// If the server does not support `fsync@openssh.com` sending the request will
    /// be omitted, but will still pseudo-successfully
    pub async fn sync_all(&self) -> SftpResult<()> {
        if !self.features.fsync {
            return Ok(());
        }

        self.session.fsync(self.handle.as_str()).await.map(|_| ())
    }

    /// Limits future reads to at most `len` bytes from the current position.
    ///
    /// Call this before the first read (and after any seek). The read pipeline
    /// will not issue requests beyond the exclusive end offset.
    pub fn set_read_limit(&mut self, len: u64) -> io::Result<()> {
        if !self.state.read_inflight.is_empty() || self.state.read_buffered.is_some() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "read limit must be set before reading",
            ));
        }
        self.state.read_limit_end = Some(self.pos.saturating_add(len));
        self.state.read_offset_next = self.pos;
        self.state.read_eof = len == 0;
        Ok(())
    }

    // ─── read pipelining helpers ──────────────────────────────────────────────

    /// Maximum payload size for a single READ request, derived from the
    /// negotiated SFTP packet/limits extensions.
    fn max_read_payload(&self) -> u32 {
        self.features
            .limits
            .and_then(|l| l.read_len)
            .unwrap_or_else(|| {
                self.features
                    .max_packet_len
                    .saturating_sub(READ_OVERHEAD_LENGTH) as u64
            }) as u32
    }

    /// Send a READ packet and queue its receiver. `push_front` is used to
    /// repair short reads (the missing tail must be served before any newer
    /// pipelined chunks).
    fn issue_read(&mut self, offset: u64, len: u32, push_front: bool) -> bool {
        match self.session.read_nowait(self.handle.clone(), offset, len) {
            Ok(rx) => {
                let entry = ReadInflight { rx, offset, len };
                if push_front {
                    self.state.read_inflight.push_front(entry);
                } else {
                    self.state.read_inflight.push_back(entry);
                }
                true
            }
            Err(_) => false,
        }
    }

    /// Top up the in-flight READ queue to the current adaptive target. Returns
    /// an error only when the queue is empty *and* a fresh send fails (i.e. we
    /// truly cannot make progress).
    fn try_fill_read_inflight(&mut self) -> io::Result<()> {
        if self.state.read_eof {
            return Ok(());
        }
        let max_len = self.max_read_payload();
        if max_len == 0 {
            return Ok(());
        }
        let cap = self.features.max_concurrent_reads.max(1);
        let limit = self.state.read_concurrent_target.clamp(1, cap);
        while self.state.read_inflight.len() < limit {
            let offset = self.state.read_offset_next;
            let request_len = match self.state.read_limit_end {
                Some(end) => {
                    let remaining = end.saturating_sub(offset);
                    if remaining == 0 {
                        break;
                    }
                    max_len.min(remaining.min(u32::MAX as u64) as u32)
                }
                None => max_len,
            };
            if !self.issue_read(offset, request_len, false) {
                if self.state.read_inflight.is_empty() {
                    return Err(io::Error::other(
                        "failed to issue read request (session closed?)",
                    ));
                }
                return Ok(());
            }
            self.state.read_offset_next += request_len as u64;
        }
        Ok(())
    }
}

fn check_write_result(
    result: Result<SftpResult<Packet>, oneshot::error::RecvError>,
) -> io::Result<()> {
    match result {
        Err(_) => Err(io::Error::new(
            io::ErrorKind::BrokenPipe,
            "write channel closed",
        )),
        Ok(Ok(Packet::Status(s))) if s.status_code == StatusCode::Ok => Ok(()),
        Ok(Ok(Packet::Status(s))) => Err(io::Error::other(s.error_message)),
        Ok(Ok(_)) => Err(io::Error::other("unexpected response packet")),
        Ok(Err(e)) => Err(io::Error::other(e.to_string())),
    }
}

fn poll_oldest_write(
    pending: &mut VecDeque<oneshot::Receiver<SftpResult<Packet>>>,
    cx: &mut Context<'_>,
) -> Option<Poll<io::Result<()>>> {
    let rx = pending.front_mut()?;
    Some(match Pin::new(rx).poll(cx) {
        Poll::Pending => Poll::Pending,
        Poll::Ready(r) => {
            pending.pop_front();
            Poll::Ready(check_write_result(r))
        }
    })
}

fn poll_drain_writes(
    pending: &mut VecDeque<oneshot::Receiver<SftpResult<Packet>>>,
    cx: &mut Context<'_>,
) -> Poll<io::Result<()>> {
    while let Some(poll) = poll_oldest_write(pending, cx) {
        ready!(poll)?;
    }
    Poll::Ready(Ok(()))
}

impl Drop for File {
    fn drop(&mut self) {
        if self.closed {
            return;
        }

        if let Ok(handle) = Handle::try_current() {
            let session = self.session.clone();
            let file_handle = self.handle.clone();

            handle.spawn(async move {
                let _ = session.close(file_handle).await;
            });
        }
    }
}

impl AsyncRead for File {
    /// Pipelined read: keeps up to `max_concurrent_reads` READ requests in
    /// flight at all times so the SSH channel stays full on high-RTT links.
    /// Mirror of the existing pipelined write path (`write_nowait` /
    /// `write_acks`). Setting `max_concurrent_reads = 1` reproduces the legacy
    /// strictly-serial behaviour.
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        // Refill the in-flight queue eagerly so subsequent polls can overlap
        // network round-trips with caller-side processing.
        if let Err(e) = self.try_fill_read_inflight() {
            return Poll::Ready(Err(e));
        }

        loop {
            // 1) Drain any data left over from a previous READ response first.
            if self.state.read_buffered.is_some() {
                // Take the buffer out so we can freely touch &mut self below.
                let mut buffered = self.state.read_buffered.take().unwrap();
                let n = std::cmp::min(buf.remaining(), buffered.len());
                if n > 0 {
                    buf.put_slice(&buffered[..n]);
                    self.pos += n as u64;
                    if n < buffered.len() {
                        buffered.drain(..n);
                        self.state.read_buffered = Some(buffered);
                    }
                    // else: fully consumed, leave None.
                } else {
                    // buf was zero-remaining: keep buffered untouched.
                    self.state.read_buffered = Some(buffered);
                }
                // Top up the in-flight queue to mask the next round-trip.
                let _ = self.try_fill_read_inflight();
                return Poll::Ready(Ok(()));
            }

            // 2) Buffer empty: need a fresh response from the in-flight head.
            if self.state.read_inflight.is_empty() {
                // Either EOF reached, or upstream send failure already bubbled
                // up via try_fill_read_inflight. Treat as EOF for AsyncRead.
                return Poll::Ready(Ok(()));
            }

            // 3) Poll the oldest in-flight READ. Borrow only `rx` to keep the
            //    mutable borrow scoped to this expression.
            let head_poll = {
                let head = self
                    .state
                    .read_inflight
                    .front_mut()
                    .expect("read_inflight non-empty checked above");
                Pin::new(&mut head.rx).poll(cx)
            };

            match head_poll {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Err(_)) => {
                    // oneshot Sender dropped (session shut down).
                    self.state.read_inflight.clear();
                    return Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        "read channel closed",
                    )));
                }
                Poll::Ready(Ok(Err(e))) => {
                    let is_eof = matches!(&e, Error::Status(s) if s.status_code == StatusCode::Eof);
                    self.state.read_inflight.clear();
                    if is_eof {
                        self.state.read_eof = true;
                        return Poll::Ready(Ok(()));
                    }
                    return Poll::Ready(Err(io::Error::other(e.to_string())));
                }
                Poll::Ready(Ok(Ok(packet))) => {
                    let head_info = self
                        .state
                        .read_inflight
                        .pop_front()
                        .expect("read_inflight non-empty checked above");
                    match packet {
                        Packet::Data(d) => {
                            let got = d.data.len();
                            let want = head_info.len as usize;
                            if got == 0 {
                                // Zero-byte Data is unusual; treat like EOF to
                                // avoid an infinite reissue loop.
                                self.state.read_inflight.clear();
                                self.state.read_eof = true;
                                return Poll::Ready(Ok(()));
                            }
                            if got < want {
                                // Short read: queue the missing tail at the
                                // front so it is served before subsequent
                                // pipelined chunks.
                                let missing_offset = head_info.offset + got as u64;
                                let missing_len = (want - got) as u32;
                                if !self.issue_read(missing_offset, missing_len, true) {
                                    self.state.read_inflight.clear();
                                    return Poll::Ready(Err(io::Error::other(
                                        "short read; failed to reissue missing tail",
                                    )));
                                }
                            }
                            // Adaptive growth: each successful response bumps
                            // the in-flight target by one, capped at the
                            // configured maximum. We tested ×2 (slow-start
                            // style) but it lost to linear +1 in practice
                            // because HelM's parallel-file-handle download
                            // multiplies the per-handle burst, overwhelming
                            // the SSH window credit / mpsc backpressure.
                            // Linear ramp lets the SSH channel grow window
                            // smoothly while still saturating BDP.
                            let cap = self.features.max_concurrent_reads.max(1);
                            if self.state.read_concurrent_target < cap {
                                self.state.read_concurrent_target += 1;
                            }
                            self.state.read_buffered = Some(d.data);
                            // Loop back to step 1 to copy into the caller buffer.
                        }
                        Packet::Status(s) if s.status_code == StatusCode::Eof => {
                            self.state.read_inflight.clear();
                            self.state.read_eof = true;
                            return Poll::Ready(Ok(()));
                        }
                        Packet::Status(s) => {
                            self.state.read_inflight.clear();
                            return Poll::Ready(Err(io::Error::other(s.error_message)));
                        }
                        _ => {
                            self.state.read_inflight.clear();
                            return Poll::Ready(Err(io::Error::other(
                                "unexpected response packet for READ",
                            )));
                        }
                    }
                }
            }
        }
    }
}

impl AsyncSeek for File {
    fn start_seek(mut self: Pin<&mut Self>, position: io::SeekFrom) -> io::Result<()> {
        if self.state.f_seek.is_some() {
            return Err(io::Error::other(
                "other file operation is pending, call poll_complete before start_seek",
            ));
        }

        self.state.f_seek = Some(match position {
            SeekFrom::Start(pos) => Box::pin(future::ready(Ok(pos))),
            SeekFrom::Current(pos) => {
                let new_pos = self.pos as i64 + pos;
                if new_pos < 0 {
                    return Err(io::Error::other(
                        "cannot move file pointer before the beginning",
                    ));
                }
                Box::pin(future::ready(Ok(new_pos as u64)))
            }
            SeekFrom::End(pos) => {
                let session = self.session.clone();
                let file_handle = self.handle.clone();

                Box::pin(async move {
                    let result = session
                        .fstat(file_handle)
                        .await
                        .map_err(|e| io::Error::other(e.to_string()))?;
                    match result.attrs.size {
                        Some(size) => {
                            let new_pos = size as i64 + pos;
                            if new_pos < 0 {
                                return Err(io::Error::other(
                                    "cannot move file pointer before the beginning",
                                ));
                            }
                            Ok(new_pos as u64)
                        }
                        None => Err(io::Error::other("file size unknown")),
                    }
                })
            }
        });

        Ok(())
    }

    fn poll_complete(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<u64>> {
        match self.state.f_seek.as_mut() {
            None => Poll::Ready(Ok(self.pos)),
            Some(f) => {
                self.pos = ready!(Pin::new(f).poll(cx))?;
                self.state.f_seek = None;
                // Discard any buffered/in-flight reads since they reference the
                // pre-seek position. Subsequent poll_read calls will refill the
                // pipeline at the new offset.
                self.state.read_inflight.clear();
                self.state.read_buffered = None;
                self.state.read_offset_next = self.pos;
                self.state.read_eof = false;
                self.state.read_limit_end = None;
                self.state.read_concurrent_target =
                    INITIAL_READ_CONCURRENCY.min(self.features.max_concurrent_reads.max(1));
                Poll::Ready(Ok(self.pos))
            }
        }
    }
}

impl AsyncWrite for File {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<Result<usize, io::Error>> {
        if self.state.write_acks.len() >= self.features.max_concurrent_writes {
            if let Some(poll) = poll_oldest_write(&mut self.state.write_acks, cx) {
                ready!(poll)?;
            }
        }

        let max_write_len = self
            .features
            .limits
            .and_then(|l| l.write_len)
            .unwrap_or_else(|| {
                let overhead = WRITE_OVERHEAD_LENGTH + self.handle.len() as u32;
                self.features.max_packet_len.saturating_sub(overhead) as u64
            }) as usize;

        let len = usize::min(buf.len(), max_write_len);
        let data = buf[..len].to_vec();
        let handle = self.handle.clone();
        let offset = self.pos;

        match self.session.write_nowait(handle, offset, data) {
            Ok(rx) => {
                self.pos += len as u64;
                self.state.write_acks.push_back(rx);
                Poll::Ready(Ok(len))
            }
            Err(e) => Poll::Ready(Err(io::Error::other(e.to_string()))),
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), io::Error>> {
        ready!(poll_drain_writes(&mut self.state.write_acks, cx))?;

        if !self.features.fsync {
            return Poll::Ready(Ok(()));
        }

        let poll = Pin::new(match self.state.f_flush.as_mut() {
            Some(f) => f,
            None => {
                let session = self.session.clone();
                let file_handle = self.handle.clone();

                self.state.f_flush.get_or_insert(Box::pin(async move {
                    session
                        .fsync(file_handle)
                        .await
                        .map(|_| ())
                        .map_err(|e| io::Error::other(e.to_string()))
                }))
            }
        })
        .poll(cx);

        if poll.is_ready() {
            self.state.f_flush = None;
        }

        poll
    }

    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Result<(), io::Error>> {
        ready!(poll_drain_writes(&mut self.state.write_acks, cx))?;

        let poll = Pin::new(match self.state.f_shutdown.as_mut() {
            Some(f) => f,
            None => {
                let session = self.session.clone();
                let file_handle = self.handle.clone();

                self.state.f_shutdown.get_or_insert(Box::pin(async move {
                    session
                        .close(file_handle)
                        .await
                        .map_err(|e| io::Error::other(e.to_string()))?;
                    Ok(())
                }))
            }
        })
        .poll(cx);

        if poll.is_ready() {
            self.state.f_shutdown = None;
            self.closed = true;
        }

        poll
    }
}
