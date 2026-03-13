use serde::{Deserialize, Serialize};
use tauri::State;

use crate::engine::db::HeartbeatRow;
use crate::engine::llm_client::LLMConfig;
use crate::engine::react_agent;
use crate::state::AppState;
use crate::state::config::HeartbeatConfig;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeartbeatHistoryItem {
    pub timestamp: u64,
    pub success: bool,
    pub message: Option<String>,
    pub target: String,
}

fn now_ts() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Resolve LLM config from state
async fn resolve_llm(state: &AppState) -> Option<LLMConfig> {
    let providers = state.providers.read().await;
    let active = providers.active_llm.as_ref()?;
    let all = providers.get_all_providers();
    let p = all.iter().find(|p| p.id == active.provider_id)?;
    let base_url = p
        .base_url
        .as_deref()
        .unwrap_or(&p.default_base_url)
        .to_string();
    let api_key = if let Some(custom) = providers.custom_providers.get(&active.provider_id) {
        custom.settings.api_key.clone()
    } else {
        providers
            .providers
            .get(&active.provider_id)
            .and_then(|s| s.api_key.clone())
    };
    let api_key = api_key.or_else(|| std::env::var(&p.api_key_prefix).ok())?;

    let native_tools = crate::state::providers::resolve_native_injections(&p.native_tools, &active.model);

    Some(LLMConfig {
        base_url,
        api_key,
        model: active.model.clone(),
        provider_id: active.provider_id.clone(),
        native_tools,
    })
}

#[tauri::command]
pub async fn get_heartbeat_config(state: State<'_, AppState>) -> Result<HeartbeatConfig, String> {
    let config = state.config.read().await;
    Ok(config.heartbeat.clone())
}

#[tauri::command]
pub async fn save_heartbeat_config(
    state: State<'_, AppState>,
    config: HeartbeatConfig,
) -> Result<HeartbeatConfig, String> {
    let mut app_config = state.config.write().await;
    app_config.heartbeat = config.clone();
    app_config.save(&state.working_dir)?;
    Ok(config)
}

#[tauri::command]
pub async fn send_heartbeat(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let config = state.config.read().await;
    let target = config.heartbeat.target.clone();
    drop(config);

    // Load heartbeat query
    let query_path = state.working_dir.join("HEARTBEAT.md");
    let query = if query_path.exists() {
        std::fs::read_to_string(&query_path).unwrap_or_else(|_| "heartbeat check".into())
    } else {
        "Perform a system health check and report status.".to_string()
    };

    // Try to run with agent if LLM is configured
    let (success, message) = if let Some(llm_config) = resolve_llm(&state).await {
        let prompt = react_agent::build_system_prompt(&state.working_dir, None, &[], &[], None, None, None).await;
        match tokio::time::timeout(
            std::time::Duration::from_secs(120),
            react_agent::run_react(&llm_config, &prompt, &query, &[]),
        )
        .await
        {
            Ok(Ok(result)) => (true, result),
            Ok(Err(e)) => (false, format!("Agent error: {}", e)),
            Err(_) => (false, "Heartbeat timed out (120s)".into()),
        }
    } else {
        let q_preview: String = query.chars().take(100).collect();
        (true, format!("Heartbeat sent (no LLM configured): {}", q_preview))
    };

    // Record history to database
    state.db.push_heartbeat(&HeartbeatRow {
        timestamp: now_ts() as i64,
        success,
        message: Some(message.chars().take(500).collect()),
        target: target.clone(),
    })?;

    Ok(serde_json::json!({
        "success": success,
        "message": if success { "Heartbeat sent" } else { "Heartbeat failed" }
    }))
}

#[tauri::command]
pub async fn get_heartbeat_history(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<Vec<HeartbeatHistoryItem>, String> {
    let limit = limit.unwrap_or(50);
    let rows = state.db.get_heartbeat_history(limit)?;
    Ok(rows
        .into_iter()
        .map(|r| HeartbeatHistoryItem {
            timestamp: r.timestamp as u64,
            success: r.success,
            message: r.message,
            target: r.target,
        })
        .collect())
}
