#![allow(dead_code)]
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, RwLock};

use crate::state::config::MCPClientConfig;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MCPTool {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

/// Transport type for MCP connections
enum MCPTransport {
    Stdio {
        child: Child,
        stdin_tx: tokio::sync::mpsc::Sender<String>,
        /// Pending responses keyed by request id
        pending: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<serde_json::Value>>>>,
    },
    Http {
        url: String,
        headers: HashMap<String, String>,
    },
}

struct MCPProcess {
    transport: MCPTransport,
    tools: Vec<MCPTool>,
}

pub struct MCPRuntime {
    processes: Arc<RwLock<HashMap<String, MCPProcess>>>,
}

impl MCPRuntime {
    pub fn new() -> Self {
        Self {
            processes: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Connect to a stdio MCP server
    pub async fn connect_stdio(
        &self,
        key: &str,
        config: &MCPClientConfig,
    ) -> Result<Vec<MCPTool>, String> {
        let command = config
            .command
            .as_ref()
            .ok_or("No command specified for stdio transport")?;

        let mut cmd = Command::new(command);
        cmd.args(&config.args);
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        for (k, v) in &config.env {
            cmd.env(k, v);
        }
        if let Some(cwd) = &config.cwd {
            cmd.current_dir(cwd);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn MCP process: {}", e))?;

        let mut stdin = child.stdin.take().ok_or("Failed to get stdin")?;
        let stdout = child.stdout.take().ok_or("Failed to get stdout")?;

        // Set up message channel for stdin
        let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(32);

        // Spawn stdin writer
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if stdin.write_all(msg.as_bytes()).await.is_err() {
                    break;
                }
                if stdin.write_all(b"\n").await.is_err() {
                    break;
                }
                stdin.flush().await.ok();
            }
        });

        // Pending response map: request id -> oneshot sender
        let pending: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<serde_json::Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));

        // Spawn stdout reader that routes responses to pending waiters
        let pending_clone = pending.clone();
        let key_clone = key.to_string();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) => break, // EOF
                    Ok(_) => {
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(line.trim()) {
                            // Extract id to route response
                            let id = json.get("id").and_then(|v| match v {
                                serde_json::Value::String(s) => Some(s.clone()),
                                serde_json::Value::Number(n) => Some(n.to_string()),
                                _ => None,
                            });
                            if let Some(id) = id {
                                let mut map = pending_clone.lock().await;
                                if let Some(sender) = map.remove(&id) {
                                    sender.send(json).ok();
                                }
                            }
                        }
                    }
                    Err(e) => {
                        log::warn!("MCP '{}' stdout read error: {}", key_clone, e);
                        break;
                    }
                }
            }
        });

        // Helper to send a request and wait for response
        let send_and_wait = |tx: &tokio::sync::mpsc::Sender<String>,
                             pending: &Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<serde_json::Value>>>>,
                             req: serde_json::Value,
                             timeout_secs: u64| {
            let tx = tx.clone();
            let pending = pending.clone();
            async move {
                let id = req.get("id").and_then(|v| match v {
                    serde_json::Value::String(s) => Some(s.clone()),
                    serde_json::Value::Number(n) => Some(n.to_string()),
                    _ => None,
                });
                let (resp_tx, resp_rx) = tokio::sync::oneshot::channel();
                if let Some(id) = &id {
                    pending.lock().await.insert(id.clone(), resp_tx);
                }
                tx.send(serde_json::to_string(&req).unwrap()).await.ok();
                if id.is_some() {
                    tokio::time::timeout(
                        std::time::Duration::from_secs(timeout_secs),
                        resp_rx,
                    )
                    .await
                    .ok()
                    .and_then(|r| r.ok())
                } else {
                    None
                }
            }
        };

        // Send initialize request (JSON-RPC)
        let init_req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {
                    "name": "yiclaw",
                    "version": "0.1.0"
                }
            }
        });

        let _init_resp = send_and_wait(&tx, &pending, init_req, 30).await;

        // Send initialized notification (no id, no response expected)
        let notif = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        });
        tx.send(serde_json::to_string(&notif).unwrap()).await.ok();

        // Request tools list
        let tools_req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
            "params": {}
        });

        let tools = match send_and_wait(&tx, &pending, tools_req, 10).await {
            Some(json) => parse_tools_from_json(&json),
            None => Vec::new(),
        };

        let process = MCPProcess {
            transport: MCPTransport::Stdio {
                child,
                stdin_tx: tx,
                pending,
            },
            tools: tools.clone(),
        };

        let mut processes = self.processes.write().await;
        processes.insert(key.to_string(), process);

        Ok(tools)
    }

    /// Connect to an HTTP/SSE MCP server
    pub async fn connect_http(
        &self,
        key: &str,
        config: &MCPClientConfig,
    ) -> Result<Vec<MCPTool>, String> {
        let url = config
            .url
            .as_ref()
            .ok_or("No URL specified for HTTP transport")?;

        let client = reqwest::Client::new();
        let init_req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {
                    "name": "yiclaw",
                    "version": "0.1.0"
                }
            }
        });

        let mut req = client.post(url).json(&init_req);
        for (k, v) in &config.headers {
            req = req.header(k, v);
        }

        let resp = req
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| format!("HTTP MCP init failed: {}", e))?;

        if !resp.status().is_success() {
            return Err(format!("MCP server returned {}", resp.status()));
        }

        // Send initialized notification (MCP protocol requirement)
        let notif = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        });
        let mut notif_req = client.post(url).json(&notif);
        for (k, v) in &config.headers {
            notif_req = notif_req.header(k, v);
        }
        notif_req.send().await.ok();

        // Request tools
        let tools_req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
            "params": {}
        });

        let mut req2 = client.post(url).json(&tools_req);
        for (k, v) in &config.headers {
            req2 = req2.header(k, v);
        }

        let tools = match req2
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
        {
            Ok(resp) => {
                if let Ok(json) = resp.json::<serde_json::Value>().await {
                    parse_tools_from_json(&json)
                } else {
                    Vec::new()
                }
            }
            Err(_) => Vec::new(),
        };

        let process = MCPProcess {
            transport: MCPTransport::Http {
                url: url.clone(),
                headers: config.headers.clone(),
            },
            tools: tools.clone(),
        };

        let mut processes = self.processes.write().await;
        processes.insert(key.to_string(), process);

        Ok(tools)
    }

    /// Get tools for a connected client
    pub async fn get_tools(&self, key: &str) -> Vec<MCPTool> {
        let processes = self.processes.read().await;
        processes.get(key).map_or(Vec::new(), |p| p.tools.clone())
    }

    /// Get all connected client keys
    pub async fn get_all_client_keys(&self) -> Vec<String> {
        let processes = self.processes.read().await;
        processes.keys().cloned().collect()
    }

    /// Get all tools from all connected clients
    pub async fn get_all_tools(&self) -> Vec<MCPTool> {
        let processes = self.processes.read().await;
        let mut all_tools = Vec::new();
        for process in processes.values() {
            all_tools.extend(process.tools.clone());
        }
        all_tools
    }

    /// Call a tool on a connected MCP server
    pub async fn call_tool(
        &self,
        key: &str,
        tool_name: &str,
        arguments: serde_json::Value,
    ) -> Result<String, String> {
        let processes = self.processes.read().await;
        let process = processes
            .get(key)
            .ok_or_else(|| format!("MCP client '{}' not connected", key))?;

        let request_id = uuid::Uuid::new_v4().to_string();
        let req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "tools/call",
            "params": {
                "name": tool_name,
                "arguments": arguments
            }
        });

        match &process.transport {
            MCPTransport::Stdio { stdin_tx, pending, .. } => {
                // Register a oneshot channel to receive the response
                let (resp_tx, resp_rx) = tokio::sync::oneshot::channel();
                let pending = pending.clone();
                pending.lock().await.insert(request_id.clone(), resp_tx);

                stdin_tx
                    .send(serde_json::to_string(&req).unwrap())
                    .await
                    .map_err(|e| format!("Failed to send to MCP: {}", e))?;

                // Drop the read lock before awaiting response
                drop(processes);

                // Wait for response with timeout
                match tokio::time::timeout(
                    std::time::Duration::from_secs(60),
                    resp_rx,
                )
                .await
                {
                    Ok(Ok(json)) => extract_tool_result(&json),
                    Ok(Err(_)) => Err("MCP response channel closed".into()),
                    Err(_) => {
                        // Clean up pending entry on timeout
                        pending.lock().await.remove(&request_id);
                        Err(format!("MCP tool '{}' timed out (60s)", tool_name))
                    }
                }
            }
            MCPTransport::Http { url, headers } => {
                let url = url.clone();
                let headers = headers.clone();

                // Drop the read lock before awaiting
                drop(processes);

                let client = reqwest::Client::new();
                let mut http_req = client.post(&url).json(&req);
                for (k, v) in &headers {
                    http_req = http_req.header(k, v);
                }

                let resp = http_req
                    .timeout(std::time::Duration::from_secs(60))
                    .send()
                    .await
                    .map_err(|e| format!("HTTP MCP call failed: {}", e))?;

                let json = resp
                    .json::<serde_json::Value>()
                    .await
                    .map_err(|e| format!("Failed to parse MCP response: {}", e))?;

                extract_tool_result(&json)
            }
        }
    }

    /// Disconnect a client
    pub async fn disconnect(&self, key: &str) {
        let mut processes = self.processes.write().await;
        if let Some(mut process) = processes.remove(key) {
            if let MCPTransport::Stdio { ref mut child, .. } = process.transport {
                child.kill().await.ok();
            }
        }
    }

    /// Disconnect all clients
    pub async fn disconnect_all(&self) {
        let mut processes = self.processes.write().await;
        for (_, mut process) in processes.drain() {
            if let MCPTransport::Stdio { ref mut child, .. } = process.transport {
                child.kill().await.ok();
            }
        }
    }
}

/// Extract tool result content from a JSON-RPC response.
fn extract_tool_result(json: &serde_json::Value) -> Result<String, String> {
    // Check for JSON-RPC error
    if let Some(error) = json.get("error") {
        let msg = error["message"].as_str().unwrap_or("Unknown error");
        return Err(format!("MCP error: {}", msg));
    }

    // Extract result content
    if let Some(result) = json.get("result") {
        // MCP tools/call returns { content: [{ type: "text", text: "..." }] }
        if let Some(content_arr) = result.get("content").and_then(|c| c.as_array()) {
            let parts: Vec<String> = content_arr
                .iter()
                .filter_map(|item| {
                    if item["type"].as_str() == Some("text") {
                        item["text"].as_str().map(|s| s.to_string())
                    } else {
                        None
                    }
                })
                .collect();
            if !parts.is_empty() {
                return Ok(parts.join("\n"));
            }
        }
        // Fallback: return the result as a string
        return Ok(result.to_string());
    }

    Ok(json.to_string())
}

fn parse_tools_from_json(json: &serde_json::Value) -> Vec<MCPTool> {
    let mut tools = Vec::new();
    if let Some(result) = json.get("result") {
        if let Some(tools_arr) = result.get("tools").and_then(|t| t.as_array()) {
            for tool in tools_arr {
                if let (Some(name), Some(desc)) = (
                    tool["name"].as_str(),
                    tool["description"].as_str(),
                ) {
                    tools.push(MCPTool {
                        name: name.to_string(),
                        description: desc.to_string(),
                        input_schema: tool
                            .get("inputSchema")
                            .cloned()
                            .unwrap_or(serde_json::json!({})),
                    });
                }
            }
        }
    }
    tools
}
