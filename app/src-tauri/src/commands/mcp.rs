use serde::{Deserialize, Serialize};
use tauri::State;

use crate::state::AppState;
use crate::state::config::MCPClientConfig;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MCPClientInfo {
    pub key: String,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub transport: String,
    pub url: Option<String>,
    pub command: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MCPClientCreateRequest {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub transport: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub cwd: Option<String>,
}

fn default_true() -> bool {
    true
}

fn config_to_info(key: &str, cfg: &MCPClientConfig) -> MCPClientInfo {
    MCPClientInfo {
        key: key.to_string(),
        name: cfg.name.clone(),
        description: cfg.description.clone(),
        enabled: cfg.enabled,
        transport: cfg.transport.clone(),
        url: cfg.url.clone(),
        command: cfg.command.clone(),
        status: if cfg.enabled { "ready".into() } else { "disabled".into() },
    }
}

pub async fn list_mcp_clients_impl(
    state: &AppState,
) -> Result<Vec<MCPClientInfo>, String> {
    let config = state.config.read().await;
    let clients: Vec<MCPClientInfo> = config
        .mcp
        .iter()
        .map(|(key, cfg)| config_to_info(key, cfg))
        .collect();
    Ok(clients)
}

#[tauri::command]
pub async fn list_mcp_clients(
    state: State<'_, AppState>,
) -> Result<Vec<MCPClientInfo>, String> {
    list_mcp_clients_impl(&*state).await
}

pub async fn get_mcp_client_impl(
    state: &AppState,
    key: String,
) -> Result<MCPClientInfo, String> {
    let config = state.config.read().await;
    config
        .mcp
        .get(&key)
        .map(|cfg| config_to_info(&key, cfg))
        .ok_or_else(|| format!("MCP client '{}' not found", key))
}

#[tauri::command]
pub async fn get_mcp_client(
    state: State<'_, AppState>,
    key: String,
) -> Result<MCPClientInfo, String> {
    get_mcp_client_impl(&*state, key).await
}

pub async fn create_mcp_client_impl(
    state: &AppState,
    client_key: String,
    client: MCPClientCreateRequest,
) -> Result<MCPClientInfo, String> {
    let mut config = state.config.write().await;

    let mcp_config = MCPClientConfig {
        name: client.name,
        description: client.description,
        enabled: client.enabled,
        transport: if !client.transport.is_empty() {
            client.transport
        } else if client.url.is_some() {
            "streamable_http".into()
        } else {
            "stdio".into()
        },
        url: client.url,
        headers: Default::default(),
        command: client.command,
        args: client.args,
        env: client.env,
        cwd: client.cwd,
        skill_override: None,
        priority: 0,
    };

    config.mcp.insert(client_key.clone(), mcp_config.clone());
    config.save(&state.working_dir)?;

    Ok(config_to_info(&client_key, &mcp_config))
}

#[tauri::command]
pub async fn create_mcp_client(
    state: State<'_, AppState>,
    client_key: String,
    client: MCPClientCreateRequest,
) -> Result<MCPClientInfo, String> {
    create_mcp_client_impl(&*state, client_key, client).await
}

pub async fn update_mcp_client_impl(
    state: &AppState,
    key: String,
    client: MCPClientCreateRequest,
) -> Result<MCPClientInfo, String> {
    let mut config = state.config.write().await;

    if !config.mcp.contains_key(&key) {
        return Err(format!("MCP client '{}' not found", key));
    }

    let mcp_config = MCPClientConfig {
        name: client.name,
        description: client.description,
        enabled: client.enabled,
        transport: if !client.transport.is_empty() {
            client.transport
        } else if client.url.is_some() {
            "streamable_http".into()
        } else {
            "stdio".into()
        },
        url: client.url,
        headers: Default::default(),
        command: client.command,
        args: client.args,
        env: client.env,
        cwd: client.cwd,
        skill_override: None,
        priority: 0,
    };

    config.mcp.insert(key.clone(), mcp_config.clone());
    config.save(&state.working_dir)?;

    Ok(config_to_info(&key, &mcp_config))
}

#[tauri::command]
pub async fn update_mcp_client(
    state: State<'_, AppState>,
    key: String,
    client: MCPClientCreateRequest,
) -> Result<MCPClientInfo, String> {
    update_mcp_client_impl(&*state, key, client).await
}

pub async fn toggle_mcp_client_impl(
    state: &AppState,
    key: String,
) -> Result<MCPClientInfo, String> {
    let mut config = state.config.write().await;

    let cfg = config
        .mcp
        .get_mut(&key)
        .ok_or_else(|| format!("MCP client '{}' not found", key))?;

    cfg.enabled = !cfg.enabled;
    let info = config_to_info(&key, cfg);
    config.save(&state.working_dir)?;

    Ok(info)
}

#[tauri::command]
pub async fn toggle_mcp_client(
    state: State<'_, AppState>,
    key: String,
) -> Result<MCPClientInfo, String> {
    toggle_mcp_client_impl(&*state, key).await
}

pub async fn delete_mcp_client_impl(
    state: &AppState,
    key: String,
) -> Result<serde_json::Value, String> {
    let mut config = state.config.write().await;
    config.mcp.remove(&key);
    config.save(&state.working_dir)?;

    Ok(serde_json::json!({
        "message": format!("MCP client '{}' deleted", key)
    }))
}

#[tauri::command]
pub async fn delete_mcp_client(
    state: State<'_, AppState>,
    key: String,
) -> Result<serde_json::Value, String> {
    delete_mcp_client_impl(&*state, key).await
}
