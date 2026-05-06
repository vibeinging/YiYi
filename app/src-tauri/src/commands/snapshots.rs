//! Tauri commands for side-git workspace snapshots.

use tauri::State;

use crate::engine::side_git::{self, RestoreReport, SnapshotInfo};
use crate::state::AppState;

#[tauri::command]
pub async fn list_snapshots(session_id: String) -> Result<Vec<SnapshotInfo>, String> {
    Ok(side_git::list_snapshots(&session_id))
}

#[tauri::command]
pub async fn restore_snapshot(
    state: State<'_, AppState>,
    session_id: String,
    turn_index: u32,
    phase: String,
) -> Result<RestoreReport, String> {
    let workspace = state.user_workspace();
    side_git::restore(&session_id, turn_index, &phase, &workspace).await
}
