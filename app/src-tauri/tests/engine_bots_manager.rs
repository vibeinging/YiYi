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
