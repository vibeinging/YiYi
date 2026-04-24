// Sub-modules
mod file_tools;
mod web_tools;
mod browser_tools;
mod system_tools;
pub(crate) mod memory_tools;
mod cron_tools;
mod bot_tools;
pub(crate) mod skill_tools;
mod task_tools;
mod canvas_tools;
mod spawn_tools;
mod computer_tools;
mod lsp_tools;
mod git_tools;
pub(crate) mod shell_security;
pub(crate) mod permission_gate;
pub(crate) mod output_envelope;
pub(crate) mod url_guard;

// Imports used by this module and sub-modules via `super::`
pub(self) use super::doc_tools;
use crate::engine::infra::mcp_runtime::MCPRuntime;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

// Re-export engine sub-modules so child modules can access them via `super::`
pub(self) use super::db;
pub(self) use super::llm_client;
pub(self) use super::mem::memory;
pub(self) use super::react_agent;
pub(self) use super::scheduler;

/// Global MCP runtime reference for tool routing.
pub(crate) static MCP_RUNTIME: std::sync::OnceLock<Arc<MCPRuntime>> = std::sync::OnceLock::new();

/// Global working directory for memory_search and other tools.
static WORKING_DIR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

/// Global Tauri app handle for emitting events to the frontend.
pub(crate) static APP_HANDLE: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

/// Global database reference for tools that need DB access.
static DATABASE: std::sync::OnceLock<Arc<super::db::Database>> = std::sync::OnceLock::new();

/// Global scheduler reference for tools that need to register jobs at runtime.
static SCHEDULER: std::sync::OnceLock<Arc<tokio::sync::RwLock<Option<crate::engine::scheduler::CronScheduler>>>> = std::sync::OnceLock::new();

/// Global providers reference for tools that need LLM config resolution.
static PROVIDERS: std::sync::OnceLock<Arc<tokio::sync::RwLock<crate::state::providers::ProvidersState>>> = std::sync::OnceLock::new();

/// Global streaming state for snapshot updates from spawn agents.
static STREAMING_STATE: std::sync::OnceLock<Arc<std::sync::Mutex<std::collections::HashMap<String, crate::state::app_state::StreamingSnapshot>>>> = std::sync::OnceLock::new();

/// Global MemMe memory store for vector-based memory operations.
static MEMME_STORE: std::sync::OnceLock<Arc<memme_core::MemoryStore>> = std::sync::OnceLock::new();

/// Shared MemMe user ID constant. All memory operations use this as the user scope.
pub(crate) const MEMME_USER_ID: &str = "yiyi_default_user";

/// Global branch lock registry for concurrent agent file coordination.
static BRANCH_LOCKS: std::sync::OnceLock<std::sync::Mutex<crate::engine::coding::branch_lock::BranchLockRegistry>> = std::sync::OnceLock::new();

/// Get or init the global branch lock registry.
pub(crate) fn branch_lock_registry() -> &'static std::sync::Mutex<crate::engine::coding::branch_lock::BranchLockRegistry> {
    BRANCH_LOCKS.get_or_init(|| std::sync::Mutex::new(crate::engine::coding::branch_lock::BranchLockRegistry::new()))
}

/// Readiness flag — set to true after all OnceLock statics are initialized.
static TOOLS_READY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Mark tools subsystem as fully initialized.
pub fn mark_ready() {
    TOOLS_READY.store(true, std::sync::atomic::Ordering::Release);
}

/// Check if tools subsystem is ready.
pub fn is_ready() -> bool {
    TOOLS_READY.load(std::sync::atomic::Ordering::Acquire)
}

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

// Per-agent tool filter for runtime enforcement. Prevents prompt-injection bypass.
tokio::task_local! {
    static AGENT_TOOL_FILTER: super::react_agent::ToolFilter;
}

// Per-agent file state cache. Tracks which files the agent has read.
// edit_file and write_file (for existing files) require a prior read_file call.
tokio::task_local! {
    static FILE_STATE_CACHE: std::sync::Arc<std::sync::Mutex<std::collections::HashSet<String>>>;
}

/// Record that a file has been read by the current agent.
pub(crate) fn file_state_mark_read(path: &str) {
    if let Ok(cache) = FILE_STATE_CACHE.try_with(|c| c.clone()) {
        if let Ok(mut set) = cache.lock() {
            set.insert(path.to_string());
        }
    }
}

/// Check if a file has been read by the current agent.
pub(crate) fn file_state_was_read(path: &str) -> bool {
    FILE_STATE_CACHE.try_with(|c| {
        c.lock().map_or(false, |set| set.contains(path))
    }).unwrap_or(true) // If no cache (e.g., not in agent context), allow
}

/// Returns true if the tool is safe to run concurrently (read-only, no side effects).
pub fn is_tool_concurrency_safe(name: &str) -> bool {
    matches!(name,
        "read_file" | "grep_search" | "glob_search" | "web_search" | "web_fetch"
        | "memory_search" | "memory_list" | "memory_read" | "diary_read"
        | "tool_search" | "query_tasks" | "code_intelligence"
    )
}

/// Scope a future with a tool filter for runtime enforcement.
pub async fn with_tool_filter<F, R>(filter: super::react_agent::ToolFilter, fut: F) -> R
where
    F: std::future::Future<Output = R>,
{
    AGENT_TOOL_FILTER.scope(filter, fut).await
}

/// Get the current agent tool filter (if set).
pub fn current_tool_filter() -> Option<super::react_agent::ToolFilter> {
    AGENT_TOOL_FILTER.try_with(|f| f.clone()).ok()
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
static PTY_MANAGER: std::sync::OnceLock<Arc<crate::engine::infra::pty_manager::PtyManager>> = std::sync::OnceLock::new();

/// Sensitive path patterns.
static SENSITIVE_PATTERNS: std::sync::OnceLock<Mutex<Vec<SensitivePattern>>> =
    std::sync::OnceLock::new();

/// Get database reference or return error string.
fn require_db() -> Result<&'static Arc<super::db::Database>, String> {
    DATABASE.get().ok_or_else(|| "Error: database not available".to_string())
}

/// Get MemMe memory store or return error string.
fn require_memme() -> Result<&'static Arc<memme_core::MemoryStore>, String> {
    MEMME_STORE.get().ok_or_else(|| "Error: MemMe memory store not available".to_string())
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
    expanded.canonicalize().unwrap_or_else(|_| {
        // For non-existent paths, manually normalize to prevent traversal
        let mut normalized = std::path::PathBuf::new();
        for component in expanded.components() {
            match component {
                std::path::Component::ParentDir => { normalized.pop(); }
                other => normalized.push(other),
            }
        }
        normalized
    })
}

/// Check if a path is authorized for the requested operation.
/// Returns Ok(()) if allowed, Err with clear message if denied.
pub async fn access_check(raw_path: &str, needs_write: bool) -> Result<(), String> {
    if raw_path.is_empty() {
        return Ok(());
    }

    let canonical = resolve_path(raw_path);

    // 0. Always allow standard system paths that tools commonly use
    static ALWAYS_ALLOW: &[&str] = &[
        "/dev/null", "/dev/zero", "/dev/urandom", "/dev/random",
        "/dev/stdin", "/dev/stdout", "/dev/stderr",
        "/tmp", "/private/tmp",
    ];
    let canonical_str = canonical.to_string_lossy();
    if ALWAYS_ALLOW.iter().any(|p| canonical_str.as_ref() == *p || canonical.starts_with(p)) {
        return Ok(());
    }

    // 1. Always allow internal working directory (~/.yiyi)
    if let Some(wd) = WORKING_DIR.get() {
        let wd_canonical = wd.canonicalize().unwrap_or_else(|_| wd.clone());
        if canonical.starts_with(&wd_canonical) {
            return Ok(());
        }
    }

    // 2. Check sensitive path blocklist — ask user via permission gate
    if is_sensitive_path(&canonical).await {
        let reason = format!(
            "「{}」是敏感文件，即使在授权文件夹内也受保护。确定要访问吗？",
            raw_path
        );
        let req = permission_gate::PermissionRequest {
            request_id: uuid::Uuid::new_v4().to_string(),
            permission_type: "sensitive_path".into(),
            path: raw_path.to_string(),
            parent_folder: String::new(),
            reason: reason.clone(),
            risk_level: "high".into(),
        };
        if permission_gate::request_permission(req).await {
            return Ok(()); // One-time pass, not persisted
        }
        return Err(reason);
    }

    // 3. Check authorized folders
    if let Some(lock) = AUTHORIZED_FOLDERS.get() {
        let folders = lock.lock().await;
        for folder in folders.iter() {
            let fc = folder.path.canonicalize().unwrap_or_else(|_| folder.path.clone());
            if canonical.starts_with(&fc) {
                if needs_write && folder.permission == FolderPermission::ReadOnly {
                    let reason = format!(
                        "「{}」在只读文件夹「{}」中，需要写入权限",
                        raw_path, folder.path.display()
                    );
                    let req = permission_gate::PermissionRequest {
                        request_id: uuid::Uuid::new_v4().to_string(),
                        permission_type: "folder_write".into(),
                        path: raw_path.to_string(),
                        parent_folder: folder.path.display().to_string(),
                        reason: reason.clone(),
                        risk_level: "low".into(),
                    };
                    if permission_gate::request_permission(req).await {
                        return Ok(()); // Upgrade handled by frontend via respond command
                    }
                    return Err(reason);
                }
                return Ok(());
            }
        }
    }

    // 4. Not in any authorized folder — ask user to authorize
    let parent_folder = permission_gate::extract_parent_folder(&canonical);
    let parent_str = parent_folder.display().to_string();
    let reason = format!(
        "「{}」不在任何授权文件夹中，是否允许访问？",
        raw_path
    );
    let req = permission_gate::PermissionRequest {
        request_id: uuid::Uuid::new_v4().to_string(),
        permission_type: "folder_access".into(),
        path: raw_path.to_string(),
        parent_folder: parent_str,
        reason: reason.clone(),
        risk_level: "low".into(),
    };
    if permission_gate::request_permission(req).await {
        return Ok(()); // Folder addition handled by frontend via respond command
    }
    Err(reason)
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
    let cache = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashSet::new()));
    TASK_SESSION_ID.scope(session_id, FILE_STATE_CACHE.scope(cache, fut)).await
}

/// Get the current task-local session ID. Returns empty string if not set.
pub fn get_current_session_id() -> String {
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

pub fn set_pty_manager(mgr: Arc<crate::engine::infra::pty_manager::PtyManager>) {
    PTY_MANAGER.set(mgr).ok();
}

pub fn set_memme_store(store: Arc<memme_core::MemoryStore>) {
    MEMME_STORE.set(store).ok();
}

/// Get the MemMe store for use outside the tools module (growth, meditation, helpers).
pub fn get_memme_store() -> Option<&'static Arc<memme_core::MemoryStore>> {
    MEMME_STORE.get()
}

/// Get the effective working directory: task-local > global USER_WORKSPACE.
pub fn get_effective_workspace() -> PathBuf {
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
fn get_pty_manager() -> Result<&'static Arc<crate::engine::infra::pty_manager::PtyManager>, String> {
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
    tools: &[crate::engine::infra::mcp_runtime::MCPTool],
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

pub(super) fn truncate_output(s: &str, max_chars: usize) -> String {
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

/// Core tools — always loaded. Everything else discoverable via tool_search.
pub fn core_tools() -> Vec<ToolDefinition> {
    static CACHE: std::sync::OnceLock<Vec<ToolDefinition>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| {
        let core_names = [
            // File operations (Claw Code MVP)
            "read_file", "write_file", "edit_file",
            "list_directory", "grep_search", "glob_search",
            // Shell (Claw Code MVP)
            "execute_shell",
            // Web
            "web_search",
            // YiYi identity — memory and skills make YiYi who she is
            "memory_search", "memory_add",
            "activate_skills",
            // Multi-step execution
            "spawn_agents",
        ];

        let mut all = Vec::new();
        all.extend(file_tools::definitions());
        all.extend(system_tools::definitions());
        all.extend(web_tools::definitions());
        all.extend(memory_tools::definitions());
        all.extend(skill_tools::definitions());
        all.extend(spawn_tools::definitions());

        all.into_iter()
            .filter(|t| core_names.contains(&t.function.name.as_str()))
            .collect()
    }).clone()
}

/// Extended tools loaded on demand via tool_search.
/// Includes ALL tools not in core set.
pub fn deferred_tools() -> Vec<ToolDefinition> {
    static CACHE: std::sync::OnceLock<Vec<ToolDefinition>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| {
        let core_names = [
            "read_file", "write_file", "edit_file",
            "list_directory", "grep_search", "glob_search",
            "execute_shell", "web_search",
            "memory_search", "memory_add",
            "activate_skills", "spawn_agents",
        ];

        let mut tools = Vec::new();
        // Collect ALL definitions from ALL modules
        tools.extend(system_tools::definitions());
        tools.extend(file_tools::definitions());
        tools.extend(web_tools::definitions());
        tools.extend(browser_tools::definitions());
        tools.extend(memory_tools::definitions());
        tools.extend(cron_tools::definitions());
        tools.extend(bot_tools::definitions());
        tools.extend(skill_tools::definitions());
        tools.extend(task_tools::definitions());
        tools.extend(canvas_tools::definitions());
        tools.extend(spawn_tools::definitions());
        tools.extend(computer_tools::definitions());
        tools.extend(lsp_tools::definitions());
        tools.extend(git_tools::definitions());

        // Buddy delegate tool — consult the user's digital twin
        tools.push(tool_def(
            "ask_buddy",
            "Ask the user's digital twin (buddy) a question. The buddy knows the user's preferences, \
             work style, and decision patterns. Use this instead of asking the user directly for \
             routine decisions like: tech stack choices, coding style preferences, quality judgments. \
             Returns the buddy's answer and confidence level.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description": "The question or decision to delegate to the buddy"
                    },
                    "context": {
                        "type": "string",
                        "description": "Additional context (task description, options being considered, etc.)"
                    }
                },
                "required": ["question"]
            }),
        ));

        // Remove core tools (they're already loaded)
        tools.retain(|t| !core_names.contains(&t.function.name.as_str()));
        tools
    }).clone()
}

/// All tools (core + deferred). Used by execute_tool dispatch.
#[allow(dead_code)]
fn all_tools() -> Vec<ToolDefinition> {
    let mut all = core_tools();
    all.extend(deferred_tools());
    all
}

/// Tag embedded in tool_search output for the agent loop to parse discovered tool names.
pub(crate) const TOOLS_DISCOVERED_TAG: &str = "[TOOLS_DISCOVERED:";

/// Count of deferred tools (cheap — no Vec clone).
pub fn deferred_tools_count() -> usize {
    static COUNT: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    *COUNT.get_or_init(|| deferred_tools().len())
}

/// Search deferred tools by name or keyword. Returns matching tool names + schemas.
/// Appends a `[TOOLS_DISCOVERED:]` tag that the agent loop parses for dynamic injection.
fn execute_tool_search(args: &serde_json::Value) -> String {
    let query = args["query"].as_str().unwrap_or("").trim().to_lowercase();
    let max_results = args["max_results"].as_u64().unwrap_or(5) as usize;

    if query.is_empty() {
        return "Error: query is required".into();
    }

    let deferred = deferred_tools();

    // Support "select:tool1,tool2" for exact name loading
    let matches: Vec<&ToolDefinition> = if let Some(selection) = query.strip_prefix("select:") {
        let wanted: Vec<&str> = selection.split(',').map(|s| s.trim()).collect();
        deferred.iter().filter(|t| wanted.contains(&t.function.name.as_str())).collect()
    } else {
        // Score-based search
        let mut scored: Vec<(&ToolDefinition, i32)> = deferred.iter().map(|t| {
            let name = t.function.name.to_lowercase();
            let desc = t.function.description.to_lowercase();
            let mut score = 0i32;
            if name == query { score += 8; }
            else if name.contains(&query) { score += 4; }
            if desc.contains(&query) { score += 2; }
            // Check individual query words
            for word in query.split_whitespace() {
                if name.contains(word) { score += 3; }
                if desc.contains(word) { score += 1; }
            }
            (t, score)
        }).filter(|(_, s)| *s > 0).collect();
        scored.sort_by(|a, b| b.1.cmp(&a.1));
        scored.into_iter().take(max_results).map(|(t, _)| t).collect()
    };

    if matches.is_empty() {
        let available: Vec<&str> = deferred.iter().map(|t| t.function.name.as_str()).collect();
        return format!(
            "No tools found for '{}'. Available deferred tools: {}",
            query,
            available.join(", ")
        );
    }

    // Build structured response with tool names for dynamic injection
    let tool_names: Vec<&str> = matches.iter().map(|t| t.function.name.as_str()).collect();
    let results: Vec<serde_json::Value> = matches.iter().map(|t| {
        serde_json::json!({
            "name": t.function.name,
            "description": t.function.description,
            "parameters": t.function.parameters,
        })
    }).collect();

    // The [TOOLS_DISCOVERED:...] tag is parsed by the agent loop to dynamically
    // inject these tools into the next API call's `tools` parameter (Claw Code pattern).
    format!(
        "Found {} tool(s). These tools are now available for use:\n\n{}\n\n[TOOLS_DISCOVERED:{}]",
        results.len(),
        serde_json::to_string_pretty(&results).unwrap_or_default(),
        tool_names.join(","),
    )
}

/// Resolve deferred tool definitions by exact names.
/// Used by the agent loop to dynamically inject tools discovered via tool_search.
pub fn resolve_deferred_tools(names: &[&str]) -> Vec<ToolDefinition> {
    let deferred = deferred_tools();
    deferred.into_iter()
        .filter(|t| names.contains(&t.function.name.as_str()))
        .collect()
}

/// Default tool set for conversations. Returns core tools + tool_search.
/// LLM uses tool_search to discover and load deferred tools on demand.
pub fn builtin_tools() -> Vec<ToolDefinition> {
    let mut tools = core_tools();
    // Add tool_search so LLM can discover deferred tools
    tools.push(tool_def(
        "tool_search",
        "Search for additional specialized tools by name or keyword. \
         Not all tools are loaded by default — use this to find tools for: \
         browser automation, bot messaging, scheduled tasks, computer control, \
         canvas rendering, code intelligence (LSP), git operations, and more.",
        serde_json::json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query: tool name, keyword, or 'select:tool1,tool2' for exact names"
                },
                "max_results": {
                    "type": "integer",
                    "description": "Maximum results to return. Default 5."
                }
            },
            "required": ["query"]
        }),
    ));
    tools
}

/// Execute a tool call and return the result
pub async fn execute_tool(call: &ToolCall) -> ToolResult {
    // Startup readiness check — reject tool calls if subsystem not yet initialized
    if !is_ready() {
        return ToolResult {
            tool_call_id: call.id.clone(),
            content: "Error: Tool subsystem not yet initialized. Please wait for app startup to complete.".into(),
            images: vec![],
        };
    }

    if is_task_cancelled() {
        return ToolResult {
            tool_call_id: call.id.clone(),
            content: "[已取消]".to_string(),
            images: vec![],
        };
    }

    // Runtime tool filter enforcement — prevents prompt-injection bypass
    if let Ok(filter) = AGENT_TOOL_FILTER.try_with(|f| f.clone()) {
        if !filter.is_allowed(&call.function.name) {
            return ToolResult {
                tool_call_id: call.id.clone(),
                content: format!(
                    "Error: Tool '{}' is not available to this agent.",
                    call.function.name
                ),
                images: vec![],
            };
        }
    }

    // Defense-in-depth: PermissionPolicy check at tool dispatch level
    // Even if the caller forgot to check, this prevents ReadOnly agents from writing
    {
        use crate::engine::permission_mode::{PermissionPolicy, PermissionMode, PermissionOutcome};
        let mode = if let Ok(filter) = AGENT_TOOL_FILTER.try_with(|f| f.clone()) {
            // Derive mode from tool filter (same logic as core.rs)
            if let super::react_agent::ToolFilter::Allow(ref names) = filter {
                let policy = PermissionPolicy::new(PermissionMode::ReadOnly);
                if names.iter().all(|n| policy.required_mode_for(n) == PermissionMode::ReadOnly) {
                    PermissionMode::ReadOnly
                } else {
                    PermissionMode::Standard
                }
            } else {
                PermissionMode::Standard
            }
        } else {
            PermissionMode::Standard
        };
        let policy = PermissionPolicy::new(mode);
        if let PermissionOutcome::Deny { reason } = policy.is_allowed(&call.function.name) {
            return ToolResult {
                tool_call_id: call.id.clone(),
                content: format!("Error: {reason}"),
                images: vec![],
            };
        }
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
        "undo_edit" => file_tools::undo_edit_tool(&args).await,
        "project_tree" => file_tools::project_tree_tool(&args).await,
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
        "list_bot_conversations" => bot_tools::list_bot_conversations_tool(&args).await,
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
        // "claude_code" removed — YiYi handles coding natively
        "send_file_to_user" => system_tools::send_file_to_user_tool(&args).await,
        "create_task" => task_tools::create_task_tool(&args).await,
        "render_canvas" => canvas_tools::render_canvas_tool(&args).await,
        "spawn_agents" => spawn_tools::spawn_agents_tool(args.clone()).await,
        "create_workspace_dir" => task_tools::create_workspace_dir_tool(&args).await,
        "report_progress" => task_tools::report_progress_tool(&args).await,
        "query_tasks" => task_tools::query_tasks_tool(&args).await,
        "pty_spawn_interactive" => system_tools::pty_spawn_interactive_tool(&args).await,
        "pty_send_input" => system_tools::pty_send_input_tool(&args).await,
        "pty_read_output" => system_tools::pty_read_output_tool(&args).await,
        "pty_close_session" => system_tools::pty_close_session_tool(&args).await,
        "git_commit" => git_tools::git_commit_tool(&args).await,
        "git_create_branch" => git_tools::git_create_branch_tool(&args).await,
        "git_diff" => git_tools::git_diff_tool(&args).await,
        "git_log" => git_tools::git_log_tool(&args).await,
        "git_status" => git_tools::git_status_tool(&args).await,
        "code_intelligence" => lsp_tools::code_intelligence_tool(&args).await,
        "ask_buddy" => {
            let question = args["question"].as_str().unwrap_or("");
            let ctx = args["context"].as_str().unwrap_or("");
            if question.is_empty() {
                "Error: question is required".into()
            } else {
                // Resolve LLM config via APP_HANDLE
                let cfg = if let Some(handle) = APP_HANDLE.get() {
                    use tauri::Manager;
                    let state = handle.state::<crate::state::AppState>();
                    let providers = state.providers.read().await;
                    llm_client::resolve_config_from_providers(&providers).ok()
                } else { None };
                match cfg {
                    Some(cfg) => {
                        match crate::engine::buddy_delegate::delegate(
                            &cfg, question,
                            crate::engine::buddy_delegate::DelegateContext::TaskDecision,
                            ctx,
                        ).await {
                            Some(result) => {
                                serde_json::json!({
                                    "answer": result.answer,
                                    "confidence": result.confidence,
                                    "needs_review": result.needs_review,
                                }).to_string()
                            }
                            None => "Buddy 暂时无法回答（用户画像尚未建立）。请直接询问用户。".into()
                        }
                    }
                    None => "Error: no LLM configured".into()
                }
            }
        }
        "tool_search" => execute_tool_search(&args),
        "computer_control" => {
            let (content, images) = computer_tools::computer_control_tool(&args).await;
            return ToolResult {
                tool_call_id: call.id.clone(),
                content,
                images,
            };
        }
        _ => {
            // Unified dispatch: look up in GlobalToolRegistry first
            if let Some(registry) = crate::engine::tool_registry_global::global_registry() {
                let tool_name = &call.function.name;
                // Check registry for dispatch routing
                if let Some(entry) = registry.get(tool_name) {
                    match &entry.source {
                        crate::engine::tool_registry_global::ToolSource::Plugin { .. } => {
                            // Route to plugin executor using dispatch_name (may have plugin__ prefix)
                            if let Some(handle) = APP_HANDLE.get() {
                                use tauri::Manager;
                                let state: tauri::State<'_, crate::state::AppState> = handle.state();
                                let plugin_reg = state.plugin_registry.read().unwrap();
                                match plugin_reg.execute_tool(&entry.dispatch_name, &args) {
                                    Ok(result) => result,
                                    Err(e) => format!("Plugin tool error: {e}"),
                                }
                            } else {
                                format!("Plugin tool unavailable: no app handle")
                            }
                        }
                        crate::engine::tool_registry_global::ToolSource::Mcp { .. } => {
                            // Route to MCP runtime
                            if let Some(runtime) = MCP_RUNTIME.get() {
                                match try_mcp_tool(runtime, &entry.dispatch_name, &args).await {
                                    Some(result) => result,
                                    None => format!("MCP tool '{}' failed", tool_name),
                                }
                            } else {
                                format!("MCP runtime not available")
                            }
                        }
                        crate::engine::tool_registry_global::ToolSource::BuiltIn => {
                            // Shouldn't reach here (built-ins handled above), but fallback
                            format!("Unknown built-in tool: {}", tool_name)
                        }
                    }
                }
                // Legacy fallback: try prefix-based routing for backward compat
                else if call.function.name.starts_with("plugin__") {
                    if let Some(handle) = APP_HANDLE.get() {
                        use tauri::Manager;
                        let state: tauri::State<'_, crate::state::AppState> = handle.state();
                        let plugin_reg = state.plugin_registry.read().unwrap();
                        match plugin_reg.execute_tool(&call.function.name, &args) {
                            Ok(result) => result,
                            Err(e) => format!("Plugin tool error: {e}"),
                        }
                    } else {
                        format!("Plugin tool unavailable")
                    }
                }
                else if let Some(runtime) = MCP_RUNTIME.get() {
                    match try_mcp_tool(runtime, &call.function.name, &args).await {
                        Some(result) => result,
                        None => format!("Unknown tool: {}", call.function.name),
                    }
                } else {
                    format!("Unknown tool: {}", call.function.name)
                }
            } else {
                format!("Tool registry not initialized: {}", call.function.name)
            }
        }
    };

    ToolResult {
        tool_call_id: call.id.clone(),
        content,
        images: vec![],
    }
}
