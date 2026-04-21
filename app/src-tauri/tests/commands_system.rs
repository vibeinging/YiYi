//! Integration tests for `commands/system.rs` thin-layer `_impl` functions.
//!
//! Part 1/2 — covers health/models/workspace/setup/install/flags/growth/correction.
//! Part 2 (meditation/memme/identity/quick actions/personality) appends to this file.
//!
//! Deferred:
//! - `check_claude_code_status` (real `which claude` subprocess + ~/.claude.json probing)
//! - `install_claude_code` (real `npm install -g`)
//! - `install_tool` / `install_git` (real package installs)

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
