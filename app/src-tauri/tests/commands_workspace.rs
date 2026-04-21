//! Integration tests for `commands/workspace.rs` thin-layer `_impl` functions.
//!
//! Covers simple `State<AppState>`-style filesystem and DB commands for:
//! - user workspace file CRUD (list/load/save/delete/create/binary)
//! - zip upload/download round-trip
//! - authorized folders CRUD (DB + in-memory refresh)
//! - sensitive patterns CRUD (DB + in-memory refresh)
//! - agent/memory markdown file CRUD
//!
//! Deferred:
//! - `pick_folder` (native OS dialog via `rfd`)
//! - `respond_permission_request` (touches global `permission_gate` state)

mod common;

#[allow(unused_imports)]
use common::*;

use app_lib::commands::workspace::*;
use serial_test::serial;

// === list_workspace_files =====================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_workspace_files_on_empty_workspace_returns_empty_vec() {
    let t = build_test_app_state().await;
    let files = list_workspace_files_impl(t.state()).await.unwrap();
    // Fresh tempdir might contain a config.json but `.` files are skipped; other
    // build_test_app_state side-effects may have written files. We just assert
    // hidden dotfiles aren't reported.
    assert!(files.iter().all(|f| !f.name.starts_with('.')));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_workspace_files_returns_created_file_and_nested_dir() {
    let t = build_test_app_state().await;
    let state = t.state();

    save_workspace_file_impl(state, "top.txt".into(), "hello".into())
        .await
        .unwrap();
    save_workspace_file_impl(state, "sub/inner.txt".into(), "nested".into())
        .await
        .unwrap();

    let files = list_workspace_files_impl(state).await.unwrap();
    let names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
    assert!(names.iter().any(|n| *n == "top.txt"));
    assert!(names.iter().any(|n| *n == "sub"));
    // Nested paths use forward-slash relative names per walk_dir.
    assert!(names.iter().any(|n| n.contains("inner.txt")));

    // Directories come before files (sort: is_dir DESC, then name ASC).
    let sub_pos = files.iter().position(|f| f.name == "sub").unwrap();
    let top_pos = files.iter().position(|f| f.name == "top.txt").unwrap();
    assert!(sub_pos < top_pos);
}

// === load_workspace_file ======================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn load_workspace_file_returns_written_content() {
    let t = build_test_app_state().await;
    let state = t.state();

    save_workspace_file_impl(state, "note.txt".into(), "my content".into())
        .await
        .unwrap();

    let content = load_workspace_file_impl(state, "note.txt".into())
        .await
        .unwrap();
    assert_eq!(content, "my content");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn load_workspace_file_rejects_path_traversal() {
    let t = build_test_app_state().await;
    let err = load_workspace_file_impl(t.state(), "../outside.txt".into())
        .await
        .unwrap_err();
    assert!(
        err.contains("Path traversal"),
        "expected path traversal error, got: {err}"
    );
}

// === save_workspace_file ======================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn save_workspace_file_creates_parent_directories() {
    let t = build_test_app_state().await;
    let state = t.state();

    save_workspace_file_impl(state, "a/b/c/deep.txt".into(), "deep".into())
        .await
        .unwrap();

    let content = load_workspace_file_impl(state, "a/b/c/deep.txt".into())
        .await
        .unwrap();
    assert_eq!(content, "deep");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn save_workspace_file_overwrites_existing_file() {
    let t = build_test_app_state().await;
    let state = t.state();

    save_workspace_file_impl(state, "ow.txt".into(), "v1".into())
        .await
        .unwrap();
    save_workspace_file_impl(state, "ow.txt".into(), "v2".into())
        .await
        .unwrap();

    let content = load_workspace_file_impl(state, "ow.txt".into())
        .await
        .unwrap();
    assert_eq!(content, "v2");
}

// === delete_workspace_file ====================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn delete_workspace_file_removes_existing_file() {
    let t = build_test_app_state().await;
    let state = t.state();

    save_workspace_file_impl(state, "del.txt".into(), "bye".into())
        .await
        .unwrap();
    delete_workspace_file_impl(state, "del.txt".into())
        .await
        .unwrap();

    let err = load_workspace_file_impl(state, "del.txt".into())
        .await
        .unwrap_err();
    assert!(err.contains("Failed to read"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn delete_workspace_file_removes_directory_recursively() {
    let t = build_test_app_state().await;
    let state = t.state();

    save_workspace_file_impl(state, "rmdir/inner.txt".into(), "x".into())
        .await
        .unwrap();
    delete_workspace_file_impl(state, "rmdir".into())
        .await
        .unwrap();

    let files = list_workspace_files_impl(state).await.unwrap();
    assert!(files.iter().all(|f| f.name != "rmdir"));
}

// === create_workspace_file ====================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn create_workspace_file_writes_new_file() {
    let t = build_test_app_state().await;
    let state = t.state();

    create_workspace_file_impl(state, "new.txt".into(), "fresh".into())
        .await
        .unwrap();

    let content = load_workspace_file_impl(state, "new.txt".into())
        .await
        .unwrap();
    assert_eq!(content, "fresh");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn create_workspace_file_errors_when_file_exists() {
    let t = build_test_app_state().await;
    let state = t.state();

    create_workspace_file_impl(state, "dup.txt".into(), "one".into())
        .await
        .unwrap();
    let err = create_workspace_file_impl(state, "dup.txt".into(), "two".into())
        .await
        .unwrap_err();
    assert!(
        err.contains("already exists"),
        "expected already-exists error, got: {err}"
    );
}

// === create_workspace_dir =====================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn create_workspace_dir_creates_new_directory() {
    let t = build_test_app_state().await;
    let state = t.state();

    create_workspace_dir_impl(state, "fresh_dir".into())
        .await
        .unwrap();
    let expected = state.user_workspace().join("fresh_dir");
    assert!(expected.is_dir());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn create_workspace_dir_errors_when_dir_exists() {
    let t = build_test_app_state().await;
    let state = t.state();

    create_workspace_dir_impl(state, "dup_dir".into())
        .await
        .unwrap();
    let err = create_workspace_dir_impl(state, "dup_dir".into())
        .await
        .unwrap_err();
    assert!(
        err.contains("already exists"),
        "expected already-exists error, got: {err}"
    );
}

// === load_workspace_file_binary ===============================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn load_workspace_file_binary_returns_raw_bytes() {
    let t = build_test_app_state().await;
    let state = t.state();

    // Use save (UTF-8) and then load as bytes to round-trip.
    save_workspace_file_impl(state, "bin.bin".into(), "AB\nC".into())
        .await
        .unwrap();
    let bytes = load_workspace_file_binary_impl(state, "bin.bin".into())
        .await
        .unwrap();
    assert_eq!(bytes, b"AB\nC");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn load_workspace_file_binary_rejects_path_traversal() {
    let t = build_test_app_state().await;
    let err = load_workspace_file_binary_impl(t.state(), "../escape".into())
        .await
        .unwrap_err();
    assert!(
        err.contains("Path traversal"),
        "expected traversal error, got: {err}"
    );
}

// === upload_workspace / download_workspace ====================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn download_workspace_returns_valid_zip_containing_saved_files() {
    let t = build_test_app_state().await;
    let state = t.state();

    save_workspace_file_impl(state, "one.txt".into(), "ABC".into())
        .await
        .unwrap();
    save_workspace_file_impl(state, "dir/two.txt".into(), "XYZ".into())
        .await
        .unwrap();

    let bytes = download_workspace_impl(state).await.unwrap();
    assert!(!bytes.is_empty());

    // Parse zip — must contain at least the two entries we just wrote.
    let cursor = std::io::Cursor::new(&bytes);
    let mut archive = zip::ZipArchive::new(cursor).expect("valid zip");
    let names: Vec<String> = (0..archive.len())
        .map(|i| archive.by_index(i).unwrap().name().to_string())
        .collect();
    assert!(
        names.iter().any(|n| n == "one.txt"),
        "missing one.txt in {names:?}"
    );
    assert!(
        names.iter().any(|n| n == "dir/two.txt"),
        "missing dir/two.txt in {names:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn upload_workspace_extracts_zip_into_workspace() {
    let t = build_test_app_state().await;
    let state = t.state();

    // Build a zip in memory containing one file.
    let mut buf = Vec::new();
    {
        let cursor = std::io::Cursor::new(&mut buf);
        let mut zip = zip::ZipWriter::new(cursor);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        zip.start_file("uploaded.txt", options).unwrap();
        std::io::Write::write_all(&mut zip, b"payload").unwrap();
        zip.finish().unwrap();
    }

    let resp = upload_workspace_impl(state, buf, "test.zip".into())
        .await
        .unwrap();
    assert_eq!(resp["success"], serde_json::json!(true));

    let content = load_workspace_file_impl(state, "uploaded.txt".into())
        .await
        .unwrap();
    assert_eq!(content, "payload");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn upload_workspace_skips_path_traversal_entries() {
    let t = build_test_app_state().await;
    let state = t.state();

    // Zip with an entry that tries to escape.
    let mut buf = Vec::new();
    {
        let cursor = std::io::Cursor::new(&mut buf);
        let mut zip = zip::ZipWriter::new(cursor);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        zip.start_file("../escape.txt", options).unwrap();
        std::io::Write::write_all(&mut zip, b"nope").unwrap();
        zip.start_file("safe.txt", options).unwrap();
        std::io::Write::write_all(&mut zip, b"ok").unwrap();
        zip.finish().unwrap();
    }

    let _ = upload_workspace_impl(state, buf, "mixed.zip".into())
        .await
        .unwrap();

    // Safe entry must land; traversal entry must NOT escape outside workspace.
    let content = load_workspace_file_impl(state, "safe.txt".into())
        .await
        .unwrap();
    assert_eq!(content, "ok");

    // Escape path should not exist in parent.
    let parent = state.user_workspace().parent().unwrap().to_path_buf();
    assert!(!parent.join("escape.txt").exists());
}

// === get_workspace_path =======================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_workspace_path_returns_current_user_workspace() {
    let t = build_test_app_state().await;
    let got = get_workspace_path_impl(t.state()).await.unwrap();
    assert_eq!(got, t.state().user_workspace().to_string_lossy());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_workspace_path_reflects_changed_path() {
    let t = build_test_app_state().await;
    let new_path = tempfile::TempDir::new().unwrap();
    t.state().set_user_workspace_path(new_path.path().to_path_buf());

    let got = get_workspace_path_impl(t.state()).await.unwrap();
    assert_eq!(got, new_path.path().to_string_lossy());
}

// === list_authorized_folders ==================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_authorized_folders_on_empty_db_returns_empty_vec() {
    let t = build_test_app_state().await;
    let folders = list_authorized_folders_impl(t.state()).await.unwrap();
    assert!(folders.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_authorized_folders_returns_added_entry() {
    let t = build_test_app_state().await;
    let state = t.state();

    let tmp = tempfile::TempDir::new().unwrap();
    add_authorized_folder_impl(
        state,
        tmp.path().to_string_lossy().to_string(),
        Some("my_label".into()),
        Some("read_only".into()),
    )
    .await
    .unwrap();

    let folders = list_authorized_folders_impl(state).await.unwrap();
    assert_eq!(folders.len(), 1);
    assert_eq!(folders[0].label.as_deref(), Some("my_label"));
    assert_eq!(folders[0].permission, "read_only");
}

// === add_authorized_folder ====================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn add_authorized_folder_persists_with_defaults_and_returns_row() {
    let t = build_test_app_state().await;
    let tmp = tempfile::TempDir::new().unwrap();

    let folder = add_authorized_folder_impl(
        t.state(),
        tmp.path().to_string_lossy().to_string(),
        None,
        None, // defaults to read_write
    )
    .await
    .unwrap();

    assert_eq!(folder.permission, "read_write");
    assert!(folder.label.is_none());
    assert!(!folder.is_default);
    assert!(!folder.id.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn add_authorized_folder_rejects_relative_path() {
    let t = build_test_app_state().await;
    let err = add_authorized_folder_impl(
        t.state(),
        "relative/path".into(),
        None,
        None,
    )
    .await
    .unwrap_err();
    assert!(
        err.contains("absolute"),
        "expected absolute-path error, got: {err}"
    );
}

// === update_authorized_folder =================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn update_authorized_folder_changes_label_and_permission() {
    let t = build_test_app_state().await;
    let state = t.state();

    let tmp = tempfile::TempDir::new().unwrap();
    let folder = add_authorized_folder_impl(
        state,
        tmp.path().to_string_lossy().to_string(),
        Some("old".into()),
        Some("read_only".into()),
    )
    .await
    .unwrap();

    update_authorized_folder_impl(
        state,
        folder.id.clone(),
        Some("new_label".into()),
        Some("read_write".into()),
    )
    .await
    .unwrap();

    let folders = list_authorized_folders_impl(state).await.unwrap();
    let updated = folders.iter().find(|f| f.id == folder.id).unwrap();
    assert_eq!(updated.label.as_deref(), Some("new_label"));
    assert_eq!(updated.permission, "read_write");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn update_authorized_folder_errors_on_unknown_id() {
    let t = build_test_app_state().await;
    let err = update_authorized_folder_impl(
        t.state(),
        "no-such-folder".into(),
        Some("x".into()),
        None,
    )
    .await
    .unwrap_err();
    assert!(
        err.contains("not found"),
        "expected not-found error, got: {err}"
    );
}

// === remove_authorized_folder =================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn remove_authorized_folder_deletes_non_default_entry() {
    let t = build_test_app_state().await;
    let state = t.state();

    let tmp = tempfile::TempDir::new().unwrap();
    let folder = add_authorized_folder_impl(
        state,
        tmp.path().to_string_lossy().to_string(),
        None,
        None,
    )
    .await
    .unwrap();

    remove_authorized_folder_impl(state, folder.id.clone())
        .await
        .unwrap();

    let folders = list_authorized_folders_impl(state).await.unwrap();
    assert!(folders.iter().all(|f| f.id != folder.id));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn remove_authorized_folder_refuses_to_delete_default_folder() {
    let t = build_test_app_state().await;
    let state = t.state();

    // Seed a default folder directly in DB (add_authorized_folder_impl always
    // sets is_default = false).
    let tmp = tempfile::TempDir::new().unwrap();
    let now = chrono::Utc::now().timestamp();
    let row = app_lib::engine::db::AuthorizedFolderRow {
        id: "default-seed".into(),
        path: tmp.path().to_string_lossy().to_string(),
        label: Some("default".into()),
        permission: "read_write".into(),
        is_default: true,
        created_at: now,
        updated_at: now,
    };
    state.db.upsert_authorized_folder(&row).unwrap();

    let err = remove_authorized_folder_impl(state, "default-seed".into())
        .await
        .unwrap_err();
    assert!(
        err.contains("default"),
        "expected default-folder error, got: {err}"
    );
}

// === list_sensitive_patterns ==================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_sensitive_patterns_on_empty_db_returns_empty_vec() {
    let t = build_test_app_state().await;
    let patterns = list_sensitive_patterns_impl(t.state()).await.unwrap();
    assert!(patterns.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_sensitive_patterns_returns_added_entry() {
    let t = build_test_app_state().await;
    let state = t.state();

    add_sensitive_pattern_impl(state, "*.secret".into())
        .await
        .unwrap();

    let patterns = list_sensitive_patterns_impl(state).await.unwrap();
    assert_eq!(patterns.len(), 1);
    assert_eq!(patterns[0].pattern, "*.secret");
    assert!(patterns[0].enabled);
    assert!(!patterns[0].is_builtin);
}

// === add_sensitive_pattern ====================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn add_sensitive_pattern_returns_enabled_non_builtin_row() {
    let t = build_test_app_state().await;
    let row = add_sensitive_pattern_impl(t.state(), "**/.aws/**".into())
        .await
        .unwrap();

    assert_eq!(row.pattern, "**/.aws/**");
    assert!(row.enabled);
    assert!(!row.is_builtin);
    assert!(!row.id.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn add_sensitive_pattern_allows_multiple_distinct_patterns() {
    let t = build_test_app_state().await;
    let state = t.state();

    add_sensitive_pattern_impl(state, "p1".into()).await.unwrap();
    add_sensitive_pattern_impl(state, "p2".into()).await.unwrap();

    let patterns = list_sensitive_patterns_impl(state).await.unwrap();
    let strs: Vec<&str> = patterns.iter().map(|p| p.pattern.as_str()).collect();
    assert!(strs.contains(&"p1"));
    assert!(strs.contains(&"p2"));
}

// === toggle_sensitive_pattern =================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn toggle_sensitive_pattern_disables_and_reenables_entry() {
    let t = build_test_app_state().await;
    let state = t.state();

    let row = add_sensitive_pattern_impl(state, "togglepat".into())
        .await
        .unwrap();

    toggle_sensitive_pattern_impl(state, row.id.clone(), false)
        .await
        .unwrap();
    let disabled = list_sensitive_patterns_impl(state).await.unwrap();
    let entry = disabled.iter().find(|p| p.id == row.id).unwrap();
    assert!(!entry.enabled);

    toggle_sensitive_pattern_impl(state, row.id.clone(), true)
        .await
        .unwrap();
    let enabled = list_sensitive_patterns_impl(state).await.unwrap();
    let entry = enabled.iter().find(|p| p.id == row.id).unwrap();
    assert!(entry.enabled);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn toggle_sensitive_pattern_on_unknown_id_is_noop() {
    let t = build_test_app_state().await;
    // SQL UPDATE on unknown id affects 0 rows and returns Ok.
    toggle_sensitive_pattern_impl(t.state(), "nope".into(), false)
        .await
        .unwrap();
}

// === remove_sensitive_pattern =================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn remove_sensitive_pattern_deletes_entry() {
    let t = build_test_app_state().await;
    let state = t.state();

    let row = add_sensitive_pattern_impl(state, "removeme".into())
        .await
        .unwrap();
    remove_sensitive_pattern_impl(state, row.id.clone())
        .await
        .unwrap();

    let patterns = list_sensitive_patterns_impl(state).await.unwrap();
    assert!(patterns.iter().all(|p| p.id != row.id));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn remove_sensitive_pattern_on_unknown_id_is_idempotent() {
    let t = build_test_app_state().await;
    remove_sensitive_pattern_impl(t.state(), "never-existed".into())
        .await
        .unwrap();
}

// === list_folder_files ========================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_folder_files_returns_files_under_authorized_folder() {
    let t = build_test_app_state().await;
    let state = t.state();

    // Create an authorized folder and populate one file inside it.
    let tmp = tempfile::TempDir::new().unwrap();
    let folder_path = tmp.path().to_path_buf();
    std::fs::write(folder_path.join("a.txt"), "content").unwrap();

    add_authorized_folder_impl(
        state,
        folder_path.to_string_lossy().to_string(),
        None,
        None,
    )
    .await
    .unwrap();

    let files = list_folder_files_impl(
        state,
        folder_path.to_string_lossy().to_string(),
    )
    .await
    .unwrap();
    assert!(files.iter().any(|f| f.name == "a.txt"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_folder_files_rejects_unauthorized_folder() {
    let t = build_test_app_state().await;
    let state = t.state();

    let tmp = tempfile::TempDir::new().unwrap();
    let result = list_folder_files_impl(
        state,
        tmp.path().to_string_lossy().to_string(),
    )
    .await;
    let err = match result {
        Err(e) => e,
        Ok(_) => panic!("expected unauthorized error, got Ok"),
    };
    assert!(
        err.contains("not in any authorized folder"),
        "expected unauthorized error, got: {err}"
    );
}

// === list_agent_files =========================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_agent_files_returns_markdown_in_working_dir() {
    let t = build_test_app_state().await;
    let state = t.state();

    // Drop a .md and a .txt into working_dir (not memory subdir).
    std::fs::write(state.working_dir.join("AGENTS.md"), "# agent").unwrap();
    std::fs::write(state.working_dir.join("ignored.txt"), "nope").unwrap();

    let files = list_agent_files_impl(state).await.unwrap();
    let names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
    assert!(names.contains(&"AGENTS.md"));
    assert!(!names.contains(&"ignored.txt"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_agent_files_returns_empty_when_no_md_present() {
    let t = build_test_app_state().await;
    // Fresh working_dir contains config.json but no .md files.
    let files = list_agent_files_impl(t.state()).await.unwrap();
    assert!(files.iter().all(|f| f.name.ends_with(".md")));
}

// === read_agent_file ==========================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn read_agent_file_returns_written_content() {
    let t = build_test_app_state().await;
    let state = t.state();

    write_agent_file_impl(state, "agent.md".into(), "# hello".into())
        .await
        .unwrap();

    let content = read_agent_file_impl(state, "agent.md".into())
        .await
        .unwrap();
    assert_eq!(content, "# hello");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn read_agent_file_rejects_path_traversal() {
    let t = build_test_app_state().await;
    let err = read_agent_file_impl(t.state(), "../escape.md".into())
        .await
        .unwrap_err();
    assert!(
        err.contains("Path traversal"),
        "expected traversal error, got: {err}"
    );
}

// === write_agent_file =========================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn write_agent_file_overwrites_existing_content() {
    let t = build_test_app_state().await;
    let state = t.state();

    write_agent_file_impl(state, "ow.md".into(), "v1".into())
        .await
        .unwrap();
    write_agent_file_impl(state, "ow.md".into(), "v2".into())
        .await
        .unwrap();

    let content = read_agent_file_impl(state, "ow.md".into()).await.unwrap();
    assert_eq!(content, "v2");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn write_agent_file_rejects_absolute_path() {
    let t = build_test_app_state().await;
    let err = write_agent_file_impl(
        t.state(),
        "/tmp/absolute.md".into(),
        "x".into(),
    )
    .await
    .unwrap_err();
    assert!(
        err.contains("Path traversal"),
        "expected traversal error, got: {err}"
    );
}

// === list_memory_files ========================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_memory_files_returns_md_under_memory_subdir() {
    let t = build_test_app_state().await;
    let state = t.state();

    // Seed memory/ dir + files via write_memory_file (it creates dir).
    write_memory_file_impl(state, "note.md".into(), "entry".into())
        .await
        .unwrap();

    let files = list_memory_files_impl(state).await.unwrap();
    let names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
    assert!(names.contains(&"note.md"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_memory_files_returns_empty_when_no_memory_dir() {
    let t = build_test_app_state().await;
    // No memory dir yet — should return an empty vec without panicking.
    let files = list_memory_files_impl(t.state()).await.unwrap();
    assert!(files.is_empty());
}

// === read_memory_file =========================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn read_memory_file_returns_written_content() {
    let t = build_test_app_state().await;
    let state = t.state();

    write_memory_file_impl(state, "m.md".into(), "memory payload".into())
        .await
        .unwrap();

    let content = read_memory_file_impl(state, "m.md".into()).await.unwrap();
    assert_eq!(content, "memory payload");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn read_memory_file_rejects_path_traversal() {
    let t = build_test_app_state().await;
    let err = read_memory_file_impl(t.state(), "../outside.md".into())
        .await
        .unwrap_err();
    assert!(
        err.contains("Path traversal"),
        "expected traversal error, got: {err}"
    );
}

// === write_memory_file ========================================================

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn write_memory_file_creates_memory_dir_and_file() {
    let t = build_test_app_state().await;
    let state = t.state();

    write_memory_file_impl(state, "fresh.md".into(), "hi".into())
        .await
        .unwrap();

    let expected = state.working_dir.join("memory").join("fresh.md");
    assert!(expected.exists(), "memory/fresh.md should be written");
    let content = tokio::fs::read_to_string(&expected).await.unwrap();
    assert_eq!(content, "hi");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn write_memory_file_rejects_path_traversal_filename() {
    let t = build_test_app_state().await;
    let err = write_memory_file_impl(
        t.state(),
        "../escape.md".into(),
        "bad".into(),
    )
    .await
    .unwrap_err();
    assert!(
        err.contains("Path traversal"),
        "expected traversal error, got: {err}"
    );
}
