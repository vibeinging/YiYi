mod common;

#[allow(unused_imports)]
use common::*;
use app_lib::commands::agent::session::*;
use serial_test::serial;

// All session commands are thin DB CRUD wrappers. `#[serial]` keeps
// concurrent tests from stepping on the shared SQLite db.
//
// Schema notes (from engine/db/sessions.rs):
//   - `create_session` always uses source "chat" (and a fresh UUID id).
//   - `ensure_session` is INSERT OR IGNORE — returns struct reflecting
//     input params; re-ensuring an existing id is a no-op on the row.
//   - `rename_session` / `delete_session` return Ok(()) even if the id
//     doesn't exist (UPDATE/DELETE 0 rows → no error).

// === list_sessions ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_sessions_returns_empty_on_fresh_db() {
    let t = build_test_app_state().await;
    let sessions = list_sessions_impl(t.state()).await.unwrap();
    assert!(sessions.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_sessions_returns_created_rows() {
    let t = build_test_app_state().await;
    let state = t.state();
    create_session_impl(state, "One".into()).await.unwrap();
    create_session_impl(state, "Two".into()).await.unwrap();

    let sessions = list_sessions_impl(state).await.unwrap();
    assert_eq!(sessions.len(), 2);
    let names: Vec<&str> = sessions.iter().map(|s| s.name.as_str()).collect();
    assert!(names.contains(&"One"));
    assert!(names.contains(&"Two"));
}

// === create_session ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn create_session_returns_row_reflecting_input_name() {
    let t = build_test_app_state().await;
    let row = create_session_impl(t.state(), "My Chat".into()).await.unwrap();
    assert_eq!(row.name, "My Chat");
    assert_eq!(row.source, "chat");
    assert!(!row.id.is_empty(), "id should be a fresh UUID");
    assert!(row.created_at > 0);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn create_session_generates_unique_ids() {
    let t = build_test_app_state().await;
    let state = t.state();
    let a = create_session_impl(state, "A".into()).await.unwrap();
    let b = create_session_impl(state, "B".into()).await.unwrap();
    assert_ne!(a.id, b.id);
}

// === ensure_session ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn ensure_session_creates_new_row_with_source() {
    let t = build_test_app_state().await;
    let state = t.state();
    let row = ensure_session_impl(
        state,
        "bot-123".into(),
        "Bot Session".into(),
        "bot".into(),
        Some("discord:channel-42".into()),
    )
    .await
    .unwrap();
    assert_eq!(row.id, "bot-123");
    assert_eq!(row.source, "bot");
    assert_eq!(row.source_meta.as_deref(), Some("discord:channel-42"));

    // Confirm it's actually persisted.
    let all = list_sessions_impl(state).await.unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].id, "bot-123");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn ensure_session_is_idempotent_on_existing_id() {
    let t = build_test_app_state().await;
    let state = t.state();
    ensure_session_impl(state, "dup".into(), "First".into(), "chat".into(), None)
        .await
        .unwrap();
    // Second call with same id — INSERT OR IGNORE skips.
    ensure_session_impl(state, "dup".into(), "Second".into(), "chat".into(), None)
        .await
        .unwrap();

    let all = list_sessions_impl(state).await.unwrap();
    assert_eq!(all.len(), 1, "ensure should not duplicate rows");
}

// === rename_session ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn rename_session_updates_name() {
    let t = build_test_app_state().await;
    let state = t.state();
    let row = create_session_impl(state, "Old".into()).await.unwrap();
    rename_session_impl(state, row.id.clone(), "New".into())
        .await
        .unwrap();

    let all = list_sessions_impl(state).await.unwrap();
    let hit = all.iter().find(|s| s.id == row.id).unwrap();
    assert_eq!(hit.name, "New");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn rename_session_on_unknown_id_is_ok() {
    let t = build_test_app_state().await;
    // DB UPDATE with 0 matched rows returns Ok.
    rename_session_impl(t.state(), "missing".into(), "X".into())
        .await
        .unwrap();
}

// === list_chat_sessions ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_chat_sessions_filters_by_source() {
    let t = build_test_app_state().await;
    let state = t.state();
    // "chat" source via create_session.
    create_session_impl(state, "Chat A".into()).await.unwrap();
    // "bot" source via ensure_session — should be filtered out.
    ensure_session_impl(state, "b1".into(), "Bot".into(), "bot".into(), None)
        .await
        .unwrap();

    let chats = list_chat_sessions_impl(state, None, None).await.unwrap();
    assert_eq!(chats.len(), 1);
    assert_eq!(chats[0].source, "chat");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_chat_sessions_respects_limit_and_offset() {
    let t = build_test_app_state().await;
    let state = t.state();
    for i in 0..5 {
        create_session_impl(state, format!("Chat {}", i)).await.unwrap();
    }
    let limited = list_chat_sessions_impl(state, Some(2), Some(0)).await.unwrap();
    assert_eq!(limited.len(), 2);

    let offset = list_chat_sessions_impl(state, Some(10), Some(3)).await.unwrap();
    assert_eq!(offset.len(), 2); // 5 total - 3 offset = 2 rows
}

// === search_chat_sessions ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn search_chat_sessions_finds_matching_names() {
    let t = build_test_app_state().await;
    let state = t.state();
    create_session_impl(state, "alpha project".into()).await.unwrap();
    create_session_impl(state, "beta project".into()).await.unwrap();
    create_session_impl(state, "unrelated".into()).await.unwrap();

    let hits = search_chat_sessions_impl(state, "project".into(), None).await.unwrap();
    assert_eq!(hits.len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn search_chat_sessions_returns_empty_on_no_match() {
    let t = build_test_app_state().await;
    let state = t.state();
    create_session_impl(state, "alpha".into()).await.unwrap();

    let hits = search_chat_sessions_impl(state, "zzz-nope".into(), None).await.unwrap();
    assert!(hits.is_empty());
}

// === delete_session ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn delete_session_removes_existing_row() {
    let t = build_test_app_state().await;
    let state = t.state();
    let row = create_session_impl(state, "ToDelete".into()).await.unwrap();
    delete_session_impl(state, row.id.clone()).await.unwrap();

    let all = list_sessions_impl(state).await.unwrap();
    assert!(all.iter().find(|s| s.id == row.id).is_none());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn delete_session_on_unknown_id_is_ok() {
    let t = build_test_app_state().await;
    // DELETE with 0 matched rows returns Ok.
    delete_session_impl(t.state(), "never-existed".into()).await.unwrap();
}
