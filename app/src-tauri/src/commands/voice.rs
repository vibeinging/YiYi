use tauri::State;

use crate::engine::voice::VoiceStatus;
use crate::state::AppState;

/// Resolve an API key from the configured providers (reuses existing LLM config resolution).
async fn resolve_api_key(state: &AppState) -> Result<String, String> {
    let providers = state.providers.read().await;
    let config = crate::engine::llm_client::resolve_config_from_providers(&providers)?;
    Ok(config.api_key)
}

#[tauri::command]
pub async fn start_voice_session(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let api_key = resolve_api_key(&state).await?;

    let manager = state.voice_manager.read().await;
    manager.start(api_key, None, app).await
}

#[tauri::command]
pub async fn stop_voice_session(
    state: State<'_, AppState>,
) -> Result<(), String> {
    let manager = state.voice_manager.read().await;
    manager.stop().await
}

#[tauri::command]
pub async fn get_voice_status(
    state: State<'_, AppState>,
) -> Result<VoiceStatus, String> {
    let manager = state.voice_manager.read().await;
    Ok(manager.status().await)
}
