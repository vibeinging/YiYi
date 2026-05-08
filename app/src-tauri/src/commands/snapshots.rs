//! Tauri commands for workspace checkpoints (shadow-git via libgit2).

use tauri::State;

use crate::engine::checkpoint::{self, CheckpointInfo, FileDiff, Phase};
use crate::state::AppState;

#[tauri::command]
pub async fn list_checkpoints(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<CheckpointInfo>, String> {
    let workspace = state.user_workspace();
    Ok(checkpoint::list_snapshots(&session_id, &workspace))
}

#[tauri::command]
pub async fn preview_checkpoint(
    state: State<'_, AppState>,
    session_id: String,
    turn_index: u32,
    phase: Phase,
) -> Result<Vec<FileDiff>, String> {
    let workspace = state.user_workspace();
    checkpoint::preview_diff(&session_id, turn_index, phase, &workspace).await
}

#[tauri::command]
pub async fn restore_checkpoint(
    state: State<'_, AppState>,
    session_id: String,
    turn_index: u32,
    phase: Phase,
    paths: Option<Vec<String>>,
) -> Result<checkpoint::RestoreReport, String> {
    let workspace = state.user_workspace();
    let path_bufs = paths.map(|v| v.into_iter().map(std::path::PathBuf::from).collect());
    checkpoint::restore(&session_id, turn_index, phase, &workspace, path_bufs).await
}

#[tauri::command]
pub async fn discard_checkpoint_branch(
    state: State<'_, AppState>,
    session_id: String,
    keep_through_turn: u32,
) -> Result<u32, String> {
    let workspace = state.user_workspace();
    checkpoint::discard_branch_after(&session_id, keep_through_turn, &workspace).await
}
