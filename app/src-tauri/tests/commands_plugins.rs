mod common;

#[allow(unused_imports)]
use common::*;
use app_lib::commands::plugins::*;
use serial_test::serial;

// NOTE: `build_test_app_state()` initializes `PluginRegistry::load(plugins_dir)`
// against an empty tempdir, so the registry starts with zero plugins. To test
// enable/disable flows we seed a tiny valid `plugin.json` fixture + reload.

fn write_plugin_fixture(plugins_dir: &std::path::Path, id: &str) {
    let plugin_dir = plugins_dir.join(id);
    std::fs::create_dir_all(&plugin_dir).unwrap();
    let manifest = format!(
        r#"{{
  "name": "{id}",
  "version": "0.1.0",
  "description": "test plugin {id}",
  "defaultEnabled": true,
  "tools": []
}}"#
    );
    std::fs::write(plugin_dir.join("plugin.json"), manifest).unwrap();
}

// === list_plugins ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_plugins_returns_empty_on_fresh_state() {
    let t = build_test_app_state().await;
    let plugins = list_plugins_impl(t.state()).await.unwrap();
    assert!(plugins.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_plugins_returns_loaded_plugins_after_reload() {
    let t = build_test_app_state().await;
    let state = t.state();
    let plugins_dir = state.working_dir.join("plugins");
    write_plugin_fixture(&plugins_dir, "demo-plugin");

    let count = reload_plugins_impl(state).await.unwrap();
    assert_eq!(count, 1);

    let plugins = list_plugins_impl(state).await.unwrap();
    assert_eq!(plugins.len(), 1);
    assert_eq!(plugins[0].id, "demo-plugin");
    assert_eq!(plugins[0].name, "demo-plugin");
    assert_eq!(plugins[0].version, "0.1.0");
    assert!(plugins[0].enabled); // defaultEnabled = true
    assert_eq!(plugins[0].tool_count, 0);
    assert!(!plugins[0].has_hooks);
}

// === enable_plugin ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn enable_plugin_flips_enabled_flag() {
    let t = build_test_app_state().await;
    let state = t.state();
    let plugins_dir = state.working_dir.join("plugins");
    write_plugin_fixture(&plugins_dir, "toggle-me");
    reload_plugins_impl(state).await.unwrap();

    // Start by disabling it — the default is enabled.
    disable_plugin_impl(state, "toggle-me".to_string()).await.unwrap();
    let plugins = list_plugins_impl(state).await.unwrap();
    assert!(!plugins.iter().find(|p| p.id == "toggle-me").unwrap().enabled);

    // Now re-enable.
    enable_plugin_impl(state, "toggle-me".to_string()).await.unwrap();
    let plugins = list_plugins_impl(state).await.unwrap();
    assert!(plugins.iter().find(|p| p.id == "toggle-me").unwrap().enabled);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn enable_plugin_on_unknown_id_is_noop() {
    let t = build_test_app_state().await;
    // Registry is empty; set_enabled on unknown id should silently succeed
    // (it just writes settings.json with no matching plugin).
    enable_plugin_impl(t.state(), "does-not-exist".to_string())
        .await
        .expect("enable on unknown id should return Ok");
    let plugins = list_plugins_impl(t.state()).await.unwrap();
    assert!(plugins.is_empty());
}

// === disable_plugin ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn disable_plugin_flips_enabled_flag_to_false() {
    let t = build_test_app_state().await;
    let state = t.state();
    let plugins_dir = state.working_dir.join("plugins");
    write_plugin_fixture(&plugins_dir, "disable-target");
    reload_plugins_impl(state).await.unwrap();

    // It starts enabled (defaultEnabled=true).
    let before = list_plugins_impl(state).await.unwrap();
    assert!(before.iter().find(|p| p.id == "disable-target").unwrap().enabled);

    disable_plugin_impl(state, "disable-target".to_string())
        .await
        .unwrap();

    let after = list_plugins_impl(state).await.unwrap();
    assert!(!after.iter().find(|p| p.id == "disable-target").unwrap().enabled);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn disable_plugin_on_unknown_id_is_noop() {
    let t = build_test_app_state().await;
    disable_plugin_impl(t.state(), "nothing-here".to_string())
        .await
        .expect("disable on unknown id should return Ok");
}

// === reload_plugins ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn reload_plugins_returns_zero_on_empty_dir() {
    let t = build_test_app_state().await;
    let count = reload_plugins_impl(t.state()).await.unwrap();
    assert_eq!(count, 0);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn reload_plugins_counts_plugins_in_dir() {
    let t = build_test_app_state().await;
    let state = t.state();
    let plugins_dir = state.working_dir.join("plugins");
    write_plugin_fixture(&plugins_dir, "alpha");
    write_plugin_fixture(&plugins_dir, "beta");

    let count = reload_plugins_impl(state).await.unwrap();
    assert_eq!(count, 2);

    let plugins = list_plugins_impl(state).await.unwrap();
    let ids: Vec<&str> = plugins.iter().map(|p| p.id.as_str()).collect();
    assert!(ids.contains(&"alpha"));
    assert!(ids.contains(&"beta"));
}
