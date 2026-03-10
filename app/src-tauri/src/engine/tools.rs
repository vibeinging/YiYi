use super::doc_tools;
use super::mcp_runtime::MCPRuntime;
use super::python_bridge;
// Playwright bridge: browser automation via external Node.js process
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tauri::Emitter;
use tokio::sync::Mutex;

/// Global MCP runtime reference for tool routing.
static MCP_RUNTIME: std::sync::OnceLock<Arc<MCPRuntime>> = std::sync::OnceLock::new();

/// Global working directory for memory_search and other tools.
static WORKING_DIR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

/// Global Tauri app handle for emitting events to the frontend.
static APP_HANDLE: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

/// Global database reference for tools that need DB access.
static DATABASE: std::sync::OnceLock<Arc<super::db::Database>> = std::sync::OnceLock::new();

/// Global scheduler reference for tools that need to register jobs at runtime.
static SCHEDULER: std::sync::OnceLock<Arc<tokio::sync::RwLock<Option<crate::engine::scheduler::CronScheduler>>>> = std::sync::OnceLock::new();

/// Global providers reference for tools that need LLM config resolution.
static PROVIDERS: std::sync::OnceLock<Arc<tokio::sync::RwLock<crate::state::providers::ProvidersState>>> = std::sync::OnceLock::new();

/// Per-task session ID for tools that need session context (e.g. send_bot_message).
/// Uses task_local so concurrent agent runs don't interfere with each other.
tokio::task_local! {
    static TASK_SESSION_ID: String;
}

/// Sandbox: session-scoped allowed paths (cleared on restart).
static SANDBOX_SESSION_PATHS: std::sync::OnceLock<Mutex<HashSet<PathBuf>>> =
    std::sync::OnceLock::new();

/// Sandbox: persistent allowed paths (saved to config).
static SANDBOX_PERSISTENT_PATHS: std::sync::OnceLock<Mutex<HashSet<PathBuf>>> =
    std::sync::OnceLock::new();

/// Sandbox: pending access requests queue (supports concurrent tool calls).
static SANDBOX_REQUESTS: std::sync::OnceLock<
    Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<SandboxResponse>>>,
> = std::sync::OnceLock::new();

/// Counter for generating unique request IDs.
static SANDBOX_REQ_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Sandbox access response from the user.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SandboxResponse {
    AllowOnce,
    AllowPermanent,
    Deny,
}

fn sandbox_session_paths() -> &'static Mutex<HashSet<PathBuf>> {
    SANDBOX_SESSION_PATHS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn sandbox_persistent_paths() -> &'static Mutex<HashSet<PathBuf>> {
    SANDBOX_PERSISTENT_PATHS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn sandbox_requests() -> &'static Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<SandboxResponse>>> {
    SANDBOX_REQUESTS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// Initialize persistent sandbox paths from saved config.
pub async fn init_sandbox_paths(paths: Vec<PathBuf>) {
    let mut persistent = sandbox_persistent_paths().lock().await;
    for p in paths {
        persistent.insert(p);
    }
}

/// Expand and canonicalize a raw path string.
fn resolve_path(raw_path: &str) -> PathBuf {
    let expanded = if raw_path == "~" {
        dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
    } else if let Some(rest) = raw_path.strip_prefix("~/") {
        dirs::home_dir().unwrap_or_default().join(rest)
    } else if raw_path == "." {
        // Resolve "." to the workspace directory, not the process cwd
        WORKING_DIR.get().cloned().unwrap_or_else(|| PathBuf::from("."))
    } else {
        PathBuf::from(raw_path)
    };
    expanded.canonicalize().unwrap_or(expanded)
}

/// Check if a path is within the sandbox (workspace or allowed paths).
/// Returns Ok(()) if allowed, or requests user permission via the frontend.
async fn sandbox_check(raw_path: &str) -> Result<(), String> {
    if raw_path.is_empty() {
        return Ok(());
    }

    let canonical = resolve_path(raw_path);

    // Always allow workspace directory
    if let Some(wd) = WORKING_DIR.get() {
        let wd_canonical = wd.canonicalize().unwrap_or(wd.clone());
        if canonical.starts_with(&wd_canonical) {
            return Ok(());
        }
    }

    // Check session + persistent allowed paths (single lock scope)
    {
        let session = sandbox_session_paths().lock().await;
        let persistent = sandbox_persistent_paths().lock().await;
        for allowed in session.iter().chain(persistent.iter()) {
            let ac = allowed.canonicalize().unwrap_or(allowed.clone());
            if canonical.starts_with(&ac) {
                return Ok(());
            }
        }
    }

    // Path not allowed — request user permission
    let handle = match APP_HANDLE.get() {
        Some(h) => h,
        None => return Err(format!("Sandbox: access denied to '{}'", raw_path)),
    };

    let req_id = format!(
        "req_{}",
        SANDBOX_REQ_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );

    let (tx, rx) = tokio::sync::oneshot::channel::<SandboxResponse>();
    {
        let mut reqs = sandbox_requests().lock().await;
        reqs.insert(req_id.clone(), tx);
    }

    // Emit event to frontend with request ID
    handle
        .emit(
            "sandbox://access_request",
            serde_json::json!({ "id": req_id, "path": raw_path }),
        )
        .map_err(|e| format!("Failed to emit sandbox event: {}", e))?;

    // Wait for user response (timeout 60s)
    let response = tokio::time::timeout(std::time::Duration::from_secs(60), rx)
        .await
        .map_err(|_| {
            // Clean up on timeout
            let req_id = req_id.clone();
            tokio::spawn(async move {
                sandbox_requests().lock().await.remove(&req_id);
            });
            format!("Sandbox: access request timed out for '{}'", raw_path)
        })?
        .map_err(|_| format!("Sandbox: access request cancelled for '{}'", raw_path))?;

    match response {
        SandboxResponse::AllowOnce => {
            let mut session = sandbox_session_paths().lock().await;
            session.insert(canonical);
            Ok(())
        }
        SandboxResponse::AllowPermanent => {
            // Add to both persistent and session
            let mut persistent = sandbox_persistent_paths().lock().await;
            persistent.insert(canonical.clone());
            drop(persistent);
            let mut session = sandbox_session_paths().lock().await;
            session.insert(canonical.clone());
            drop(session);
            // Save to database
            if let Some(db) = DATABASE.get() {
                let path_str = canonical.to_string_lossy().to_string();
                db.save_sandbox_path(&path_str).ok();
            }
            Ok(())
        }
        SandboxResponse::Deny => {
            Err(format!("Sandbox: user denied access to '{}'", raw_path))
        }
    }
}

/// Respond to a pending sandbox access request by ID (called from frontend).
pub async fn sandbox_respond(req_id: &str, response: SandboxResponse) -> Result<(), String> {
    let mut reqs = sandbox_requests().lock().await;
    if let Some(tx) = reqs.remove(req_id) {
        tx.send(response).map_err(|_| "Sandbox: response channel closed".to_string())
    } else {
        Err(format!("No pending sandbox request with id '{}'", req_id))
    }
}

/// Get all persistent sandbox paths.
pub async fn get_persistent_sandbox_paths() -> Vec<PathBuf> {
    let persistent = sandbox_persistent_paths().lock().await;
    persistent.iter().cloned().collect()
}

/// Get all sandbox-allowed paths (session + persistent) as display strings.
pub async fn get_all_sandbox_paths() -> Vec<String> {
    let session = sandbox_session_paths().lock().await;
    let persistent = sandbox_persistent_paths().lock().await;
    session
        .iter()
        .chain(persistent.iter())
        .map(|p| p.to_string_lossy().to_string())
        .collect()
}

/// Remove a persistent sandbox path.
pub async fn remove_sandbox_path(path: &str) -> Result<(), String> {
    let p = PathBuf::from(path);
    let canonical = p.canonicalize().unwrap_or(p);
    let mut persistent = sandbox_persistent_paths().lock().await;
    persistent.remove(&canonical);
    if let Some(db) = DATABASE.get() {
        db.remove_sandbox_path(&canonical.to_string_lossy()).ok();
    }
    Ok(())
}

/// Set the MCP runtime for tool execution.
pub fn set_mcp_runtime(runtime: Arc<MCPRuntime>) {
    MCP_RUNTIME.set(runtime).ok();
}

/// Set the working directory for tools that need filesystem context.
pub fn set_working_dir(dir: std::path::PathBuf) {
    WORKING_DIR.set(dir).ok();
}

/// Run a future with a session ID bound to the current task.
/// All tool calls within this future will see this session ID.
pub async fn with_session_id<F, R>(session_id: String, fut: F) -> R
where
    F: std::future::Future<Output = R>,
{
    TASK_SESSION_ID.scope(session_id, fut).await
}

/// Get the current task-local session ID. Returns empty string if not set.
fn get_current_session_id() -> String {
    TASK_SESSION_ID.try_with(|s| s.clone()).unwrap_or_default()
}

/// Set the Tauri app handle for tools that emit frontend events.
pub fn set_app_handle(handle: tauri::AppHandle) {
    APP_HANDLE.set(handle).ok();
}

/// Set the database reference for tools that need DB access.
pub fn set_database(db: Arc<super::db::Database>) {
    DATABASE.set(db).ok();
}

/// Set the global scheduler reference for tools.
pub fn set_scheduler(scheduler: Arc<tokio::sync::RwLock<Option<crate::engine::scheduler::CronScheduler>>>) {
    SCHEDULER.set(scheduler).ok();
}

/// Set the global providers reference for tools.
pub fn set_providers(providers: Arc<tokio::sync::RwLock<crate::state::providers::ProvidersState>>) {
    PROVIDERS.set(providers).ok();
}

/// Get the stored database reference (for scheduler).
pub fn get_database() -> Option<Arc<super::db::Database>> {
    DATABASE.get().cloned()
}

/// Get the stored working directory (for scheduler).
pub fn get_working_dir() -> Option<std::path::PathBuf> {
    WORKING_DIR.get().cloned()
}

/// Resolve LLM config from global providers state (public for scheduler).
pub async fn resolve_llm_config_from_globals_pub() -> Option<super::llm_client::LLMConfig> {
    resolve_llm_config_from_globals().await
}

/// Resolve LLM config from global providers state.
async fn resolve_llm_config_from_globals() -> Option<super::llm_client::LLMConfig> {
    let providers_lock = PROVIDERS.get()?;
    let providers = providers_lock.read().await;
    let active = providers.active_llm.as_ref()?;
    let all = providers.get_all_providers();
    let p = all.iter().find(|p| p.id == active.provider_id)?;
    let base_url = p.base_url.as_deref().unwrap_or(&p.default_base_url).to_string();
    let api_key = if let Some(custom) = providers.custom_providers.get(&active.provider_id) {
        custom.settings.api_key.clone()
    } else {
        providers.providers.get(&active.provider_id).and_then(|s| s.api_key.clone())
    };
    let api_key = api_key.or_else(|| std::env::var(&p.api_key_prefix).ok())?;
    Some(super::llm_client::LLMConfig {
        base_url,
        api_key,
        model: active.model.clone(),
    })
}

/// Get the stored Tauri app handle.
pub fn get_app_handle() -> Option<&'static tauri::AppHandle> {
    APP_HANDLE.get()
}

/// Convert MCP tools to agent ToolDefinitions.
/// If `skill_overrides` is provided, tools from servers with a skill_override will have
/// their description replaced by the SKILL.md content (for richer prompt context).
pub fn mcp_tools_as_definitions(
    tools: &[super::mcp_runtime::MCPTool],
    skill_overrides: &HashMap<String, String>,
) -> Vec<ToolDefinition> {
    tools
        .iter()
        .map(|t| {
            // Check if this tool's server has a skill override description
            let description = skill_overrides
                .get(&t.server_key)
                .cloned()
                .unwrap_or_else(|| t.description.clone());
            ToolDefinition {
                r#type: "function".into(),
                function: FunctionDef {
                    name: t.name.clone(),
                    description,
                    parameters: t.input_schema.clone(),
                },
            }
        })
        .collect()
}

/// Build a map of server_key -> skill override description from config and working dir.
/// Reads SKILL.md from active_skills/<skill_name> for each MCP server that has skill_override set.
pub fn build_mcp_skill_overrides(
    mcp_config: &HashMap<String, crate::state::config::MCPClientConfig>,
    working_dir: &std::path::Path,
) -> HashMap<String, String> {
    let mut overrides = HashMap::new();
    let active_dir = working_dir.join("active_skills");
    for (key, cfg) in mcp_config {
        if let Some(skill_name) = &cfg.skill_override {
            let skill_md = active_dir.join(skill_name).join("SKILL.md");
            if let Ok(content) = std::fs::read_to_string(&skill_md) {
                overrides.insert(key.clone(), content);
            }
        }
    }
    overrides
}

/// Playwright bridge state: Node.js child process + HTTP port.
struct BrowserState {
    child: tokio::process::Child,
    port: u16,
    client: reqwest::Client,
}

impl BrowserState {
    fn is_alive(&self) -> bool {
        // Check if child process still running
        if let Some(id) = self.child.id() {
            unsafe { libc::kill(id as i32, 0) == 0 }
        } else {
            false
        }
    }

    async fn shutdown(mut self) {
        // Send stop action to cleanly close browser
        let _ = self.client
            .post(format!("http://127.0.0.1:{}/action", self.port))
            .json(&serde_json::json!({"action": "stop"}))
            .timeout(std::time::Duration::from_secs(3))
            .send()
            .await;
        // Kill the Node.js process
        let _ = self.child.kill().await;
    }
}

static BROWSER_STATE: std::sync::LazyLock<Arc<Mutex<Option<BrowserState>>>> =
    std::sync::LazyLock::new(|| Arc::new(Mutex::new(None)));

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub r#type: String,
    pub function: FunctionDef,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionDef {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub r#type: String,
    pub function: FunctionCall,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionCall {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub tool_call_id: String,
    pub content: String,
    /// Base64 data URIs for images (e.g. screenshots) — fed to LLM as multimodal content.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
}

fn tool_def(name: &str, desc: &str, params: serde_json::Value) -> ToolDefinition {
    ToolDefinition {
        r#type: "function".into(),
        function: FunctionDef {
            name: name.into(),
            description: desc.into(),
            parameters: params,
        },
    }
}

/// Built-in tools available to the agent
pub fn builtin_tools() -> Vec<ToolDefinition> {
    vec![
        tool_def(
            "execute_shell",
            "Execute a shell command and return its output.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "The shell command to execute" },
                    "cwd": { "type": "string", "description": "Working directory (optional)" }
                },
                "required": ["command"]
            }),
        ),
        tool_def(
            "read_file",
            "Read the contents of a file at the given path.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to the file" }
                },
                "required": ["path"]
            }),
        ),
        tool_def(
            "write_file",
            "Write content to a file. Creates the file if it doesn't exist.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to the file" },
                    "content": { "type": "string", "description": "Content to write" }
                },
                "required": ["path", "content"]
            }),
        ),
        tool_def(
            "edit_file",
            "Replace a specific string in a file with new content. Use for targeted edits.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to the file" },
                    "old_text": { "type": "string", "description": "Text to find and replace" },
                    "new_text": { "type": "string", "description": "Replacement text" }
                },
                "required": ["path", "old_text", "new_text"]
            }),
        ),
        tool_def(
            "append_file",
            "Append content to the end of a file.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to the file" },
                    "content": { "type": "string", "description": "Content to append" }
                },
                "required": ["path", "content"]
            }),
        ),
        tool_def(
            "delete_file",
            "Delete a file or directory. Use this instead of 'rm' in shell commands for safety.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to the file or directory to delete" },
                    "recursive": { "type": "boolean", "description": "If true, delete directory and all contents (like rm -rf). Default false." }
                },
                "required": ["path"]
            }),
        ),
        tool_def(
            "list_directory",
            "List files and directories in a given path.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Directory path to list" }
                },
                "required": ["path"]
            }),
        ),
        tool_def(
            "grep_search",
            "Search for a pattern in files recursively. Returns matching lines with file paths.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "Search pattern (regex supported)" },
                    "path": { "type": "string", "description": "Directory to search in" },
                    "file_pattern": { "type": "string", "description": "File glob pattern, e.g. '*.ts' (optional)" }
                },
                "required": ["pattern", "path"]
            }),
        ),
        tool_def(
            "glob_search",
            "Find files matching a glob pattern recursively.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "Glob pattern, e.g. '**/*.rs'" },
                    "path": { "type": "string", "description": "Base directory to search from" }
                },
                "required": ["pattern", "path"]
            }),
        ),
        tool_def(
            "web_search",
            "Search the web for information. Returns search results.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search query" }
                },
                "required": ["query"]
            }),
        ),
        tool_def(
            "get_current_time",
            "Get the current date and time.",
            serde_json::json!({
                "type": "object",
                "properties": {}
            }),
        ),
        tool_def(
            "desktop_screenshot",
            "Take a screenshot of the desktop. Returns base64-encoded PNG.",
            serde_json::json!({
                "type": "object",
                "properties": {}
            }),
        ),
        tool_def(
            "browser_use",
            "Control a Chromium browser for web automation. Actions:\n\
            - start: Launch browser (headed=true for visible window)\n\
            - open: Open URL in new tab\n\
            - goto: Navigate current page to URL (no new tab)\n\
            - get_url: Get current page URL\n\
            - snapshot: Get page text content (title + body text)\n\
            - ai_snapshot: Get structured page snapshot with numbered interactive elements for AI. Returns a tree with [1] <button>Login</button> style labels. Use 'act' to interact by number. Labels are ephemeral — re-run ai_snapshot after navigation or major DOM changes.\n\
            - act: Interact with a numbered element from ai_snapshot. Provide 'element' (number), 'operation' (click/type/select). For type also provide 'text'; for select provide 'value'. If the element is not found, run ai_snapshot again.\n\
            - screenshot: Capture page as PNG image\n\
            - click: Click element by CSS selector\n\
            - type: Type text into element\n\
            - press_key: Press keyboard key (Enter, Tab, Escape, ArrowDown, etc.)\n\
            - scroll: Scroll page or scroll element into view\n\
            - wait: Wait for element to appear or wait N milliseconds\n\
            - evaluate: Execute JavaScript and return result\n\
            - find_elements: Find multiple elements and extract text/attributes\n\
            - select: Choose option in dropdown/select element\n\
            - upload: Upload file to file input element\n\
            - cookies: Get/set/delete cookies\n\
            - list_frames: List all frames/iframes on the page\n\
            - switch_frame: Switch context to a specific iframe by index or URL\n\
            - evaluate_in_frame: Execute JavaScript inside a specific iframe\n\
            - stop: Close browser",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["start", "open", "goto", "get_url", "snapshot", "ai_snapshot", "act", "screenshot",
                                 "click", "type", "press_key", "scroll", "wait", "evaluate",
                                 "find_elements", "select", "upload", "cookies",
                                 "list_frames", "switch_frame", "evaluate_in_frame", "stop"],
                        "description": "Browser action to perform"
                    },
                    "url": { "type": "string", "description": "URL for 'open'/'goto' actions" },
                    "selector": { "type": "string", "description": "CSS selector for element actions" },
                    "text": { "type": "string", "description": "Text for 'type' action" },
                    "clear": { "type": "boolean", "description": "Clear existing input value before typing (for 'type', default: false)" },
                    "headed": { "type": "boolean", "description": "Launch visible browser (for 'start', default: false)" },
                    "expression": { "type": "string", "description": "JavaScript code (for 'evaluate' / 'evaluate_in_frame')" },
                    "key": { "type": "string", "description": "Key name: Enter, Tab, Escape, Backspace, ArrowDown, etc. (for 'press_key')" },
                    "direction": { "type": "string", "enum": ["up", "down", "left", "right"], "description": "Scroll direction (default: down)" },
                    "amount": { "type": "number", "description": "Scroll pixels (default: 500)" },
                    "timeout": { "type": "number", "description": "Wait timeout in ms (default: 5000, max: 30000)" },
                    "value": { "type": "string", "description": "Option value for 'select', or cookie value for 'cookies set'" },
                    "file_path": { "type": "string", "description": "Local file path for 'upload'" },
                    "limit": { "type": "number", "description": "Max elements to return (for 'find_elements', default: 20)" },
                    "attributes": { "type": "array", "items": {"type": "string"}, "description": "Attributes to extract (for 'find_elements', e.g. [\"href\", \"class\"])" },
                    "operation": { "type": "string", "description": "For 'cookies': get/set/delete. For 'act': click/type/select (default: click)" },
                    "name": { "type": "string", "description": "Cookie name (for 'cookies')" },
                    "domain": { "type": "string", "description": "Cookie domain (for 'cookies set')" },
                    "frame_index": { "type": "number", "description": "Frame index from list_frames (for 'switch_frame' / 'evaluate_in_frame')" },
                    "frame_url": { "type": "string", "description": "Frame URL pattern to match (for 'switch_frame' / 'evaluate_in_frame')" },
                    "element": { "type": "number", "description": "Element number from ai_snapshot (for 'act' action)" }
                },
                "required": ["action"]
            }),
        ),
        // --- Python tools (embedded interpreter, no system Python needed) ---
        tool_def(
            "run_python",
            "Execute Python code using the embedded interpreter. Output is captured and returned. Use for complex data processing, library calls, etc.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "code": { "type": "string", "description": "Python code to execute" }
                },
                "required": ["code"]
            }),
        ),
        tool_def(
            "run_python_script",
            "Execute a Python script file using the embedded interpreter. Script output is captured.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "script_path": { "type": "string", "description": "Absolute path to the .py file" },
                    "args": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Command-line arguments for the script (optional)"
                    }
                },
                "required": ["script_path"]
            }),
        ),
        tool_def(
            "pip_install",
            "Install Python packages using pip. Packages are installed to the user's local directory (~/.yiclaw/python_packages/).",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "packages": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Package names to install, e.g. [\"requests\", \"beautifulsoup4\"]"
                    }
                },
                "required": ["packages"]
            }),
        ),
        // --- Document tools (native, no Python/Node.js needed) ---
        tool_def(
            "read_pdf",
            "Extract text content from a PDF file. No external dependencies needed.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to the PDF file" }
                },
                "required": ["path"]
            }),
        ),
        tool_def(
            "read_spreadsheet",
            "Read data from Excel (.xlsx/.xls) or CSV/TSV files. Returns tabular text.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to the spreadsheet file" },
                    "sheet": { "type": "string", "description": "Sheet name (optional, defaults to first sheet)" },
                    "max_rows": { "type": "integer", "description": "Maximum rows to return (default: 200)" }
                },
                "required": ["path"]
            }),
        ),
        tool_def(
            "create_spreadsheet",
            "Create an Excel (.xlsx) file from tabular data. Data is a JSON array of arrays (first row = headers).",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Output file path (should end with .xlsx)" },
                    "data": { "type": "array", "description": "Array of arrays, e.g. [[\"Name\",\"Age\"],[\"Alice\",30]]" },
                    "sheet_name": { "type": "string", "description": "Sheet name (optional)" }
                },
                "required": ["path", "data"]
            }),
        ),
        tool_def(
            "read_docx",
            "Extract text content from a Word (.docx) file. No external dependencies needed.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to the DOCX file" }
                },
                "required": ["path"]
            }),
        ),
        tool_def(
            "create_docx",
            "Create a Word (.docx) file from text content. Supports Markdown-style headings (# ## ###) and bullet lists (- *).",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Output file path (should end with .docx)" },
                    "content": { "type": "string", "description": "Text content with optional Markdown formatting" }
                },
                "required": ["path", "content"]
            }),
        ),
        tool_def(
            "memory_add",
            "Add a memory entry to the persistent knowledge store. Use this to save important facts, user preferences, project decisions, or experiences that should be remembered across conversations. Each memory has a category for organization.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "content": { "type": "string", "description": "The memory content to store" },
                    "category": { "type": "string", "enum": ["fact", "preference", "experience", "decision", "note"], "description": "Category of the memory (default: fact). fact=factual info, preference=user likes/dislikes, experience=lessons learned, decision=choices made, note=general notes" }
                },
                "required": ["content"]
            }),
        ),
        tool_def(
            "memory_search",
            "Search stored memories using full-text search with BM25 relevance ranking. Supports Chinese and English. Use before answering questions about prior work, decisions, preferences, or past conversations.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search query (keywords or phrases, supports Chinese and English)" },
                    "category": { "type": "string", "enum": ["fact", "preference", "experience", "decision", "note"], "description": "Optional: filter by category" },
                    "max_results": { "type": "integer", "description": "Maximum results to return (default: 10)" }
                },
                "required": ["query"]
            }),
        ),
        tool_def(
            "memory_delete",
            "Delete a specific memory entry by its ID. Use memory_search or memory_list first to find the ID.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "The memory ID to delete" }
                },
                "required": ["id"]
            }),
        ),
        tool_def(
            "memory_list",
            "List stored memories, optionally filtered by category. Shows content, category, and timestamps.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "category": { "type": "string", "enum": ["fact", "preference", "experience", "decision", "note"], "description": "Optional: filter by category" },
                    "limit": { "type": "integer", "description": "Maximum entries to return (default: 20)" },
                    "offset": { "type": "integer", "description": "Number of entries to skip (default: 0, for pagination)" }
                }
            }),
        ),
        tool_def(
            "manage_cronjob",
            "Create, list, or delete scheduled tasks. Supports three schedule types:\n\
            - 'delay': one-time task after N minutes (e.g., remind in 5 minutes). Use delay_minutes.\n\
            - 'once': one-time task at a specific time (ISO 8601). Use schedule_at.\n\
            - 'cron': recurring task with cron expression (6 fields: sec min hour day month weekday).\n\
            For one-time reminders like '5分钟后提醒我', use schedule_type='delay' with delay_minutes=5.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["create", "list", "delete"],
                        "description": "Action to perform"
                    },
                    "name": { "type": "string", "description": "Human-readable name for the job (for create)" },
                    "schedule_type": {
                        "type": "string",
                        "enum": ["cron", "delay", "once"],
                        "description": "Schedule type: 'delay' for one-time after N minutes, 'once' for specific time, 'cron' for recurring"
                    },
                    "cron": { "type": "string", "description": "Cron expression with 6 fields: sec min hour day month weekday (only for schedule_type='cron')" },
                    "delay_minutes": { "type": "number", "description": "Minutes to delay before execution (only for schedule_type='delay')" },
                    "schedule_at": { "type": "string", "description": "ISO 8601 datetime for one-time execution (only for schedule_type='once', e.g. '2026-03-09T21:44:00+08:00')" },
                    "text": { "type": "string", "description": "Task content: notification text for 'notify', or prompt/instruction for 'agent'" },
                    "task_type": { "type": "string", "enum": ["notify", "agent"], "description": "Task type: 'notify' for simple reminder/notification (no AI), 'agent' for AI-driven execution" },
                    "id": { "type": "string", "description": "Job ID (for delete)" }
                },
                "required": ["action"]
            }),
        ),
        tool_def(
            "send_notification",
            "Send a macOS system notification to the user immediately.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Notification title" },
                    "body": { "type": "string", "description": "Notification body text" }
                },
                "required": ["title", "body"]
            }),
        ),
        tool_def(
            "add_calendar_event",
            "Add an event or reminder to the system calendar. Cross-platform: opens in Calendar (macOS), Outlook (Windows), or default calendar app (Linux). \
            Best for long-term reminders (hours/days/weeks away). For short delays (< 30 min), prefer manage_cronjob with delay type.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Event title" },
                    "description": { "type": "string", "description": "Event description/notes (optional)" },
                    "start_time": { "type": "string", "description": "Start time in ISO 8601 format (e.g. '2026-03-10T09:00:00+08:00')" },
                    "end_time": { "type": "string", "description": "End time in ISO 8601 (optional, defaults to start_time + 15min for reminders)" },
                    "reminder_minutes": { "type": "integer", "description": "Reminder alert N minutes before event (default: 5)" },
                    "all_day": { "type": "boolean", "description": "Whether this is an all-day event (default: false)" }
                },
                "required": ["title", "start_time"]
            }),
        ),
        tool_def(
            "list_bound_bots",
            "List bots bound to the current chat session. Call this FIRST to discover which bots are available before sending messages. Returns bot names, platforms, and IDs. Bot information is stored in the database, NOT in config files — never try to read config files for bot info.",
            serde_json::json!({
                "type": "object",
                "properties": {},
                "required": []
            }),
        ),
        tool_def(
            "send_bot_message",
            "Send a message through a bot bound to the current session. Use this when the user asks you to send a message to an external platform (Discord, Telegram, Feishu, DingTalk, etc.). Call list_bound_bots first if you don't know which bots are available. If bot_id is not specified and only one bot is bound, it will be used automatically.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "target": { "type": "string", "description": "Target ID: channel ID, group ID, or user ID on the platform" },
                    "content": { "type": "string", "description": "Message content to send" },
                    "bot_id": { "type": "string", "description": "Bot ID to use (optional if only one bot is bound to the session)" }
                },
                "required": ["target", "content"]
            }),
        ),
        tool_def(
            "manage_skill",
            "Manage AI skills: create, list, enable, disable, or delete skills.\n\
            - create: Generate a new custom skill from a name and SKILL.md content. The content must include YAML frontmatter (name, description, metadata with emoji) and Markdown instructions.\n\
            - list: List all available skills with their status.\n\
            - enable: Enable a skill by name.\n\
            - disable: Disable a skill by name.\n\
            - delete: Delete a custom skill by name.\n\
            Use this when the user asks to create, manage, or configure skills/abilities.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["create", "list", "enable", "disable", "delete"],
                        "description": "Action to perform"
                    },
                    "name": { "type": "string", "description": "Skill name (lowercase, alphanumeric with hyphens/underscores). Required for create/enable/disable/delete." },
                    "content": { "type": "string", "description": "Full SKILL.md content including YAML frontmatter and Markdown instructions. Required for create." }
                },
                "required": ["action"]
            }),
        ),
        tool_def(
            "claude_code",
            "Delegate a coding task to Claude Code CLI. Claude Code provides powerful code understanding, editing, searching, and terminal capabilities. \
            Use this for complex coding tasks like multi-file refactoring, feature implementation, debugging, and code analysis. \
            Session continuity is automatic — multiple calls within the same chat session share context.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "prompt": {
                        "type": "string",
                        "description": "The coding task description. Be specific about what to do, which files/directories to work with."
                    },
                    "working_dir": {
                        "type": "string",
                        "description": "Working directory for Claude Code. Defaults to user workspace if not specified."
                    },
                    "continue_session": {
                        "type": "boolean",
                        "description": "If true, continue the previous Claude Code session for this chat (maintains full context). Default true."
                    },
                    "context": {
                        "type": "string",
                        "description": "Additional context to prepend to the prompt. Use this to pass relevant skill instructions, project conventions, user preferences, or conversation summary to Claude Code."
                    },
                    "timeout_secs": {
                        "type": "integer",
                        "description": "Timeout in seconds. Default 300 (5 minutes)."
                    }
                },
                "required": ["prompt"]
            }),
        ),
        tool_def(
            "manage_bot",
            "Manage platform bots (Discord, Telegram, QQ, DingTalk, Feishu, WeCom, Webhook). \
            Use this to create, list, update, enable, disable, or delete bots.\n\
            Supported platforms and their required config fields:\n\
            - discord: bot_token\n\
            - telegram: bot_token\n\
            - qq: app_id, client_secret\n\
            - dingtalk: webhook_url, secret\n\
            - feishu: app_id, app_secret, webhook_url\n\
            - wecom: corp_id, corp_secret, agent_id\n\
            - webhook: webhook_url, port\n\
            When user asks to add a bot, use browser_use to guide them through the platform's developer console \
            to obtain credentials, then create the bot with this tool.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["create", "list", "update", "delete", "enable", "disable", "start", "stop"],
                        "description": "Action to perform"
                    },
                    "platform": {
                        "type": "string",
                        "enum": ["discord", "telegram", "qq", "dingtalk", "feishu", "wecom", "webhook"],
                        "description": "Platform type (required for create)"
                    },
                    "name": { "type": "string", "description": "Bot display name (required for create)" },
                    "config": {
                        "type": "object",
                        "description": "Platform-specific config (required for create/update). E.g. {\"app_id\": \"cli_xxx\", \"app_secret\": \"xxx\"}"
                    },
                    "bot_id": { "type": "string", "description": "Bot ID (required for update/delete/enable/disable)" }
                },
                "required": ["action"]
            }),
        ),
        tool_def(
            "send_file_to_user",
            "Send a file to the user. In the desktop app, this triggers a save dialog so the user can download/save the file. Use this after creating a file that the user needs.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to the file to send" },
                    "filename": { "type": "string", "description": "Suggested filename for the user (optional, defaults to original filename)" },
                    "description": { "type": "string", "description": "Brief description of the file (optional)" }
                },
                "required": ["path"]
            }),
        ),
    ]
}

/// Execute a tool call and return the result
pub async fn execute_tool(call: &ToolCall) -> ToolResult {
    let args: serde_json::Value = serde_json::from_str(&call.function.arguments)
        .unwrap_or(serde_json::Value::Null);

    let content = match call.function.name.as_str() {
        "execute_shell" => execute_shell_tool(&args).await,
        "read_file" => read_file_tool(&args).await,
        "write_file" => write_file_tool(&args).await,
        "edit_file" => edit_file_tool(&args).await,
        "append_file" => append_file_tool(&args).await,
        "delete_file" => delete_file_tool(&args).await,
        "list_directory" => list_directory_tool(&args).await,
        "grep_search" => grep_search_tool(&args).await,
        "glob_search" => glob_search_tool(&args).await,
        "web_search" => web_search_tool(&args).await,
        "get_current_time" => get_current_time_tool().await,
        "desktop_screenshot" => {
            let result = desktop_screenshot_tool().await;
            // If result contains base64 image data, extract it
            if result.contains("data:image/png;base64,") {
                if let Some(start) = result.find("data:image/png;base64,") {
                    let data_uri = result[start..].split_whitespace().next().unwrap_or("").to_string();
                    return ToolResult {
                        tool_call_id: call.id.clone(),
                        content: "Desktop screenshot captured.".into(),
                        images: vec![data_uri],
                    };
                }
            }
            result
        }
        "browser_use" => {
            let (content, images) = browser_use_tool(&args).await;
            return ToolResult {
                tool_call_id: call.id.clone(),
                content,
                images,
            };
        }
        "run_python" => run_python_tool(&args).await,
        "run_python_script" => run_python_script_tool(&args).await,
        "pip_install" => pip_install_tool(&args).await,
        "read_pdf" => {
            let path = args["path"].as_str().unwrap_or("");
            if let Err(e) = sandbox_check(path).await {
                format!("Error: {}", e)
            } else {
                doc_tools::read_pdf_text(path)
            }
        }
        "read_spreadsheet" => {
            let path = args["path"].as_str().unwrap_or("");
            if let Err(e) = sandbox_check(path).await {
                format!("Error: {}", e)
            } else {
                let sheet = args["sheet"].as_str();
                let max_rows = args["max_rows"].as_u64().map(|n| n as usize);
                doc_tools::read_spreadsheet(path, sheet, max_rows)
            }
        }
        "create_spreadsheet" => {
            let path = args["path"].as_str().unwrap_or("");
            if let Err(e) = sandbox_check(path).await {
                format!("Error: {}", e)
            } else {
                let data = &args["data"];
                let sheet_name = args["sheet_name"].as_str();
                doc_tools::create_spreadsheet(path, data, sheet_name)
            }
        }
        "read_docx" => {
            let path = args["path"].as_str().unwrap_or("");
            if let Err(e) = sandbox_check(path).await {
                format!("Error: {}", e)
            } else {
                doc_tools::read_docx_text(path)
            }
        }
        "create_docx" => {
            let path = args["path"].as_str().unwrap_or("");
            if let Err(e) = sandbox_check(path).await {
                format!("Error: {}", e)
            } else {
                let content = args["content"].as_str().unwrap_or("");
                doc_tools::create_docx(path, content)
            }
        }
        "memory_add" => memory_add_tool(&args).await,
        "memory_search" => memory_search_tool(&args).await,
        "memory_delete" => memory_delete_tool(&args).await,
        "memory_list" => memory_list_tool(&args).await,
        "manage_cronjob" => manage_cronjob_tool(&args).await,
        "list_bound_bots" => list_bound_bots_tool().await,
        "manage_skill" => manage_skill_tool(&args).await,
        "send_bot_message" => send_bot_message_tool(&args).await,
        "manage_bot" => manage_bot_tool(&args).await,
        "send_notification" => send_notification_tool(&args),
        "add_calendar_event" => add_calendar_event_tool(&args).await,
        "claude_code" => claude_code_tool(&args).await,
        "send_file_to_user" => send_file_to_user_tool(&args).await,
        _ => {
            // Try MCP runtime for unknown tools
            if let Some(runtime) = MCP_RUNTIME.get() {
                match try_mcp_tool(runtime, &call.function.name, &args).await {
                    Some(result) => result,
                    None => format!("Unknown tool: {}", call.function.name),
                }
            } else {
                format!("Unknown tool: {}", call.function.name)
            }
        }
    };

    ToolResult {
        tool_call_id: call.id.clone(),
        content,
        images: vec![],
    }
}

/// Check if a shell command matches dangerous patterns.
/// Normalizes whitespace for loose matching to catch variations like `rm  -rf  /`.
fn check_dangerous_command(command: &str) -> Result<(), String> {
    // Normalize: trim, lowercase, collapse whitespace
    let normalized: String = command
        .trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    let dangerous: &[(&str, &str)] = &[
        ("rm -rf /", "rm -rf /"),
        ("rm -rf /*", "rm -rf /*"),
        ("rm -r -f /", "rm -rf /"),
        ("rm -rf ~", "rm -rf ~"),
        ("rm -r -f ~", "rm -rf ~"),
        ("mkfs.", "mkfs (format disk)"),
        ("dd if=/dev/zero of=/dev/", "dd write to device"),
        (":(){ :|:& };:", "fork bomb"),
        ("> /dev/sd", "write to raw device"),
        ("chmod -r 777 /", "chmod 777 /"),
    ];

    for (pattern, label) in dangerous {
        if normalized.contains(pattern) {
            return Err(format!(
                "Blocked: command matches dangerous pattern ({}). This operation could cause irreversible damage.",
                label
            ));
        }
    }
    Ok(())
}

async fn execute_shell_tool(args: &serde_json::Value) -> String {
    let command = args["command"].as_str().unwrap_or("");
    let cwd = args["cwd"].as_str();

    if command.is_empty() {
        return "Error: command is required".into();
    }

    // Block obviously dangerous commands
    if let Err(e) = check_dangerous_command(command) {
        return format!("Error: {}", e);
    }

    // Working directory priority: explicit cwd > workspace default
    // Note: cwd is not sandbox-gated because shell commands can access any path
    // in the command body anyway. The sandbox boundary is enforced via system prompt
    // and file-level tool checks. Defaulting to workspace is the key safety measure.
    let effective_cwd = match cwd {
        Some(dir) => Some(dir.to_string()),
        None => WORKING_DIR.get().map(|p| p.to_string_lossy().to_string()),
    };

    let mut cmd = tokio::process::Command::new("sh");
    cmd.arg("-c").arg(command);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    if let Some(dir) = &effective_cwd {
        cmd.current_dir(dir);
    }

    match cmd.output().await {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let code = output.status.code().unwrap_or(-1);

            if code == 0 {
                let s = stdout.to_string();
                if s.is_empty() {
                    "(completed with no output)".into()
                } else {
                    truncate_output(&s, 8000)
                }
            } else {
                format!("Exit code: {}\nstdout: {}\nstderr: {}", code, stdout, stderr)
            }
        }
        Err(e) => format!("Failed to execute: {}", e),
    }
}

async fn read_file_tool(args: &serde_json::Value) -> String {
    let path = args["path"].as_str().unwrap_or("");
    if path.is_empty() {
        return "Error: path is required".into();
    }
    if let Err(e) = sandbox_check(path).await {
        return format!("Error: {}", e);
    }
    match tokio::fs::read_to_string(path).await {
        Ok(content) => truncate_output(&content, 10000),
        Err(e) => format!("Error reading file: {}", e),
    }
}

async fn write_file_tool(args: &serde_json::Value) -> String {
    let path = args["path"].as_str().unwrap_or("");
    let content = args["content"].as_str().unwrap_or("");
    if path.is_empty() {
        return "Error: path is required".into();
    }
    if let Err(e) = sandbox_check(path).await {
        return format!("Error: {}", e);
    }
    if let Some(parent) = std::path::Path::new(path).parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }
    match tokio::fs::write(path, content).await {
        Ok(_) => format!("Wrote {} bytes to {}", content.len(), path),
        Err(e) => format!("Error writing file: {}", e),
    }
}

async fn edit_file_tool(args: &serde_json::Value) -> String {
    let path = args["path"].as_str().unwrap_or("");
    let old_text = args["old_text"].as_str().unwrap_or("");
    let new_text = args["new_text"].as_str().unwrap_or("");

    if path.is_empty() || old_text.is_empty() {
        return "Error: path and old_text are required".into();
    }
    if let Err(e) = sandbox_check(path).await {
        return format!("Error: {}", e);
    }

    match tokio::fs::read_to_string(path).await {
        Ok(content) => {
            if !content.contains(old_text) {
                return format!("Error: old_text not found in {}", path);
            }
            let new_content = content.replacen(old_text, new_text, 1);
            match tokio::fs::write(path, &new_content).await {
                Ok(_) => format!("Edited {} successfully", path),
                Err(e) => format!("Error writing: {}", e),
            }
        }
        Err(e) => format!("Error reading: {}", e),
    }
}

async fn append_file_tool(args: &serde_json::Value) -> String {
    let path = args["path"].as_str().unwrap_or("");
    let content = args["content"].as_str().unwrap_or("");

    if path.is_empty() {
        return "Error: path is required".into();
    }
    if let Err(e) = sandbox_check(path).await {
        return format!("Error: {}", e);
    }

    use tokio::io::AsyncWriteExt;
    match tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await
    {
        Ok(mut file) => match file.write_all(content.as_bytes()).await {
            Ok(_) => format!("Appended {} bytes to {}", content.len(), path),
            Err(e) => format!("Error appending: {}", e),
        },
        Err(e) => format!("Error opening file: {}", e),
    }
}

async fn delete_file_tool(args: &serde_json::Value) -> String {
    let path = args["path"].as_str().unwrap_or("");
    let recursive = args["recursive"].as_bool().unwrap_or(false);

    if path.is_empty() {
        return "Error: path is required".into();
    }

    // Sandbox check — will prompt user if outside workspace
    if let Err(e) = sandbox_check(path).await {
        return format!("Error: {}", e);
    }

    let resolved = resolve_path(path);

    // Safety: block deletion of critical system paths
    let blocked = ["/", "/usr", "/bin", "/sbin", "/etc", "/var", "/tmp", "/System", "/Library", "/Applications"];
    let resolved_str = resolved.to_string_lossy();
    for b in &blocked {
        if resolved_str == *b {
            return format!("Error: refusing to delete system path '{}'", b);
        }
    }

    // Check existence
    let metadata = match tokio::fs::metadata(&resolved).await {
        Ok(m) => m,
        Err(e) => return format!("Error: '{}' not found: {}", path, e),
    };

    if metadata.is_dir() {
        if !recursive {
            return format!(
                "Error: '{}' is a directory. Set recursive=true to delete it and all its contents.",
                path
            );
        }
        match tokio::fs::remove_dir_all(&resolved).await {
            Ok(_) => format!("Deleted directory '{}'", path),
            Err(e) => format!("Error deleting directory: {}", e),
        }
    } else {
        match tokio::fs::remove_file(&resolved).await {
            Ok(_) => format!("Deleted file '{}'", path),
            Err(e) => format!("Error deleting file: {}", e),
        }
    }
}

async fn list_directory_tool(args: &serde_json::Value) -> String {
    let path = args["path"].as_str().unwrap_or(".");
    if let Err(e) = sandbox_check(path).await {
        return format!("Error: {}", e);
    }

    match tokio::fs::read_dir(path).await {
        Ok(mut entries) => {
            let mut items = Vec::new();
            while let Ok(Some(entry)) = entries.next_entry().await {
                let name = entry.file_name().to_string_lossy().to_string();
                let meta = entry.metadata().await.ok();
                let is_dir = meta.as_ref().map_or(false, |m| m.is_dir());
                let size = meta.as_ref().map_or(0, |m| m.len());
                if is_dir {
                    items.push(format!("  [DIR] {}/", name));
                } else {
                    items.push(format!("  {} ({} bytes)", name, size));
                }
            }
            if items.is_empty() {
                format!("{}: (empty)", path)
            } else {
                format!("{}:\n{}", path, items.join("\n"))
            }
        }
        Err(e) => format!("Error: {}", e),
    }
}

async fn grep_search_tool(args: &serde_json::Value) -> String {
    let pattern = args["pattern"].as_str().unwrap_or("");
    let path = args["path"].as_str().unwrap_or(".");
    let file_pattern = args["file_pattern"].as_str();

    if pattern.is_empty() {
        return "Error: pattern is required".into();
    }
    if let Err(e) = sandbox_check(path).await {
        return format!("Error: {}", e);
    }

    // Use grep command for robustness
    let mut cmd_str = format!("grep -rn --include='*' '{}' '{}'", pattern, path);
    if let Some(fp) = file_pattern {
        cmd_str = format!("grep -rn --include='{}' '{}' '{}'", fp, pattern, path);
    }

    let mut cmd = tokio::process::Command::new("sh");
    cmd.arg("-c").arg(&cmd_str);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    match cmd.output().await {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            if stdout.is_empty() {
                format!("No matches found for '{}' in {}", pattern, path)
            } else {
                truncate_output(&stdout, 8000)
            }
        }
        Err(e) => format!("Error: {}", e),
    }
}

async fn glob_search_tool(args: &serde_json::Value) -> String {
    let pattern = args["pattern"].as_str().unwrap_or("");
    let path = args["path"].as_str().unwrap_or(".");

    if pattern.is_empty() {
        return "Error: pattern is required".into();
    }
    if let Err(e) = sandbox_check(path).await {
        return format!("Error: {}", e);
    }

    let full_pattern = format!("{}/{}", path, pattern);
    match glob::glob(&full_pattern) {
        Ok(paths) => {
            let mut results = Vec::new();
            for entry in paths.flatten() {
                results.push(entry.to_string_lossy().to_string());
                if results.len() >= 200 {
                    results.push("...(truncated at 200 results)".into());
                    break;
                }
            }
            if results.is_empty() {
                format!("No files found matching '{}' in {}", pattern, path)
            } else {
                results.join("\n")
            }
        }
        Err(e) => format!("Invalid glob pattern: {}", e),
    }
}

async fn web_search_tool(args: &serde_json::Value) -> String {
    let query = args["query"].as_str().unwrap_or("");
    if query.is_empty() {
        return "Error: query is required".into();
    }

    if let Ok(api_key) = std::env::var("TAVILY_API_KEY") {
        let client = reqwest::Client::new();
        let body = serde_json::json!({
            "api_key": api_key,
            "query": query,
            "max_results": 5
        });

        match client
            .post("https://api.tavily.com/search")
            .json(&body)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
        {
            Ok(resp) => {
                if let Ok(json) = resp.json::<serde_json::Value>().await {
                    if let Some(results) = json["results"].as_array() {
                        let formatted: Vec<String> = results
                            .iter()
                            .enumerate()
                            .map(|(i, r)| {
                                format!(
                                    "{}. {}\n   {}\n   URL: {}",
                                    i + 1,
                                    r["title"].as_str().unwrap_or(""),
                                    r["content"]
                                        .as_str()
                                        .unwrap_or("")
                                        .chars()
                                        .take(200)
                                        .collect::<String>(),
                                    r["url"].as_str().unwrap_or("")
                                )
                            })
                            .collect();
                        return formatted.join("\n\n");
                    }
                }
                "Search returned no results".into()
            }
            Err(e) => format!("Search failed: {}", e),
        }
    } else {
        format!(
            "Web search unavailable (no TAVILY_API_KEY). Query: {}",
            query
        )
    }
}

async fn get_current_time_tool() -> String {
    let now = chrono::Local::now();
    format!(
        "Current time: {}\nTimezone: {}",
        now.format("%Y-%m-%d %H:%M:%S"),
        now.format("%Z")
    )
}

async fn desktop_screenshot_tool() -> String {
    // Use macOS screencapture command
    let tmp = format!("/tmp/yiclaw_screenshot_{}.png", uuid::Uuid::new_v4());

    let mut cmd = tokio::process::Command::new("screencapture");
    cmd.args(["-x", &tmp]);

    match cmd.output().await {
        Ok(output) => {
            if output.status.success() {
                match tokio::fs::read(&tmp).await {
                    Ok(data) => {
                        tokio::fs::remove_file(&tmp).await.ok();
                        use base64::Engine;
                        let b64 =
                            base64::engine::general_purpose::STANDARD.encode(&data);
                        format!(
                            "Screenshot captured ({} bytes). Base64 data: data:image/png;base64,{}",
                            data.len(),
                            &b64[..b64.len().min(200)]
                        )
                    }
                    Err(e) => format!("Failed to read screenshot: {}", e),
                }
            } else {
                "Screenshot command failed".into()
            }
        }
        Err(e) => format!("Failed to take screenshot: {}", e),
    }
}

/// Helper: if browser state exists but is dead, clean it up and set to None.
async fn cleanup_dead_browser() {
    let mut state_lock = BROWSER_STATE.lock().await;
    let is_dead = state_lock.as_ref().map_or(false, |s| !s.is_alive());
    if is_dead {
        if let Some(state) = state_lock.take() {
            log::warn!("Playwright bridge process died, cleaning up");
            state.shutdown().await;
        }
    }
}

/// Resolve the path to the playwright-bridge server.js script.
fn playwright_bridge_script() -> String {
    // In dev, it's relative to the src-tauri directory
    let dev_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("playwright-bridge")
        .join("server.js");
    if dev_path.exists() {
        return dev_path.to_string_lossy().to_string();
    }
    // In production bundle, look in resource dir
    if let Some(app) = APP_HANDLE.get() {
        use tauri::Manager;
        if let Ok(resource_dir) = app.path().resource_dir() {
            let bundled: std::path::PathBuf = resource_dir.join("playwright-bridge").join("server.js");
            if bundled.exists() {
                return bundled.to_string_lossy().to_string();
            }
        }
    }
    dev_path.to_string_lossy().to_string()
}

/// Response from the Playwright bridge.
#[derive(Debug, Deserialize, Default)]
struct BridgeResponse {
    text: String,
    #[serde(default)]
    images: Vec<String>,
}

/// Returns (text_content, image_data_uris).
async fn browser_use_tool(args: &serde_json::Value) -> (String, Vec<String>) {
    let action = args["action"].as_str().unwrap_or("");

    // "start" needs special handling: launch the bridge process
    if action == "start" {
        let mut state_lock = BROWSER_STATE.lock().await;
        // Shut down old bridge if any
        if let Some(old) = state_lock.take() {
            log::info!("Shutting down previous Playwright bridge");
            old.shutdown().await;
        }

        let script_path = playwright_bridge_script();
        log::info!("Launching Playwright bridge: {}", script_path);

        let mut child = match tokio::process::Command::new("node")
            .arg(&script_path)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(c) => c,
            Err(e) => return (format!("Failed to start Playwright bridge: {}. Make sure Node.js is installed.", e), vec![]),
        };

        // Read stdout until we get READY:{port}
        let stdout = child.stdout.take().unwrap();
        let mut reader = tokio::io::BufReader::new(stdout);
        let mut line = String::new();
        let ready_timeout = std::time::Duration::from_secs(15);

        let port: u16 = match tokio::time::timeout(ready_timeout, async {
            use tokio::io::AsyncBufReadExt;
            loop {
                line.clear();
                let n = reader.read_line(&mut line).await.map_err(|e| format!("IO error: {}", e))?;
                if n == 0 { return Err("Bridge process exited before becoming ready".to_string()); }
                let trimmed = line.trim();
                if let Some(port_str) = trimmed.strip_prefix("READY:") {
                    return port_str.parse::<u16>().map_err(|e| format!("Invalid port: {}", e));
                }
            }
        }).await {
            Ok(Ok(p)) => p,
            Ok(Err(e)) => {
                let _ = child.kill().await;
                return (format!("Playwright bridge failed to start: {}", e), vec![]);
            }
            Err(_) => {
                let _ = child.kill().await;
                return ("Playwright bridge startup timed out (15s)".to_string(), vec![]);
            }
        };

        let client = reqwest::Client::new();

        // Forward the actual start action (with headed flag) to the bridge
        let resp = client
            .post(format!("http://127.0.0.1:{}/action", port))
            .json(args)
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .await;

        match resp {
            Ok(r) => {
                let body: BridgeResponse = r.json().await.unwrap_or_default();
                if body.text.starts_with("Error:") {
                    // Browser launch failed inside bridge, kill the process
                    let _ = child.kill().await;
                    return (body.text, vec![]);
                }
                *state_lock = Some(BrowserState { child, port, client });
                return (body.text, body.images);
            }
            Err(e) => {
                let _ = child.kill().await;
                return (format!("Bridge start request failed: {}", e), vec![]);
            }
        }
    }

    // "stop" shuts down the bridge
    if action == "stop" {
        let mut state_lock = BROWSER_STATE.lock().await;
        if let Some(state) = state_lock.take() {
            state.shutdown().await;
        }
        return ("Browser stopped.".to_string(), vec![]);
    }

    // All other actions: proxy to the bridge via HTTP
    cleanup_dead_browser().await;
    let state_lock = BROWSER_STATE.lock().await;
    let state = match state_lock.as_ref() {
        Some(s) => s,
        None => return ("Error: Browser not started. Call browser_use with action='start' first.".to_string(), vec![]),
    };

    let timeout = if action == "screenshot" || action == "ai_snapshot" {
        std::time::Duration::from_secs(30)
    } else if action == "wait" {
        std::time::Duration::from_secs(35)
    } else {
        std::time::Duration::from_secs(60)
    };

    match state.client
        .post(format!("http://127.0.0.1:{}/action", state.port))
        .json(args)
        .timeout(timeout)
        .send()
        .await
    {
        Ok(r) => {
            let body: BridgeResponse = r.json().await.unwrap_or_default();
            (body.text, body.images)
        }
        Err(e) => (format!("Browser bridge error: {}", e), vec![]),
    }
}

// ---------------------------------------------------------------------------
// Python tools (embedded interpreter via tauri-plugin-python)
// ---------------------------------------------------------------------------

async fn run_python_tool(args: &serde_json::Value) -> String {
    let code = args["code"].as_str().unwrap_or("");
    if code.is_empty() {
        return "Error: code is required".into();
    }
    if !python_bridge::is_available() {
        return "Error: Python interpreter not available".into();
    }
    match python_bridge::call_python("run_code", vec![code.to_string()]).await {
        Ok(result) => truncate_output(&result, 8000),
        Err(e) => format!("Python error: {}", e),
    }
}

async fn run_python_script_tool(args: &serde_json::Value) -> String {
    let script_path = args["script_path"].as_str().unwrap_or("");
    if script_path.is_empty() {
        return "Error: script_path is required".into();
    }
    if !python_bridge::is_available() {
        return "Error: Python interpreter not available".into();
    }

    let script_args: Vec<String> = args["args"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let args_json = serde_json::to_string(&script_args).unwrap_or_else(|_| "[]".into());

    match python_bridge::call_python(
        "run_script",
        vec![script_path.to_string(), args_json],
    )
    .await
    {
        Ok(result) => truncate_output(&result, 8000),
        Err(e) => format!("Python script error: {}", e),
    }
}

async fn pip_install_tool(args: &serde_json::Value) -> String {
    let packages: Vec<String> = args["packages"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    if packages.is_empty() {
        return "Error: packages array is required".into();
    }
    if !python_bridge::is_available() {
        return "Error: Python interpreter not available".into();
    }

    let packages_json = serde_json::to_string(&packages).unwrap_or_else(|_| "[]".into());

    match python_bridge::call_python("pip_install", vec![packages_json]).await {
        Ok(result) => result,
        Err(e) => format!("pip install error: {}", e),
    }
}

// ---------------------------------------------------------------------------
// Memory tools — FTS5-backed full-text search
// ---------------------------------------------------------------------------

/// Add a memory entry to the SQLite FTS5 knowledge store.
async fn memory_add_tool(args: &serde_json::Value) -> String {
    let content = args["content"].as_str().unwrap_or("");
    let category = args["category"].as_str().unwrap_or("fact");

    if content.is_empty() {
        return "Error: content is required".into();
    }

    let db = match DATABASE.get() {
        Some(db) => db,
        None => return "Error: database not available".into(),
    };

    // Use the current task-local session_id if available
    let sid = get_current_session_id();
    let session_id: Option<String> = if sid.is_empty() { None } else { Some(sid) };

    match db.memory_add(content, category, session_id.as_deref()) {
        Ok(id) => format!("Memory added (id: {}, category: {})", id, category),
        Err(e) => format!("Error adding memory: {}", e),
    }
}

/// Search memories using FTS5 MATCH with BM25 ranking.
async fn memory_search_tool(args: &serde_json::Value) -> String {
    let query = args["query"].as_str().unwrap_or("");
    let category = args["category"].as_str();
    let max_results = args["max_results"].as_u64().unwrap_or(10) as usize;

    if query.is_empty() {
        return "Error: query is required".into();
    }

    let db = match DATABASE.get() {
        Some(db) => db,
        None => return "Error: database not available".into(),
    };

    match db.memory_search(query, category, max_results) {
        Ok(rows) => {
            if rows.is_empty() {
                return format!("No memories found matching '{}'", query);
            }
            let results: Vec<String> = rows
                .iter()
                .map(|m| {
                    format!(
                        "[{}] ({})\n{}\n  -- id: {} | created: {}",
                        m.category,
                        format_timestamp(m.updated_at),
                        m.content,
                        m.id,
                        format_timestamp(m.created_at),
                    )
                })
                .collect();
            format!(
                "Found {} memories matching '{}':\n\n{}",
                results.len(),
                query,
                results.join("\n---\n")
            )
        }
        Err(e) => format!("Error searching memories: {}", e),
    }
}

/// Delete a memory entry by ID.
async fn memory_delete_tool(args: &serde_json::Value) -> String {
    let id = args["id"].as_str().unwrap_or("");
    if id.is_empty() {
        return "Error: id is required".into();
    }

    let db = match DATABASE.get() {
        Some(db) => db,
        None => return "Error: database not available".into(),
    };

    match db.memory_delete(id) {
        Ok(true) => format!("Memory deleted (id: {})", id),
        Ok(false) => format!("No memory found with id: {}", id),
        Err(e) => format!("Error deleting memory: {}", e),
    }
}

/// List memories with optional category filter and pagination.
async fn memory_list_tool(args: &serde_json::Value) -> String {
    let category = args["category"].as_str();
    let limit = args["limit"].as_u64().unwrap_or(20) as usize;
    let offset = args["offset"].as_u64().unwrap_or(0) as usize;

    let db = match DATABASE.get() {
        Some(db) => db,
        None => return "Error: database not available".into(),
    };

    let total = db.memory_count(category).unwrap_or(0);

    match db.memory_list(category, limit, offset) {
        Ok(rows) => {
            if rows.is_empty() {
                return if category.is_some() {
                    format!("No memories found in category '{}'", category.unwrap())
                } else {
                    "No memories stored yet.".into()
                };
            }
            let entries: Vec<String> = rows
                .iter()
                .map(|m| {
                    format!(
                        "- [{}] {} (id: {}, updated: {})",
                        m.category,
                        truncate_output(&m.content, 200),
                        m.id,
                        format_timestamp(m.updated_at),
                    )
                })
                .collect();
            format!(
                "Memories ({} total, showing {}-{}):\n{}",
                total,
                offset + 1,
                offset + rows.len(),
                entries.join("\n")
            )
        }
        Err(e) => format!("Error listing memories: {}", e),
    }
}

/// Format a millisecond timestamp into a human-readable string.
fn format_timestamp(ts: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ts)
        .map(|dt| dt.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|| ts.to_string())
}

// ---------------------------------------------------------------------------
// manage_cronjob — create/list/delete scheduled tasks
// ---------------------------------------------------------------------------

async fn manage_cronjob_tool(args: &serde_json::Value) -> String {
    let action = args["action"].as_str().unwrap_or("");
    let db = match DATABASE.get() {
        Some(db) => db,
        None => return "Error: database not configured".into(),
    };

    match action {
        "list" => {
            match db.list_cronjobs() {
                Ok(jobs) if jobs.is_empty() => "No cron jobs configured.".into(),
                Ok(jobs) => {
                    let items: Vec<String> = jobs
                        .iter()
                        .map(|j| {
                            let schedule: serde_json::Value = serde_json::from_str(&j.schedule_json).unwrap_or_default();
                            format!(
                                "- [{}] {} | cron: {} | type: {} | enabled: {}",
                                j.id,
                                j.name,
                                schedule["cron"].as_str().unwrap_or("?"),
                                j.task_type,
                                j.enabled,
                            )
                        })
                        .collect();
                    format!("Cron jobs ({}):\n{}", items.len(), items.join("\n"))
                }
                Err(e) => format!("Error listing jobs: {}", e),
            }
        }
        "create" => {
            let name = args["name"].as_str().unwrap_or("Untitled Job");
            let text = args["text"].as_str().unwrap_or("");
            let task_type = args["task_type"].as_str().unwrap_or("notify");
            let schedule_type = args["schedule_type"].as_str().unwrap_or("cron");

            let schedule_json = match schedule_type {
                "delay" => {
                    let minutes = args["delay_minutes"].as_f64().unwrap_or(0.0) as u64;
                    if minutes == 0 {
                        return "Error: delay_minutes is required and must be > 0".into();
                    }
                    let created_at = chrono::Utc::now().timestamp() as u64;
                    serde_json::json!({"type": "delay", "delay_minutes": minutes, "created_at": created_at})
                }
                "once" => {
                    let schedule_at = args["schedule_at"].as_str().unwrap_or("");
                    if schedule_at.is_empty() {
                        return "Error: schedule_at (ISO 8601) is required for once type".into();
                    }
                    serde_json::json!({"type": "once", "schedule_at": schedule_at})
                }
                _ => {
                    let cron = args["cron"].as_str().unwrap_or("");
                    if cron.is_empty() {
                        return "Error: cron expression is required".into();
                    }
                    serde_json::json!({"type": "cron", "cron": cron})
                }
            };

            let id = uuid::Uuid::new_v4().to_string();
            let row = super::db::CronJobRow {
                id: id.clone(),
                name: name.to_string(),
                enabled: true,
                schedule_json: schedule_json.to_string(),
                task_type: task_type.to_string(),
                text: if text.is_empty() { None } else { Some(text.to_string()) },
                request_json: None,
                dispatch_json: None,
                runtime_json: None,
            };

            match db.upsert_cronjob(&row) {
                Ok(_) => {
                    // Schedule the job to actually run
                    let spec = crate::commands::cronjobs::CronJobSpec::from_row(&row);
                    schedule_created_job(spec);

                    let schedule_desc = match schedule_type {
                        "delay" => format!("in {} minutes", args["delay_minutes"].as_f64().unwrap_or(0.0) as u64),
                        "once" => format!("at {}", args["schedule_at"].as_str().unwrap_or("?")),
                        _ => format!("cron: {}", args["cron"].as_str().unwrap_or("?")),
                    };
                    format!("Created {} job '{}' (id: {})\nSchedule: {}\nText: {}", schedule_type, name, id, schedule_desc, text)
                }
                Err(e) => format!("Error saving cronjob: {}", e),
            }
        }
        "delete" => {
            let id = args["id"].as_str().unwrap_or("");
            if id.is_empty() {
                return "Error: id is required for delete".into();
            }

            match db.delete_cronjob(id) {
                Ok(_) => format!("Deleted cron job '{}'", id),
                Err(e) => format!("Error deleting cronjob: {}", e),
            }
        }
        _ => format!("Unknown action: '{}'. Supported: create, list, delete", action),
    }
}

/// Schedule a newly created job by registering it with the CronScheduler.
/// Works for all types: delay, once, and cron.
fn schedule_created_job(spec: crate::commands::cronjobs::CronJobSpec) {
    let scheduler_lock = match SCHEDULER.get() {
        Some(s) => s.clone(),
        None => {
            log::warn!("Scheduler not initialized, job '{}' will run after restart", spec.id);
            return;
        }
    };

    tokio::spawn(async move {
        let guard = scheduler_lock.read().await;
        if let Some(ref scheduler) = *guard {
            if let Err(e) = scheduler.add_job_from_globals(&spec).await {
                log::error!("Failed to schedule job '{}': {}", spec.id, e);
            }
        } else {
            log::warn!("Scheduler not started, job '{}' will run after restart", spec.id);
        }
    });
}

// ---------------------------------------------------------------------------
// send_notification — macOS system notification
// ---------------------------------------------------------------------------

fn send_notification_tool(args: &serde_json::Value) -> String {
    let title = args["title"].as_str().unwrap_or("YiClaw");
    let body = args["body"].as_str().unwrap_or("");

    if body.is_empty() {
        return "Error: body is required".into();
    }

    super::scheduler::send_system_notification(title, body);
    format!("Notification sent: {} - {}", title, body)
}

// ---------------------------------------------------------------------------
// add_calendar_event — cross-platform calendar integration via .ics
// ---------------------------------------------------------------------------

async fn add_calendar_event_tool(args: &serde_json::Value) -> String {
    let title = args["title"].as_str().unwrap_or("");
    let description = args["description"].as_str().unwrap_or("");
    let start_str = args["start_time"].as_str().unwrap_or("");
    let end_str = args["end_time"].as_str().unwrap_or("");
    let reminder_min = args["reminder_minutes"].as_i64().unwrap_or(5);
    let all_day = args["all_day"].as_bool().unwrap_or(false);

    if title.is_empty() || start_str.is_empty() {
        return "Error: title and start_time are required".into();
    }

    // Parse start time
    let start = match chrono::DateTime::parse_from_rfc3339(start_str) {
        Ok(t) => t.to_utc(),
        Err(e) => return format!("Error: invalid start_time '{}': {}", start_str, e),
    };

    // Parse or default end time
    let end = if !end_str.is_empty() {
        match chrono::DateTime::parse_from_rfc3339(end_str) {
            Ok(t) => t.to_utc(),
            Err(e) => return format!("Error: invalid end_time '{}': {}", end_str, e),
        }
    } else {
        start + chrono::Duration::minutes(15)
    };

    // Format times for ICS (UTC)
    let fmt = "%Y%m%dT%H%M%SZ";
    let (dtstart, dtend) = if all_day {
        let day_fmt = "%Y%m%d";
        (
            format!("VALUE=DATE:{}", start.format(day_fmt)),
            format!("VALUE=DATE:{}", (start + chrono::Duration::days(1)).format(day_fmt)),
        )
    } else {
        (start.format(fmt).to_string(), end.format(fmt).to_string())
    };

    let now_stamp = chrono::Utc::now().format(fmt);
    let uid = uuid::Uuid::new_v4();

    // Escape special characters in ICS text fields
    let ics_escape = |s: &str| -> String {
        s.replace('\\', "\\\\")
            .replace(';', "\\;")
            .replace(',', "\\,")
            .replace('\n', "\\n")
    };

    let mut ics = format!(
        "BEGIN:VCALENDAR\r\n\
        VERSION:2.0\r\n\
        PRODID:-//YiClaw//Calendar//EN\r\n\
        CALSCALE:GREGORIAN\r\n\
        METHOD:PUBLISH\r\n\
        BEGIN:VEVENT\r\n\
        UID:{uid}\r\n\
        DTSTAMP:{now}\r\n\
        DTSTART{colon}{dtstart}\r\n\
        DTEND{colon}{dtend}\r\n\
        SUMMARY:{title}\r\n",
        uid = uid,
        now = now_stamp,
        colon = if all_day { ";" } else { ":" },
        dtstart = dtstart,
        dtend = dtend,
        title = ics_escape(title),
    );

    if !description.is_empty() {
        ics.push_str(&format!("DESCRIPTION:{}\r\n", ics_escape(description)));
    }

    if reminder_min > 0 {
        ics.push_str(&format!(
            "BEGIN:VALARM\r\n\
            TRIGGER:-PT{}M\r\n\
            ACTION:DISPLAY\r\n\
            DESCRIPTION:Reminder\r\n\
            END:VALARM\r\n",
            reminder_min
        ));
    }

    ics.push_str("END:VEVENT\r\nEND:VCALENDAR\r\n");

    // Write .ics file to temp directory
    let temp_dir = std::env::temp_dir().join("yiclaw_calendar");
    if let Err(e) = tokio::fs::create_dir_all(&temp_dir).await {
        return format!("Error creating temp dir: {}", e);
    }

    let safe_title: String = title
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-' || *c == ' ')
        .take(50)
        .collect();
    let filename = format!("{}_{}.ics", safe_title.trim(), uid.to_string().split('-').next().unwrap_or("evt"));
    let file_path = temp_dir.join(&filename);

    if let Err(e) = tokio::fs::write(&file_path, &ics).await {
        return format!("Error writing .ics file: {}", e);
    }

    // Open with system default calendar app
    let open_cmd = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "start"
    } else {
        "xdg-open"
    };

    let path_str = file_path.to_string_lossy().to_string();
    let open_result = if cfg!(target_os = "windows") {
        tokio::process::Command::new("cmd")
            .args(["/C", "start", "", &path_str])
            .spawn()
    } else {
        tokio::process::Command::new(open_cmd)
            .arg(&path_str)
            .spawn()
    };

    match open_result {
        Ok(_) => {
            let local_start = start.with_timezone(&chrono::Local);
            format!(
                "Calendar event created and opened in system calendar:\n\
                - Title: {}\n\
                - Time: {}\n\
                - Reminder: {} minutes before\n\
                - File: {}",
                title,
                local_start.format("%Y-%m-%d %H:%M"),
                reminder_min,
                file_path.display()
            )
        }
        Err(e) => {
            format!(
                "Calendar event file created at {} but failed to open: {}. \
                The user can manually open this .ics file to add it to their calendar.",
                file_path.display(), e
            )
        }
    }
}

// ---------------------------------------------------------------------------
// send_file_to_user — emit Tauri event so frontend can trigger save dialog
// ---------------------------------------------------------------------------

async fn list_bound_bots_tool() -> String {
    let db = match DATABASE.get() {
        Some(db) => db,
        None => return "Error: database not available".into(),
    };

    let session_id = get_current_session_id();
    if session_id.is_empty() {
        return "Error: no active session context.".into();
    }

    let bots = match db.list_session_bots(&session_id) {
        Ok(bots) => bots,
        Err(e) => return format!("Error listing bound bots: {}", e),
    };

    if bots.is_empty() {
        return format!(
            "No bots are bound to the current session (session_id: {}). \
            The user can bind bots via the bot icon in the chat toolbar.",
            session_id
        );
    }

    let list: Vec<String> = bots
        .iter()
        .map(|b| {
            let last_conv = db.get_bot_last_conversation(&b.id)
                .unwrap_or_else(|| "none".into());
            format!(
                "- {} (platform: {}, id: {}, enabled: {}, last_target: {})",
                b.name, b.platform, b.id, b.enabled, last_conv
            )
        })
        .collect();

    format!(
        "Bots bound to current session ({}):\n{}\n\n\
        To send a message, use send_bot_message with the bot's id and the last_target as target.\n\
        - Target format: 'c2c:xxx' (private chat), 'group:xxx' (group chat), 'guild:gid:cid' (guild channel)\n\
        - If last_target is 'none', no one has messaged this bot yet — the bot cannot initiate contact. \
        Tell the user that the other person needs to send a message to the bot first.",
        session_id,
        list.join("\n")
    )
}

async fn send_bot_message_tool(args: &serde_json::Value) -> String {
    let target = args["target"].as_str().unwrap_or("");
    let content = args["content"].as_str().unwrap_or("");
    let explicit_bot_id = args["bot_id"].as_str();

    if target.is_empty() || content.is_empty() {
        return "Error: both 'target' and 'content' are required".into();
    }

    let db = match DATABASE.get() {
        Some(db) => db,
        None => return "Error: database not available".into(),
    };

    let session_id = get_current_session_id();
    if session_id.is_empty() {
        return "Error: no active session. Cannot determine which bots are bound.".into();
    }

    // Get bots bound to this session
    let bound_bots = match db.list_session_bots(&session_id) {
        Ok(bots) => bots,
        Err(e) => return format!("Error listing session bots: {}", e),
    };

    if bound_bots.is_empty() {
        return "Error: no bots are bound to the current session. Ask the user to bind a bot first via the session settings.".into();
    }

    // Determine which bot to use
    let bot = if let Some(bid) = explicit_bot_id {
        match bound_bots.iter().find(|b| b.id == bid) {
            Some(b) => b,
            None => return format!("Error: bot '{}' is not bound to this session", bid),
        }
    } else if bound_bots.len() == 1 {
        &bound_bots[0]
    } else {
        let bot_list: Vec<String> = bound_bots.iter().map(|b| format!("{} ({}, {})", b.name, b.platform, b.id)).collect();
        return format!(
            "Error: multiple bots are bound to this session. Please specify bot_id. Available bots:\n{}",
            bot_list.join("\n")
        );
    };

    // Send via the bot
    match crate::commands::bots::send_to_bot(db, &bot.id, target, content).await {
        Ok(()) => format!("Message sent via {} ({}) to target '{}'", bot.name, bot.platform, target),
        Err(e) => format!("Error sending message: {}", e),
    }
}

async fn manage_bot_tool(args: &serde_json::Value) -> String {
    let action = args["action"].as_str().unwrap_or("");
    let db = match DATABASE.get() {
        Some(db) => db,
        None => return "Error: database not available".into(),
    };

    match action {
        "list" => {
            let bots = match db.list_bots() {
                Ok(b) => b,
                Err(e) => return format!("Error listing bots: {}", e),
            };
            if bots.is_empty() {
                return "No bots configured. Use action='create' to add one.".into();
            }
            let list: Vec<String> = bots.iter().map(|b| {
                format!("- {} | platform: {} | enabled: {} | id: {}", b.name, b.platform, b.enabled, b.id)
            }).collect();
            format!("Bots:\n{}", list.join("\n"))
        }
        "create" => {
            let platform = match args["platform"].as_str() {
                Some(p) => p,
                None => return "Error: 'platform' is required for create".into(),
            };
            let name = match args["name"].as_str() {
                Some(n) => n,
                None => return "Error: 'name' is required for create".into(),
            };
            let config = match args.get("config") {
                Some(c) if c.is_object() => c.clone(),
                _ => return "Error: 'config' object is required for create".into(),
            };

            let valid_platforms = ["discord", "telegram", "qq", "dingtalk", "feishu", "wecom", "webhook"];
            if !valid_platforms.contains(&platform) {
                return format!("Error: invalid platform '{}'. Valid: {:?}", platform, valid_platforms);
            }

            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64;

            let row = crate::engine::db::BotRow {
                id: uuid::Uuid::new_v4().to_string(),
                name: name.to_string(),
                platform: platform.to_string(),
                enabled: true,
                config_json: serde_json::to_string(&config).unwrap_or_else(|_| "{}".into()),
                persona: None,
                access_json: None,
                created_at: now,
                updated_at: now,
            };

            let bot_id = row.id.clone();
            match db.upsert_bot(&row) {
                Ok(()) => format!(
                    "Bot '{}' created successfully!\nPlatform: {}\nBot ID: {}\n\
                    The bot is enabled by default. Use 'start' action to connect it.",
                    name, platform, bot_id
                ),
                Err(e) => format!("Error creating bot: {}", e),
            }
        }
        "update" => {
            let bot_id = match args["bot_id"].as_str() {
                Some(id) => id,
                None => return "Error: 'bot_id' is required for update".into(),
            };
            let mut row = match db.get_bot(bot_id) {
                Ok(Some(r)) => r,
                Ok(None) => return format!("Error: bot '{}' not found", bot_id),
                Err(e) => return format!("Error: {}", e),
            };

            if let Some(n) = args["name"].as_str() { row.name = n.to_string(); }
            if let Some(c) = args.get("config").filter(|c| c.is_object()) {
                row.config_json = serde_json::to_string(c).unwrap_or_else(|_| "{}".into());
            }
            row.updated_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64;

            match db.upsert_bot(&row) {
                Ok(()) => format!("Bot '{}' updated successfully.", row.name),
                Err(e) => format!("Error updating bot: {}", e),
            }
        }
        "enable" | "disable" => {
            let bot_id = match args["bot_id"].as_str() {
                Some(id) => id,
                None => return format!("Error: 'bot_id' is required for {}", action),
            };
            let mut row = match db.get_bot(bot_id) {
                Ok(Some(r)) => r,
                Ok(None) => return format!("Error: bot '{}' not found", bot_id),
                Err(e) => return format!("Error: {}", e),
            };
            row.enabled = action == "enable";
            row.updated_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64;
            match db.upsert_bot(&row) {
                Ok(()) => format!("Bot '{}' {}d.", row.name, action),
                Err(e) => format!("Error: {}", e),
            }
        }
        "delete" => {
            let bot_id = match args["bot_id"].as_str() {
                Some(id) => id,
                None => return "Error: 'bot_id' is required for delete".into(),
            };
            match db.delete_bot(bot_id) {
                Ok(()) => format!("Bot '{}' deleted.", bot_id),
                Err(e) => format!("Error deleting bot: {}", e),
            }
        }
        "start" | "stop" => {
            format!(
                "The '{}' action requires the app runtime. Please tell the user to click the '{}' button on the Bots page.",
                action,
                if action == "start" { "启动全部 / Start All" } else { "停止全部 / Stop All" }
            )
        }
        _ => format!("Unknown action '{}'. Valid: create, list, update, delete, enable, disable, start, stop", action),
    }
}

async fn manage_skill_tool(args: &serde_json::Value) -> String {
    let action = args["action"].as_str().unwrap_or("");
    let name = args["name"].as_str().unwrap_or("");

    let working_dir = match WORKING_DIR.get() {
        Some(d) => d.clone(),
        None => return "Error: working directory not initialized".into(),
    };

    let active_dir = working_dir.join("active_skills");
    let custom_dir = working_dir.join("customized_skills");

    match action {
        "create" => {
            let content = args["content"].as_str().unwrap_or("");
            if name.is_empty() || content.is_empty() {
                return "Error: 'name' and 'content' are required for create".into();
            }

            // Create in customized_skills and active_skills
            let skill_custom = custom_dir.join(name);
            let skill_active = active_dir.join(name);

            if let Err(e) = std::fs::create_dir_all(&skill_custom) {
                return format!("Error creating skill dir: {}", e);
            }
            if let Err(e) = std::fs::write(skill_custom.join("SKILL.md"), content) {
                return format!("Error writing SKILL.md: {}", e);
            }

            std::fs::create_dir_all(&skill_active).ok();
            std::fs::write(skill_active.join("SKILL.md"), content).ok();

            // Notify frontend to refresh
            if let Some(handle) = APP_HANDLE.get() {
                handle.emit("skills://changed", "created").ok();
            }

            format!("Skill '{}' created and enabled successfully.", name)
        }
        "list" => {
            let mut result = Vec::new();

            // Active skills
            if let Ok(entries) = std::fs::read_dir(&active_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() && path.join("SKILL.md").exists() {
                        let skill_name = path.file_name().unwrap().to_string_lossy().to_string();
                        result.push(format!("  [enabled] {}", skill_name));
                    }
                }
            }

            // Customized but disabled
            if let Ok(entries) = std::fs::read_dir(&custom_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() && path.join("SKILL.md").exists() {
                        let skill_name = path.file_name().unwrap().to_string_lossy().to_string();
                        if !active_dir.join(&skill_name).exists() {
                            result.push(format!("  [disabled] {}", skill_name));
                        }
                    }
                }
            }

            if result.is_empty() {
                "No skills found.".into()
            } else {
                format!("Skills:\n{}", result.join("\n"))
            }
        }
        "enable" => {
            if name.is_empty() {
                return "Error: 'name' is required for enable".into();
            }
            let src = custom_dir.join(name);
            let dst = active_dir.join(name);
            if dst.exists() {
                return format!("Skill '{}' is already enabled.", name);
            }
            if src.exists() {
                std::fs::create_dir_all(&active_dir).ok();
                fn copy_dir(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
                    std::fs::create_dir_all(dst)?;
                    for entry in std::fs::read_dir(src)? {
                        let entry = entry?;
                        let dest = dst.join(entry.file_name());
                        if entry.path().is_dir() {
                            copy_dir(&entry.path(), &dest)?;
                        } else {
                            std::fs::copy(&entry.path(), &dest)?;
                        }
                    }
                    Ok(())
                }
                if let Err(e) = copy_dir(&src, &dst) {
                    return format!("Error enabling skill: {}", e);
                }
            } else {
                return format!("Error: skill '{}' not found in customized_skills", name);
            }

            if let Some(handle) = APP_HANDLE.get() {
                handle.emit("skills://changed", "enabled").ok();
            }
            format!("Skill '{}' enabled.", name)
        }
        "disable" => {
            if name.is_empty() {
                return "Error: 'name' is required for disable".into();
            }
            let path = active_dir.join(name);
            if path.exists() {
                if let Err(e) = std::fs::remove_dir_all(&path) {
                    return format!("Error disabling skill: {}", e);
                }
            }

            if let Some(handle) = APP_HANDLE.get() {
                handle.emit("skills://changed", "disabled").ok();
            }
            format!("Skill '{}' disabled.", name)
        }
        "delete" => {
            if name.is_empty() {
                return "Error: 'name' is required for delete".into();
            }
            let custom_path = custom_dir.join(name);
            let active_path = active_dir.join(name);

            if custom_path.exists() {
                std::fs::remove_dir_all(&custom_path).ok();
            }
            if active_path.exists() {
                std::fs::remove_dir_all(&active_path).ok();
            }

            if let Some(handle) = APP_HANDLE.get() {
                handle.emit("skills://changed", "deleted").ok();
            }
            format!("Skill '{}' deleted.", name)
        }
        _ => format!("Unknown action: '{}'. Use create, list, enable, disable, or delete.", action),
    }
}

async fn send_file_to_user_tool(args: &serde_json::Value) -> String {
    use tauri::Emitter;

    let path = args["path"].as_str().unwrap_or("");
    if path.is_empty() {
        return "Error: path is required".into();
    }

    let file_path = std::path::Path::new(path);
    if !file_path.exists() {
        return format!("Error: file not found: {}", path);
    }

    let filename = args["filename"]
        .as_str()
        .unwrap_or_else(|| {
            file_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("file")
        })
        .to_string();

    let description = args["description"].as_str().unwrap_or("").to_string();

    let metadata = file_path.metadata().ok();
    let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);

    let payload = serde_json::json!({
        "path": path,
        "filename": filename,
        "description": description,
        "size": size,
    });

    match APP_HANDLE.get() {
        Some(handle) => {
            handle.emit("agent://send_file", &payload).ok();

            // System notification for generated file
            crate::engine::scheduler::send_notification_with_context(
                "YiClaw",
                &format!("{} ({:.1} KB)", filename, size as f64 / 1024.0),
                serde_json::json!({
                    "page": "chat",
                    "file_path": path,
                }),
            );

            format!(
                "File sent to user: {} ({} bytes)",
                filename, size
            )
        }
        None => {
            format!(
                "File ready: {} ({} bytes) at {}",
                filename, size, path
            )
        }
    }
}

// ============================================================================
// Claude Code CLI integration
// ============================================================================

/// Per-session Claude Code session ID cache (capped at 100 entries).
/// Key: YiClaw session_id, Value: Claude Code session_id (from --output-format json).
const CC_SESSIONS_MAX: usize = 100;
static CC_SESSIONS: std::sync::LazyLock<tokio::sync::Mutex<std::collections::HashMap<String, String>>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(std::collections::HashMap::new()));

async fn claude_code_tool(args: &serde_json::Value) -> String {
    let prompt = match args["prompt"].as_str() {
        Some(p) if !p.is_empty() => p,
        _ => return "Error: prompt is required".into(),
    };

    let context = args["context"].as_str().unwrap_or("");
    let continue_session = args["continue_session"].as_bool().unwrap_or(true);
    let timeout_secs = args["timeout_secs"].as_u64().unwrap_or(300);

    // Resolve working directory
    let working_dir = args["working_dir"]
        .as_str()
        .map(|s| s.to_string())
        .or_else(|| WORKING_DIR.get().map(|p| p.to_string_lossy().to_string()))
        .unwrap_or_else(|| ".".into());

    // Resolve claude CLI path (cross-platform, with fallback for GUI apps)
    let claude_bin = resolve_claude_bin().await;
    let claude_bin = match claude_bin {
        Some(bin) => bin,
        None => {
            return "Error: Claude Code CLI is not installed. \
                    Please install it with: npm i -g @anthropic-ai/claude-code\n\
                    Then ensure ANTHROPIC_API_KEY is set in your environment."
                .into();
        }
    };

    // Build command — combine context + prompt into final prompt
    let final_prompt = if context.is_empty() {
        prompt.to_string()
    } else {
        format!(
            "<context>\n{}\n</context>\n\n{}",
            context, prompt
        )
    };

    let mut cmd = tokio::process::Command::new(&claude_bin);
    cmd.arg("-p").arg(&final_prompt);
    cmd.arg("--output-format").arg("json");
    cmd.arg("--max-turns").arg("30");
    cmd.current_dir(&working_dir);

    // Non-interactive mode: skip permission prompts.
    // YiClaw's own sandbox layer handles access control,
    // so Claude Code doesn't need to double-gate operations.
    cmd.arg("--dangerously-skip-permissions");

    // Prevent "nested session" error when called from within a Claude Code context.
    // YiClaw's Tauri process won't have this, but defensive just in case.
    cmd.env_remove("CLAUDECODE");

    // Inject provider API key if ANTHROPIC_API_KEY isn't already in env.
    // This lets Claude Code reuse the user's existing provider config (e.g. coding-plan).
    if std::env::var("ANTHROPIC_API_KEY").map(|v| v.is_empty()).unwrap_or(true) {
        if let Some((api_key, base_url)) = resolve_claude_code_provider().await {
            cmd.env("ANTHROPIC_API_KEY", &api_key);
            cmd.env("ANTHROPIC_BASE_URL", &base_url);
        }
    }

    // Session continuity: look up or create session ID for this chat
    let yiclaw_session = get_current_session_id();
    if continue_session && !yiclaw_session.is_empty() {
        let sessions = CC_SESSIONS.lock().await;
        if let Some(cc_sid) = sessions.get(&yiclaw_session) {
            cmd.arg("--resume").arg(cc_sid);
        }
        drop(sessions);
    }

    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    // Emit progress event to frontend
    if let Some(handle) = APP_HANDLE.get() {
        handle
            .emit(
                "agent://tool_progress",
                serde_json::json!({
                    "tool": "claude_code",
                    "status": "running",
                    "message": format!("Claude Code is working on: {}",
                        truncate_output(prompt, 80))
                }),
            )
            .ok();
    }

    // Execute with timeout — use spawn + kill to avoid orphan processes
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return format!("Error: failed to start claude: {}", e),
    };

    // Grab PID before wait_with_output() consumes the child
    let child_id = child.id();

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        child.wait_with_output(),
    )
    .await;

    match result {
        Err(_) => {
            // Timeout — kill the child process to avoid resource leak
            if let Some(pid) = child_id {
                let kill_cmd = if cfg!(windows) { "taskkill" } else { "kill" };
                let kill_args: Vec<String> = if cfg!(windows) {
                    vec!["/PID".into(), pid.to_string(), "/F".into()]
                } else {
                    vec![pid.to_string()]
                };
                std::process::Command::new(kill_cmd).args(&kill_args).output().ok();
            }
            "Error: Claude Code timed out. The task may be too complex. \
             Try breaking it into smaller steps, or increase timeout_secs."
                .into()
        }
        Ok(Err(e)) => format!("Error: failed to run claude: {}", e),
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let exit_code = output.status.code().unwrap_or(-1);

            // Try to extract session ID from JSON output for continuity
            if !yiclaw_session.is_empty() {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&stdout) {
                    if let Some(sid) = json["session_id"].as_str() {
                        let mut sessions = CC_SESSIONS.lock().await;
                        // Evict oldest entries if at capacity
                        if sessions.len() >= CC_SESSIONS_MAX {
                            if let Some(oldest) = sessions.keys().next().cloned() {
                                sessions.remove(&oldest);
                            }
                        }
                        sessions.insert(yiclaw_session.clone(), sid.to_string());
                    }
                }
            }

            // Parse JSON output to extract the result text
            let response_text = parse_claude_code_output(&stdout);

            if exit_code == 0 {
                if response_text.is_empty() {
                    "(Claude Code completed with no output)".into()
                } else {
                    truncate_output(&response_text, 12000)
                }
            } else {
                let error_detail = if !stderr.is_empty() {
                    truncate_output(&stderr, 4000)
                } else {
                    truncate_output(&response_text, 4000)
                };
                format!(
                    "Claude Code exited with code {}.\n{}",
                    exit_code, error_detail
                )
            }
        }
    }
}

/// Resolve the full path to the `claude` CLI binary.
/// Falls back to common install paths for GUI apps with restricted PATH.
async fn resolve_claude_bin() -> Option<String> {
    // Try PATH first
    let check_cmd = if cfg!(windows) { "where" } else { "which" };
    if let Ok(output) = tokio::process::Command::new(check_cmd)
        .arg("claude")
        .output()
        .await
    {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(path);
            }
        }
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
                return Some(path.to_string_lossy().to_string());
            }
        }
    }

    None
}

/// Resolve a usable provider's API key + base URL for Claude Code.
/// Priority: anthropic > coding-plan > any configured provider.
async fn resolve_claude_code_provider() -> Option<(String, String)> {
    // Check DB flag first — user may have chosen a provider in the setup dialog
    let chosen_provider = DATABASE
        .get()
        .and_then(|db| db.get_config("claude_code_provider"));

    let providers_lock = PROVIDERS.get()?;
    let providers = providers_lock.read().await;
    let all = providers.get_all_providers();

    // If user explicitly chose a provider, use that
    let candidates: Vec<&str> = if let Some(ref chosen) = chosen_provider {
        vec![chosen.as_str()]
    } else {
        vec!["anthropic"]
    };

    for pid in candidates {
        let p = match all.iter().find(|p| p.id == pid) {
            Some(p) => p,
            None => continue,
        };

        let api_key = if let Some(custom) = providers.custom_providers.get(pid) {
            custom.settings.api_key.clone()
        } else {
            providers
                .providers
                .get(pid)
                .and_then(|s| s.api_key.clone())
        };
        let api_key = api_key
            .or_else(|| std::env::var(&p.api_key_prefix).ok())
            .filter(|k| !k.is_empty());

        if let Some(key) = api_key {
            let base_url = p
                .base_url
                .as_deref()
                .unwrap_or(&p.default_base_url)
                .to_string();
            return Some((key, base_url));
        }
    }
    None
}

/// Parse Claude Code JSON output to extract the meaningful result text.
fn parse_claude_code_output(raw: &str) -> String {
    // Claude Code --output-format json returns a JSON object with a "result" field
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(raw) {
        // Primary: result field (text content)
        if let Some(result) = json["result"].as_str() {
            return result.to_string();
        }
        // Fallback: extract text from content blocks
        if let Some(content) = json["result"].as_array() {
            let texts: Vec<&str> = content
                .iter()
                .filter_map(|block| block["text"].as_str())
                .collect();
            if !texts.is_empty() {
                return texts.join("\n");
            }
        }
        // Last resort: pretty-print the JSON
        return serde_json::to_string_pretty(&json).unwrap_or_else(|_| raw.to_string());
    }
    // Not valid JSON — return raw output
    raw.to_string()
}

fn truncate_output(s: &str, max_chars: usize) -> String {
    let char_count = s.chars().count();
    if char_count > max_chars {
        let truncated: String = s.chars().take(max_chars).collect();
        format!(
            "{}...\n[truncated, {} chars total]",
            truncated, char_count
        )
    } else {
        s.to_string()
    }
}

/// Try to execute a tool via MCP runtime.
/// Returns Some(result) if a matching MCP tool was found and called, None otherwise.
async fn try_mcp_tool(
    runtime: &MCPRuntime,
    tool_name: &str,
    args: &serde_json::Value,
) -> Option<String> {
    // First try to find the tool via get_all_tools which already has server_key metadata
    let all_tools = runtime.get_all_tools().await;
    if let Some(tool) = all_tools.iter().find(|t| t.name == tool_name) {
        if !tool.server_key.is_empty() {
            // Direct call using the known server key
            match runtime.call_tool(&tool.server_key, tool_name, args.clone()).await {
                Ok(result) => return Some(truncate_output(&result, 8000)),
                Err(e) => return Some(format!("MCP tool error: {}", e)),
            }
        }
    }

    // Fallback: scan all clients (for backwards compatibility)
    let clients = runtime.get_all_client_keys().await;
    for key in &clients {
        let tools = runtime.get_tools(key).await;
        if tools.iter().any(|t| t.name == tool_name) {
            match runtime.call_tool(key, tool_name, args.clone()).await {
                Ok(result) => return Some(truncate_output(&result, 8000)),
                Err(e) => return Some(format!("MCP tool error: {}", e)),
            }
        }
    }
    None
}
