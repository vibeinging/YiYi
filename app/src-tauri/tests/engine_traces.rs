//! Integration tests for the agent_traces table.

mod common;

#[allow(unused_imports)]
use common::*;
use app_lib::engine::db::NewAgentTrace;
use serial_test::serial;

fn sample_trace<'a>(session: &'a str, turn: i64, role: &'a str) -> NewAgentTrace<'a> {
    NewAgentTrace {
        session_id: session,
        task_id: None,
        turn_index: turn,
        role,
        content: Some("hello"),
        reasoning_content: None,
        tool_calls_json: None,
        tool_call_id: None,
        model: Some("deepseek-v4"),
    }
}

#[test]
#[serial]
fn trace_record_and_list_round_trip() {
    let t = TempDb::new();
    let db = t.db();
    db.record_trace(&sample_trace("sess-1", 1, "user")).expect("insert user");
    db.record_trace(&sample_trace("sess-1", 2, "assistant")).expect("insert asst");
    db.record_trace(&sample_trace("sess-2", 1, "user")).expect("insert other");

    let s1 = db.list_traces_for_session("sess-1");
    assert_eq!(s1.len(), 2);
    assert_eq!(s1[0].turn_index, 1);
    assert_eq!(s1[1].turn_index, 2);
    assert_eq!(s1[1].role, "assistant");

    let s2 = db.list_traces_for_session("sess-2");
    assert_eq!(s2.len(), 1);

    assert_eq!(db.count_traces(), 3);
}

#[test]
#[serial]
fn trace_clear_wipes_all() {
    let t = TempDb::new();
    let db = t.db();
    db.record_trace(&sample_trace("s", 1, "user")).expect("insert");
    db.record_trace(&sample_trace("s", 2, "assistant")).expect("insert");
    assert_eq!(db.count_traces(), 2);
    let deleted = db.clear_traces().expect("clear");
    assert_eq!(deleted, 2);
    assert_eq!(db.count_traces(), 0);
}

#[test]
#[serial]
fn trace_gc_drops_old_keeps_fresh() {
    let t = TempDb::new();
    let db = t.db();
    db.record_trace(&sample_trace("s", 1, "user")).expect("insert fresh");
    db.record_trace(&sample_trace("s", 2, "assistant")).expect("insert stale");

    // Backdate row id=2 past the 30-day cutoff
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    let stale_ts = now - 40 * 86_400_000;
    {
        let conn = db.get_conn().expect("conn");
        conn.execute(
            "UPDATE agent_traces SET created_at = ?1 WHERE turn_index = 2",
            rusqlite::params![stale_ts],
        ).expect("backdate");
    }

    let dropped = db.gc_old_traces(30).expect("gc");
    assert_eq!(dropped, 1);
    assert_eq!(db.count_traces(), 1);
    let remaining = db.list_traces_for_session("s");
    assert_eq!(remaining[0].turn_index, 1, "the fresh row survives");
}
