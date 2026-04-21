use base64::Engine;
use tauri::State;
use crate::state::AppState;
use crate::engine::infra::pty_manager::PtySessionInfo;

#[tauri::command]
pub async fn pty_spawn(
    command: String,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let effective_cwd = cwd.unwrap_or_else(|| {
        state.user_workspace().to_string_lossy().to_string()
    });
    let args_vec = args.unwrap_or_default();
    let cols = cols.unwrap_or(80);
    let rows = rows.unwrap_or(24);

    state
        .pty_manager
        .spawn(&app, &command, &args_vec, &effective_cwd, cols, rows)
        .await
}

#[tauri::command]
pub async fn pty_write(
    session_id: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // data is base64-encoded
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| format!("Invalid base64: {}", e))?;

    state.pty_manager.write_stdin(&session_id, &bytes).await
}

pub async fn pty_resize_impl(
    state: &AppState,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.pty_manager.resize(&session_id, cols, rows).await
}

#[tauri::command]
pub async fn pty_resize(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    pty_resize_impl(&*state, session_id, cols, rows).await
}

pub async fn pty_close_impl(
    state: &AppState,
    session_id: String,
) -> Result<(), String> {
    state.pty_manager.close(&session_id).await
}

#[tauri::command]
pub async fn pty_close(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    pty_close_impl(&*state, session_id).await
}

pub async fn pty_list_impl(state: &AppState) -> Result<Vec<PtySessionInfo>, String> {
    Ok(state.pty_manager.list().await)
}

#[tauri::command]
pub async fn pty_list(
    state: State<'_, AppState>,
) -> Result<Vec<PtySessionInfo>, String> {
    pty_list_impl(&*state).await
}
