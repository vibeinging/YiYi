mod common;

#[allow(unused_imports)]
use common::*;
use app_lib::commands::mcp::*;
use serial_test::serial;

// All `*_mcp_client_impl` commands read/write shared config state and persist
// to `config.json` via `Config::save`. `#[serial]` keeps the file-system + lock
// access deterministic across concurrent tests.

fn mk_request(name: &str, command: Option<&str>) -> MCPClientCreateRequest {
    // Deserialize from JSON so we exercise the default-serde attrs and don't
    // depend on private struct fields.
    let mut json = serde_json::json!({
        "name": name,
        "description": format!("{} desc", name),
    });
    if let Some(cmd) = command {
        json["command"] = serde_json::Value::String(cmd.to_string());
    }
    serde_json::from_value(json).unwrap()
}

// === list_mcp_clients ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_mcp_clients_returns_empty_on_fresh_state() {
    let t = build_test_app_state().await;
    let clients = list_mcp_clients_impl(t.state()).await.unwrap();
    assert!(clients.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_mcp_clients_returns_saved_entries() {
    let t = build_test_app_state().await;
    let state = t.state();
    create_mcp_client_impl(state, "alpha".into(), mk_request("Alpha", Some("alpha-cmd")))
        .await
        .unwrap();
    create_mcp_client_impl(state, "beta".into(), mk_request("Beta", Some("beta-cmd")))
        .await
        .unwrap();

    let clients = list_mcp_clients_impl(state).await.unwrap();
    assert_eq!(clients.len(), 2);
    let keys: Vec<&str> = clients.iter().map(|c| c.key.as_str()).collect();
    assert!(keys.contains(&"alpha"));
    assert!(keys.contains(&"beta"));
}

// === get_mcp_client ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_mcp_client_returns_existing_entry() {
    let t = build_test_app_state().await;
    let state = t.state();
    create_mcp_client_impl(state, "target".into(), mk_request("Target", Some("target-cmd")))
        .await
        .unwrap();

    let info = get_mcp_client_impl(state, "target".into()).await.unwrap();
    assert_eq!(info.key, "target");
    assert_eq!(info.name, "Target");
    assert_eq!(info.command.as_deref(), Some("target-cmd"));
    assert_eq!(info.transport, "stdio"); // default inferred
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_mcp_client_errors_on_unknown_key() {
    let t = build_test_app_state().await;
    let err = get_mcp_client_impl(t.state(), "does-not-exist".into()).await.unwrap_err();
    assert!(err.contains("not found"), "expected 'not found' error, got: {}", err);
}

// === create_mcp_client ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn create_mcp_client_returns_info_reflecting_input() {
    let t = build_test_app_state().await;
    let state = t.state();
    let info = create_mcp_client_impl(
        state,
        "new-client".into(),
        mk_request("New Client", Some("./binary")),
    )
    .await
    .unwrap();
    assert_eq!(info.key, "new-client");
    assert_eq!(info.name, "New Client");
    assert_eq!(info.description, "New Client desc");
    assert!(info.enabled, "default_true should apply");
    assert_eq!(info.transport, "stdio"); // command but no url => stdio
    assert_eq!(info.status, "ready"); // enabled => "ready"
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn create_mcp_client_infers_streamable_http_transport_from_url() {
    let t = build_test_app_state().await;
    let state = t.state();
    let json = serde_json::json!({
        "name": "Remote",
        "url": "https://example.test/mcp",
    });
    let req: MCPClientCreateRequest = serde_json::from_value(json).unwrap();
    let info = create_mcp_client_impl(state, "remote".into(), req).await.unwrap();
    assert_eq!(info.transport, "streamable_http");
    assert_eq!(info.url.as_deref(), Some("https://example.test/mcp"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn create_mcp_client_persists_to_config_file() {
    let t = build_test_app_state().await;
    let state = t.state();
    create_mcp_client_impl(state, "persist-me".into(), mk_request("Persisted", Some("ls")))
        .await
        .unwrap();

    let cfg_path = state.working_dir.join("config.json");
    assert!(cfg_path.exists(), "config.json should be written");
    let raw = std::fs::read_to_string(&cfg_path).unwrap();
    assert!(raw.contains("persist-me"), "config should contain new key");
}

// === update_mcp_client ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn update_mcp_client_overwrites_existing() {
    let t = build_test_app_state().await;
    let state = t.state();
    create_mcp_client_impl(state, "upd".into(), mk_request("Before", Some("old"))).await.unwrap();

    let updated = update_mcp_client_impl(
        state,
        "upd".into(),
        mk_request("After", Some("new")),
    )
    .await
    .unwrap();
    assert_eq!(updated.name, "After");
    assert_eq!(updated.command.as_deref(), Some("new"));

    // Only one client total (update, not create).
    let clients = list_mcp_clients_impl(state).await.unwrap();
    assert_eq!(clients.len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn update_mcp_client_errors_on_unknown_key() {
    let t = build_test_app_state().await;
    let err = update_mcp_client_impl(
        t.state(),
        "missing".into(),
        mk_request("X", Some("y")),
    )
    .await
    .unwrap_err();
    assert!(err.contains("not found"), "expected 'not found' error, got: {}", err);
}

// === toggle_mcp_client ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn toggle_mcp_client_flips_enabled_flag() {
    let t = build_test_app_state().await;
    let state = t.state();
    create_mcp_client_impl(state, "tog".into(), mk_request("Tog", Some("x"))).await.unwrap();

    let info = get_mcp_client_impl(state, "tog".into()).await.unwrap();
    assert!(info.enabled);

    let after1 = toggle_mcp_client_impl(state, "tog".into()).await.unwrap();
    assert!(!after1.enabled);
    assert_eq!(after1.status, "disabled");

    let after2 = toggle_mcp_client_impl(state, "tog".into()).await.unwrap();
    assert!(after2.enabled);
    assert_eq!(after2.status, "ready");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn toggle_mcp_client_errors_on_unknown_key() {
    let t = build_test_app_state().await;
    let err = toggle_mcp_client_impl(t.state(), "nope".into()).await.unwrap_err();
    assert!(err.contains("not found"), "expected 'not found' error, got: {}", err);
}

// === delete_mcp_client ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn delete_mcp_client_removes_existing_entry() {
    let t = build_test_app_state().await;
    let state = t.state();
    create_mcp_client_impl(state, "rm-me".into(), mk_request("RM", Some("x"))).await.unwrap();

    let resp = delete_mcp_client_impl(state, "rm-me".into()).await.unwrap();
    assert!(resp["message"].as_str().unwrap().contains("rm-me"));

    let clients = list_mcp_clients_impl(state).await.unwrap();
    assert!(clients.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn delete_mcp_client_on_unknown_key_is_idempotent() {
    let t = build_test_app_state().await;
    // HashMap::remove on a missing key is a no-op — the impl treats delete as
    // idempotent-Ok regardless of presence.
    let resp = delete_mcp_client_impl(t.state(), "never-existed".into()).await.unwrap();
    assert!(resp["message"].as_str().unwrap().contains("never-existed"));
}
