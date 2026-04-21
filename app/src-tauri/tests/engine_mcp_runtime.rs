//! Smoke tests for `engine::infra::mcp_runtime::MCPRuntime`.
//!
//! MCPRuntime bridges YiYi to external MCP servers over either stdio (child
//! process, JSON-RPC over stdin/stdout) or HTTP. Exercising the stdio path
//! truly end-to-end requires a real MCP server binary on PATH — that's out of
//! scope for a unit-style integration test. What we can verify without
//! spawning subprocesses:
//!
//!   - `MCPRuntime::new()` constructs a usable, empty runtime
//!   - read-only accessors (`get_tools`, `get_all_tools`, `get_status`,
//!     `is_available`, `get_all_client_keys`, `get_all_tools_with_status`)
//!     return sensible defaults for unknown keys
//!   - `call_tool` on an unknown server fails cleanly (no panic / hang)
//!   - `disconnect` / `disconnect_all` / `invalidate_cache` are idempotent
//!     on empty state
//!
//! These are foundational API-surface tests. Deeper stdio / HTTP coverage
//! is deferred until a lightweight mock MCP server harness exists.

mod common;

#[allow(unused_imports)]
use common::*;

use app_lib::engine::infra::mcp_runtime::{MCPRuntime, MCPStatus};

// ── Construction ────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn mcp_runtime_new_returns_empty_instance() {
    let rt = MCPRuntime::new();
    assert!(
        rt.get_all_client_keys().await.is_empty(),
        "fresh runtime should have no client keys"
    );
    assert!(
        rt.get_all_tools().await.is_empty(),
        "fresh runtime should have no tools"
    );
    let (tools, unavailable) = rt.get_all_tools_with_status().await;
    assert!(tools.is_empty());
    assert!(unavailable.is_empty());
}

// ── Read-only accessors on unknown server keys ──────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn mcp_runtime_get_tools_for_unknown_key_is_empty() {
    let rt = MCPRuntime::new();
    let tools = rt.get_tools("never-connected").await;
    assert!(tools.is_empty(), "unknown server should surface no tools");
}

#[tokio::test(flavor = "multi_thread")]
async fn mcp_runtime_get_status_on_unknown_key_is_disconnected() {
    let rt = MCPRuntime::new();
    let status = rt.get_status("ghost").await;
    assert_eq!(
        status,
        MCPStatus::Disconnected,
        "unknown server must default to Disconnected"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn mcp_runtime_is_available_false_for_unknown_key() {
    let rt = MCPRuntime::new();
    assert!(
        !rt.is_available("missing").await,
        "unknown server must not be advertised as available"
    );
}

// ── Call on unknown server returns Err (no panic) ───────────────────────
//
// The current implementation pre-checks the process table, finds nothing,
// and falls through to `call_tool_uncached`, which returns an Err. Either
// pre-check-reject or uncached-reject is acceptable — we only require that
// the call does not panic, does not hang, and surfaces an Err.

#[tokio::test(flavor = "multi_thread")]
async fn mcp_runtime_call_tool_on_unknown_server_returns_err() {
    let rt = MCPRuntime::new();
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        rt.call_tool("nope", "irrelevant_tool", serde_json::json!({})),
    )
    .await
    .expect("call_tool must not hang on missing server");

    assert!(
        result.is_err(),
        "call_tool on unknown server must return Err, got: {:?}",
        result.ok()
    );
}

// ── Disconnect paths are idempotent on empty runtime ────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn mcp_runtime_disconnect_unknown_key_is_noop() {
    let rt = MCPRuntime::new();
    rt.disconnect("does-not-exist").await; // must not panic
    assert!(rt.get_all_client_keys().await.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn mcp_runtime_disconnect_all_on_empty_is_idempotent() {
    let rt = MCPRuntime::new();
    rt.disconnect_all().await;
    rt.disconnect_all().await; // second call must also be a noop
    assert!(rt.get_all_client_keys().await.is_empty());
    assert!(rt.get_all_tools().await.is_empty());
}

// ── Cache invalidation is safe on empty runtime ─────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn mcp_runtime_invalidate_cache_on_unknown_key_is_noop() {
    let rt = MCPRuntime::new();
    rt.invalidate_cache("phantom").await; // must not panic / deadlock
}
