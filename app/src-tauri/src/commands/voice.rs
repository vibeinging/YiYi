use tauri::{AppHandle, Runtime, State};

use crate::engine::voice::VoiceStatus;
use crate::state::AppState;

/// Resolve an API key from the configured providers (reuses existing LLM config resolution).
async fn resolve_api_key(state: &AppState) -> Result<String, String> {
    let providers = state.providers.read().await;
    let config = crate::engine::llm_client::resolve_config_from_providers(&providers)?;
    Ok(config.api_key)
}

/// Core logic for `start_voice_session`, generic over the Tauri runtime so
/// tests can drive it with `AppHandle<MockRuntime>`.
///
/// Resolves an API key from the configured providers, then hands off to
/// `VoiceSessionManager::start` which owns the session lifecycle.
pub async fn start_voice_session_impl<R: Runtime>(
    state: &AppState,
    app: AppHandle<R>,
) -> Result<String, String> {
    let api_key = resolve_api_key(state).await?;

    let manager = state.voice_manager.read().await;
    manager.start(api_key, None, app).await
}

#[tauri::command]
pub async fn start_voice_session(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    start_voice_session_impl(&*state, app).await
}

pub async fn stop_voice_session_impl(
    state: &AppState,
) -> Result<(), String> {
    let manager = state.voice_manager.read().await;
    manager.stop().await
}

#[tauri::command]
pub async fn stop_voice_session(
    state: State<'_, AppState>,
) -> Result<(), String> {
    stop_voice_session_impl(&*state).await
}

pub async fn get_voice_status_impl(
    state: &AppState,
) -> Result<VoiceStatus, String> {
    let manager = state.voice_manager.read().await;
    Ok(manager.status().await)
}

#[tauri::command]
pub async fn get_voice_status(
    state: State<'_, AppState>,
) -> Result<VoiceStatus, String> {
    get_voice_status_impl(&*state).await
}
