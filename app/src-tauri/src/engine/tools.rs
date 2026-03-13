use super::doc_tools;
use super::mcp_runtime::MCPRuntime;
use super::python_bridge;
// Playwright bridge: browser automation via external Node.js process
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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

/// Global streaming state for snapshot updates from spawn agents.
static STREAMING_STATE: std::sync::OnceLock<Arc<std::sync::Mutex<std::collections::HashMap<String, crate::state::app_state::StreamingSnapshot>>>> = std::sync::OnceLock::new();

// Per-task session ID for tools that need session context (e.g. send_bot_message).
// Uses task_local so concurrent agent runs track depth independently.
tokio::task_local! {
    static TASK_SESSION_ID: String;
    static TASK_CANCELLED: std::sync::Arc<std::sync::atomic::AtomicBool>;
    static CONTINUATION_REQUESTED: std::sync::Arc<std::sync::atomic::AtomicBool>;
}

// Per-task bot context for tools that need to know the originating bot (e.g. schedule_create).
// Stores (bot_id, conversation_id) so tools can infer dispatch targets when called from a Bot conversation.
tokio::task_local! {
    static TASK_BOT_CONTEXT: (String, String);
}

// Per-task working directory override. When set, tools use this instead of the global workspace.
tokio::task_local! {
    pub static TASK_WORKING_DIR: std::path::PathBuf;
}

/// Authorized folders loaded at startup, updated at runtime.
static AUTHORIZED_FOLDERS: std::sync::OnceLock<Mutex<Vec<AuthorizedFolder>>> =
    std::sync::OnceLock::new();

/// User-facing workspace directory (~/Documents/YiYiClaw).
/// Used as the default working directory for claude_code and file operations.
static USER_WORKSPACE: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

/// Current task workspace path set by create_workspace_dir tool, keyed by session.
static CURRENT_TASK_WORKSPACE: std::sync::OnceLock<Mutex<std::collections::HashMap<String, String>>> = std::sync::OnceLock::new();

fn task_workspace_map() -> &'static Mutex<std::collections::HashMap<String, String>> {
    CURRENT_TASK_WORKSPACE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// Get the task workspace path for a given session.
#[allow(dead_code)]
pub async fn get_task_workspace_for_session(session_id: &str) -> Option<String> {
    let map = task_workspace_map().lock().await;
    map.get(session_id).cloned()
}

/// Global PTY manager reference for interactive terminal sessions.
static PTY_MANAGER: std::sync::OnceLock<Arc<crate::engine::pty_manager::PtyManager>> = std::sync::OnceLock::new();

/// Sensitive path patterns.
static SENSITIVE_PATTERNS: std::sync::OnceLock<Mutex<Vec<SensitivePattern>>> =
    std::sync::OnceLock::new();

#[derive(Debug, Clone)]
pub struct AuthorizedFolder {
    pub path: PathBuf,
    pub permission: FolderPermission,
}

#[derive(Debug, Clone, PartialEq)]
pub enum FolderPermission {
    ReadOnly,
    ReadWrite,
}

#[derive(Debug, Clone)]
pub struct SensitivePattern {
    pub compiled: glob::Pattern,
    /// Pre-compiled pattern for filename-only matching (from `**/` prefix patterns).
    pub recursive_pattern: Option<glob::Pattern>,
    pub enabled: bool,
}

impl From<super::db::AuthorizedFolderRow> for AuthorizedFolder {
    fn from(r: super::db::AuthorizedFolderRow) -> Self {
        AuthorizedFolder {
            path: PathBuf::from(&r.path),
            permission: if r.permission == "read_only" {
                FolderPermission::ReadOnly
            } else {
                FolderPermission::ReadWrite
            },
        }
    }
}

impl From<super::db::SensitivePathRow> for SensitivePattern {
    fn from(r: super::db::SensitivePathRow) -> Self {
        let home = dirs::home_dir().unwrap_or_default();
        let home_str = home.to_string_lossy();
        let expanded = r.pattern.replace('~', &home_str);
        let compiled = glob::Pattern::new(&expanded)
            .unwrap_or_else(|_| glob::Pattern::new("__invalid__").unwrap());
        let recursive_pattern = r.pattern.strip_prefix("**/").and_then(|stripped| {
            glob::Pattern::new(stripped).ok()
        });
        SensitivePattern {
            compiled,
            recursive_pattern,
            enabled: r.enabled,
        }
    }
}

pub fn init_authorized_folders(rows: Vec<super::db::AuthorizedFolderRow>) {
    let folders: Vec<AuthorizedFolder> = rows.into_iter().map(AuthorizedFolder::from).collect();
    AUTHORIZED_FOLDERS.get_or_init(|| Mutex::new(folders));
}

pub fn init_sensitive_patterns(rows: Vec<super::db::SensitivePathRow>) {
    let patterns: Vec<SensitivePattern> = rows.into_iter().map(SensitivePattern::from).collect();
    SENSITIVE_PATTERNS.get_or_init(|| Mutex::new(patterns));
}

/// Refresh authorized folders from database (call after add/remove/update).
pub async fn refresh_authorized_folders(rows: Vec<super::db::AuthorizedFolderRow>) {
    if let Some(lock) = AUTHORIZED_FOLDERS.get() {
        let mut folders = lock.lock().await;
        *folders = rows.into_iter().map(AuthorizedFolder::from).collect();
    }
}

pub async fn refresh_sensitive_patterns(rows: Vec<super::db::SensitivePathRow>) {
    if let Some(lock) = SENSITIVE_PATTERNS.get() {
        let mut patterns = lock.lock().await;
        *patterns = rows.into_iter().map(SensitivePattern::from).collect();
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

/// Check if a path is authorized for the requested operation.
/// Returns Ok(()) if allowed, Err with clear message if denied.
pub async fn access_check(raw_path: &str, needs_write: bool) -> Result<(), String> {
    if raw_path.is_empty() {
        return Ok(());
    }

    let canonical = resolve_path(raw_path);

    // 1. Always allow internal working directory (~/.yiyiclaw)
    if let Some(wd) = WORKING_DIR.get() {
        let wd_canonical = wd.canonicalize().unwrap_or_else(|_| wd.clone());
        if canonical.starts_with(&wd_canonical) {
            return Ok(());
        }
    }

    // 2. Check sensitive path blocklist FIRST
    if is_sensitive_path(&canonical).await {
        return Err(format!(
            "Access denied: '{}' matches a sensitive file pattern. This file is protected even within authorized folders. You can adjust sensitive path rules in Settings > Workspace.",
            raw_path
        ));
    }

    // 3. Check authorized folders
    if let Some(lock) = AUTHORIZED_FOLDERS.get() {
        let folders = lock.lock().await;
        for folder in folders.iter() {
            let fc = folder.path.canonicalize().unwrap_or_else(|_| folder.path.clone());
            if canonical.starts_with(&fc) {
                if needs_write && folder.permission == FolderPermission::ReadOnly {
                    return Err(format!(
                        "Access denied: '{}' is in read-only folder '{}'. Change folder permissions in Settings > Workspace to allow writes.",
                        raw_path,
                        folder.path.display()
                    ));
                }
                return Ok(());
            }
        }
    }

    // 4. Not in any authorized folder
    Err(format!(
        "Access denied: '{}' is outside all authorized folders. Add the parent folder in Settings > Workspace to grant access.",
        raw_path
    ))
}

/// Check if a path matches any enabled sensitive pattern.
async fn is_sensitive_path(canonical: &std::path::Path) -> bool {
    let path_str = canonical.to_string_lossy();

    if let Some(lock) = SENSITIVE_PATTERNS.get() {
        let patterns = lock.lock().await;
        for sp in patterns.iter() {
            if !sp.enabled {
                continue;
            }
            if sp.compiled.matches(&path_str) {
                return true;
            }
            // Also check the filename alone for patterns like **/.env
            if let Some(ref recursive_glob) = sp.recursive_pattern {
                if let Some(filename) = canonical.file_name() {
                    let fname = filename.to_string_lossy();
                    if recursive_glob.matches(&fname) {
                        return true;
                    }
                }
            }
        }
    }
    false
}

/// Get all authorized folder paths as display strings (for system prompt).
pub async fn get_all_authorized_paths() -> Vec<String> {
    if let Some(lock) = AUTHORIZED_FOLDERS.get() {
        let folders = lock.lock().await;
        folders
            .iter()
            .map(|f| {
                let perm = if f.permission == FolderPermission::ReadOnly {
                    "read-only"
                } else {
                    "read-write"
                };
                format!("{} ({})", f.path.display(), perm)
            })
            .collect()
    } else {
        Vec::new()
    }
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

/// Run a future with bot context (bot_id, conversation_id) bound to the current task.
/// Tools within this future can access the originating bot info for smart dispatch inference.
pub async fn with_bot_context<F, R>(bot_id: String, conversation_id: String, fut: F) -> R
where
    F: std::future::Future<Output = R>,
{
    TASK_BOT_CONTEXT.scope((bot_id, conversation_id), fut).await
}

/// Get the current task-local bot context. Returns None if not in a bot conversation.
fn get_current_bot_context() -> Option<(String, String)> {
    TASK_BOT_CONTEXT.try_with(|ctx| ctx.clone()).ok()
}

/// Run a future with a cancellation signal bound to the current task.
pub async fn with_cancelled<F, R>(cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>, fut: F) -> R
where
    F: std::future::Future<Output = R>,
{
    TASK_CANCELLED.scope(cancelled, fut).await
}

/// Check if the current task has been cancelled.
fn is_task_cancelled() -> bool {
    TASK_CANCELLED
        .try_with(|c| c.load(std::sync::atomic::Ordering::Relaxed))
        .unwrap_or(false)
}

/// Run a future with a continuation flag bound to the current task.
pub async fn with_continuation_flag<F, R>(flag: std::sync::Arc<std::sync::atomic::AtomicBool>, fut: F) -> R
where
    F: std::future::Future<Output = R>,
{
    CONTINUATION_REQUESTED.scope(flag, fut).await
}

/// Check if the model requested continuation in the current round.
pub fn is_continuation_requested() -> bool {
    CONTINUATION_REQUESTED
        .try_with(|c| c.load(std::sync::atomic::Ordering::Relaxed))
        .unwrap_or(false)
}

/// Reset the continuation flag for a new round.
pub fn reset_continuation_flag() {
    CONTINUATION_REQUESTED
        .try_with(|c| c.store(false, std::sync::atomic::Ordering::Relaxed))
        .ok();
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

pub fn set_streaming_state(ss: Arc<std::sync::Mutex<std::collections::HashMap<String, crate::state::app_state::StreamingSnapshot>>>) {
    STREAMING_STATE.set(ss).ok();
}

/// Set the user workspace directory for tools (e.g. claude_code default working dir).
pub fn set_user_workspace(dir: std::path::PathBuf) {
    USER_WORKSPACE.set(dir).ok();
}

pub fn set_pty_manager(mgr: Arc<crate::engine::pty_manager::PtyManager>) {
    PTY_MANAGER.set(mgr).ok();
}

/// Get the effective working directory: task-local > global USER_WORKSPACE.
fn get_effective_workspace() -> PathBuf {
    TASK_WORKING_DIR
        .try_with(|d| d.clone())
        .unwrap_or_else(|_| {
            USER_WORKSPACE
                .get()
                .cloned()
                .unwrap_or_else(|| PathBuf::from("."))
        })
}

/// Get the stored database reference (for scheduler).
pub fn get_database() -> Option<Arc<super::db::Database>> {
    DATABASE.get().cloned()
}

/// Get the stored working directory (for scheduler).
pub fn get_working_dir() -> Option<std::path::PathBuf> {
    WORKING_DIR.get().cloned()
}

/// Get the PTY manager reference, returning error if not initialized.
fn get_pty_manager() -> Result<&'static Arc<crate::engine::pty_manager::PtyManager>, String> {
    PTY_MANAGER.get().ok_or_else(|| "PTY manager not initialized".to_string())
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
    let native_tools = crate::state::providers::resolve_native_injections(&p.native_tools, &active.model);
    Some(super::llm_client::LLMConfig {
        base_url,
        api_key,
        model: active.model.clone(),
        provider_id: active.provider_id.clone(),
        native_tools,
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
            let pid = match i32::try_from(id) {
                Ok(p) => p,
                Err(_) => return false,
            };
            let ret = unsafe { libc::kill(pid, 0) };
            if ret == 0 {
                true
            } else {
                // EPERM means the process exists but we lack permission to signal it
                std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
            }
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
            "Search the web using DuckDuckGo. Returns top results with title, snippet and URL. Use for quick information lookup.",
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
            "Install Python packages using pip. Packages are installed to the user's local directory (~/.yiyiclaw/python_packages/).",
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
        // --- Markdown diary & long-term memory tools ---
        tool_def(
            "diary_write",
            "Write an entry to today's diary. Use this to record important events, learnings, decisions, and interactions from the current session.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "content": {
                        "type": "string",
                        "description": "The diary entry content"
                    },
                    "topic": {
                        "type": "string",
                        "description": "Brief topic/title for this entry"
                    }
                },
                "required": ["content"]
            }),
        ),
        tool_def(
            "diary_read",
            "Read diary entries. Can read a specific date or recent days. Returns chronological diary content.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "date": {
                        "type": "string",
                        "description": "Specific date in YYYY-MM-DD format. If omitted, reads recent days."
                    },
                    "days": {
                        "type": "integer",
                        "description": "Number of recent days to read (default: 3, max: 30)"
                    }
                }
            }),
        ),
        tool_def(
            "memory_read",
            "Read the long-term memory file (MEMORY.md). Contains important persistent facts, user preferences, key decisions, and knowledge accumulated over time.",
            serde_json::json!({
                "type": "object",
                "properties": {}
            }),
        ),
        tool_def(
            "memory_write",
            "Update the long-term memory file (MEMORY.md). Use this to promote important information from diary or conversation to persistent memory. Overwrites the entire file - read first, then write the updated version.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "content": {
                        "type": "string",
                        "description": "The complete MEMORY.md content to write"
                    }
                },
                "required": ["content"]
            }),
        ),
        tool_def(
            "manage_cronjob",
            "Create, list, update, delete scheduled tasks, or query execution history. Supports three schedule types:\n\
            - 'delay': one-time task after N minutes (e.g., remind in 5 minutes). Use delay_minutes.\n\
            - 'once': one-time task at a specific time (ISO 8601). Use schedule_at.\n\
            - 'cron': recurring task with cron expression (6 fields: sec min hour day month weekday).\n\
            When called from a Bot conversation without dispatch_targets, auto-infers current Bot + conversation as dispatch target.\n\
            For reminders like '5 min later remind me', use schedule_type='delay' with delay_minutes=5.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["create", "list", "update", "delete", "history", "get_execution"],
                        "description": "操作类型：create 创建、list 列表、update 更新、delete 删除、history 查看执行历史、get_execution 获取某次执行的完整结果"
                    },
                    "name": { "type": "string", "description": "任务名称（create 时使用）" },
                    "schedule_type": {
                        "type": "string",
                        "enum": ["cron", "delay", "once"],
                        "description": "调度类型：delay 延迟N分钟、once 指定时间、cron 周期执行"
                    },
                    "cron": { "type": "string", "description": "Cron表达式（6字段：秒 分 时 日 月 周），仅 schedule_type='cron' 时使用" },
                    "delay_minutes": { "type": "number", "description": "延迟分钟数，仅 schedule_type='delay' 时使用" },
                    "schedule_at": { "type": "string", "description": "执行时间（ISO 8601），仅 schedule_type='once' 时使用，如 '2026-03-09T21:44:00+08:00'" },
                    "text": { "type": "string", "description": "任务内容：notify 类型为通知文本，agent 类型为 AI 提示词" },
                    "task_type": { "type": "string", "enum": ["notify", "agent"], "description": "任务类型：notify 直接通知、agent 由 AI 执行" },
                    "id": { "type": "string", "description": "任务ID（update/delete 时必填）" },
                    "enabled": { "type": "boolean", "description": "是否启用（update 时使用）" },
                    "enabled_only": { "type": "boolean", "description": "仅列出启用的任务（list 时使用，默认 false）" },
                    "dispatch_targets": {
                        "type": "array",
                        "description": "通知目标列表。不指定时：Bot对话自动推断当前Bot+会话；App对话默认系统通知+应用内通知",
                        "items": {
                            "type": "object",
                            "properties": {
                                "type": { "type": "string", "enum": ["system", "app", "bot"], "description": "目标类型" },
                                "bot_id": { "type": "string", "description": "Bot ID（type='bot' 时必填）" },
                                "target": { "type": "string", "description": "目标ID：频道ID、群ID等（type='bot' 时必填）" }
                            },
                            "required": ["type"]
                        }
                    },
                    "schedule_value": { "type": "string", "description": "更新调度值（update 时使用）：cron表达式、ISO 8601时间、或延迟分钟数" },
                    "limit": { "type": "number", "description": "history 时返回的记录数（默认 20）" },
                    "execution_index": { "type": "number", "description": "get_execution 时使用：第N次执行（1=最早，负数从最新算起，-1=最新）" },
                    "execution_id": { "type": "number", "description": "get_execution 时使用：执行记录的数据库ID（优先于 execution_index）" }
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
            "activate_skills",
            "Load detailed instructions for specific skills on demand. \
            Check the 'Available Skills' list in your system prompt and call this when you need specialized knowledge for a task. \
            The skill content will be returned so you can follow the instructions.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "names": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Skill names to activate (from the Available Skills list)"
                    }
                },
                "required": ["names"]
            }),
        ),
        tool_def(
            "request_continuation",
            "Signal that the current task is not yet complete and requires another round to finish. \
            Call this when you have completed a meaningful sub-step but more work remains. \
            Do NOT call this for simple questions, single-step tasks, or when the task is already complete.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "reason": {
                        "type": "string",
                        "description": "Brief description of what remains to be done in the next round"
                    }
                },
                "required": ["reason"]
            }),
        ),
        tool_def(
            "claude_code",
            "Delegate a coding task to Claude Code CLI. Claude Code provides powerful code understanding, editing, searching, and terminal capabilities. \
            Use this for complex coding tasks like multi-file refactoring, feature implementation, debugging, and code analysis. \
            Session continuity is automatic — multiple calls within the same chat session share context. \
            IMPORTANT: After this tool completes, you MUST present the results to the user. \
            If the output is a website/HTML page, use browser_use(headed=true) to open it so the user can see it immediately. \
            If it's a script, run it and show the output. Never just say 'done' without showing tangible results.",
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
        tool_def(
            "spawn_agents",
            "Dynamically create and run a team of temporary agents to handle complex tasks in parallel. Each agent works independently on its assigned task, and all results are collected and returned.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "agents": {
                        "type": "array",
                        "description": "Array of agent specifications to spawn in parallel",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": { "type": "string", "description": "Agent name/role (e.g., 'Researcher', 'Analyst')" },
                                "task": { "type": "string", "description": "Detailed task description for this agent" },
                                "skills": {
                                    "type": "array",
                                    "items": { "type": "string" },
                                    "description": "Optional array of skill names to load for this agent"
                                }
                            },
                            "required": ["name", "task"]
                        }
                    }
                },
                "required": ["agents"]
            }),
        ),
        tool_def(
            "create_task",
            "当用户请求需要较长时间执行的复杂任务时，创建一个独立的后台任务。适用场景：建网站、分析长文档、批量处理文件、创建复杂项目等。不适用于简单问答或单步操作。创建后任务会在后台独立执行。",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "任务标题，简短描述任务内容"
                    },
                    "description": {
                        "type": "string",
                        "description": "任务的详细描述和需求"
                    },
                    "plan": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "执行阶段列表，如 ['初始化项目', '编写代码', '测试']"
                    }
                },
                "required": ["title", "description"]
            }),
        ),
        tool_def(
            "propose_background_task",
            "When you determine a task will take a long time (multi-step file creation, code generation, complex analysis), call this tool to propose background execution to the user. The user can choose to run it in background or continue inline.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "task_name": {
                        "type": "string",
                        "description": "Short task name (e.g. '\u{521b}\u{5efa}\u{4e2a}\u{4eba}\u{4f5c}\u{54c1}\u{96c6}\u{7f51}\u{7ad9}')"
                    },
                    "task_description": {
                        "type": "string",
                        "description": "Brief description of what the task involves and estimated steps"
                    },
                    "context_summary": {
                        "type": "string",
                        "description": "Summary of conversation context: user requirements, preferences, constraints. This will be passed to the background task as initial context."
                    },
                    "estimated_steps": {
                        "type": "number",
                        "description": "Estimated number of steps"
                    }
                },
                "required": ["task_name", "task_description", "context_summary"]
            }),
        ),
        tool_def(
            "create_workspace_dir",
            "Create a workspace directory for task file outputs. Call this BEFORE writing any files when the task will produce files (HTML, code, documents, etc.). The directory is created under the user's workspace (~/Documents/YiYiClaw/).",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "dir_name": {
                        "type": "string",
                        "description": "Meaningful directory name related to the task (e.g. '个人作品集网站', 'Q1数据分析报告')"
                    }
                },
                "required": ["dir_name"]
            }),
        ),
        tool_def(
            "report_progress",
            "Report task progress. Call this after completing a significant sub-step.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "step_title": { "type": "string", "description": "Title of the completed step" },
                    "status": { "type": "string", "enum": ["completed", "in_progress", "blocked"], "description": "Status of this step" },
                    "summary": { "type": "string", "description": "Brief summary of what was done" }
                },
                "required": ["step_title", "status", "summary"]
            }),
        ),
        tool_def(
            "pty_spawn_interactive",
            "Spawn an interactive PTY session for a CLI tool (e.g. bash, python, claude-code). Returns session_id.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Command to run (e.g. 'bash', 'python3', 'claude')" },
                    "args": { "type": "array", "items": { "type": "string" }, "description": "Command arguments" },
                    "cwd": { "type": "string", "description": "Working directory" }
                },
                "required": ["command"]
            }),
        ),
        tool_def(
            "pty_send_input",
            "Send input to an interactive PTY session and wait for output.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "session_id": { "type": "string", "description": "PTY session ID" },
                    "input": { "type": "string", "description": "Text to send (newline appended automatically)" },
                    "wait_ms": { "type": "integer", "description": "Milliseconds to wait for output (default: 3000)" }
                },
                "required": ["session_id", "input"]
            }),
        ),
        tool_def(
            "pty_read_output",
            "Read recent output from a PTY session without sending input.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "session_id": { "type": "string", "description": "PTY session ID" },
                    "wait_ms": { "type": "integer", "description": "Milliseconds to wait for new output (default: 1000)" }
                },
                "required": ["session_id"]
            }),
        ),
        tool_def(
            "pty_close_session",
            "Close an interactive PTY session and kill the process.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "session_id": { "type": "string", "description": "PTY session ID to close" }
                },
                "required": ["session_id"]
            }),
        ),
    ]
}

/// Execute a tool call and return the result
pub async fn execute_tool(call: &ToolCall) -> ToolResult {
    if is_task_cancelled() {
        return ToolResult {
            tool_call_id: call.id.clone(),
            content: "[已取消]".to_string(),
            images: vec![],
        };
    }

    let args: serde_json::Value = match serde_json::from_str(&call.function.arguments) {
        Ok(v) => v,
        Err(_) => {
            // Try lightweight JSON repair before giving up
            match repair_json(&call.function.arguments) {
                Some(repaired) => {
                    log::warn!(
                        "Repaired malformed JSON for tool '{}': {}",
                        call.function.name,
                        call.function.arguments.chars().take(200).collect::<String>()
                    );
                    repaired
                }
                None => {
                    // Return error to model so it can self-correct
                    log::warn!(
                        "Invalid JSON arguments for tool '{}': {}",
                        call.function.name,
                        call.function.arguments.chars().take(200).collect::<String>()
                    );
                    return ToolResult {
                        tool_call_id: call.id.clone(),
                        content: format!(
                            "Error: Invalid JSON in tool arguments. Please retry with valid JSON.\n\
                            Tool: {}\nReceived: {}",
                            call.function.name,
                            call.function.arguments.chars().take(500).collect::<String>()
                        ),
                        images: vec![],
                    };
                }
            }
        }
    };

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
            let (content, images) = desktop_screenshot_tool().await;
            return ToolResult {
                tool_call_id: call.id.clone(),
                content,
                images,
            };
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
            if let Err(e) = access_check(path, false).await {
                format!("Error: {}", e)
            } else {
                doc_tools::read_pdf_text(path)
            }
        }
        "read_spreadsheet" => {
            let path = args["path"].as_str().unwrap_or("");
            if let Err(e) = access_check(path, false).await {
                format!("Error: {}", e)
            } else {
                let sheet = args["sheet"].as_str();
                let max_rows = args["max_rows"].as_u64().map(|n| n as usize);
                doc_tools::read_spreadsheet(path, sheet, max_rows)
            }
        }
        "create_spreadsheet" => {
            let path = args["path"].as_str().unwrap_or("");
            if let Err(e) = access_check(path, true).await {
                format!("Error: {}", e)
            } else {
                let data = &args["data"];
                let sheet_name = args["sheet_name"].as_str();
                doc_tools::create_spreadsheet(path, data, sheet_name)
            }
        }
        "read_docx" => {
            let path = args["path"].as_str().unwrap_or("");
            if let Err(e) = access_check(path, false).await {
                format!("Error: {}", e)
            } else {
                doc_tools::read_docx_text(path)
            }
        }
        "create_docx" => {
            let path = args["path"].as_str().unwrap_or("");
            if let Err(e) = access_check(path, true).await {
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
        "diary_write" => {
            let content = match args["content"].as_str() {
                Some(c) => c,
                None => return ToolResult { tool_call_id: call.id.clone(), content: "Error: content is required".into(), images: vec![] },
            };
            let topic = args["topic"].as_str();
            let working_dir = match WORKING_DIR.get() {
                Some(d) => d.clone(),
                None => return ToolResult { tool_call_id: call.id.clone(), content: "Error: working directory not set".into(), images: vec![] },
            };
            match super::memory::append_diary(&working_dir, content, topic) {
                Ok(()) => {
                    // Also store in DB for search
                    if let Some(db) = DATABASE.get() {
                        let sid = get_current_session_id();
                        let session_id: Option<&str> = if sid.is_empty() { None } else { Some(&sid) };
                        let _ = db.memory_add(content, "note", session_id);
                    }
                    "Diary entry written.".into()
                }
                Err(e) => format!("Error: {e}"),
            }
        }
        "diary_read" => {
            let working_dir = match WORKING_DIR.get() {
                Some(d) => d.clone(),
                None => return ToolResult { tool_call_id: call.id.clone(), content: "Error: working directory not set".into(), images: vec![] },
            };
            if let Some(date) = args.get("date").and_then(|d| d.as_str()) {
                match super::memory::read_diary(&working_dir, date) {
                    Err(e) => e,
                    Ok(content) if content.is_empty() => format!("No diary entry found for {date}."),
                    Ok(content) => content,
                }
            } else {
                let days = args.get("days").and_then(|d| d.as_u64()).unwrap_or(3).min(30) as usize;
                let entries = super::memory::read_recent_diaries(&working_dir, days);
                if entries.is_empty() {
                    "No recent diary entries found.".into()
                } else {
                    let mut output = String::new();
                    for (date, content) in entries {
                        output.push_str(&format!("--- {date} ---\n{content}\n\n"));
                    }
                    output
                }
            }
        }
        "memory_read" => {
            let working_dir = match WORKING_DIR.get() {
                Some(d) => d.clone(),
                None => return ToolResult { tool_call_id: call.id.clone(), content: "Error: working directory not set".into(), images: vec![] },
            };
            let content = super::memory::read_memory_md(&working_dir);
            if content.is_empty() {
                "MEMORY.md is empty. No long-term memories stored yet.".into()
            } else {
                content
            }
        }
        "memory_write" => {
            let content = match args["content"].as_str() {
                Some(c) => c,
                None => return ToolResult { tool_call_id: call.id.clone(), content: "Error: content is required".into(), images: vec![] },
            };
            let working_dir = match WORKING_DIR.get() {
                Some(d) => d.clone(),
                None => return ToolResult { tool_call_id: call.id.clone(), content: "Error: working directory not set".into(), images: vec![] },
            };
            match super::memory::write_memory_md(&working_dir, content) {
                Ok(()) => "MEMORY.md updated successfully.".into(),
                Err(e) => format!("Error: {e}"),
            }
        }
        "manage_cronjob" => manage_cronjob_tool(&args).await,
        "list_bound_bots" => list_bound_bots_tool().await,
        "manage_skill" => manage_skill_tool(&args).await,
        "activate_skills" => activate_skills_tool(&args).await,
        "request_continuation" => {
            CONTINUATION_REQUESTED
                .try_with(|c| c.store(true, std::sync::atomic::Ordering::Relaxed))
                .ok();
            let reason = args["reason"].as_str().unwrap_or("unspecified");
            format!("Continuation scheduled. Remaining work: {}", reason)
        }
        "send_bot_message" => send_bot_message_tool(&args).await,
        "manage_bot" => manage_bot_tool(&args).await,
        "send_notification" => send_notification_tool(&args),
        "add_calendar_event" => add_calendar_event_tool(&args).await,
        "claude_code" => claude_code_tool(&args).await,
        "send_file_to_user" => send_file_to_user_tool(&args).await,
        "create_task" => create_task_tool(&args).await,
        "spawn_agents" => spawn_agents_tool(args.clone()).await,
        "propose_background_task" => {
            // This tool returns a special result that the frontend renders as a confirmation card.
            // The actual background task creation happens when the user clicks "后台执行".
            let task_name = args.get("task_name").and_then(|v| v.as_str()).unwrap_or("Untitled Task");
            let task_description = args.get("task_description").and_then(|v| v.as_str()).unwrap_or("");
            let context_summary = args.get("context_summary").and_then(|v| v.as_str()).unwrap_or("");
            let estimated_steps = args.get("estimated_steps").and_then(|v| v.as_u64()).unwrap_or(0);

            // Emit event so frontend can show confirmation card
            if let Some(handle) = APP_HANDLE.get() {
                let _ = handle.emit("task://propose_background", serde_json::json!({
                    "task_name": task_name,
                    "task_description": task_description,
                    "context_summary": context_summary,
                    "estimated_steps": estimated_steps,
                }));
            }

            // Include workspace_path if one was created for this session
            let session_id = get_current_session_id();
            let workspace_path = if !session_id.is_empty() {
                let map = task_workspace_map().lock().await;
                map.get(&session_id).cloned()
            } else {
                None
            };

            serde_json::json!({
                "__type": "propose_background_task",
                "task_name": task_name,
                "task_description": task_description,
                "context_summary": context_summary,
                "estimated_steps": estimated_steps,
                "workspace_path": workspace_path,
            }).to_string()
        }
        "create_workspace_dir" => {
            let raw_name = args.get("dir_name").and_then(|v| v.as_str()).unwrap_or("task_output");
            // Sanitize: strip path separators and parent-dir references
            let dir_name: String = raw_name
                .replace(['/', '\\'], "_")
                .replace("..", "_")
                .trim()
                .to_string();
            let dir_name = if dir_name.is_empty() { "task_output".to_string() } else { dir_name };

            // Get user workspace directory
            let workspace_base = USER_WORKSPACE
                .get()
                .cloned()
                .unwrap_or_else(|| {
                    dirs::document_dir()
                        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default())
                        .join("YiYiClaw")
                });

            // Create directory with dedup suffix if needed (max 100 attempts)
            let mut target = workspace_base.join(&dir_name);
            if target.exists() {
                let mut suffix = 2;
                while suffix <= 100 {
                    target = workspace_base.join(format!("{}-{}", dir_name, suffix));
                    if !target.exists() {
                        break;
                    }
                    suffix += 1;
                }
            }

            if let Err(e) = std::fs::create_dir_all(&target) {
                format!("Failed to create workspace directory: {}", e)
            } else {
                let abs_path = target.to_string_lossy().to_string();

                // Store in per-session map
                let session_id = get_current_session_id();
                if !session_id.is_empty() {
                    let mut map = task_workspace_map().lock().await;
                    map.insert(session_id, abs_path.clone());
                }

                format!("Workspace directory created: {}\nAll task output files should be written to this directory.", abs_path)
            }
        }
        "report_progress" => {
            let step_title = args["step_title"].as_str().unwrap_or("Unknown step");
            let status = args["status"].as_str().unwrap_or("in_progress");
            let summary = args["summary"].as_str().unwrap_or("");

            // Find task for current session
            let session_id = get_current_session_id();
            let task_info = if let Some(db) = DATABASE.get() {
                db.list_tasks(None, Some("running"))
                    .unwrap_or_default()
                    .into_iter()
                    .find(|t| t.session_id == session_id)
            } else {
                None
            };

            if let Some(task) = &task_info {
                // Update progress.json
                if let Some(wd) = WORKING_DIR.get() {
                    let progress_dir = wd.join("tasks").join(&task.id);
                    std::fs::create_dir_all(&progress_dir).ok();
                    let progress = serde_json::json!({
                        "task_id": task.id,
                        "session_id": session_id,
                        "status": "running",
                        "current_step": step_title,
                        "step_status": status,
                        "step_summary": summary,
                        "current_stage": task.current_stage,
                        "total_stages": task.total_stages,
                        "updated_at": chrono::Utc::now().timestamp(),
                    });
                    write_progress_json(&progress_dir, &progress);
                }

                // Emit step progress event
                if let Some(handle) = APP_HANDLE.get() {
                    handle.emit("task://step_progress", serde_json::json!({
                        "taskId": task.id,
                        "stepTitle": step_title,
                        "status": status,
                        "summary": summary,
                    })).ok();
                }
            }

            format!("Progress reported: [{}] {} - {}", status, step_title, summary)
        }
        "pty_spawn_interactive" => {
            let command = args["command"].as_str().unwrap_or("bash");
            let cmd_args: Vec<String> = args.get("args")
                .and_then(|a| serde_json::from_value(a.clone()).ok())
                .unwrap_or_default();
            let cwd = args["cwd"].as_str()
                .map(String::from)
                .unwrap_or_else(|| get_effective_workspace().to_string_lossy().to_string());
            let cols = args["cols"].as_u64().unwrap_or(80) as u16;
            let rows = args["rows"].as_u64().unwrap_or(24) as u16;

            match (get_pty_manager(), APP_HANDLE.get()) {
                (Ok(mgr), Some(handle)) => {
                    match mgr.spawn(handle, command, &cmd_args, &cwd, cols, rows).await {
                        Ok(sid) => format!("PTY session created: {}", sid),
                        Err(e) => format!("Error spawning PTY: {}", e),
                    }
                }
                (Err(e), _) => e,
                (_, None) => "Error: App handle not available".into(),
            }
        }
        "pty_send_input" => {
            let session_id = args["session_id"].as_str().unwrap_or("");
            let input = args["input"].as_str().unwrap_or("");
            let wait_ms = args["wait_ms"].as_u64().unwrap_or(3000);

            let mgr = match get_pty_manager() {
                Ok(m) => m,
                Err(e) => { return ToolResult { tool_call_id: call.id.clone(), content: e, images: vec![] }; }
            };

            let input_with_nl = format!("{}\n", input);
            if let Err(e) = mgr.write_stdin(session_id, input_with_nl.as_bytes()).await {
                return ToolResult {
                    tool_call_id: call.id.clone(),
                    content: format!("Error writing to PTY: {}", e),
                    images: vec![],
                };
            }

            match mgr.read_output(session_id, wait_ms).await {
                Ok(output) if output.is_empty() => "(no output within timeout)".into(),
                Ok(output) => truncate_output(&output, 8000),
                Err(e) => format!("Error reading PTY output: {}", e),
            }
        }
        "pty_read_output" => {
            let session_id = args["session_id"].as_str().unwrap_or("");
            let wait_ms = args["wait_ms"].as_u64().unwrap_or(1000);

            let mgr = match get_pty_manager() {
                Ok(m) => m,
                Err(e) => { return ToolResult { tool_call_id: call.id.clone(), content: e, images: vec![] }; }
            };

            match mgr.read_output(session_id, wait_ms).await {
                Ok(output) if output.is_empty() => "(no new output)".into(),
                Ok(output) => truncate_output(&output, 8000),
                Err(e) => format!("Error reading PTY output: {}", e),
            }
        }
        "pty_close_session" => {
            let session_id = args["session_id"].as_str().unwrap_or("");

            let mgr = match get_pty_manager() {
                Ok(m) => m,
                Err(e) => { return ToolResult { tool_call_id: call.id.clone(), content: e, images: vec![] }; }
            };

            match mgr.close(session_id).await {
                Ok(()) => format!("PTY session {} closed", session_id),
                Err(e) => format!("Error closing PTY: {}", e),
            }
        }
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
        None => Some(get_effective_workspace().to_string_lossy().to_string()),
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
    if let Err(e) = access_check(path, false).await {
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
    if let Err(e) = access_check(path, true).await {
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
    if let Err(e) = access_check(path, true).await {
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
    if let Err(e) = access_check(path, true).await {
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

    // Access check — verify path is in authorized folders
    if let Err(e) = access_check(path, true).await {
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
    if let Err(e) = access_check(path, false).await {
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
    if let Err(e) = access_check(path, false).await {
        return format!("Error: {}", e);
    }

    // Use Command::new with args to avoid shell injection
    let mut cmd = tokio::process::Command::new("grep");
    cmd.arg("-rn");
    if let Some(fp) = file_pattern {
        cmd.arg(format!("--include={}", fp));
    }
    cmd.arg("--").arg(pattern).arg(path);
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
    if let Err(e) = access_check(path, false).await {
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
    let query = args["query"].as_str().unwrap_or("").trim();
    if query.is_empty() {
        return "Error: query is required".into();
    }

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .build()
        .unwrap_or_default();

    let resp = match client
        .post("https://html.duckduckgo.com/html/")
        .form(&[("q", query)])
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return format!("Search request failed: {}", e),
    };

    let html = match resp.text().await {
        Ok(t) => t,
        Err(e) => return format!("Failed to read response: {}", e),
    };

    let document = scraper::Html::parse_document(&html);
    let result_sel = scraper::Selector::parse(".result").unwrap();
    let title_sel = scraper::Selector::parse(".result__a").unwrap();
    let snippet_sel = scraper::Selector::parse(".result__snippet").unwrap();

    let mut results = Vec::new();
    for el in document.select(&result_sel) {
        if results.len() >= 8 {
            break;
        }
        let title = el
            .select(&title_sel)
            .next()
            .map(|a| a.text().collect::<String>())
            .unwrap_or_default();
        if title.trim().is_empty() {
            continue;
        }
        let href = el
            .select(&title_sel)
            .next()
            .and_then(|a| a.value().attr("href"))
            .unwrap_or("");
        let snippet = el
            .select(&snippet_sel)
            .next()
            .map(|s| s.text().collect::<String>())
            .unwrap_or_default();

        // DuckDuckGo HTML wraps URLs in a redirect; extract the real URL
        let url = if let Some(pos) = href.find("uddg=") {
            let encoded = &href[pos + 5..];
            let end = encoded.find('&').unwrap_or(encoded.len());
            urlencoding::decode(&encoded[..end])
                .unwrap_or_else(|_| encoded[..end].into())
                .into_owned()
        } else {
            href.to_string()
        };

        results.push(format!(
            "{}. {}\n   {}\n   URL: {}",
            results.len() + 1,
            title.trim(),
            snippet.trim(),
            url
        ));
    }

    if results.is_empty() {
        format!("No results found for: {}", query)
    } else {
        results.join("\n\n")
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

async fn desktop_screenshot_tool() -> (String, Vec<String>) {
    // Use macOS screencapture command
    let tmp = format!("/tmp/yiyiclaw_screenshot_{}.png", uuid::Uuid::new_v4());

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
                        let data_uri = format!("data:image/png;base64,{}", b64);
                        (
                            format!("[Screenshot captured successfully, {} bytes]", data.len()),
                            vec![data_uri],
                        )
                    }
                    Err(e) => (format!("Failed to read screenshot: {}", e), vec![]),
                }
            } else {
                ("Screenshot command failed".into(), vec![])
            }
        }
        Err(e) => (format!("Failed to take screenshot: {}", e), vec![]),
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
        let stdout = match child.stdout.take() {
            Some(s) => s,
            None => return (format!("Failed to capture stdout from Playwright bridge process."), vec![]),
        };
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
// manage_cronjob — create/list/update/delete scheduled tasks
// ---------------------------------------------------------------------------

async fn manage_cronjob_tool(args: &serde_json::Value) -> String {
    let action = args["action"].as_str().unwrap_or("");
    let db = match DATABASE.get() {
        Some(db) => db,
        None => return "Error: 数据库未初始化".into(),
    };

    match action {
        "list" => {
            let enabled_only = args["enabled_only"].as_bool().unwrap_or(false);
            match db.list_cronjobs() {
                Ok(jobs) if jobs.is_empty() => "当前没有定时任务。".into(),
                Ok(jobs) => {
                    let filtered: Vec<_> = if enabled_only {
                        jobs.iter().filter(|j| j.enabled).collect()
                    } else {
                        jobs.iter().collect()
                    };
                    if filtered.is_empty() {
                        return "没有符合条件的定时任务。".into();
                    }
                    let items: Vec<String> = filtered
                        .iter()
                        .map(|j| {
                            let schedule: serde_json::Value = serde_json::from_str(&j.schedule_json).unwrap_or_default();
                            let sched_type = schedule["type"].as_str().unwrap_or("cron");
                            let sched_desc = match sched_type {
                                "delay" => format!("延迟 {} 分钟", schedule["delay_minutes"].as_u64().unwrap_or(0)),
                                "once" => format!("定时 {}", schedule["schedule_at"].as_str().unwrap_or("?")),
                                _ => format!("cron: {}", schedule["cron"].as_str().unwrap_or("?")),
                            };
                            let dispatch_info = j.dispatch_json.as_ref().map(|d| {
                                let spec: serde_json::Value = serde_json::from_str(d).unwrap_or_default();
                                if let Some(targets) = spec["targets"].as_array() {
                                    let descs: Vec<String> = targets.iter().map(|t| {
                                        match t["type"].as_str().unwrap_or("") {
                                            "bot" => format!("bot:{}", t["bot_id"].as_str().unwrap_or("?")),
                                            other => other.to_string(),
                                        }
                                    }).collect();
                                    format!(" | 通知: {}", descs.join(", "))
                                } else {
                                    String::new()
                                }
                            }).unwrap_or_default();
                            format!(
                                "- [{}] {} | {} | 类型: {} | 启用: {}{}",
                                j.id, j.name, sched_desc, j.task_type, j.enabled, dispatch_info,
                            )
                        })
                        .collect();
                    format!("定时任务 ({}):\n{}", items.len(), items.join("\n"))
                }
                Err(e) => format!("Error: 查询任务失败: {}", e),
            }
        }
        "create" => {
            let name = args["name"].as_str().unwrap_or("未命名任务");
            let text = args["text"].as_str().unwrap_or("");
            let task_type = args["task_type"].as_str().unwrap_or("notify");
            let schedule_type = args["schedule_type"].as_str().unwrap_or("cron");

            let schedule_json = match schedule_type {
                "delay" => {
                    let minutes = args["delay_minutes"].as_f64().unwrap_or(0.0) as u64;
                    if minutes == 0 {
                        return "Error: delay_minutes 必须大于 0".into();
                    }
                    let created_at = chrono::Utc::now().timestamp() as u64;
                    serde_json::json!({"type": "delay", "delay_minutes": minutes, "created_at": created_at})
                }
                "once" => {
                    let schedule_at = args["schedule_at"].as_str().unwrap_or("");
                    if schedule_at.is_empty() {
                        return "Error: schedule_at (ISO 8601) 是 once 类型的必填参数".into();
                    }
                    // Validate ISO 8601 format
                    if chrono::DateTime::parse_from_rfc3339(schedule_at).is_err() {
                        return format!("Error: schedule_at 格式无效，请使用 ISO 8601 格式，如 '2026-03-09T21:44:00+08:00'");
                    }
                    serde_json::json!({"type": "once", "schedule_at": schedule_at})
                }
                _ => {
                    let cron = args["cron"].as_str().unwrap_or("");
                    if cron.is_empty() {
                        return "Error: cron 表达式是 cron 类型的必填参数".into();
                    }
                    serde_json::json!({"type": "cron", "cron": cron})
                }
            };

            // Build dispatch spec: explicit > bot context inference > default
            let dispatch_json = build_dispatch_json(args);

            let id = uuid::Uuid::new_v4().to_string();
            let row = super::db::CronJobRow {
                id: id.clone(),
                name: name.to_string(),
                enabled: true,
                schedule_json: schedule_json.to_string(),
                task_type: task_type.to_string(),
                text: if text.is_empty() { None } else { Some(text.to_string()) },
                request_json: None,
                dispatch_json,
                runtime_json: None,
                execution_mode: crate::engine::db::ExecutionMode::default(),
            };

            match db.upsert_cronjob(&row) {
                Ok(_) => {
                    // Schedule the job to actually run
                    let spec = crate::commands::cronjobs::CronJobSpec::from_row(&row);
                    schedule_created_job(spec);

                    // Notify frontend to refresh
                    if let Some(handle) = APP_HANDLE.get() {
                        let _ = handle.emit("cronjob://refresh", ());
                    }

                    let schedule_desc = match schedule_type {
                        "delay" => format!("{} 分钟后执行", args["delay_minutes"].as_f64().unwrap_or(0.0) as u64),
                        "once" => format!("在 {} 执行", args["schedule_at"].as_str().unwrap_or("?")),
                        _ => format!("cron: {}", args["cron"].as_str().unwrap_or("?")),
                    };
                    let dispatch_desc = if row.dispatch_json.is_some() {
                        "\n通知目标: 已配置"
                    } else {
                        "\n通知目标: 系统通知 + 应用内通知（默认）"
                    };
                    let result_msg = format!("已创建定时任务「{}」\n调度: {}\n类型: {}\n内容: {}{}", name, schedule_desc, task_type, text, dispatch_desc);

                    // Seed the cron session with creation context:
                    // Copy the user's original message + AI creation summary into cron:{id}
                    seed_cron_session_context(db, &id, name);

                    result_msg
                }
                Err(e) => format!("Error: 保存任务失败: {}", e),
            }
        }
        "update" => {
            let id = args["id"].as_str().unwrap_or("");
            if id.is_empty() {
                return "Error: id 是 update 操作的必填参数".into();
            }

            // Fetch existing job
            let existing = match db.get_cronjob(id) {
                Ok(Some(row)) => row,
                Ok(None) => return format!("Error: 未找到任务 '{}'", id),
                Err(e) => return format!("Error: 查询任务失败: {}", e),
            };

            let mut updated = existing.clone();
            let mut changes = Vec::new();
            let mut need_reschedule = false;

            // Update enabled status
            if let Some(enabled) = args["enabled"].as_bool() {
                updated.enabled = enabled;
                changes.push(format!("启用状态: {}", enabled));
                need_reschedule = true;
            }

            // Update text
            if let Some(text) = args["text"].as_str() {
                updated.text = if text.is_empty() { None } else { Some(text.to_string()) };
                changes.push(format!("内容: {}", text));
            }

            // Update schedule_value (cron expression, or schedule_at for once)
            if let Some(schedule_value) = args["schedule_value"].as_str() {
                let mut schedule: serde_json::Value = serde_json::from_str(&updated.schedule_json).unwrap_or_default();
                let sched_type = schedule["type"].as_str().unwrap_or("cron").to_string();
                match sched_type.as_str() {
                    "cron" => {
                        schedule["cron"] = serde_json::Value::String(schedule_value.to_string());
                        changes.push(format!("cron: {}", schedule_value));
                    }
                    "once" => {
                        if chrono::DateTime::parse_from_rfc3339(schedule_value).is_err() {
                            return format!("Error: schedule_value 格式无效（需要 ISO 8601）");
                        }
                        schedule["schedule_at"] = serde_json::Value::String(schedule_value.to_string());
                        changes.push(format!("执行时间: {}", schedule_value));
                    }
                    "delay" => {
                        if let Ok(mins) = schedule_value.parse::<u64>() {
                            schedule["delay_minutes"] = serde_json::json!(mins);
                            schedule["created_at"] = serde_json::json!(chrono::Utc::now().timestamp() as u64);
                            changes.push(format!("延迟: {} 分钟", mins));
                        } else {
                            return "Error: delay 类型的 schedule_value 必须是分钟数".into();
                        }
                    }
                    _ => {}
                }
                updated.schedule_json = schedule.to_string();
                need_reschedule = true;
            }

            // Update dispatch targets
            let new_dispatch = build_dispatch_json(args);
            if new_dispatch.is_some() {
                updated.dispatch_json = new_dispatch;
                changes.push("通知目标: 已更新".to_string());
            }

            if changes.is_empty() {
                return "没有需要更新的内容。请指定要修改的字段（enabled、text、schedule_value、dispatch_targets）".into();
            }

            match db.upsert_cronjob(&updated) {
                Ok(_) => {
                    // Re-schedule if needed
                    if need_reschedule {
                        // Remove old schedule
                        remove_scheduled_job(id);
                        // Add new schedule if enabled
                        if updated.enabled {
                            let spec = crate::commands::cronjobs::CronJobSpec::from_row(&updated);
                            schedule_created_job(spec);
                        }
                    }

                    // Notify frontend to refresh
                    if let Some(handle) = APP_HANDLE.get() {
                        let _ = handle.emit("cronjob://refresh", ());
                    }

                    format!("已更新任务「{}」\n变更: {}", updated.name, changes.join("、"))
                }
                Err(e) => format!("Error: 更新任务失败: {}", e),
            }
        }
        "delete" => {
            let id = args["id"].as_str().unwrap_or("");
            if id.is_empty() {
                return "Error: id 是 delete 操作的必填参数".into();
            }

            // Get name before deleting
            let job_name = db.get_cronjob(id).ok().flatten()
                .map(|j| j.name).unwrap_or_else(|| id.to_string());

            // Remove from scheduler first
            remove_scheduled_job(id);

            match db.delete_cronjob(id) {
                Ok(_) => {
                    // Notify frontend to refresh
                    if let Some(handle) = APP_HANDLE.get() {
                        let _ = handle.emit("cronjob://refresh", ());
                    }
                    format!("已删除定时任务「{}」", job_name)
                }
                Err(e) => format!("Error: 删除任务失败: {}", e),
            }
        }
        "history" => {
            let id = args["id"].as_str().unwrap_or("");
            // In cron session context, auto-infer job_id from session
            let job_id = if !id.is_empty() {
                id.to_string()
            } else if let Some(sid) = { let s = get_current_session_id(); if s.is_empty() { None } else { Some(s) } } {
                if let Some(jid) = sid.strip_prefix("cron:") {
                    jid.to_string()
                } else {
                    return "Error: id 是 history 操作的必填参数（不在 cron session 中时）".into();
                }
            } else {
                return "Error: id 是 history 操作的必填参数".into();
            };
            let limit = args["limit"].as_u64().unwrap_or(20) as usize;
            match db.list_executions(&job_id, limit) {
                Ok(execs) if execs.is_empty() => "该任务暂无执行记录。".into(),
                Ok(execs) => {
                    let total = execs.len();
                    // execs are ordered DESC (newest first), we display with index
                    // Calculate total count for proper indexing
                    let all_count = db.list_executions(&job_id, 10000).map(|v| v.len()).unwrap_or(total);
                    let items: Vec<String> = execs.iter().enumerate().map(|(i, e)| {
                        let idx = all_count - i; // 1-based, newest = highest
                        let started = chrono::DateTime::from_timestamp(e.started_at, 0)
                            .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
                            .unwrap_or_else(|| e.started_at.to_string());
                        let result_preview = e.result.as_deref().unwrap_or("").chars().take(100).collect::<String>();
                        let result_len = e.result.as_deref().map(|r| r.len()).unwrap_or(0);
                        let truncated = if result_len > 100 { format!("... (共{}字符)", result_len) } else { String::new() };
                        format!(
                            "#{} [ID:{}] {} | 状态: {} | 触发: {} | 结果预览: {}{}",
                            idx, e.id, started, e.status, e.trigger_type, result_preview, truncated,
                        )
                    }).collect();
                    format!("执行历史 (最近{}/{}):\n{}", total, all_count, items.join("\n"))
                }
                Err(e) => format!("Error: 查询执行历史失败: {}", e),
            }
        }
        "get_execution" => {
            let id = args["id"].as_str().unwrap_or("");
            let job_id = if !id.is_empty() {
                id.to_string()
            } else if let Some(sid) = { let s = get_current_session_id(); if s.is_empty() { None } else { Some(s) } } {
                if let Some(jid) = sid.strip_prefix("cron:") {
                    jid.to_string()
                } else {
                    return "Error: id (job_id) 是 get_execution 操作的必填参数（不在 cron session 中时）".into();
                }
            } else {
                return "Error: id (job_id) 是 get_execution 操作的必填参数".into();
            };

            // Find the target execution: by execution_id or execution_index
            if let Some(exec_id) = args["execution_id"].as_i64() {
                // Direct lookup by execution record ID
                match db.list_executions(&job_id, 10000) {
                    Ok(execs) => {
                        match execs.iter().find(|e| e.id == exec_id) {
                            Some(e) => format_full_execution(e, &execs),
                            None => format!("Error: 未找到执行记录 ID={}", exec_id),
                        }
                    }
                    Err(e) => format!("Error: {}", e),
                }
            } else if let Some(idx) = args["execution_index"].as_i64() {
                match db.list_executions(&job_id, 10000) {
                    Ok(execs) if execs.is_empty() => "该任务暂无执行记录。".into(),
                    Ok(execs) => {
                        // execs is DESC order (newest first)
                        // positive index: 1=oldest, 2=second oldest...
                        // negative index: -1=newest, -2=second newest...
                        let total = execs.len() as i64;
                        let actual_idx = if idx > 0 {
                            total - idx // convert 1-based ASC to DESC index
                        } else {
                            (-idx) - 1 // -1 → 0 (newest), -2 → 1 ...
                        };
                        if actual_idx < 0 || actual_idx >= total {
                            return format!("Error: 索引 {} 超出范围，共有 {} 条执行记录", idx, total);
                        }
                        let e = &execs[actual_idx as usize];
                        format_full_execution(e, &execs)
                    }
                    Err(e) => format!("Error: {}", e),
                }
            } else {
                "Error: get_execution 需要 execution_id 或 execution_index 参数".into()
            }
        }
        _ => format!("未知操作: '{}'. 支持的操作: create, list, update, delete, history, get_execution", action),
    }
}

fn format_full_execution(e: &crate::engine::db::CronJobExecutionRow, all_execs: &[crate::engine::db::CronJobExecutionRow]) -> String {
    let total = all_execs.len();
    let pos = all_execs.iter().position(|x| x.id == e.id).unwrap_or(0);
    let index = total - pos; // 1-based, oldest=1
    let started = chrono::DateTime::from_timestamp(e.started_at, 0)
        .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_else(|| e.started_at.to_string());
    let finished = e.finished_at
        .and_then(|t| chrono::DateTime::from_timestamp(t, 0))
        .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_else(|| "进行中".into());
    let result = e.result.as_deref().unwrap_or("(无结果)");
    format!(
        "执行记录 #{} (ID: {})\n\
         开始时间: {}\n\
         结束时间: {}\n\
         状态: {}\n\
         触发方式: {}\n\
         ---\n\
         完整结果:\n{}",
        index, e.id, started, finished, e.status, e.trigger_type, result,
    )
}

/// Seed a cron session (`cron:{job_id}`) with the creation context:
/// the user's original message and an assistant summary, so that when the user
/// navigates to the cron session they see how the task was created.
fn seed_cron_session_context(db: &super::db::Database, job_id: &str, job_name: &str) {
    let cron_session_id = format!("cron:{}", job_id);

    // Ensure the cron session exists
    let _ = db.ensure_session(&cron_session_id, job_name, "cronjob", Some(job_id));

    // Find the user's last message in the current (source) session
    let source_sid = get_current_session_id();
    if source_sid.is_empty() {
        return;
    }
    let messages = match db.get_recent_messages(&source_sid, 10) {
        Ok(msgs) => msgs,
        Err(_) => return,
    };

    // Find the last user message (the one that triggered this creation)
    if let Some(user_msg) = messages.iter().rev().find(|m| m.role == "user") {
        let _ = db.push_message(&cron_session_id, "user", &user_msg.content);
        let summary = format!("好的，我已为你创建了定时任务「{}」。你可以在这里查看执行历史、修改任务设置，或基于执行结果进行进一步操作。", job_name);
        let _ = db.push_message(&cron_session_id, "assistant", &summary);
    }
}

/// Build dispatch JSON from tool arguments, with smart bot context inference.
/// Priority: explicit dispatch_targets > bot context inference > None (use defaults)
fn build_dispatch_json(args: &serde_json::Value) -> Option<String> {
    // Check for explicit dispatch_targets
    if let Some(targets) = args["dispatch_targets"].as_array() {
        let dispatch_targets: Vec<serde_json::Value> = targets.iter().map(|t| {
            serde_json::json!({
                "type": t["type"].as_str().unwrap_or("system"),
                "bot_id": t["bot_id"].as_str(),
                "target": t["target"].as_str(),
            })
        }).collect();
        let spec = serde_json::json!({"targets": dispatch_targets});
        return Some(spec.to_string());
    }

    // Smart inference: if we're in a bot conversation, add the current bot as a dispatch target
    if let Some((bot_id, conversation_id)) = get_current_bot_context() {
        if !conversation_id.trim().is_empty() {
            let spec = serde_json::json!({
                "targets": [
                    {"type": "system"},
                    {"type": "app"},
                    {"type": "bot", "bot_id": bot_id, "target": conversation_id}
                ]
            });
            return Some(spec.to_string());
        } else {
            // conversation_id is empty — only add system + app targets
            let spec = serde_json::json!({
                "targets": [
                    {"type": "system"},
                    {"type": "app"}
                ]
            });
            return Some(spec.to_string());
        }
    }

    // No explicit targets and not in bot context — return None to use defaults
    None
}

/// Remove a scheduled job from the CronScheduler (for update/delete).
fn remove_scheduled_job(job_id: &str) {
    let scheduler_lock = match SCHEDULER.get() {
        Some(s) => s.clone(),
        None => return,
    };
    let job_id = job_id.to_string();
    tokio::spawn(async move {
        let guard = scheduler_lock.read().await;
        if let Some(ref scheduler) = *guard {
            if let Err(e) = scheduler.remove_job(&job_id).await {
                log::error!("Failed to remove job '{}' from scheduler: {}", job_id, e);
            }
        }
    });
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
    let title = args["title"].as_str().unwrap_or("YiYiClaw");
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
        PRODID:-//YiYiClaw//Calendar//EN\r\n\
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
    let temp_dir = std::env::temp_dir().join("yiyiclaw_calendar");
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

async fn activate_skills_tool(args: &serde_json::Value) -> String {
    let names = match args["names"].as_array() {
        Some(arr) => arr.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>(),
        None => return "Error: 'names' must be an array of skill names.".to_string(),
    };
    if names.is_empty() {
        return "Error: provide at least one skill name.".to_string();
    }

    let skills_dir = match WORKING_DIR.get() {
        Some(wd) => wd.join("active_skills"),
        None => return "Error: working directory not configured.".to_string(),
    };

    let mut results = Vec::new();
    let mut not_found = Vec::new();

    for name in &names {
        let skill_md = skills_dir.join(name).join("SKILL.md");
        match tokio::fs::read_to_string(&skill_md).await {
            Ok(content) => {
                // Strip YAML frontmatter — model only needs the instructions
                let body = strip_frontmatter(&content);
                let skill_dir = skills_dir.join(name);
                results.push(format!(
                    "[Skill: {} | directory: {}]\n\n{}",
                    name,
                    skill_dir.to_string_lossy(),
                    body.trim()
                ));
            }
            Err(_) => not_found.push(*name),
        }
    }

    if !not_found.is_empty() {
        // List available skills to help the model self-correct
        let available: Vec<String> = std::fs::read_dir(&skills_dir)
            .ok()
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|e| e.path().join("SKILL.md").exists())
                    .filter_map(|e| e.file_name().into_string().ok())
                    .collect()
            })
            .unwrap_or_default();
        results.push(format!(
            "Skills not found: {}. Available: {}",
            not_found.join(", "),
            available.join(", ")
        ));
    }

    results.join("\n\n---\n\n")
}

/// Attempt lightweight repair of malformed JSON from LLM tool calls.
/// Handles common issues: unclosed braces/brackets, trailing commas, markdown wrapping.
pub fn repair_json(raw: &str) -> Option<serde_json::Value> {
    let mut s = raw.trim().to_string();

    // Strip markdown code fences: ```json ... ```
    if s.starts_with("```") {
        if let Some(start) = s.find('\n') {
            s = s[start + 1..].to_string();
        }
        if s.ends_with("```") {
            s.truncate(s.len() - 3);
            s = s.trim_end().to_string();
        }
    }

    // Remove trailing commas before } or ]
    s = remove_trailing_commas(&s);

    // Try parsing after basic cleanup
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
        return Some(v);
    }

    // Count unclosed braces/brackets and close them
    let mut brace_depth: i32 = 0;
    let mut bracket_depth: i32 = 0;
    let mut in_string = false;
    let mut prev_char = '\0';
    for ch in s.chars() {
        if in_string {
            if ch == '"' && prev_char != '\\' {
                in_string = false;
            }
        } else {
            match ch {
                '"' => in_string = true,
                '{' => brace_depth += 1,
                '}' => brace_depth -= 1,
                '[' => bracket_depth += 1,
                ']' => bracket_depth -= 1,
                _ => {}
            }
        }
        prev_char = ch;
    }

    // If we're still inside a string, close it
    if in_string {
        s.push('"');
    }

    // Close unclosed brackets/braces
    for _ in 0..bracket_depth {
        s.push(']');
    }
    for _ in 0..brace_depth {
        s.push('}');
    }

    // Remove trailing commas again after closing
    s = remove_trailing_commas(&s);

    serde_json::from_str::<serde_json::Value>(&s).ok()
}

/// Remove trailing commas before closing braces/brackets: `,}` → `}`, `,]` → `]`
fn remove_trailing_commas(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == ',' {
            // Look ahead past whitespace for } or ]
            let mut j = i + 1;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            if j < chars.len() && (chars[j] == '}' || chars[j] == ']') {
                // Skip this comma
                i += 1;
                continue;
            }
        }
        result.push(chars[i]);
        i += 1;
    }
    result
}

/// Strip YAML frontmatter (between --- delimiters) from SKILL.md content.
fn strip_frontmatter(content: &str) -> &str {
    let trimmed = content.trim();
    if !trimmed.starts_with("---") {
        return content;
    }
    let rest = &trimmed[3..];
    match rest.find("---") {
        Some(end) => rest[end + 3..].trim_start(),
        None => content,
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
                        let skill_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                        result.push(format!("  [enabled] {}", skill_name));
                    }
                }
            }

            // Customized but disabled
            if let Ok(entries) = std::fs::read_dir(&custom_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() && path.join("SKILL.md").exists() {
                        let skill_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
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
                "YiYiClaw",
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
/// Key: YiYiClaw session_id, Value: Claude Code session_id (from --output-format json).
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

    // Resolve working directory: args > USER_WORKSPACE > WORKING_DIR > "."
    let working_dir = args["working_dir"]
        .as_str()
        .map(|s| s.to_string())
        .or_else(|| USER_WORKSPACE.get().map(|p| p.to_string_lossy().to_string()))
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
    cmd.arg("--output-format").arg("stream-json");
    cmd.arg("--max-turns").arg("30");
    cmd.current_dir(&working_dir);

    // Non-interactive mode: skip permission prompts.
    cmd.arg("--dangerously-skip-permissions");

    // Prevent "nested session" error when called from within a Claude Code context.
    cmd.env_remove("CLAUDECODE");

    // Inject provider API key if ANTHROPIC_API_KEY isn't already in env.
    if std::env::var("ANTHROPIC_API_KEY").map(|v| v.is_empty()).unwrap_or(true) {
        if let Some((api_key, base_url)) = resolve_claude_code_provider().await {
            cmd.env("ANTHROPIC_API_KEY", &api_key);
            cmd.env("ANTHROPIC_BASE_URL", &base_url);
        }
    }

    // Session continuity: look up or create session ID for this chat
    let yiyiclaw_session = get_current_session_id();
    if continue_session && !yiyiclaw_session.is_empty() {
        let sessions = CC_SESSIONS.lock().await;
        if let Some(cc_sid) = sessions.get(&yiyiclaw_session) {
            cmd.arg("--resume").arg(cc_sid);
        }
        drop(sessions);
    }

    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    // Execute with timeout — use spawn + streaming read
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return format!("Error: failed to start claude: {}", e),
    };

    let child_id = child.id();
    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => return "Error: failed to capture claude stdout".into(),
    };

    // Drain stderr in background to prevent pipe buffer from filling up and blocking the child
    let stderr_handle = child.stderr.take().map(|stderr| {
        tokio::spawn(async move {
            let mut buf = String::new();
            let mut reader = tokio::io::BufReader::new(stderr);
            use tokio::io::AsyncReadExt;
            reader.read_to_string(&mut buf).await.ok();
            buf
        })
    });

    // Emit initial progress event
    let handle = APP_HANDLE.get().cloned();
    let session_id = yiyiclaw_session.clone();
    if let Some(h) = &handle {
        h.emit("chat://claude_code_stream", serde_json::json!({
            "type": "start",
            "session_id": session_id,
            "working_dir": working_dir,
        })).ok();
    }

    // Stream stdout line by line (NDJSON from --output-format stream-json)
    let reader = tokio::io::BufReader::new(stdout);
    use tokio::io::AsyncBufReadExt;
    let mut lines = reader.lines();

    let mut final_result = String::new();
    let mut cc_session_id = String::new();
    let mut had_error = false;

    let stream_future = async {
        while let Ok(Some(line)) = lines.next_line().await {
            // Check cancellation on each line
            if is_task_cancelled() {
                return; // Will be handled as cancellation below
            }
            if line.trim().is_empty() {
                continue;
            }
            let json: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let msg_type = json["type"].as_str().unwrap_or("");

            match msg_type {
                "stream_event" => {
                    // Extract streaming text deltas and tool use events
                    let event = &json["event"];
                    let event_type = event["type"].as_str().unwrap_or("");

                    match event_type {
                        "content_block_delta" => {
                            let delta = &event["delta"];
                            let delta_type = delta["type"].as_str().unwrap_or("");
                            if delta_type == "text_delta" {
                                if let Some(text) = delta["text"].as_str() {
                                    if let Some(h) = &handle {
                                        h.emit("chat://claude_code_stream", serde_json::json!({
                                            "type": "text_delta",
                                            "content": text,
                                            "session_id": session_id,
                                        })).ok();
                                    }
                                }
                            }
                        }
                        "content_block_start" => {
                            let block = &event["content_block"];
                            let block_type = block["type"].as_str().unwrap_or("");
                            if block_type == "tool_use" {
                                let tool_name = block["name"].as_str().unwrap_or("unknown");
                                if let Some(h) = &handle {
                                    h.emit("chat://claude_code_stream", serde_json::json!({
                                        "type": "tool_start",
                                        "tool_name": tool_name,
                                        "session_id": session_id,
                                    })).ok();
                                }
                            }
                        }
                        _ => {}
                    }
                }
                // tool_result messages indicate a tool has finished executing
                "tool_result" | "tool_use_summary" => {
                    // Claude Code emits tool_result after tool execution completes
                    let tool_name = json["tool_name"].as_str()
                        .or_else(|| json["name"].as_str())
                        .unwrap_or("unknown");
                    if let Some(h) = &handle {
                        h.emit("chat://claude_code_stream", serde_json::json!({
                            "type": "tool_end",
                            "tool_name": tool_name,
                            "session_id": session_id,
                        })).ok();
                    }
                }
                "assistant" => {
                    // Extract session_id from assistant messages
                    if let Some(sid) = json["session_id"].as_str() {
                        cc_session_id = sid.to_string();
                    }
                }
                "result" => {
                    // Final result — extract text
                    if let Some(result_text) = json["result"].as_str() {
                        final_result = result_text.to_string();
                    } else if let Some(blocks) = json["result"].as_array() {
                        let texts: Vec<&str> = blocks
                            .iter()
                            .filter_map(|b| b["text"].as_str())
                            .collect();
                        if !texts.is_empty() {
                            final_result = texts.join("\n");
                        }
                    }
                    if let Some(sid) = json["session_id"].as_str() {
                        cc_session_id = sid.to_string();
                    }
                }
                _ => {}
            }
        }
    };

    // Wrap with timeout
    let timed_out = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        stream_future,
    ).await.is_err();

    let was_cancelled = is_task_cancelled();

    // Helper to kill the child process and its descendants
    let kill_child = |pid: u32| {
        #[cfg(windows)]
        {
            // /T kills the process tree
            std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .output().ok();
        }
        #[cfg(unix)]
        {
            // Kill the process group (negative PID) to clean up child processes,
            // then fall back to killing the PID directly if it wasn't a group leader.
            unsafe { libc::kill(-(pid as i32), libc::SIGTERM); }
            std::thread::sleep(std::time::Duration::from_millis(100));
            unsafe { libc::kill(-(pid as i32), libc::SIGKILL); }
            // Also kill the process directly in case it didn't have its own group
            unsafe { libc::kill(pid as i32, libc::SIGKILL); }
        }
    };

    if timed_out || was_cancelled {
        // Kill the child process on timeout or cancellation
        if let Some(pid) = child_id {
            kill_child(pid);
        }
        had_error = true;
        final_result = if was_cancelled {
            "Claude Code was cancelled by user.".into()
        } else {
            "Error: Claude Code timed out. Try breaking the task into smaller steps.".into()
        };
    } else {
        // Wait for process exit
        match child.wait().await {
            Ok(status) if !status.success() => {
                had_error = true;
                if final_result.is_empty() {
                    // Try to include stderr for better diagnostics
                    let stderr_text = if let Some(h) = stderr_handle {
                        h.await.ok().unwrap_or_default()
                    } else {
                        String::new()
                    };
                    final_result = if stderr_text.is_empty() {
                        format!("Claude Code exited with code {}", status.code().unwrap_or(-1))
                    } else {
                        format!("Claude Code exited with code {}.\n{}", status.code().unwrap_or(-1), truncate_output(&stderr_text, 4000))
                    };
                }
            }
            Err(e) => {
                had_error = true;
                final_result = format!("Error: failed to wait for claude: {}", e);
            }
            _ => {}
        }
    }

    // Cache Claude Code session ID for continuity
    if !cc_session_id.is_empty() && !yiyiclaw_session.is_empty() {
        let mut sessions = CC_SESSIONS.lock().await;
        if sessions.len() >= CC_SESSIONS_MAX {
            if let Some(oldest) = sessions.keys().next().cloned() {
                sessions.remove(&oldest);
            }
        }
        sessions.insert(yiyiclaw_session, cc_session_id);
    }

    // Emit completion event to frontend
    if let Some(h) = &handle {
        h.emit("chat://claude_code_stream", serde_json::json!({
            "type": "done",
            "session_id": session_id,
            "error": had_error,
        })).ok();
    }

    if final_result.is_empty() {
        "(Claude Code completed with no output)".into()
    } else {
        truncate_output(&final_result, 12000)
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

// ---------------------------------------------------------------------------
// spawn_agents: dynamically create and run ephemeral sub-agents in parallel
// ---------------------------------------------------------------------------

// Depth counter for spawn_agents to prevent infinite recursion.
// Uses task_local so concurrent agent runs track depth independently.
tokio::task_local! {
    static DELEGATION_DEPTH: u32;
}

/// Maximum delegation depth to prevent infinite loops.
const MAX_DELEGATION_DEPTH: u32 = 3;

/// A single agent specification from the spawn_agents tool call.
#[derive(Debug, Deserialize)]
struct AgentSpec {
    name: String,
    task: String,
    #[serde(default)]
    skills: Vec<String>,
}

async fn create_task_tool(args: &serde_json::Value) -> String {
    let title = args.get("title").and_then(|v| v.as_str()).unwrap_or("Untitled Task");
    let description = args.get("description").and_then(|v| v.as_str()).unwrap_or("");
    let plan: Vec<String> = args
        .get("plan")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    let task_id = uuid::Uuid::new_v4().to_string();
    let session_id = format!("task:{}", task_id);
    let total_stages = plan.len() as i32;

    // Get parent session id from task-local context
    let parent_session_id = get_current_session_id();

    let now = chrono::Utc::now().timestamp();

    // 1. Create task session and task record in DB
    if let Some(db) = DATABASE.get() {
        // Create a session for this task
        if let Err(e) = db.ensure_session(&session_id, title, "task", Some(&task_id)) {
            return format!("Error creating task session: {}", e);
        }

        // Build plan JSON if provided
        let plan_json = if plan.is_empty() {
            None
        } else {
            Some(
                serde_json::to_string(
                    &plan
                        .iter()
                        .map(|s| serde_json::json!({"title": s, "status": "pending"}))
                        .collect::<Vec<_>>(),
                )
                .unwrap_or_default(),
            )
        };

        // Create task record in tasks table
        if let Err(e) = db.create_task(
            &task_id,
            title,
            Some(description),
            "pending",
            &session_id,
            Some(&parent_session_id),
            plan_json.as_deref(),
            total_stages,
            now,
        ) {
            return format!("Error creating task record: {}", e);
        }
    } else {
        return "Error: database not available".into();
    }

    // 2. Emit event to notify frontend
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.emit(
            "task://created",
            serde_json::json!({
                "task_id": task_id,
                "session_id": session_id,
                "parent_session_id": parent_session_id,
                "title": title,
                "description": description,
                "plan": plan,
                "total_stages": total_stages,
                "source": "tool",
            }),
        );
    }

    // 3. Spawn async task execution
    spawn_task_execution(
        task_id.clone(),
        session_id.clone(),
        title.to_string(),
        description.to_string(),
        plan.clone(),
        total_stages,
    );

    // Return result to the main conversation
    serde_json::json!({
        "task_id": task_id,
        "session_id": session_id,
        "status": "created",
        "message": format!("任务「{}」已创建并开始执行。任务 ID: {}", title, task_id)
    })
    .to_string()
}

/// Background task that executes a created task via a ReAct Agent.
/// Separated from `create_task_tool` to ensure the async block is Send + 'static.
pub fn spawn_task_execution(
    task_id: String,
    session_id: String,
    title: String,
    description: String,
    plan: Vec<String>,
    total_stages: i32,
) {
    let sid = session_id.clone();
    tokio::spawn(with_session_id(sid, async move {
        // Resolve LLM config
        let llm_config = match resolve_llm_config_from_globals().await {
            Some(cfg) => cfg,
            None => {
                log::error!("Task {}: No active model configured", task_id);
                fail_task(&task_id, &session_id, "No active model configured");
                return;
            }
        };

        let working_dir = match WORKING_DIR.get() {
            Some(wd) => wd.clone(),
            None => {
                log::error!("Task {}: Working directory not set", task_id);
                fail_task(&task_id, &session_id, "Working directory not set");
                return;
            }
        };

        let app_handle = APP_HANDLE.get().cloned();

        // Create cancellation signal via APP_HANDLE -> AppState
        let cancel_signal: Option<std::sync::Arc<std::sync::atomic::AtomicBool>> = if let Some(ref handle) = app_handle {
            use tauri::Manager;
            if let Some(state) = handle.try_state::<crate::state::AppState>() {
                Some(state.get_or_create_task_cancel(&task_id))
            } else {
                None
            }
        } else {
            None
        };

        // Update task status to "running"
        if let Some(db) = DATABASE.get() {
            db.update_task_status(&task_id, "running").ok();
        }

        // Emit running event
        if let Some(ref handle) = app_handle {
            handle.emit("task://progress", serde_json::json!({
                "task_id": task_id,
                "session_id": session_id,
                "status": "running",
                "current_stage": 0,
                "progress": 0.0,
            })).ok();
        }

        // Load skill index + always-active skills
        let skills_dir = working_dir.join("active_skills");
        let mut skill_index = Vec::new();
        let mut always_active_skills = Vec::new();
        if let Ok(mut entries) = tokio::fs::read_dir(&skills_dir).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                let path = entry.path();
                let skill_md = path.join("SKILL.md");
                if let Ok(content) = tokio::fs::read_to_string(&skill_md).await {
                    let name = path.file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let (description, is_always_active) = crate::commands::agent::parse_skill_frontmatter(&content);
                    if is_always_active {
                        always_active_skills.push(content);
                    } else {
                        skill_index.push(crate::commands::agent::SkillIndexEntry {
                            name,
                            description: description.unwrap_or_default(),
                        });
                    }
                }
            }
        }

        // Load MCP tools
        let (mcp_tools_list, unavailable_servers) = if let Some(runtime) = MCP_RUNTIME.get() {
            runtime.get_all_tools_with_status().await
        } else {
            (vec![], vec![])
        };
        let skill_overrides = std::collections::HashMap::new();
        let mcp_extra: Vec<ToolDefinition> = mcp_tools_as_definitions(&mcp_tools_list, &skill_overrides);

        let mcp_ref = if mcp_tools_list.is_empty() { None } else { Some(mcp_tools_list.as_slice()) };
        let unavail_ref = if unavailable_servers.is_empty() { None } else { Some(unavailable_servers.as_slice()) };

        // Build system prompt
        let base_prompt = super::react_agent::build_system_prompt(
            &working_dir, None, &skill_index, &always_active_skills, None, mcp_ref, unavail_ref,
        ).await;

        let plan_text = if plan.is_empty() {
            String::new()
        } else {
            let steps: Vec<String> = plan.iter().enumerate()
                .map(|(i, s)| format!("{}. {}", i + 1, s))
                .collect();
            format!("\n执行计划：\n{}\n", steps.join("\n"))
        };

        let system_prompt = format!(
            "你正在执行一个独立任务。\n\n\
            任务标题：{title}\n\
            任务描述：{description}\n\
            {plan_text}\n\
            请按计划逐步执行每个阶段。每完成一个阶段，请在输出中明确标记 [STAGE_COMPLETE: N]（N 为阶段编号，从 1 开始）来指示进度。\n\
            完成所有阶段后，总结执行结果。\n\n\
            {base_prompt}",
            title = title,
            description = description,
            plan_text = plan_text,
            base_prompt = base_prompt,
        );

        let user_message = format!(
            "开始执行任务「{}」。请按照计划逐步完成。",
            title
        );

        // Track progress from agent output
        let task_id_for_cb = task_id.clone();
        let session_id_for_cb = session_id.clone();
        let total_stages_for_cb = total_stages;
        let app_handle_for_cb = app_handle.clone();

        let on_event = move |evt: super::react_agent::AgentStreamEvent| {
            match &evt {
                super::react_agent::AgentStreamEvent::Token(text) => {
                    // Emit streaming chunk for frontend task stream
                    if let Some(ref handle) = app_handle_for_cb {
                        handle.emit("task://stream_chunk", serde_json::json!({
                            "taskId": task_id_for_cb,
                            "text": text,
                        })).ok();
                    }

                    // Check for [STAGE_COMPLETE: N] markers
                    if let Some(stage) = parse_stage_complete(text) {
                        let progress = if total_stages_for_cb > 0 {
                            (stage as f64 / total_stages_for_cb as f64 * 100.0).min(100.0)
                        } else {
                            0.0
                        };

                        // Update DB progress
                        if let Some(db) = DATABASE.get() {
                            db.update_task_progress(&task_id_for_cb, stage, total_stages_for_cb, progress).ok();
                        }

                        // Emit progress event (camelCase for consistency)
                        if let Some(ref handle) = app_handle_for_cb {
                            handle.emit("task://progress", serde_json::json!({
                                "taskId": task_id_for_cb,
                                "sessionId": session_id_for_cb,
                                "status": "running",
                                "currentStage": stage,
                                "totalStages": total_stages_for_cb,
                                "progress": progress,
                            })).ok();
                        }
                    }
                }
                super::react_agent::AgentStreamEvent::ToolStart { name, args_preview } => {
                    if let Some(ref handle) = app_handle_for_cb {
                        handle.emit("task://tool_start", serde_json::json!({
                            "taskId": task_id_for_cb,
                            "name": name,
                            "preview": args_preview,
                        })).ok();
                    }
                }
                super::react_agent::AgentStreamEvent::ToolEnd { name, result_preview } => {
                    if let Some(ref handle) = app_handle_for_cb {
                        handle.emit("task://tool_end", serde_json::json!({
                            "taskId": task_id_for_cb,
                            "name": name,
                            "preview": result_preview,
                        })).ok();
                    }
                }
                _ => {}
            }
        };

        // Execute the agent
        let result: Result<String, String> = if let Some(ref cancel) = cancel_signal {
            with_cancelled(cancel.clone(), Box::pin(
                super::react_agent::run_react_with_options_stream(
                    &llm_config, &system_prompt, &user_message, &mcp_extra,
                    &[], None, Some(&working_dir), on_event,
                    Some(cancel.as_ref()), None,
                )
            )).await
        } else {
            super::react_agent::run_react_with_options_stream(
                &llm_config, &system_prompt, &user_message, &mcp_extra,
                &[], None, Some(&working_dir), on_event,
                None, None,
            ).await
        };

        // Handle result
        match result {
            Ok(reply) => {
                // Save result to DB
                if let Some(db) = DATABASE.get() {
                    db.update_task_status(&task_id, "completed").ok();
                    db.update_task_progress(&task_id, total_stages, total_stages, 100.0).ok();
                    db.push_message(&session_id, "assistant", &reply).ok();
                }

                if let Some(ref handle) = app_handle {
                    handle.emit("task://completed", serde_json::json!({
                        "taskId": task_id,
                        "sessionId": session_id,
                        "status": "completed",
                        "result": truncate_output(&reply, 3000),
                    })).ok();
                }

                log::info!("Task {} completed successfully", task_id);
            }
            Err(e) => {
                let error_msg = if e == "cancelled" {
                    "任务已被取消"
                } else {
                    &e
                };
                let status = if e == "cancelled" { "cancelled" } else { "failed" };

                fail_task_with_status(&task_id, &session_id, error_msg, status);
                log::warn!("Task {} {}: {}", task_id, status, error_msg);
            }
        }

        // Cleanup cancel signal
        if let Some(ref handle) = app_handle {
            use tauri::Manager;
            if let Some(state) = handle.try_state::<crate::state::AppState>() {
                state.cleanup_task_signal(&task_id);
            }
        }
    }));
}

/// Parse `[STAGE_COMPLETE: N]` marker from text, returning the stage number.
fn parse_stage_complete(text: &str) -> Option<i32> {
    // Look for [STAGE_COMPLETE: N] pattern
    let marker = "[STAGE_COMPLETE:";
    if let Some(start) = text.find(marker) {
        let rest = &text[start + marker.len()..];
        let num_str: String = rest.chars()
            .skip_while(|c| c.is_whitespace())
            .take_while(|c| c.is_ascii_digit())
            .collect();
        num_str.parse::<i32>().ok()
    } else {
        None
    }
}

/// Atomically write progress.json (tmp + rename) for crash recovery.
pub fn write_progress_json(progress_dir: &std::path::Path, data: &serde_json::Value) {
    if let Ok(json) = serde_json::to_string_pretty(data) {
        let tmp_path = progress_dir.join("progress.json.tmp");
        let final_path = progress_dir.join("progress.json");
        if std::fs::write(&tmp_path, &json).is_ok() {
            std::fs::rename(&tmp_path, &final_path).ok();
        }
    }
}

/// Helper: mark task as failed with default "failed" status.
fn fail_task(task_id: &str, session_id: &str, error_message: &str) {
    fail_task_with_status(task_id, session_id, error_message, "failed");
}

/// Helper: mark task as failed/cancelled and emit event.
fn fail_task_with_status(task_id: &str, session_id: &str, error_message: &str, status: &str) {
    if let Some(db) = DATABASE.get() {
        db.update_task_error(task_id, status, error_message).ok();
    }

    if let Some(app) = APP_HANDLE.get() {
        let event_name = if status == "cancelled" { "task://cancelled" } else { "task://failed" };
        app.emit(event_name, serde_json::json!({
            "taskId": task_id,
            "sessionId": session_id,
            "status": status,
            "error": error_message,
        })).ok();
    }
}

async fn spawn_agents_tool(args: serde_json::Value) -> String {
    let specs: Vec<AgentSpec> = match serde_json::from_value(args["agents"].clone()) {
        Ok(v) => v,
        Err(e) => return format!("Error: invalid agents parameter: {}", e),
    };
    if specs.is_empty() {
        return "Error: agents array must not be empty".into();
    }

    // Check delegation depth
    let current_depth = DELEGATION_DEPTH.try_with(|d| *d).unwrap_or(0);
    if current_depth >= MAX_DELEGATION_DEPTH {
        return format!(
            "Error: Maximum delegation depth ({}) reached. Cannot spawn further agents to prevent infinite loops.",
            MAX_DELEGATION_DEPTH
        );
    }

    // Resolve LLM config (use global active LLM — same as parent)
    let llm_config = match resolve_llm_config_from_globals().await {
        Some(cfg) => cfg,
        None => return "Error: No active model configured".into(),
    };

    let working_dir = match WORKING_DIR.get() {
        Some(wd) => wd.clone(),
        None => return "Error: Working directory not set".into(),
    };

    // Grab the global app handle for streaming events (may be None in non-UI contexts)
    let app_handle = APP_HANDLE.get().cloned();

    // Capture session ID for event filtering and DB persistence
    let session_id = get_current_session_id();

    // Emit spawn_start event with agent list and session_id
    if let Some(ref handle) = app_handle {
        let agents_info: Vec<serde_json::Value> = specs
            .iter()
            .map(|s| serde_json::json!({ "name": s.name, "task": s.task }))
            .collect();
        handle
            .emit("chat://spawn_start", serde_json::json!({ "agents": agents_info, "session_id": session_id }))
            .ok();
    }

    // Update streaming snapshot with spawn agent entries
    if let Some(ss_arc) = STREAMING_STATE.get() {
        if let Ok(mut ss) = ss_arc.lock() {
            if let Some(snap) = ss.get_mut(&session_id) {
                snap.spawn_agents = specs.iter().map(|s| {
                    crate::state::app_state::SpawnAgentSnapshot {
                        name: s.name.clone(),
                        task: s.task.clone(),
                        status: "running".into(),
                        content: String::new(),
                        tools: vec![],
                    }
                }).collect();
            }
        }
    }

    // Load skill index + always-active skills for sub-agents
    let skills_dir = working_dir.join("active_skills");
    let mut all_skill_index: Vec<crate::commands::agent::SkillIndexEntry> = Vec::new();
    let mut all_always_active: Vec<String> = Vec::new();
    if let Ok(mut entries) = tokio::fs::read_dir(&skills_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            let skill_md = path.join("SKILL.md");
            if let Ok(content) = tokio::fs::read_to_string(&skill_md).await {
                let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                let (description, is_always_active) = crate::commands::agent::parse_skill_frontmatter(&content);
                if is_always_active {
                    all_always_active.push(content);
                } else {
                    all_skill_index.push(crate::commands::agent::SkillIndexEntry {
                        name,
                        description: description.unwrap_or_default(),
                    });
                }
            }
        }
    }

    // Load MCP tools (inherited from parent) — must be done before spawning as MCP_RUNTIME may not be Send
    let (mcp_tools_list, unavailable_servers) = if let Some(runtime) = MCP_RUNTIME.get() {
        runtime.get_all_tools_with_status().await
    } else {
        (vec![], vec![])
    };
    let skill_overrides = std::collections::HashMap::new();
    let mcp_extra: Vec<ToolDefinition> = mcp_tools_as_definitions(&mcp_tools_list, &skill_overrides);

    let agent_names: Vec<String> = specs.iter().map(|s| s.name.clone()).collect();
    let agent_tasks: Vec<String> = specs.iter().map(|s| s.task.clone()).collect();

    // Launch all agents in a background tokio task — returns immediately
    let depth = current_depth + 1;
    // Inherit the cancellation signal so spawn agents can be stopped
    let cancelled = TASK_CANCELLED.try_with(|c| c.clone()).ok();
    spawn_agents_background(
        specs, depth, llm_config, working_dir, app_handle,
        all_skill_index, all_always_active, mcp_tools_list, unavailable_servers, mcp_extra, session_id, cancelled,
    );

    // Return immediately — agents run in background
    format!(
        "Team started with {} agents: {}.\n\nTheir tasks:\n{}\n\nThe agents are working in the background. Results will be delivered when all agents complete.",
        agent_names.len(),
        agent_names.join(", "),
        agent_names.iter().zip(agent_tasks.iter())
            .map(|(n, t)| format!("- **{}**: {}", n, t))
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

/// Background task that runs spawned agents in parallel. Separated from spawn_agents_tool
/// to ensure the async block is Send + 'static (no borrowed references from the caller).
fn spawn_agents_background(
    specs: Vec<AgentSpec>,
    depth: u32,
    llm_config: super::llm_client::LLMConfig,
    working_dir: std::path::PathBuf,
    app_handle: Option<tauri::AppHandle>,
    all_skill_index: Vec<crate::commands::agent::SkillIndexEntry>,
    all_always_active: Vec<String>,
    mcp_tools_list: Vec<super::mcp_runtime::MCPTool>,
    unavailable_servers: Vec<String>,
    mcp_extra: Vec<ToolDefinition>,
    session_id: String,
    cancelled: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
) {
    let sid = session_id.clone();
    tokio::spawn(with_session_id(sid, async move {
        let futures: Vec<_> = specs.into_iter().map(|spec| {
            let config = llm_config.clone();
            let wd = working_dir.clone();
            let mcp_extra = mcp_extra.clone();
            let skill_idx = all_skill_index.clone();
            let always_active = all_always_active.clone();
            let mcp_tools_for_prompt = mcp_tools_list.clone();
            let unavail_for_prompt = unavailable_servers.clone();
            let handle_for_agent = app_handle.clone();
            let cancelled_for_agent = cancelled.clone();
            let sid_for_agent = session_id.clone();

            async move {
                let agent_name = spec.name.clone();

                // Filter skill index if agent specifies specific skills
                let filtered_index: Vec<crate::commands::agent::SkillIndexEntry> = if spec.skills.is_empty() {
                    skill_idx
                } else {
                    skill_idx.into_iter()
                        .filter(|e| spec.skills.iter().any(|s| s == &e.name))
                        .collect()
                };

                let mcp_ref = if mcp_tools_for_prompt.is_empty() { None } else { Some(mcp_tools_for_prompt.as_slice()) };
                let unavail_ref = if unavail_for_prompt.is_empty() { None } else { Some(unavail_for_prompt.as_slice()) };

                let base_prompt = super::react_agent::build_system_prompt(
                    &wd, None, &filtered_index, &always_active, None, mcp_ref, unavail_ref,
                ).await;

                let system_prompt = format!(
                    "You are **{}**, a specialist agent.\n\
                    Your task: {}\n\n\
                    Complete the task thoroughly and return a clear, concise result.\n\n\
                    {}",
                    spec.name, spec.task, base_prompt
                );

                let result = if let Some(ref handle) = handle_for_agent {
                    let h = handle.clone();
                    let name_for_cb = agent_name.clone();
                    let sid_for_cb = sid_for_agent.clone();
                    let on_event = move |evt: super::react_agent::AgentStreamEvent| {
                        match &evt {
                            super::react_agent::AgentStreamEvent::Token(text) => {
                                h.emit("chat://spawn_agent_chunk", serde_json::json!({
                                    "agent_name": name_for_cb, "content": text,
                                    "session_id": sid_for_cb,
                                })).ok();
                                // Update streaming snapshot
                                if let Some(ss_arc) = STREAMING_STATE.get() {
                                    if let Ok(mut ss) = ss_arc.lock() {
                                        if let Some(snap) = ss.get_mut(&sid_for_cb) {
                                            if let Some(agent) = snap.spawn_agents.iter_mut().find(|a| a.name == name_for_cb) {
                                                agent.content.push_str(text);
                                            }
                                        }
                                    }
                                }
                            }
                            super::react_agent::AgentStreamEvent::ToolStart { name, args_preview } => {
                                h.emit("chat://spawn_agent_tool", serde_json::json!({
                                    "agent_name": name_for_cb, "type": "start",
                                    "tool_name": name, "preview": args_preview,
                                    "session_id": sid_for_cb,
                                })).ok();
                                if let Some(ss_arc) = STREAMING_STATE.get() {
                                    if let Ok(mut ss) = ss_arc.lock() {
                                        if let Some(snap) = ss.get_mut(&sid_for_cb) {
                                            if let Some(agent) = snap.spawn_agents.iter_mut().find(|a| a.name == name_for_cb) {
                                                agent.tools.push(crate::state::app_state::ToolSnapshot {
                                                    name: name.clone(),
                                                    status: "running".into(),
                                                    preview: Some(args_preview.clone()),
                                                });
                                            }
                                        }
                                    }
                                }
                            }
                            super::react_agent::AgentStreamEvent::ToolEnd { name, result_preview } => {
                                h.emit("chat://spawn_agent_tool", serde_json::json!({
                                    "agent_name": name_for_cb, "type": "end",
                                    "tool_name": name, "preview": result_preview,
                                    "session_id": sid_for_cb,
                                })).ok();
                                if let Some(ss_arc) = STREAMING_STATE.get() {
                                    if let Ok(mut ss) = ss_arc.lock() {
                                        if let Some(snap) = ss.get_mut(&sid_for_cb) {
                                            if let Some(agent) = snap.spawn_agents.iter_mut().find(|a| a.name == name_for_cb) {
                                                for t in agent.tools.iter_mut().rev() {
                                                    if t.name == *name && t.status == "running" {
                                                        t.status = "done".into();
                                                        if !result_preview.is_empty() {
                                                            t.preview = Some(result_preview.clone());
                                                        }
                                                        break;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            super::react_agent::AgentStreamEvent::Complete
                            | super::react_agent::AgentStreamEvent::Error
                            | super::react_agent::AgentStreamEvent::Thinking(_) => {}
                        }
                    };
                    DELEGATION_DEPTH.scope(depth, Box::pin(
                        super::react_agent::run_react_with_options_stream(
                            &config, &system_prompt, &spec.task, &mcp_extra,
                            &[], None, Some(&wd), on_event,
                            cancelled_for_agent.as_ref().map(|c| c.as_ref()), None,
                        )
                    )).await
                } else {
                    DELEGATION_DEPTH.scope(depth, Box::pin(
                        super::react_agent::run_react_with_options(
                            &config, &system_prompt, &spec.task, &mcp_extra,
                            &[], None, Some(&wd),
                        )
                    )).await
                };

                let (agent_result_text, is_error) = match result {
                    Ok(reply) => (truncate_output(&reply, 12000), false),
                    Err(e) => (e, true),
                };

                if let Some(ref handle) = handle_for_agent {
                    handle.emit("chat://spawn_agent_complete", serde_json::json!({
                        "agent_name": agent_name, "result": agent_result_text,
                        "session_id": sid_for_agent,
                    })).ok();
                }

                // Update streaming snapshot: mark spawn agent as complete
                if let Some(ss_arc) = STREAMING_STATE.get() {
                    if let Ok(mut ss) = ss_arc.lock() {
                        if let Some(snap) = ss.get_mut(&sid_for_agent) {
                            if let Some(agent) = snap.spawn_agents.iter_mut().find(|a| a.name == agent_name) {
                                agent.status = "complete".into();
                                agent.content = agent_result_text.clone();
                            }
                        }
                    }
                }

                (agent_name, agent_result_text, is_error)
            }
        }).collect();

        let results = futures::future::join_all(futures).await;

        // Build structured agent results for metadata
        let agent_results_json: Vec<serde_json::Value> = results.iter().map(|(name, text, is_err)| {
            serde_json::json!({
                "name": name,
                "result": text.chars().take(3000).collect::<String>(),
                "is_error": is_err,
            })
        }).collect();

        // Save to DB with structured metadata so frontend can render nicely
        if !session_id.is_empty() {
            if let Some(db) = DATABASE.get() {
                let metadata = serde_json::json!({
                    "spawn_agents": agent_results_json,
                }).to_string();
                // Content is a brief summary for LLM context
                let summary: Vec<String> = results.iter().map(|(name, text, is_err)| {
                    let preview: String = text.chars().take(500).collect();
                    if *is_err {
                        format!("[{}] Error: {}", name, preview)
                    } else {
                        format!("[{}] {}", name, preview)
                    }
                }).collect();
                db.push_message_with_metadata(
                    &session_id, "assistant",
                    &summary.join("\n\n"),
                    Some(&metadata),
                ).ok();
            }
        }

        if let Some(ref handle) = app_handle {
            let results_json: Vec<serde_json::Value> = results.iter()
                .map(|(name, result, _)| serde_json::json!({ "name": name, "result": result }))
                .collect();
            handle.emit("chat://spawn_complete", serde_json::json!({
                "results": results_json,
                "session_id": session_id,
            })).ok();
        }
    }));
}
