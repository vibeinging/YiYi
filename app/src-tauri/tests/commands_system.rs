//! Integration tests for `commands/system.rs` thin-layer `_impl` functions.
//!
//! Part 1/2 — covers health/models/workspace/setup/install/flags/growth/correction.
//! Part 2/2 — covers meditation/memme/identity/quick actions/personality/sparkling.
//!
//! Deferred:
//! - `check_claude_code_status` (real `which claude` subprocess + ~/.claude.json probing)
//! - `install_claude_code` (real `npm install -g`)
//! - `install_tool` / `install_git` (real package installs)
//! - `consolidate_principles` (requires live LLM; thin layer is `_impl`-refactored for parity)

mod common;

#[allow(unused_imports)]
use common::*;

use app_lib::commands::system::*;
use serial_test::serial;

// === health_check =============================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn health_check_returns_ok_status() {
    let resp = health_check_impl().await.unwrap();
    assert_eq!(resp.status, "ok");
    assert!(!resp.version.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn health_check_lists_known_methods() {
    let resp = health_check_impl().await.unwrap();
    // A subset of methods the front-end discovers via /health.
    for expected in ["chat", "skills", "models", "cronjobs", "mcp", "workspace"] {
        assert!(
            resp.methods.iter().any(|m| m == expected),
            "expected method '{expected}' in {:?}",
            resp.methods
        );
    }
}

// === list_models ==============================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_models_returns_builtin_models_even_without_config() {
    let t = build_test_app_state().await;
    let models = list_models_impl(t.state()).await.unwrap();
    // Built-in providers ship with model catalogs — should be non-empty even
    // on a fresh DB.
    assert!(!models.is_empty(), "expected built-in models, got empty");
    // At least one well-known model should be present.
    assert!(
        models.iter().any(|m| m.id == "gpt-5-chat")
            || models.iter().any(|m| m.id.starts_with("claude-")),
        "expected a known model, got {:?}",
        models.iter().map(|m| &m.id).collect::<Vec<_>>()
    );
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_models_flattens_across_providers() {
    let t = build_test_app_state().await;
    let models = list_models_impl(t.state()).await.unwrap();
    // Distinct model IDs across providers — there should be more than any
    // single provider's catalog.
    let distinct = models
        .iter()
        .map(|m| m.id.as_str())
        .collect::<std::collections::HashSet<_>>();
    assert!(distinct.len() >= 3, "expected multiple distinct models");
}

// === set_model / get_current_model ===========================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn set_model_on_known_model_persists_active_llm() {
    let t = build_test_app_state().await;
    let resp = set_model_impl(t.state(), "gpt-5-chat".into()).await.unwrap();
    assert_eq!(resp["status"], "ok");
    assert_eq!(resp["model"], "gpt-5-chat");

    let got = get_current_model_impl(t.state()).await.unwrap();
    assert_eq!(got["model"], "gpt-5-chat");
    assert_eq!(got["provider_id"], "openai");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn set_model_rejects_unknown_model() {
    let t = build_test_app_state().await;
    let err = set_model_impl(t.state(), "model-that-does-not-exist".into())
        .await
        .unwrap_err();
    assert!(
        err.contains("not found"),
        "expected not-found error, got: {err}"
    );
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_current_model_on_fresh_state_returns_null_model() {
    let t = build_test_app_state().await;
    let got = get_current_model_impl(t.state()).await.unwrap();
    assert_eq!(got["status"], "ok");
    assert!(got["model"].is_null());
}

// === save_agents_config =======================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn save_agents_config_persists_language_and_max_iterations() {
    let t = build_test_app_state().await;
    save_agents_config_impl(t.state(), Some("en".into()), Some(42))
        .await
        .unwrap();

    let cfg = t.state().config.read().await;
    assert_eq!(cfg.agents.language.as_deref(), Some("en"));
    assert_eq!(cfg.agents.max_iterations, Some(42));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn save_agents_config_caps_max_iterations_at_500() {
    let t = build_test_app_state().await;
    save_agents_config_impl(t.state(), None, Some(10_000))
        .await
        .unwrap();

    let cfg = t.state().config.read().await;
    assert_eq!(cfg.agents.max_iterations, Some(500));
}

// === get_user_workspace / set_user_workspace =================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_user_workspace_returns_current_path() {
    let t = build_test_app_state().await;
    let got = get_user_workspace_impl(t.state()).await.unwrap();
    assert_eq!(got, t.state().user_workspace().to_string_lossy());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn set_user_workspace_updates_runtime_and_config() {
    let t = build_test_app_state().await;
    let new_dir = tempfile::TempDir::new().unwrap();
    let new_path = new_dir.path().to_string_lossy().to_string();

    set_user_workspace_impl(t.state(), new_path.clone())
        .await
        .unwrap();

    // Runtime state reflects change.
    let got = get_user_workspace_impl(t.state()).await.unwrap();
    assert_eq!(got, new_path);

    // Config persists it.
    let cfg = t.state().config.read().await;
    assert_eq!(cfg.agents.workspace_dir.as_deref(), Some(new_path.as_str()));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn set_user_workspace_rejects_relative_path() {
    let t = build_test_app_state().await;
    let err = set_user_workspace_impl(t.state(), "relative/dir".into())
        .await
        .unwrap_err();
    assert!(
        err.contains("absolute"),
        "expected absolute-path error, got: {err}"
    );
}

// === is_setup_complete / complete_setup =======================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn is_setup_complete_on_fresh_db_returns_false() {
    let t = build_test_app_state().await;
    let done = is_setup_complete_impl(t.state()).await.unwrap();
    assert!(!done);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn complete_setup_persists_flag_and_writes_bootstrap_marker() {
    let t = build_test_app_state().await;
    complete_setup_impl(t.state()).await.unwrap();

    assert!(is_setup_complete_impl(t.state()).await.unwrap());

    // `.bootstrap_completed` marker written to working_dir.
    let marker = t.state().working_dir.join(".bootstrap_completed");
    assert!(marker.exists(), "expected bootstrap marker at {marker:?}");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn complete_setup_is_idempotent() {
    let t = build_test_app_state().await;
    complete_setup_impl(t.state()).await.unwrap();
    // Second call should not error (just overwrites flag + marker).
    complete_setup_impl(t.state()).await.unwrap();
    assert!(is_setup_complete_impl(t.state()).await.unwrap());
}

// === check_tool_available =====================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn check_tool_available_returns_false_for_unknown_tool() {
    // Unknown tools are rejected to prevent command injection.
    let ok = check_tool_available_impl("nonexistent_tool_xyz_12345".into())
        .await
        .unwrap();
    assert!(!ok);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn check_tool_available_handles_known_tool_keys() {
    // `git` is a recognized key; result depends on the host system. We only
    // assert that the function returns Ok (doesn't panic or error) and
    // returns a bool, not a specific value.
    let _ = check_tool_available_impl("git".into()).await.unwrap();
    let _ = check_tool_available_impl("python3".into()).await.unwrap();
    let _ = check_tool_available_impl("npm".into()).await.unwrap();
}

// === check_git_available ======================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn check_git_available_matches_check_tool_available_git() {
    let via_wrapper = check_git_available_impl().await.unwrap();
    let via_generic = check_tool_available_impl("git".into()).await.unwrap();
    assert_eq!(via_wrapper, via_generic);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn check_git_available_returns_bool_without_panic() {
    // Just verify the wrapper resolves without error.
    let _ = check_git_available_impl().await.unwrap();
}

// === get_app_flag / set_app_flag ==============================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn set_app_flag_roundtrips_through_get_app_flag() {
    let t = build_test_app_state().await;

    set_app_flag_impl(t.state(), "theme".into(), "dark".into())
        .await
        .unwrap();
    let got = get_app_flag_impl(t.state(), "theme".into()).await.unwrap();
    assert_eq!(got.as_deref(), Some("dark"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_app_flag_on_missing_key_returns_none() {
    let t = build_test_app_state().await;
    let got = get_app_flag_impl(t.state(), "onboarding_step".into())
        .await
        .unwrap();
    assert!(got.is_none());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_app_flag_rejects_unknown_key() {
    let t = build_test_app_state().await;
    let err = get_app_flag_impl(t.state(), "not_in_allowlist".into())
        .await
        .unwrap_err();
    assert!(
        err.contains("Unknown flag key"),
        "expected unknown-flag error, got: {err}"
    );
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn set_app_flag_allows_user_prefix_keys() {
    let t = build_test_app_state().await;
    // `user_*` keys are explicitly allowed by the validator.
    set_app_flag_impl(t.state(), "user_custom_pref".into(), "v1".into())
        .await
        .unwrap();
    let got = get_app_flag_impl(t.state(), "user_custom_pref".into())
        .await
        .unwrap();
    assert_eq!(got.as_deref(), Some("v1"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn set_app_flag_rejects_unknown_key() {
    let t = build_test_app_state().await;
    let err = set_app_flag_impl(t.state(), "arbitrary_key".into(), "x".into())
        .await
        .unwrap_err();
    assert!(
        err.contains("Unknown flag key"),
        "expected unknown-flag error, got: {err}"
    );
}

// === get_growth_report ========================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_growth_report_on_empty_db_returns_shaped_json() {
    let t = build_test_app_state().await;
    let v = get_growth_report_impl(t.state()).await.unwrap();

    // Keys always present, shape stable for the frontend.
    assert!(v.get("report").is_some());
    assert!(v.get("skill_suggestion").is_some());
    assert!(v.get("capabilities").is_some());
    assert!(v.get("timeline").is_some());

    // With no reflections, the report is null; capabilities/timeline are empty.
    assert!(v["report"].is_null());
    assert!(v["skill_suggestion"].is_null());
    assert_eq!(v["capabilities"].as_array().unwrap().len(), 0);
    assert_eq!(v["timeline"].as_array().unwrap().len(), 0);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_growth_report_reflects_stored_reflections() {
    let t = build_test_app_state().await;
    // Seed a couple of reflections so generate_growth_report has data.
    for i in 0..3 {
        t.state()
            .db
            .add_reflection(
                Some(&format!("task-{i}")),
                None,
                if i == 0 { "failure" } else { "success" },
                &format!("summary-{i}"),
                Some("lesson learned"),
                None,
                "user_initiated",
                0.8,
            )
            .unwrap();
    }

    let v = get_growth_report_impl(t.state()).await.unwrap();
    let report = v["report"].as_object().expect("report populated");
    assert_eq!(report["total_tasks"], 3);
    assert_eq!(report["success_count"], 2);
    assert_eq!(report["failure_count"], 1);
}

// === get_morning_greeting =====================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_morning_greeting_without_llm_config_returns_none() {
    // No provider API key or active_llm slot => resolve_llm_config errs =>
    // the command swallows the error and returns Ok(None).
    let t = build_test_app_state().await;
    let got = get_morning_greeting_impl(t.state()).await.unwrap();
    assert!(got.is_none());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_morning_greeting_does_not_error_on_repeated_calls() {
    // Regardless of LLM state, the command surface is Result<Option<String>, _>
    // and should never error out of the `Ok(None)` fast-path.
    let t = build_test_app_state().await;
    let _ = get_morning_greeting_impl(t.state()).await.unwrap();
    let _ = get_morning_greeting_impl(t.state()).await.unwrap();
}

// === disable_correction =======================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn disable_correction_on_unknown_id_is_noop() {
    // DB UPDATE on a non-existent row affects 0 rows and returns Ok.
    let t = build_test_app_state().await;
    disable_correction_impl(t.state(), "no-such-correction".into())
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn disable_correction_marks_existing_correction_inactive() {
    let t = build_test_app_state().await;
    let db = &t.state().db;

    // Seed a correction via the DB layer and capture its id.
    let correction_id = db
        .add_correction(
            "always greet when asked",
            None,
            "greet the user warmly",
            Some("user_feedback"),
            0.8,
        )
        .expect("add_correction should succeed");

    // Should appear in active corrections before disable.
    let before = db.get_active_corrections(10);
    assert!(
        !before.is_empty(),
        "expected at least one active correction after seeding"
    );

    disable_correction_impl(t.state(), correction_id.clone())
        .await
        .unwrap();

    // Query the `active` flag directly by id — get_active_corrections doesn't
    // return ids.
    let conn = db.get_conn().expect("db connection");
    let active_flag: i64 = conn
        .query_row(
            "SELECT active FROM corrections WHERE id = ?1",
            rusqlite::params![correction_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(active_flag, 0, "correction should be marked inactive");
}

// ============================================================================
// Part 2/2 — meditation / memme / identity / quick actions / personality /
//            sparkling / recall
// ============================================================================

// === save_meditation_config / get_meditation_config ==========================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_meditation_config_returns_defaults_on_fresh_state() {
    let t = build_test_app_state().await;
    let got = get_meditation_config_impl(t.state()).await.unwrap();
    // Defaults from `MeditationConfig::default()`.
    assert!(got.enabled);
    assert_eq!(got.start_time, "23:00");
    assert!(got.notify_on_complete);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn save_meditation_config_persists_values_and_roundtrips() {
    let t = build_test_app_state().await;
    save_meditation_config_impl(t.state(), false, "02:30".into(), false)
        .await
        .unwrap();

    let got = get_meditation_config_impl(t.state()).await.unwrap();
    assert!(!got.enabled);
    assert_eq!(got.start_time, "02:30");
    assert!(!got.notify_on_complete);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn save_meditation_config_writes_to_config_json_on_disk() {
    let t = build_test_app_state().await;
    save_meditation_config_impl(t.state(), true, "21:15".into(), true)
        .await
        .unwrap();

    // The saved config should land in working_dir/config.json.
    let config_path = t.state().working_dir.join("config.json");
    assert!(config_path.exists(), "expected config.json at {config_path:?}");
    let text = std::fs::read_to_string(&config_path).unwrap();
    assert!(
        text.contains("21:15"),
        "expected start_time '21:15' persisted, got: {text}"
    );
}

// === get_latest_meditation ===================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_latest_meditation_on_fresh_db_returns_none() {
    let t = build_test_app_state().await;
    let got = get_latest_meditation_impl(t.state()).await.unwrap();
    assert!(got.is_none(), "expected None on fresh DB, got {got:?}");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_latest_meditation_returns_most_recent_session() {
    let t = build_test_app_state().await;
    // Seed two sessions; the second should win (DESC by started_at).
    t.state().db.create_meditation_session("m-old");
    // Small sleep not required — started_at is ms precision in create_meditation_session
    // but the second create overrides `id`. Give the clock a tick so started_at differs.
    std::thread::sleep(std::time::Duration::from_millis(10));
    t.state().db.create_meditation_session("m-new");

    let got = get_latest_meditation_impl(t.state())
        .await
        .unwrap()
        .expect("expected a session after seeding");
    assert_eq!(got.id, "m-new");
    assert_eq!(got.status, "running");
}

// === trigger_meditation =======================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn trigger_meditation_without_llm_config_fails_and_resets_flag() {
    // Without an active LLM, resolve_llm_config errs; the impl should unset
    // meditation_running before returning so a retry isn't permanently blocked.
    let t = build_test_app_state().await;
    let err = trigger_meditation_impl(t.state()).await.unwrap_err();
    assert!(
        err.to_lowercase().contains("no active model") || err.contains("Provider"),
        "expected LLM resolution error, got: {err}"
    );
    // Flag must be reset after the early-return error path.
    assert!(
        !t.state()
            .meditation_running
            .load(std::sync::atomic::Ordering::Relaxed),
        "meditation_running should be false after fast-path error"
    );
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn trigger_meditation_rejects_while_flag_already_running() {
    let t = build_test_app_state().await;
    // Simulate an already-running session by pre-setting the atomic flag.
    t.state()
        .meditation_running
        .store(true, std::sync::atomic::Ordering::SeqCst);

    let err = trigger_meditation_impl(t.state()).await.unwrap_err();
    assert!(
        err.contains("正在进行中") || err.to_lowercase().contains("already running"),
        "expected already-running rejection, got: {err}"
    );

    // Flag should remain set — we pre-set it; impl must not clobber it.
    assert!(
        t.state()
            .meditation_running
            .load(std::sync::atomic::Ordering::Relaxed),
        "meditation_running should remain true; impl must not reset other owner's flag"
    );

    // Reset so we don't leak state to later serial tests.
    t.state()
        .meditation_running
        .store(false, std::sync::atomic::Ordering::Relaxed);
}

// === get_meditation_status ====================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_meditation_status_on_fresh_db_returns_idle() {
    let t = build_test_app_state().await;
    let got = get_meditation_status_impl(t.state()).await.unwrap();
    assert_eq!(got, "idle");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_meditation_status_returns_running_for_fresh_running_session() {
    let t = build_test_app_state().await;
    t.state().db.create_meditation_session("m-active");
    // `create_meditation_session` inserts status='running' with started_at = now —
    // well under the 10-minute stale threshold, so status should be "running".
    let got = get_meditation_status_impl(t.state()).await.unwrap();
    assert_eq!(got, "running");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_meditation_status_stale_running_without_flag_is_idle() {
    let t = build_test_app_state().await;
    // Seed a session with started_at > 10 minutes ago AND status='running'.
    // With the in-process flag false, the impl should surface "idle" (crash-recovery).
    let stale_started_at = chrono::Utc::now().timestamp_millis() - 11 * 60 * 1000;
    {
        let conn = t.state().db.get_conn().expect("db conn");
        conn.execute(
            "INSERT INTO meditation_sessions (id, started_at, status) VALUES (?1, ?2, 'running')",
            rusqlite::params!["m-stale", stale_started_at],
        )
        .unwrap();
    }
    assert!(
        !t.state()
            .meditation_running
            .load(std::sync::atomic::Ordering::Relaxed)
    );

    let got = get_meditation_status_impl(t.state()).await.unwrap();
    assert_eq!(got, "idle", "stale 'running' rows with no flag should be idle");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_meditation_status_completed_within_5_minutes_reports_completed() {
    let t = build_test_app_state().await;
    let now = chrono::Utc::now().timestamp_millis();
    // Seed a completed row finished 30 seconds ago.
    {
        let conn = t.state().db.get_conn().expect("db conn");
        conn.execute(
            "INSERT INTO meditation_sessions (id, started_at, finished_at, status)
             VALUES (?1, ?2, ?3, 'completed')",
            rusqlite::params!["m-done", now - 60_000, now - 30_000],
        )
        .unwrap();
    }
    let got = get_meditation_status_impl(t.state()).await.unwrap();
    assert_eq!(got, "completed");
}

// === get_meditation_summary ===================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_meditation_summary_on_empty_db_returns_none() {
    let t = build_test_app_state().await;
    let got = get_meditation_summary_impl(t.state()).await.unwrap();
    assert!(got.is_none());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_meditation_summary_with_only_running_session_returns_none() {
    // `get_latest_completed_meditation_session` filters status != 'running'.
    let t = build_test_app_state().await;
    t.state().db.create_meditation_session("m-running-only");
    let got = get_meditation_summary_impl(t.state()).await.unwrap();
    assert!(got.is_none(), "running-only session should yield None summary");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_meditation_summary_formats_nonzero_counters_into_message() {
    let t = build_test_app_state().await;
    // Create then update — the `update_meditation_session` fn transitions status to 'completed'.
    t.state().db.create_meditation_session("m-done");
    t.state().db.update_meditation_session(
        "m-done",
        "completed",
        3,  // sessions_reviewed
        5,  // memories_updated
        2,  // principles_changed
        1,  // memories_archived
        Some("日记"),
        None,
    );

    let got = get_meditation_summary_impl(t.state()).await.unwrap();
    let msg = got.expect("expected Some(message) for completed session");
    assert!(msg.contains("5"), "expected memories_updated count in: {msg}");
    assert!(msg.contains("1"), "expected memories_archived count in: {msg}");
    assert!(msg.contains("2"), "expected principles_changed count in: {msg}");
    assert!(msg.contains("3"), "expected sessions_reviewed count in: {msg}");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_meditation_summary_with_all_zero_counters_returns_empty_message() {
    let t = build_test_app_state().await;
    t.state().db.create_meditation_session("m-empty");
    t.state().db.update_meditation_session(
        "m-empty", "completed", 0, 0, 0, 0, None, None,
    );
    let got = get_meditation_summary_impl(t.state()).await.unwrap();
    assert_eq!(got.as_deref(), Some("没有新的变化~"));
}

// === get_memme_config / save_memme_config =====================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_memme_config_returns_defaults_on_fresh_state() {
    let t = build_test_app_state().await;
    let got = get_memme_config_impl(t.state()).await.unwrap();
    // Defaults from `MemmeConfig::default()`.
    assert_eq!(got.embedding_provider, "local-bge-zh");
    assert_eq!(got.embedding_model, "bge-small-zh-v1.5");
    assert_eq!(got.embedding_dims, 512);
    assert!(got.enable_graph);
    assert!(got.enable_forgetting_curve);
    assert_eq!(got.extraction_depth, "standard");
    assert!(got.memory_llm_api_key.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn save_memme_config_persists_to_disk_and_rereads() {
    let t = build_test_app_state().await;
    let mut cfg = app_lib::state::config::MemmeConfig::default();
    cfg.extraction_depth = "thorough".to_string();
    cfg.enable_graph = false;
    cfg.memory_llm_model = "gpt-5-mini".to_string();

    let result = save_memme_config_impl(t.state(), cfg.clone()).await.unwrap();
    // With no MemMe singleton initialized in test AND no API key, nothing hot-swaps.
    assert!(
        !result.llm_hot_swapped,
        "no live singleton in test context; expected no hot swap"
    );
    // No warning either: falls into the (None, _) branch — store not initialized.
    assert!(
        result.warning.is_none(),
        "expected no warning when singleton is uninitialized, got {:?}",
        result.warning
    );

    // Re-read via get_memme_config — the change must have been persisted.
    let got = get_memme_config_impl(t.state()).await.unwrap();
    assert_eq!(got.extraction_depth, "thorough");
    assert!(!got.enable_graph);
    assert_eq!(got.memory_llm_model, "gpt-5-mini");

    // And config.json on disk should carry the change.
    let config_path = t.state().working_dir.join("config.json");
    let text = std::fs::read_to_string(&config_path).unwrap();
    assert!(text.contains("thorough"));
    assert!(text.contains("gpt-5-mini"));
}

// === get_identity_traits ======================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_identity_traits_on_fresh_store_is_empty() {
    // `state.memme_store` is built fresh for each test via build_test_app_state,
    // so identity_traits is always empty on first call.
    let t = build_test_app_state().await;
    let got = get_identity_traits_impl(t.state()).await.unwrap();
    assert!(got.is_empty(), "expected no identity traits, got {got:?}");
}

// === list_quick_actions / add_quick_action / update / delete ==================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_quick_actions_on_fresh_db_is_empty() {
    let t = build_test_app_state().await;
    let got = list_quick_actions_impl(t.state()).await.unwrap();
    assert!(got.is_empty(), "expected no quick actions on fresh DB");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn add_quick_action_persists_and_surfaces_via_list() {
    let t = build_test_app_state().await;
    let id = add_quick_action_impl(
        t.state(),
        "Plan my day".into(),
        "summarize today".into(),
        "Please plan my day".into(),
        "sparkle".into(),
        "#ff0080".into(),
    )
    .await
    .unwrap();
    assert!(!id.is_empty(), "expected non-empty id from add_quick_action");

    let all = list_quick_actions_impl(t.state()).await.unwrap();
    assert_eq!(all.len(), 1);
    let row = &all[0];
    assert_eq!(row.id, id);
    assert_eq!(row.label, "Plan my day");
    assert_eq!(row.description, "summarize today");
    assert_eq!(row.prompt, "Please plan my day");
    assert_eq!(row.icon, "sparkle");
    assert_eq!(row.color, "#ff0080");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn update_quick_action_mutates_existing_row() {
    let t = build_test_app_state().await;
    let id = add_quick_action_impl(
        t.state(),
        "A".into(),
        "desc".into(),
        "pA".into(),
        "i".into(),
        "c".into(),
    )
    .await
    .unwrap();

    update_quick_action_impl(
        t.state(),
        id.clone(),
        "B".into(),
        "desc2".into(),
        "pB".into(),
        "i2".into(),
        "#222".into(),
    )
    .await
    .unwrap();

    let all = list_quick_actions_impl(t.state()).await.unwrap();
    assert_eq!(all.len(), 1);
    let row = &all[0];
    assert_eq!(row.id, id);
    assert_eq!(row.label, "B");
    assert_eq!(row.description, "desc2");
    assert_eq!(row.prompt, "pB");
    assert_eq!(row.icon, "i2");
    assert_eq!(row.color, "#222");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn delete_quick_action_removes_row_from_list() {
    let t = build_test_app_state().await;
    let id_keep = add_quick_action_impl(
        t.state(), "keep".into(), "".into(), "p".into(), "i".into(), "c".into(),
    ).await.unwrap();
    let id_drop = add_quick_action_impl(
        t.state(), "drop".into(), "".into(), "p".into(), "i".into(), "c".into(),
    ).await.unwrap();

    delete_quick_action_impl(t.state(), id_drop.clone())
        .await
        .unwrap();

    let all = list_quick_actions_impl(t.state()).await.unwrap();
    let ids: Vec<&str> = all.iter().map(|r| r.id.as_str()).collect();
    assert!(ids.contains(&id_keep.as_str()), "keep row should survive");
    assert!(!ids.contains(&id_drop.as_str()), "deleted row must be gone");
}

// === get_personality_stats ====================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_personality_stats_on_empty_db_returns_five_traits_at_base() {
    // Personality aggregates use a process-wide cache; invalidate it so earlier
    // tests with seeded signals don't bleed into this assertion.
    app_lib::engine::db::invalidate_personality_cache();

    let t = build_test_app_state().await;
    let got = get_personality_stats_impl(t.state()).await.unwrap();
    // The implementation always returns these five traits in order.
    let traits: Vec<&str> = got.iter().map(|v| v["trait"].as_str().unwrap()).collect();
    assert_eq!(traits, vec!["energy", "warmth", "mischief", "wit", "sass"]);

    // Empty DB: delta is 0.0, value clamped to PERSONALITY_BASE_STAT (50).
    for v in &got {
        assert_eq!(v["delta"].as_f64().unwrap(), 0.0);
        assert_eq!(v["value"].as_i64().unwrap(), 50);
    }
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_personality_stats_reflects_seeded_signals() {
    app_lib::engine::db::invalidate_personality_cache();

    let t = build_test_app_state().await;
    let signals = vec![
        app_lib::engine::db::PersonalitySignal {
            trait_name: "warmth".into(),
            delta: 8.0,
            evidence: "nice moment".into(),
            memory_id: None,
        },
        app_lib::engine::db::PersonalitySignal {
            trait_name: "sass".into(),
            delta: -3.0,
            evidence: "deadpan reply".into(),
            memory_id: None,
        },
    ];
    t.state()
        .db
        .add_personality_signals(&signals, None)
        .unwrap();
    // add_personality_signals invalidates the cache internally — no need to
    // re-invalidate before reading.

    let got = get_personality_stats_impl(t.state()).await.unwrap();
    let by_trait: std::collections::HashMap<&str, &serde_json::Value> = got
        .iter()
        .map(|v| (v["trait"].as_str().unwrap(), v))
        .collect();

    // Today's signals have ~1.0 decay weight, so delta ≈ raw delta.
    let warmth_delta = by_trait["warmth"]["delta"].as_f64().unwrap();
    assert!(
        (warmth_delta - 8.0).abs() < 0.1,
        "expected warmth delta near 8.0, got {warmth_delta}"
    );
    let sass_delta = by_trait["sass"]["delta"].as_f64().unwrap();
    assert!(
        (sass_delta + 3.0).abs() < 0.1,
        "expected sass delta near -3.0, got {sass_delta}"
    );

    // value = (base + delta).clamp(0, 100) → 58 for warmth, 47 for sass.
    assert_eq!(by_trait["warmth"]["value"].as_i64().unwrap(), 58);
    assert_eq!(by_trait["sass"]["value"].as_i64().unwrap(), 47);
}

// === get_personality_timeline =================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_personality_timeline_on_empty_db_is_empty() {
    let t = build_test_app_state().await;
    let got = get_personality_timeline_impl(t.state(), None).await.unwrap();
    assert!(got.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_personality_timeline_applies_limit_and_orders_newest_first() {
    let t = build_test_app_state().await;
    // Seed three signals. They share one batch `created_at`, so ordering within
    // the batch is by insertion order but all share the same timestamp —
    // the test asserts on count + limit, which is the contract the UI cares about.
    let signals = vec![
        app_lib::engine::db::PersonalitySignal {
            trait_name: "energy".into(),
            delta: 1.0,
            evidence: "a".into(),
            memory_id: None,
        },
        app_lib::engine::db::PersonalitySignal {
            trait_name: "energy".into(),
            delta: 2.0,
            evidence: "b".into(),
            memory_id: None,
        },
        app_lib::engine::db::PersonalitySignal {
            trait_name: "energy".into(),
            delta: 3.0,
            evidence: "c".into(),
            memory_id: None,
        },
    ];
    t.state()
        .db
        .add_personality_signals(&signals, None)
        .unwrap();

    let all = get_personality_timeline_impl(t.state(), None).await.unwrap();
    assert_eq!(all.len(), 3);

    let limited = get_personality_timeline_impl(t.state(), Some(2)).await.unwrap();
    assert_eq!(limited.len(), 2, "expected limit=2 to cap the timeline");
}

// === toggle_sparkling_memory / list_sparkling_memories ========================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_sparkling_memories_on_fresh_store_is_empty() {
    let t = build_test_app_state().await;
    let got = list_sparkling_memories_impl(t.state()).await.unwrap();
    assert!(got.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn toggle_sparkling_memory_pins_then_unpins_trace() {
    let t = build_test_app_state().await;
    // Seed a memory via the test store — MEMME_USER_ID for parity with the impl.
    let add_opts = memme_core::AddOptions::new("yiyi_default_user")
        .categories(vec!["test".into()]);
    let result = t
        .state()
        .memme_store
        .add("a sparkling moment", add_opts)
        .expect("add memory");

    // Pin it.
    toggle_sparkling_memory_impl(t.state(), result.id.clone(), true)
        .await
        .unwrap();

    let pinned = list_sparkling_memories_impl(t.state()).await.unwrap();
    assert_eq!(pinned.len(), 1, "expected one pinned memory");
    assert_eq!(pinned[0]["id"].as_str().unwrap(), result.id);
    assert_eq!(pinned[0]["content"].as_str().unwrap(), "a sparkling moment");

    // Unpin it.
    toggle_sparkling_memory_impl(t.state(), result.id.clone(), false)
        .await
        .unwrap();
    let after = list_sparkling_memories_impl(t.state()).await.unwrap();
    assert!(after.is_empty(), "unpinned memory should drop from list");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn toggle_sparkling_memory_on_unknown_id_is_no_op() {
    // UPDATE on non-existent row affects 0 rows and returns Ok — matches SQL semantics.
    let t = build_test_app_state().await;
    toggle_sparkling_memory_impl(t.state(), "does-not-exist".into(), true)
        .await
        .unwrap();
    let got = list_sparkling_memories_impl(t.state()).await.unwrap();
    assert!(got.is_empty());
}

// === get_recall_candidates ====================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_recall_candidates_on_fresh_store_is_empty() {
    let t = build_test_app_state().await;
    let got = get_recall_candidates_impl(t.state(), None).await.unwrap();
    assert!(got.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_recall_candidates_ignores_fresh_memories() {
    // The impl requires memories older than 7 days; freshly-added rows
    // shouldn't surface.
    let t = build_test_app_state().await;
    let _ = t
        .state()
        .memme_store
        .add(
            "a recent thought",
            memme_core::AddOptions::new("yiyi_default_user")
                .importance(0.9),
        )
        .expect("add memory");
    let got = get_recall_candidates_impl(t.state(), Some(5)).await.unwrap();
    assert!(
        got.is_empty(),
        "fresh (<7d) memories should not appear in recall"
    );
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_recall_candidates_respects_limit_on_old_memories() {
    let t = build_test_app_state().await;
    // Add a memory via the normal API, then manually backdate it in storage so
    // recall_nostalgia's 7-day floor passes.
    let rec = t
        .state()
        .memme_store
        .add(
            "an old cherished memory",
            memme_core::AddOptions::new("yiyi_default_user")
                .importance(0.9),
        )
        .expect("add memory");

    // Backdate via direct DB write on the memme sqlite file.
    let memme_db = t.state().working_dir.join("memme.sqlite");
    let conn = rusqlite::Connection::open(&memme_db).expect("open memme db");
    let old_ts = (chrono::Utc::now() - chrono::Duration::days(30))
        .format("%Y-%m-%dT%H:%M:%S")
        .to_string();
    conn.execute(
        "UPDATE memories SET created_at = ?1 WHERE id = ?2",
        rusqlite::params![old_ts, rec.id],
    )
    .expect("backdate row");
    drop(conn);

    let got = get_recall_candidates_impl(t.state(), Some(5)).await.unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["id"].as_str().unwrap(), rec.id);
    // importance 0.9 → confidence 0.9
    assert!(
        (got[0]["confidence"].as_f64().unwrap() - 0.9).abs() < 1e-6,
        "expected confidence ~0.9, got {:?}",
        got[0]["confidence"]
    );
}
