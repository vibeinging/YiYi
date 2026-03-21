// Sub-modules
mod file_tools;
mod web_tools;
mod browser_tools;
mod system_tools;
mod memory_tools;
mod cron_tools;
mod bot_tools;
mod skill_tools;
pub(crate) mod claude_code;
mod task_tools;
mod spawn_tools;

// Imports used by this module and sub-modules via `super::`
pub(self) use super::doc_tools;
use super::mcp_runtime::MCPRuntime;
pub(self) use super::python_bridge;
// Playwright bridge: browser automation via external Node.js process
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

// Re-export engine sub-modules so child modules can access them via `super::`
pub(self) use super::db;
pub(self) use super::llm_client;
pub(self) use super::memory;
pub(self) use super::react_agent;
pub(self) use super::scheduler;
pub(self) use super::mcp_runtime;

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

/// User-facing workspace directory (~/Documents/YiYi).
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

/// Get database reference or return error string.
fn require_db() -> Result<&'static Arc<super::db::Database>, String> {
    DATABASE.get().ok_or_else(|| "Error: database not available".to_string())
}

/// Get working directory or return error string.
#[allow(dead_code)]
fn require_working_dir() -> Result<std::path::PathBuf, String> {
    WORKING_DIR.get().cloned().ok_or_else(|| "Error: working directory not set".to_string())
}

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

    // 1. Always allow internal working directory (~/.yiyi)
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
pub fn mcp_tools_as_definitions(
    tools: &[super::mcp_runtime::MCPTool],
    skill_overrides: &HashMap<String, String>,
) -> Vec<ToolDefinition> {
    tools
        .iter()
        .map(|t| {
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

// ============================================================================
// Core types
// ============================================================================

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

// ============================================================================
// Helpers used by sub-modules
// ============================================================================

fn truncate_output(s: &str, max_chars: usize) -> String {
    let char_count = s.chars().count();
    if char_count <= max_chars {
        return s.to_string();
    }
    // Keep head (80%) and tail (20%) to preserve both context and trailing errors
    let head_chars = max_chars * 4 / 5;
    let tail_chars = max_chars - head_chars;
    let head: String = s.chars().take(head_chars).collect();
    let tail: String = s.chars().skip(char_count - tail_chars).collect();
    format!(
        "{}\n\n... [truncated {} of {} chars] ...\n\n{}",
        head,
        char_count - max_chars,
        char_count,
        tail
    )
}

/// Try to execute a tool via MCP runtime.
async fn try_mcp_tool(
    runtime: &MCPRuntime,
    tool_name: &str,
    args: &serde_json::Value,
) -> Option<String> {
    let all_tools = runtime.get_all_tools().await;
    if let Some(tool) = all_tools.iter().find(|t| t.name == tool_name) {
        if !tool.server_key.is_empty() {
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

/// Attempt lightweight repair of malformed JSON from LLM tool calls.
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

/// Remove trailing commas before closing braces/brackets: `,}` -> `}`, `,]` -> `]`
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

/// Format a millisecond timestamp into a human-readable string.
fn format_timestamp(ts: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ts)
        .map(|dt| dt.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|| ts.to_string())
}

/// Check if Claude Code CLI is installed (cached after first check).
pub(crate) async fn is_claude_cli_available() -> bool {
    claude_code::is_claude_cli_available().await
}

/// Refresh Claude Code CLI availability cache (call after installation).
#[allow(dead_code)]
pub fn refresh_claude_cli_cache() {
    claude_code::refresh_claude_cli_cache();
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

/// Strip `[STAGE_COMPLETE: N]` markers from text.
/// Re-exported for use from `commands/agent/chat.rs`.
pub fn strip_stage_markers(text: &str) -> String {
    task_tools::strip_stage_markers(text)
}

/// Background task that executes a created task via a ReAct Agent.
/// Re-exported for use from `commands/tasks.rs` and `lib.rs`.
pub fn spawn_task_execution(
    task_id: String,
    session_id: String,
    title: String,
    description: String,
    plan: Vec<String>,
    total_stages: i32,
) {
    task_tools::spawn_task_execution(task_id, session_id, title, description, plan, total_stages);
}

// ============================================================================
// builtin_tools & execute_tool — the public API
// ============================================================================

/// Built-in tools available to the agent
pub fn builtin_tools() -> Vec<ToolDefinition> {
    let mut tools = Vec::new();
    tools.extend(system_tools::definitions());
    tools.extend(file_tools::definitions());
    tools.extend(web_tools::definitions());
    tools.extend(browser_tools::definitions());
    tools.extend(memory_tools::definitions());
    tools.extend(cron_tools::definitions());
    tools.extend(bot_tools::definitions());
    tools.extend(skill_tools::definitions());
    tools.extend(claude_code::definitions());
    tools.extend(task_tools::definitions());
    tools.extend(spawn_tools::definitions());
    tools
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
        "execute_shell" => system_tools::execute_shell_tool(&args).await,
        "read_file" => file_tools::read_file_tool(&args).await,
        "write_file" => file_tools::write_file_tool(&args).await,
        "edit_file" => file_tools::edit_file_tool(&args).await,
        "append_file" => file_tools::append_file_tool(&args).await,
        "delete_file" => file_tools::delete_file_tool(&args).await,
        "list_directory" => file_tools::list_directory_tool(&args).await,
        "grep_search" => file_tools::grep_search_tool(&args).await,
        "glob_search" => file_tools::glob_search_tool(&args).await,
        "web_search" => web_tools::web_search_tool(&args).await,
        "get_current_time" => system_tools::get_current_time_tool().await,
        "desktop_screenshot" => {
            let (content, images) = system_tools::desktop_screenshot_tool().await;
            return ToolResult {
                tool_call_id: call.id.clone(),
                content,
                images,
            };
        }
        "browser_use" => {
            let (content, images) = browser_tools::browser_use_tool(&args).await;
            return ToolResult {
                tool_call_id: call.id.clone(),
                content,
                images,
            };
        }
        "run_python" => system_tools::run_python_tool(&args).await,
        "run_python_script" => system_tools::run_python_script_tool(&args).await,
        "pip_install" => system_tools::pip_install_tool(&args).await,
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
        "memory_add" => memory_tools::memory_add_tool(&args).await,
        "memory_search" => memory_tools::memory_search_tool(&args).await,
        "memory_delete" => memory_tools::memory_delete_tool(&args).await,
        "memory_list" => memory_tools::memory_list_tool(&args).await,
        "diary_write" => {
            match memory_tools::diary_write_tool(&args).await {
                Ok(s) => s,
                Err(e) => return ToolResult { tool_call_id: call.id.clone(), content: e, images: vec![] },
            }
        }
        "diary_read" => {
            match memory_tools::diary_read_tool(&args).await {
                Ok(s) => s,
                Err(e) => return ToolResult { tool_call_id: call.id.clone(), content: e, images: vec![] },
            }
        }
        "memory_read" => {
            match memory_tools::memory_read_tool().await {
                Ok(s) => s,
                Err(e) => return ToolResult { tool_call_id: call.id.clone(), content: e, images: vec![] },
            }
        }
        "memory_write" => {
            match memory_tools::memory_write_tool(&args).await {
                Ok(s) => s,
                Err(e) => return ToolResult { tool_call_id: call.id.clone(), content: e, images: vec![] },
            }
        }
        "manage_cronjob" => cron_tools::manage_cronjob_tool(&args).await,
        "manage_quick_action" => skill_tools::manage_quick_action_tool(&args).await,
        "list_bound_bots" => bot_tools::list_bound_bots_tool().await,
        "manage_skill" => skill_tools::manage_skill_tool(&args).await,
        "activate_skills" => skill_tools::activate_skills_tool(&args).await,
        "register_code" => skill_tools::register_code_tool(&args).await,
        "search_my_code" => skill_tools::search_my_code_tool(&args).await,
        "request_continuation" => {
            CONTINUATION_REQUESTED
                .try_with(|c| c.store(true, std::sync::atomic::Ordering::Relaxed))
                .ok();
            let reason = args["reason"].as_str().unwrap_or("unspecified");
            format!("Continuation scheduled. Remaining work: {}", reason)
        }
        "send_bot_message" => bot_tools::send_bot_message_tool(&args).await,
        "manage_bot" => bot_tools::manage_bot_tool(&args).await,
        "send_notification" => system_tools::send_notification_tool(&args),
        "add_calendar_event" => system_tools::add_calendar_event_tool(&args).await,
        "claude_code" => claude_code::claude_code_tool(&args).await,
        "send_file_to_user" => system_tools::send_file_to_user_tool(&args).await,
        "create_task" => task_tools::create_task_tool(&args).await,
        "spawn_agents" => spawn_tools::spawn_agents_tool(args.clone()).await,
        "create_workspace_dir" => task_tools::create_workspace_dir_tool(&args).await,
        "report_progress" => task_tools::report_progress_tool(&args).await,
        "pty_spawn_interactive" => system_tools::pty_spawn_interactive_tool(&args).await,
        "pty_send_input" => system_tools::pty_send_input_tool(&args).await,
        "pty_read_output" => system_tools::pty_read_output_tool(&args).await,
        "pty_close_session" => system_tools::pty_close_session_tool(&args).await,
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
