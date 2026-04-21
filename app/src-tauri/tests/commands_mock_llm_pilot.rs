//! Mock LLM pilot — proves that `MockLlmServer` can drive end-to-end tests
//! of commands that call `engine::llm_client::chat_completion[_stream]`.
//!
//! Strategy:
//! - Stand up a local `wiremock` server via `MockLlmServer::start()`.
//! - Seed the test `AppState.providers` with a provider whose `base_url`
//!   points at the mock URI (helper: `seed_mock_llm_provider`).
//! - Invoke the command's `_impl`, and assert on the command's observable
//!   return value (which reflects the mocked LLM response).
//!
//! Pilot target: `buddy_observe_impl` — chosen because it's a pure
//! non-streaming call to `chat_completion`, parses JSON from the response,
//! and returns `Option<String>` that maps directly to the mocked text.
//!
//! See `docs/testing-conventions.md` "LLM-dependent commands" for the
//! replicable pattern.

mod common;

#[allow(unused_imports)]
use common::*;

use app_lib::commands::buddy::buddy_observe_impl;
use serial_test::serial;
use std::collections::HashMap;

/// Helper: stats map used across tests. Values don't affect routing — the
/// mock returns the same response regardless of system prompt content.
fn default_stats() -> HashMap<String, i64> {
    let mut stats = HashMap::new();
    stats.insert("ENERGY".to_string(), 50);
    stats.insert("WARMTH".to_string(), 50);
    stats.insert("MISCHIEF".to_string(), 50);
    stats.insert("WIT".to_string(), 50);
    stats.insert("SASS".to_string(), 50);
    stats
}

// === Pilot — success path =============================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn buddy_observe_returns_reaction_text_when_mock_llm_says_react_true() {
    // 1. Mock LLM returns a JSON assistant message indicating reaction=true.
    let mock = MockLlmServer::start().await;
    mock.mock_chat_completion_response(
        r#"{"react": true, "text": "哇，你今天好厉害！"}"#,
    )
    .await;

    // 2. Build test state, seed the "openai" provider pointing at the mock URI.
    let t = build_test_app_state().await;
    seed_mock_llm_provider(t.state(), &mock, "mock-model").await;

    // 3. Invoke `buddy_observe_impl`.
    let result = buddy_observe_impl(
        t.state(),
        vec!["你好啊".into(), "最近怎么样".into()],
        "Yiyi".into(),
        "cat".into(),
        "gentle".into(),
        default_stats(),
    )
    .await;

    // 4. The mocked JSON had react=true, so a Some(reaction) is returned.
    let reaction = result.expect("command should succeed");
    assert_eq!(reaction.as_deref(), Some("哇，你今天好厉害！"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn buddy_observe_returns_none_when_mock_llm_says_react_false() {
    // When the LLM says react=false, the command returns Ok(None) —
    // the buddy stays silent.
    let mock = MockLlmServer::start().await;
    mock.mock_chat_completion_response(r#"{"react": false, "text": ""}"#)
        .await;

    let t = build_test_app_state().await;
    seed_mock_llm_provider(t.state(), &mock, "mock-model").await;

    let result = buddy_observe_impl(
        t.state(),
        vec!["普通对话".into()],
        "Yiyi".into(),
        "cat".into(),
        "neutral".into(),
        default_stats(),
    )
    .await;

    assert_eq!(result.unwrap(), None);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn buddy_observe_returns_none_when_llm_returns_garbage() {
    // When the LLM returns non-JSON, `extract_json_from_response` falls back
    // and the parser fails — `buddy_observe_impl` returns Ok(None) (graceful
    // silent path).
    let mock = MockLlmServer::start().await;
    mock.mock_chat_completion_response("this isn't JSON at all :(")
        .await;

    let t = build_test_app_state().await;
    seed_mock_llm_provider(t.state(), &mock, "mock-model").await;

    let result = buddy_observe_impl(
        t.state(),
        vec!["x".into()],
        "Yiyi".into(),
        "fox".into(),
        "sassy".into(),
        default_stats(),
    )
    .await;

    assert_eq!(result.unwrap(), None);
}

// === Pilot — error path ================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn buddy_observe_propagates_llm_auth_errors() {
    // 401 is classified as AuthError (non-retryable) so the retry engine
    // returns immediately — no multi-second backoff.
    let mock = MockLlmServer::start().await;
    mock.mock_chat_completion_error(401).await;

    let t = build_test_app_state().await;
    seed_mock_llm_provider(t.state(), &mock, "mock-model").await;

    let result = buddy_observe_impl(
        t.state(),
        vec!["hello".into()],
        "Yiyi".into(),
        "cat".into(),
        "gentle".into(),
        default_stats(),
    )
    .await;

    let err = result.unwrap_err();
    assert!(
        err.contains("LLM error") || err.contains("API"),
        "expected LLM error to propagate, got: {err}"
    );
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn buddy_observe_errors_when_no_llm_configured() {
    // Sanity check: without `seed_mock_llm_provider`, the command should
    // fail fast with "No LLM configured" — confirms the seed helper is
    // load-bearing.
    let t = build_test_app_state().await;

    let result = buddy_observe_impl(
        t.state(),
        vec!["hello".into()],
        "Yiyi".into(),
        "cat".into(),
        "gentle".into(),
        default_stats(),
    )
    .await;

    let err = result.unwrap_err();
    assert!(
        err.contains("No LLM configured") || err.contains("No active model"),
        "expected no-LLM error, got: {err}"
    );
}

// === Scale check — get_morning_greeting ================================
// Proves the pattern replicates to a different LLM-dependent command
// (`get_morning_greeting_impl`) with minimal additional wiring. Only the
// test body differs; infrastructure (`MockLlmServer`, `seed_mock_llm_provider`)
// is identical.

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_morning_greeting_returns_mocked_reflection_text() {
    use app_lib::commands::system::get_morning_greeting_impl;

    let mock = MockLlmServer::start().await;
    mock.mock_chat_completion_response(
        "早上好！今天要不要先处理邮件再开始工作？",
    )
    .await;

    let t = build_test_app_state().await;
    seed_mock_llm_provider(t.state(), &mock, "mock-model").await;

    let result = get_morning_greeting_impl(t.state())
        .await
        .expect("command should succeed");

    let greeting = result.expect("should return Some(greeting) from mocked LLM");
    assert!(
        greeting.contains("早上好"),
        "expected mocked greeting text, got: {greeting}"
    );
}

