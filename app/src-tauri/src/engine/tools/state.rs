//! Global state for the tools subsystem.
//!
//! Everything the runtime sets up at startup (or per-task via `tokio::task_local`)
//! lives here:
//!   - `OnceLock` singletons (MCP runtime, working dir, app handle, DB, scheduler, …)
//!   - Per-task scope objects (session id, cancellation flag, tool filter, …)
//!   - Cheap mutable flags (tracing on/off, readiness)
//!
//! Tools throughout the module access these via `super::FOO` re-exports from
//! `mod.rs`. External callers (commands, scheduler, lib.rs) use the public
//! `set_*` / `get_*` API surface.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::engine::infra::mcp_runtime::MCPRuntime;

// ── Global singletons ────────────────────────────────────────────────

/// Global MCP runtime reference for tool routing.
pub(crate) static MCP_RUNTIME: std::sync::OnceLock<Arc<MCPRuntime>> = std::sync::OnceLock::new();

/// Global working directory for memory_search and other tools.
pub(crate) static WORKING_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Global Tauri app handle for emitting events to the frontend.
pub(crate) static APP_HANDLE: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

/// Global database reference for tools that need DB access.
pub(crate) static DATABASE: std::sync::OnceLock<Arc<super::super::db::Database>> =
    std::sync::OnceLock::new();

/// Tracing master switch — config.tracing.enabled mirrored to a process-level
/// atomic so the agent hot path doesn't need to lock config on every turn.
/// Updated by `set_tracing_enabled` from lib.rs config load + Settings toggle.
pub(crate) static TRACING_ENABLED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Global scheduler reference for tools that need to register jobs at runtime.
pub(crate) static SCHEDULER: std::sync::OnceLock<
    Arc<tokio::sync::RwLock<Option<crate::engine::scheduler::CronScheduler>>>,
> = std::sync::OnceLock::new();

/// Global providers reference for tools that need LLM config resolution.
pub(crate) static PROVIDERS: std::sync::OnceLock<
    Arc<tokio::sync::RwLock<crate::state::providers::ProvidersState>>,
> = std::sync::OnceLock::new();

/// Global streaming state for snapshot updates from spawn agents.
pub(crate) static STREAMING_STATE: std::sync::OnceLock<
    Arc<std::sync::Mutex<HashMap<String, crate::state::app_state::StreamingSnapshot>>>,
> = std::sync::OnceLock::new();

/// Global MemMe memory store for vector-based memory operations.
pub(crate) static MEMME_STORE: std::sync::OnceLock<Arc<memme_core::MemoryStore>> =
    std::sync::OnceLock::new();

/// Shared MemMe user ID constant. All memory operations use this as the user scope.
pub(crate) const MEMME_USER_ID: &str = "yiyi_default_user";

/// User-Agent string used by all built-in web fetchers (web_search, browser_fetch).
/// Matches a real Chrome 131 build — anything containing `HeadlessChrome` triggers
/// blanket 403s on Cloudflare/Akamai/Chinese CDN-protected sites.
pub(crate) const BROWSER_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// Global branch lock registry for concurrent agent file coordination.
static BRANCH_LOCKS: std::sync::OnceLock<
    std::sync::Mutex<crate::engine::coding::branch_lock::BranchLockRegistry>,
> = std::sync::OnceLock::new();

/// Get or init the global branch lock registry.
pub fn branch_lock_registry()
-> &'static std::sync::Mutex<crate::engine::coding::branch_lock::BranchLockRegistry> {
    BRANCH_LOCKS
        .get_or_init(|| std::sync::Mutex::new(crate::engine::coding::branch_lock::BranchLockRegistry::new()))
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

/// User-facing workspace directory (~/Documents/YiYi).
/// Used as the default working directory for claude_code and file operations.
pub(crate) static USER_WORKSPACE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Current task workspace path set by create_workspace_dir tool, keyed by session.
static CURRENT_TASK_WORKSPACE: std::sync::OnceLock<Mutex<HashMap<String, String>>> =
    std::sync::OnceLock::new();

pub(crate) fn task_workspace_map() -> &'static Mutex<HashMap<String, String>> {
    CURRENT_TASK_WORKSPACE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Get the task workspace path for a given session.
#[allow(dead_code)]
pub async fn get_task_workspace_for_session(session_id: &str) -> Option<String> {
    let map = task_workspace_map().lock().await;
    map.get(session_id).cloned()
}

/// Global PTY manager reference for interactive terminal sessions.
static PTY_MANAGER: std::sync::OnceLock<Arc<crate::engine::infra::pty_manager::PtyManager>> =
    std::sync::OnceLock::new();

// ── Per-task task_locals ────────────────────────────────────────────

tokio::task_local! {
    pub(crate) static TASK_SESSION_ID: String;
    pub(crate) static TASK_CANCELLED: std::sync::Arc<std::sync::atomic::AtomicBool>;
    pub(crate) static CONTINUATION_REQUESTED: std::sync::Arc<std::sync::atomic::AtomicBool>;
}

tokio::task_local! {
    /// Per-task bot context for tools that need to know the originating bot
    /// (e.g. schedule_create). Stores `(bot_id, conversation_id)` so tools can
    /// infer dispatch targets when called from a Bot conversation.
    pub(crate) static TASK_BOT_CONTEXT: (String, String);
}

tokio::task_local! {
    /// Per-task working directory override. When set, tools use this instead of
    /// the global workspace.
    pub static TASK_WORKING_DIR: PathBuf;
}

tokio::task_local! {
    /// Per-agent tool filter for runtime enforcement. Prevents prompt-injection bypass.
    pub(crate) static AGENT_TOOL_FILTER: super::super::react_agent::ToolFilter;
}

tokio::task_local! {
    /// Per-agent file state cache. Tracks which files the agent has read.
    /// `edit_file` and `write_file` (for existing files) require a prior
    /// `read_file` call.
    pub(crate) static FILE_STATE_CACHE: std::sync::Arc<std::sync::Mutex<std::collections::HashSet<String>>>;
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
    FILE_STATE_CACHE
        .try_with(|c| c.lock().map_or(false, |set| set.contains(path)))
        .unwrap_or(true) // If no cache (e.g., not in agent context), allow
}

// ── Tool-classification helpers ─────────────────────────────────────

/// Returns true if the tool is safe to run concurrently (read-only, no side effects).
pub fn is_tool_concurrency_safe(name: &str) -> bool {
    matches!(
        name,
        "read_file"
            | "grep_search"
            | "glob_search"
            | "web_search"
            | "web_fetch"
            | "browser_screenshot"
            | "browser_fetch"
            | "memory_search"
            | "memory_list"
            | "memory_read"
            | "diary_read"
            | "tool_search"
            | "query_tasks"
            | "code_intelligence"
    )
}

// ── Task-local scope helpers ────────────────────────────────────────

/// Scope a future with a tool filter for runtime enforcement.
pub async fn with_tool_filter<F, R>(filter: super::super::react_agent::ToolFilter, fut: F) -> R
where
    F: std::future::Future<Output = R>,
{
    AGENT_TOOL_FILTER.scope(filter, fut).await
}

/// Get the current agent tool filter (if set).
pub fn current_tool_filter() -> Option<super::super::react_agent::ToolFilter> {
    AGENT_TOOL_FILTER.try_with(|f| f.clone()).ok()
}

/// Run a future with a session ID bound to the current task.
/// All tool calls within this future will see this session ID.
pub async fn with_session_id<F, R>(session_id: String, fut: F) -> R
where
    F: std::future::Future<Output = R>,
{
    let cache = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashSet::new()));
    TASK_SESSION_ID
        .scope(session_id, FILE_STATE_CACHE.scope(cache, fut))
        .await
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
pub(crate) fn get_current_bot_context() -> Option<(String, String)> {
    TASK_BOT_CONTEXT.try_with(|ctx| ctx.clone()).ok()
}

/// Run a future with a cancellation signal bound to the current task.
pub async fn with_cancelled<F, R>(
    cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
    fut: F,
) -> R
where
    F: std::future::Future<Output = R>,
{
    TASK_CANCELLED.scope(cancelled, fut).await
}

/// Check if the current task has been cancelled.
pub(crate) fn is_task_cancelled() -> bool {
    TASK_CANCELLED
        .try_with(|c| c.load(std::sync::atomic::Ordering::Relaxed))
        .unwrap_or(false)
}

/// Run a future with a continuation flag bound to the current task.
pub async fn with_continuation_flag<F, R>(
    flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
    fut: F,
) -> R
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

// ── Setters (called from app init / config reload) ──────────────────

/// Set the MCP runtime for tool execution.
pub fn set_mcp_runtime(runtime: Arc<MCPRuntime>) {
    MCP_RUNTIME.set(runtime).ok();
}

/// Set the working directory for tools that need filesystem context.
pub fn set_working_dir(dir: PathBuf) {
    WORKING_DIR.set(dir).ok();
}

/// Set the Tauri app handle for tools that emit frontend events.
pub fn set_app_handle(handle: tauri::AppHandle) {
    APP_HANDLE.set(handle).ok();
}

/// Set the database reference for tools that need DB access.
pub fn set_database(db: Arc<super::super::db::Database>) {
    DATABASE.set(db).ok();
}

/// Update the tracing master switch. Called from config load + Settings toggle.
pub fn set_tracing_enabled(enabled: bool) {
    TRACING_ENABLED.store(enabled, std::sync::atomic::Ordering::Relaxed);
}

/// Cheap check used by the agent hot path before formatting a trace row.
pub fn is_tracing_enabled() -> bool {
    TRACING_ENABLED.load(std::sync::atomic::Ordering::Relaxed)
}

/// Set the global scheduler reference for tools.
pub fn set_scheduler(
    scheduler: Arc<tokio::sync::RwLock<Option<crate::engine::scheduler::CronScheduler>>>,
) {
    SCHEDULER.set(scheduler).ok();
}

/// Set the global providers reference for tools.
pub fn set_providers(
    providers: Arc<tokio::sync::RwLock<crate::state::providers::ProvidersState>>,
) {
    PROVIDERS.set(providers).ok();
}

pub fn set_streaming_state(
    ss: Arc<std::sync::Mutex<HashMap<String, crate::state::app_state::StreamingSnapshot>>>,
) {
    STREAMING_STATE.set(ss).ok();
}

/// Set the user workspace directory for tools (e.g. claude_code default working dir).
pub fn set_user_workspace(dir: PathBuf) {
    USER_WORKSPACE.set(dir).ok();
}

pub fn set_pty_manager(mgr: Arc<crate::engine::infra::pty_manager::PtyManager>) {
    PTY_MANAGER.set(mgr).ok();
}

pub fn set_memme_store(store: Arc<memme_core::MemoryStore>) {
    MEMME_STORE.set(store).ok();
}

// ── Getters ─────────────────────────────────────────────────────────

/// Get the MemMe store for use outside the tools module (growth, meditation, helpers).
pub fn get_memme_store() -> Option<&'static Arc<memme_core::MemoryStore>> {
    MEMME_STORE.get()
}

/// Get the effective working directory: task-local > global USER_WORKSPACE.
pub fn get_effective_workspace() -> PathBuf {
    TASK_WORKING_DIR
        .try_with(|d| d.clone())
        .unwrap_or_else(|_| USER_WORKSPACE.get().cloned().unwrap_or_else(|| PathBuf::from(".")))
}

/// Get the stored database reference (for scheduler).
pub fn get_database() -> Option<Arc<super::super::db::Database>> {
    DATABASE.get().cloned()
}

/// Get the stored working directory (for scheduler).
pub fn get_working_dir() -> Option<PathBuf> {
    WORKING_DIR.get().cloned()
}

/// Get the PTY manager reference, returning error if not initialized.
pub(crate) fn get_pty_manager()
-> Result<&'static Arc<crate::engine::infra::pty_manager::PtyManager>, String> {
    PTY_MANAGER
        .get()
        .ok_or_else(|| "PTY manager not initialized".to_string())
}

/// Get the stored Tauri app handle.
pub fn get_app_handle() -> Option<&'static tauri::AppHandle> {
    APP_HANDLE.get()
}

// ── Internal `require_*` helpers (panic-free Result accessors) ──────

/// Get database reference or return error string.
pub(crate) fn require_db() -> Result<&'static Arc<super::super::db::Database>, String> {
    DATABASE
        .get()
        .ok_or_else(|| "Error: database not available".to_string())
}

/// Get MemMe memory store or return error string.
pub(crate) fn require_memme() -> Result<&'static Arc<memme_core::MemoryStore>, String> {
    MEMME_STORE
        .get()
        .ok_or_else(|| "Error: MemMe memory store not available".to_string())
}

/// Get working directory or return error string.
#[allow(dead_code)]
pub(crate) fn require_working_dir() -> Result<PathBuf, String> {
    WORKING_DIR
        .get()
        .cloned()
        .ok_or_else(|| "Error: working directory not set".to_string())
}

// ── LLM-config resolution (used by scheduler + internals) ───────────

/// Resolve LLM config from global providers state.
pub(crate) async fn resolve_llm_config_from_globals()
-> Option<super::super::llm_client::LLMConfig> {
    let providers_lock = PROVIDERS.get()?;
    let providers = providers_lock.read().await;
    let active = providers.active_llm.as_ref()?;
    let all = providers.get_all_providers();
    let p = all.iter().find(|p| p.id == active.provider_id)?;
    let base_url = p
        .base_url
        .as_deref()
        .unwrap_or(&p.default_base_url)
        .to_string();
    let api_key = providers
        .providers
        .get(&active.provider_id)
        .and_then(|s| s.api_key.clone());
    let api_key = api_key.or_else(|| std::env::var(&p.api_key_prefix).ok())?;
    let native_tools =
        crate::state::providers::resolve_native_injections(&p.native_tools, &active.model);
    Some(super::super::llm_client::LLMConfig {
        base_url,
        api_key,
        model: active.model.clone(),
        provider_id: active.provider_id.clone(),
        native_tools,
    })
}
