mod common;

#[allow(unused_imports)]
use common::*;
use app_lib::commands::voice::*;
use app_lib::engine::voice::VoiceStatus;
use serial_test::serial;

// Note: `start_voice_session` is deferred because it takes a `tauri::AppHandle`
// and emits events. Only `stop_voice_session` and `get_voice_status` are
// testable at the _impl layer.

// === get_voice_status ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_voice_status_returns_idle_on_fresh_state() {
    let t = build_test_app_state().await;
    let status = get_voice_status_impl(t.state()).await.unwrap();
    assert_eq!(status, VoiceStatus::Idle);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_voice_status_remains_idle_after_stop_on_no_session() {
    let t = build_test_app_state().await;
    let state = t.state();
    // No session was ever started, so stop is a no-op.
    stop_voice_session_impl(state).await.unwrap();
    let status = get_voice_status_impl(state).await.unwrap();
    assert_eq!(status, VoiceStatus::Idle);
}

// === stop_voice_session ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn stop_voice_session_is_ok_when_no_session_active() {
    let t = build_test_app_state().await;
    // Should not error on fresh manager with no session.
    stop_voice_session_impl(t.state()).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn stop_voice_session_is_idempotent() {
    let t = build_test_app_state().await;
    let state = t.state();
    // Two consecutive stops must both succeed.
    stop_voice_session_impl(state).await.unwrap();
    stop_voice_session_impl(state).await.unwrap();
}
