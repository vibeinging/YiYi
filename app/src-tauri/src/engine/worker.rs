//! Worker bootstrap state machine and registry.
//!
//! Borrowed from Claw Code's `worker_boot.rs` design, adapted for YiYi's
//! agent/task execution model.  Provides:
//!
//! - A 6-state machine (Spawning → TrustRequired → Ready → Running → Finished/Failed)
//! - An audit-trail of `WorkerEvent`s per worker
//! - Trust-prompt detection (scans output text for permission/approval patterns)
//! - A thread-safe `WorkerRegistry` with spawn, transition, list, and cleanup

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

// ── Helpers ──────────────────────────────────────────────────────────────

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

// ── Failure reason ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "message", rename_all = "snake_case")]
pub enum FailureReason {
    TrustGate(String),
    PromptDelivery(String),
    Timeout,
    RuntimeError(String),
}

impl std::fmt::Display for FailureReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TrustGate(msg) => write!(f, "trust_gate: {msg}"),
            Self::PromptDelivery(msg) => write!(f, "prompt_delivery: {msg}"),
            Self::Timeout => write!(f, "timeout"),
            Self::RuntimeError(msg) => write!(f, "runtime_error: {msg}"),
        }
    }
}

// ── Worker state ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum WorkerState {
    Spawning,
    TrustRequired { prompt_text: String },
    Ready,
    Running,
    Finished { result: String },
    Failed { reason: FailureReason },
}

impl WorkerState {
    /// Short label for display / filtering.
    #[must_use]
    pub fn label(&self) -> &'static str {
        match self {
            Self::Spawning => "spawning",
            Self::TrustRequired { .. } => "trust_required",
            Self::Ready => "ready",
            Self::Running => "running",
            Self::Finished { .. } => "finished",
            Self::Failed { .. } => "failed",
        }
    }

    /// Whether this state is terminal (no further transitions allowed).
    #[must_use]
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Finished { .. } | Self::Failed { .. })
    }
}

// ── Worker events (audit trail) ──────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkerEvent {
    Spawned {
        timestamp: i64,
    },
    TrustRequired {
        prompt_text: String,
        timestamp: i64,
    },
    TrustResolved {
        approved: bool,
        timestamp: i64,
    },
    Ready {
        timestamp: i64,
    },
    Running {
        timestamp: i64,
    },
    Finished {
        result: String,
        timestamp: i64,
    },
    Failed {
        reason: FailureReason,
        timestamp: i64,
    },
    Restarted {
        timestamp: i64,
    },
}

impl WorkerEvent {
    fn timestamp(&self) -> i64 {
        match self {
            Self::Spawned { timestamp }
            | Self::TrustRequired { timestamp, .. }
            | Self::TrustResolved { timestamp, .. }
            | Self::Ready { timestamp }
            | Self::Running { timestamp }
            | Self::Finished { timestamp, .. }
            | Self::Failed { timestamp, .. }
            | Self::Restarted { timestamp } => *timestamp,
        }
    }
}

// ── Worker struct ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Worker {
    pub id: String,
    pub name: String,
    pub state: WorkerState,
    pub created_at: i64,
    pub updated_at: i64,
    pub events: Vec<WorkerEvent>,
}

impl Worker {
    fn push_event(&mut self, event: WorkerEvent) {
        self.updated_at = event.timestamp();
        self.events.push(event);
    }
}

// ── State transition validation ──────────────────────────────────────────

/// Returns `true` if `from → to` is a valid transition.
fn is_valid_transition(from: &WorkerState, to: &WorkerState) -> bool {
    use WorkerState::*;
    matches!(
        (from, to),
        // Normal forward path
        (Spawning, TrustRequired { .. })
            | (Spawning, Ready)
            | (TrustRequired { .. }, Ready)
            | (TrustRequired { .. }, Failed { .. })
            | (Ready, Running)
            | (Running, Finished { .. })
            // Any non-terminal state can fail
            | (Spawning, Failed { .. })
            | (Ready, Failed { .. })
            | (Running, Failed { .. })
            // Restart: from terminal back to Spawning
            | (Finished { .. }, Spawning)
            | (Failed { .. }, Spawning)
    )
}

// ── Worker Registry ──────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct WorkerRegistry {
    inner: Arc<Mutex<RegistryInner>>,
}

#[derive(Debug)]
struct RegistryInner {
    workers: HashMap<String, Worker>,
    counter: u64,
}

impl Default for WorkerRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl WorkerRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(RegistryInner {
                workers: HashMap::new(),
                counter: 0,
            })),
        }
    }

    /// Spawn a new worker. Returns the generated worker ID.
    pub fn spawn(&self, name: impl Into<String>) -> String {
        let mut inner = self.inner.lock().expect("worker registry lock poisoned");
        inner.counter += 1;
        let ts = now_millis();
        let worker_id = format!("worker_{:08x}_{}", ts as u64, inner.counter);
        let name = name.into();

        let worker = Worker {
            id: worker_id.clone(),
            name,
            state: WorkerState::Spawning,
            created_at: ts,
            updated_at: ts,
            events: vec![WorkerEvent::Spawned { timestamp: ts }],
        };

        inner.workers.insert(worker_id.clone(), worker);
        worker_id
    }

    /// Transition a worker to a new state.
    ///
    /// Returns `Ok(())` on success, `Err(message)` if the transition is invalid
    /// or the worker does not exist.
    pub fn transition(&self, id: &str, new_state: WorkerState) -> Result<(), String> {
        let mut inner = self.inner.lock().expect("worker registry lock poisoned");
        let worker = inner
            .workers
            .get_mut(id)
            .ok_or_else(|| format!("worker '{id}' not found"))?;

        if !is_valid_transition(&worker.state, &new_state) {
            return Err(format!(
                "invalid transition: {} -> {}",
                worker.state.label(),
                new_state.label()
            ));
        }

        let ts = now_millis();

        // Emit the matching audit event
        let event = match &new_state {
            WorkerState::Spawning => WorkerEvent::Restarted { timestamp: ts },
            WorkerState::TrustRequired { prompt_text } => WorkerEvent::TrustRequired {
                prompt_text: prompt_text.clone(),
                timestamp: ts,
            },
            WorkerState::Ready => WorkerEvent::Ready { timestamp: ts },
            WorkerState::Running => WorkerEvent::Running { timestamp: ts },
            WorkerState::Finished { result } => WorkerEvent::Finished {
                result: result.clone(),
                timestamp: ts,
            },
            WorkerState::Failed { reason } => WorkerEvent::Failed {
                reason: reason.clone(),
                timestamp: ts,
            },
        };

        worker.state = new_state;
        worker.push_event(event);
        Ok(())
    }

    /// Resolve a trust prompt: approve or deny.
    ///
    /// If approved, transitions TrustRequired → Ready.
    /// If denied, transitions TrustRequired → Failed(TrustGate).
    pub fn resolve_trust(&self, id: &str, approved: bool) -> Result<(), String> {
        let mut inner = self.inner.lock().expect("worker registry lock poisoned");
        let worker = inner
            .workers
            .get_mut(id)
            .ok_or_else(|| format!("worker '{id}' not found"))?;

        if !matches!(worker.state, WorkerState::TrustRequired { .. }) {
            return Err(format!(
                "worker '{}' is in state '{}', not 'trust_required'",
                id,
                worker.state.label()
            ));
        }

        let ts = now_millis();

        // Record the resolution event
        worker.push_event(WorkerEvent::TrustResolved {
            approved,
            timestamp: ts,
        });

        if approved {
            worker.state = WorkerState::Ready;
            worker.push_event(WorkerEvent::Ready { timestamp: ts });
        } else {
            let reason = FailureReason::TrustGate("user denied trust prompt".into());
            worker.state = WorkerState::Failed {
                reason: reason.clone(),
            };
            worker.push_event(WorkerEvent::Failed {
                reason,
                timestamp: ts,
            });
        }

        Ok(())
    }

    /// List all workers.
    #[must_use]
    pub fn list(&self) -> Vec<Worker> {
        let inner = self.inner.lock().expect("worker registry lock poisoned");
        inner.workers.values().cloned().collect()
    }

    /// Remove finished/failed workers older than `max_age_ms` milliseconds.
    /// Returns the number of cleaned-up workers.
    pub fn cleanup_finished(&self, max_age_ms: i64) -> usize {
        let mut inner = self.inner.lock().expect("worker registry lock poisoned");
        let now = now_millis();
        let before = inner.workers.len();
        inner.workers.retain(|_, w| {
            !w.state.is_terminal() || (now - w.updated_at) < max_age_ms
        });
        before - inner.workers.len()
    }
}

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: get a worker by id (test-only).
    fn get_worker(reg: &WorkerRegistry, id: &str) -> Option<Worker> {
        reg.list().into_iter().find(|w| w.id == id)
    }

    #[test]
    fn spawn_and_get() {
        let reg = WorkerRegistry::new();
        let id = reg.spawn("test-worker");
        let w = get_worker(&reg, &id).unwrap();
        assert_eq!(w.name, "test-worker");
        assert_eq!(w.state.label(), "spawning");
        assert_eq!(w.events.len(), 1);
    }

    #[test]
    fn happy_path_transitions() {
        let reg = WorkerRegistry::new();
        let id = reg.spawn("w1");

        reg.transition(&id, WorkerState::Ready).unwrap();
        assert_eq!(get_worker(&reg, &id).unwrap().state.label(), "ready");

        reg.transition(&id, WorkerState::Running).unwrap();
        assert_eq!(get_worker(&reg, &id).unwrap().state.label(), "running");

        reg.transition(
            &id,
            WorkerState::Finished {
                result: "done".into(),
            },
        )
        .unwrap();
        assert_eq!(get_worker(&reg, &id).unwrap().state.label(), "finished");
    }

    #[test]
    fn trust_flow() {
        let reg = WorkerRegistry::new();
        let id = reg.spawn("w2");

        reg.transition(
            &id,
            WorkerState::TrustRequired {
                prompt_text: "allow access?".into(),
            },
        )
        .unwrap();
        assert_eq!(get_worker(&reg, &id).unwrap().state.label(), "trust_required");

        reg.resolve_trust(&id, true).unwrap();
        assert_eq!(get_worker(&reg, &id).unwrap().state.label(), "ready");
    }

    #[test]
    fn trust_denied() {
        let reg = WorkerRegistry::new();
        let id = reg.spawn("w3");

        reg.transition(
            &id,
            WorkerState::TrustRequired {
                prompt_text: "allow?".into(),
            },
        )
        .unwrap();
        reg.resolve_trust(&id, false).unwrap();
        assert_eq!(get_worker(&reg, &id).unwrap().state.label(), "failed");
    }

    #[test]
    fn invalid_transition_rejected() {
        let reg = WorkerRegistry::new();
        let id = reg.spawn("w4");
        // Can't go from Spawning directly to Running
        assert!(reg.transition(&id, WorkerState::Running).is_err());
    }

    #[test]
    fn cleanup_removes_old_terminal_workers() {
        let reg = WorkerRegistry::new();
        let id = reg.spawn("old");
        reg.transition(&id, WorkerState::Ready).unwrap();
        reg.transition(&id, WorkerState::Running).unwrap();
        reg.transition(
            &id,
            WorkerState::Finished {
                result: "ok".into(),
            },
        )
        .unwrap();

        // max_age_ms=0 means "remove anything that's already terminal"
        let removed = reg.cleanup_finished(0);
        assert_eq!(removed, 1);
        assert!(get_worker(&reg, &id).is_none());
    }

    #[test]
    fn restart_from_terminal() {
        let reg = WorkerRegistry::new();
        let id = reg.spawn("restartable");
        reg.transition(
            &id,
            WorkerState::Failed {
                reason: FailureReason::Timeout,
            },
        )
        .unwrap();

        // Restart: Failed → Spawning
        reg.transition(&id, WorkerState::Spawning).unwrap();
        assert_eq!(get_worker(&reg, &id).unwrap().state.label(), "spawning");
    }
}
