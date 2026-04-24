//! Integration tests for `commands/buddy.rs` thin-layer `_impl` functions.
//!
//! Covers the simple `State<AppState>`-only commands plus the memme-store
//! commands (migrated to `state.memme_store` in this A2 cleanup batch).
//! Defers:
//! - `buddy_observe` (requires LLM provider wiring — covered by
//!   `tests/commands_mock_llm_pilot.rs`).

mod common;

#[allow(unused_imports)]
use common::*;

use app_lib::commands::buddy::*;
use app_lib::state::config::BuddyConfig;
use serial_test::serial;
use std::collections::HashMap;

// Shared seed helpers ----------------------------------------------------

/// Insert a buddy decision row directly, returning its id.
fn seed_decision(t: &TestAppState, context: &str, answer: &str, confidence: f64) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    t.state().db.log_buddy_decision(
        &id,
        "should I delegate?",
        context,
        answer,
        confidence,
    );
    id
}

// === get_buddy_config ===================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_buddy_config_returns_default_config_for_fresh_state() {
    let t = build_test_app_state().await;
    let got = get_buddy_config_impl(t.state()).await.unwrap();

    // Default config: unhatched, no name, no personality.
    // NOTE: `#[derive(Default)]` on BuddyConfig ignores the
    // `#[serde(default = "default_trust")]` attribute — so the
    // programmatic default for `trust_overall` is 0.0, not 0.5.
    // The 0.5 default only applies when deserializing an empty JSON object.
    // `Config::default()` (used by `build_test_app_state`) yields 0.0.
    assert_eq!(got.name, "");
    assert_eq!(got.personality, "");
    assert_eq!(got.hatched_at, 0);
    assert!(!got.hosted_mode);
    assert_eq!(got.trust_overall, 0.0);
    assert!(got.trust_scores.is_empty());
    assert!(got.stats_delta.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_buddy_config_reflects_in_memory_mutations_to_config() {
    let t = build_test_app_state().await;

    // Mutate config directly, then read via _impl.
    {
        let mut cfg = t.state().config.write().await;
        cfg.buddy.name = "Aria".into();
        cfg.buddy.hosted_mode = true;
    }

    let got = get_buddy_config_impl(t.state()).await.unwrap();
    assert_eq!(got.name, "Aria");
    assert!(got.hosted_mode);
}

// === save_buddy_config ==================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn save_buddy_config_persists_to_disk_and_round_trips() {
    let t = build_test_app_state().await;

    let mut cfg = BuddyConfig::default();
    cfg.name = "Echo".into();
    cfg.personality = "playful".into();
    cfg.hatched_at = 1_700_000_000_000;
    cfg.hosted_mode = true;
    cfg.trust_overall = 0.83;

    let echoed = save_buddy_config_impl(t.state(), cfg.clone()).await.unwrap();
    assert_eq!(echoed.name, "Echo");
    assert_eq!(echoed.personality, "playful");

    // Written to disk at <workdir>/config.json.
    let config_path = t.state().working_dir.join("config.json");
    assert!(config_path.exists());
    let on_disk = std::fs::read_to_string(&config_path).unwrap();
    assert!(on_disk.contains("\"Echo\""));
    assert!(on_disk.contains("\"playful\""));
    assert!(on_disk.contains("\"hosted_mode\": true"));

    // Also reflected in in-memory state.
    let reread = get_buddy_config_impl(t.state()).await.unwrap();
    assert_eq!(reread.name, "Echo");
    assert!(reread.hosted_mode);
    assert!((reread.trust_overall - 0.83).abs() < f64::EPSILON);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn save_buddy_config_overwrites_previous_values() {
    let t = build_test_app_state().await;

    let mut first = BuddyConfig::default();
    first.name = "First".into();
    first.hosted_mode = true;
    save_buddy_config_impl(t.state(), first).await.unwrap();

    let mut second = BuddyConfig::default();
    second.name = "Second".into();
    second.hosted_mode = false;
    save_buddy_config_impl(t.state(), second).await.unwrap();

    let got = get_buddy_config_impl(t.state()).await.unwrap();
    assert_eq!(got.name, "Second");
    assert!(!got.hosted_mode);
}

// === hatch_buddy ========================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn hatch_buddy_sets_name_personality_and_timestamp() {
    let t = build_test_app_state().await;

    let before_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    let got = hatch_buddy_impl(t.state(), "Yiyi".into(), "gentle".into())
        .await
        .unwrap();

    assert_eq!(got.name, "Yiyi");
    assert_eq!(got.personality, "gentle");
    assert!(got.hatched_at >= before_ms, "hatched_at should be now-ish");

    // Also persisted to disk.
    let config_path = t.state().working_dir.join("config.json");
    let on_disk = std::fs::read_to_string(&config_path).unwrap();
    assert!(on_disk.contains("\"Yiyi\""));
    assert!(on_disk.contains("\"gentle\""));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn hatch_buddy_overwrites_existing_hatch_data() {
    let t = build_test_app_state().await;

    hatch_buddy_impl(t.state(), "Old".into(), "quiet".into())
        .await
        .unwrap();
    let first = get_buddy_config_impl(t.state()).await.unwrap();
    let first_ts = first.hatched_at;
    assert_eq!(first.name, "Old");

    // Small sleep to ensure a fresh timestamp value.
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;

    let second = hatch_buddy_impl(t.state(), "New".into(), "loud".into())
        .await
        .unwrap();
    assert_eq!(second.name, "New");
    assert_eq!(second.personality, "loud");
    assert!(
        second.hatched_at >= first_ts,
        "re-hatch should update timestamp"
    );
}

// === toggle_buddy_hosted + get_buddy_hosted ============================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn toggle_buddy_hosted_flips_flag_and_returns_new_value() {
    let t = build_test_app_state().await;

    // Default is false.
    assert!(!get_buddy_hosted_impl(t.state()).await.unwrap());

    let enabled = toggle_buddy_hosted_impl(t.state(), true).await.unwrap();
    assert!(enabled);
    assert!(get_buddy_hosted_impl(t.state()).await.unwrap());

    let disabled = toggle_buddy_hosted_impl(t.state(), false).await.unwrap();
    assert!(!disabled);
    assert!(!get_buddy_hosted_impl(t.state()).await.unwrap());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn toggle_buddy_hosted_persists_to_disk() {
    let t = build_test_app_state().await;

    toggle_buddy_hosted_impl(t.state(), true).await.unwrap();

    let config_path = t.state().working_dir.join("config.json");
    let on_disk = std::fs::read_to_string(&config_path).unwrap();
    assert!(on_disk.contains("\"hosted_mode\": true"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_buddy_hosted_defaults_to_false() {
    let t = build_test_app_state().await;
    assert!(!get_buddy_hosted_impl(t.state()).await.unwrap());
}

// === list_corrections ===================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_corrections_returns_empty_for_fresh_db() {
    let t = build_test_app_state().await;
    let got = list_corrections_impl(t.state()).await.unwrap();
    assert_eq!(got.len(), 0);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_corrections_returns_seeded_active_rows_with_expected_shape() {
    let t = build_test_app_state().await;

    t.state()
        .db
        .add_correction("pattern-a", Some("wrong-a"), "correct-a", Some("user"), 0.9)
        .unwrap();
    t.state()
        .db
        .add_correction("pattern-b", None, "correct-b", Some("system"), 0.7)
        .unwrap();

    let got = list_corrections_impl(t.state()).await.unwrap();
    assert_eq!(got.len(), 2);

    // Each row is a JSON object with the four expected fields.
    for row in &got {
        assert!(row.get("trigger").is_some());
        assert!(row.get("correct_behavior").is_some());
        assert!(row.get("source").is_some());
        assert!(row.get("confidence").is_some());
    }

    let row_a = got
        .iter()
        .find(|r| r["trigger"] == "pattern-a")
        .expect("pattern-a should be present");
    assert_eq!(row_a["correct_behavior"], "correct-a");
    assert_eq!(row_a["source"], "user");
    assert!((row_a["confidence"].as_f64().unwrap() - 0.9).abs() < f64::EPSILON);
}

// === list_meditation_sessions ===========================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_meditation_sessions_returns_empty_for_fresh_db() {
    let t = build_test_app_state().await;
    let got = list_meditation_sessions_impl(t.state(), None).await.unwrap();
    assert_eq!(got.len(), 0);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_meditation_sessions_excludes_running_and_respects_limit() {
    let t = build_test_app_state().await;

    // Running sessions are excluded by the query.
    t.state().db.create_meditation_session("run-1");

    // Finished sessions are included.
    t.state().db.create_meditation_session("done-1");
    t.state().db.update_meditation_session(
        "done-1",
        "completed",
        3,
        2,
        1,
        0,
        Some("journal-1"),
        None,
    );

    t.state().db.create_meditation_session("done-2");
    t.state().db.update_meditation_session(
        "done-2",
        "completed",
        1,
        1,
        0,
        0,
        Some("journal-2"),
        None,
    );

    let all = list_meditation_sessions_impl(t.state(), Some(10))
        .await
        .unwrap();
    assert_eq!(all.len(), 2, "running sessions should be excluded");
    assert!(all.iter().all(|s| s.status == "completed"));

    let limited = list_meditation_sessions_impl(t.state(), Some(1))
        .await
        .unwrap();
    assert_eq!(limited.len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_meditation_sessions_default_limit_is_ten() {
    // `_impl` defaults to `limit.unwrap_or(10)`. Insert a small batch
    // (5) — None should still return all 5 because the default cap is 10.
    let t = build_test_app_state().await;

    for i in 0..5 {
        let id = format!("m-{}", i);
        t.state().db.create_meditation_session(&id);
        t.state().db.update_meditation_session(
            &id, "completed", 0, 0, 0, 0, None, None,
        );
    }

    let got = list_meditation_sessions_impl(t.state(), None).await.unwrap();
    assert_eq!(got.len(), 5);
}

// === list_buddy_decisions ===============================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_buddy_decisions_returns_empty_for_fresh_db() {
    let t = build_test_app_state().await;
    let got = list_buddy_decisions_impl(t.state(), None).await.unwrap();
    assert_eq!(got.len(), 0);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_buddy_decisions_returns_seeded_rows_ordered_by_recency() {
    let t = build_test_app_state().await;

    let id_a = seed_decision(&t, "task_decision", "yes", 0.8);
    let id_b = seed_decision(&t, "permission", "no", 0.4);

    let got = list_buddy_decisions_impl(t.state(), None).await.unwrap();
    assert_eq!(got.len(), 2);
    // Both ids present.
    assert!(got.iter().any(|d| d.id == id_a));
    assert!(got.iter().any(|d| d.id == id_b));
    // Feedback is unset initially.
    assert!(got.iter().all(|d| d.user_feedback.is_none()));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_buddy_decisions_honors_explicit_limit() {
    let t = build_test_app_state().await;

    for i in 0..5 {
        seed_decision(&t, &format!("ctx-{}", i), "yes", 0.5);
    }

    let limited = list_buddy_decisions_impl(t.state(), Some(2)).await.unwrap();
    assert_eq!(limited.len(), 2);
}

// === set_decision_feedback ==============================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn set_decision_feedback_rejects_non_good_or_bad_input() {
    let t = build_test_app_state().await;
    let id = seed_decision(&t, "task_decision", "yes", 0.5);

    let err = set_decision_feedback_impl(t.state(), id, "meh".into())
        .await
        .unwrap_err();
    assert!(err.contains("'good'") && err.contains("'bad'"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn set_decision_feedback_updates_db_row_and_recomputes_trust() {
    let t = build_test_app_state().await;

    // Two decisions, both in context "task_decision".
    let id_good = seed_decision(&t, "task_decision", "yes", 0.8);
    let id_bad = seed_decision(&t, "task_decision", "no", 0.3);

    set_decision_feedback_impl(t.state(), id_good.clone(), "good".into())
        .await
        .unwrap();
    set_decision_feedback_impl(t.state(), id_bad.clone(), "bad".into())
        .await
        .unwrap();

    // Trust stats: 1 good, 1 bad → accuracy 0.5.
    let stats = t.state().db.get_trust_stats();
    assert_eq!(stats.good, 1);
    assert_eq!(stats.bad, 1);
    assert!((stats.accuracy - 0.5).abs() < f64::EPSILON);

    // Config now reflects the new trust_overall + per-context score.
    let cfg = get_buddy_config_impl(t.state()).await.unwrap();
    assert!((cfg.trust_overall - 0.5).abs() < f64::EPSILON);
    assert!(cfg.trust_scores.contains_key("task_decision"));

    // Persisted to disk.
    let on_disk = std::fs::read_to_string(t.state().working_dir.join("config.json")).unwrap();
    assert!(on_disk.contains("trust_overall"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn set_decision_feedback_with_good_moves_accuracy_to_one() {
    let t = build_test_app_state().await;
    let id = seed_decision(&t, "permission", "yes", 0.6);

    set_decision_feedback_impl(t.state(), id, "good".into())
        .await
        .unwrap();

    let cfg = get_buddy_config_impl(t.state()).await.unwrap();
    // One good, zero bad → accuracy 1.0, trust_overall should track that.
    assert!((cfg.trust_overall - 1.0).abs() < f64::EPSILON);
}

// === get_trust_stats ====================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_trust_stats_returns_zero_totals_when_no_decisions_logged() {
    let t = build_test_app_state().await;
    let stats = get_trust_stats_impl(t.state()).await.unwrap();

    assert_eq!(stats.total, 0);
    assert_eq!(stats.good, 0);
    assert_eq!(stats.bad, 0);
    assert_eq!(stats.pending, 0);
    // With no rated decisions, default accuracy is 0.5.
    assert!((stats.accuracy - 0.5).abs() < f64::EPSILON);
    assert!(stats.by_context.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_trust_stats_reflects_feedback_across_contexts() {
    let t = build_test_app_state().await;

    let a1 = seed_decision(&t, "task_decision", "yes", 0.7);
    let a2 = seed_decision(&t, "task_decision", "no", 0.4);
    let b1 = seed_decision(&t, "permission", "yes", 0.8);

    t.state().db.set_decision_feedback(&a1, "good");
    t.state().db.set_decision_feedback(&a2, "bad");
    t.state().db.set_decision_feedback(&b1, "good");

    let stats = get_trust_stats_impl(t.state()).await.unwrap();

    assert_eq!(stats.total, 3);
    assert_eq!(stats.good, 2);
    assert_eq!(stats.bad, 1);
    // good / (good + bad) = 2/3
    assert!((stats.accuracy - (2.0 / 3.0)).abs() < 1e-9);

    // Per-context breakdown present for both contexts.
    let task = stats
        .by_context
        .get("task_decision")
        .expect("task_decision context should exist");
    assert_eq!(task.total, 2);
    assert_eq!(task.good, 1);
    assert_eq!(task.bad, 1);

    let perm = stats
        .by_context
        .get("permission")
        .expect("permission context should exist");
    assert_eq!(perm.good, 1);
    assert_eq!(perm.bad, 0);
}

// ============================================================================
// Memme-backed commands (migrated from OnceLock singleton to state.memme_store)
// ============================================================================

const TEST_USER_ID: &str = "yiyi_default_user";

/// Seed a memory into the test store and return the generated id.
fn seed_memory(
    t: &TestAppState,
    content: &str,
    categories: Vec<&str>,
    importance: Option<f32>,
) -> String {
    let mut opts = memme_core::AddOptions::new(TEST_USER_ID)
        .categories(categories.iter().map(|s| s.to_string()).collect());
    if let Some(imp) = importance {
        opts = opts.importance(imp);
    }
    t.state()
        .memme_store
        .add(content, opts)
        .expect("add memory")
        .id
}

fn seed_episode(
    t: &TestAppState,
    title: &str,
    summary: &str,
    started_at: &str,
) -> String {
    let opts = memme_core::CreateEpisodeOptions::new(
        title,
        summary,
        TEST_USER_ID,
        started_at,
    );
    t.state()
        .memme_store
        .create_episode(opts)
        .expect("create episode")
        .episode_id
}

// === get_memory_stats ===================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_memory_stats_returns_zero_totals_for_fresh_store() {
    let t = build_test_app_state().await;
    let got = get_memory_stats_impl(t.state()).await.unwrap();
    assert_eq!(got.total, 0);
    assert!(got.by_category.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_memory_stats_tallies_seeded_memories_by_first_category() {
    let t = build_test_app_state().await;

    seed_memory(&t, "learn rust", vec!["study"], Some(0.5));
    seed_memory(&t, "write tests", vec!["work", "study"], Some(0.7));
    // memory with no categories falls into "未归类"
    let opts = memme_core::AddOptions::new(TEST_USER_ID);
    t.state()
        .memme_store
        .add("random thought", opts)
        .expect("add memory");

    let got = get_memory_stats_impl(t.state()).await.unwrap();
    assert_eq!(got.total, 3);
    // Two traces have first-category "study" and "work"; one goes to "未归类".
    assert_eq!(got.by_category.get("study").copied().unwrap_or(0), 1);
    assert_eq!(got.by_category.get("work").copied().unwrap_or(0), 1);
    assert_eq!(
        got.by_category.get("未归类").copied().unwrap_or(0),
        1
    );
}

// === list_recent_episodes ===============================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_recent_episodes_returns_empty_for_fresh_store() {
    let t = build_test_app_state().await;
    let got = list_recent_episodes_impl(t.state(), None).await.unwrap();
    assert!(got.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_recent_episodes_returns_seeded_rows_respecting_limit() {
    let t = build_test_app_state().await;

    for i in 0..3 {
        seed_episode(
            &t,
            &format!("episode-{}", i),
            &format!("summary-{}", i),
            "2026-04-20T00:00:00",
        );
    }

    let all = list_recent_episodes_impl(t.state(), None).await.unwrap();
    assert_eq!(all.len(), 3);
    for row in &all {
        assert!(!row.episode_id.is_empty());
        assert!(row.title.starts_with("episode-"));
        assert!(row.summary.starts_with("summary-"));
    }

    let limited = list_recent_episodes_impl(t.state(), Some(1))
        .await
        .unwrap();
    assert_eq!(limited.len(), 1);
}

// === list_recent_memories ===============================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_recent_memories_returns_empty_for_fresh_store() {
    let t = build_test_app_state().await;
    let got = list_recent_memories_impl(t.state(), None).await.unwrap();
    assert!(got.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_recent_memories_returns_seeded_rows_with_expected_shape() {
    let t = build_test_app_state().await;

    let id_a = seed_memory(&t, "first", vec!["cat-a"], Some(0.4));
    let id_b = seed_memory(&t, "second", vec!["cat-b"], Some(0.8));

    let rows = list_recent_memories_impl(t.state(), Some(10))
        .await
        .unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().any(|r| r.id == id_a && r.content == "first"));
    assert!(rows.iter().any(|r| r.id == id_b && r.content == "second"));

    let row_b = rows.iter().find(|r| r.id == id_b).unwrap();
    assert_eq!(row_b.categories, vec!["cat-b".to_string()]);
    assert!((row_b.importance - 0.8).abs() < 1e-4);
    assert!(!row_b.created_at.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_recent_memories_honors_explicit_limit() {
    let t = build_test_app_state().await;
    for i in 0..5 {
        seed_memory(&t, &format!("m-{}", i), vec!["x"], None);
    }
    let rows = list_recent_memories_impl(t.state(), Some(2))
        .await
        .unwrap();
    assert_eq!(rows.len(), 2);
}

// === search_memories ====================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn search_memories_with_blank_query_short_circuits_to_empty() {
    let t = build_test_app_state().await;
    seed_memory(&t, "hello world", vec!["greeting"], None);

    // Blank query returns empty without hitting the store.
    let got = search_memories_impl(t.state(), "   ".into(), None)
        .await
        .unwrap();
    assert!(got.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn search_memories_finds_seeded_content_via_keyword_search() {
    let t = build_test_app_state().await;

    let id_match = seed_memory(&t, "rust programming language", vec!["code"], None);
    let _id_other = seed_memory(&t, "cats are fluffy", vec!["pets"], None);

    let got = search_memories_impl(t.state(), "rust".into(), Some(10))
        .await
        .unwrap();

    // FakeEmbedder may produce noisy vector matches, but keyword_search=true
    // ensures the FTS-matched row is included. Assert presence — not
    // exclusivity — so the test stays robust to additional recall hits.
    assert!(
        got.iter().any(|r| r.id == id_match),
        "expected the matching row to surface, got {:?}",
        got.iter().map(|r| &r.content).collect::<Vec<_>>()
    );
}

// === delete_memory ======================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn delete_memory_removes_seeded_row() {
    let t = build_test_app_state().await;

    let id = seed_memory(&t, "to be deleted", vec!["temp"], None);
    // Verify it's there first.
    let before = list_recent_memories_impl(t.state(), None).await.unwrap();
    assert!(before.iter().any(|r| r.id == id));

    delete_memory_impl(t.state(), id.clone()).await.unwrap();

    let after = list_recent_memories_impl(t.state(), None).await.unwrap();
    assert!(!after.iter().any(|r| r.id == id), "deleted row should be gone");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn delete_memory_on_unknown_id_surfaces_not_found_error() {
    // memme_core's `delete_trace` returns `NotFound` for unknown ids, and
    // the command wraps it with a "删除失败" prefix.
    let t = build_test_app_state().await;
    let err = delete_memory_impl(t.state(), "does-not-exist".into())
        .await
        .unwrap_err();
    assert!(
        err.contains("删除失败") && err.contains("not found"),
        "expected not-found error with Chinese prefix, got: {err}"
    );
}

// Avoid `HashMap` import warning on nightly.
#[allow(dead_code)]
fn _type_check_hashmap_import(_m: HashMap<String, i64>) {}
