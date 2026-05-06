//! "Deferred MCP" registry — tracks MCP servers that didn't start because
//! their prerequisites are missing, and registers placeholder tool stubs
//! so the agent can still plan around the deferred capability and trigger
//! a lazy install on first invocation.
//!
//! Lifecycle:
//!  * App boot — for each enabled MCP whose `requires` aren't met, call
//!    `mark_deferred(server_id, requires)`. The server is NOT spawned.
//!  * Tool registry — `stubs_for_active_deferrals()` returns synthetic
//!    `ToolDefinition`s the agent sees alongside real tools.
//!  * Dispatch — when the agent invokes a tool, `find_stub_owner(name)`
//!    looks it up in the deferred set; if matched, the dispatcher emits
//!    `mcp://needs_install` and returns a placeholder result asking the
//!    agent to retry after the user installs.
//!  * `clear_deferred(server_id)` is called by `retry_mcp_server` once a
//!    real connection succeeds, so subsequent invocations route to the
//!    real MCP runtime instead of the stub.

use crate::engine::tools::{tool_def, ToolDefinition};
use crate::state::config::DepSpec;
use serde_json::json;
use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};

#[derive(Debug, Clone)]
pub struct DeferredEntry {
    pub server_id: String,
    pub server_name: String,
    pub missing: Vec<DepSpec>,
}

/// Hardcoded tool surface for known MCP servers. When the server is
/// deferred we expose these stubs so the agent can plan around the
/// capability. Names match the real Playwright MCP tool names so once
/// the real server is up its definitions seamlessly take over.
const PLAYWRIGHT_STUBS: &[(&str, &str)] = &[
    ("browser_navigate", "Navigate the headless browser to a URL. Provides interactive browsing — for read-only fetching, prefer `browser_fetch`."),
    ("browser_click", "Click on an element identified by an ARIA snapshot ref."),
    ("browser_type", "Type text into a focused or referenced input field."),
    ("browser_snapshot", "Capture an ARIA accessibility-tree snapshot of the current page (text, no pixels). Pair with browser_click/type using the returned refs."),
    ("browser_press_key", "Press a keyboard key (Enter, Tab, Escape, etc.)."),
    ("browser_evaluate", "Run a JavaScript expression on the page and return the result."),
    ("browser_wait_for", "Wait for a selector / text / load state before continuing."),
    ("browser_console_messages", "Read console.log/warn/error messages emitted since last check."),
    ("browser_close", "Close the current browser tab."),
    ("browser_handle_dialog", "Accept or dismiss a JavaScript dialog (alert / confirm / prompt)."),
];

fn stubs_for(server_id: &str) -> &'static [(&'static str, &'static str)] {
    match server_id {
        "playwright" => PLAYWRIGHT_STUBS,
        _ => &[],
    }
}

fn registry() -> &'static RwLock<HashMap<String, DeferredEntry>> {
    static R: OnceLock<RwLock<HashMap<String, DeferredEntry>>> = OnceLock::new();
    R.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Record a deferred MCP server and its missing dependencies.
pub fn mark_deferred(server_id: &str, server_name: &str, missing: Vec<DepSpec>) {
    if let Ok(mut map) = registry().write() {
        map.insert(
            server_id.to_string(),
            DeferredEntry {
                server_id: server_id.to_string(),
                server_name: server_name.to_string(),
                missing,
            },
        );
    }
}

/// Drop a deferred entry once its real MCP connection succeeds.
pub fn clear_deferred(server_id: &str) {
    if let Ok(mut map) = registry().write() {
        map.remove(server_id);
    }
}

/// Return the deferred entry for a server (used by frontend status).
pub fn get_deferred(server_id: &str) -> Option<DeferredEntry> {
    registry().read().ok()?.get(server_id).cloned()
}

/// All currently-deferred entries (for Settings → MCP badges).
pub fn list_deferred() -> Vec<DeferredEntry> {
    registry()
        .read()
        .map(|m| m.values().cloned().collect())
        .unwrap_or_default()
}

/// If `tool_name` is a stub belonging to a deferred MCP, return that
/// server's id. Used by the dispatcher to route stub invocations to the
/// install-prompt flow instead of a real MCP backend.
pub fn find_stub_owner(tool_name: &str) -> Option<String> {
    let map = registry().read().ok()?;
    for (server_id, _) in map.iter() {
        for (stub_name, _desc) in stubs_for(server_id) {
            if *stub_name == tool_name {
                return Some(server_id.clone());
            }
        }
    }
    None
}

/// Build `ToolDefinition`s for every stub owned by a currently-deferred
/// server. Called from `deferred_tools()` so the agent's tool_search can
/// surface them.
pub fn stubs_for_active_deferrals() -> Vec<ToolDefinition> {
    let Ok(map) = registry().read() else { return Vec::new(); };
    let mut out = Vec::new();
    for server_id in map.keys() {
        for (name, desc) in stubs_for(server_id) {
            // Stubs use a permissive schema — the real MCP definition
            // will replace this one once installed; until then we just
            // need the model to know the name and capability.
            out.push(tool_def(
                name,
                &format!(
                    "{} (currently disabled — invoking will prompt the user to install Playwright; agent should retry the call once install succeeds.)",
                    desc
                ),
                json!({
                    "type": "object",
                    "properties": {},
                    "additionalProperties": true,
                }),
            ));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    fn cleanup() {
        if let Ok(mut m) = registry().write() {
            m.clear();
        }
    }

    #[test]
    #[serial(deferred_mcp_global)]
    fn mark_then_find_stub_owner() {
        cleanup();
        mark_deferred("playwright", "Playwright", vec![]);
        assert_eq!(find_stub_owner("browser_navigate").as_deref(), Some("playwright"));
        assert_eq!(find_stub_owner("totally_unrelated_tool"), None);
        clear_deferred("playwright");
        assert!(find_stub_owner("browser_navigate").is_none());
    }

    #[test]
    #[serial(deferred_mcp_global)]
    fn stubs_visible_only_when_deferred() {
        cleanup();
        assert!(stubs_for_active_deferrals().is_empty());
        mark_deferred("playwright", "Playwright", vec![]);
        let stubs = stubs_for_active_deferrals();
        assert!(stubs.iter().any(|t| t.function.name == "browser_navigate"));
        assert!(stubs.iter().any(|t| t.function.name == "browser_snapshot"));
        clear_deferred("playwright");
        assert!(stubs_for_active_deferrals().is_empty());
    }

    #[test]
    #[serial(deferred_mcp_global)]
    fn unknown_server_id_yields_no_stubs() {
        cleanup();
        mark_deferred("acme", "Acme", vec![]);
        assert!(stubs_for_active_deferrals().is_empty());
        clear_deferred("acme");
    }
}
