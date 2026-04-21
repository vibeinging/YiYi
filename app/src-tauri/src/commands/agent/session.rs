use tauri::State;

use crate::engine::db;
use crate::state::AppState;

// --- Session management commands ---

pub async fn list_sessions_impl(
    state: &AppState,
) -> Result<Vec<db::ChatSession>, String> {
    state.db.list_sessions()
}

#[tauri::command]
pub async fn list_sessions(
    state: State<'_, AppState>,
) -> Result<Vec<db::ChatSession>, String> {
    list_sessions_impl(&*state).await
}

pub async fn create_session_impl(
    state: &AppState,
    name: String,
) -> Result<db::ChatSession, String> {
    state.db.create_session(&name)
}

#[tauri::command]
pub async fn create_session(
    state: State<'_, AppState>,
    name: String,
) -> Result<db::ChatSession, String> {
    create_session_impl(&*state, name).await
}

pub async fn ensure_session_impl(
    state: &AppState,
    id: String,
    name: String,
    source: String,
    source_meta: Option<String>,
) -> Result<db::ChatSession, String> {
    state.db.ensure_session(&id, &name, &source, source_meta.as_deref())
}

#[tauri::command]
pub async fn ensure_session(
    state: State<'_, AppState>,
    id: String,
    name: String,
    source: String,
    source_meta: Option<String>,
) -> Result<db::ChatSession, String> {
    ensure_session_impl(&*state, id, name, source, source_meta).await
}

pub async fn rename_session_impl(
    state: &AppState,
    session_id: String,
    name: String,
) -> Result<(), String> {
    state.db.rename_session(&session_id, &name)
}

#[tauri::command]
pub async fn rename_session(
    state: State<'_, AppState>,
    session_id: String,
    name: String,
) -> Result<(), String> {
    rename_session_impl(&*state, session_id, name).await
}

pub async fn list_chat_sessions_impl(
    state: &AppState,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<db::ChatSession>, String> {
    let limit = limit.unwrap_or(30);
    let offset = offset.unwrap_or(0);
    state.db.list_sessions_by_source_paged("chat", limit, offset)
}

#[tauri::command]
pub async fn list_chat_sessions(
    state: State<'_, AppState>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<db::ChatSession>, String> {
    list_chat_sessions_impl(&*state, limit, offset).await
}

pub async fn search_chat_sessions_impl(
    state: &AppState,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<db::ChatSession>, String> {
    let limit = limit.unwrap_or(20);
    state.db.search_sessions("chat", &query, limit)
}

#[tauri::command]
pub async fn search_chat_sessions(
    state: State<'_, AppState>,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<db::ChatSession>, String> {
    search_chat_sessions_impl(&*state, query, limit).await
}

pub async fn delete_session_impl(
    state: &AppState,
    session_id: String,
) -> Result<(), String> {
    state.db.delete_session(&session_id)
}

#[tauri::command]
pub async fn delete_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    delete_session_impl(&*state, session_id).await
}
