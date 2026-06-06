//! Integration tests for `pending_questions` CRUD —— `ask_user`(F1)的跨会话
//! 持久化层。覆盖:落库 / 按会话列未答 / 标记已答后从未答消失 / 去重命中已答 /
//! 跨会话隔离。

mod common;

#[allow(unused_imports)]
use common::*;
use app_lib::engine::db::PendingQuestion;
use serial_test::serial;

fn sample(request_id: &str, session_id: &str, question: &str) -> PendingQuestion {
    PendingQuestion {
        request_id: request_id.into(),
        session_id: session_id.into(),
        collaboration_id: None,
        step_id: None,
        companion_id: 0,
        asker_name: "YiYi".into(),
        question: question.into(),
        options_json: None,
        kind: "text".into(),
        status: "pending".into(),
        answer: None,
        created_at: 1_700_000_000_000,
        answered_at: None,
    }
}

#[test]
#[serial]
fn questions_insert_then_list_pending_returns_row() {
    let t = TempDb::new();
    let db = t.db();
    db.insert_pending_question(&sample("req-1", "sess-a", "用什么框架?"))
        .unwrap();

    let pending = db.list_pending_questions("sess-a");
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].request_id, "req-1");
    assert_eq!(pending[0].question, "用什么框架?");
    assert_eq!(pending[0].status, "pending");
}

#[test]
#[serial]
fn questions_mark_answered_drops_from_pending_and_dedup_hits() {
    let t = TempDb::new();
    let db = t.db();
    db.insert_pending_question(&sample("req-2", "sess-b", "要深色模式吗?"))
        .unwrap();

    db.mark_question_answered("req-2", "要").unwrap();

    // 已答 → 不再出现在未答列表。
    assert!(db.list_pending_questions("sess-b").is_empty());

    // 去重:同会话同问题再问 → 直接命中已答答案。
    assert_eq!(
        db.find_answered_question("sess-b", "要深色模式吗?"),
        Some("要".to_string())
    );

    // 单行查询能读回答案。
    let row = db.get_pending_question("req-2").unwrap();
    assert_eq!(row.status, "answered");
    assert_eq!(row.answer.as_deref(), Some("要"));
    assert!(row.answered_at.is_some());
}

#[test]
#[serial]
fn questions_find_answered_returns_none_when_only_pending() {
    let t = TempDb::new();
    let db = t.db();
    db.insert_pending_question(&sample("req-3", "sess-c", "还没答的问题"))
        .unwrap();

    // 仍 pending → 去重不该命中(否则会拿到空答案误导 agent)。
    assert_eq!(db.find_answered_question("sess-c", "还没答的问题"), None);
}

#[test]
#[serial]
fn questions_list_pending_isolates_by_session() {
    let t = TempDb::new();
    let db = t.db();
    db.insert_pending_question(&sample("req-4", "sess-x", "x 的问题"))
        .unwrap();
    db.insert_pending_question(&sample("req-5", "sess-y", "y 的问题"))
        .unwrap();

    let x = db.list_pending_questions("sess-x");
    assert_eq!(x.len(), 1);
    assert_eq!(x[0].request_id, "req-4");

    // 空 session_id → 拉全部未答(无会话上下文的兜底)。
    let all = db.list_pending_questions("");
    assert_eq!(all.len(), 2);
}
