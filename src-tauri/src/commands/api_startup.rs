use std::{future::Future, sync::Mutex};

use tokio::{
    sync::watch,
    time::{Duration, Instant},
};

use crate::{
    api_server::ApiServerInfo,
    errors::{AppError, AppResult},
};

pub(super) const API_STARTUP_NORMAL_WAIT: Duration = Duration::from_secs(10);
pub(super) const API_STARTUP_MAX_WAIT: Duration = Duration::from_secs(15);

pub(super) struct ApiStartup {
    cancelled: watch::Sender<bool>,
    progress: Mutex<ApiServerInfo>,
}

impl Default for ApiStartup {
    fn default() -> Self {
        Self {
            cancelled: watch::channel(false).0,
            progress: Mutex::new(ApiServerInfo::default()),
        }
    }
}

impl ApiStartup {
    pub fn cancellation(&self) -> watch::Receiver<bool> {
        self.cancelled.subscribe()
    }

    pub fn is_cancelled(&self) -> bool {
        *self.cancelled.borrow()
    }

    // Explicit user operations supersede automatic recovery for this launch.
    pub fn cancel(&self) {
        self.cancelled.send_replace(true);
        *self
            .progress
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = ApiServerInfo::default();
    }

    pub fn waiting(&self, port: u16) -> bool {
        let mut progress = self
            .progress
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if progress.starting && progress.port == port {
            return false;
        }
        *progress = ApiServerInfo {
            starting: true,
            port,
            ..Default::default()
        };
        true
    }

    pub fn finish(&self, error: Option<String>) {
        let mut progress = self
            .progress
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        progress.starting = false;
        progress.error = error;
    }

    pub fn decorate(&self, mut info: ApiServerInfo) -> ApiServerInfo {
        if !info.running && !self.is_cancelled() {
            let progress = self
                .progress
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            info.starting = progress.starting;
            info.error = progress.error.clone();
            if info.port == 0 {
                info.port = progress.port;
            }
        }
        info
    }
}

async fn cancelled(receiver: &mut watch::Receiver<bool>) {
    let _ = receiver.wait_for(|value| *value).await;
}

/// Only retry the OS address-in-use error. No lifecycle/config lock is held
/// during backoff; stop and application shutdown wake it immediately.
pub(super) async fn retry_api_start<T, F, Fut>(
    mut attempt: F,
    mut stop: watch::Receiver<bool>,
    mut shutdown: watch::Receiver<bool>,
    normal_budget: Duration,
    budget: Duration,
) -> AppResult<Option<T>>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = AppResult<Option<T>>>,
{
    let started = Instant::now();
    let normal_deadline = started + normal_budget.min(budget);
    let deadline = started + budget;
    let mut extended = false;
    let mut delay = Duration::from_millis(100);
    let mut attempts = 0;
    loop {
        if *stop.borrow() || *shutdown.borrow() {
            return Ok(None);
        }
        attempts += 1;
        match attempt().await {
            Err(error @ AppError::ApiPortInUse(_)) => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err(error);
                }
                if attempts == 1 {
                    log::warn!(
                        "AI API port is occupied during startup; retrying for {}s, maximum {}s: {error}",
                        normal_budget.as_secs(), budget.as_secs()
                    );
                }
                if !extended && Instant::now() >= normal_deadline {
                    extended = true;
                    log::warn!(
                        "AI API port is still occupied; extending startup recovery to {}s total",
                        budget.as_secs()
                    );
                }
                let next_boundary = if extended { deadline } else { normal_deadline };
                let wait = delay.min(next_boundary.saturating_duration_since(Instant::now()));
                tokio::select! {
                    _ = cancelled(&mut stop) => return Ok(None),
                    _ = cancelled(&mut shutdown) => return Ok(None),
                    _ = tokio::time::sleep(wait) => {},
                }
                if Instant::now() >= deadline {
                    return Err(error);
                }
                delay = (delay * 2).min(Duration::from_millis(500));
            }
            result => {
                if attempts > 1 && matches!(result, Ok(Some(_))) {
                    log::info!("AI API startup recovered after {attempts} attempts");
                }
                return result;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_server::bind_api_listener;

    #[tokio::test]
    async fn installer_port_handoff_recovers_without_restarting_the_app() {
        let old_listener = bind_api_listener(0).await.unwrap();
        let port = old_listener.local_addr().unwrap().port();
        let startup = ApiStartup::default();
        let (_shutdown_tx, shutdown_rx) = watch::channel(false);
        let release = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            drop(old_listener);
        });
        let listener = retry_api_start(
            || async { bind_api_listener(port).await.map(Some) },
            startup.cancellation(),
            shutdown_rx,
            Duration::from_secs(1),
            Duration::from_secs(2),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(listener.local_addr().unwrap().port(), port);
        release.await.unwrap();
    }

    #[tokio::test]
    async fn stop_and_shutdown_cancel_port_recovery() {
        for shutdown_request in [false, true] {
            let listener = bind_api_listener(0).await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let startup = std::sync::Arc::new(ApiStartup::default());
            let (shutdown_tx, shutdown_rx) = watch::channel(false);
            let cancellation = startup.cancellation();
            let cancel = tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(20)).await;
                if shutdown_request {
                    shutdown_tx.send_replace(true);
                } else {
                    startup.cancel();
                }
            });
            let result = tokio::time::timeout(
                Duration::from_millis(500),
                retry_api_start(
                    || async { bind_api_listener(port).await.map(Some) },
                    cancellation,
                    shutdown_rx,
                    API_STARTUP_NORMAL_WAIT,
                    API_STARTUP_MAX_WAIT,
                ),
            )
            .await
            .unwrap()
            .unwrap();
            assert!(result.is_none());
            cancel.await.unwrap();
        }
    }

    #[tokio::test]
    async fn permanent_conflict_has_a_deadline_and_other_errors_are_not_retried() {
        let listener = bind_api_listener(0).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let startup = ApiStartup::default();
        let (_shutdown_tx, shutdown_rx) = watch::channel(false);
        assert!(matches!(
            retry_api_start(
                || async { bind_api_listener(port).await.map(Some) },
                startup.cancellation(),
                shutdown_rx.clone(),
                Duration::from_millis(10),
                Duration::from_millis(30)
            )
            .await,
            Err(AppError::ApiPortInUse(_))
        ));
        let mut attempts = 0;
        let result = retry_api_start(
            || {
                attempts += 1;
                async { Err::<Option<()>, _>(AppError::VaultLocked) }
            },
            startup.cancellation(),
            shutdown_rx,
            API_STARTUP_NORMAL_WAIT,
            API_STARTUP_MAX_WAIT,
        )
        .await;
        assert!(matches!(result, Err(AppError::VaultLocked)));
        assert_eq!(attempts, 1);
    }

    #[test]
    fn status_distinguishes_startup_failure_running_and_explicit_stop() {
        let startup = ApiStartup::default();
        startup.waiting(19880);
        let waiting = startup.decorate(ApiServerInfo::default());
        assert!(waiting.starting);
        assert!(!waiting.running);
        assert_eq!(waiting.port, 19880);
        startup.finish(Some("port occupied".into()));
        assert_eq!(
            startup.decorate(ApiServerInfo::default()).error.as_deref(),
            Some("port occupied")
        );
        let running = startup.decorate(ApiServerInfo {
            running: true,
            ..Default::default()
        });
        assert!(!running.starting && running.error.is_none());
        startup.cancel();
        let stopped = startup.decorate(ApiServerInfo::default());
        assert!(!stopped.starting && stopped.error.is_none());
    }

    #[tokio::test]
    async fn recovery_extends_only_to_the_total_limit() {
        let listener = bind_api_listener(0).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let startup = ApiStartup::default();
        let (_shutdown_tx, shutdown_rx) = watch::channel(false);
        let release = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(70)).await;
            drop(listener);
        });
        // Release after the normal window but inside the single fallback window.
        let recovered = retry_api_start(
            || async { bind_api_listener(port).await.map(Some) },
            startup.cancellation(),
            shutdown_rx,
            Duration::from_millis(40),
            Duration::from_millis(400),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(recovered.local_addr().unwrap().port(), port);
        release.await.unwrap();
    }
}
