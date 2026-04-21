mod common;

#[allow(unused_imports)]
use common::*;
use app_lib::commands::agent::chat::{
    chat_stream_state_impl, chat_stream_stop_impl, clear_history_impl,
    delete_message_impl, get_history_impl,
};
use serial_test::serial;

// === chat_stream_stop ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn chat_stream_stop_sets_cancel_flag() {
    let t = build_test_app_state().await;
    let state = t.state();
    assert!(!state.chat_cancelled.load(std::sync::atomic::Ordering::Relaxed));
    chat_stream_stop_impl(state).await.unwrap();
    assert!(state.chat_cancelled.load(std::sync::atomic::Ordering::Relaxed));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn chat_stream_stop_is_idempotent() {
    let t = build_test_app_state().await;
    let state = t.state();
    chat_stream_stop_impl(state).await.unwrap();
    chat_stream_stop_impl(state).await.unwrap();
    assert!(state.chat_cancelled.load(std::sync::atomic::Ordering::Relaxed));
}

// === chat_stream_state ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn chat_stream_state_returns_none_for_unknown_session() {
    let t = build_test_app_state().await;
    let result = chat_stream_state_impl(t.state(), "nonexistent".to_string())
        .await
        .unwrap();
    assert!(result.is_none());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn chat_stream_state_returns_some_after_state_insertion() {
    use app_lib::state::app_state::StreamingSnapshot;
    let t = build_test_app_state().await;
    let state = t.state();
    {
        let mut ss = state.streaming_state.lock().unwrap();
        ss.insert(
            "sess-1".to_string(),
            StreamingSnapshot {
                is_active: true,
                accumulated_text: String::new(),
                tools: vec![],
                spawn_agents: vec![],
            },
        );
    }
    let result = chat_stream_state_impl(state, "sess-1".to_string())
        .await
        .unwrap();
    assert!(result.is_some());
    assert!(result.unwrap().is_active);
}

// === clear_history ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn clear_history_inserts_context_reset_marker() {
    let t = build_test_app_state().await;
    let state = t.state();
    // First create a session by pushing a message
    state.db.push_message("test-session", "user", "hello").unwrap();
    // Clear
    clear_history_impl(state, Some("test-session".to_string()))
        .await
        .unwrap();
    // Verify the last message is the context_reset marker
    let msgs = state.db.get_messages("test-session", None).unwrap();
    let last = msgs.last().expect("should have messages");
    assert_eq!(last.role, "context_reset");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn clear_history_with_none_session_id_uses_default() {
    let t = build_test_app_state().await;
    let state = t.state();
    // Should not error even when session_id is None (uses default session)
    clear_history_impl(state, None).await.unwrap();
}

// === delete_message ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn delete_message_removes_existing_message() {
    let t = build_test_app_state().await;
    let state = t.state();
    state.db.push_message("sess", "user", "to be deleted").unwrap();
    let msgs = state.db.get_messages("sess", None).unwrap();
    let msg_id = msgs.last().unwrap().id;
    delete_message_impl(state, msg_id).await.unwrap();
    let after = state.db.get_messages("sess", None).unwrap();
    assert!(after.iter().all(|m| m.id != msg_id));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn delete_message_on_nonexistent_id_does_not_panic() {
    let t = build_test_app_state().await;
    // Nonexistent message id — should return Ok (delete is idempotent) or a controlled error.
    let _ = delete_message_impl(t.state(), 9_999_999).await;
}

// === get_history ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_history_returns_messages_in_order() {
    let t = build_test_app_state().await;
    let state = t.state();
    state.db.push_message("sess-hist", "user", "first").unwrap();
    state.db.push_message("sess-hist", "assistant", "second").unwrap();
    let messages = get_history_impl(state, Some("sess-hist".to_string()), None)
        .await
        .unwrap();
    assert!(messages.len() >= 2);
    assert_eq!(messages[0].role, "user");
    assert_eq!(messages[0].content, "first");
    assert_eq!(messages[1].role, "assistant");
    assert_eq!(messages[1].content, "second");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_history_empty_when_no_messages() {
    let t = build_test_app_state().await;
    let messages = get_history_impl(t.state(), Some("empty-sess".to_string()), None)
        .await
        .unwrap();
    assert!(messages.is_empty());
}
