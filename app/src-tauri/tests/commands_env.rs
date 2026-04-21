mod common;

#[allow(unused_imports)]
use common::*;
use app_lib::commands::env::*;
use serial_test::serial;

// `save_envs` / `delete_env` mutate process environment via `std::env::set_var`
// and `std::env::remove_var`. Those changes are global and visible across tests
// in the same binary, so `#[serial]` is required.

fn mk(key: &str, value: &str) -> EnvVar {
    EnvVar {
        key: key.to_string(),
        value: value.to_string(),
    }
}

// === list_envs ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_envs_returns_empty_on_fresh_workspace() {
    let t = build_test_app_state().await;
    let envs = list_envs_impl(t.state()).await.unwrap();
    assert!(envs.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_envs_returns_saved_entries() {
    let t = build_test_app_state().await;
    let state = t.state();
    save_envs_impl(
        state,
        vec![mk("LIST_ENVS_FOO", "1"), mk("LIST_ENVS_BAR", "two words")],
    )
    .await
    .unwrap();

    let envs = list_envs_impl(state).await.unwrap();
    // BTreeMap ordering by key — LIST_ENVS_BAR sorts before LIST_ENVS_FOO.
    assert_eq!(envs.len(), 2);
    let keys: Vec<&str> = envs.iter().map(|e| e.key.as_str()).collect();
    assert!(keys.contains(&"LIST_ENVS_FOO"));
    assert!(keys.contains(&"LIST_ENVS_BAR"));
    let bar = envs.iter().find(|e| e.key == "LIST_ENVS_BAR").unwrap();
    assert_eq!(bar.value, "two words");
}

// === save_envs ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn save_envs_persists_to_env_file_and_process_env() {
    let t = build_test_app_state().await;
    let state = t.state();
    save_envs_impl(state, vec![mk("SAVE_ENVS_FOO", "persisted")]).await.unwrap();

    // Verify .env file written.
    let env_path = state.working_dir.join(".env");
    let content = std::fs::read_to_string(&env_path).expect(".env should exist");
    assert!(content.contains("SAVE_ENVS_FOO=persisted"));

    // Verify process env set.
    assert_eq!(std::env::var("SAVE_ENVS_FOO").ok().as_deref(), Some("persisted"));

    // Cleanup.
    std::env::remove_var("SAVE_ENVS_FOO");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn save_envs_filters_out_empty_keys() {
    let t = build_test_app_state().await;
    let state = t.state();
    save_envs_impl(
        state,
        vec![mk("", "ignored"), mk("SAVE_ENVS_KEEP", "kept")],
    )
    .await
    .unwrap();

    let envs = list_envs_impl(state).await.unwrap();
    assert_eq!(envs.len(), 1);
    assert_eq!(envs[0].key, "SAVE_ENVS_KEEP");

    // Cleanup.
    std::env::remove_var("SAVE_ENVS_KEEP");
}

// === delete_env ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn delete_env_removes_existing_key() {
    let t = build_test_app_state().await;
    let state = t.state();
    save_envs_impl(
        state,
        vec![mk("DELETE_ENVS_A", "1"), mk("DELETE_ENVS_B", "2")],
    )
    .await
    .unwrap();

    delete_env_impl(state, "DELETE_ENVS_A".to_string()).await.unwrap();

    let envs = list_envs_impl(state).await.unwrap();
    let keys: Vec<&str> = envs.iter().map(|e| e.key.as_str()).collect();
    assert!(!keys.contains(&"DELETE_ENVS_A"));
    assert!(keys.contains(&"DELETE_ENVS_B"));

    // Process env should also be cleared.
    assert!(std::env::var("DELETE_ENVS_A").is_err());

    // Cleanup.
    std::env::remove_var("DELETE_ENVS_B");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn delete_env_on_nonexistent_key_is_idempotent() {
    let t = build_test_app_state().await;
    // Should not error on keys that never existed.
    delete_env_impl(t.state(), "DELETE_ENVS_NEVER_SET".to_string())
        .await
        .expect("delete of unknown key should be idempotent Ok");
}
