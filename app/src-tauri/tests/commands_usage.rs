mod common;

#[allow(unused_imports)]
use common::*;
use app_lib::commands::usage::*;
use serial_test::serial;

// === get_usage_summary ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_usage_summary_returns_zero_on_empty_db() {
    let t = build_test_app_state().await;
    let summary = get_usage_summary_impl(t.state(), None, None).unwrap();
    assert_eq!(summary.total_input_tokens, 0);
    assert_eq!(summary.total_output_tokens, 0);
    assert_eq!(summary.total_cache_read_tokens, 0);
    assert_eq!(summary.total_cache_write_tokens, 0);
    assert_eq!(summary.call_count, 0);
    assert!((summary.total_cost_usd - 0.0).abs() < 1e-9);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_usage_summary_aggregates_recorded_rows() {
    let t = build_test_app_state().await;
    let state = t.state();
    // Record two calls across two sessions.
    state.db.record_usage("sess-a", "gpt-4o", 100, 50, 10, 5, 0.01);
    state.db.record_usage("sess-b", "gpt-4o", 200, 80, 20, 15, 0.02);

    let summary = get_usage_summary_impl(state, None, None).unwrap();
    assert_eq!(summary.total_input_tokens, 300);
    assert_eq!(summary.total_output_tokens, 130);
    assert_eq!(summary.total_cache_read_tokens, 30);
    assert_eq!(summary.total_cache_write_tokens, 20);
    assert_eq!(summary.call_count, 2);
    assert!((summary.total_cost_usd - 0.03).abs() < 1e-6);
}

// === get_usage_by_session ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_usage_by_session_returns_empty_on_no_rows() {
    let t = build_test_app_state().await;
    let rows = get_usage_by_session_impl(t.state(), None).unwrap();
    assert!(rows.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_usage_by_session_groups_and_sorts_by_cost_desc() {
    let t = build_test_app_state().await;
    let state = t.state();
    // sess-cheap: $0.01 (split over 2 calls)
    state.db.record_usage("sess-cheap", "gpt-4o", 50, 30, 0, 0, 0.005);
    state.db.record_usage("sess-cheap", "gpt-4o", 50, 30, 0, 0, 0.005);
    // sess-expensive: $0.20 in 1 call
    state.db.record_usage("sess-expensive", "gpt-4o", 500, 300, 0, 0, 0.20);

    let rows = get_usage_by_session_impl(state, Some(10)).unwrap();
    assert_eq!(rows.len(), 2);
    // Highest cost first.
    assert_eq!(rows[0].session_id, "sess-expensive");
    assert_eq!(rows[1].session_id, "sess-cheap");
    assert_eq!(rows[1].summary.call_count, 2);
}

// === get_usage_daily ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_usage_daily_returns_empty_on_no_rows() {
    let t = build_test_app_state().await;
    let rows = get_usage_daily_impl(t.state(), None).unwrap();
    assert!(rows.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_usage_daily_returns_today_entry_after_insert() {
    let t = build_test_app_state().await;
    let state = t.state();
    state.db.record_usage("sess-today", "gpt-4o", 100, 60, 0, 0, 0.05);

    // Default (30 days) should include today.
    let rows = get_usage_daily_impl(state, None).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].summary.call_count, 1);
    assert_eq!(rows[0].summary.total_input_tokens, 100);
    // `date` is a non-empty string in YYYY-MM-DD form — don't couple to the
    // current system clock beyond basic shape.
    assert!(!rows[0].date.is_empty());
}
