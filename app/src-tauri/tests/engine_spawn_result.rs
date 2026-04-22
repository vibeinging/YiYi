//! Unit tests for `state::app_state::SpawnAgentResult::build` — the pure
//! helper that converts a raw spawn-agent outcome into the structured result
//! persisted in chat history and returned via events.
//!
//! Full integration (driving an actual subagent end-to-end) is deferred: the
//! spawn machinery reaches into `APP_HANDLE` / `STREAMING_STATE` / the global
//! tool registry, which aren't easy to fake in a test harness without a
//! sizable refactor. Covering the builder here nails down the contract that
//! the Rust + TS consumers actually depend on: status classification, summary
//! truncation, and error-vs-output separation.

use app_lib::state::app_state::SpawnAgentResult;

#[test]
fn spawn_agent_result_captures_success_fields() {
    let output = "Explored the repo and found 3 relevant files.\n\nFiles:\n- a.rs\n- b.rs\n- c.rs";
    let r = SpawnAgentResult::build("explore", output, false, false, 1234);

    assert_eq!(r.name, "explore");
    assert!(r.success);
    assert_eq!(r.status, "complete");
    assert_eq!(r.full_output, output);
    // Summary is non-empty and caps at 500 chars.
    assert!(!r.summary.is_empty());
    assert!(r.summary.chars().count() <= 500);
    assert_eq!(r.duration_ms, 1234);
    assert!(r.error.is_none());
}

#[test]
fn spawn_agent_result_captures_full_error_uncapped() {
    // Simulate an LLM 401 with a long payload — we want the FULL text to
    // survive into both `full_output` and `error`, with no 200-char cap.
    let long_err = format!(
        "LLM call failed: HTTP 401 Unauthorized. {}",
        "detail ".repeat(120) // ~840 chars of filler
    );
    assert!(long_err.len() > 200, "test precondition: error must exceed 200 chars");

    let r = SpawnAgentResult::build("planner", &long_err, true, false, 42);

    assert_eq!(r.name, "planner");
    assert!(!r.success);
    assert_eq!(r.status, "failed");
    assert_eq!(r.full_output, long_err);
    assert_eq!(r.error.as_deref(), Some(long_err.as_str()));
    // Critical invariant: full error text is NOT truncated.
    assert!(r.error.as_deref().unwrap().len() > 200);
    assert_eq!(r.full_output.len(), long_err.len());
}

#[test]
fn spawn_agent_result_captures_timeout() {
    let msg = "Agent 'slow' timed out after 1s";
    let r = SpawnAgentResult::build("slow", msg, true, true, 1000);

    assert_eq!(r.status, "timeout");
    assert!(!r.success);
    assert!(r.error.as_deref().unwrap().contains("timed out"));
    assert_eq!(r.duration_ms, 1000);
}

#[test]
fn spawn_agent_result_classifies_cancellation() {
    let r = SpawnAgentResult::build("x", "cancelled", true, false, 7);
    assert_eq!(r.status, "cancelled");
    assert!(!r.success);
    assert_eq!(r.error.as_deref(), Some("cancelled"));
}

#[test]
fn spawn_agent_result_summary_truncates_long_output() {
    let long = "A".repeat(2000);
    let r = SpawnAgentResult::build("big", &long, false, false, 10);
    // Summary caps at 500; full_output keeps everything.
    assert_eq!(r.summary.chars().count(), 500);
    assert_eq!(r.full_output.len(), 2000);
}

#[test]
fn spawn_agent_result_serializes_with_expected_field_names() {
    // Downstream (TS + DB metadata reader) depends on these exact field names.
    let r = SpawnAgentResult::build("s", "ok", false, false, 5);
    let j = serde_json::to_value(&r).unwrap();
    assert_eq!(j["name"], "s");
    assert_eq!(j["success"], true);
    assert_eq!(j["status"], "complete");
    assert_eq!(j["full_output"], "ok");
    assert_eq!(j["duration_ms"], 5);
    assert_eq!(j["summary"], "ok");
    // `error` absent on success (serde skip_serializing_if).
    assert!(j.get("error").is_none() || j["error"].is_null());
}
