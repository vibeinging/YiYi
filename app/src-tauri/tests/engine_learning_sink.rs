//! Integration tests for the SQLite-backed LearningSink — covers
//! round-tripping every LearningSignal variant + ordering invariants for
//! `recent()`.

mod common;

#[allow(unused_imports)]
use common::*;
use app_lib::engine::collaboration::learning::{
    sqlite_sink::SqliteLearningSink, LearningSignal, LearningSink,
};
use app_lib::engine::collaboration::CollaborationPlan;
use serial_test::serial;

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn dispatch_recalled_round_trips() {
    let t = TempDb::new();
    let sink = SqliteLearningSink::new(t.db());
    let signal = LearningSignal::DispatchRecalled {
        collaboration_id: 7,
        original_plan: CollaborationPlan::default(),
    };
    sink.record(signal.clone()).await.expect("record");

    let recent = sink.recent(10).await.expect("recent");
    assert_eq!(recent.len(), 1);
    match &recent[0] {
        LearningSignal::DispatchRecalled { collaboration_id, .. } => {
            assert_eq!(*collaboration_id, 7);
        }
        other => panic!("expected DispatchRecalled, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn verdict_rejected_preserves_user_note() {
    let t = TempDb::new();
    let sink = SqliteLearningSink::new(t.db());
    sink.record(LearningSignal::VerdictRejected {
        collaboration_id: 3,
        user_note: "阿狸说得不对，我觉得应该用 Rust".into(),
    })
    .await
    .expect("record");

    let recent = sink.recent(10).await.expect("recent");
    match &recent[0] {
        LearningSignal::VerdictRejected { user_note, .. } => {
            assert_eq!(user_note, "阿狸说得不对，我觉得应该用 Rust");
        }
        other => panic!("expected VerdictRejected, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn recent_returns_newest_first() {
    let t = TempDb::new();
    let sink = SqliteLearningSink::new(t.db());

    sink.record(LearningSignal::VerdictAccepted { collaboration_id: 1 })
        .await
        .unwrap();
    // Ensure created_at differs (millis-resolution timestamps in db::now_ts).
    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    sink.record(LearningSignal::VerdictAccepted { collaboration_id: 2 })
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    sink.record(LearningSignal::VerdictAccepted { collaboration_id: 3 })
        .await
        .unwrap();

    let recent = sink.recent(10).await.expect("recent");
    let ids: Vec<i64> = recent
        .iter()
        .map(|s| match s {
            LearningSignal::VerdictAccepted { collaboration_id } => *collaboration_id,
            _ => unreachable!(),
        })
        .collect();
    assert_eq!(ids, vec![3, 2, 1]);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn recent_respects_limit() {
    let t = TempDb::new();
    let sink = SqliteLearningSink::new(t.db());

    for i in 0..5 {
        sink.record(LearningSignal::VerdictAccepted { collaboration_id: i })
            .await
            .unwrap();
    }
    let recent = sink.recent(2).await.expect("recent");
    assert_eq!(recent.len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn plan_aborted_at_step_optional_round_trips() {
    let t = TempDb::new();
    let sink = SqliteLearningSink::new(t.db());

    sink.record(LearningSignal::PlanAborted {
        collaboration_id: 1,
        at_step: None,
    })
    .await
    .unwrap();
    sink.record(LearningSignal::PlanAborted {
        collaboration_id: 2,
        at_step: Some(42),
    })
    .await
    .unwrap();

    let recent = sink.recent(10).await.expect("recent");
    let aborts: Vec<Option<i64>> = recent
        .iter()
        .filter_map(|s| match s {
            LearningSignal::PlanAborted { at_step, .. } => Some(*at_step),
            _ => None,
        })
        .collect();
    // Newest first: Some(42), then None.
    assert_eq!(aborts, vec![Some(42), None]);
}
