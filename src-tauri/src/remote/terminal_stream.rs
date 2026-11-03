use super::*;
use tauri::ipc::{Channel as IpcChannel, Response};

// One ordered binary channel per terminal. Header: 0=stdout, 1=stderr,
// 2=system UTF-8, 3=closed; the remaining bytes are passed through unchanged.
pub(super) const TERMINAL_IN_FLIGHT_BYTES: usize = 1024 * 1024;
pub(super) const TERMINAL_FRAME_BYTES: usize = 64 * 1024;

pub(super) struct TerminalFlowControl {
    slots: Arc<Semaphore>,
    sent: AtomicU64,
    acknowledged: AtomicU64,
    pub urgent: AtomicBool,
}

impl Default for TerminalFlowControl {
    fn default() -> Self {
        Self {
            slots: Arc::new(Semaphore::new(TERMINAL_IN_FLIGHT_BYTES)),
            sent: AtomicU64::new(0),
            acknowledged: AtomicU64::new(0),
            urgent: AtomicBool::new(true),
        }
    }
}

impl TerminalFlowControl {
    pub fn acknowledge(&self, consumed: u64) -> AppResult<()> {
        if consumed > self.sent.load(Ordering::Acquire) {
            return Err(AppError::InvalidInput("终端消费确认超出已发送数据".into()));
        }
        let previous = self.acknowledged.fetch_max(consumed, Ordering::AcqRel);
        if consumed > previous {
            self.slots.add_permits((consumed - previous) as usize);
        }
        Ok(())
    }

    pub fn close(&self) {
        self.slots.close();
    }

    pub async fn send(
        &self,
        channel: &IpcChannel<Response>,
        kind: &str,
        data: &[u8],
    ) -> AppResult<()> {
        for chunk in data.chunks(TERMINAL_FRAME_BYTES) {
            let permit = self
                .slots
                .clone()
                .acquire_many_owned(chunk.len() as u32)
                .await
                .map_err(remote_error)?;
            let mut frame = Vec::with_capacity(chunk.len() + 1);
            frame.push(match kind {
                "error" => 1,
                "system" => 2,
                _ => 0,
            });
            frame.extend_from_slice(chunk);
            self.sent.fetch_add(chunk.len() as u64, Ordering::Release);
            // Credit is returned only after xterm has consumed the frame.
            permit.forget();
            if let Err(error) = channel.send(Response::new(frame)) {
                self.close();
                return Err(remote_error(error));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn binary_stream_preserves_bytes_and_requires_consumption_credit() {
        let frames = Arc::new(StdMutex::new(Vec::new()));
        let received = frames.clone();
        let channel = IpcChannel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Raw(bytes) = body {
                received.lock().unwrap().push(bytes);
            } else {
                panic!("terminal output must be raw binary");
            }
            Ok(())
        });
        let flow = TerminalFlowControl::default();
        flow.send(&channel, "output", "中文\x1b[31m".as_bytes())
            .await
            .unwrap();
        let first = frames.lock().unwrap()[0].clone();
        assert_eq!(first[0], 0);
        assert_eq!(&first[1..], "中文\x1b[31m".as_bytes());
        let consumed = (first.len() - 1) as u64;
        flow.acknowledge(consumed).unwrap();
        flow.acknowledge(consumed).unwrap();
        flow.acknowledge(0).unwrap();
        assert_eq!(flow.slots.available_permits(), TERMINAL_IN_FLIGHT_BYTES);
        assert!(flow.acknowledge(consumed + 1).is_err());
        flow.send(&channel, "error", &vec![b'x'; TERMINAL_IN_FLIGHT_BYTES])
            .await
            .unwrap();
        assert_eq!(flow.slots.available_permits(), 0);
        assert!(timeout(
            Duration::from_millis(10),
            flow.send(&channel, "output", b"a")
        )
        .await
        .is_err());
        flow.acknowledge(consumed + TERMINAL_FRAME_BYTES as u64)
            .unwrap();
        flow.send(&channel, "output", b"a").await.unwrap();
        assert_eq!(flow.slots.available_permits(), TERMINAL_FRAME_BYTES - 1);
        flow.close();
        assert!(flow.send(&channel, "output", b"a").await.is_err());
    }
}
