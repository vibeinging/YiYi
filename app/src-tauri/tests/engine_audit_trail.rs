//! AuditTrail integration tests — covers persistent write + live broadcast
//! happening as a single atomic operation.

mod common;

#[allow(unused_imports)]
use common::*;
use app_lib::engine::collaboration::audit::AuditTrail;
use app_lib::engine::collaboration::{events, Actor, AuditKind, CollaborationEvent};
use serde_json::json;
use serial_test::serial;

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn emit_persists_and_can_be_listed() {
    let t = TempDb::new();
    let trail = AuditTrail::new(t.db());

    trail
        .emit(1, Actor::System, AuditKind::Submitted, json!({"plan_size": 3}))
        .expect("emit submitted");
    trail
        .emit(1, Actor::User, AuditKind::Confirmed, json!(null))
        .expect("emit confirmed");

    let events_list = trail.list(1).expect("list");
    assert_eq!(events_list.len(), 2);
    assert_eq!(events_list[0].kind, AuditKind::Submitted);
    assert_eq!(events_list[0].actor, Actor::System);
    assert_eq!(events_list[1].kind, AuditKind::Confirmed);
    assert_eq!(events_list[1].actor, Actor::User);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn emit_broadcasts_live_event_to_subscribers() {
    let t = TempDb::new();
    let trail = AuditTrail::new(t.db());
    let mut rx = events::subscribe();

    trail
        .emit(
            42,
            Actor::Companion(7),
            AuditKind::StepStarted,
            json!({"step_id": 1}),
        )
        .expect("emit");

    let event = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv())
        .await
        .expect("recv timeout")
        .expect("recv");
    match event {
        CollaborationEvent::Audit { event: a } => {
            assert_eq!(a.collaboration_id, 42);
            assert_eq!(a.actor, Actor::Companion(7));
            assert_eq!(a.kind, AuditKind::StepStarted);
            assert_eq!(a.payload["step_id"], 1);
        }
        _ => panic!("expected Audit event"),
    }
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_returns_oldest_first() {
    let t = TempDb::new();
    let trail = AuditTrail::new(t.db());

    trail.emit(5, Actor::System, AuditKind::Submitted, json!(null)).unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    trail.emit(5, Actor::System, AuditKind::StepStarted, json!(null)).unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    trail.emit(5, Actor::User, AuditKind::Aborted, json!(null)).unwrap();

    let events_list = trail.list(5).expect("list");
    let kinds: Vec<AuditKind> = events_list.iter().map(|e| e.kind.clone()).collect();
    assert_eq!(
        kinds,
        vec![AuditKind::Submitted, AuditKind::StepStarted, AuditKind::Aborted]
    );
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_isolates_by_collaboration_id() {
    let t = TempDb::new();
    let trail = AuditTrail::new(t.db());

    trail.emit(1, Actor::System, AuditKind::Submitted, json!(null)).unwrap();
    trail.emit(2, Actor::System, AuditKind::Submitted, json!(null)).unwrap();
    trail.emit(2, Actor::User, AuditKind::Confirmed, json!(null)).unwrap();

    let only_1 = trail.list(1).unwrap();
    let only_2 = trail.list(2).unwrap();
    assert_eq!(only_1.len(), 1);
    assert_eq!(only_2.len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn payload_survives_round_trip_with_complex_json() {
    let t = TempDb::new();
    let trail = AuditTrail::new(t.db());

    let payload = json!({
        "reason": "高 confidence 派遣到阿狸",
        "plan": {
            "steps": [{"kind": "single_agent", "companion": 7}]
        },
        "metrics": {"confidence": 0.92, "tokens": 1453}
    });
    trail
        .emit(1, Actor::Companion(0), AuditKind::DispatchJudged, payload.clone())
        .unwrap();
    let events_list = trail.list(1).unwrap();
    assert_eq!(events_list[0].payload, payload);
}
