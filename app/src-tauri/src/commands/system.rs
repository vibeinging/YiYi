use serde::Serialize;
use tauri::State;

use crate::state::AppState;
use crate::state::providers::ModelInfo;

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
    pub methods: Vec<String>,
}

#[tauri::command]
pub async fn health_check() -> Result<HealthResponse, String> {
    Ok(HealthResponse {
        status: "ok".to_string(),
        version: "0.1.0".to_string(),
        methods: vec![
            "chat".into(),
            "skills".into(),
            "models".into(),
            "channels".into(),
            "cronjobs".into(),
            "heartbeat".into(),
            "mcp".into(),
            "workspace".into(),
            "shell".into(),
            "browser".into(),
            "env".into(),
        ],
    })
}

#[tauri::command]
pub async fn list_models(state: State<'_, AppState>) -> Result<Vec<ModelInfo>, String> {
    let providers = state.providers.read().await;
    let all = providers.get_all_providers();
    let models: Vec<ModelInfo> = all
        .into_iter()
        .flat_map(|p| p.models)
        .collect();
    Ok(models)
}

#[tauri::command]
pub async fn set_model(
    state: State<'_, AppState>,
    model_name: String,
) -> Result<serde_json::Value, String> {
    // Find the provider that has this model
    let mut providers = state.providers.write().await;
    let all = providers.get_all_providers();

    for p in &all {
        if p.models.iter().any(|m| m.id == model_name) {
            providers.active_llm = Some(crate::state::providers::ModelSlotConfig {
                provider_id: p.id.clone(),
                model: model_name.clone(),
            });
            providers.save()?;
            return Ok(serde_json::json!({
                "status": "ok",
                "model": model_name
            }));
        }
    }

    Err(format!("Model '{}' not found", model_name))
}

#[tauri::command]
pub async fn get_current_model(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let providers = state.providers.read().await;
    match &providers.active_llm {
        Some(slot) => Ok(serde_json::json!({
            "status": "ok",
            "model": slot.model,
            "provider_id": slot.provider_id,
        })),
        None => Ok(serde_json::json!({
            "status": "ok",
            "model": null
        })),
    }
}

/// Save agents config (language, max_iterations, etc.)
#[tauri::command]
pub async fn save_agents_config(
    state: State<'_, AppState>,
    language: Option<String>,
    max_iterations: Option<usize>,
) -> Result<(), String> {
    let mut config = state.config.write().await;
    if let Some(lang) = language {
        config.agents.language = Some(lang);
    }
    if let Some(max) = max_iterations {
        config.agents.max_iterations = Some(max);
    }
    config.save(&state.working_dir)
}

/// Get user workspace path
#[tauri::command]
pub async fn get_user_workspace(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state.user_workspace().to_string_lossy().to_string())
}

/// Set user workspace path (persisted in config)
#[tauri::command]
pub async fn set_user_workspace(
    state: State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if !p.is_absolute() {
        return Err("Workspace path must be absolute".into());
    }
    std::fs::create_dir_all(&p)
        .map_err(|e| format!("Failed to create workspace directory: {}", e))?;

    // Update runtime state immediately
    state.set_user_workspace_path(p);

    let mut config = state.config.write().await;
    config.agents.workspace_dir = Some(path);
    config.save(&state.working_dir)
}

/// Check if the initial setup wizard has been completed
#[tauri::command]
pub async fn is_setup_complete(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.db.get_config("setup_complete").is_some())
}

/// Mark the initial setup as complete
#[tauri::command]
pub async fn complete_setup(state: State<'_, AppState>) -> Result<(), String> {
    state.db.set_config("setup_complete", "true")
}
