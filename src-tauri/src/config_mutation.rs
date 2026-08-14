use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

use tokio::sync::{Mutex, OwnedMutexGuard};

use crate::errors::{AppError, AppResult};

/// Serializes committed Vault mutations and invalidates commands that were
/// accepted before a whole-config replacement (backup import/restore).
///
/// Even epochs are stable. A replacement owns the mutex and exposes an odd
/// epoch until it finishes, so requests arriving during the replacement are
/// invalidated as well as requests queued before it.
#[derive(Clone, Default)]
pub struct ConfigMutationCoordinator {
    gate: Arc<Mutex<()>>,
    epoch: Arc<AtomicU64>,
}

#[derive(Clone, Copy)]
pub struct ConfigMutationTicket(u64);

pub struct ConfigReplacementGuard {
    coordinator: ConfigMutationCoordinator,
    _gate: OwnedMutexGuard<()>,
}

impl ConfigMutationCoordinator {
    pub fn ticket(&self) -> ConfigMutationTicket {
        ConfigMutationTicket(self.epoch.load(Ordering::Acquire))
    }

    pub async fn lock(&self, ticket: ConfigMutationTicket) -> AppResult<OwnedMutexGuard<()>> {
        let guard = self.gate.clone().lock_owned().await;
        let current = self.epoch.load(Ordering::Acquire);
        if current != ticket.0 || !current.is_multiple_of(2) {
            return Err(stale_config_error());
        }
        Ok(guard)
    }

    pub async fn begin_replacement(&self) -> ConfigReplacementGuard {
        let gate = self.gate.clone().lock_owned().await;
        let previous = self.epoch.fetch_add(1, Ordering::AcqRel);
        debug_assert!(previous.is_multiple_of(2));
        ConfigReplacementGuard {
            coordinator: self.clone(),
            _gate: gate,
        }
    }
}

impl Drop for ConfigReplacementGuard {
    fn drop(&mut self) {
        let previous = self.coordinator.epoch.fetch_add(1, Ordering::AcqRel);
        debug_assert!(!previous.is_multiple_of(2));
    }
}

fn stale_config_error() -> AppError {
    AppError::ConfigConflict("配置已被备份恢复替换，请基于最新配置重试".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn replacement_invalidates_old_and_in_flight_tickets() {
        let coordinator = ConfigMutationCoordinator::default();
        let old = coordinator.ticket();
        let replacement = coordinator.begin_replacement().await;
        let during = coordinator.ticket();
        drop(replacement);

        assert!(matches!(
            coordinator.lock(old).await,
            Err(AppError::ConfigConflict(_))
        ));
        assert!(matches!(
            coordinator.lock(during).await,
            Err(AppError::ConfigConflict(_))
        ));
        assert!(coordinator.lock(coordinator.ticket()).await.is_ok());
    }
}
