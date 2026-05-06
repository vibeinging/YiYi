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
        requires: Vec::new(),
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
        requires: Vec::new(),
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

// ─── Lazy-install commands ─────────────────────────────────────────────

/// Run a single user-approved install step. Streams stdout / stderr lines
/// as `mcp://install_progress` events; resolves on completion.
///
/// Frontend calls this after the user picks an InstallStep from the
/// consent dialog (e.g. "Install via Homebrew" → `brew install node`).
#[tauri::command]
pub async fn install_deps(
    app: tauri::AppHandle,
    server_id: String,
    step: crate::state::config::InstallStep,
) -> Result<(), String> {
    use crate::engine::infra::install_runner::{run_install_step, ProgressStream};
    use tauri::Emitter;

    let app_for_progress = app.clone();
    let sid = server_id.clone();
    run_install_step(&step, move |p| {
        let _ = app_for_progress.emit(
            "mcp://install_progress",
            serde_json::json!({
                "server_id": sid,
                "stream": match p.stream {
                    ProgressStream::Stdout => "stdout",
                    ProgressStream::Stderr => "stderr",
                },
                "line": p.line,
            }),
        );
    })
    .await
}

/// Re-attempt to start an MCP server after the user finished installing
/// its prerequisites. Re-checks `requires`, then dispatches stdio / http.
/// On success emits `mcp://ready`, on persistent miss re-emits
/// `mcp://needs_install`.
#[tauri::command]
pub async fn retry_mcp_server(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    server_id: String,
) -> Result<(), String> {
    use tauri::Emitter;

    let cfg = {
        let config = state.config.read().await;
        config
            .mcp
            .get(&server_id)
            .cloned()
            .ok_or_else(|| format!("MCP server '{server_id}' not found"))?
    };
    if !cfg.enabled {
        return Err(format!("MCP server '{server_id}' is disabled"));
    }

    let missing = crate::engine::infra::dep_check::missing_deps(&cfg.requires);
    if !missing.is_empty() {
        let _ = app.emit(
            "mcp://needs_install",
            serde_json::json!({
                "server_id": &server_id,
                "server_name": cfg.name,
                "missing": missing,
            }),
        );
        return Err(format!(
            "{} prerequisite(s) still missing — see install dialog",
            missing.len()
        ));
    }

    let mcp = state.mcp_runtime.clone();
    let result = match cfg.transport.as_str() {
        "stdio" => mcp.connect_stdio(&server_id, &cfg).await,
        "http" | "streamable_http" => mcp.connect_http(&server_id, &cfg).await,
        other => return Err(format!("unknown transport '{other}'")),
    };

    match result {
        Ok(tools) => {
            let _ = app.emit(
                "mcp://ready",
                serde_json::json!({
                    "server_id": &server_id,
                    "tool_count": tools.len(),
                }),
            );
            Ok(())
        }
        Err(e) => Err(e),
    }
}
