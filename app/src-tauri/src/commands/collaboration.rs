//! Tauri command surface for the Collaboration subsystem.
//!
//! Four high-level entry points map directly onto `CollaborationOrchestrator`
//! trait methods. The front-end constructs a `CollaborationPlan` (via
//! the `api/collaboration.ts` helpers) and submits — everything else
//! flows through events.

use std::sync::Arc;

use tauri::State;

use crate::commands::agent::resolve_llm_config;
use crate::engine::collaboration::{
    executor::ConcreteExecutor, orchestrator::SqliteOrchestrator, Collaboration,
    CollaborationId, CollaborationMode, CollaborationOrchestrator, CollaborationPlan,
    Mutation,
};
use crate::state::AppState;

/// Build a fresh orchestrator + concrete executor for one command call.
/// Orchestrator state is fully persisted in SQLite, so per-call
/// construction is correct (and cheap — just Arc bumps + an LLMConfig
/// resolve). The only process-wide resource is the broadcast events
/// channel, which is a `OnceLock` and survives transparently.
async fn orchestrator(state: &AppState) -> Result<SqliteOrchestrator, String> {
    let config = resolve_llm_config(state).await?;
    let executor = Arc::new(ConcreteExecutor::new(config));
    Ok(SqliteOrchestrator::new(state.db.clone(), executor))
}

#[tauri::command]
pub async fn collaboration_submit(
    state: State<'_, AppState>,
    chat_session_id: String,
    intent: String,
    plan: CollaborationPlan,
    mode: CollaborationMode,
    parent_id: Option<CollaborationId>,
) -> Result<CollaborationId, String> {
    let orch = orchestrator(&state).await?;
    orch.submit(chat_session_id, intent, plan, mode, parent_id).await
}

#[tauri::command]
pub async fn collaboration_confirm(
    state: State<'_, AppState>,
    id: CollaborationId,
    edited_plan: Option<CollaborationPlan>,
) -> Result<(), String> {
    let orch = orchestrator(&state).await?;
    orch.confirm(id, edited_plan).await
}

#[tauri::command]
pub async fn collaboration_abort(
    state: State<'_, AppState>,
    id: CollaborationId,
) -> Result<(), String> {
    let orch = orchestrator(&state).await?;
    orch.abort(id).await
}

#[tauri::command]
pub async fn collaboration_mutate(
    state: State<'_, AppState>,
    id: CollaborationId,
    mutation: Mutation,
) -> Result<(), String> {
    let orch = orchestrator(&state).await?;
    orch.mutate(id, mutation).await
}

#[tauri::command]
pub async fn collaboration_get(
    state: State<'_, AppState>,
    id: CollaborationId,
) -> Result<Option<Collaboration>, String> {
    let orch = orchestrator(&state).await?;
    orch.get(id).await
}
