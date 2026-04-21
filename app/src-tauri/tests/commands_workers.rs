mod common;

#[allow(unused_imports)]
use common::*;
use app_lib::commands::workers::{list_workers_impl, resolve_worker_trust_impl};
use app_lib::engine::worker::{WorkerRegistry, WorkerState};

#[test]
fn list_workers_returns_empty_on_fresh_registry() {
    let reg = WorkerRegistry::new();
    let workers = list_workers_impl(&reg);
    assert!(workers.is_empty());
}

#[test]
fn list_workers_returns_registered_workers() {
    let reg = WorkerRegistry::new();
    let id_a = reg.spawn("worker-a");
    let id_b = reg.spawn("worker-b");

    let workers = list_workers_impl(&reg);
    assert_eq!(workers.len(), 2);

    let ids: Vec<&str> = workers.iter().map(|w| w.id.as_str()).collect();
    assert!(ids.contains(&id_a.as_str()));
    assert!(ids.contains(&id_b.as_str()));

    // Fresh-spawned workers should all be in "spawning" state.
    for w in &workers {
        assert_eq!(w.state, "spawning");
        assert_eq!(w.event_count, 1); // Only the initial Spawned event.
    }
}

#[test]
fn resolve_worker_trust_errors_on_unknown_worker_id() {
    let reg = WorkerRegistry::new();
    let result = resolve_worker_trust_impl(&reg, "nonexistent".to_string(), true);
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("not found"));
}

#[test]
fn resolve_worker_trust_approves_pending_worker() {
    let reg = WorkerRegistry::new();
    let id = reg.spawn("pending");
    // Move into TrustRequired state so resolve_trust has something to do.
    reg.transition(
        &id,
        WorkerState::TrustRequired {
            prompt_text: "allow access?".into(),
        },
    )
    .unwrap();

    // Approve the trust prompt.
    resolve_worker_trust_impl(&reg, id.clone(), true).unwrap();

    let workers = list_workers_impl(&reg);
    let w = workers.iter().find(|w| w.id == id).unwrap();
    assert_eq!(w.state, "ready");
}

#[test]
fn resolve_worker_trust_denies_pending_worker() {
    let reg = WorkerRegistry::new();
    let id = reg.spawn("pending-deny");
    reg.transition(
        &id,
        WorkerState::TrustRequired {
            prompt_text: "allow?".into(),
        },
    )
    .unwrap();

    resolve_worker_trust_impl(&reg, id.clone(), false).unwrap();

    let workers = list_workers_impl(&reg);
    let w = workers.iter().find(|w| w.id == id).unwrap();
    assert_eq!(w.state, "failed");
}
