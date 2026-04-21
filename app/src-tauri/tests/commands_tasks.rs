mod common;

#[allow(unused_imports)]
use common::*;
use app_lib::commands::tasks::*;
use serial_test::serial;
use std::sync::{Arc, Mutex};
use tauri::Listener;

// Seed a task row directly via Database. Returns (task_id, session_id).
fn seed_task(
    t: &TestAppState,
    title: &str,
    parent_session_id: Option<&str>,
    status: &str,
) -> (String, String) {
    let task_id = uuid::Uuid::new_v4().to_string();
    let session_id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp();

    t.state()
        .db
        .ensure_session(&session_id, title, "task", Some(&task_id))
        .expect("ensure_session should succeed");
    t.state()
        .db
        .create_task(
            &task_id,
            title,
            Some("seeded-description"),
            status,
            &session_id,
            parent_session_id,
            None,
            0,
            now,
        )
        .expect("create_task should succeed");

    (task_id, session_id)
}

// === list_tasks ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_tasks_returns_empty_on_fresh_db() {
    let t = build_test_app_state().await;
    let tasks = list_tasks_impl(t.state(), None, None).await.unwrap();
    assert!(tasks.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_tasks_returns_seeded_tasks() {
    let t = build_test_app_state().await;
    let (id_a, _) = seed_task(&t, "alpha", None, "pending");
    let (id_b, _) = seed_task(&t, "beta", None, "running");
    let tasks = list_tasks_impl(t.state(), None, None).await.unwrap();
    assert_eq!(tasks.len(), 2);
    let ids: Vec<&str> = tasks.iter().map(|t| t.id.as_str()).collect();
    assert!(ids.contains(&id_a.as_str()));
    assert!(ids.contains(&id_b.as_str()));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_tasks_filters_by_status() {
    let t = build_test_app_state().await;
    let _ = seed_task(&t, "pend", None, "pending");
    let (running_id, _) = seed_task(&t, "run", None, "running");
    let tasks = list_tasks_impl(t.state(), None, Some("running".to_string()))
        .await
        .unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].id, running_id);
    assert_eq!(tasks[0].status, "running");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_tasks_filters_by_parent_session_id() {
    let t = build_test_app_state().await;
    let (match_id, _) = seed_task(&t, "with-parent", Some("parent-xyz"), "pending");
    let _ = seed_task(&t, "other-parent", Some("parent-abc"), "pending");
    let _ = seed_task(&t, "no-parent", None, "pending");
    let tasks = list_tasks_impl(t.state(), Some("parent-xyz".to_string()), None)
        .await
        .unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].id, match_id);
}

// === get_task_status ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_task_status_errors_on_missing_id() {
    let t = build_test_app_state().await;
    let err = get_task_status_impl(t.state(), "does-not-exist".to_string())
        .await
        .expect_err("missing task should error");
    assert!(err.contains("Task not found"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_task_status_returns_seeded_task() {
    let t = build_test_app_state().await;
    let (task_id, session_id) = seed_task(&t, "findable", None, "pending");
    let task = get_task_status_impl(t.state(), task_id.clone()).await.unwrap();
    assert_eq!(task.id, task_id);
    assert_eq!(task.title, "findable");
    assert_eq!(task.session_id, session_id);
    assert_eq!(task.status, "pending");
    assert_eq!(task.description.as_deref(), Some("seeded-description"));
}

// === get_task_by_name ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_task_by_name_returns_none_when_missing() {
    let t = build_test_app_state().await;
    let found = get_task_by_name_impl(t.state(), "nothing".to_string())
        .await
        .unwrap();
    assert!(found.is_none());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_task_by_name_returns_substring_match() {
    let t = build_test_app_state().await;
    let (task_id, _) = seed_task(&t, "my-important-report", None, "pending");
    let found = get_task_by_name_impl(t.state(), "important".to_string())
        .await
        .unwrap();
    let task = found.expect("should find by substring");
    assert_eq!(task.id, task_id);
    assert_eq!(task.title, "my-important-report");
}

// === list_all_tasks_brief ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_all_tasks_brief_empty_on_fresh_db() {
    let t = build_test_app_state().await;
    let tasks = list_all_tasks_brief_impl(t.state()).await.unwrap();
    assert!(tasks.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_all_tasks_brief_includes_all_statuses_and_parents() {
    let t = build_test_app_state().await;
    // Mix of statuses and parent-session values — list_all_tasks_brief ignores filters.
    let _ = seed_task(&t, "a", None, "pending");
    let _ = seed_task(&t, "b", Some("parent-1"), "running");
    let _ = seed_task(&t, "c", Some("parent-2"), "completed");
    let tasks = list_all_tasks_brief_impl(t.state()).await.unwrap();
    assert_eq!(tasks.len(), 3);
    let titles: Vec<&str> = tasks.iter().map(|t| t.title.as_str()).collect();
    assert!(titles.contains(&"a"));
    assert!(titles.contains(&"b"));
    assert!(titles.contains(&"c"));
}

// ────────────────────────────────────────────────────────────────────────────
// AppHandle-taking commands (backfill batch)
//
// These tests drive the generic `_impl<R: Runtime>` entrypoints with
// `AppHandle<MockRuntime>` so we can both (a) assert persisted DB state and
// (b) observe emitted events via the mock listener.
// ────────────────────────────────────────────────────────────────────────────

/// Capture every event fired on the given channel. Attach BEFORE invoking the
/// command under test — MockRuntime dispatches listener callbacks synchronously.
fn capture_events(
    handle: &tauri::AppHandle<tauri::test::MockRuntime>,
    channel: &str,
) -> Arc<Mutex<Vec<serde_json::Value>>> {
    let events: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
    let events_clone = events.clone();
    let _id = handle.listen(channel, move |event| {
        let payload: serde_json::Value =
            serde_json::from_str(event.payload()).unwrap_or(serde_json::Value::Null);
        events_clone.lock().unwrap().push(payload);
    });
    events
}

// === create_task ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn create_task_inserts_row_and_emits_created_event() {
    let t = build_test_app_state().await;
    let app = build_mock_tauri_app();
    let handle = app.handle().clone();
    let events = capture_events(&handle, "task://created");

    let task = create_task_impl(
        t.state(),
        &handle,
        "new-task".to_string(),
        Some("desc".to_string()),
        "parent-s".to_string(),
        Some(vec!["step1".to_string(), "step2".to_string()]),
    )
    .await
    .expect("create_task_impl should succeed");

    // Persisted state
    assert_eq!(task.title, "new-task");
    assert_eq!(task.description.as_deref(), Some("desc"));
    assert_eq!(task.status, "pending");
    assert_eq!(task.total_stages, 2);
    assert_eq!(task.parent_session_id.as_deref(), Some("parent-s"));

    let fetched = t.state().db.get_task(&task.id).unwrap().unwrap();
    assert_eq!(fetched.id, task.id);

    // Cancellation signal was registered.
    let signal = t.state().get_or_create_task_cancel(&task.id);
    assert!(!signal.load(std::sync::atomic::Ordering::Relaxed));

    // Emitted event
    let got = events.lock().unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["taskId"], serde_json::Value::String(task.id.clone()));
    assert_eq!(got[0]["title"], "new-task");
    assert_eq!(got[0]["parentSessionId"], "parent-s");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn create_task_defaults_to_zero_stages_when_plan_absent() {
    let t = build_test_app_state().await;
    let app = build_mock_tauri_app();
    let handle = app.handle().clone();

    let task = create_task_impl(
        t.state(),
        &handle,
        "no-plan".to_string(),
        None,
        "parent".to_string(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(task.total_stages, 0);
    assert!(task.plan.is_none());
    assert!(task.description.is_none());
}

// === pause_task ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn pause_task_flips_status_and_emits_paused_event() {
    let t = build_test_app_state().await;
    let app = build_mock_tauri_app();
    let handle = app.handle().clone();

    let (task_id, _) = seed_task(&t, "runnable", None, "running");
    t.state().get_or_create_task_cancel(&task_id);

    let events = capture_events(&handle, "task://paused");

    pause_task_impl(t.state(), &handle, task_id.clone())
        .await
        .expect("pause_task_impl should succeed");

    let row = t.state().db.get_task(&task_id).unwrap().unwrap();
    assert_eq!(row.status, "paused");

    let got = events.lock().unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["taskId"], serde_json::Value::String(task_id));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn pause_task_errors_on_non_pausable_status() {
    let t = build_test_app_state().await;
    let app = build_mock_tauri_app();
    let handle = app.handle().clone();

    let (task_id, _) = seed_task(&t, "done-task", None, "completed");
    let err = pause_task_impl(t.state(), &handle, task_id)
        .await
        .expect_err("cannot pause a completed task");
    assert!(err.contains("Cannot pause task"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn pause_task_errors_on_missing_id() {
    let t = build_test_app_state().await;
    let app = build_mock_tauri_app();
    let handle = app.handle().clone();

    let err = pause_task_impl(t.state(), &handle, "ghost".to_string())
        .await
        .expect_err("missing task should error");
    assert!(err.contains("Task not found"));
}

// === send_task_message ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn send_task_message_pushes_user_message_and_emits_event() {
    let t = build_test_app_state().await;
    let app = build_mock_tauri_app();
    let handle = app.handle().clone();

    let (task_id, session_id) = seed_task(&t, "chat-task", None, "running");
    let events = capture_events(&handle, "task://message");

    send_task_message_impl(
        t.state(),
        &handle,
        task_id.clone(),
        "hello task".to_string(),
    )
    .await
    .expect("send_task_message_impl should succeed");

    // DB: message was pushed to the task session
    let msgs = t.state().db.get_recent_messages(&session_id, 10).unwrap();
    let user_msg = msgs.iter().find(|m| m.role == "user" && m.content == "hello task");
    assert!(user_msg.is_some(), "user message should be in task session");

    // Event carries taskId, sessionId, message
    let got = events.lock().unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["taskId"], serde_json::Value::String(task_id));
    assert_eq!(got[0]["sessionId"], serde_json::Value::String(session_id));
    assert_eq!(got[0]["message"], "hello task");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn send_task_message_errors_on_non_active_status() {
    let t = build_test_app_state().await;
    let app = build_mock_tauri_app();
    let handle = app.handle().clone();

    let (task_id, _) = seed_task(&t, "pending-task", None, "pending");
    let err = send_task_message_impl(
        t.state(),
        &handle,
        task_id,
        "ignored".to_string(),
    )
    .await
    .expect_err("cannot send to pending task");
    assert!(err.contains("Cannot send message"));
}

// === delete_task ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn delete_task_removes_row_and_emits_deleted_event() {
    let t = build_test_app_state().await;
    let app = build_mock_tauri_app();
    let handle = app.handle().clone();

    let (task_id, _) = seed_task(&t, "doomed", None, "running");
    // Register a cancellation signal so we can assert cleanup.
    t.state().get_or_create_task_cancel(&task_id);

    let events = capture_events(&handle, "task://deleted");

    delete_task_impl(t.state(), &handle, task_id.clone())
        .await
        .expect("delete_task_impl should succeed");

    // DB row is gone
    let gone = t.state().db.get_task(&task_id).unwrap();
    assert!(gone.is_none(), "task row should be deleted");

    // Cancellation signal cleaned up
    let cancellations = t.state().task_cancellations.lock().unwrap();
    assert!(
        !cancellations.contains_key(&task_id),
        "delete_task_impl should cleanup task_cancellations entry"
    );
    drop(cancellations);

    // Event fired
    let got = events.lock().unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["taskId"], serde_json::Value::String(task_id));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn delete_task_is_idempotent_on_unknown_id() {
    // Mirror the cancel_task idempotency contract: deleting an unknown row
    // is an SQL DELETE with 0 rows affected — still Ok.
    let t = build_test_app_state().await;
    let app = build_mock_tauri_app();
    let handle = app.handle().clone();

    let events = capture_events(&handle, "task://deleted");

    delete_task_impl(t.state(), &handle, "no-such-task".to_string())
        .await
        .expect("delete of unknown id must not error");

    // Event is always emitted (observable contract; frontend doesn't know if there was a row).
    let got = events.lock().unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["taskId"], "no-such-task");
}

// === pin_task ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn pin_task_flips_pinned_flag_and_emits_updated_event() {
    let t = build_test_app_state().await;
    let app = build_mock_tauri_app();
    let handle = app.handle().clone();

    let (task_id, _) = seed_task(&t, "pinnable", None, "pending");
    let events = capture_events(&handle, "task://updated");

    pin_task_impl(t.state(), &handle, task_id.clone(), true)
        .await
        .unwrap();
    let row = t.state().db.get_task(&task_id).unwrap().unwrap();
    assert!(row.pinned, "pinned should be true after pinning");

    pin_task_impl(t.state(), &handle, task_id.clone(), false)
        .await
        .unwrap();
    let row = t.state().db.get_task(&task_id).unwrap().unwrap();
    assert!(!row.pinned, "pinned should be false after unpinning");

    // Two events: pinned=true then pinned=false
    let got = events.lock().unwrap();
    assert_eq!(got.len(), 2);
    assert_eq!(got[0]["pinned"], true);
    assert_eq!(got[1]["pinned"], false);
    assert_eq!(got[0]["taskId"], serde_json::Value::String(task_id));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn pin_task_is_idempotent_on_unknown_id() {
    let t = build_test_app_state().await;
    let app = build_mock_tauri_app();
    let handle = app.handle().clone();

    // Underlying SQL UPDATE with no matching row is still Ok.
    pin_task_impl(t.state(), &handle, "ghost".to_string(), true)
        .await
        .expect("pin on unknown id should be idempotent Ok");
}

// === confirm_background_task ===
//
// This command (a) inserts a task row, (b) pushes context + user message
// into the task session, (c) emits `task://created`, (d) fires-and-forgets
// a ReAct execution via `tokio::spawn`. In tests we only assert the
// synchronous (a-c) contract; the spawned task will fail in test env because
// no LLM is configured, but that's not in our scope.

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn confirm_background_task_creates_task_and_pushes_messages() {
    let t = build_test_app_state().await;
    let app = build_mock_tauri_app();
    let handle = app.handle().clone();

    let events = capture_events(&handle, "task://created");

    let task = confirm_background_task_impl(
        t.state(),
        &handle,
        "parent-sess".to_string(),
        "bg-task".to_string(),
        "do the thing".to_string(),
        "prior context".to_string(),
        None,
    )
    .await
    .expect("confirm_background_task_impl should succeed");

    // Task row inserted
    assert_eq!(task.title, "bg-task");
    assert_eq!(task.status, "pending");
    assert_eq!(task.parent_session_id.as_deref(), Some("parent-sess"));

    // Context + user messages pushed into the task's own session
    let msgs = t.state().db.get_recent_messages(&task.session_id, 20).unwrap();
    let has_context = msgs.iter().any(|m| {
        m.role == "system" && m.content.contains("[Context from main chat]") && m.content.contains("prior context")
    });
    let has_user = msgs.iter().any(|m| m.role == "user" && m.content == "do the thing");
    assert!(has_context, "context summary should be pushed as system message");
    assert!(has_user, "original message should be pushed as user message");

    // task://created event fired with source=background
    let got = events.lock().unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["taskId"], serde_json::Value::String(task.id.clone()));
    assert_eq!(got[0]["source"], "background");
    assert_eq!(got[0]["parentSessionId"], "parent-sess");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn confirm_background_task_skips_context_when_summary_empty() {
    let t = build_test_app_state().await;
    let app = build_mock_tauri_app();
    let handle = app.handle().clone();

    let task = confirm_background_task_impl(
        t.state(),
        &handle,
        "parent".to_string(),
        "bg".to_string(),
        "hi".to_string(),
        "".to_string(), // empty context
        None,
    )
    .await
    .unwrap();

    let msgs = t.state().db.get_recent_messages(&task.session_id, 20).unwrap();
    let has_context_system_msg = msgs.iter().any(|m| {
        m.role == "system" && m.content.contains("[Context from main chat]")
    });
    assert!(!has_context_system_msg, "empty context must not push any system message");
}

// === convert_to_long_task ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn convert_to_long_task_copies_parent_history_and_emits_event() {
    let t = build_test_app_state().await;
    let app = build_mock_tauri_app();
    let handle = app.handle().clone();

    // Seed parent session with a few messages.
    let parent_id = "parent-session".to_string();
    t.state()
        .db
        .ensure_session(&parent_id, "parent", "chat", None)
        .unwrap();
    t.state().db.push_message(&parent_id, "user", "first msg").unwrap();
    t.state().db.push_message(&parent_id, "assistant", "response 1").unwrap();
    t.state().db.push_message(&parent_id, "user", "second msg").unwrap();

    let events = capture_events(&handle, "task://created");

    let task = convert_to_long_task_impl(
        t.state(),
        &handle,
        parent_id.clone(),
        "converted-task".to_string(),
        "extracted context".to_string(),
        None,
    )
    .await
    .expect("convert_to_long_task_impl should succeed");

    // Task row inserted
    assert_eq!(task.title, "converted-task");
    assert_eq!(task.parent_session_id.as_deref(), Some(parent_id.as_str()));

    // Task session has: context system msg + 3 parent messages
    let msgs = t.state().db.get_recent_messages(&task.session_id, 50).unwrap();
    let has_task_context = msgs.iter().any(|m| {
        m.role == "system" && m.content.contains("[Task Context]") && m.content.contains("extracted context")
    });
    let first_copied = msgs.iter().any(|m| m.role == "user" && m.content == "first msg");
    let assistant_copied = msgs.iter().any(|m| m.role == "assistant" && m.content == "response 1");
    let second_copied = msgs.iter().any(|m| m.role == "user" && m.content == "second msg");
    assert!(has_task_context, "task context should be pushed first as system message");
    assert!(first_copied);
    assert!(assistant_copied);
    assert!(second_copied);

    // task://created event fired with source=converted
    let got = events.lock().unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["source"], "converted");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn convert_to_long_task_handles_parent_with_no_messages() {
    let t = build_test_app_state().await;
    let app = build_mock_tauri_app();
    let handle = app.handle().clone();

    // Parent session exists but has no messages — get_recent_messages returns empty Vec.
    let parent_id = "empty-parent".to_string();
    t.state()
        .db
        .ensure_session(&parent_id, "empty", "chat", None)
        .unwrap();

    let task = convert_to_long_task_impl(
        t.state(),
        &handle,
        parent_id,
        "conv".to_string(),
        "ctx".to_string(),
        None,
    )
    .await
    .expect("should succeed even with empty parent");

    // Only the context system message ends up in the task session.
    let msgs = t.state().db.get_recent_messages(&task.session_id, 50).unwrap();
    let system_count = msgs.iter().filter(|m| m.role == "system").count();
    let other_count = msgs.iter().filter(|m| m.role != "system").count();
    assert!(system_count >= 1, "at least the task-context system message");
    assert_eq!(other_count, 0, "no parent messages to copy");
}
