//! Integration tests for the Growth V3 Inbox CRUD layer.
//! Covers: insert / list / get / count / approve / reject / withdraw / dedup.
//! LLM-driven `propose_skills_from_history` is exercised at the deterministic
//! sub-function level via the in-module unit tests (in `skill_proposer.rs`);
//! end-to-end LLM calls are out of scope here.

mod common;

#[allow(unused_imports)]
use common::*;
use app_lib::engine::db::NewInboxItem;
use serial_test::serial;

fn sample_draft_json(name: &str) -> String {
    serde_json::json!({
        "name": name,
        "description": "test skill",
        "content": "---\nname: foo\n---\n# body\n",
        "confidence": 0.7,
        "reason": "test",
    })
    .to_string()
}

fn new_item(id: &str, name: &str) -> NewInboxItem {
    NewInboxItem {
        id: id.into(),
        kind: "skill_create".into(),
        draft_json: sample_draft_json(name),
        source: "user_request".into(),
        reason: "test reason".into(),
        confidence: 0.7,
        evidence_json: Some(r#"{"tools":["a","b"],"occurrence_count":3,"session_ids":["s1","s2","s3"]}"#.into()),
    }
}

#[test]
#[serial]
fn inbox_insert_then_list_returns_pending() {
    let t = TempDb::new();
    let db = t.db();
    db.insert_inbox_item(&new_item("id-1", "my-skill")).expect("insert");

    let pending = db.list_inbox_items(Some("pending"), 10);
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].id, "id-1");
    assert_eq!(pending[0].status, "pending");
    assert_eq!(pending[0].kind, "skill_create");

    assert_eq!(db.count_pending_inbox(), 1);
}

#[test]
#[serial]
fn inbox_get_by_id_returns_some() {
    let t = TempDb::new();
    let db = t.db();
    db.insert_inbox_item(&new_item("id-2", "skill-x")).expect("insert");

    let got = db.get_inbox_item("id-2").expect("found");
    assert_eq!(got.id, "id-2");
    assert!(got.evidence_json.is_some());

    let missing = db.get_inbox_item("nope");
    assert!(missing.is_none());
}

#[test]
#[serial]
fn inbox_approve_sets_status_and_action() {
    let t = TempDb::new();
    let db = t.db();
    db.insert_inbox_item(&new_item("id-3", "approve-me")).expect("insert");

    db.mark_inbox_approved("id-3", None, Some("looks good"))
        .expect("approve");

    let item = db.get_inbox_item("id-3").unwrap();
    assert_eq!(item.status, "approved");
    assert_eq!(item.user_action.as_deref(), Some("approve"));
    assert_eq!(item.user_note.as_deref(), Some("looks good"));
    assert!(item.reviewed_at.is_some());
    assert!(item.applied_at.is_none(), "applied_at set only after side-effect");

    db.mark_inbox_applied("id-3").expect("apply stamp");
    assert!(db.get_inbox_item("id-3").unwrap().applied_at.is_some());

    // Pending count drops to 0
    assert_eq!(db.count_pending_inbox(), 0);
}

#[test]
#[serial]
fn inbox_edit_approve_records_edited_payload() {
    let t = TempDb::new();
    let db = t.db();
    db.insert_inbox_item(&new_item("id-4", "edit-me")).expect("insert");

    let new_body = r##"{"name":"edit-me","content":"# new body"}"##;
    db.mark_inbox_approved("id-4", Some(new_body), None)
        .expect("edit approve");

    let item = db.get_inbox_item("id-4").unwrap();
    assert_eq!(item.status, "edited");
    assert_eq!(item.user_action.as_deref(), Some("edit_approve"));
    assert_eq!(item.user_edited_json.as_deref(), Some(new_body));
}

#[test]
#[serial]
fn inbox_reject_does_not_set_applied_at() {
    let t = TempDb::new();
    let db = t.db();
    db.insert_inbox_item(&new_item("id-5", "no-thanks")).expect("insert");

    db.reject_inbox_item("id-5", Some("not useful")).expect("reject");

    let item = db.get_inbox_item("id-5").unwrap();
    assert_eq!(item.status, "rejected");
    assert_eq!(item.user_action.as_deref(), Some("reject"));
    assert_eq!(item.user_note.as_deref(), Some("not useful"));
    assert!(item.applied_at.is_none());
}

#[test]
#[serial]
fn inbox_withdraw_marks_status() {
    let t = TempDb::new();
    let db = t.db();
    db.insert_inbox_item(&new_item("id-6", "withdraw-me")).expect("insert");

    db.withdraw_inbox_item("id-6").expect("withdraw");
    let item = db.get_inbox_item("id-6").unwrap();
    assert_eq!(item.status, "withdrawn");
    assert_eq!(item.user_action.as_deref(), Some("withdraw"));
}

#[test]
#[serial]
fn inbox_approve_idempotent_on_already_reviewed() {
    let t = TempDb::new();
    let db = t.db();
    db.insert_inbox_item(&new_item("id-7", "twice")).expect("insert");
    db.mark_inbox_approved("id-7", None, None).expect("first");
    // Second approve should be a no-op (WHERE status='pending' filter)
    db.mark_inbox_approved("id-7", None, Some("late note")).expect("second");
    let item = db.get_inbox_item("id-7").unwrap();
    assert_eq!(item.status, "approved");
    assert_ne!(item.user_note.as_deref(), Some("late note"), "late note must not overwrite");
}

#[test]
#[serial]
fn inbox_list_filters_by_status() {
    let t = TempDb::new();
    let db = t.db();
    db.insert_inbox_item(&new_item("id-a", "a")).expect("insert");
    db.insert_inbox_item(&new_item("id-b", "b")).expect("insert");
    db.insert_inbox_item(&new_item("id-c", "c")).expect("insert");
    db.reject_inbox_item("id-b", None).expect("reject");

    let pending = db.list_inbox_items(Some("pending"), 100);
    assert_eq!(pending.len(), 2);
    let rejected = db.list_inbox_items(Some("rejected"), 100);
    assert_eq!(rejected.len(), 1);
    let all = db.list_inbox_items(None, 100);
    assert_eq!(all.len(), 3);
}

#[test]
#[serial]
fn inbox_has_open_skill_proposal_detects_dup() {
    let t = TempDb::new();
    let db = t.db();
    db.insert_inbox_item(&new_item("id-x", "shared-name"))
        .expect("insert");
    assert!(db.has_open_skill_proposal("shared-name"));
    assert!(!db.has_open_skill_proposal("other-name"));

    // After rejection, no longer "open"
    db.reject_inbox_item("id-x", None).expect("reject");
    assert!(!db.has_open_skill_proposal("shared-name"));
}
