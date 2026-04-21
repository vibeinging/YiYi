//! Tauri commands for the worker bootstrap state machine.

use serde::Serialize;
use tauri::State;

use crate::engine::worker::{Worker, WorkerRegistry};

/// Lightweight worker summary returned to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct WorkerSummary {
    pub id: String,
    pub name: String,
    pub state: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub event_count: usize,
}

impl From<&Worker> for WorkerSummary {
    fn from(w: &Worker) -> Self {
        Self {
            id: w.id.clone(),
            name: w.name.clone(),
            state: w.state.label().to_string(),
            created_at: w.created_at,
            updated_at: w.updated_at,
            event_count: w.events.len(),
        }
    }
}

/// List all workers with their current state.
pub fn list_workers_impl(registry: &WorkerRegistry) -> Vec<WorkerSummary> {
    registry
        .list()
        .iter()
        .map(WorkerSummary::from)
        .collect()
}

#[tauri::command]
pub fn list_workers(registry: State<'_, WorkerRegistry>) -> Vec<WorkerSummary> {
    list_workers_impl(&*registry)
}

/// Resolve a worker's trust prompt: approve or deny.
pub fn resolve_worker_trust_impl(
    registry: &WorkerRegistry,
    worker_id: String,
    approved: bool,
) -> Result<(), String> {
    registry.resolve_trust(&worker_id, approved)
}

#[tauri::command]
pub fn resolve_worker_trust(
    registry: State<'_, WorkerRegistry>,
    worker_id: String,
    approved: bool,
) -> Result<(), String> {
    resolve_worker_trust_impl(&*registry, worker_id, approved)
}
