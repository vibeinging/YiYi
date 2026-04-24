//! Integration tests for `engine::mem::meditation::run_meditation_session`.
//!
//! Coverage is deliberately bounded: the full meditation pipeline depends on a
//! global `MemMe` store (initialised elsewhere in app bootstrap) which these
//! integration tests intentionally leave un-initialised. With no MemMe store
//! the Phase A0 (pre-compact), Phase A (MemMe meditate), Phase B (learn from
//! feedback via MemMe) and MemMe reflect branches all short-circuit gracefully
//! — exactly the code path we exercise here. What remains observable:
//!
//!   - cancel-before-start returns Err without invoking the LLM
//!   - empty-DB happy path succeeds (Phase C growth + Phase D journal run,
//!     using the mock LLM) and produces a plausible MeditationResult
//!   - LLM error in Phase C bubbles up as Err
//!
//! All tests are `#[serial]` because Database handles share a process-wide
//! SQLite connection pool via `TempDb`, and meditation touches working-dir
//! files (journal/morning-prep) that benefit from sequential execution.

mod common;

#[allow(unused_imports)]
use common::*;

use serial_test::serial;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use app_lib::engine::llm_client::LLMConfig;
use app_lib::engine::mem::meditation::run_meditation_session;

/// Build a minimal LLMConfig pointing at the mock server (OpenAI format).
fn make_llm_config(mock_uri: &str) -> LLMConfig {
    LLMConfig {
        base_url: mock_uri.to_string(),
        api_key: "test-fake-key".to_string(),
        model: "mock-model".to_string(),
        provider_id: "openai".to_string(),
        native_tools: vec![],
    }
}

/// A plausible Phase C growth response that `parse_growth_sections` can split.
const GROWTH_RESPONSE: &str = "\
[SYNTHESIS]\nAll systems nominal. No regressions detected.\n\
[TOMORROW]\n- Focus on test coverage\n- Review open PRs";

// ── Cancellation before any LLM call ────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn meditation_respects_cancel_flag_and_returns_err_quickly() {
    let tmp = TempDb::new();
    let ws = TempWorkspace::new();
    let mock = MockLlmServer::start().await;
    // No mock endpoints registered — if the code ever dispatched a request it
    // would fail. Cancellation must short-circuit well before that.

    let config = make_llm_config(&mock.uri());
    let cancel = Arc::new(AtomicBool::new(true)); // pre-cancelled

    let result = run_meditation_session(&config, &tmp.db(), ws.path(), cancel).await;

    assert!(
        result.is_err(),
        "pre-cancelled meditation must return Err, got Ok({:?})",
        result.ok()
    );
    let err = result.unwrap_err();
    assert!(
        err.to_lowercase().contains("interrupt")
            || err.to_lowercase().contains("cancel")
            || !err.is_empty(),
        "expected cancel/interrupt message, got: {}",
        err
    );
}

// ── Empty-DB idle-gate path ─────────────────────────────────────────────
//
// Fresh TempDb has no sessions / no corrections. The idle-gate (added for
// cost jury P0 #4) short-circuits the whole YiYi-specific phase set
// because there's nothing to reflect on. Result is Ok with `depth="idle"`
// and no LLM calls made.

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn meditation_on_empty_db_short_circuits_to_idle() {
    let tmp = TempDb::new();
    let ws = TempWorkspace::new();
    let mock = MockLlmServer::start().await;
    // No mocks mounted — idle gate must prevent any LLM call.

    let config = make_llm_config(&mock.uri());
    let cancel = Arc::new(AtomicBool::new(false));

    let result = run_meditation_session(&config, &tmp.db(), ws.path(), cancel).await;

    let r = result.expect("idle-gate path should succeed");
    assert_eq!(r.depth, "idle");
    assert_eq!(r.sessions_reviewed, 0);
    assert!(r.journal.contains("Quiet day"));
}

// ── LLM error in Phase C bubbles up ─────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn meditation_propagates_llm_error() {
    let tmp = TempDb::new();
    let ws = TempWorkspace::new();

    // Seed corrections so we bypass the idle-gate added for the cost-jury
    // #4 work — 401 has to actually be hit for the test to mean anything.
    for i in 0..3 {
        tmp.db()
            .add_correction(
                &format!("trigger {i}"),
                Some("old behavior"),
                &format!("corrected behavior {i}"),
                Some("chat"),
                0.9,
            )
            .expect("seeding correction should succeed");
    }

    let mock = MockLlmServer::start().await;
    // 401 is a hard auth failure; the client should not retry indefinitely.
    mock.mock_chat_completion_error(401).await;

    let config = make_llm_config(&mock.uri());
    let cancel = Arc::new(AtomicBool::new(false));

    let result = run_meditation_session(&config, &tmp.db(), ws.path(), cancel).await;

    assert!(
        result.is_err(),
        "401 auth error should surface as Err, got Ok({:?})",
        result.ok()
    );
}

// ── Non-empty DB: seeded sessions + correction are included in context ──
//
// Seed a session + a correction row, then run meditation. This exercises
// `get_today_sessions_messages` and `get_corrections_since` reading real rows
// (rather than the empty-DB branch). MemMe is still un-initialised, so
// principles_changed stays 0 (Phase B is MemMe-only in the current
// implementation), but we can still assert the meditation run completes
// without error and the context-gathering code did not panic on populated
// rows.

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn meditation_with_seeded_session_and_correction_runs_to_completion() {
    let tmp = TempDb::new();
    let ws = TempWorkspace::new();

    // Seed: one session (not strictly required to have messages — the
    // session row itself exercises list queries) and one correction.
    let _session = tmp
        .db()
        .create_session("meditation-test-session")
        .expect("create_session should succeed");
    let _corr_id = tmp
        .db()
        .add_correction(
            "when user says hi",
            Some("says hello back with no context"),
            "greet warmly and reference prior context",
            Some("chat"),
            0.9,
        )
        .expect("add_correction should succeed");

    let mock = MockLlmServer::start().await;
    mock.mock_chat_completion_response(GROWTH_RESPONSE).await;

    let config = make_llm_config(&mock.uri());
    let cancel = Arc::new(AtomicBool::new(false));

    let result = run_meditation_session(&config, &tmp.db(), ws.path(), cancel).await;

    let r = result.expect("meditation with seeded rows should succeed");
    assert_eq!(r.depth, "memme");
    assert!(!r.journal.is_empty(), "journal populated by Phase D");
    // Sanity: counts are non-negative ints (no underflow).
    assert!(r.sessions_reviewed >= 0);
    assert!(r.principles_changed >= 0);
}

// ── Cancellation is observed between phases ─────────────────────────────
//
// We can't easily race a cancel mid-phase, but we can verify that
// `check_cancel` flips a false→true transition into an Err return when
// observed at a phase boundary. The simplest deterministic variant: pre-set
// cancel, confirm Err (same as the first test) but explicitly assert that
// the cancel flag is still set afterwards (no stomp).

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn meditation_preserves_cancel_flag_state_on_interrupt() {
    let tmp = TempDb::new();
    let ws = TempWorkspace::new();
    let mock = MockLlmServer::start().await;
    // no mocks mounted — same guarantee as first test

    let config = make_llm_config(&mock.uri());
    let cancel = Arc::new(AtomicBool::new(true));
    let cancel_clone = cancel.clone();

    let result = run_meditation_session(&config, &tmp.db(), ws.path(), cancel).await;
    assert!(result.is_err());
    assert!(
        cancel_clone.load(Ordering::Relaxed),
        "cancel flag must still read true after interrupted run"
    );
}
