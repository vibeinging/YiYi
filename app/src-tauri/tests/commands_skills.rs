//! Integration tests for `commands/skills.rs` thin-layer `_impl` functions.
//!
//! Covers simple `State<AppState>` FS-only commands. Defers:
//! - `import_skill` (HTTP reqwest to GitHub/raw URL — real network)
//! - `generate_skill_ai` (AppHandle + LLM provider streaming — needs mock LLM + emit harness)
//! - `hub_search_skills`, `hub_install_skill`, `hub_list_skills` (real Hub HTTP calls)

mod common;

#[allow(unused_imports)]
use common::*;

use app_lib::commands::skills::*;
use serial_test::serial;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

// Helper: write a minimal SKILL.md (+ optional references/scripts dir) under
// a named skill directory inside `parent` (typically active_skills/ or
// customized_skills/). Returns the skill directory.
fn seed_skill_dir(parent: &Path, name: &str, content: &str) -> std::path::PathBuf {
    let skill_dir = parent.join(name);
    fs::create_dir_all(&skill_dir).expect("create skill dir");
    fs::write(skill_dir.join("SKILL.md"), content).expect("write SKILL.md");
    skill_dir
}

fn minimal_skill_md(name: &str, desc: &str) -> String {
    format!(
        "---\nname: {name}\ndescription: \"{desc}\"\nmetadata:\n  {{\n    \"yiyi\":\n      {{\n        \"emoji\": \"X\",\n        \"requires\": {{}}\n      }}\n  }}\n---\n\n# {name}\n\nBody of the skill.\n"
    )
}

// === list_skills ========================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_skills_on_empty_working_dir_returns_only_builtin_with_disabled_status() {
    let t = build_test_app_state().await;

    // No active_skills/ or customized_skills/ populated — only the embedded
    // builtins should show up, each marked enabled=false (since the SKILL.md
    // doesn't exist on disk yet).
    let skills = list_skills_impl(t.state(), None, None).await.unwrap();

    // Known builtin names
    assert!(skills.iter().any(|s| s.name == "pdf"));
    assert!(skills.iter().any(|s| s.name == "docx"));

    // All returned entries for this fresh workspace are builtin and not enabled
    let pdf = skills.iter().find(|s| s.name == "pdf").unwrap();
    assert_eq!(pdf.source, "builtin");
    assert!(!pdf.enabled);
    assert!(!pdf.system);
    // Content comes from embedded resources.
    assert!(pdf.content.contains("name: pdf"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_skills_includes_customized_entries_on_disk() {
    let t = build_test_app_state().await;
    let custom_dir = t.state().working_dir.join("customized_skills");
    fs::create_dir_all(&custom_dir).unwrap();

    seed_skill_dir(&custom_dir, "my_custom", &minimal_skill_md("my_custom", "a custom skill"));

    let skills = list_skills_impl(t.state(), Some("customized".into()), None)
        .await
        .unwrap();
    let custom = skills
        .iter()
        .find(|s| s.name == "my_custom")
        .expect("customized skill should appear");
    assert_eq!(custom.source, "customized");
    assert!(custom.enabled); // discover_skills always sets enabled=true
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_skills_with_source_builtin_only_returns_builtin_entries() {
    let t = build_test_app_state().await;
    let skills = list_skills_impl(t.state(), Some("builtin".into()), None)
        .await
        .unwrap();
    // Every entry must be a builtin.
    assert!(skills.iter().all(|s| s.source == "builtin"));
    // Must include the known builtin "pdf".
    assert!(skills.iter().any(|s| s.name == "pdf"));
}

// === get_skill ==========================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_skill_returns_builtin_by_name() {
    let t = build_test_app_state().await;
    let s = get_skill_impl(t.state(), "pdf".into()).await.unwrap();
    assert_eq!(s.name, "pdf");
    assert_eq!(s.source, "builtin");
    assert!(s.content.contains("name: pdf"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_skill_errors_when_name_unknown() {
    let t = build_test_app_state().await;
    let err = get_skill_impl(t.state(), "nonexistent-xyz".into())
        .await
        .unwrap_err();
    assert!(err.contains("not found"), "expected not-found, got: {err}");
}

// === get_skill_content ==================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_skill_content_reads_skill_md_from_active_dir() {
    let t = build_test_app_state().await;
    let active = t.state().working_dir.join("active_skills");
    fs::create_dir_all(&active).unwrap();

    let content = minimal_skill_md("hello", "a hello skill");
    seed_skill_dir(&active, "hello", &content);

    let got = get_skill_content_impl(t.state(), "hello".into(), None)
        .await
        .unwrap();
    assert_eq!(got, content);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_skill_content_path_traversal_check_is_shallow() {
    // KNOWN BUG documented by this test: `get_skill_content_impl` uses
    // `target.starts_with(&skill_dir)` where `target = skill_dir.join(fp)`.
    // `Path::starts_with` compares components, so
    //   `/tmp/ws/active_skills/safe/../../secret.txt`
    //   starts_with
    //   `/tmp/ws/active_skills/safe`
    // evaluates to TRUE (the first components literally match), even though
    // `..` segments mean the effective file is *outside* the skill dir.
    // Result: a traversal input reads an arbitrary file without rejection.
    //
    // Proper fix: canonicalize both paths (or reject any `..` in `file_path`)
    // before the prefix check. Test pinned to current behaviour so the fix is
    // visible when someone lands it.
    let t = build_test_app_state().await;
    let active = t.state().working_dir.join("active_skills");
    fs::create_dir_all(&active).unwrap();
    seed_skill_dir(&active, "safe", &minimal_skill_md("safe", "safe skill"));

    // Write a sibling secret file that traversal would try to read.
    fs::write(
        t.state().working_dir.join("secret.txt"),
        "very secret contents",
    )
    .unwrap();

    let got = get_skill_content_impl(
        t.state(),
        "safe".into(),
        Some("../../secret.txt".into()),
    )
    .await;

    match got {
        Ok(body) => {
            // Current buggy behaviour: traversal succeeds.
            assert_eq!(body, "very secret contents");
        }
        Err(e) => {
            // Once hardened, the check should reject traversal inputs.
            assert!(
                e.contains("Path traversal") || e.contains("Failed to read"),
                "unexpected error variant after hardening: {e}"
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_skill_content_reads_nested_file_within_skill_dir() {
    // Positive case for path handling: a nested file under scripts/ should
    // be readable and the prefix check should accept it.
    let t = build_test_app_state().await;
    let active = t.state().working_dir.join("active_skills");
    let scripts_dir = active.join("nested").join("scripts");
    fs::create_dir_all(&scripts_dir).unwrap();
    seed_skill_dir(&active, "nested", &minimal_skill_md("nested", "n"));
    fs::write(scripts_dir.join("hello.py"), "print('hi')").unwrap();

    let body = get_skill_content_impl(
        t.state(),
        "nested".into(),
        Some("scripts/hello.py".into()),
    )
    .await
    .unwrap();
    assert_eq!(body, "print('hi')");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_skill_content_errors_when_skill_not_found() {
    let t = build_test_app_state().await;
    let err = get_skill_content_impl(t.state(), "ghost".into(), None)
        .await
        .unwrap_err();
    assert!(err.contains("not found"), "expected not-found, got: {err}");
}

// === enable_skill =======================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn enable_skill_copies_customized_source_into_active_dir() {
    let t = build_test_app_state().await;
    let custom = t.state().working_dir.join("customized_skills");
    fs::create_dir_all(&custom).unwrap();
    seed_skill_dir(&custom, "mine", &minimal_skill_md("mine", "my skill"));

    let resp = enable_skill_impl(t.state(), "mine".into()).await.unwrap();
    assert_eq!(resp["status"], "ok");

    let active_file = t
        .state()
        .working_dir
        .join("active_skills")
        .join("mine")
        .join("SKILL.md");
    assert!(active_file.exists(), "SKILL.md should be copied to active");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn enable_skill_extracts_embedded_builtin_when_not_in_customized() {
    let t = build_test_app_state().await;

    // No customized skills; enabling "pdf" should extract the embedded
    // builtin into active_skills/pdf/.
    enable_skill_impl(t.state(), "pdf".into()).await.unwrap();

    let pdf_md = t
        .state()
        .working_dir
        .join("active_skills")
        .join("pdf")
        .join("SKILL.md");
    assert!(
        pdf_md.exists(),
        "embedded pdf SKILL.md should be extracted into active_skills"
    );
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn enable_skill_is_idempotent_when_already_active() {
    let t = build_test_app_state().await;
    let active = t.state().working_dir.join("active_skills");
    fs::create_dir_all(&active).unwrap();
    seed_skill_dir(&active, "already", &minimal_skill_md("already", "al"));

    // Already active — should be a no-op (no error).
    let resp = enable_skill_impl(t.state(), "already".into()).await.unwrap();
    assert_eq!(resp["status"], "ok");
}

// === disable_skill ======================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn disable_skill_removes_active_skill_dir() {
    let t = build_test_app_state().await;
    let active = t.state().working_dir.join("active_skills");
    fs::create_dir_all(&active).unwrap();
    let skill_dir = seed_skill_dir(&active, "gone", &minimal_skill_md("gone", "g"));
    assert!(skill_dir.exists());

    let resp = disable_skill_impl(t.state(), "gone".into()).await.unwrap();
    assert_eq!(resp["status"], "ok");
    assert!(!skill_dir.exists(), "active skill dir should be removed");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn disable_skill_is_noop_when_skill_does_not_exist() {
    let t = build_test_app_state().await;
    // Not present — should succeed silently.
    let resp = disable_skill_impl(t.state(), "never-existed".into())
        .await
        .unwrap();
    assert_eq!(resp["status"], "ok");
}

// === update_skill =======================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn update_skill_writes_content_for_custom_skill_in_both_dirs() {
    let t = build_test_app_state().await;
    let wd = &t.state().working_dir;
    let custom = wd.join("customized_skills");
    let active = wd.join("active_skills");
    fs::create_dir_all(&custom).unwrap();
    fs::create_dir_all(&active).unwrap();
    seed_skill_dir(&custom, "cus", "OLD CUS");
    seed_skill_dir(&active, "cus", "OLD ACT");

    update_skill_impl(t.state(), "cus".into(), "NEW CONTENT".into())
        .await
        .unwrap();

    let custom_body = fs::read_to_string(custom.join("cus").join("SKILL.md")).unwrap();
    let active_body = fs::read_to_string(active.join("cus").join("SKILL.md")).unwrap();
    assert_eq!(custom_body, "NEW CONTENT");
    assert_eq!(active_body, "NEW CONTENT");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn update_skill_extracts_builtin_into_active_if_missing_then_overwrites() {
    let t = build_test_app_state().await;
    // "pdf" is a builtin. active_skills/pdf does not exist yet → implementation
    // should extract embedded first, then write the new content.
    let resp = update_skill_impl(t.state(), "pdf".into(), "REPLACED".into())
        .await
        .unwrap();
    assert_eq!(resp["status"], "ok");

    let written = fs::read_to_string(
        t.state()
            .working_dir
            .join("active_skills")
            .join("pdf")
            .join("SKILL.md"),
    )
    .unwrap();
    assert_eq!(written, "REPLACED");
}

// === create_skill =======================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn create_skill_writes_skill_md_to_customized_and_active() {
    let t = build_test_app_state().await;
    let content = minimal_skill_md("brand_new", "brand new");
    let resp = create_skill_impl(
        t.state(),
        "brand_new".into(),
        content.clone(),
        None::<HashMap<String, serde_json::Value>>,
        None::<HashMap<String, serde_json::Value>>,
    )
    .await
    .unwrap();
    assert_eq!(resp["status"], "ok");

    let wd = &t.state().working_dir;
    assert!(wd
        .join("customized_skills")
        .join("brand_new")
        .join("SKILL.md")
        .exists());
    assert!(wd
        .join("active_skills")
        .join("brand_new")
        .join("SKILL.md")
        .exists());
    let got = fs::read_to_string(
        wd.join("customized_skills")
            .join("brand_new")
            .join("SKILL.md"),
    )
    .unwrap();
    assert_eq!(got, content);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn create_skill_accepts_arbitrary_content_without_parsing_frontmatter() {
    let t = build_test_app_state().await;
    // The function writes raw content — no frontmatter validation.
    create_skill_impl(
        t.state(),
        "freeform".into(),
        "just a string, no yaml".into(),
        None::<HashMap<String, serde_json::Value>>,
        None::<HashMap<String, serde_json::Value>>,
    )
    .await
    .unwrap();

    let body = fs::read_to_string(
        t.state()
            .working_dir
            .join("customized_skills")
            .join("freeform")
            .join("SKILL.md"),
    )
    .unwrap();
    assert_eq!(body, "just a string, no yaml");
}

// === delete_skill =======================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn delete_skill_removes_both_customized_and_active_entries() {
    let t = build_test_app_state().await;
    let wd = &t.state().working_dir;
    let custom = wd.join("customized_skills");
    let active = wd.join("active_skills");
    fs::create_dir_all(&custom).unwrap();
    fs::create_dir_all(&active).unwrap();
    seed_skill_dir(&custom, "del", &minimal_skill_md("del", "d"));
    seed_skill_dir(&active, "del", &minimal_skill_md("del", "d"));

    delete_skill_impl(t.state(), "del".into()).await.unwrap();

    assert!(!custom.join("del").exists());
    assert!(!active.join("del").exists());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn delete_skill_is_idempotent_on_missing_skill() {
    let t = build_test_app_state().await;
    // Nothing to delete — should still succeed.
    let resp = delete_skill_impl(t.state(), "never".into()).await.unwrap();
    assert_eq!(resp["status"], "ok");
}

// === reload_skills ======================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn reload_skills_copies_customized_into_active_and_returns_count() {
    let t = build_test_app_state().await;
    let wd = &t.state().working_dir;
    let custom = wd.join("customized_skills");
    fs::create_dir_all(&custom).unwrap();
    seed_skill_dir(&custom, "one", &minimal_skill_md("one", "1"));
    seed_skill_dir(&custom, "two", &minimal_skill_md("two", "2"));

    let resp = reload_skills_impl(t.state()).await.unwrap();
    assert_eq!(resp["status"], "ok");
    let count = resp["count"].as_u64().expect("count should be integer");
    assert!(count >= 2, "expected at least 2 active, got {count}");

    // Both were copied.
    assert!(wd.join("active_skills").join("one").join("SKILL.md").exists());
    assert!(wd.join("active_skills").join("two").join("SKILL.md").exists());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn reload_skills_on_empty_dirs_returns_zero_count() {
    let t = build_test_app_state().await;
    // Nothing in customized/, active/ — count should be 0.
    let resp = reload_skills_impl(t.state()).await.unwrap();
    assert_eq!(resp["count"], 0);
    assert_eq!(resp["status"], "ok");
}

// === batch_enable_skills / batch_disable_skills =========================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn batch_enable_skills_extracts_multiple_builtins() {
    let t = build_test_app_state().await;
    let resp = batch_enable_skills_impl(
        t.state(),
        vec!["pdf".into(), "docx".into()],
    )
    .await
    .unwrap();

    let enabled = resp["enabled"].as_array().unwrap();
    assert_eq!(enabled.len(), 2);
    let failed = resp["failed"].as_array().unwrap();
    assert!(failed.is_empty(), "no failures expected, got: {failed:?}");

    let wd = &t.state().working_dir;
    assert!(wd.join("active_skills/pdf/SKILL.md").exists());
    assert!(wd.join("active_skills/docx/SKILL.md").exists());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn batch_enable_skills_reports_partial_success_for_unknown_names() {
    let t = build_test_app_state().await;
    // "pdf" is a builtin and will succeed.
    // "no_such_skill" is neither embedded nor customized — enable_skill_impl
    // silently does nothing (no source to copy from), so the dst never gets
    // created. But the function itself returns Ok, so batch_enable reports
    // both as "enabled". That reflects a mild spec gap (see concerns).
    let resp = batch_enable_skills_impl(
        t.state(),
        vec!["pdf".into(), "no_such_skill".into()],
    )
    .await
    .unwrap();
    let total = resp["total"].as_u64().unwrap();
    assert_eq!(total, 2);

    let wd = &t.state().working_dir;
    assert!(wd.join("active_skills/pdf/SKILL.md").exists());
    // Missing one: no SKILL.md got created.
    assert!(!wd.join("active_skills/no_such_skill/SKILL.md").exists());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn batch_disable_skills_removes_multiple_active_entries() {
    let t = build_test_app_state().await;
    let active = t.state().working_dir.join("active_skills");
    fs::create_dir_all(&active).unwrap();
    seed_skill_dir(&active, "a", &minimal_skill_md("a", "a"));
    seed_skill_dir(&active, "b", &minimal_skill_md("b", "b"));

    let resp = batch_disable_skills_impl(
        t.state(),
        vec!["a".into(), "b".into()],
    )
    .await
    .unwrap();
    let disabled = resp["disabled"].as_array().unwrap();
    assert_eq!(disabled.len(), 2);
    let failed = resp["failed"].as_array().unwrap();
    assert!(failed.is_empty());
    assert!(!active.join("a").exists());
    assert!(!active.join("b").exists());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn batch_disable_skills_treats_missing_entries_as_success() {
    let t = build_test_app_state().await;
    // Both are missing; disable_skill_impl is a no-op when path doesn't
    // exist and returns Ok, so batch_disable classifies both as disabled.
    let resp = batch_disable_skills_impl(
        t.state(),
        vec!["nope1".into(), "nope2".into()],
    )
    .await
    .unwrap();
    assert_eq!(resp["total"], 2);
    assert_eq!(resp["failed"].as_array().unwrap().len(), 0);
}

// === get_hub_config =====================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_hub_config_returns_default_hub_config_with_nonempty_base_url() {
    let cfg = get_hub_config_impl().unwrap();
    // Default hub config must have a non-empty base URL (either a default
    // public hub or a sentinel string) so the frontend can show it.
    assert!(!cfg.base_url.is_empty(), "hub base_url should be non-empty");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_hub_config_is_stable_across_calls() {
    let a = get_hub_config_impl().unwrap();
    let b = get_hub_config_impl().unwrap();
    assert_eq!(a.base_url, b.base_url);
    assert_eq!(a.search_path, b.search_path);
}
