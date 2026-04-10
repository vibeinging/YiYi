#![allow(dead_code)]
//! Unified Task Registry — a single framework for all async work in YiYi.
//!
//! Replaces the ad-hoc task tracking scattered across CronScheduler, Agent chat,
//! Bot message processing, and Verification Agent with a unified model.
//!
//! Design inspired by Claude Code's task system:
//! - 5-state machine: Pending → Running → Completed/Failed/Killed
//! - Minimal polymorphic interface (only `kill` varies per kind)
//! - Penetrating registration: sub-agents register tasks in the global registry

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;

// ── Task status (5-state machine) ──────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Killed,
}

impl TaskStatus {
    pub fn is_terminal(&self) -> bool {
        matches!(self, TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Killed)
    }
}

// ── Task kind ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TaskKind {
    /// Background agent task (create_task tool).
    AgentTask {
        session_id: String,
        task_name: String,
    },
    /// Cron/scheduled job.
    CronJob {
        job_id: String,
        schedule: String,
    },
    /// Bot message reply processing.
    BotReply {
        platform: String,
        channel_id: String,
    },
    /// Verification Agent running post-task checks.
    Verification {
        parent_session_id: String,
    },
    /// Spawn sub-agent.
    SpawnAgent {
        agent_name: String,
        parent_session_id: String,
    },
}

// ── Task entry ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct TaskEntry {
    pub id: String,
    pub kind: TaskKind,
    pub status: TaskStatus,
    pub description: String,
    /// When the task was registered.
    #[serde(skip)]
    pub created_at: Instant,
    /// When the task last changed status.
    #[serde(skip)]
    pub updated_at: Instant,
    /// Error message if status == Failed.
    pub error: Option<String>,
    /// Cancellation signal (shared with the task's runtime).
    /// Use `TaskRegistry::kill()` instead of modifying directly.
    #[serde(skip)]
    pub(crate) cancel_flag: Option<Arc<std::sync::atomic::AtomicBool>>,
}

impl TaskEntry {
    pub fn new(id: impl Into<String>, kind: TaskKind, description: impl Into<String>) -> Self {
        let now = Instant::now();
        Self {
            id: id.into(),
            kind,
            status: TaskStatus::Pending,
            description: description.into(),
            created_at: now,
            updated_at: now,
            error: None,
            cancel_flag: None,
        }
    }

    /// Attach a cancellation flag (call before starting the task).
    pub fn with_cancel_flag(mut self, flag: Arc<std::sync::atomic::AtomicBool>) -> Self {
        self.cancel_flag = Some(flag);
        self
    }
}

// ── Registry ───────────────────────────────────────────────────────────

/// Global task registry. Thread-safe, designed to be stored in AppState.
///
/// Penetrating design: sub-agents spawned anywhere in the system can register
/// tasks here via the global accessor, ensuring nothing is lost.
#[derive(Debug, Clone)]
pub struct TaskRegistry {
    inner: Arc<Mutex<RegistryInner>>,
}

#[derive(Debug)]
struct RegistryInner {
    tasks: HashMap<String, TaskEntry>,
    /// Auto-incrementing counter for generating unique task IDs.
    next_id: u64,
}

impl TaskRegistry {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(RegistryInner {
                tasks: HashMap::new(),
                next_id: 1,
            })),
        }
    }

    /// Generate a unique task ID.
    pub fn next_id(&self) -> String {
        let mut inner = self.inner.lock().unwrap();
        let id = format!("task_{}", inner.next_id);
        inner.next_id += 1;
        id
    }

    /// Register a new task. Returns the task ID.
    /// Automatically evicts terminal tasks older than 5 minutes to prevent unbounded growth.
    pub fn register(&self, mut entry: TaskEntry) -> String {
        let id = entry.id.clone();
        entry.status = TaskStatus::Pending;
        let mut inner = self.inner.lock().unwrap();
        // Inline eviction: remove old terminal tasks to prevent memory leak
        if inner.tasks.len() > 50 {
            let now = Instant::now();
            let max_age = std::time::Duration::from_secs(300);
            inner.tasks.retain(|_, t| {
                !t.status.is_terminal() || now.duration_since(t.updated_at) < max_age
            });
        }
        inner.tasks.insert(id.clone(), entry);
        id
    }

    /// Update task status. Returns false if the task doesn't exist.
    pub fn update_status(&self, id: &str, status: TaskStatus) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if let Some(entry) = inner.tasks.get_mut(id) {
            entry.status = status;
            entry.updated_at = Instant::now();
            true
        } else {
            false
        }
    }

    /// Mark a task as running.
    pub fn start(&self, id: &str) -> bool {
        self.update_status(id, TaskStatus::Running)
    }

    /// Mark a task as completed.
    pub fn complete(&self, id: &str) -> bool {
        self.update_status(id, TaskStatus::Completed)
    }

    /// Mark a task as failed with an error message.
    pub fn fail(&self, id: &str, error: &str) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if let Some(entry) = inner.tasks.get_mut(id) {
            entry.status = TaskStatus::Failed;
            entry.error = Some(error.to_string());
            entry.updated_at = Instant::now();
            true
        } else {
            false
        }
    }

    /// Kill a task by setting its cancel flag and updating status.
    pub fn kill(&self, id: &str) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if let Some(entry) = inner.tasks.get_mut(id) {
            if entry.status.is_terminal() {
                return false; // can't kill a finished task
            }
            if let Some(ref flag) = entry.cancel_flag {
                flag.store(true, std::sync::atomic::Ordering::Relaxed);
            }
            entry.status = TaskStatus::Killed;
            entry.updated_at = Instant::now();
            true
        } else {
            false
        }
    }

    /// Get a snapshot of a single task.
    pub fn get(&self, id: &str) -> Option<TaskEntry> {
        let inner = self.inner.lock().unwrap();
        inner.tasks.get(id).cloned()
    }

    /// List all tasks, optionally filtered by status.
    pub fn list(&self, status_filter: Option<TaskStatus>) -> Vec<TaskEntry> {
        let inner = self.inner.lock().unwrap();
        inner.tasks.values()
            .filter(|t| status_filter.map_or(true, |s| t.status == s))
            .cloned()
            .collect()
    }

    /// List running tasks for a specific session.
    pub fn running_for_session(&self, session_id: &str) -> Vec<TaskEntry> {
        let inner = self.inner.lock().unwrap();
        inner.tasks.values()
            .filter(|t| {
                t.status == TaskStatus::Running && match &t.kind {
                    TaskKind::AgentTask { session_id: sid, .. } => sid == session_id,
                    TaskKind::Verification { parent_session_id } => parent_session_id == session_id,
                    TaskKind::SpawnAgent { parent_session_id, .. } => parent_session_id == session_id,
                    _ => false,
                }
            })
            .cloned()
            .collect()
    }

    /// Evict terminal tasks older than the given duration.
    /// Returns the number of evicted tasks.
    pub fn evict_terminal(&self, max_age: std::time::Duration) -> usize {
        let mut inner = self.inner.lock().unwrap();
        let now = Instant::now();
        let before = inner.tasks.len();
        inner.tasks.retain(|_, t| {
            !t.status.is_terminal() || now.duration_since(t.updated_at) < max_age
        });
        before - inner.tasks.len()
    }

    /// Kill all running tasks for a specific session (cleanup on session close / agent exit).
    pub fn kill_all_for_session(&self, session_id: &str) -> usize {
        let mut inner = self.inner.lock().unwrap();
        let mut killed = 0;
        for entry in inner.tasks.values_mut() {
            if entry.status.is_terminal() {
                continue;
            }
            let belongs = match &entry.kind {
                TaskKind::AgentTask { session_id: sid, .. } => sid == session_id,
                TaskKind::Verification { parent_session_id } => parent_session_id == session_id,
                TaskKind::SpawnAgent { parent_session_id, .. } => parent_session_id == session_id,
                _ => false,
            };
            if belongs {
                if let Some(ref flag) = entry.cancel_flag {
                    flag.store(true, std::sync::atomic::Ordering::Relaxed);
                }
                entry.status = TaskStatus::Killed;
                entry.updated_at = Instant::now();
                killed += 1;
            }
        }
        killed
    }
}

// ── Global accessor ────────────────────────────────────────────────────

static GLOBAL_REGISTRY: std::sync::OnceLock<TaskRegistry> = std::sync::OnceLock::new();

/// Initialize the global task registry. Call once during app startup.
pub fn init_global_registry() -> &'static TaskRegistry {
    GLOBAL_REGISTRY.get_or_init(TaskRegistry::new)
}

/// Get the global task registry. Returns None if not initialized.
pub fn global_registry() -> Option<&'static TaskRegistry> {
    GLOBAL_REGISTRY.get()
}
