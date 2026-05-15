//! End-to-end tests for the file-oriented tools.
//!
//! Each test stages a real tempdir, authorizes it via
//! `init_authorized_folders` / `refresh_authorized_folders` so
//! `access_check` short-circuits to Ok (no `APP_HANDLE` to satisfy a
//! permission-gate dialog), and exercises the tool fns through their
//! JSON input shape — the exact contract the LLM sees.
//!
//! All tests are `#[serial]` because `AUTHORIZED_FOLDERS` and
//! `SENSITIVE_PATTERNS` are process-wide `OnceLock<Mutex<_>>` singletons.

use super::backup::{backup_slot_for, backup_to_central};
use super::diff::generate_diff;
use super::*;
use crate::engine::db::AuthorizedFolderRow;
use crate::engine::tools::{init_authorized_folders, refresh_authorized_folders};
use serde_json::json;
use serial_test::serial;
use tempfile::TempDir;

/// Authorize `dir` as a read/write folder so `access_check` short-circuits
/// to Ok without needing an app handle. Canonicalizes the path so it
/// matches on macOS where tempdirs live under `/var -> /private/var`.
async fn authorize(dir: &std::path::Path) {
    let canonical = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
    let row = AuthorizedFolderRow {
        id: "file-tools-test".into(),
        path: canonical.to_string_lossy().to_string(),
        label: Some("test".into()),
        permission: "read_write".into(),
        is_default: false,
        created_at: 0,
        updated_at: 0,
    };
    // First call seeds; subsequent calls no-op. Always refresh to update
    // the live Mutex contents for the current test.
    init_authorized_folders(vec![row.clone()]);
    refresh_authorized_folders(vec![row]).await;
}

fn tmpdir() -> TempDir {
    tempfile::tempdir().expect("tempdir")
}

/// Return the canonical path of a tempdir — on macOS this resolves
/// the `/var -> /private/var` symlink so `access_check` comparisons
/// line up with `authorize()`'s canonical form.
fn canonical_tmpdir(dir: &TempDir) -> std::path::PathBuf {
    dir.path()
        .canonicalize()
        .unwrap_or_else(|_| dir.path().to_path_buf())
}

// ── read_file_tool ────────────────────────────────────────────────
#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn read_file_returns_content_with_line_numbers() {
    let dir = tmpdir();
    authorize(dir.path()).await;
    let file = dir.path().join("hello.txt");
    std::fs::write(&file, "hello\nworld\n").unwrap();

    let out = read_file_tool(&json!({ "path": file.to_string_lossy() })).await;
    assert!(out.contains("hello"), "expected content, got: {out}");
    assert!(out.contains("world"));
    // line-numbered format: "1\thello"
    assert!(out.contains("1\thello"), "expected line numbers, got: {out}");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn read_file_returns_error_for_missing_path() {
    let dir = tmpdir();
    authorize(dir.path()).await;
    let missing = dir.path().join("nope.txt");

    let out = read_file_tool(&json!({ "path": missing.to_string_lossy() })).await;
    assert!(out.starts_with("Error"), "expected error, got: {out}");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn read_file_rejects_binary_content() {
    let dir = tmpdir();
    authorize(dir.path()).await;
    let file = dir.path().join("blob.bin");
    // Contains NUL byte → heuristic flags as binary
    std::fs::write(&file, b"abc\0def").unwrap();

    let out = read_file_tool(&json!({ "path": file.to_string_lossy() })).await;
    assert!(
        out.contains("binary file"),
        "expected binary reject, got: {out}"
    );
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn read_file_rejects_empty_path() {
    let out = read_file_tool(&json!({ "path": "" })).await;
    assert!(out.contains("path is required"));
}

// ── write_file_tool ───────────────────────────────────────────────
#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn write_file_creates_new_file() {
    let dir = tmpdir();
    authorize(dir.path()).await;
    let file = canonical_tmpdir(&dir).join("new.txt");

    let out = write_file_tool(&json!({
        "path": file.to_string_lossy(),
        "content": "fresh content"
    }))
    .await;
    assert!(out.contains("created"), "expected 'created', got: {out}");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "fresh content");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn write_file_creates_parent_directories() {
    let dir = tmpdir();
    authorize(dir.path()).await;
    let nested = canonical_tmpdir(&dir).join("a/b/c/deep.txt");

    let out = write_file_tool(&json!({
        "path": nested.to_string_lossy(),
        "content": "x"
    }))
    .await;
    assert!(out.contains("created"), "got: {out}");
    assert!(nested.exists());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn write_file_requires_prior_read_when_overwriting() {
    use crate::engine::tools::with_session_id;
    let dir = tmpdir();
    authorize(dir.path()).await;
    let file = dir.path().join("existing.txt");
    std::fs::write(&file, "original").unwrap();
    let path_str = file.to_string_lossy().to_string();

    // Need FILE_STATE_CACHE in scope so the gate actually engages —
    // outside of an agent session the cache is absent and the gate
    // is a pass-through.
    let out = with_session_id("file-tools-test-session".into(), async {
        write_file_tool(&json!({
            "path": path_str,
            "content": "clobber"
        }))
        .await
    })
    .await;
    assert!(
        out.contains("must read_file"),
        "expected read-before-write, got: {out}"
    );
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "original");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn write_file_rejects_empty_path() {
    let out = write_file_tool(&json!({ "path": "", "content": "x" })).await;
    assert!(out.contains("path is required"));
}

// ── edit_file_tool ────────────────────────────────────────────────
#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn edit_file_replaces_unique_occurrence() {
    let dir = tmpdir();
    authorize(dir.path()).await;
    let file = dir.path().join("code.txt");
    std::fs::write(&file, "alpha beta gamma").unwrap();
    let _ = read_file_tool(&json!({ "path": file.to_string_lossy() })).await;

    let out = edit_file_tool(&json!({
        "path": file.to_string_lossy(),
        "old_text": "beta",
        "new_text": "BETA"
    }))
    .await;
    assert!(out.starts_with("Edited"), "got: {out}");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "alpha BETA gamma");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn edit_file_fails_when_old_text_missing() {
    let dir = tmpdir();
    authorize(dir.path()).await;
    let file = dir.path().join("code.txt");
    std::fs::write(&file, "alpha beta").unwrap();
    let _ = read_file_tool(&json!({ "path": file.to_string_lossy() })).await;

    let out = edit_file_tool(&json!({
        "path": file.to_string_lossy(),
        "old_text": "zeta",
        "new_text": "ZETA"
    }))
    .await;
    assert!(out.contains("not found"), "got: {out}");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn edit_file_rejects_same_old_and_new() {
    let out = edit_file_tool(&json!({
        "path": "/tmp/whatever",
        "old_text": "same",
        "new_text": "same"
    }))
    .await;
    assert!(out.contains("must be different"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn edit_file_fails_on_multiple_matches_without_replace_all() {
    let dir = tmpdir();
    authorize(dir.path()).await;
    let file = dir.path().join("dup.txt");
    std::fs::write(&file, "foo foo foo").unwrap();
    let _ = read_file_tool(&json!({ "path": file.to_string_lossy() })).await;

    let out = edit_file_tool(&json!({
        "path": file.to_string_lossy(),
        "old_text": "foo",
        "new_text": "bar"
    }))
    .await;
    assert!(out.contains("matches 3 locations"), "got: {out}");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn edit_file_replace_all_replaces_every_occurrence() {
    let dir = tmpdir();
    authorize(dir.path()).await;
    let file = dir.path().join("dup.txt");
    std::fs::write(&file, "foo foo foo").unwrap();
    let _ = read_file_tool(&json!({ "path": file.to_string_lossy() })).await;

    let out = edit_file_tool(&json!({
        "path": file.to_string_lossy(),
        "old_text": "foo",
        "new_text": "bar",
        "replace_all": true
    }))
    .await;
    assert!(out.starts_with("Edited"), "got: {out}");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "bar bar bar");
}

// ── append_file_tool ──────────────────────────────────────────────
#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn append_file_appends_to_existing_file() {
    let dir = tmpdir();
    authorize(dir.path()).await;
    let file = dir.path().join("log.txt");
    std::fs::write(&file, "line1\n").unwrap();

    let out = append_file_tool(&json!({
        "path": file.to_string_lossy(),
        "content": "line2\n"
    }))
    .await;
    assert!(out.contains("Appended"));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "line1\nline2\n");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn append_file_creates_file_if_missing() {
    let dir = tmpdir();
    authorize(dir.path()).await;
    let file = canonical_tmpdir(&dir).join("fresh.log");
    assert!(!file.exists());

    let out = append_file_tool(&json!({
        "path": file.to_string_lossy(),
        "content": "first line"
    }))
    .await;
    assert!(out.contains("Appended"));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "first line");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn append_file_rejects_empty_path() {
    let out = append_file_tool(&json!({ "path": "", "content": "x" })).await;
    assert!(out.contains("path is required"));
}

// ── delete_file_tool ──────────────────────────────────────────────
#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn delete_file_removes_existing_file() {
    let dir = tmpdir();
    authorize(dir.path()).await;
    let file = dir.path().join("doomed.txt");
    std::fs::write(&file, "bye").unwrap();

    let out = delete_file_tool(&json!({ "path": file.to_string_lossy() })).await;
    assert!(out.contains("Deleted"), "got: {out}");
    assert!(!file.exists());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn delete_file_errors_when_missing() {
    let dir = tmpdir();
    authorize(dir.path()).await;
    let missing = dir.path().join("nope.txt");

    let out = delete_file_tool(&json!({ "path": missing.to_string_lossy() })).await;
    assert!(out.starts_with("Error"), "got: {out}");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn delete_file_requires_recursive_for_dir() {
    let dir = tmpdir();
    authorize(dir.path()).await;
    let sub = dir.path().join("subdir");
    std::fs::create_dir(&sub).unwrap();

    let out = delete_file_tool(&json!({ "path": sub.to_string_lossy() })).await;
    assert!(out.contains("recursive=true"), "got: {out}");
    assert!(sub.exists(), "dir should still exist");

    let out2 = delete_file_tool(&json!({
        "path": sub.to_string_lossy(),
        "recursive": true
    }))
    .await;
    assert!(out2.contains("Deleted"), "got: {out2}");
    assert!(!sub.exists());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn delete_file_rejects_empty_path() {
    let out = delete_file_tool(&json!({ "path": "" })).await;
    assert!(out.contains("path is required"));
}

// ── list_directory_tool ───────────────────────────────────────────
#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_directory_lists_entries() {
    let dir = tmpdir();
    authorize(dir.path()).await;
    std::fs::write(dir.path().join("a.txt"), "one").unwrap();
    std::fs::create_dir(dir.path().join("sub")).unwrap();

    let out = list_directory_tool(&json!({ "path": dir.path().to_string_lossy() })).await;
    assert!(out.contains("a.txt"));
    assert!(out.contains("[DIR] sub/"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_directory_handles_empty_dir() {
    let dir = tmpdir();
    authorize(dir.path()).await;

    let out = list_directory_tool(&json!({ "path": dir.path().to_string_lossy() })).await;
    assert!(out.contains("(empty)"), "got: {out}");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_directory_errors_on_missing_path() {
    let dir = tmpdir();
    authorize(dir.path()).await;
    let missing = dir.path().join("nope");

    let out = list_directory_tool(&json!({ "path": missing.to_string_lossy() })).await;
    assert!(out.starts_with("Error"), "got: {out}");
}

// ── project_tree_tool ─────────────────────────────────────────────
#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn project_tree_renders_tree_for_directory() {
    let dir = tmpdir();
    authorize(dir.path()).await;
    std::fs::write(dir.path().join("README.md"), "# test").unwrap();

    let out = project_tree_tool(&json!({ "path": dir.path().to_string_lossy() })).await;
    assert!(!out.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn project_tree_errors_when_path_is_file() {
    let dir = tmpdir();
    authorize(dir.path()).await;
    let file = dir.path().join("plain.txt");
    std::fs::write(&file, "x").unwrap();

    let out = project_tree_tool(&json!({ "path": file.to_string_lossy() })).await;
    assert!(out.contains("not a directory"), "got: {out}");
}

// ── undo_edit_tool ────────────────────────────────────────────────
#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn undo_edit_errors_when_no_backup_exists() {
    let unique = format!("/tmp/yiyi_undo_no_backup_{}.txt", uuid::Uuid::new_v4());
    let out = undo_edit_tool(&json!({ "path": unique })).await;
    assert!(out.contains("no backup"), "got: {out}");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn undo_edit_rejects_empty_path() {
    let out = undo_edit_tool(&json!({ "path": "" })).await;
    assert!(out.contains("path is required"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn undo_edit_restores_from_backup_after_edit() {
    if dirs::home_dir().is_none() {
        return;
    }
    let dir = tmpdir();
    authorize(dir.path()).await;
    let file = dir.path().join(format!("undo_{}.txt", uuid::Uuid::new_v4()));
    std::fs::write(&file, "original content").unwrap();
    let _ = read_file_tool(&json!({ "path": file.to_string_lossy() })).await;
    let _ = edit_file_tool(&json!({
        "path": file.to_string_lossy(),
        "old_text": "original",
        "new_text": "modified"
    }))
    .await;
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "modified content");

    let out = undo_edit_tool(&json!({ "path": file.to_string_lossy() })).await;
    assert!(out.starts_with("Restored"), "got: {out}");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "original content");

    // Clean up backup file
    let safe_name = file.to_string_lossy().replace(['/', '\\'], "__");
    let backup = dirs::home_dir()
        .unwrap()
        .join(".yiyi")
        .join("backups")
        .join(format!("{}.backup", safe_name));
    let _ = std::fs::remove_file(backup);
}

// ── P2.1: every file-mutating tool routes its pre-change snapshot
//    through `backup_to_central`, so `undo_edit` should be able to
//    roll back ANY of them — not just edit_file (the only one
//    covered before P2.1).
#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn undo_edit_rolls_back_write_file_overwrite() {
    if dirs::home_dir().is_none() {
        return;
    }
    let dir = tmpdir();
    authorize(dir.path()).await;
    let file = dir.path().join(format!("write_{}.txt", uuid::Uuid::new_v4()));
    let pre = "VERSION_ONE — the value before write_file overwrites it. Has to be over 500 chars so the shrink-guard doesn't fire when we replace it with a similarly-sized payload. Padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding padding";
    std::fs::write(&file, pre).unwrap();
    // Read-before-write contract.
    let _ = read_file_tool(&json!({ "path": file.to_string_lossy() })).await;
    let post: String = pre.replace("VERSION_ONE", "VERSION_TWO");
    let out = write_file_tool(&json!({
        "path": file.to_string_lossy(),
        "content": post,
    }))
    .await;
    assert!(out.starts_with("File "), "write_file failed: {out}");
    assert!(std::fs::read_to_string(&file).unwrap().contains("VERSION_TWO"));

    let undo = undo_edit_tool(&json!({ "path": file.to_string_lossy() })).await;
    assert!(undo.starts_with("Restored"), "undo_edit failed: {undo}");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), pre);

    let _ = std::fs::remove_file(backup_slot_for(&file.to_string_lossy()).unwrap());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn undo_edit_rolls_back_append_file_changes() {
    if dirs::home_dir().is_none() {
        return;
    }
    let dir = tmpdir();
    authorize(dir.path()).await;
    let file = dir.path().join(format!("append_{}.log", uuid::Uuid::new_v4()));
    std::fs::write(&file, "line1\n").unwrap();

    let out = append_file_tool(&json!({
        "path": file.to_string_lossy(),
        "content": "line2\n"
    }))
    .await;
    assert!(out.starts_with("Appended"), "append_file failed: {out}");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "line1\nline2\n");

    let undo = undo_edit_tool(&json!({ "path": file.to_string_lossy() })).await;
    assert!(undo.starts_with("Restored"), "undo_edit failed: {undo}");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "line1\n");

    let _ = std::fs::remove_file(backup_slot_for(&file.to_string_lossy()).unwrap());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn undo_edit_resurrects_deleted_file() {
    if dirs::home_dir().is_none() {
        return;
    }
    let dir = tmpdir();
    authorize(dir.path()).await;
    let file = dir.path().join(format!("doomed_{}.txt", uuid::Uuid::new_v4()));
    std::fs::write(&file, "contents worth preserving").unwrap();

    let out = delete_file_tool(&json!({ "path": file.to_string_lossy() })).await;
    assert!(out.starts_with("Deleted"), "delete_file failed: {out}");
    assert!(!file.exists());

    let undo = undo_edit_tool(&json!({ "path": file.to_string_lossy() })).await;
    assert!(undo.contains("Restored"), "undo_edit failed: {undo}");
    assert!(file.exists(), "undo_edit must recreate the deleted file");
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "contents worth preserving"
    );

    let _ = std::fs::remove_file(backup_slot_for(&file.to_string_lossy()).unwrap());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn backup_to_central_skips_when_source_missing() {
    // No file exists at this path — `backup_to_central` must NOT write
    // an empty `.backup` for it, since that would let a later
    // `undo_edit` mistakenly "restore" garbage.
    let unique = format!(
        "/tmp/yiyi_backup_source_missing_{}.txt",
        uuid::Uuid::new_v4()
    );
    let result = backup_to_central(&unique).await;
    assert!(
        result.is_none(),
        "expected None for missing source, got {:?}",
        result
    );
    let slot = backup_slot_for(&unique).unwrap();
    assert!(!slot.exists(), "no backup file should have been created");
}

// ── grep_search_tool ──────────────────────────────────────────────
#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn grep_search_finds_matches() {
    let dir = tmpdir();
    authorize(dir.path()).await;
    std::fs::write(dir.path().join("a.txt"), "needle\nother\n").unwrap();
    std::fs::write(dir.path().join("b.txt"), "no match here\n").unwrap();

    let out = grep_search_tool(&json!({
        "pattern": "needle",
        "path": dir.path().to_string_lossy()
    }))
    .await;
    assert!(out.contains("needle"), "expected hit, got: {out}");
    assert!(out.contains("a.txt"), "expected filename, got: {out}");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn grep_search_reports_no_matches() {
    let dir = tmpdir();
    authorize(dir.path()).await;
    std::fs::write(dir.path().join("a.txt"), "hello world\n").unwrap();

    let out = grep_search_tool(&json!({
        "pattern": "zzz_unlikely_pattern_zzz",
        "path": dir.path().to_string_lossy()
    }))
    .await;
    assert!(
        out.contains("No matches") || out.contains("no matches"),
        "got: {out}"
    );
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn grep_search_requires_pattern() {
    let dir = tmpdir();
    authorize(dir.path()).await;
    let out = grep_search_tool(&json!({
        "pattern": "",
        "path": dir.path().to_string_lossy()
    }))
    .await;
    assert!(out.contains("pattern is required"));
}

// ── glob_search_tool ──────────────────────────────────────────────
#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn glob_search_matches_pattern() {
    let dir = tmpdir();
    authorize(dir.path()).await;
    std::fs::write(dir.path().join("one.rs"), "").unwrap();
    std::fs::write(dir.path().join("two.rs"), "").unwrap();
    std::fs::write(dir.path().join("three.txt"), "").unwrap();

    let out = glob_search_tool(&json!({
        "pattern": "*.rs",
        "path": dir.path().to_string_lossy()
    }))
    .await;
    assert!(out.contains("one.rs"));
    assert!(out.contains("two.rs"));
    assert!(
        !out.contains("three.txt"),
        "glob should not match .txt, got: {out}"
    );
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn glob_search_reports_no_files_found() {
    let dir = tmpdir();
    authorize(dir.path()).await;
    std::fs::write(dir.path().join("only.txt"), "").unwrap();

    let out = glob_search_tool(&json!({
        "pattern": "*.rs",
        "path": dir.path().to_string_lossy()
    }))
    .await;
    assert!(out.contains("No files found"), "got: {out}");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn glob_search_requires_pattern() {
    let dir = tmpdir();
    authorize(dir.path()).await;
    let out = glob_search_tool(&json!({
        "pattern": "",
        "path": dir.path().to_string_lossy()
    }))
    .await;
    assert!(out.contains("pattern is required"));
}

// ── generate_diff helper ──────────────────────────────────────────
#[test]
fn generate_diff_returns_no_changes_for_identical() {
    let out = generate_diff("same\n", "same\n", "f.txt");
    assert_eq!(out, "No changes.");
}

#[test]
fn generate_diff_summarizes_new_file() {
    let out = generate_diff("", "a\nb\nc\n", "new.txt");
    assert!(out.contains("New file with"));
    assert!(out.contains("3 lines"));
}

#[test]
fn generate_diff_summarizes_cleared_file() {
    let out = generate_diff("a\nb\nc\n", "", "gone.txt");
    assert!(out.contains("cleared"));
}
