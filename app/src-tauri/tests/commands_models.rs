mod common;

#[allow(unused_imports)]
use common::*;
use app_lib::commands::models::*;
use serial_test::serial;

// V4-only build: DeepSeek is the sole built-in provider (models deepseek-v4-pro / -flash).
// The multi-provider feature (custom providers, provider plugins, templates, add/remove
// model, import/export, scan) was removed in commit 820bb56 "DeepSeek V4-only build".
// Tests for those removed commands were dropped along with it; only the commands that
// survive the V4-only pivot are covered here.

// === list_providers ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_providers_returns_all_builtin_providers() {
    let t = build_test_app_state().await;
    let providers = list_providers_impl(t.state()).await.unwrap();
    // V4-only build: DeepSeek is the sole built-in provider.
    assert!(providers.iter().any(|p| p.id == "deepseek"));
    // Fresh state: nothing configured.
    assert!(providers.iter().all(|p| !p.configured));
}

// === configure_provider ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn configure_provider_saves_api_key_and_base_url_for_builtin() {
    let t = build_test_app_state().await;
    let state = t.state();

    let info = configure_provider_impl(
        state,
        "deepseek".to_string(),
        Some("sk-test-123".to_string()),
        Some("https://proxy.example.com/v1".to_string()),
    )
    .await
    .unwrap();

    assert_eq!(info.id, "deepseek");
    assert!(info.configured);
    assert_eq!(info.base_url.as_deref(), Some("https://proxy.example.com/v1"));
    assert_eq!(info.api_key_saved.as_deref(), Some("sk-test-123"));
}

// === test_provider ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn test_provider_without_configured_key_and_no_model_returns_failure() {
    let t = build_test_app_state().await;
    let state = t.state();

    // Unreachable base_url on 127.0.0.1:1; no model selected (first built-in is picked).
    let resp = test_provider_impl(
        state,
        "deepseek".to_string(),
        Some("fake-key".to_string()),
        Some("http://127.0.0.1:1/bogus".to_string()),
        None,
    )
    .await
    .unwrap();

    // Whether the connection fails fast or slow, the response must not be success.
    assert!(!resp.success, "expected failure against 127.0.0.1:1, got {:?}", resp.message);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn test_provider_with_invalid_host_returns_connection_failed() {
    let t = build_test_app_state().await;
    let state = t.state();

    // Explicit unreachable base URL and an explicit model.
    let resp = test_provider_impl(
        state,
        "deepseek".to_string(),
        Some("fake-key".to_string()),
        Some("http://127.0.0.1:1".to_string()),
        Some("deepseek-v4-pro".to_string()),
    )
    .await
    .unwrap();

    assert!(!resp.success);
    // No assistant reply is produced on a connection failure.
    assert!(
        resp.reply.is_none(),
        "no reply expected on failure, got {:?}",
        resp.reply
    );
}

// === test_model ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn test_model_without_configured_key_returns_no_api_key_error() {
    let t = build_test_app_state().await;
    let state = t.state();

    // No saved key and no DEEPSEEK_API_KEY env var → "No API key configured".
    std::env::remove_var("DEEPSEEK_API_KEY");

    let result = test_model_impl(
        state,
        "deepseek".to_string(),
        "deepseek-v4-pro".to_string(),
    )
    .await;
    match result {
        Err(e) => assert!(
            e.contains("No API key"),
            "expected 'No API key' error, got: {e}"
        ),
        Ok(_) => panic!("expected 'No API key' error, got Ok"),
    }
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn test_model_with_unknown_provider_returns_not_found_error() {
    let t = build_test_app_state().await;
    let state = t.state();

    let result = test_model_impl(
        state,
        "ghost-provider".to_string(),
        "some-model".to_string(),
    )
    .await;
    match result {
        Err(e) => assert!(
            e.contains("not found"),
            "expected not-found error, got: {e}"
        ),
        Ok(_) => panic!("expected error for unknown provider, got Ok"),
    }
}

// === get_active_llm / set_active_llm ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_active_llm_returns_none_when_nothing_set() {
    let t = build_test_app_state().await;
    let info = get_active_llm_impl(t.state()).await.unwrap();
    assert!(info.provider_id.is_none());
    assert!(info.model.is_none());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn set_active_llm_persists_and_is_readable() {
    let t = build_test_app_state().await;
    let state = t.state();

    let after_set = set_active_llm_impl(
        state,
        "deepseek".to_string(),
        "deepseek-v4-pro".to_string(),
    )
    .await
    .unwrap();
    assert_eq!(after_set.provider_id.as_deref(), Some("deepseek"));
    assert_eq!(after_set.model.as_deref(), Some("deepseek-v4-pro"));

    let read_back = get_active_llm_impl(state).await.unwrap();
    assert_eq!(read_back.provider_id.as_deref(), Some("deepseek"));
    assert_eq!(read_back.model.as_deref(), Some("deepseek-v4-pro"));

    // Round-trip via DB reload.
    let reloaded =
        app_lib::state::providers::ProvidersState::load(state.db.clone());
    let slot = reloaded.active_llm.expect("active_llm should be persisted");
    assert_eq!(slot.provider_id, "deepseek");
    assert_eq!(slot.model, "deepseek-v4-pro");
}
