//! Build a mock Tauri app + AppHandle for tests that exercise commands
//! taking `AppHandle` / `Window` parameters.
//!
//! Uses `tauri::test::mock_builder` (from the `tauri/test` feature, enabled via
//! our `test-support` feature). The produced `App<MockRuntime>` supports
//! `emit` / `listen` on its `AppHandle<MockRuntime>`, so tests can verify
//! events fired by commands whose `_impl` is generic over `R: Runtime`.
//!
//! Keep the `App` alive for the duration of the test: dropping it tears down
//! the event loop, which makes listeners stop receiving events.

use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::App;

/// Build a minimal mock Tauri app for tests.
///
/// Intended usage:
/// ```ignore
/// let app = build_mock_tauri_app();
/// let handle = app.handle().clone();
/// // pass &handle to `_impl` functions generic over `R: tauri::Runtime`.
/// ```
pub fn build_mock_tauri_app() -> App<MockRuntime> {
    mock_builder()
        .build(mock_context(noop_assets()))
        .expect("failed to build mock Tauri app")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use tauri::{Emitter, Listener};

    #[test]
    fn mock_tauri_app_builds_and_provides_handle() {
        let app = build_mock_tauri_app();
        let _handle = app.handle().clone();
        // Smoke test: construction succeeded and we can clone a handle.
    }

    #[test]
    fn mock_tauri_app_can_emit_and_listen() {
        let app = build_mock_tauri_app();
        let handle = app.handle().clone();

        let received = Arc::new(AtomicBool::new(false));
        let received_clone = received.clone();
        let _id = handle.listen("pilot-event", move |_event| {
            received_clone.store(true, Ordering::SeqCst);
        });

        handle.emit("pilot-event", ()).expect("emit should succeed");

        // Mock runtime dispatches listener callbacks synchronously on emit.
        assert!(
            received.load(Ordering::SeqCst),
            "listener should have received the emitted event"
        );
    }

    #[test]
    fn mock_tauri_app_listener_sees_payload() {
        let app = build_mock_tauri_app();
        let handle = app.handle().clone();

        let captured: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let captured_clone = captured.clone();
        let _id = handle.listen("pilot-event-payload", move |event| {
            captured_clone
                .lock()
                .unwrap()
                .push(event.payload().to_string());
        });

        handle
            .emit("pilot-event-payload", serde_json::json!({ "n": 42 }))
            .expect("emit with payload should succeed");

        let got = captured.lock().unwrap();
        assert_eq!(got.len(), 1, "expected exactly one event");
        let payload: serde_json::Value =
            serde_json::from_str(&got[0]).expect("payload must parse as JSON");
        assert_eq!(payload["n"], 42);
    }
}
