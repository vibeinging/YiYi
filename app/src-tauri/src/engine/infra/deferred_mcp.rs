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

/// Single proxy stub per deferred MCP server. When the server is
/// deferred, the agent sees ONE tool that represents the whole missing
/// capability. Calling it triggers the install dialog; after install
/// completes, the real MCP server registers its actual (rich) tool set,
/// and the agent retries the original task with the proper tools.
///
/// Why one instead of ten: a long stub list bloats the agent's tool
/// surface and confuses planning. One unmistakable "this feature is
/// behind an install" entry is clearer and cheaper.
const PLAYWRIGHT_STUB: (&str, &str) = (
    "browser_enable",
    "Enable the interactive browser (Playwright). Call this whenever a \
     task needs to navigate, click, type, fill forms, take an ARIA \
     snapshot, or otherwise *interact* with a web page beyond simple \
     read-only fetching with `browser_fetch`. Will prompt the user to \
     install Playwright; once they confirm, a full set of \
     `browser_navigate` / `browser_click` / `browser_type` / \
     `browser_snapshot` / etc. tools becomes available — retry your \
     original step then.",
);

fn stub_for(server_id: &str) -> Option<(&'static str, &'static str)> {
    match server_id {
        "playwright" => Some(PLAYWRIGHT_STUB),
        _ => None,
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

/// If `tool_name` is the proxy stub for a deferred MCP, return that
/// server's id. Used by the dispatcher to route stub invocations to the
/// install-prompt flow instead of a real MCP backend.
pub fn find_stub_owner(tool_name: &str) -> Option<String> {
    let map = registry().read().ok()?;
    for server_id in map.keys() {
        if let Some((stub_name, _)) = stub_for(server_id) {
            if stub_name == tool_name {
                return Some(server_id.clone());
            }
        }
    }
    None
}

/// Build a single proxy `ToolDefinition` for every currently-deferred
/// server. Called from `deferred_tools()` so the agent's tool_search can
/// surface the capability without flooding the tool list.
pub fn stubs_for_active_deferrals() -> Vec<ToolDefinition> {
    let Ok(map) = registry().read() else { return Vec::new(); };
    let mut out = Vec::new();
    for server_id in map.keys() {
        if let Some((name, desc)) = stub_for(server_id) {
            out.push(tool_def(
                name,
                desc,
                json!({
                    "type": "object",
                    "properties": {
                        "reason": {
                            "type": "string",
                            "description": "Optional one-line reason you need this capability — surfaced to the user in the install dialog."
                        }
                    },
                    "additionalProperties": false,
                }),
            ));
        }
    }
    // 按名排序:registry 是 HashMap,keys() 迭代每进程随机。这些 stub 会经
    // tool_search 注入进 tools 数组,无序会让 DeepSeek 的 tools 前缀漂移。见缓存 P1-1。
    out.sort_by(|a, b| a.function.name.cmp(&b.function.name));
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
        assert_eq!(
            find_stub_owner("browser_enable").as_deref(),
            Some("playwright")
        );
        assert_eq!(find_stub_owner("totally_unrelated_tool"), None);
        clear_deferred("playwright");
        assert!(find_stub_owner("browser_enable").is_none());
    }

    #[test]
    #[serial(deferred_mcp_global)]
    fn single_stub_per_deferred_server() {
        cleanup();
        assert!(stubs_for_active_deferrals().is_empty());
        mark_deferred("playwright", "Playwright", vec![]);
        let stubs = stubs_for_active_deferrals();
        assert_eq!(stubs.len(), 1, "exactly one proxy stub per deferred MCP");
        assert_eq!(stubs[0].function.name, "browser_enable");
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
