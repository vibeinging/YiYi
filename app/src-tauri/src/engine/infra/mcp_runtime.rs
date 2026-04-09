#![allow(dead_code)] // TODO: audit and remove dead MCP code after stabilization
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, RwLock};

use crate::state::config::MCPClientConfig;
use crate::engine::infra::mcp_lifecycle::{McpLifecycleTracker, McpPhase};

// Global MCP lifecycle tracker
static MCP_LIFECYCLE: std::sync::OnceLock<std::sync::Mutex<McpLifecycleTracker>> = std::sync::OnceLock::new();

fn lifecycle_tracker() -> &'static std::sync::Mutex<McpLifecycleTracker> {
    MCP_LIFECYCLE.get_or_init(|| std::sync::Mutex::new(McpLifecycleTracker::new()))
}

// ---------------------------------------------------------------------------
// Shared HTTP client for MCP HTTP transport — reuses connection pool & TLS
// ---------------------------------------------------------------------------

fn mcp_http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .pool_max_idle_per_host(5)
            .build()
            .expect("Failed to build MCP HTTP client")
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MCPTool {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
    /// Server key that owns this tool.
    #[serde(default)]
    pub server_key: String,
    /// Priority for sorting (inherited from MCPClientConfig). Higher = first.
    #[serde(default)]
    pub priority: i32,
}

/// Connection status for an MCP server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum MCPStatus {
    Connected,
    Disconnected,
    Error(String),
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
    status: MCPStatus,
    priority: i32,
}

/// Cached tool call result with expiration.
struct CachedResult {
    value: String,
    expires_at: Instant,
}

/// Default cache TTL: 30 seconds.
const CACHE_TTL_SECS: u64 = 30;

pub struct MCPRuntime {
    processes: Arc<RwLock<HashMap<String, MCPProcess>>>,
    /// Short-lived cache for tool call results. Key: "server_key:tool_name:args_hash".
    cache: Arc<Mutex<HashMap<String, CachedResult>>>,
}

impl MCPRuntime {
    pub fn new() -> Self {
        Self {
            processes: Arc::new(RwLock::new(HashMap::new())),
            cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Connect to a stdio MCP server
    pub async fn connect_stdio(
        &self,
        key: &str,
        config: &MCPClientConfig,
    ) -> Result<Vec<MCPTool>, String> {
        // Track lifecycle
        if let Ok(mut tracker) = lifecycle_tracker().lock() {
            tracker.transition(key, McpPhase::SpawnConnect);
        }

        let command = config
            .command
            .as_ref()
            .ok_or_else(|| {
                if let Ok(mut tracker) = lifecycle_tracker().lock() {
                    tracker.record_error(key, McpPhase::SpawnConnect, "No command specified", true);
                }
                "No command specified for stdio transport".to_string()
            })?;

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

        // Spawn stdout reader that routes responses to pending waiters.
        // Also detects EOF to mark the server as disconnected.
        let pending_clone = pending.clone();
        let key_clone = key.to_string();
        let processes_ref = self.processes.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) => {
                        // EOF — server process exited
                        log::warn!("MCP '{}' process exited (EOF)", key_clone);
                        let mut procs = processes_ref.write().await;
                        if let Some(proc) = procs.get_mut(&key_clone) {
                            proc.status = MCPStatus::Disconnected;
                        }
                        break;
                    }
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
                        let mut procs = processes_ref.write().await;
                        if let Some(proc) = procs.get_mut(&key_clone) {
                            proc.status = MCPStatus::Error(e.to_string());
                        }
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
                if let Err(e) = tx.send(serde_json::to_string(&req).unwrap()).await {
                    log::warn!("MCP send failed (channel closed): {}", e);
                    return None;
                }
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
                    "name": "yiyi",
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

        let mut tools = match send_and_wait(&tx, &pending, tools_req, 10).await {
            Some(json) => parse_tools_from_json(&json),
            None => Vec::new(),
        };

        // Tag tools with server key and priority
        for t in &mut tools {
            t.server_key = key.to_string();
            t.priority = config.priority;
        }

        let process = MCPProcess {
            transport: MCPTransport::Stdio {
                child,
                stdin_tx: tx,
                pending,
            },
            tools: tools.clone(),
            status: MCPStatus::Connected,
            priority: config.priority,
        };

        let mut processes = self.processes.write().await;
        processes.insert(key.to_string(), process);

        if let Ok(mut tracker) = lifecycle_tracker().lock() {
            tracker.transition(key, McpPhase::Ready);
        }

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

        let client = mcp_http_client();
        let init_req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {
                    "name": "yiyi",
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

        let mut tools = match req2
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

        // Tag tools with server key and priority
        for t in &mut tools {
            t.server_key = key.to_string();
            t.priority = config.priority;
        }

        let process = MCPProcess {
            transport: MCPTransport::Http {
                url: url.clone(),
                headers: config.headers.clone(),
            },
            tools: tools.clone(),
            status: MCPStatus::Connected,
            priority: config.priority,
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

    /// Get connection status for a specific client.
    pub async fn get_status(&self, key: &str) -> MCPStatus {
        let processes = self.processes.read().await;
        processes
            .get(key)
            .map(|p| p.status.clone())
            .unwrap_or(MCPStatus::Disconnected)
    }

    /// Check if a specific client is connected and healthy.
    pub async fn is_available(&self, key: &str) -> bool {
        let processes = self.processes.read().await;
        processes
            .get(key)
            .map(|p| p.status == MCPStatus::Connected)
            .unwrap_or(false)
    }

    /// Get all tools from all connected clients, sorted by priority (descending).
    /// Skips tools from servers that are disconnected or in error state.
    pub async fn get_all_tools(&self) -> Vec<MCPTool> {
        let processes = self.processes.read().await;
        let mut all_tools = Vec::new();
        for process in processes.values() {
            if process.status == MCPStatus::Connected {
                all_tools.extend(process.tools.clone());
            }
        }
        // Sort by priority descending (higher priority first)
        all_tools.sort_by(|a, b| b.priority.cmp(&a.priority));
        all_tools
    }

    /// Get all tools including status info (for diagnostics / system prompt).
    /// Returns (available_tools, unavailable_server_names).
    pub async fn get_all_tools_with_status(&self) -> (Vec<MCPTool>, Vec<String>) {
        let processes = self.processes.read().await;
        let mut available = Vec::new();
        let mut unavailable = Vec::new();
        for (key, process) in processes.iter() {
            if process.status == MCPStatus::Connected {
                available.extend(process.tools.clone());
            } else {
                unavailable.push(key.clone());
            }
        }
        available.sort_by(|a, b| b.priority.cmp(&a.priority));
        (available, unavailable)
    }

    /// Call a tool on a connected MCP server.
    /// Uses short-lived caching to avoid redundant calls within the TTL window.
    pub async fn call_tool(
        &self,
        key: &str,
        tool_name: &str,
        arguments: serde_json::Value,
    ) -> Result<String, String> {
        // Check if server is available (graceful degradation)
        {
            let processes = self.processes.read().await;
            if let Some(process) = processes.get(key) {
                match &process.status {
                    MCPStatus::Disconnected => {
                        return Err(format!(
                            "MCP server '{}' is disconnected. The tool '{}' is currently unavailable.",
                            key, tool_name
                        ));
                    }
                    MCPStatus::Error(e) => {
                        return Err(format!(
                            "MCP server '{}' is in error state ({}). The tool '{}' is currently unavailable.",
                            key, e, tool_name
                        ));
                    }
                    MCPStatus::Connected => {}
                }
            }
        }

        // Check cache
        let cache_key = build_cache_key(key, tool_name, &arguments);
        {
            let cache = self.cache.lock().await;
            if let Some(entry) = cache.get(&cache_key) {
                if entry.expires_at > Instant::now() {
                    log::debug!("MCP cache hit: {}:{}", key, tool_name);
                    return Ok(entry.value.clone());
                }
            }
        }

        // Perform the actual call
        let result = self.call_tool_uncached(key, tool_name, arguments).await;

        // On success, store in cache
        if let Ok(ref value) = result {
            let mut cache = self.cache.lock().await;
            cache.insert(
                cache_key,
                CachedResult {
                    value: value.clone(),
                    expires_at: Instant::now() + Duration::from_secs(CACHE_TTL_SECS),
                },
            );
            // Evict expired entries periodically (when cache grows large)
            if cache.len() > 200 {
                let now = Instant::now();
                cache.retain(|_, v| v.expires_at > now);
            }
        }

        // If call failed due to send error, mark server as disconnected
        if let Err(ref e) = result {
            if e.contains("Failed to send to MCP") || e.contains("channel closed") {
                let mut processes = self.processes.write().await;
                if let Some(proc) = processes.get_mut(key) {
                    proc.status = MCPStatus::Disconnected;
                    log::warn!("Marked MCP server '{}' as disconnected after call failure", key);
                }
            }
        }

        result
    }

    /// Internal uncached tool call.
    async fn call_tool_uncached(
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

                let client = mcp_http_client();
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

    /// Invalidate all cached results for a specific server.
    pub async fn invalidate_cache(&self, key: &str) {
        let prefix = format!("{}:", key);
        let mut cache = self.cache.lock().await;
        cache.retain(|k, _| !k.starts_with(&prefix));
    }

    /// Disconnect a client
    pub async fn disconnect(&self, key: &str) {
        let mut processes = self.processes.write().await;
        if let Some(mut process) = processes.remove(key) {
            if let MCPTransport::Stdio { ref mut child, .. } = process.transport {
                child.kill().await.ok();
            }
        }
        // Also clear cache for this server
        let prefix = format!("{}:", key);
        let mut cache = self.cache.lock().await;
        cache.retain(|k, _| !k.starts_with(&prefix));
    }

    /// Disconnect all clients
    pub async fn disconnect_all(&self) {
        let mut processes = self.processes.write().await;
        for (_, mut process) in processes.drain() {
            if let MCPTransport::Stdio { ref mut child, .. } = process.transport {
                child.kill().await.ok();
            }
        }
        self.cache.lock().await.clear();
    }
}

/// Build a cache key from server key, tool name, and arguments.
fn build_cache_key(server_key: &str, tool_name: &str, args: &serde_json::Value) -> String {
    // Use a simple hash of the arguments JSON for the cache key
    use std::hash::{Hash, Hasher};
    let args_str = args.to_string();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    args_str.hash(&mut hasher);
    let hash = hasher.finish();
    format!("{}:{}:{:x}", server_key, tool_name, hash)
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
                        server_key: String::new(),
                        priority: 0,
                    });
                }
            }
        }
    }
    tools
}
