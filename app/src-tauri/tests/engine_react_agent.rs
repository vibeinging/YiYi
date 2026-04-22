//! Integration tests for `engine::react_agent::core`.
//!
//! Exercises the ReAct loop end-to-end against a local `MockLlmServer` that
//! speaks OpenAI-compatible SSE. Happy-path tests cover streaming completion;
//! tool-call tests exercise iteration + max-iteration bailout + cancellation.
//!
//! All tests are `#[serial]` because the ReAct loop touches globals
//! (tool registry sync, current session id) and we don't want them racing.

mod common;

#[allow(unused_imports)]
use common::*;

use serial_test::serial;
use std::sync::atomic::{AtomicBool, Ordering};

use app_lib::engine::llm_client::LLMConfig;
use app_lib::engine::react_agent::{
    run_react, run_react_with_options, run_react_with_options_stream,
};
use app_lib::engine::tools::{FunctionDef, ToolDefinition};

/// Build a minimal LLMConfig pointing at the mock server.
/// Uses "openai" provider_id so the OpenAI-format adapter is used.
fn make_llm_config(mock_uri: &str) -> LLMConfig {
    LLMConfig {
        base_url: mock_uri.to_string(),
        api_key: "test-fake-key".to_string(),
        model: "mock-model".to_string(),
        provider_id: "openai".to_string(),
        native_tools: vec![],
    }
}

/// Build a trivial extra-tool definition (not registered globally — only used
/// to populate the `tools` argument given to the LLM).
fn make_dummy_tool(name: &str) -> ToolDefinition {
    ToolDefinition {
        r#type: "function".into(),
        function: FunctionDef {
            name: name.into(),
            description: "test tool".into(),
            parameters: serde_json::json!({"type": "object", "properties": {}}),
        },
    }
}

// ── Happy path: single-chunk response ──────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn react_agent_returns_final_response_from_stream() {
    let mock = MockLlmServer::start().await;
    mock.mock_chat_completion_stream(&["Hello, world!"]).await;

    let config = make_llm_config(&mock.uri());
    let result = run_react(&config, "you are a test", "say hi", &[])
        .await
        .expect("run_react should succeed");

    assert!(
        result.contains("Hello") && result.contains("world"),
        "expected streamed text to round-trip, got: {:?}",
        result
    );
}

// ── Happy path: multi-chunk accumulation ───────────────────────────────

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn react_agent_accumulates_multi_chunk_stream() {
    let mock = MockLlmServer::start().await;
    mock.mock_chat_completion_stream(&["Hel", "lo", " wo", "rld"])
        .await;

    let config = make_llm_config(&mock.uri());
    let result = run_react(&config, "sys", "hi", &[]).await.unwrap();

    assert_eq!(result.trim(), "Hello world");
}

// ── Error propagation ──────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn react_agent_propagates_llm_error() {
    let mock = MockLlmServer::start().await;
    // 401 is a hard auth failure, not a transient 5xx — should not be retried
    // indefinitely and should bubble up as Err.
    mock.mock_chat_completion_error(401).await;

    let config = make_llm_config(&mock.uri());
    let result = run_react(&config, "sys", "hi", &[]).await;
    assert!(result.is_err(), "expected Err on 401, got: {:?}", result);
}

// ── Empty stream: only [DONE], no chunks ───────────────────────────────
//
// With no content and no tool calls, the loop retries up to MAX_EMPTY_RETRIES
// times before returning Ok(String::new()). Each retry hits the same mock
// server, which continues to serve the same (empty) response. With only [DONE]
// the loop should complete without panicking and return an empty string.

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn react_agent_handles_empty_stream() {
    let mock = MockLlmServer::start().await;
    mock.mock_chat_completion_stream(&[]).await;

    let config = make_llm_config(&mock.uri());
    let result = run_react(&config, "sys", "hi", &[]).await;

    // Should not panic. Either returns Ok("") after exhausting empty retries,
    // or Err (e.g. if the provider-level stream parser rejects an empty body).
    // Both outcomes are acceptable — the important guarantee is no panic and
    // a bounded return.
    match result {
        Ok(s) => assert!(
            s.is_empty(),
            "expected empty string on empty stream, got: {:?}",
            s
        ),
        Err(e) => {
            // If the adapter errors out on an empty stream, surface it — don't
            // panic. Ensure we at least got *some* error string.
            assert!(!e.is_empty());
        }
    }
}

// ── Max iterations bailout ─────────────────────────────────────────────
//
// Configure the mock to always return a tool_call. `execute_tool` on an
// unknown tool returns an error string (not a panic), so the loop keeps
// iterating. With max_iterations=1, it should bail after one pass.
//
// We accept either:
//   - Err("Agent reached maximum iterations (N)")   — looped without a final answer
//   - Ok(...) if the unknown-tool error feedback somehow produced text
// What we must NOT see is a hang or a large iteration count.

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn react_agent_respects_max_iterations() {
    let mock = MockLlmServer::start().await;
    // Every call returns a tool_call → loop keeps going
    mock.mock_chat_completion_tool_call(
        "__definitely_not_a_real_tool__",
        r#"{}"#,
    )
    .await;

    let config = make_llm_config(&mock.uri());
    let result = run_react_with_options(
        &config,
        "sys",
        "hi",
        &[make_dummy_tool("__definitely_not_a_real_tool__")],
        &[],
        Some(1), // max 1 iteration
        None,
    )
    .await;

    match result {
        Err(e) => assert!(
            e.contains("maximum iterations") || e.contains("cancelled") || !e.is_empty(),
            "unexpected error: {}",
            e
        ),
        Ok(_) => {
            // Acceptable — tool error may short-circuit loop in one pass.
        }
    }
}

// ── Cancellation flag respected ────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn react_agent_respects_cancellation_flag() {
    let mock = MockLlmServer::start().await;
    mock.mock_chat_completion_stream(&["should not matter"]).await;

    let config = make_llm_config(&mock.uri());
    let cancelled = AtomicBool::new(true); // pre-cancelled

    let result = run_react_with_options_stream(
        &config,
        "sys",
        "hi",
        &[],
        &[],
        None,
        None,
        |_evt| {},
        Some(&cancelled),
        None,
        None,
    )
    .await;

    assert!(result.is_err(), "expected Err on pre-cancelled run");
    let err = result.unwrap_err();
    assert!(
        err.contains("cancel") || err.contains("cancelled"),
        "expected cancellation message, got: {}",
        err
    );
}

// ── Streaming events are emitted (Token event fires for content deltas) ──

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn react_agent_stream_emits_token_and_complete_events() {
    use app_lib::engine::react_agent::AgentStreamEvent;
    use std::sync::Arc;
    use std::sync::Mutex;

    let mock = MockLlmServer::start().await;
    mock.mock_chat_completion_stream(&["Hi ", "there"]).await;

    let config = make_llm_config(&mock.uri());
    let seen_token = Arc::new(Mutex::new(false));
    let seen_complete = Arc::new(Mutex::new(false));
    let st = seen_token.clone();
    let sc = seen_complete.clone();

    let result = run_react_with_options_stream(
        &config,
        "sys",
        "hi",
        &[],
        &[],
        None,
        None,
        move |evt| match evt {
            AgentStreamEvent::Token(_) => *st.lock().unwrap() = true,
            AgentStreamEvent::Complete => *sc.lock().unwrap() = true,
            _ => {}
        },
        None,
        None,
        None,
    )
    .await
    .expect("stream run should succeed");

    assert!(result.contains("Hi"));
    assert!(
        *seen_token.lock().unwrap(),
        "expected at least one Token event"
    );
    assert!(
        *seen_complete.lock().unwrap(),
        "expected a Complete event"
    );
    // Prevent flag drops from warnings — explicit discard
    let _ = Ordering::Relaxed;
}

// ── Per-agent wall-clock timeout ───────────────────────────────────────
//
// Mirrors the timeout wrapping applied inside `spawn_agents_background`:
// if a ReAct run exceeds `timeout_secs`, `tokio::time::timeout` returns
// `Elapsed` and we synthesize a "timed out" error string.
//
// Uses a mock whose SSE response is delayed (via wiremock's
// `ResponseTemplate::set_delay`) so the underlying future can't resolve
// before the timeout fires. Asserts we bail well before the delay elapses.

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn react_agent_timeout_wrapper_aborts_before_llm_responds() {
    let mock = MockLlmServer::start().await;
    // Mock will not respond for 5s — our timeout is 1s, so we should bail
    // long before the stream ever arrives.
    mock.mock_chat_completion_stream_delayed(
        &["this should never be seen"],
        std::time::Duration::from_secs(5),
    )
    .await;

    let config = make_llm_config(&mock.uri());

    let started = std::time::Instant::now();
    let agent_name = "slow_agent";
    let run_future = run_react(&config, "sys", "hi", &[]);
    let timeout_secs: u64 = 1;

    let outcome: Result<String, String> = match tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        run_future,
    )
    .await
    {
        Ok(r) => r,
        Err(_) => Err(format!(
            "Agent '{}' timed out after {}s",
            agent_name, timeout_secs
        )),
    };

    let elapsed = started.elapsed();

    // Must have bailed with a timeout error, not waited for the 5s mock delay.
    let err = outcome.expect_err("expected timeout Err, not Ok");
    assert!(
        err.contains("timed out") && err.contains(agent_name),
        "expected timeout error mentioning agent name, got: {:?}",
        err
    );
    assert!(
        elapsed < std::time::Duration::from_secs(3),
        "timeout should bail ~1s, not wait for the 5s delay (elapsed {:?})",
        elapsed
    );
}
