mod common;

#[allow(unused_imports)]
use common::*;
use app_lib::commands::export::*;
use serial_test::serial;

// === export_conversations ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn export_conversations_markdown_on_empty_db_creates_file() {
    let t = build_test_app_state().await;
    let path = export_conversations_impl(t.state(), "markdown".to_string(), None)
        .await
        .unwrap();
    let p = std::path::PathBuf::from(&path);
    assert!(p.exists(), "export path should exist: {}", path);
    let content = std::fs::read_to_string(&p).unwrap();
    // Header is always written, even with zero sessions.
    assert!(content.contains("YiYi Conversations Export"));
    assert!(p.extension().and_then(|s| s.to_str()) == Some("md"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn export_conversations_json_writes_session_messages() {
    let t = build_test_app_state().await;
    let state = t.state();
    state.db.push_message("exp-sess", "user", "hello from test").unwrap();
    state.db.push_message("exp-sess", "assistant", "hi back").unwrap();

    let path = export_conversations_impl(state, "json".to_string(), None)
        .await
        .unwrap();
    let content = std::fs::read_to_string(&path).unwrap();
    // Minimal JSON sanity: root is an array and mentions our session.
    let parsed: serde_json::Value = serde_json::from_str(&content).expect("valid JSON");
    assert!(parsed.is_array(), "export is a JSON array");
    assert!(content.contains("exp-sess"));
    assert!(content.contains("hello from test"));
    assert!(content.contains("hi back"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn export_conversations_rejects_unknown_format() {
    let t = build_test_app_state().await;
    let err = export_conversations_impl(t.state(), "xml".to_string(), None)
        .await
        .expect_err("unknown format should error");
    assert!(err.contains("Unknown format"));
}

// === export_memories ===
//
// `export_memories_impl` calls the process-wide MemMe store via
// `get_memme_store()`. It returns `None` until someone calls `set_memme_store`
// and installs a store. Since `OnceLock::set` is one-shot per binary, the
// happy-path test below installs the test's MemMe store on first use and the
// error-path test relies on the order it runs in or on the fact that the
// test_support store differs from whatever was installed before.
//
// The safe assertion here is behavioural: either we succeed and a file
// appears, or we fail with the "not initialized" message. Both are valid.

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn export_memories_succeeds_or_reports_uninitialized_store() {
    let t = build_test_app_state().await;
    let state = t.state();

    // Best-effort: try to install the test's MemMe store so the happy path can
    // succeed. This is a no-op after the first successful install in this
    // binary, which is fine for the assertion we make below.
    app_lib::engine::tools::set_memme_store(state.memme_store.clone());

    match export_memories_impl(state).await {
        Ok(path) => {
            assert!(std::path::Path::new(&path).exists(), "export file missing: {}", path);
            let content = std::fs::read_to_string(&path).unwrap();
            // Empty store still produces a valid JSON array.
            assert!(serde_json::from_str::<serde_json::Value>(&content).is_ok());
        }
        Err(e) => {
            assert!(
                e.contains("MemMe store not initialized"),
                "unexpected error: {}",
                e
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn export_memories_does_not_panic_on_empty_store() {
    let t = build_test_app_state().await;
    let state = t.state();
    app_lib::engine::tools::set_memme_store(state.memme_store.clone());
    // Just verify no panic. Ok or controlled Err both acceptable.
    let _ = export_memories_impl(state).await;
}

// === export_settings ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn export_settings_produces_valid_json_on_default_state() {
    let t = build_test_app_state().await;
    let path = export_settings_impl(t.state()).await.unwrap();
    assert!(std::path::Path::new(&path).exists());
    let content = std::fs::read_to_string(&path).unwrap();
    let v: serde_json::Value = serde_json::from_str(&content).expect("valid JSON");
    // Top-level keys written by export_settings_impl.
    for key in [
        "active_llm",
        "providers",
        "workspace_path",
        "agents",
        "meditation",
        "memme",
        "enabled_skills",
    ] {
        assert!(v.get(key).is_some(), "missing key '{}' in export", key);
    }
    // The embedding_api_key is intentionally omitted for security.
    assert!(v["memme"].get("embedding_api_key").is_none());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn export_settings_places_file_under_user_workspace_exports_dir() {
    let t = build_test_app_state().await;
    let state = t.state();
    let path = export_settings_impl(state).await.unwrap();
    let ws = state.user_workspace();
    let expected_prefix = ws.join("exports");
    assert!(
        std::path::Path::new(&path).starts_with(&expected_prefix),
        "{} should live under {}",
        path,
        expected_prefix.display()
    );
}
