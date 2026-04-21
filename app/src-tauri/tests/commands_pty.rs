mod common;

#[allow(unused_imports)]
use common::*;
use app_lib::commands::pty::*;
use serial_test::serial;

// PTY commands operate on an in-memory `PtyManager` owned by AppState.
// The `_impl` helpers we cover here (`pty_resize_impl`, `pty_close_impl`,
// `pty_list_impl`) never touch a live subprocess because there are no
// spawned sessions in the test state — so they exercise only the
// session-map lookup / error paths. `pty_spawn` / `pty_write` are
// deferred (require AppHandle + live PTY subprocess).

// === pty_list ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn pty_list_returns_empty_on_fresh_state() {
    let t = build_test_app_state().await;
    let sessions = pty_list_impl(t.state()).await.unwrap();
    assert!(sessions.is_empty(), "fresh PtyManager should have no sessions");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn pty_list_does_not_panic_on_repeated_calls() {
    let t = build_test_app_state().await;
    // Multiple list calls should be safe and always return empty.
    for _ in 0..3 {
        let sessions = pty_list_impl(t.state()).await.unwrap();
        assert_eq!(sessions.len(), 0);
    }
}

// === pty_close ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn pty_close_errors_on_unknown_session() {
    let t = build_test_app_state().await;
    let err = pty_close_impl(t.state(), "no-such-session".into())
        .await
        .unwrap_err();
    assert!(
        err.contains("not found"),
        "expected 'not found' error, got: {}",
        err
    );
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn pty_close_empty_id_errors() {
    let t = build_test_app_state().await;
    let err = pty_close_impl(t.state(), "".into()).await.unwrap_err();
    assert!(
        err.contains("not found"),
        "empty id should hit not-found branch, got: {}",
        err
    );
}

// === pty_resize ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn pty_resize_errors_on_unknown_session() {
    let t = build_test_app_state().await;
    let err = pty_resize_impl(t.state(), "missing".into(), 120, 40)
        .await
        .unwrap_err();
    assert!(
        err.contains("not found"),
        "expected 'not found' error, got: {}",
        err
    );
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn pty_resize_accepts_various_dimensions() {
    let t = build_test_app_state().await;
    // Even tiny / huge dims should just error 'not found' (no spawned session),
    // confirming the lookup happens before any dim validation.
    for (cols, rows) in [(1u16, 1u16), (80, 24), (200, 60), (0, 0)] {
        let err = pty_resize_impl(t.state(), "nope".into(), cols, rows)
            .await
            .unwrap_err();
        assert!(err.contains("not found"));
    }
}
