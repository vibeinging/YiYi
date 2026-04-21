mod common;

#[allow(unused_imports)]
use common::*;
use app_lib::commands::voice::*;
use app_lib::engine::voice::VoiceStatus;
use serial_test::serial;

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

// ────────────────────────────────────────────────────────────────────────────
// start_voice_session (backfilled)
//
// The happy path reaches out to the OpenAI Realtime API over a WebSocket,
// which is out of scope for unit tests. We instead assert the synchronous
// failure contract: with no providers configured, `resolve_api_key` fails
// before `VoiceSessionManager::start` is ever called, and the manager
// remains idle.
// ────────────────────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn start_voice_session_errors_when_no_llm_provider_configured() {
    let t = build_test_app_state().await;
    let app = build_mock_tauri_app();
    let handle = app.handle().clone();

    let err = start_voice_session_impl(t.state(), handle)
        .await
        .expect_err("start_voice_session should fail with no provider configured");
    // The exact wording comes from resolve_config_from_providers, but it
    // mentions the missing provider/LLM/config — check it's an informative error.
    assert!(!err.is_empty(), "error must not be empty: {:?}", err);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn start_voice_session_failure_leaves_voice_manager_idle() {
    // A failed start must not register a session. Status stays Idle.
    let t = build_test_app_state().await;
    let app = build_mock_tauri_app();
    let handle = app.handle().clone();

    let _err = start_voice_session_impl(t.state(), handle)
        .await
        .expect_err("should fail without a provider");

    let status = get_voice_status_impl(t.state()).await.unwrap();
    assert_eq!(
        status,
        VoiceStatus::Idle,
        "voice_manager must remain Idle after a failed start"
    );
}
