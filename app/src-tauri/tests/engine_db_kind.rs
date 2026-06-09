//! S1(chat×work 2×2 正交化)数据判别器迁移测试。
//!
//! 验:`collaborations.kind` / `messages.context_type` 两列经 `Database::open` 的迁移
//! 建出、默认值正确(旧数据/未指定一律落 chat 侧:'chat_group' / 'collab'),
//! 且 `set/get/list_collaborations_by_kind` 往返正确。TempDb 隔离 + #[serial]。

mod common;

#[allow(unused_imports)]
use common::*;
use serial_test::serial;

/// 直接建一条 collaboration 行(不经 orchestrator),返回其 id。
/// 故意**不指定 kind** —— 验列默认值。chat_session_id FK 到 sessions,先建 session。
fn insert_bare_collaboration(t: &TempDb, session_id: &str) -> i64 {
    let db = t.db();
    let conn = db.get_conn().unwrap();
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT OR IGNORE INTO sessions (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
        rusqlite::params![session_id, "test", now],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO collaborations (chat_session_id, intent, mode_json, status, plan_json, created_at)
         VALUES (?1, ?2, '\"Manual\"', 'planning', '{\"steps\":[]}', ?3)",
        rusqlite::params![session_id, "做点事", now],
    )
    .unwrap();
    conn.last_insert_rowid()
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn collaboration_kind_defaults_chat_group_and_roundtrips() {
    let t = TempDb::new();
    let cid = insert_bare_collaboration(&t, "sess-kind");

    // 未指定 kind → 列默认 'chat_group'(迁移前数据/普通群聊一律按 chat)。
    assert_eq!(
        t.db().get_collaboration_kind(cid).as_deref(),
        Some("chat_group"),
        "新建未指定 kind 应默认 chat_group",
    );

    // 派工路径标 work_dispatch → 往返一致。
    t.db().set_collaboration_kind(cid, "work_dispatch").unwrap();
    assert_eq!(
        t.db().get_collaboration_kind(cid).as_deref(),
        Some("work_dispatch"),
    );

    // by_kind 查询:work_dispatch 命中本 id;chat_group 不含它。
    assert!(t.db().list_collaborations_by_kind("work_dispatch").contains(&cid));
    assert!(!t.db().list_collaborations_by_kind("chat_group").contains(&cid));

    // 不存在的协作:get 返回 None,set 不 panic(no-op)。
    assert_eq!(t.db().get_collaboration_kind(999_999), None);
    t.db().set_collaboration_kind(999_999, "work_dispatch").unwrap();
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn message_context_type_defaults_collab() {
    let t = TempDb::new();
    let db = t.db();
    let conn = db.get_conn().unwrap();
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT OR IGNORE INTO sessions (id, name, created_at, updated_at) VALUES ('s-ctx', 'test', ?1, ?1)",
        rusqlite::params![now],
    )
    .unwrap();
    // 不指定 context_type 插一条消息(等价旧的 push_message 写法)→ 应默认 'collab'。
    conn.execute(
        "INSERT INTO messages (session_id, role, content, timestamp) VALUES ('s-ctx', 'assistant', 'hi', ?1)",
        rusqlite::params![now],
    )
    .unwrap();
    let ctx: Option<String> = conn
        .query_row(
            "SELECT context_type FROM messages WHERE session_id = 's-ctx' LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(ctx.as_deref(), Some("collab"), "未指定 context_type 应默认 collab");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_work_jobs_returns_only_work_dispatch() {
    let t = TempDb::new();
    let chat = insert_bare_collaboration(&t, "sess-wj"); // 默认 chat_group
    let work = insert_bare_collaboration(&t, "sess-wj");
    t.db().set_collaboration_kind(work, "work_dispatch").unwrap();

    let jobs = t.db().list_work_jobs();
    // 只列 work_dispatch 的;chat 那条不在
    assert_eq!(jobs.len(), 1, "list_work_jobs 只列 kind=work_dispatch");
    assert_eq!(jobs[0].id, work);
    assert_eq!(jobs[0].intent, "做点事");
    assert_eq!(jobs[0].status, "planning");
    assert_eq!(jobs[0].session_id, "sess-wj");
    assert!(!jobs.iter().any(|j| j.id == chat), "chat 协作不该出现在 work job 列表");
}
