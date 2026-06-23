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
async fn companion_kind_worker_hidden_from_companion_lists_but_visible_in_group() {
    // 2026-06-11 伙伴/worker 边界:work 自动组队产生的成员标 kind='worker' ——
    // 不进伙伴列表(好友/委托/系统提示/冥想都走 list_active_companions),
    // 但仍是团队群成员(list_group_members),执行/派工不受影响。
    let t = TempDb::new();
    let db = t.db();
    let friend = db
        .adopt_companion(&app_lib::engine::db::NewCompanion {
            name: "阿狸".into(),
            agent_definition_name: "code_reviewer".into(),
            avatar_emoji: "🦊".into(),
            color_hex: "#F97316".into(),
            persona_md_path: None,
            memory_user_id: "c_friend".into(),
            metadata_json: None,
            role_label: None,
        })
        .unwrap();
    let worker = db
        .adopt_companion(&app_lib::engine::db::NewCompanion {
            name: "前端临时工".into(),
            agent_definition_name: "dyn_frontend".into(),
            avatar_emoji: "💻".into(),
            color_hex: "#10B981".into(),
            persona_md_path: None,
            memory_user_id: "c_worker".into(),
            metadata_json: None,
            role_label: None,
        })
        .unwrap();
    db.set_companion_kind(worker, "worker").unwrap();

    let actives = db.list_active_companions();
    assert!(actives.iter().any(|c| c.id == friend), "伙伴在列表里");
    assert!(
        !actives.iter().any(|c| c.id == worker),
        "worker 不该出现在伙伴列表",
    );

    // worker 仍是团队群成员(work 执行面不受影响);伙伴也能被拉进同一个群。
    let gid = db.create_companion_group("美味工坊", None, None).unwrap();
    db.add_group_member(gid, worker).unwrap();
    db.add_group_member(gid, friend).unwrap();
    let members = db.list_group_members(gid);
    assert!(members.iter().any(|c| c.id == worker), "worker 在团队群里可见");
    assert!(members.iter().any(|c| c.id == friend), "伙伴可被拉进 work 团队");

    // 退休的 worker 也不该出现在「恢复伙伴」列表。
    db.retire_companion(worker).unwrap();
    assert!(
        !db.list_retired_companions().iter().any(|c| c.id == worker),
        "退休 worker 不进恢复列表",
    );
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_work_jobs_reads_job_state_machine_not_collab_status() {
    // R3:列表来自 work_jobs 薄表(job 级状态机),不再从协作 status 倒推 ——
    // intake 协作 done ≠ 已交付;chat 协作与无 job 行的会话都不该出现。
    let t = TempDb::new();
    let db = t.db();
    let _chat = insert_bare_collaboration(&t, "sess-wj"); // 默认 chat_group,无 job 行
    db.create_work_job("sess-job", "做个 app", Some(7)).unwrap();
    // sessions 行(list_work_jobs INNER JOIN sessions 过滤孤儿)。
    {
        let conn = db.get_conn().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "INSERT OR IGNORE INTO sessions (id, name, created_at, updated_at) VALUES ('sess-job', '做个 app', ?1, ?1)",
            rusqlite::params![now],
        )
        .unwrap();
    }

    let jobs = db.list_work_jobs();
    assert_eq!(jobs.len(), 1, "只列 work_jobs 表里的 job");
    assert_eq!(jobs[0].session_id, "sess-job");
    assert_eq!(jobs[0].status, "clarifying", "新 job 初始态 = 澄清中");

    // 状态机推进:pending_commit → running → done(终态写 completed_at)。
    db.set_work_job_status("sess-job", "pending_commit").unwrap();
    assert_eq!(db.get_work_job_status("sess-job").as_deref(), Some("pending_commit"));
    db.set_work_job_status("sess-job", "done").unwrap();
    let jobs = db.list_work_jobs();
    assert_eq!(jobs[0].status, "done");
    assert!(jobs[0].completed_at.is_some(), "终态应写 completed_at");

    // lead 固化可读回。
    assert_eq!(db.get_work_job_lead("sess-job"), Some(7));

    // 孤儿过滤:job 行在、session 没有 → 不出现(幽灵条目)。
    db.create_work_job("sess-ghost-没有session行", "幽灵", None).unwrap();
    {
        let conn = db.get_conn().unwrap();
        conn.execute("DELETE FROM sessions WHERE id = 'sess-ghost-没有session行'", []).unwrap();
    }
    assert!(
        !db.list_work_jobs().iter().any(|j| j.session_id.contains("ghost")),
        "无 session 的孤儿 job 不该出现",
    );
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn reap_stale_work_collab_syncs_job_to_failed_with_resume_hint() {
    // #1(2026-06-14):app 重启把在途 work 协作 reap 成 aborted —— 但必须同步 work_jobs,
    // 否则 job 在 Work 列表仍撒谎「进行中」。验:reap 后 job=failed + 一条可见中断消息。
    let t = TempDb::new();
    let db = t.db();
    let sid = "work-reaped";
    {
        let conn = db.get_conn().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "INSERT INTO sessions (id, name, created_at, updated_at) VALUES (?1, 'w', ?2, ?2)",
            rusqlite::params![sid, now],
        )
        .unwrap();
        // 一条 running 的 work_dispatch 协作(重启遗留的孤儿)。
        conn.execute(
            "INSERT INTO collaborations (chat_session_id, intent, mode_json, status, plan_json, created_at, kind)
             VALUES (?1, '做个 app', '\"Manual\"', 'running', '{\"steps\":[]}', ?2, 'work_dispatch')",
            rusqlite::params![sid, now],
        )
        .unwrap();
    }
    db.create_work_job(sid, "做个 app", Some(1)).unwrap();
    db.set_work_job_status(sid, "running").unwrap();

    db.reap_stale_collaborations();

    // job 不再撒谎「running」,落 failed(可由 followup 重新激活续做)。
    assert_eq!(
        db.get_work_job_status(sid).as_deref(),
        Some("failed"),
        "reap 后 work_jobs 应同步成 failed,不再显示进行中",
    );
    // 一条诚实的中断提示消息(work_job 上下文)。
    let msgs = db.get_messages(sid, None).unwrap();
    assert!(
        msgs.iter().any(|m| m.context_type.as_deref() == Some("work_job")
            && m.content.contains("重启时被中断")),
        "应写一条可见的中断/可重发消息",
    );

    // 已是终态的 job 不被 reap 改动(幂等)。
    let sid2 = "work-already-done";
    {
        let conn = db.get_conn().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "INSERT INTO sessions (id, name, created_at, updated_at) VALUES (?1, 'w2', ?2, ?2)",
            rusqlite::params![sid2, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO collaborations (chat_session_id, intent, mode_json, status, plan_json, created_at, kind)
             VALUES (?1, 'x', '\"Manual\"', 'done', '{\"steps\":[]}', ?2, 'work_dispatch')",
            rusqlite::params![sid2, now],
        )
        .unwrap();
    }
    db.create_work_job(sid2, "x", None).unwrap();
    db.set_work_job_status(sid2, "done").unwrap();
    db.reap_stale_collaborations();
    assert_eq!(db.get_work_job_status(sid2).as_deref(), Some("done"), "终态 job 不被 reap 动");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn retire_chat_group_sessions_deletes_chat_groups_keeps_work_and_solo() {
    // 2026-06-15:chat 多分身群聊退役 —— 启动清理删 source='chat'+group 的会话,
    // 不动 work 会话(source='work')和单聊(无 group)。
    let t = TempDb::new();
    let db = t.db();
    let now = chrono::Utc::now().timestamp_millis();
    let mk = |id: &str, source: &str, gid: Option<i64>| {
        // 先在 block 里建 session 再放锁 —— get_conn() 是单连接 Mutex 守卫,
        // 持锁时调 push_message(内部又 get_conn)会自死锁。
        {
            let conn = db.get_conn().unwrap();
            conn.execute(
                "INSERT INTO sessions (id, name, created_at, updated_at, source, group_id) VALUES (?1, ?1, ?2, ?2, ?3, ?4)",
                rusqlite::params![id, now, source, gid],
            )
            .unwrap();
        }
        // 一条消息,验 cascade。
        db.push_message(id, "user", "hi").unwrap();
    };
    mk("chat-group", "chat", Some(1)); // 群聊 —— 该删
    mk("chat-solo", "chat", None);     // 单聊 —— 留
    mk("work-job", "work", Some(2));   // work 团队 —— 留

    db.retire_chat_group_sessions();

    let ids: std::collections::HashSet<String> =
        db.list_sessions().unwrap().into_iter().map(|s| s.id).collect();
    assert!(!ids.contains("chat-group"), "chat 群聊会话应被删除");
    assert!(ids.contains("chat-solo"), "单聊应保留");
    assert!(ids.contains("work-job"), "work 会话应保留");
    // 群聊会话的消息也随 FK cascade 清掉。
    assert!(db.get_messages("chat-group", None).unwrap().is_empty(), "群聊消息应随会话删除");
    assert!(!db.get_messages("chat-solo", None).unwrap().is_empty(), "单聊消息应保留");
}
