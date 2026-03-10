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

/// Check if `claude` CLI is reachable. Falls back to common install paths
/// since GUI apps (launched via Finder/dock) may have a restricted PATH.
fn is_claude_cli_available() -> bool {
    let (cmd, args): (&str, &[&str]) = if cfg!(windows) {
        ("where", &["claude"])
    } else {
        ("which", &["claude"])
    };
    if std::process::Command::new(cmd)
        .args(args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        return true;
    }

    // Fallback: check common install locations (GUI apps may not inherit shell PATH)
    #[cfg(not(windows))]
    {
        let home = dirs::home_dir().unwrap_or_default();
        let candidates = [
            home.join(".npm-global/bin/claude"),
            home.join(".local/bin/claude"),
            std::path::PathBuf::from("/usr/local/bin/claude"),
            home.join(".nvm/current/bin/claude"),
        ];
        for path in &candidates {
            if path.exists() {
                return true;
            }
        }
    }

    false
}

/// Check Claude Code CLI status: installed + API key + available providers
#[tauri::command]
pub async fn check_claude_code_status(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    // 1. Check if CLI is installed (which/where + common install paths for GUI apps)
    let installed = is_claude_cli_available();

    // 2. Check ANTHROPIC_API_KEY in current process env or Claude Code config
    let has_api_key = std::env::var("ANTHROPIC_API_KEY")
        .map(|v| !v.is_empty())
        .unwrap_or(false)
        || check_claude_has_auth();

    // 3. Check if user has a configured provider that Claude Code can use
    let available_provider = if !has_api_key {
        find_usable_provider_for_claude(&state).await
    } else {
        None
    };

    Ok(serde_json::json!({
        "installed": installed,
        "has_api_key": has_api_key,
        "available_provider": available_provider,
    }))
}

/// Find a configured provider whose API key Claude Code can reuse.
/// Priority: anthropic > coding-plan > any custom provider with anthropic-compatible base URL.
async fn find_usable_provider_for_claude(
    state: &AppState,
) -> Option<serde_json::Value> {
    let providers = state.providers.read().await;
    let all = providers.get_all_providers();

    // Only Anthropic-compatible providers can work with Claude Code.
    // coding-plan (DashScope) uses OpenAI-compatible format, not Anthropic format.
    let candidates = ["anthropic"];

    for pid in candidates {
        let p = match all.iter().find(|p| p.id == pid) {
            Some(p) => p,
            None => continue,
        };

        // Try to get API key: saved settings > env var
        let api_key = providers
            .providers
            .get(pid)
            .and_then(|s| s.api_key.clone())
            .or_else(|| std::env::var(&p.api_key_prefix).ok())
            .filter(|k| !k.is_empty());

        if let Some(_key) = api_key {
            let base_url = p
                .base_url
                .as_deref()
                .unwrap_or(&p.default_base_url)
                .to_string();
            return Some(serde_json::json!({
                "id": pid,
                "name": p.name,
                "base_url": base_url,
            }));
        }
    }
    None
}

/// Check if Claude Code has valid authentication (API key or OAuth login).
fn check_claude_has_auth() -> bool {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return false,
    };

    // 1. Check ~/.claude.json for OAuth login (oauthAccount field)
    //    or API key stored in config
    if let Ok(content) = std::fs::read_to_string(home.join(".claude.json")) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
            // OAuth login: oauthAccount with accountUuid
            if json["oauthAccount"]["accountUuid"].as_str().is_some_and(|v| !v.is_empty()) {
                return true;
            }
            // API key in config
            let key = json["apiKey"].as_str()
                .or_else(|| json["api_key"].as_str());
            if key.is_some_and(|k| !k.is_empty()) {
                return true;
            }
        }
    }

    // 2. Check settings.json / config.json for API key
    let extras = [
        home.join(".claude").join("config.json"),
        home.join(".claude").join("settings.json"),
    ];
    for path in &extras {
        if let Ok(content) = std::fs::read_to_string(path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                let key = json["apiKey"].as_str()
                    .or_else(|| json["api_key"].as_str());
                if key.is_some_and(|k| !k.is_empty()) {
                    return true;
                }
            }
        }
    }

    false
}

/// Get a persistent app flag from the database
#[tauri::command]
pub async fn get_app_flag(
    state: State<'_, AppState>,
    key: String,
) -> Result<Option<String>, String> {
    Ok(state.db.get_config(&key))
}

/// Set a persistent app flag in the database
#[tauri::command]
pub async fn set_app_flag(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), String> {
    state.db.set_config(&key, &value)
}
