//! Tools subsystem — the LLM's hands.
//!
//! Each `_tools.rs` sibling implements one family of tools (file I/O, shell,
//! memory, …). This `mod.rs` is a thin facade that:
//!   1. Declares every tool sub-module.
//!   2. Splits its own infrastructure into focused files:
//!      - `types`         — `ToolDefinition` / `ToolCall` / `ToolResult`.
//!      - `state`         — global singletons + task-locals + setters/getters.
//!      - `authorization` — `AuthorizedFolder` / `SensitivePattern` + `access_check`.
//!      - `internal`      — `truncate_output` / `repair_json` / progress.json / MCP fallback.
//!      - `catalog`       — `core_tools` / `deferred_tools` / `tool_search`.
//!      - `dispatch`      — `execute_tool` (the giant router match).
//!   3. Re-exports the surface external callers + sibling tool files used
//!      to read from the old monolithic `mod.rs`, so nothing else had to
//!      move to support the split.
//!
//! When adding a new tool, the only file that grows is `dispatch.rs` (one
//! match arm) + the tool's own `<name>_tools.rs`.

// ── Split infrastructure (used to live in this file) ────────────────
mod authorization;
mod catalog;
mod dispatch;
mod internal;
mod state;
mod types;

// ── Tool implementations (one file per tool family) ─────────────────
mod bot_tools;
pub(crate) mod ask_user;
mod browser_tools;
pub(crate) mod project_tools;
mod canvas_tools;
mod cheap_browser;
mod companion_tools;
mod delegate_tools;
mod cron_tools;
mod file_tools;
mod flash_tools;
mod git_tools;
mod lsp_tools;
pub(crate) mod memory_tools;
pub(crate) mod output_envelope;
pub(crate) mod permission_gate;
pub(crate) mod screenshot_codec;
pub(crate) mod shell_security;
pub(crate) mod skill_tools;
mod snapshot_tools;
mod spawn_tools;
mod system_tools;
mod task_tools;
pub(crate) mod url_guard;
mod web_tools;

// Engine-module aliases so siblings can write `super::db`, `super::llm_client`, etc.
pub(crate) use super::db;
pub(crate) use super::llm_client;
pub(crate) use super::mem::memory;
pub(crate) use super::react_agent;
pub(crate) use super::scheduler;

// ── Re-exports: cheap_browser liveness probe → tool_registry_global ─
pub(super) use cheap_browser::chrome_available;

// ── Re-exports: types ──────────────────────────────────────────────
pub use types::{FunctionCall, FunctionDef, ToolCall, ToolDefinition, ToolResult};
pub(crate) use types::tool_def;

// ── Re-exports: state (public API) ─────────────────────────────────
pub use state::{
    branch_lock_registry, current_tool_filter, get_app_handle, get_current_session_id,
    get_database, get_effective_workspace, get_memme_store, get_task_workspace_for_session,
    get_working_dir, is_continuation_requested, is_ready, is_tool_concurrency_safe,
    is_tracing_enabled, mark_ready, reset_continuation_flag, set_app_handle, set_database,
    set_mcp_runtime, set_memme_store, set_providers, set_pty_manager, set_scheduler,
    set_streaming_state, set_tracing_enabled, set_user_workspace, set_working_dir,
    with_bot_context, with_cancelled, with_continuation_flag, with_session_id,
    with_task_working_dir, with_tool_filter,
};
// pub(crate) globals + atomic statics + consts that siblings reach for directly.
pub(crate) use state::{
    current_memme_user_id, file_state_mark_read, file_state_was_read, get_current_bot_context,
    get_pty_manager, require_db, require_memme, resolve_llm_config_from_globals,
    task_workspace_map, with_memme_user_id, APP_HANDLE, BROWSER_UA, DATABASE,
    DEFAULT_MEMME_USER_ID, MCP_RUNTIME, MEMME_USER_ID, SCHEDULER, STREAMING_STATE,
    TASK_CANCELLED, TASK_SESSION_ID, USER_WORKSPACE, WORKING_DIR,
};

// ── Re-exports: authorization ──────────────────────────────────────
pub use authorization::{
    access_check, get_all_authorized_paths, init_authorized_folders, init_sensitive_patterns,
    refresh_authorized_folders, refresh_sensitive_patterns, AuthorizedFolder, FolderPermission,
    SensitivePattern,
};
pub(crate) use authorization::resolve_path;

// ── Re-exports: internal helpers ───────────────────────────────────
pub use internal::{
    build_mcp_skill_overrides, repair_json, spawn_task_execution, strip_stage_markers,
    write_progress_json,
};
pub(crate) use internal::{scavenge_tool_calls, strip_frontmatter, truncate_output};

// ── Re-exports: catalog ────────────────────────────────────────────
pub use catalog::{builtin_tools, core_tools, deferred_tools, resolve_deferred_tools};
pub(crate) use catalog::TOOLS_DISCOVERED_TAG;

// ── Re-exports: dispatcher ─────────────────────────────────────────
pub use dispatch::execute_tool;
