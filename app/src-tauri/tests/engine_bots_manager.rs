mod common;

#[allow(unused_imports)]
use common::*;
use app_lib::engine::bots::manager::{BotManager, RunningBot};
use std::sync::Arc;
use tokio::sync::RwLock;

#[tokio::test(flavor = "multi_thread")]
async fn bot_manager_new_starts_not_running() {
    let mgr = BotManager::new();
    assert!(!mgr.is_running().await);
    assert_eq!(mgr.connected_count().await, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn bot_manager_register_and_query_running_bot() {
    let mgr = BotManager::new();
    let bot = RunningBot {
        bot_id: "bot-1".to_string(),
        running_flag: Arc::new(RwLock::new(true)),
    };
    mgr.register_running_bot(bot).await;

    assert!(mgr.is_bot_running("bot-1").await);
    let ids = mgr.list_running_bot_ids().await;
    assert_eq!(ids, vec!["bot-1".to_string()]);
}

#[tokio::test(flavor = "multi_thread")]
async fn bot_manager_unregister_bot_returns_true_if_present() {
    let mgr = BotManager::new();
    let bot = RunningBot {
        bot_id: "bot-2".to_string(),
        running_flag: Arc::new(RwLock::new(true)),
    };
    mgr.register_running_bot(bot).await;
    assert!(mgr.unregister_running_bot("bot-2").await);
    assert!(!mgr.is_bot_running("bot-2").await);
}

#[tokio::test(flavor = "multi_thread")]
async fn bot_manager_unregister_missing_bot_returns_false() {
    let mgr = BotManager::new();
    assert!(!mgr.unregister_running_bot("never-existed").await);
}

#[tokio::test(flavor = "multi_thread")]
async fn bot_manager_list_empty_when_no_bots_registered() {
    let mgr = BotManager::new();
    let ids = mgr.list_running_bot_ids().await;
    assert!(ids.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn bot_manager_get_sender_returns_working_channel() {
    let mgr = BotManager::new();
    let tx = mgr.get_sender();
    drop(tx);
}

#[tokio::test(flavor = "multi_thread")]
async fn bot_manager_register_handler_does_not_panic() {
    let mgr = BotManager::new();
    mgr.register_handler("bot-3", |_session, _content| async move {
        Ok(())
    })
    .await;
    assert!(!mgr.is_running().await);
}

// === Fixture-driven tests (batch 1 backfill) ===
//
// NOTE on scope: `BotManager::start()` takes a concrete `tauri::AppHandle`
// (Wry runtime) which cannot be constructed from the `MockRuntime` used by
// `build_mock_tauri_app`. End-to-end dedup/debounce/worker-isolation tests
// that require `start()` are therefore deferred until either:
//   (a) `start()` is refactored to be generic over `tauri::Runtime`, or
//   (b) a Wry AppHandle can be spun up in tests.
// These tests cover the public surface we can reach today.

#[tokio::test(flavor = "multi_thread")]
async fn bot_manager_get_sender_accepts_fixture_message() {
    let mgr = BotManager::new();
    let tx = mgr.get_sender();
    let msg = incoming_message("bot-send", "webhook", "m1", "hello");
    tx.send(msg).await.expect("send should succeed on fresh channel");
}

#[tokio::test(flavor = "multi_thread")]
async fn bot_manager_get_sender_accepts_many_messages_without_blocking() {
    // Channel capacity is 1000 in the production code. Prove we can enqueue
    // a reasonable batch via the fixture without start() running.
    let mgr = BotManager::new();
    let tx = mgr.get_sender();
    for i in 0..50 {
        let msg = incoming_message(
            "bot-batch",
            "webhook",
            &format!("m{}", i),
            &format!("text {}", i),
        );
        tx.send(msg).await.expect("send should succeed");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn bot_manager_connected_count_tracks_registered_handlers() {
    let mgr = BotManager::new();
    assert_eq!(mgr.connected_count().await, 0);

    mgr.register_handler("bot-a", |_s, _c| async move { Ok(()) }).await;
    assert_eq!(mgr.connected_count().await, 1);

    mgr.register_handler("bot-b", |_s, _c| async move { Ok(()) }).await;
    assert_eq!(mgr.connected_count().await, 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn bot_manager_unregister_handler_removes_from_connected_count() {
    let mgr = BotManager::new();
    mgr.register_handler("bot-x", |_s, _c| async move { Ok(()) }).await;
    mgr.register_handler("bot-y", |_s, _c| async move { Ok(()) }).await;
    assert_eq!(mgr.connected_count().await, 2);

    mgr.unregister_handler("bot-x").await;
    assert_eq!(mgr.connected_count().await, 1);

    // Unregistering a bot that was never registered is a no-op.
    mgr.unregister_handler("does-not-exist").await;
    assert_eq!(mgr.connected_count().await, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn bot_manager_register_handler_overwrites_previous_entry() {
    // Registering the same bot_id twice should keep the count at 1 — the
    // second call replaces the handler entry for that bot rather than
    // duplicating it.
    let mgr = BotManager::new();
    mgr.register_handler("bot-dup", |_s, _c| async move { Ok(()) }).await;
    mgr.register_handler("bot-dup", |_s, _c| async move { Ok(()) }).await;
    assert_eq!(mgr.connected_count().await, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn bot_manager_stop_without_start_is_idempotent() {
    // stop() flips a running flag; calling it before start() must not panic
    // and `is_running()` stays false.
    let mgr = BotManager::new();
    assert!(!mgr.is_running().await);
    mgr.stop().await;
    assert!(!mgr.is_running().await);
}

#[tokio::test(flavor = "multi_thread")]
async fn bot_manager_register_and_unregister_running_bot_flips_flag() {
    // Exercises the running_flag write on unregister — production uses this
    // to ask platform bots to shut down cooperatively.
    let mgr = BotManager::new();
    let flag = Arc::new(RwLock::new(true));
    let bot = RunningBot {
        bot_id: "bot-flag".to_string(),
        running_flag: flag.clone(),
    };
    mgr.register_running_bot(bot).await;
    assert!(*flag.read().await, "flag should still be true before unregister");

    assert!(mgr.unregister_running_bot("bot-flag").await);
    assert!(
        !*flag.read().await,
        "running_flag should be flipped to false after unregister"
    );
}
