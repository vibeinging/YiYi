mod common;

#[allow(unused_imports)]
use common::*;
use app_lib::commands::cronjobs::*;
use app_lib::engine::db::ExecutionMode;
use serial_test::serial;
use std::sync::{Arc, Mutex};
use tauri::Listener;

// Minimal-valid CronJobSpec builder. Uses "cron" schedule type so no scheduler
// wiring is required — tests exercise DB behaviour only.
fn mk_cronjob(id: &str) -> CronJobSpec {
    CronJobSpec {
        id: id.to_string(),
        name: format!("test-job-{}", id),
        enabled: true,
        schedule: ScheduleSpec {
            r#type: "cron".to_string(),
            cron: "0 0 * * *".to_string(),
            timezone: None,
            delay_minutes: None,
            schedule_at: None,
            created_at: None,
        },
        task_type: "notify".to_string(),
        text: Some("hello".to_string()),
        request: None,
        dispatch: None,
        runtime: None,
        execution_mode: ExecutionMode::Shared,
    }
}

// === list_cronjobs ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_cronjobs_returns_empty_on_fresh_db() {
    let t = build_test_app_state().await;
    let jobs = list_cronjobs_impl(t.state()).await.unwrap();
    assert!(jobs.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_cronjobs_returns_inserted_jobs() {
    let t = build_test_app_state().await;
    let state = t.state();
    let spec = mk_cronjob("job-a");
    let created = create_cronjob_impl(state, spec).await.unwrap();
    let jobs = list_cronjobs_impl(state).await.unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].id, created.id);
    assert_eq!(jobs[0].name, "test-job-job-a");
}

// === create_cronjob ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn create_cronjob_generates_uuid_when_id_empty() {
    let t = build_test_app_state().await;
    let mut spec = mk_cronjob("placeholder");
    spec.id = String::new();
    let created = create_cronjob_impl(t.state(), spec).await.unwrap();
    assert!(!created.id.is_empty());
    // Loose UUID shape check: 36 chars with four '-'.
    assert_eq!(created.id.len(), 36);
    assert_eq!(created.id.matches('-').count(), 4);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn create_cronjob_preserves_given_id() {
    let t = build_test_app_state().await;
    let spec = mk_cronjob("my-explicit-id");
    let created = create_cronjob_impl(t.state(), spec).await.unwrap();
    assert_eq!(created.id, "my-explicit-id");
}

// === update_cronjob ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn update_cronjob_errors_on_nonexistent_id() {
    let t = build_test_app_state().await;
    let spec = mk_cronjob("does-not-exist");
    let err = update_cronjob_impl(t.state(), "does-not-exist".to_string(), spec)
        .await
        .expect_err("should error on missing job");
    assert!(err.contains("not found"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn update_cronjob_modifies_existing_job() {
    let t = build_test_app_state().await;
    let state = t.state();
    let spec = mk_cronjob("updatable");
    let _ = create_cronjob_impl(state, spec).await.unwrap();

    let mut new_spec = mk_cronjob("updatable");
    new_spec.name = "renamed".to_string();
    new_spec.text = Some("new text".to_string());
    let updated = update_cronjob_impl(state, "updatable".to_string(), new_spec)
        .await
        .unwrap();
    assert_eq!(updated.id, "updatable");
    assert_eq!(updated.name, "renamed");

    // Verify persistence via list
    let jobs = list_cronjobs_impl(state).await.unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].name, "renamed");
    assert_eq!(jobs[0].text.as_deref(), Some("new text"));
}

// === delete_cronjob ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn delete_cronjob_removes_from_db() {
    let t = build_test_app_state().await;
    let state = t.state();
    let _ = create_cronjob_impl(state, mk_cronjob("doomed")).await.unwrap();
    delete_cronjob_impl(state, "doomed".to_string()).await.unwrap();
    let jobs = list_cronjobs_impl(state).await.unwrap();
    assert!(jobs.iter().all(|j| j.id != "doomed"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn delete_cronjob_idempotent_on_nonexistent() {
    let t = build_test_app_state().await;
    // DB impl uses DELETE WHERE id = ... which is idempotent.
    delete_cronjob_impl(t.state(), "never-existed".to_string())
        .await
        .expect("delete of unknown id should be idempotent Ok");
}

// === pause_cronjob ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn pause_cronjob_sets_enabled_false() {
    let t = build_test_app_state().await;
    let state = t.state();
    let _ = create_cronjob_impl(state, mk_cronjob("pausable")).await.unwrap();
    pause_cronjob_impl(state, "pausable".to_string()).await.unwrap();
    let jobs = list_cronjobs_impl(state).await.unwrap();
    let job = jobs.iter().find(|j| j.id == "pausable").unwrap();
    assert!(!job.enabled);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn pause_cronjob_errors_on_nonexistent_id() {
    let t = build_test_app_state().await;
    let err = pause_cronjob_impl(t.state(), "ghost".to_string())
        .await
        .expect_err("pause on missing job should error");
    assert!(err.contains("not found"));
}

// === get_cronjob_state ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_cronjob_state_returns_state_struct() {
    let t = build_test_app_state().await;
    let state = t.state();
    let _ = create_cronjob_impl(state, mk_cronjob("stateful")).await.unwrap();
    let value = get_cronjob_state_impl(state, "stateful".to_string())
        .await
        .unwrap();
    assert_eq!(value["id"].as_str(), Some("stateful"));
    assert_eq!(value["enabled"].as_bool(), Some(true));
    assert!(value["next_run_at"].is_null());
    // No executions yet, so last_run_at should be absent or null.
    assert!(value["last_run_at"].is_null());
    assert!(value["last_status"].is_null());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_cronjob_state_errors_on_nonexistent_id() {
    let t = build_test_app_state().await;
    let err = get_cronjob_state_impl(t.state(), "not-here".to_string())
        .await
        .expect_err("get_cronjob_state on missing id should error");
    assert!(err.contains("not found"));
}

// === list_cronjob_executions ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_cronjob_executions_empty_for_new_job() {
    let t = build_test_app_state().await;
    let state = t.state();
    let _ = create_cronjob_impl(state, mk_cronjob("fresh")).await.unwrap();
    let execs = list_cronjob_executions_impl(state, "fresh".to_string(), None)
        .await
        .unwrap();
    assert!(execs.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_cronjob_executions_returns_inserted_executions() {
    let t = build_test_app_state().await;
    let state = t.state();
    let _ = create_cronjob_impl(state, mk_cronjob("with-execs")).await.unwrap();
    // Insert an execution via the DB helper (mirror of what scheduler would do).
    let exec_id = state
        .db
        .insert_execution("with-execs", "manual")
        .expect("insert_execution should succeed");
    assert!(exec_id > 0);

    let execs = list_cronjob_executions_impl(state, "with-execs".to_string(), Some(10))
        .await
        .unwrap();
    assert_eq!(execs.len(), 1);
    assert_eq!(execs[0].job_id, "with-execs");
    assert_eq!(execs[0].trigger_type, "manual");
}

// ────────────────────────────────────────────────────────────────────────────
// AppHandle-taking commands (backfill batch)
// ────────────────────────────────────────────────────────────────────────────

/// Build a delay-type cronjob spec. `state.scheduler` is None in tests, so the
/// re-registration branch of `resume_cronjob_impl` is skipped but the emit
/// branch still fires.
fn mk_delay_cronjob(id: &str, delay_minutes: u64) -> CronJobSpec {
    CronJobSpec {
        id: id.to_string(),
        name: format!("delay-job-{}", id),
        enabled: false, // will be flipped by resume
        schedule: ScheduleSpec {
            r#type: "delay".to_string(),
            cron: String::new(),
            timezone: None,
            delay_minutes: Some(delay_minutes),
            schedule_at: None,
            created_at: None,
        },
        task_type: "notify".to_string(),
        text: Some("delay ping".to_string()),
        request: None,
        // Empty dispatch targets so no OS notification fires during tests.
        dispatch: Some(DispatchSpec { targets: vec![] }),
        runtime: None,
        execution_mode: ExecutionMode::Shared,
    }
}

// === resume_cronjob ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn resume_cronjob_errors_on_nonexistent_id() {
    let t = build_test_app_state().await;
    let app = build_mock_tauri_app();
    let handle = app.handle().clone();

    let err = resume_cronjob_impl(t.state(), &handle, "ghost".to_string())
        .await
        .expect_err("resume on missing job should error");
    assert!(err.contains("not found"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn resume_cronjob_flips_enabled_and_returns_restarted_false_for_cron_type() {
    let t = build_test_app_state().await;
    let state = t.state();
    let app = build_mock_tauri_app();
    let handle = app.handle().clone();

    // A disabled cron job (not delay/once).
    let mut spec = mk_cronjob("cron-job");
    spec.enabled = false;
    let _ = create_cronjob_impl(state, spec).await.unwrap();

    let events: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
    let events_clone = events.clone();
    let _id = handle.listen("cronjob://result", move |event| {
        let payload: serde_json::Value =
            serde_json::from_str(event.payload()).unwrap_or(serde_json::Value::Null);
        events_clone.lock().unwrap().push(payload);
    });

    let result = resume_cronjob_impl(state, &handle, "cron-job".to_string())
        .await
        .unwrap();

    assert_eq!(result["restarted"].as_bool(), Some(false));
    // enabled flag flipped to true
    let jobs = list_cronjobs_impl(state).await.unwrap();
    let job = jobs.iter().find(|j| j.id == "cron-job").unwrap();
    assert!(job.enabled);
    // No event for cron type
    let got = events.lock().unwrap();
    assert!(got.is_empty(), "cron type should not emit cronjob://result");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn resume_cronjob_delay_type_emits_result_event_and_flips_enabled() {
    let t = build_test_app_state().await;
    let state = t.state();
    let app = build_mock_tauri_app();
    let handle = app.handle().clone();

    let spec = mk_delay_cronjob("delay-a", 7);
    let _ = create_cronjob_impl(state, spec).await.unwrap();

    let events: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
    let events_clone = events.clone();
    let _id = handle.listen("cronjob://result", move |event| {
        let payload: serde_json::Value =
            serde_json::from_str(event.payload()).unwrap_or(serde_json::Value::Null);
        events_clone.lock().unwrap().push(payload);
    });

    let result = resume_cronjob_impl(state, &handle, "delay-a".to_string())
        .await
        .unwrap();

    assert_eq!(result["restarted"].as_bool(), Some(true));
    assert_eq!(result["schedule_type"].as_str(), Some("delay"));

    // enabled flipped
    let jobs = list_cronjobs_impl(state).await.unwrap();
    let job = jobs.iter().find(|j| j.id == "delay-a").unwrap();
    assert!(job.enabled);

    // Event contains job_id, job_name, and a "7 分钟" result string.
    let got = events.lock().unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["job_id"].as_str(), Some("delay-a"));
    assert_eq!(got[0]["job_name"].as_str(), Some("delay-job-delay-a"));
    let msg = got[0]["result"].as_str().unwrap();
    assert!(msg.contains("7"), "result message should include delay minutes: {}", msg);
}

// === run_cronjob ===
//
// Uses task_type="notify" + empty dispatch targets so the unified
// execute_job_task path is a pure string-passthrough: no LLM, no OS
// notification, no app-handle emit. We just assert the synchronous contract:
// the execution row is inserted and marked success.

fn mk_notify_cronjob(id: &str) -> CronJobSpec {
    CronJobSpec {
        id: id.to_string(),
        name: format!("notify-{}", id),
        enabled: true,
        schedule: ScheduleSpec {
            r#type: "cron".to_string(),
            cron: "0 0 * * *".to_string(),
            timezone: None,
            delay_minutes: None,
            schedule_at: None,
            created_at: None,
        },
        task_type: "notify".to_string(),
        text: Some("hello from test".to_string()),
        request: None,
        dispatch: Some(DispatchSpec { targets: vec![] }),
        runtime: None,
        execution_mode: ExecutionMode::Shared,
    }
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn run_cronjob_errors_on_nonexistent_id() {
    let t = build_test_app_state().await;
    let err = run_cronjob_impl(t.state(), "never-existed".to_string())
        .await
        .expect_err("run on missing job should error");
    assert!(err.contains("not found"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn run_cronjob_succeeds_for_notify_type_and_records_execution() {
    let t = build_test_app_state().await;
    let state = t.state();

    let spec = mk_notify_cronjob("notify-ok");
    let _ = create_cronjob_impl(state, spec).await.unwrap();

    run_cronjob_impl(state, "notify-ok".to_string())
        .await
        .expect("notify-type run should succeed");

    // Execution row recorded with success status.
    let execs = list_cronjob_executions_impl(state, "notify-ok".to_string(), None)
        .await
        .unwrap();
    assert_eq!(execs.len(), 1, "exactly one execution row after one run");
    assert_eq!(execs[0].job_id, "notify-ok");
    assert_eq!(execs[0].trigger_type, "manual");
    assert_eq!(
        execs[0].status, "success",
        "notify jobs never fail — output is just echoed back"
    );
    // Output is the echoed `text` field.
    assert_eq!(execs[0].result.as_deref(), Some("hello from test"));
}
