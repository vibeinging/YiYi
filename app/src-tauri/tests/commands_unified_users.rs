mod common;

#[allow(unused_imports)]
use common::*;
use app_lib::commands::unified_users::*;
use serial_test::serial;

// === unified_users_list ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn unified_users_list_returns_empty_on_fresh_db() {
    let t = build_test_app_state().await;
    let users = unified_users_list_impl(t.state()).await.unwrap();
    assert!(users.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn unified_users_list_returns_created_users_with_identities() {
    let t = build_test_app_state().await;
    let state = t.state();

    let alice = unified_users_create_impl(state, Some("Alice".to_string()))
        .await
        .unwrap();
    let _bob = unified_users_create_impl(state, Some("Bob".to_string()))
        .await
        .unwrap();

    // Link an identity to Alice so we can verify identity embedding.
    unified_users_link_impl(
        state,
        alice.id.clone(),
        "discord".to_string(),
        "alice#1234".to_string(),
        "bot-a".to_string(),
        Some("Alice D".to_string()),
    )
    .await
    .unwrap();

    let users = unified_users_list_impl(state).await.unwrap();
    assert_eq!(users.len(), 2);

    let listed_alice = users.iter().find(|u| u.id == alice.id).unwrap();
    assert_eq!(listed_alice.display_name.as_deref(), Some("Alice"));
    assert_eq!(listed_alice.identities.len(), 1);
    assert_eq!(listed_alice.identities[0].platform, "discord");
    assert_eq!(listed_alice.identities[0].platform_user_id, "alice#1234");
}

// === unified_users_create ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn unified_users_create_with_display_name_persists() {
    let t = build_test_app_state().await;
    let state = t.state();

    let created = unified_users_create_impl(state, Some("Charlie".to_string()))
        .await
        .unwrap();
    assert!(!created.id.is_empty());
    assert_eq!(created.display_name.as_deref(), Some("Charlie"));
    assert!(created.identities.is_empty());

    // Verify it's in the DB.
    let row = state.db.get_unified_user(&created.id).unwrap();
    assert!(row.is_some());
    assert_eq!(row.unwrap().display_name.as_deref(), Some("Charlie"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn unified_users_create_without_display_name_is_ok() {
    let t = build_test_app_state().await;
    let state = t.state();

    let created = unified_users_create_impl(state, None).await.unwrap();
    assert!(!created.id.is_empty());
    assert!(created.display_name.is_none());
}

// === unified_users_link ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn unified_users_link_attaches_identity_to_user() {
    let t = build_test_app_state().await;
    let state = t.state();

    let user = unified_users_create_impl(state, Some("LinkTest".to_string()))
        .await
        .unwrap();
    unified_users_link_impl(
        state,
        user.id.clone(),
        "telegram".to_string(),
        "12345".to_string(),
        "bot-x".to_string(),
        Some("Linked Name".to_string()),
    )
    .await
    .unwrap();

    let identities = state.db.list_user_identities(&user.id).unwrap();
    assert_eq!(identities.len(), 1);
    assert_eq!(identities[0].platform, "telegram");
    assert_eq!(identities[0].platform_user_id, "12345");
    assert_eq!(identities[0].bot_id, "bot-x");
    assert_eq!(identities[0].display_name.as_deref(), Some("Linked Name"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn unified_users_link_errors_on_nonexistent_user() {
    let t = build_test_app_state().await;
    let state = t.state();

    let err = unified_users_link_impl(
        state,
        "ghost-user-id".to_string(),
        "discord".to_string(),
        "someone".to_string(),
        "bot-a".to_string(),
        None,
    )
    .await
    .unwrap_err();
    assert!(err.contains("not found"), "expected not-found error, got: {err}");
}

// === unified_users_unlink ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn unified_users_unlink_removes_linked_identity() {
    let t = build_test_app_state().await;
    let state = t.state();

    let user = unified_users_create_impl(state, Some("UnlinkTest".to_string()))
        .await
        .unwrap();
    unified_users_link_impl(
        state,
        user.id.clone(),
        "qq".to_string(),
        "999".to_string(),
        "bot-q".to_string(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(state.db.list_user_identities(&user.id).unwrap().len(), 1);

    unified_users_unlink_impl(
        state,
        "qq".to_string(),
        "999".to_string(),
        "bot-q".to_string(),
    )
    .await
    .unwrap();

    assert!(state.db.list_user_identities(&user.id).unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn unified_users_unlink_on_nonexistent_identity_is_idempotent() {
    let t = build_test_app_state().await;
    let state = t.state();

    // Unlinking an identity that was never linked should succeed (no-op DELETE).
    unified_users_unlink_impl(
        state,
        "telegram".to_string(),
        "never-existed".to_string(),
        "some-bot".to_string(),
    )
    .await
    .expect("unlink of unknown identity should be idempotent Ok");
}
