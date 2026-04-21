mod common;

#[allow(unused_imports)]
use common::*;
use app_lib::commands::agents::*;
use serial_test::serial;

// Valid AGENT.md content with unique name for save/delete tests.
fn agent_md(name: &str) -> String {
    format!(
        r#"---
name: {name}
description: "test agent {name}"
metadata:
  yiyi:
    emoji: "🧪"
---

You are the {name} test agent.
"#
    )
}

// === list_agents ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_agents_returns_builtins_on_fresh_state() {
    let t = build_test_app_state().await;
    let agents = list_agents_impl(t.state()).await.unwrap();
    // AgentRegistry::load always embeds the 3 builtins (explore, planner,
    // desktop_operator). No resource_dir + empty custom dir = just builtins.
    assert!(agents.len() >= 3, "expected >=3 builtin agents, got {}", agents.len());
    let names: Vec<&str> = agents.iter().map(|a| a.name.as_str()).collect();
    assert!(names.contains(&"explore"));
    assert!(names.contains(&"planner"));
    assert!(names.contains(&"desktop_operator"));

    // Builtin check should be true for these.
    let explore = agents.iter().find(|a| a.name == "explore").unwrap();
    assert!(explore.is_builtin);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_agents_includes_custom_after_save() {
    let t = build_test_app_state().await;
    let state = t.state();

    save_agent_impl(state, agent_md("custom_one")).await.unwrap();
    let agents = list_agents_impl(state).await.unwrap();
    let names: Vec<&str> = agents.iter().map(|a| a.name.as_str()).collect();
    assert!(names.contains(&"custom_one"));
    let custom = agents.iter().find(|a| a.name == "custom_one").unwrap();
    assert!(!custom.is_builtin);
}

// === get_agent ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_agent_returns_builtin_by_name() {
    let t = build_test_app_state().await;
    let agent = get_agent_impl(t.state(), "explore".to_string())
        .await
        .unwrap()
        .expect("builtin explore agent should be present");
    assert_eq!(agent.name, "explore");
    // The instructions body is the markdown after the frontmatter.
    assert!(!agent.instructions.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_agent_returns_none_for_unknown_name() {
    let t = build_test_app_state().await;
    let result = get_agent_impl(t.state(), "no-such-agent".to_string())
        .await
        .unwrap();
    assert!(result.is_none());
}

// === save_agent ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn save_agent_writes_file_and_reloads_registry() {
    let t = build_test_app_state().await;
    let state = t.state();

    save_agent_impl(state, agent_md("persist_me")).await.unwrap();

    // File landed at <working_dir>/agents/persist_me/AGENT.md
    let agent_file = state.working_dir.join("agents").join("persist_me").join("AGENT.md");
    assert!(agent_file.exists(), "AGENT.md should be written to disk");

    // Registry picked it up.
    let loaded = get_agent_impl(state, "persist_me".to_string())
        .await
        .unwrap()
        .expect("saved agent should be loaded");
    assert_eq!(loaded.name, "persist_me");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn save_agent_rejects_invalid_frontmatter() {
    let t = build_test_app_state().await;
    let err = save_agent_impl(t.state(), "no frontmatter here, just text".to_string())
        .await
        .unwrap_err();
    assert!(
        err.contains("Invalid AGENT.md"),
        "expected invalid-format error, got: {err}"
    );
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn save_agent_rejects_path_traversal_name() {
    let t = build_test_app_state().await;
    // Name with path separator must be refused before any file write.
    let malicious = r#"---
name: "../escape"
description: "tries to escape"
---

evil body
"#
    .to_string();
    let err = save_agent_impl(t.state(), malicious).await.unwrap_err();
    assert!(err.contains("path separators"), "expected path-sep error, got: {err}");

    // Nothing should be created.
    let escaped_dir = t.state().working_dir.join("agents").join("../escape");
    assert!(!escaped_dir.exists());
}

// === delete_agent ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn delete_agent_removes_custom_agent_dir_and_reloads() {
    let t = build_test_app_state().await;
    let state = t.state();

    save_agent_impl(state, agent_md("to_delete")).await.unwrap();
    let agent_dir = state.working_dir.join("agents").join("to_delete");
    assert!(agent_dir.exists());

    delete_agent_impl(state, "to_delete".to_string()).await.unwrap();

    assert!(!agent_dir.exists(), "agent dir should be removed");
    let gone = get_agent_impl(state, "to_delete".to_string()).await.unwrap();
    assert!(gone.is_none());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn delete_agent_errors_on_nonexistent_agent() {
    let t = build_test_app_state().await;
    let err = delete_agent_impl(t.state(), "never_existed".to_string())
        .await
        .unwrap_err();
    assert!(err.contains("not found"), "expected not-found error, got: {err}");
}
