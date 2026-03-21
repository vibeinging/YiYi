use tauri::State;

use crate::engine::db;
use crate::state::AppState;

// --- Session management commands ---

#[tauri::command]
pub async fn list_sessions(
    state: State<'_, AppState>,
) -> Result<Vec<db::ChatSession>, String> {
    state.db.list_sessions()
}

#[tauri::command]
pub async fn create_session(
    state: State<'_, AppState>,
    name: String,
) -> Result<db::ChatSession, String> {
    state.db.create_session(&name)
}

#[tauri::command]
pub async fn ensure_session(
    state: State<'_, AppState>,
    id: String,
    name: String,
    source: String,
    source_meta: Option<String>,
) -> Result<db::ChatSession, String> {
    state.db.ensure_session(&id, &name, &source, source_meta.as_deref())
}

#[tauri::command]
pub async fn rename_session(
    state: State<'_, AppState>,
    session_id: String,
    name: String,
) -> Result<(), String> {
    state.db.rename_session(&session_id, &name)
}

#[tauri::command]
pub async fn delete_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    state.db.delete_session(&session_id)
}
