mod common;

#[allow(unused_imports)]
use common::*;
use app_lib::commands::cli::*;
use app_lib::state::config::CliProviderConfig;
use serial_test::serial;

// All CLI provider config commands read/write shared config state and
// persist to `config.json` via `Config::save`. `#[serial]` keeps the
// file-system + lock access deterministic across concurrent tests.
// `install_cli_provider` is deferred — it spawns `sh -c <install_cmd>`
// which touches the host system.

fn mk_cfg(binary: &str) -> CliProviderConfig {
    CliProviderConfig {
        enabled: true,
        binary: binary.to_string(),
        install_command: format!("echo install {}", binary),
        auth_command: "auth login".to_string(),
        check_command: "--version".to_string(),
        credentials: std::collections::HashMap::new(),
        auth_status: "unknown".to_string(),
    }
}

// === list_cli_providers ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_cli_providers_returns_empty_on_fresh_state() {
    let t = build_test_app_state().await;
    let providers = list_cli_providers_impl(t.state()).await.unwrap();
    assert!(providers.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_cli_providers_returns_saved_entries() {
    let t = build_test_app_state().await;
    let state = t.state();
    save_cli_provider_config_impl(state, "alpha".into(), mk_cfg("alpha-bin"))
        .await
        .unwrap();
    save_cli_provider_config_impl(state, "beta".into(), mk_cfg("beta-bin"))
        .await
        .unwrap();

    let providers = list_cli_providers_impl(state).await.unwrap();
    assert_eq!(providers.len(), 2);
    let keys: Vec<&str> = providers.iter().map(|p| p.key.as_str()).collect();
    assert!(keys.contains(&"alpha"));
    assert!(keys.contains(&"beta"));
}

// === save_cli_provider_config ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn save_cli_provider_config_returns_info_reflecting_input() {
    let t = build_test_app_state().await;
    let state = t.state();
    let info = save_cli_provider_config_impl(state, "new".into(), mk_cfg("new-bin"))
        .await
        .unwrap();
    assert_eq!(info.key, "new");
    assert_eq!(info.binary, "new-bin");
    assert!(info.enabled);
    assert_eq!(info.auth_status, "unknown");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn save_cli_provider_config_writes_config_file() {
    let t = build_test_app_state().await;
    let state = t.state();
    save_cli_provider_config_impl(state, "persist".into(), mk_cfg("persist-bin"))
        .await
        .unwrap();

    let cfg_path = state.working_dir.join("config.json");
    assert!(cfg_path.exists(), "config.json should exist after save");
    let raw = std::fs::read_to_string(&cfg_path).expect("readable config.json");
    assert!(raw.contains("persist-bin"), "serialized config should contain binary");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn save_cli_provider_config_overwrites_previous_value() {
    let t = build_test_app_state().await;
    let state = t.state();
    save_cli_provider_config_impl(state, "k".into(), mk_cfg("first")).await.unwrap();
    save_cli_provider_config_impl(state, "k".into(), mk_cfg("second")).await.unwrap();

    let providers = list_cli_providers_impl(state).await.unwrap();
    assert_eq!(providers.len(), 1);
    assert_eq!(providers[0].binary, "second");
}

// === check_cli_provider ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn check_cli_provider_returns_existing_entry() {
    let t = build_test_app_state().await;
    let state = t.state();
    save_cli_provider_config_impl(state, "target".into(), mk_cfg("target-bin"))
        .await
        .unwrap();

    let info = check_cli_provider_impl(state, "target".into()).await.unwrap();
    assert_eq!(info.key, "target");
    assert_eq!(info.binary, "target-bin");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn check_cli_provider_errors_on_unknown_key() {
    let t = build_test_app_state().await;
    let err = check_cli_provider_impl(t.state(), "nope".into()).await.unwrap_err();
    assert!(err.contains("not found"), "expected 'not found' error, got: {}", err);
}

// === delete_cli_provider ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn delete_cli_provider_removes_existing_entry() {
    let t = build_test_app_state().await;
    let state = t.state();
    save_cli_provider_config_impl(state, "rm".into(), mk_cfg("rm-bin"))
        .await
        .unwrap();

    delete_cli_provider_impl(state, "rm".into()).await.unwrap();

    let providers = list_cli_providers_impl(state).await.unwrap();
    assert!(providers.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn delete_cli_provider_errors_on_unknown_key() {
    let t = build_test_app_state().await;
    let err = delete_cli_provider_impl(t.state(), "ghost".into()).await.unwrap_err();
    assert!(err.contains("not found"), "expected 'not found' error, got: {}", err);
}
