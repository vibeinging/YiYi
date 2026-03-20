#![allow(dead_code)]
//! MCP Server: exposes local YiYi skills as an MCP-compatible JSON-RPC server.
//!
//! When `skill_server.expose_as_mcp` is true in config, this module starts
//! an HTTP server that responds to MCP protocol requests, allowing external
//! tools (other AI agents, editors, etc.) to call YiYi skills.

use axum::{extract::State as AxumState, routing::post, Json, Router};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::state::config::SkillServerConfig;

/// Represents a skill exposed as an MCP tool.
#[derive(Debug, Clone)]
pub(crate) struct ExposedSkill {
    name: String,
    description: String,
    content: String,
    path: PathBuf,
}

/// Shared state for the MCP skill server.
#[derive(Clone)]
struct ServerState {
    skills: Arc<RwLock<Vec<ExposedSkill>>>,
    working_dir: PathBuf,
}

/// JSON-RPC request envelope.
#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    jsonrpc: String,
    #[serde(default)]
    id: Option<serde_json::Value>,
    method: String,
    #[serde(default)]
    params: serde_json::Value,
}

/// JSON-RPC response envelope.
#[derive(Debug, Serialize)]
struct JsonRpcResponse {
    jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<serde_json::Value>,
}

impl JsonRpcResponse {
    fn success(id: Option<serde_json::Value>, result: serde_json::Value) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id,
            result: Some(result),
            error: None,
        }
    }

    fn error(id: Option<serde_json::Value>, code: i64, message: &str) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id,
            result: None,
            error: Some(serde_json::json!({
                "code": code,
                "message": message,
            })),
        }
    }
}

/// Load skills from the active_skills directory, filtered by config.
fn load_exposed_skills(working_dir: &Path, config: &SkillServerConfig) -> Vec<ExposedSkill> {
    let active_dir = working_dir.join("active_skills");
    let mut skills = Vec::new();

    if !active_dir.exists() {
        return skills;
    }

    let entries = match std::fs::read_dir(&active_dir) {
        Ok(e) => e,
        Err(_) => return skills,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill_md = path.join("SKILL.md");
        if !skill_md.exists() {
            continue;
        }

        let name = path.file_name().unwrap().to_string_lossy().to_string();

        // Filter by config if specific skills are listed
        if !config.skills.is_empty() && !config.skills.contains(&name) {
            continue;
        }

        let content = std::fs::read_to_string(&skill_md).unwrap_or_default();

        // Extract description from YAML frontmatter
        let description = extract_skill_description(&content).unwrap_or_else(|| {
            format!("YiYi skill: {}", name)
        });

        skills.push(ExposedSkill {
            name,
            description,
            content,
            path,
        });
    }

    skills
}

/// Extract the description field from SKILL.md YAML frontmatter.
fn extract_skill_description(content: &str) -> Option<String> {
    let trimmed = content.trim();
    if !trimmed.starts_with("---") {
        return None;
    }
    let rest = &trimmed[3..];
    let end = rest.find("---")?;
    let frontmatter = &rest[..end];
    for line in frontmatter.lines() {
        let line = line.trim();
        if let Some(desc) = line.strip_prefix("description:") {
            return Some(desc.trim().trim_matches('"').trim_matches('\'').to_string());
        }
    }
    None
}

/// Handle a JSON-RPC request from an MCP client.
async fn handle_rpc(
    AxumState(state): AxumState<ServerState>,
    Json(req): Json<JsonRpcRequest>,
) -> Json<JsonRpcResponse> {
    let response = match req.method.as_str() {
        "initialize" => {
            JsonRpcResponse::success(req.id, serde_json::json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {}
                },
                "serverInfo": {
                    "name": "yiyi-skill-server",
                    "version": "0.1.0"
                }
            }))
        }

        "notifications/initialized" => {
            // No response needed for notifications, but return empty success
            JsonRpcResponse::success(req.id, serde_json::json!({}))
        }

        "tools/list" => {
            let skills = state.skills.read().await;
            let tools: Vec<serde_json::Value> = skills
                .iter()
                .map(|s| {
                    serde_json::json!({
                        "name": format!("yiyi_skill_{}", s.name),
                        "description": s.description,
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "input": {
                                    "type": "string",
                                    "description": "Input text or instruction for the skill"
                                }
                            },
                            "required": ["input"]
                        }
                    })
                })
                .collect();

            JsonRpcResponse::success(req.id, serde_json::json!({
                "tools": tools
            }))
        }

        "tools/call" => {
            let tool_name = req.params["name"].as_str().unwrap_or("");
            let input = req.params["arguments"]["input"]
                .as_str()
                .unwrap_or("");

            // Strip the yiyi_skill_ prefix to find the skill name
            let skill_name = tool_name.strip_prefix("yiyi_skill_").unwrap_or(tool_name);

            let skills = state.skills.read().await;
            if let Some(skill) = skills.iter().find(|s| s.name == skill_name) {
                // Return the skill content + user input for the caller to process
                let result = format!(
                    "Skill: {}\nSkill Instructions:\n{}\n\nUser Input: {}",
                    skill.name, skill.content, input
                );
                JsonRpcResponse::success(req.id, serde_json::json!({
                    "content": [{
                        "type": "text",
                        "text": result
                    }]
                }))
            } else {
                JsonRpcResponse::error(
                    req.id,
                    -32601,
                    &format!("Skill '{}' not found", skill_name),
                )
            }
        }

        _ => {
            // Unknown method
            if req.id.is_some() {
                JsonRpcResponse::error(req.id, -32601, &format!("Method not found: {}", req.method))
            } else {
                // Notifications don't need a response
                JsonRpcResponse::success(None, serde_json::json!({}))
            }
        }
    };

    Json(response)
}

/// Start the MCP skill server if enabled in config.
/// Returns a handle that can be used to shut down the server.
pub async fn start_skill_server(
    working_dir: PathBuf,
    config: &SkillServerConfig,
) -> Option<tokio::task::JoinHandle<()>> {
    if !config.expose_as_mcp {
        return None;
    }

    let skills = load_exposed_skills(&working_dir, config);
    if skills.is_empty() {
        log::info!("MCP skill server: no skills to expose, not starting");
        return None;
    }

    log::info!(
        "MCP skill server: exposing {} skills on {}:{}",
        skills.len(),
        config.host,
        config.port,
    );

    let state = ServerState {
        skills: Arc::new(RwLock::new(skills)),
        working_dir,
    };

    let app = Router::new()
        .route("/", post(handle_rpc))
        .with_state(state);

    let addr = format!("{}:{}", config.host, config.port);
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            log::error!("MCP skill server: failed to bind {}: {}", addr, e);
            return None;
        }
    };

    let handle = tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            log::error!("MCP skill server error: {}", e);
        }
    });

    Some(handle)
}

/// Reload exposed skills (call after skill enable/disable changes).
#[allow(dead_code)]
pub(crate) async fn reload_exposed_skills(
    working_dir: &Path,
    config: &SkillServerConfig,
    state: &Arc<RwLock<Vec<ExposedSkill>>>,
) {
    let skills = load_exposed_skills(working_dir, config);
    let mut locked = state.write().await;
    *locked = skills;
}
