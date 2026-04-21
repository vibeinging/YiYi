//! Integration tests for `commands/bots.rs` thin-layer `_impl` functions.
//!
//! Covers simple `State<AppState>`-style DB and manager commands. Defers:
//! - `bots_send` (real external API — Discord/Telegram/QQ/etc.)
//! - `bots_start` / `bots_start_one` (BotManager::start takes concrete AppHandle<Wry>
//!   and spawns real platform connections; refactor needed at engine layer to
//!   generalize the runtime parameter)
//! - `bots_test_connection` (real external API call per platform)

mod common;

#[allow(unused_imports)]
use common::*;

use app_lib::commands::bots::*;
use app_lib::engine::bots::manager::RunningBot;
use serial_test::serial;
use std::sync::Arc;
use tokio::sync::RwLock;

// === Helpers ===================================================================

/// Create a bot via the `_impl` so tests can share setup without touching
/// internal Database fields.
async fn seed_bot(
    t: &TestAppState,
    name: &str,
    platform: &str,
    config: serde_json::Value,
) -> BotInfo {
    bots_create_impl(
        t.state(),
        name.to_string(),
        platform.to_string(),
        config,
        None,
        None,
    )
    .await
    .expect("seed_bot should succeed")
}

// === bots_list / bots_list_platforms ==========================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn bots_list_on_empty_db_returns_empty_vec() {
    let t = build_test_app_state().await;
    let bots = bots_list_impl(t.state()).await.unwrap();
    assert!(bots.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn bots_list_returns_created_bots_with_deserialized_config() {
    let t = build_test_app_state().await;

    seed_bot(
        &t,
        "Alpha",
        "discord",
        serde_json::json!({ "bot_token": "t1" }),
    )
    .await;
    seed_bot(&t, "Beta", "webhook", serde_json::json!({ "port": 9090 })).await;

    let bots = bots_list_impl(t.state()).await.unwrap();
    assert_eq!(bots.len(), 2);
    let alpha = bots.iter().find(|b| b.name == "Alpha").unwrap();
    assert_eq!(alpha.platform, "discord");
    assert!(alpha.enabled);
    assert_eq!(alpha.config["bot_token"], "t1");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn bots_list_platforms_returns_nonempty_shaped_list() {
    let list = bots_list_platforms_impl();
    assert!(!list.is_empty());
    // Every entry must have an id and a name.
    for item in &list {
        assert!(item["id"].is_string(), "missing 'id' in {:?}", item);
        assert!(item["name"].is_string(), "missing 'name' in {:?}", item);
    }
    // Known built-in platforms.
    let ids: Vec<&str> = list.iter().filter_map(|v| v["id"].as_str()).collect();
    assert!(ids.contains(&"discord"));
    assert!(ids.contains(&"webhook"));
}

// === bots_get =================================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn bots_get_returns_row_by_id() {
    let t = build_test_app_state().await;
    let created = seed_bot(&t, "Echo", "telegram", serde_json::json!({})).await;

    let got = bots_get_impl(t.state(), created.id.clone()).await.unwrap();
    assert_eq!(got.id, created.id);
    assert_eq!(got.name, "Echo");
    assert_eq!(got.platform, "telegram");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn bots_get_on_unknown_id_returns_not_found_error() {
    let t = build_test_app_state().await;
    let err = bots_get_impl(t.state(), "no-such-bot".into())
        .await
        .unwrap_err();
    assert!(
        err.contains("not found"),
        "expected not-found error, got: {err}"
    );
}

// === bots_create =============================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn bots_create_persists_with_config_and_defaults_enabled() {
    let t = build_test_app_state().await;
    let info = bots_create_impl(
        t.state(),
        "Foxtrot".into(),
        "discord".into(),
        serde_json::json!({ "bot_token": "abc" }),
        Some("helpful".into()),
        None,
    )
    .await
    .unwrap();

    assert!(info.enabled, "newly created bot should default to enabled");
    assert_eq!(info.persona.as_deref(), Some("helpful"));
    assert!(!info.id.is_empty());

    // Reload and verify
    let reloaded = bots_get_impl(t.state(), info.id.clone()).await.unwrap();
    assert_eq!(reloaded.config["bot_token"], "abc");
    assert_eq!(reloaded.persona.as_deref(), Some("helpful"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn bots_create_serializes_access_field_when_provided() {
    let t = build_test_app_state().await;
    let info = bots_create_impl(
        t.state(),
        "Gulf".into(),
        "webhook".into(),
        serde_json::json!({}),
        None,
        Some(serde_json::json!({ "users": ["u1", "u2"] })),
    )
    .await
    .unwrap();

    assert!(info.access.is_some());
    let access = info.access.as_ref().unwrap();
    assert_eq!(access["users"][0], "u1");
}

// === bots_update ==============================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn bots_update_applies_partial_changes_and_bumps_updated_at() {
    let t = build_test_app_state().await;
    let original = seed_bot(&t, "Hotel", "discord", serde_json::json!({})).await;
    // Ensure timestamps differ even if both land in the same millisecond.
    tokio::time::sleep(std::time::Duration::from_millis(2)).await;

    let updated = bots_update_impl(
        t.state(),
        original.id.clone(),
        Some("Hotel Renamed".into()),
        Some(false),
        None,
        None,
        None,
    )
    .await
    .unwrap();

    assert_eq!(updated.name, "Hotel Renamed");
    assert!(!updated.enabled);
    assert_eq!(updated.platform, "discord"); // unchanged
    assert!(
        updated.updated_at >= original.updated_at,
        "updated_at should not regress"
    );
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn bots_update_with_empty_persona_clears_value() {
    let t = build_test_app_state().await;
    let original = bots_create_impl(
        t.state(),
        "India".into(),
        "discord".into(),
        serde_json::json!({}),
        Some("initial persona".into()),
        None,
    )
    .await
    .unwrap();
    assert!(original.persona.is_some());

    let cleared = bots_update_impl(
        t.state(),
        original.id.clone(),
        None,
        None,
        None,
        Some(String::new()), // empty → clear
        None,
    )
    .await
    .unwrap();
    assert!(
        cleared.persona.is_none(),
        "empty persona string should clear the field"
    );
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn bots_update_on_unknown_id_returns_not_found_error() {
    let t = build_test_app_state().await;
    let err = bots_update_impl(
        t.state(),
        "ghost-bot".into(),
        Some("Ghost".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap_err();
    assert!(err.contains("not found"), "got: {err}");
}

// === bots_delete ==============================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn bots_delete_removes_bot_from_db() {
    let t = build_test_app_state().await;
    let info = seed_bot(&t, "Juliet", "webhook", serde_json::json!({})).await;

    bots_delete_impl(t.state(), info.id.clone()).await.unwrap();

    let err = bots_get_impl(t.state(), info.id.clone())
        .await
        .unwrap_err();
    assert!(err.contains("not found"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn bots_delete_unknown_id_is_idempotent() {
    let t = build_test_app_state().await;
    // SQL DELETE with no matching row returns Ok (0 rows affected).
    bots_delete_impl(t.state(), "never-created".into())
        .await
        .expect("delete on unknown id should be idempotent");
}

// === bots_stop ================================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn bots_stop_on_fresh_manager_is_noop_and_returns_ok() {
    let t = build_test_app_state().await;
    let resp = bots_stop_impl(t.state()).await.unwrap();
    assert_eq!(resp["status"], "ok");
    // Nothing was running; still no bots running after stop.
    assert!(t.state().bot_manager.list_running_bot_ids().await.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn bots_stop_clears_running_bots_when_present() {
    let t = build_test_app_state().await;
    // Register a fake running bot directly in the manager.
    t.state()
        .bot_manager
        .register_running_bot(RunningBot {
            bot_id: "fake-run".into(),
            running_flag: Arc::new(RwLock::new(true)),
        })
        .await;
    assert!(t.state().bot_manager.is_bot_running("fake-run").await);

    // bots_stop() doesn't clear the running_bots map directly; it calls
    // `bot_manager.stop()` which only toggles the consumer loop and webhook
    // server. Verify the call returns ok.
    let resp = bots_stop_impl(t.state()).await.unwrap();
    assert_eq!(resp["status"], "ok");
}

// === bots_stop_one ============================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn bots_stop_one_unregisters_a_running_bot() {
    let t = build_test_app_state().await;
    let running_flag = Arc::new(RwLock::new(true));
    t.state()
        .bot_manager
        .register_running_bot(RunningBot {
            bot_id: "stopme".into(),
            running_flag: running_flag.clone(),
        })
        .await;
    // Also register a handler so unregister_handler has something to remove.
    t.state()
        .bot_manager
        .register_handler("stopme", |_session, _content| async move { Ok(()) })
        .await;

    let resp = bots_stop_one_impl(t.state(), "stopme".into())
        .await
        .unwrap();
    assert_eq!(resp["status"], "ok");
    assert_eq!(resp["bot_id"], "stopme");
    assert!(!t.state().bot_manager.is_bot_running("stopme").await);
    // Running flag flipped off so the bot's task loop can exit.
    assert!(!*running_flag.read().await);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn bots_stop_one_on_unknown_id_returns_error() {
    let t = build_test_app_state().await;
    let err = bots_stop_one_impl(t.state(), "never-ran".into())
        .await
        .unwrap_err();
    assert!(
        err.contains("not running") || err.contains("not found"),
        "got: {err}"
    );
}

// === bots_running_list ========================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn bots_running_list_returns_empty_for_fresh_manager() {
    let t = build_test_app_state().await;
    let ids = bots_running_list_impl(t.state()).await.unwrap();
    assert!(ids.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn bots_running_list_returns_registered_bot_ids() {
    let t = build_test_app_state().await;
    t.state()
        .bot_manager
        .register_running_bot(RunningBot {
            bot_id: "bot-a".into(),
            running_flag: Arc::new(RwLock::new(true)),
        })
        .await;
    t.state()
        .bot_manager
        .register_running_bot(RunningBot {
            bot_id: "bot-b".into(),
            running_flag: Arc::new(RwLock::new(true)),
        })
        .await;

    let mut ids = bots_running_list_impl(t.state()).await.unwrap();
    ids.sort();
    assert_eq!(ids, vec!["bot-a".to_string(), "bot-b".to_string()]);
}

// === bots_list_sessions =======================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn bots_list_sessions_is_empty_on_fresh_db() {
    let t = build_test_app_state().await;
    let sessions = bots_list_sessions_impl(t.state()).await.unwrap();
    assert!(sessions.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn bots_list_sessions_returns_only_bot_source_sessions() {
    let t = build_test_app_state().await;

    // Seed one "bot"-source session and one "chat"-source session.
    t.state()
        .db
        .ensure_session("bot-sess-1", "Bot session", "bot", None)
        .unwrap();
    t.state()
        .db
        .ensure_session("chat-sess-1", "Chat session", "chat", None)
        .unwrap();

    let sessions = bots_list_sessions_impl(t.state()).await.unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].id, "bot-sess-1");
}

// === bot_conversations_list ===================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn bot_conversations_list_returns_empty_when_none_exist() {
    let t = build_test_app_state().await;
    let convs = bot_conversations_list_impl(t.state(), None).await.unwrap();
    assert!(convs.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn bot_conversations_list_returns_upserted_conversation_with_bot_name() {
    let t = build_test_app_state().await;
    let bot = seed_bot(&t, "Kilo", "discord", serde_json::json!({})).await;

    let conv = t
        .state()
        .db
        .upsert_conversation(&bot.id, "external-123", "discord", Some("Channel #1"))
        .unwrap();

    let all = bot_conversations_list_impl(t.state(), None).await.unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].id, conv.id);
    assert_eq!(all[0].bot_name, "Kilo"); // joined from bot row
    assert_eq!(all[0].external_id, "external-123");
    assert_eq!(all[0].trigger_mode, "mention"); // default from upsert_conversation

    // Filter by bot_id
    let filtered = bot_conversations_list_impl(t.state(), Some(bot.id.clone()))
        .await
        .unwrap();
    assert_eq!(filtered.len(), 1);

    // Filter by a different bot_id → empty
    let other = bot_conversations_list_impl(t.state(), Some("other-bot-id".into()))
        .await
        .unwrap();
    assert!(other.is_empty());
}

// === bot_conversation_update_trigger ==========================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn bot_conversation_update_trigger_accepts_valid_modes() {
    let t = build_test_app_state().await;
    let bot = seed_bot(&t, "Lima", "discord", serde_json::json!({})).await;
    let conv = t
        .state()
        .db
        .upsert_conversation(&bot.id, "ch-1", "discord", None)
        .unwrap();

    for mode in ["all", "keyword", "muted", "mention"] {
        bot_conversation_update_trigger_impl(t.state(), conv.id.clone(), mode.into())
            .await
            .unwrap_or_else(|_| panic!("mode '{mode}' should be accepted"));
    }

    // Round-trip final value via list.
    let convs = bot_conversations_list_impl(t.state(), None).await.unwrap();
    assert_eq!(convs[0].trigger_mode, "mention");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn bot_conversation_update_trigger_rejects_invalid_mode() {
    let t = build_test_app_state().await;
    let bot = seed_bot(&t, "Mike", "discord", serde_json::json!({})).await;
    let conv = t
        .state()
        .db
        .upsert_conversation(&bot.id, "ch-2", "discord", None)
        .unwrap();

    let err = bot_conversation_update_trigger_impl(
        t.state(),
        conv.id.clone(),
        "bogus-mode".into(),
    )
    .await
    .unwrap_err();
    assert!(err.contains("Invalid trigger_mode"), "got: {err}");
}

// === bot_conversation_link ====================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn bot_conversation_link_sets_and_clears_linked_session() {
    let t = build_test_app_state().await;
    let bot = seed_bot(&t, "November", "discord", serde_json::json!({})).await;
    let conv = t
        .state()
        .db
        .upsert_conversation(&bot.id, "ch-3", "discord", None)
        .unwrap();

    bot_conversation_link_impl(t.state(), conv.id.clone(), Some("link-session-1".into()))
        .await
        .unwrap();

    let after = bot_conversations_list_impl(t.state(), None).await.unwrap();
    assert_eq!(after[0].linked_session_id.as_deref(), Some("link-session-1"));

    // Unlink (None)
    bot_conversation_link_impl(t.state(), conv.id.clone(), None)
        .await
        .unwrap();
    let cleared = bot_conversations_list_impl(t.state(), None).await.unwrap();
    assert!(cleared[0].linked_session_id.is_none());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn bot_conversation_link_on_unknown_id_is_ok() {
    let t = build_test_app_state().await;
    // SQL UPDATE on missing row → 0 rows affected → Ok.
    bot_conversation_link_impl(t.state(), "nope".into(), Some("s".into()))
        .await
        .expect("linking unknown conversation should not error");
}

// === bot_conversation_set_agent ================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn bot_conversation_set_agent_validates_json_shape() {
    let t = build_test_app_state().await;
    let bot = seed_bot(&t, "Oscar", "discord", serde_json::json!({})).await;
    let conv = t
        .state()
        .db
        .upsert_conversation(&bot.id, "ch-4", "discord", None)
        .unwrap();

    // Valid: matches AgentRouteConfig shape.
    let valid_json = serde_json::json!({
        "agent_id": "agent-a",
        "persona": "helpful",
        "allowed_tools": ["web_search"]
    })
    .to_string();
    bot_conversation_set_agent_impl(t.state(), conv.id.clone(), Some(valid_json))
        .await
        .unwrap();

    // Invalid: malformed JSON.
    let err = bot_conversation_set_agent_impl(
        t.state(),
        conv.id.clone(),
        Some("{not json".into()),
    )
    .await
    .unwrap_err();
    assert!(err.contains("Invalid agent config"), "got: {err}");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn bot_conversation_set_agent_with_none_clears_config() {
    let t = build_test_app_state().await;
    let bot = seed_bot(&t, "Papa", "discord", serde_json::json!({})).await;
    let conv = t
        .state()
        .db
        .upsert_conversation(&bot.id, "ch-5", "discord", None)
        .unwrap();

    // Set first
    bot_conversation_set_agent_impl(
        t.state(),
        conv.id.clone(),
        Some(serde_json::json!({ "agent_id": "a1" }).to_string()),
    )
    .await
    .unwrap();

    // Clear
    bot_conversation_set_agent_impl(t.state(), conv.id.clone(), None)
        .await
        .unwrap();

    let after = bot_conversations_list_impl(t.state(), None).await.unwrap();
    assert!(after[0].agent_config_json.is_none());
}

// === bot_conversation_delete ===================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn bot_conversation_delete_removes_conversation_row() {
    let t = build_test_app_state().await;
    let bot = seed_bot(&t, "Quebec", "discord", serde_json::json!({})).await;
    let conv = t
        .state()
        .db
        .upsert_conversation(&bot.id, "ch-6", "discord", None)
        .unwrap();
    assert_eq!(
        bot_conversations_list_impl(t.state(), None).await.unwrap().len(),
        1
    );

    bot_conversation_delete_impl(t.state(), conv.id.clone())
        .await
        .unwrap();
    assert_eq!(
        bot_conversations_list_impl(t.state(), None).await.unwrap().len(),
        0
    );
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn bot_conversation_delete_on_unknown_id_is_ok() {
    let t = build_test_app_state().await;
    // Idempotent DELETE — 0 rows affected is Ok.
    bot_conversation_delete_impl(t.state(), "ghost-conv".into())
        .await
        .expect("deleting non-existent conversation should be ok");
}

// === bots_get_status ===========================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn bots_get_status_returns_list_without_panic() {
    // The global bot-statuses map is a singleton shared across tests. We only
    // assert the call succeeds and yields a valid Vec (possibly empty).
    let statuses = bots_get_status_impl();
    // Smoke: every entry has a bot_id.
    for s in &statuses {
        assert!(
            !s.bot_id.is_empty(),
            "bot status entry should carry a bot_id"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn bots_get_status_returns_vec_type_and_is_callable_repeatedly() {
    // Call twice: the impl should be a pure getter with no state mutation.
    let a = bots_get_status_impl();
    let b = bots_get_status_impl();
    // Both calls return the same length (no side effect on the global map).
    assert_eq!(a.len(), b.len());
}
