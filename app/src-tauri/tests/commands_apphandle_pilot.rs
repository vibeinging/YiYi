//! AppHandle mock infrastructure pilot.
//!
//! Exercises the generic-runtime `_impl` pattern: `cancel_task_impl<R: Runtime>`
//! is driven with an `AppHandle<MockRuntime>` built via `build_mock_tauri_app`.
//! Asserts both persisted state (DB row flipped to `cancelled`) and observable
//! side effects (event fired on the `task://cancelled` channel).
//!
//! This file is the reference example for the remaining ~50 deferred
//! AppHandle-taking commands — see `docs/testing-conventions.md`.

mod common;

#[allow(unused_imports)]
use common::*;

use app_lib::commands::tasks::*;
use serial_test::serial;
use std::sync::{Arc, Mutex};
use tauri::Listener;

// Seed a task row directly via Database. Returns task_id.
fn seed_task(t: &TestAppState, title: &str, status: &str) -> String {
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
            None,
            None,
            0,
            now,
        )
        .expect("create_task should succeed");

    // Register cancellation signal so cancel_task_signal returns true.
    t.state().get_or_create_task_cancel(&task_id);

    task_id
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn cancel_task_flips_status_and_emits_cancelled_event() {
    let t = build_test_app_state().await;
    let app = build_mock_tauri_app();
    let handle = app.handle().clone();

    let task_id = seed_task(&t, "pilot-task", "running");

    // Capture events BEFORE invoking the command.
    let events: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
    let events_clone = events.clone();
    let _id = handle.listen("task://cancelled", move |event| {
        let payload: serde_json::Value = serde_json::from_str(event.payload())
            .expect("task://cancelled payload should be valid JSON");
        events_clone.lock().unwrap().push(payload);
    });

    // Act.
    cancel_task_impl(t.state(), &handle, task_id.clone())
        .await
        .expect("cancel_task_impl should succeed");

    // Persisted state: DB row flipped to cancelled.
    let row = t
        .state()
        .db
        .get_task(&task_id)
        .expect("get_task should succeed")
        .expect("task row should exist");
    assert_eq!(row.status, "cancelled");

    // Cleanup: cancellation signal removed from the map.
    let cancellations = t.state().task_cancellations.lock().unwrap();
    assert!(
        !cancellations.contains_key(&task_id),
        "cancel_task_impl should cleanup task_cancellations entry"
    );
    drop(cancellations);

    // Emitted event: payload contains the task_id.
    let got = events.lock().unwrap();
    assert_eq!(got.len(), 1, "expected exactly one task://cancelled event");
    assert_eq!(got[0]["taskId"], serde_json::Value::String(task_id));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn cancel_task_is_idempotent_for_unknown_id() {
    // No seeded task; no signal registered. cancel_task_impl still emits an
    // event and logs a warning, but must not panic or error out. This mirrors
    // the real-world case where the frontend clicks cancel on a task the
    // engine already finished.
    let t = build_test_app_state().await;
    let app = build_mock_tauri_app();
    let handle = app.handle().clone();

    let events: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
    let events_clone = events.clone();
    let _id = handle.listen("task://cancelled", move |event| {
        let payload: serde_json::Value =
            serde_json::from_str(event.payload()).unwrap_or(serde_json::Value::Null);
        events_clone.lock().unwrap().push(payload);
    });

    // Acts on a non-existent id. Implementation treats update_task_status as
    // a simple SQL UPDATE (0 rows affected = still Ok), so this is idempotent.
    cancel_task_impl(t.state(), &handle, "no-such-task".into())
        .await
        .expect("cancel_task_impl should not error on unknown id");

    // Event is always emitted, even when the task didn't exist — that's the
    // observable contract; the frontend doesn't care whether there was a row
    // to flip.
    let got = events.lock().unwrap();
    assert_eq!(got.len(), 1, "expected one idempotent task://cancelled event");
    assert_eq!(got[0]["taskId"], "no-such-task");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn cancel_task_signals_pending_cancellation_flag() {
    // The cancellation signal is an AtomicBool — `cancel_task_impl` flips it
    // to true so any running agent loop watching the signal will exit. We
    // capture the signal before the call, then assert it was stored.
    let t = build_test_app_state().await;
    let app = build_mock_tauri_app();
    let handle = app.handle().clone();

    let task_id = seed_task(&t, "signal-task", "running");
    let signal = t.state().get_or_create_task_cancel(&task_id);
    assert!(
        !signal.load(std::sync::atomic::Ordering::Relaxed),
        "signal starts false"
    );

    cancel_task_impl(t.state(), &handle, task_id.clone())
        .await
        .expect("cancel_task_impl should succeed");

    assert!(
        signal.load(std::sync::atomic::Ordering::Relaxed),
        "cancel_task_impl should set the cancellation signal to true"
    );
}
