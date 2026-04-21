mod common;

#[allow(unused_imports)]
use common::*;
use app_lib::commands::tasks::*;
use serial_test::serial;

// Seed a task row directly via Database. Returns (task_id, session_id).
fn seed_task(
    t: &TestAppState,
    title: &str,
    parent_session_id: Option<&str>,
    status: &str,
) -> (String, String) {
    let task_id = uuid::Uuid::new_v4().to_string();
    let session_id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp();

    t.state()
        .db
        .ensure_session(&session_id, title, "task", Some(&task_id))
        .expect("ensure_session should succeed");
    t.state()
        .db
        .create_task(
            &task_id,
            title,
            Some("seeded-description"),
            status,
            &session_id,
            parent_session_id,
            None,
            0,
            now,
        )
        .expect("create_task should succeed");

    (task_id, session_id)
}

// === list_tasks ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_tasks_returns_empty_on_fresh_db() {
    let t = build_test_app_state().await;
    let tasks = list_tasks_impl(t.state(), None, None).await.unwrap();
    assert!(tasks.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_tasks_returns_seeded_tasks() {
    let t = build_test_app_state().await;
    let (id_a, _) = seed_task(&t, "alpha", None, "pending");
    let (id_b, _) = seed_task(&t, "beta", None, "running");
    let tasks = list_tasks_impl(t.state(), None, None).await.unwrap();
    assert_eq!(tasks.len(), 2);
    let ids: Vec<&str> = tasks.iter().map(|t| t.id.as_str()).collect();
    assert!(ids.contains(&id_a.as_str()));
    assert!(ids.contains(&id_b.as_str()));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_tasks_filters_by_status() {
    let t = build_test_app_state().await;
    let _ = seed_task(&t, "pend", None, "pending");
    let (running_id, _) = seed_task(&t, "run", None, "running");
    let tasks = list_tasks_impl(t.state(), None, Some("running".to_string()))
        .await
        .unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].id, running_id);
    assert_eq!(tasks[0].status, "running");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_tasks_filters_by_parent_session_id() {
    let t = build_test_app_state().await;
    let (match_id, _) = seed_task(&t, "with-parent", Some("parent-xyz"), "pending");
    let _ = seed_task(&t, "other-parent", Some("parent-abc"), "pending");
    let _ = seed_task(&t, "no-parent", None, "pending");
    let tasks = list_tasks_impl(t.state(), Some("parent-xyz".to_string()), None)
        .await
        .unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].id, match_id);
}

// === get_task_status ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_task_status_errors_on_missing_id() {
    let t = build_test_app_state().await;
    let err = get_task_status_impl(t.state(), "does-not-exist".to_string())
        .await
        .expect_err("missing task should error");
    assert!(err.contains("Task not found"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_task_status_returns_seeded_task() {
    let t = build_test_app_state().await;
    let (task_id, session_id) = seed_task(&t, "findable", None, "pending");
    let task = get_task_status_impl(t.state(), task_id.clone()).await.unwrap();
    assert_eq!(task.id, task_id);
    assert_eq!(task.title, "findable");
    assert_eq!(task.session_id, session_id);
    assert_eq!(task.status, "pending");
    assert_eq!(task.description.as_deref(), Some("seeded-description"));
}

// === get_task_by_name ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_task_by_name_returns_none_when_missing() {
    let t = build_test_app_state().await;
    let found = get_task_by_name_impl(t.state(), "nothing".to_string())
        .await
        .unwrap();
    assert!(found.is_none());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_task_by_name_returns_substring_match() {
    let t = build_test_app_state().await;
    let (task_id, _) = seed_task(&t, "my-important-report", None, "pending");
    let found = get_task_by_name_impl(t.state(), "important".to_string())
        .await
        .unwrap();
    let task = found.expect("should find by substring");
    assert_eq!(task.id, task_id);
    assert_eq!(task.title, "my-important-report");
}

// === list_all_tasks_brief ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_all_tasks_brief_empty_on_fresh_db() {
    let t = build_test_app_state().await;
    let tasks = list_all_tasks_brief_impl(t.state()).await.unwrap();
    assert!(tasks.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_all_tasks_brief_includes_all_statuses_and_parents() {
    let t = build_test_app_state().await;
    // Mix of statuses and parent-session values — list_all_tasks_brief ignores filters.
    let _ = seed_task(&t, "a", None, "pending");
    let _ = seed_task(&t, "b", Some("parent-1"), "running");
    let _ = seed_task(&t, "c", Some("parent-2"), "completed");
    let tasks = list_all_tasks_brief_impl(t.state()).await.unwrap();
    assert_eq!(tasks.len(), 3);
    let titles: Vec<&str> = tasks.iter().map(|t| t.title.as_str()).collect();
    assert!(titles.contains(&"a"));
    assert!(titles.contains(&"b"));
    assert!(titles.contains(&"c"));
}
