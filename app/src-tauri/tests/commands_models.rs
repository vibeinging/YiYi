mod common;

#[allow(unused_imports)]
use common::*;
use app_lib::commands::models::*;
use app_lib::state::providers::{ModelInfo, ProviderPlugin};
use serial_test::serial;

// === list_providers ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_providers_returns_all_builtin_providers() {
    let t = build_test_app_state().await;
    let providers = list_providers_impl(t.state()).await.unwrap();
    // Built-in providers include openai, anthropic, google, deepseek, etc.
    assert!(providers.iter().any(|p| p.id == "openai"));
    assert!(providers.iter().any(|p| p.id == "anthropic"));
    // Fresh state: nothing configured.
    assert!(providers.iter().all(|p| !p.configured));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_providers_includes_custom_providers_after_create() {
    let t = build_test_app_state().await;
    let state = t.state();

    create_custom_provider_impl(
        state,
        "my-custom".to_string(),
        "My Custom".to_string(),
        "https://example.com/v1".to_string(),
        "MY_KEY".to_string(),
        vec![ModelInfo {
            id: "custom-model".into(),
            name: "Custom Model".into(),
        }],
    )
    .await
    .unwrap();

    let providers = list_providers_impl(state).await.unwrap();
    let custom = providers
        .iter()
        .find(|p| p.id == "my-custom")
        .expect("custom provider should be listed");
    assert!(custom.is_custom);
    assert_eq!(custom.name, "My Custom");
    assert_eq!(custom.models.len(), 1);
}

// === configure_provider ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn configure_provider_saves_api_key_and_base_url_for_builtin() {
    let t = build_test_app_state().await;
    let state = t.state();

    let info = configure_provider_impl(
        state,
        "openai".to_string(),
        Some("sk-test-123".to_string()),
        Some("https://proxy.example.com/v1".to_string()),
    )
    .await
    .unwrap();

    assert_eq!(info.id, "openai");
    assert!(info.configured);
    assert_eq!(info.base_url.as_deref(), Some("https://proxy.example.com/v1"));
    assert_eq!(info.api_key_saved.as_deref(), Some("sk-test-123"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn configure_provider_updates_custom_provider_settings() {
    let t = build_test_app_state().await;
    let state = t.state();

    create_custom_provider_impl(
        state,
        "cfg-custom".to_string(),
        "CfgCustom".to_string(),
        "https://cfg.example.com".to_string(),
        "CFG_KEY".to_string(),
        vec![],
    )
    .await
    .unwrap();

    let info = configure_provider_impl(
        state,
        "cfg-custom".to_string(),
        Some("custom-key".to_string()),
        None,
    )
    .await
    .unwrap();

    assert!(info.is_custom);
    assert!(info.configured);
    assert_eq!(info.api_key_saved.as_deref(), Some("custom-key"));
}

// === test_provider ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn test_provider_without_configured_key_and_no_model_returns_failure() {
    let t = build_test_app_state().await;
    let state = t.state();

    // Use a bogus base_url on an invalid TLD that should fail DNS fast.
    // No model specified → falls back to /models endpoint check.
    let resp = test_provider_impl(
        state,
        "openai".to_string(),
        Some("fake-key".to_string()),
        Some("http://127.0.0.1:1/bogus".to_string()),
        // Deliberately pass an empty model selection; the provider has
        // built-in models so first one is picked.
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

    // Provide an explicit unreachable base URL and an explicit model.
    let resp = test_provider_impl(
        state,
        "openai".to_string(),
        Some("fake-key".to_string()),
        Some("http://127.0.0.1:1".to_string()),
        Some("gpt-4.1".to_string()),
    )
    .await
    .unwrap();

    assert!(!resp.success);
    // Either "Connection failed:" (reqwest error) or HTTP failure path.
    assert!(
        resp.reply.is_none(),
        "no reply expected on failure, got {:?}",
        resp.reply
    );
}

// === create_custom_provider ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn create_custom_provider_persists_definition() {
    let t = build_test_app_state().await;
    let state = t.state();

    let info = create_custom_provider_impl(
        state,
        "persist-custom".to_string(),
        "Persisted".to_string(),
        "https://persist.example/v1".to_string(),
        "PERSIST_KEY".to_string(),
        vec![ModelInfo {
            id: "pmodel".into(),
            name: "P Model".into(),
        }],
    )
    .await
    .unwrap();

    assert!(info.is_custom);
    assert_eq!(info.default_base_url, "https://persist.example/v1");
    assert_eq!(info.models.len(), 1);

    // Round-trip: reload providers state from DB and assert presence.
    let reloaded =
        app_lib::state::providers::ProvidersState::load(state.db.clone());
    assert!(reloaded.custom_providers.contains_key("persist-custom"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn create_custom_provider_allows_empty_model_list() {
    let t = build_test_app_state().await;
    let state = t.state();

    let info = create_custom_provider_impl(
        state,
        "no-models".to_string(),
        "NoModels".to_string(),
        "https://x".to_string(),
        "NM_KEY".to_string(),
        vec![],
    )
    .await
    .unwrap();

    assert!(info.is_custom);
    assert!(info.models.is_empty());
}

// === delete_custom_provider ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn delete_custom_provider_removes_from_state_and_db() {
    let t = build_test_app_state().await;
    let state = t.state();

    create_custom_provider_impl(
        state,
        "to-delete".to_string(),
        "ToDelete".to_string(),
        "https://x".to_string(),
        "TD_KEY".to_string(),
        vec![],
    )
    .await
    .unwrap();

    let after = delete_custom_provider_impl(state, "to-delete".to_string())
        .await
        .unwrap();
    assert!(after.iter().all(|p| p.id != "to-delete"));

    // Verify DB no longer has it.
    let reloaded =
        app_lib::state::providers::ProvidersState::load(state.db.clone());
    assert!(!reloaded.custom_providers.contains_key("to-delete"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn delete_custom_provider_on_unknown_id_is_idempotent() {
    let t = build_test_app_state().await;
    let state = t.state();

    // Deleting a non-existent custom provider should succeed (DELETE is idempotent).
    let after =
        delete_custom_provider_impl(state, "never-existed".to_string())
            .await
            .unwrap();
    // Built-ins are still present.
    assert!(after.iter().any(|p| p.id == "openai"));
}

// === add_model ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn add_model_appends_extra_model_to_builtin() {
    let t = build_test_app_state().await;
    let state = t.state();

    let info = add_model_impl(
        state,
        "openai".to_string(),
        "gpt-custom-1".to_string(),
        "Custom GPT".to_string(),
    )
    .await
    .unwrap();

    assert!(info.extra_models.iter().any(|m| m.id == "gpt-custom-1"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn add_model_appends_model_to_custom_provider_definition() {
    let t = build_test_app_state().await;
    let state = t.state();

    create_custom_provider_impl(
        state,
        "addmodel-custom".to_string(),
        "AddModelCustom".to_string(),
        "https://x".to_string(),
        "AM_KEY".to_string(),
        vec![],
    )
    .await
    .unwrap();

    let info = add_model_impl(
        state,
        "addmodel-custom".to_string(),
        "cm-1".to_string(),
        "Custom Model One".to_string(),
    )
    .await
    .unwrap();

    assert!(info.is_custom);
    assert!(info.models.iter().any(|m| m.id == "cm-1"));
}

// === remove_model ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn remove_model_deletes_extra_model_from_builtin() {
    let t = build_test_app_state().await;
    let state = t.state();

    add_model_impl(
        state,
        "openai".to_string(),
        "temporary-model".to_string(),
        "Temp".to_string(),
    )
    .await
    .unwrap();

    let info = remove_model_impl(
        state,
        "openai".to_string(),
        "temporary-model".to_string(),
    )
    .await
    .unwrap();

    assert!(info.extra_models.iter().all(|m| m.id != "temporary-model"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn remove_model_deletes_model_from_custom_provider() {
    let t = build_test_app_state().await;
    let state = t.state();

    create_custom_provider_impl(
        state,
        "rm-custom".to_string(),
        "RmCustom".to_string(),
        "https://x".to_string(),
        "RM_KEY".to_string(),
        vec![ModelInfo {
            id: "keep".into(),
            name: "Keep".into(),
        }, ModelInfo {
            id: "drop".into(),
            name: "Drop".into(),
        }],
    )
    .await
    .unwrap();

    let info = remove_model_impl(
        state,
        "rm-custom".to_string(),
        "drop".to_string(),
    )
    .await
    .unwrap();

    assert_eq!(info.models.len(), 1);
    assert_eq!(info.models[0].id, "keep");
}

// === test_model ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn test_model_without_configured_key_returns_no_api_key_error() {
    let t = build_test_app_state().await;
    let state = t.state();

    // Ensure no env var is set that would leak a key.
    // Provider 'openai' with no saved key and (presumably) no OPENAI_API_KEY
    // env var in the test environment should return an error.
    std::env::remove_var("OPENAI_API_KEY");

    let result = test_model_impl(
        state,
        "openai".to_string(),
        "gpt-4.1".to_string(),
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
        "openai".to_string(),
        "gpt-4.1".to_string(),
    )
    .await
    .unwrap();
    assert_eq!(after_set.provider_id.as_deref(), Some("openai"));
    assert_eq!(after_set.model.as_deref(), Some("gpt-4.1"));

    let read_back = get_active_llm_impl(state).await.unwrap();
    assert_eq!(read_back.provider_id.as_deref(), Some("openai"));
    assert_eq!(read_back.model.as_deref(), Some("gpt-4.1"));

    // Round-trip via DB reload
    let reloaded =
        app_lib::state::providers::ProvidersState::load(state.db.clone());
    let slot = reloaded.active_llm.expect("active_llm should be persisted");
    assert_eq!(slot.provider_id, "openai");
    assert_eq!(slot.model, "gpt-4.1");
}

// === list_provider_templates ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_provider_templates_returns_nonempty_builtin_list() {
    let templates = list_provider_templates_impl();
    assert!(!templates.is_empty());
    // OpenRouter is one of the known built-in templates.
    assert!(templates.iter().any(|t| t.id == "openrouter"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_provider_templates_entries_have_valid_plugin_definitions() {
    let templates = list_provider_templates_impl();
    for t in &templates {
        assert_eq!(t.id, t.plugin.id);
        assert!(!t.name.is_empty());
        assert!(!t.plugin.default_base_url.is_empty() || t.plugin.is_local);
    }
}

// === import_provider_plugin ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn import_provider_plugin_registers_as_custom() {
    let t = build_test_app_state().await;
    let state = t.state();

    let plugin = ProviderPlugin {
        id: "imp-plugin".into(),
        name: "Imported Plugin".into(),
        default_base_url: "https://imp.example.com/v1".into(),
        api_key_env: "IMP_KEY".into(),
        api_compat: "openai".into(),
        is_local: false,
        models: vec![ModelInfo {
            id: "imp-1".into(),
            name: "Imp One".into(),
        }],
        description: Some("imported".into()),
        native_tools: vec![],
    };

    let info = import_provider_plugin_impl(state, plugin).await.unwrap();
    assert_eq!(info.id, "imp-plugin");
    assert!(info.is_custom);
    assert_eq!(info.models.len(), 1);

    // The plugin file is written to working_dir/plugins/providers/.
    let plugin_file = state
        .working_dir
        .join("plugins")
        .join("providers")
        .join("imp-plugin.json");
    assert!(plugin_file.exists(), "plugin file should be written");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn import_provider_plugin_overwrites_existing_entry() {
    let t = build_test_app_state().await;
    let state = t.state();

    let plugin_v1 = ProviderPlugin {
        id: "twice".into(),
        name: "V1".into(),
        default_base_url: "https://v1".into(),
        api_key_env: "K".into(),
        api_compat: "openai".into(),
        is_local: false,
        models: vec![],
        description: None,
        native_tools: vec![],
    };
    import_provider_plugin_impl(state, plugin_v1).await.unwrap();

    let plugin_v2 = ProviderPlugin {
        id: "twice".into(),
        name: "V2".into(),
        default_base_url: "https://v2".into(),
        api_key_env: "K".into(),
        api_compat: "openai".into(),
        is_local: false,
        models: vec![],
        description: None,
        native_tools: vec![],
    };
    let info = import_provider_plugin_impl(state, plugin_v2).await.unwrap();
    assert_eq!(info.name, "V2");
    assert_eq!(info.default_base_url, "https://v2");
}

// === export_provider_config ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn export_provider_config_returns_builtin_definition() {
    let t = build_test_app_state().await;
    let state = t.state();

    let plugin = export_provider_config_impl(state, "openai".to_string())
        .await
        .unwrap();
    assert_eq!(plugin.id, "openai");
    assert_eq!(plugin.api_compat, "openai");
    assert!(!plugin.models.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn export_provider_config_returns_custom_provider() {
    let t = build_test_app_state().await;
    let state = t.state();

    create_custom_provider_impl(
        state,
        "exp-custom".to_string(),
        "ExpCustom".to_string(),
        "https://exp".to_string(),
        "EXP_KEY".to_string(),
        vec![ModelInfo {
            id: "m".into(),
            name: "M".into(),
        }],
    )
    .await
    .unwrap();

    let plugin = export_provider_config_impl(state, "exp-custom".to_string())
        .await
        .unwrap();
    assert_eq!(plugin.id, "exp-custom");
    assert_eq!(plugin.api_key_env, "EXP_KEY");
    assert_eq!(plugin.models.len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn export_provider_config_errors_on_unknown_id() {
    let t = build_test_app_state().await;
    let state = t.state();

    let err =
        export_provider_config_impl(state, "unknown-xyz".to_string())
            .await
            .unwrap_err();
    assert!(err.contains("not found"), "expected not-found, got: {err}");
}

// === scan_provider_plugins ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn scan_provider_plugins_on_empty_dir_is_noop() {
    let t = build_test_app_state().await;
    let state = t.state();

    // No plugin files present under working_dir/plugins/providers/.
    let providers = scan_provider_plugins_impl(state).await.unwrap();
    // Should only return built-ins (no custom plugins registered).
    assert!(providers.iter().all(|p| !p.is_custom));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn scan_provider_plugins_loads_plugin_written_to_disk() {
    let t = build_test_app_state().await;
    let state = t.state();

    // Write a plugin file directly, then ask scan to load it.
    let plugin = ProviderPlugin {
        id: "on-disk".into(),
        name: "OnDisk".into(),
        default_base_url: "https://disk.example".into(),
        api_key_env: "DISK_KEY".into(),
        api_compat: "openai".into(),
        is_local: false,
        models: vec![],
        description: None,
        native_tools: vec![],
    };
    app_lib::state::providers::save_plugin_file(&state.working_dir, &plugin)
        .expect("write plugin file");

    let providers = scan_provider_plugins_impl(state).await.unwrap();
    let loaded = providers
        .iter()
        .find(|p| p.id == "on-disk")
        .expect("plugin should be loaded from disk");
    assert!(loaded.is_custom);
    assert_eq!(loaded.name, "OnDisk");
}

// === import_provider_from_template ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn import_provider_from_template_registers_openrouter() {
    let t = build_test_app_state().await;
    let state = t.state();

    let info =
        import_provider_from_template_impl(state, "openrouter".to_string())
            .await
            .unwrap();
    assert_eq!(info.id, "openrouter");
    assert!(info.is_custom);
    assert!(!info.models.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn import_provider_from_template_errors_on_unknown_template_id() {
    let t = build_test_app_state().await;
    let state = t.state();

    let err = import_provider_from_template_impl(
        state,
        "nonexistent-template".to_string(),
    )
    .await
    .unwrap_err();
    assert!(err.contains("not found"), "expected not-found, got: {err}");
}
