mod common;

#[allow(unused_imports)]
use common::*;
use app_lib::commands::heartbeat::*;
use app_lib::state::config::HeartbeatConfig;
use serial_test::serial;

// `get_heartbeat_config` / `save_heartbeat_config` read/write shared config
// state and touch disk via `Config::save`. `send_heartbeat` and
// `get_heartbeat_history` hit the shared SQLite database. All tests use
// `#[serial]` for safety (shared db/config under concurrent load).

// === get_heartbeat_config ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_heartbeat_config_returns_default_on_fresh_state() {
    let t = build_test_app_state().await;
    let cfg = get_heartbeat_config_impl(t.state()).await.unwrap();
    // Default: disabled, target "main", every "6h"
    assert!(!cfg.enabled);
    assert_eq!(cfg.target, "main");
    assert_eq!(cfg.every, "6h");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_heartbeat_config_reflects_saved_changes() {
    let t = build_test_app_state().await;
    let state = t.state();
    let new_cfg = HeartbeatConfig {
        enabled: true,
        every: "15m".to_string(),
        target: "custom-target".to_string(),
        active_hours: None,
    };
    save_heartbeat_config_impl(state, new_cfg.clone()).await.unwrap();

    let read_back = get_heartbeat_config_impl(state).await.unwrap();
    assert!(read_back.enabled);
    assert_eq!(read_back.every, "15m");
    assert_eq!(read_back.target, "custom-target");
}

// === save_heartbeat_config ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn save_heartbeat_config_persists_to_disk() {
    let t = build_test_app_state().await;
    let state = t.state();
    let cfg = HeartbeatConfig {
        enabled: true,
        every: "30m".to_string(),
        target: "disk-check".to_string(),
        active_hours: None,
    };
    let returned = save_heartbeat_config_impl(state, cfg.clone()).await.unwrap();
    assert_eq!(returned.target, "disk-check");

    // config.json should be written under working_dir.
    let cfg_path = state.working_dir.join("config.json");
    assert!(cfg_path.exists(), "config.json should exist after save");
    let raw = std::fs::read_to_string(&cfg_path).expect("readable config.json");
    assert!(raw.contains("disk-check"), "serialized config should contain target");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn save_heartbeat_config_overwrites_previous_value() {
    let t = build_test_app_state().await;
    let state = t.state();
    save_heartbeat_config_impl(
        state,
        HeartbeatConfig {
            enabled: true,
            every: "1h".to_string(),
            target: "first".to_string(),
            active_hours: None,
        },
    )
    .await
    .unwrap();
    save_heartbeat_config_impl(
        state,
        HeartbeatConfig {
            enabled: false,
            every: "2h".to_string(),
            target: "second".to_string(),
            active_hours: None,
        },
    )
    .await
    .unwrap();

    let final_cfg = get_heartbeat_config_impl(state).await.unwrap();
    assert!(!final_cfg.enabled);
    assert_eq!(final_cfg.every, "2h");
    assert_eq!(final_cfg.target, "second");
}

// === send_heartbeat ===
// Without an LLM configured, `send_heartbeat` falls back to a
// "no-LLM" success path that records a row to the db. We exercise
// that branch only — the LLM path would require external network.

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn send_heartbeat_no_llm_reports_success() {
    let t = build_test_app_state().await;
    let result = send_heartbeat_impl(t.state()).await.unwrap();
    // Fallback branch: success=true with stub message.
    assert_eq!(result["success"], serde_json::Value::Bool(true));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn send_heartbeat_writes_history_row() {
    let t = build_test_app_state().await;
    let state = t.state();
    // Before: history is empty.
    let before = get_heartbeat_history_impl(state, None).await.unwrap();
    assert!(before.is_empty());

    send_heartbeat_impl(state).await.unwrap();

    let after = get_heartbeat_history_impl(state, None).await.unwrap();
    assert_eq!(after.len(), 1);
    // Target should match the default config.
    assert_eq!(after[0].target, "main");
}

// === get_heartbeat_history ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_heartbeat_history_returns_empty_on_fresh_db() {
    let t = build_test_app_state().await;
    let history = get_heartbeat_history_impl(t.state(), None).await.unwrap();
    assert!(history.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_heartbeat_history_respects_limit() {
    let t = build_test_app_state().await;
    let state = t.state();
    // Fire 3 heartbeats (all succeed via no-LLM branch).
    for _ in 0..3 {
        send_heartbeat_impl(state).await.unwrap();
    }
    let limited = get_heartbeat_history_impl(state, Some(2)).await.unwrap();
    assert_eq!(limited.len(), 2);

    let full = get_heartbeat_history_impl(state, Some(100)).await.unwrap();
    assert_eq!(full.len(), 3);
}
