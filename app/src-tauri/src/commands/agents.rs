use tauri::State;

use crate::engine::agents::AgentSummary;
use crate::state::AppState;

#[tauri::command]
pub async fn list_agents(state: State<'_, AppState>) -> Result<Vec<AgentSummary>, String> {
    let registry = state.agent_registry.read().await;
    Ok(registry.list().iter().map(AgentSummary::from).collect())
}

#[tauri::command]
pub async fn get_agent(
    state: State<'_, AppState>,
    name: String,
) -> Result<Option<crate::engine::agents::AgentDefinition>, String> {
    let registry = state.agent_registry.read().await;
    Ok(registry.get(&name).cloned())
}

#[tauri::command]
pub async fn save_agent(
    state: State<'_, AppState>,
    content: String,
) -> Result<(), String> {
    // Validate by parsing with the shared parser
    let def = crate::engine::agents::parse_agent_md(&content, &std::path::PathBuf::from("new"))
        .ok_or("Invalid AGENT.md format: check YAML frontmatter (must have name field)")?;

    if def.name.is_empty() {
        return Err("Agent name is required".into());
    }
    let partial_name = def.name.clone();

    // Write to custom agents directory
    let agents_dir = state.working_dir.join("agents").join(&partial_name);
    std::fs::create_dir_all(&agents_dir)
        .map_err(|e| format!("Failed to create agent directory: {e}"))?;
    std::fs::write(agents_dir.join("AGENT.md"), &content)
        .map_err(|e| format!("Failed to write AGENT.md: {e}"))?;

    // Reload registry
    let mut registry = state.agent_registry.write().await;
    registry.reload(&state.working_dir, None);

    Ok(())
}

#[tauri::command]
pub async fn delete_agent(
    state: State<'_, AppState>,
    name: String,
) -> Result<(), String> {
    let agent_dir = state.working_dir.join("agents").join(&name);
    if !agent_dir.exists() {
        return Err(format!("Custom agent '{}' not found", name));
    }
    std::fs::remove_dir_all(&agent_dir)
        .map_err(|e| format!("Failed to delete agent: {e}"))?;

    let mut registry = state.agent_registry.write().await;
    registry.reload(&state.working_dir, None);

    Ok(())
}
