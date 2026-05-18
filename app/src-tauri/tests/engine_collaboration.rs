//! Integration tests for `SqliteOrchestrator` — covers the full state
//! machine (submit / confirm / abort / mutate), DAG dependency
//! resolution, audit log completeness, and step failure / retry paths.
//!
//! Uses a `MockExecutor` so the tests run in milliseconds and don't
//! touch the LLM. The real `Executor` (`engine/collaboration/executor.rs`,
//! Phase 2A.6) is tested separately with its own fixtures.

mod common;

#[allow(unused_imports)]
use common::*;
use app_lib::engine::agents::MemoryScope;
use app_lib::engine::collaboration::{
    audit::AuditTrail,
    orchestrator::SqliteOrchestrator,
    Actor, AuditKind, CollaborationId, CollaborationMode, CollaborationOrchestrator,
    CollaborationPlan, CollaborationStatus, Executor, ExecutorHandle, Mutation, Participant, Step,
    StepId, StepInput, StepKind, StepOutput, StepStatus, TokenUsage,
};
use async_trait::async_trait;
use serial_test::serial;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Step outcome the mock should return.
#[derive(Clone)]
enum MockOutcome {
    Success(StepOutput),
    Failure(String),
}

fn default_success_output() -> StepOutput {
    StepOutput {
        summary: "mock summary".into(),
        full_output: "mock full output".into(),
        tokens_used: TokenUsage { input: 100, output: 50 },
        duration_ms: 1,
    }
}

/// Test-only Executor. Records every invocation; returns configured
/// outcomes (default: success with `default_success_output()`).
struct MockExecutor {
    outcomes: Mutex<HashMap<StepId, MockOutcome>>,
    invocations: Mutex<Vec<StepId>>,
    /// Optional delay before resolving, lets tests verify "running" state.
    delay: Duration,
}

impl MockExecutor {
    fn new() -> Self {
        Self::with_delay(Duration::from_millis(0))
    }

    fn with_delay(delay: Duration) -> Self {
        Self {
            outcomes: Mutex::new(HashMap::new()),
            invocations: Mutex::new(Vec::new()),
            delay,
        }
    }

    fn handle(self: Arc<Self>) -> ExecutorHandle {
        self
    }

    fn fail_step(&self, step_id: StepId, reason: &str) {
        self.outcomes
            .lock()
            .unwrap()
            .insert(step_id, MockOutcome::Failure(reason.into()));
    }

    fn succeed_with(&self, step_id: StepId, output: StepOutput) {
        self.outcomes
            .lock()
            .unwrap()
            .insert(step_id, MockOutcome::Success(output));
    }

    fn invocations(&self) -> Vec<StepId> {
        self.invocations.lock().unwrap().clone()
    }
}

#[async_trait]
impl Executor for MockExecutor {
    async fn run_step(
        &self,
        _collab_id: CollaborationId,
        step: &Step,
        _upstream: &[(StepId, StepOutput)],
    ) -> Result<StepOutput, String> {
        self.invocations.lock().unwrap().push(step.id);
        if !self.delay.is_zero() {
            tokio::time::sleep(self.delay).await;
        }
        let outcome = self
            .outcomes
            .lock()
            .unwrap()
            .get(&step.id)
            .cloned()
            .unwrap_or_else(|| MockOutcome::Success(default_success_output()));
        match outcome {
            MockOutcome::Success(o) => Ok(o),
            MockOutcome::Failure(r) => Err(r),
        }
    }
}

// ── Helpers ──────────────────────────────────────────────────────────

fn participant(id: i64, name: &str) -> Participant {
    Participant {
        companion_id: id,
        name: name.into(),
        avatar_emoji: "🦊".into(),
        color_hex: "#F97316".into(),
        memory_scope: MemoryScope::Private,
    }
}

fn step_single(id: StepId, prompt: &str, participant_id: i64) -> Step {
    Step {
        id,
        kind: StepKind::SingleAgent,
        participants: vec![participant(participant_id, "tester")],
        depends_on: vec![],
        input: StepInput {
            prompt: prompt.into(),
            metadata: serde_json::Value::Null,
        },
        output: None,
        status: StepStatus::Pending,
        started_at: None,
        finished_at: None,
    }
}

fn step_parallel(id: StepId, prompt: &str, participant_ids: &[i64]) -> Step {
    Step {
        id,
        kind: StepKind::ParallelAgents,
        participants: participant_ids
            .iter()
            .map(|i| participant(*i, &format!("p{i}")))
            .collect(),
        depends_on: vec![],
        input: StepInput {
            prompt: prompt.into(),
            metadata: serde_json::Value::Null,
        },
        output: None,
        status: StepStatus::Pending,
        started_at: None,
        finished_at: None,
    }
}

fn step_host_summary(id: StepId, depends_on: Vec<StepId>) -> Step {
    Step {
        id,
        kind: StepKind::HostSummarize,
        participants: vec![Participant {
            companion_id: 0,
            name: "host".into(),
            avatar_emoji: "🌸".into(),
            color_hex: "#A855F7".into(),
            memory_scope: MemoryScope::Shared,
        }],
        depends_on,
        input: StepInput {
            prompt: "host summarises".into(),
            metadata: serde_json::Value::Null,
        },
        output: None,
        status: StepStatus::Pending,
        started_at: None,
        finished_at: None,
    }
}

fn step_user_confirmation(id: StepId, depends_on: Vec<StepId>) -> Step {
    Step {
        id,
        kind: StepKind::UserConfirmation,
        participants: vec![],
        depends_on,
        input: StepInput {
            prompt: "需要您拍板".into(),
            metadata: serde_json::Value::Null,
        },
        output: None,
        status: StepStatus::Pending,
        started_at: None,
        finished_at: None,
    }
}

async fn wait_for_status<F>(
    orch: &SqliteOrchestrator,
    id: CollaborationId,
    timeout_ms: u64,
    pred: F,
) -> CollaborationStatus
where
    F: Fn(&CollaborationStatus) -> bool,
{
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let collab = orch.get(id).await.unwrap().unwrap();
        if pred(&collab.status) {
            return collab.status;
        }
        if Instant::now() >= deadline {
            panic!(
                "status {:?} did not satisfy predicate within {timeout_ms}ms",
                collab.status
            );
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

async fn wait_for_terminal(orch: &SqliteOrchestrator, id: CollaborationId) -> CollaborationStatus {
    wait_for_status(orch, id, 2000, |s| s.is_terminal()).await
}

/// Insert a placeholder session so collaborations referencing it pass the
/// FK. Idempotent — fine to call multiple times.
fn ensure_session(t: &TempDb, session_id: &str) {
    let db = t.db();
    let conn = db.get_conn().expect("conn");
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT OR IGNORE INTO sessions (id, name, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?3)",
        rusqlite::params![session_id, "test session", now],
    )
    .expect("insert session");
}

fn build_orchestrator(t: &TempDb) -> (SqliteOrchestrator, Arc<MockExecutor>) {
    // Most tests submit collaborations under a small handful of session ids;
    // pre-create them so FK constraints don't trip.
    for sid in ["sess-1", "s"] {
        ensure_session(t, sid);
    }
    let executor = Arc::new(MockExecutor::new());
    let orch = SqliteOrchestrator::new(t.db(), executor.clone().handle());
    (orch, executor)
}

// ── Tests: lifecycle ─────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn manual_single_agent_runs_to_done() {
    let t = TempDb::new();
    let (orch, executor) = build_orchestrator(&t);
    let plan = CollaborationPlan {
        steps: vec![step_single(1, "hello", 42)],
    };
    let id = orch
        .submit(
            "sess-1".into(),
            "test intent".into(),
            plan,
            CollaborationMode::Manual,
            None,
        )
        .await
        .expect("submit");

    let final_status = wait_for_terminal(&orch, id).await;
    assert!(matches!(final_status, CollaborationStatus::Done));
    assert_eq!(executor.invocations(), vec![1]);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn dispatched_single_agent_skips_confirmation() {
    let t = TempDb::new();
    let (orch, executor) = build_orchestrator(&t);
    let plan = CollaborationPlan {
        steps: vec![step_single(1, "hello", 42)],
    };
    let id = orch
        .submit(
            "sess-1".into(),
            "test".into(),
            plan,
            CollaborationMode::Dispatched(99),
            None,
        )
        .await
        .expect("submit");

    let final_status = wait_for_terminal(&orch, id).await;
    assert!(matches!(final_status, CollaborationStatus::Done));
    assert_eq!(executor.invocations(), vec![1]);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn dispatched_with_parallel_agents_awaits_confirmation() {
    let t = TempDb::new();
    let (orch, executor) = build_orchestrator(&t);
    let plan = CollaborationPlan {
        steps: vec![
            step_parallel(1, "discuss", &[10, 20, 30]),
            step_host_summary(2, vec![1]),
        ],
    };
    let id = orch
        .submit(
            "sess-1".into(),
            "jury time".into(),
            plan,
            CollaborationMode::Dispatched(99),
            None,
        )
        .await
        .expect("submit");

    // Sit in AwaitingConfirm — executor must not have been called.
    tokio::time::sleep(Duration::from_millis(50)).await;
    let collab = orch.get(id).await.unwrap().unwrap();
    assert!(matches!(collab.status, CollaborationStatus::AwaitingConfirm));
    assert!(executor.invocations().is_empty());

    // User confirms.
    orch.confirm(id, None).await.expect("confirm");
    let final_status = wait_for_terminal(&orch, id).await;
    assert!(matches!(final_status, CollaborationStatus::Done));

    // All 4 steps invoked: 3 jurors + 1 host.
    let mut invoked = executor.invocations();
    invoked.sort();
    assert_eq!(invoked, vec![1, 2]);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn abort_in_awaiting_confirm_transitions_to_aborted() {
    let t = TempDb::new();
    let (orch, _executor) = build_orchestrator(&t);
    let plan = CollaborationPlan {
        steps: vec![
            step_parallel(1, "x", &[1, 2]),
            step_host_summary(2, vec![1]),
        ],
    };
    let id = orch
        .submit(
            "sess-1".into(),
            "x".into(),
            plan,
            CollaborationMode::Dispatched(99),
            None,
        )
        .await
        .unwrap();

    orch.abort(id).await.expect("abort");
    let collab = orch.get(id).await.unwrap().unwrap();
    assert!(matches!(collab.status, CollaborationStatus::Aborted));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn step_failure_terminates_collaboration_with_failed_status() {
    let t = TempDb::new();
    let (orch, executor) = build_orchestrator(&t);
    executor.fail_step(1, "network glitch");
    let plan = CollaborationPlan {
        steps: vec![step_single(1, "x", 7)],
    };
    let id = orch
        .submit("s".into(), "x".into(), plan, CollaborationMode::Manual, None)
        .await
        .unwrap();
    let status = wait_for_terminal(&orch, id).await;
    match status {
        CollaborationStatus::Failed(reason) => {
            assert!(reason.contains("network glitch"));
        }
        other => panic!("expected Failed, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn retry_step_revives_failed_collaboration() {
    let t = TempDb::new();
    let (orch, executor) = build_orchestrator(&t);
    executor.fail_step(1, "transient");
    let plan = CollaborationPlan {
        steps: vec![step_single(1, "x", 7)],
    };
    let id = orch
        .submit("s".into(), "x".into(), plan, CollaborationMode::Manual, None)
        .await
        .unwrap();
    wait_for_status(&orch, id, 2000, |s| matches!(s, CollaborationStatus::Failed(_))).await;

    // Clear the outcome so the retry succeeds.
    executor.outcomes.lock().unwrap().remove(&1);
    orch.mutate(id, Mutation::RetryStep { step_id: 1 })
        .await
        .expect("retry");

    let status = wait_for_terminal(&orch, id).await;
    assert!(matches!(status, CollaborationStatus::Done));
    // Executor saw step 1 twice (original + retry).
    assert_eq!(executor.invocations().len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn dag_dependency_runs_steps_in_topological_order() {
    let t = TempDb::new();
    let (orch, executor) = build_orchestrator(&t);
    let plan = CollaborationPlan {
        steps: vec![
            step_single(1, "step1", 10),
            step_single(2, "step2", 11),
            // step 3 depends on 1 and 2.
            {
                let mut s = step_single(3, "step3", 12);
                s.depends_on = vec![1, 2];
                s
            },
        ],
    };
    let id = orch
        .submit("s".into(), "dag".into(), plan, CollaborationMode::Manual, None)
        .await
        .unwrap();
    let status = wait_for_terminal(&orch, id).await;
    assert!(matches!(status, CollaborationStatus::Done));

    let invocations = executor.invocations();
    // 1 and 2 may run in any order, but 3 must be last.
    assert_eq!(invocations.len(), 3);
    assert_eq!(invocations[2], 3);
    let head: std::collections::HashSet<_> = invocations[..2].iter().copied().collect();
    assert_eq!(head, [1, 2].into_iter().collect());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn user_confirmation_step_pauses_to_awaiting_confirm() {
    let t = TempDb::new();
    let (orch, executor) = build_orchestrator(&t);
    let plan = CollaborationPlan {
        steps: vec![
            step_single(1, "first", 10),
            step_user_confirmation(2, vec![1]),
            // Step 3 must wait on the user-confirmation gate.
            {
                let mut s = step_single(3, "after confirm", 11);
                s.depends_on = vec![2];
                s
            },
        ],
    };
    let id = orch
        .submit("s".into(), "x".into(), plan, CollaborationMode::Manual, None)
        .await
        .unwrap();

    // Wait for the first step to complete and the second (UserConfirmation)
    // to flip the collaboration to AwaitingConfirm.
    wait_for_status(&orch, id, 5000, |s| {
        s == &CollaborationStatus::AwaitingConfirm
    })
    .await;
    // Step 3 must not have been invoked yet.
    assert_eq!(executor.invocations(), vec![1]);

    // Manually mark the user_confirmation step Skipped to release the gate
    // — this mimics the UI "user 拍板" action without exercising confirm's
    // edited-plan path.
    orch.mutate(id, Mutation::SkipStep { step_id: 2 })
        .await
        .unwrap();
    // After skip, status went back to a pending-step-resumed state; we just
    // need to wait for the whole DAG to finish.
    let status = wait_for_terminal(&orch, id).await;
    assert!(matches!(status, CollaborationStatus::Done));
    assert!(executor.invocations().contains(&3));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn add_step_mutation_invokes_added_step_before_completion() {
    let t = TempDb::new();
    // Slow step 1 down so we have a real window to mutate during.
    let executor = Arc::new(MockExecutor::with_delay(Duration::from_millis(150)));
    let exec_handle: ExecutorHandle = executor.clone();
    for sid in ["sess-1", "s"] {
        ensure_session(&t, sid);
    }
    let orch = SqliteOrchestrator::new(t.db(), exec_handle);

    let plan = CollaborationPlan {
        steps: vec![step_single(1, "slow step", 10)],
    };
    let id = orch
        .submit("s".into(), "x".into(), plan, CollaborationMode::Manual, None)
        .await
        .unwrap();

    // Step 1 is mid-flight. Inject a brand-new step 2 — it must end up
    // executed by the time the collaboration reaches Done.
    let new_step = step_single(2, "added on the fly", 20);
    orch.mutate(id, Mutation::AddStep { step: new_step })
        .await
        .expect("AddStep while Running must succeed");

    let final_status = wait_for_terminal(&orch, id).await;
    assert!(
        matches!(final_status, CollaborationStatus::Done),
        "collaboration should finish Done, got {final_status:?}"
    );
    let invocations = executor.invocations();
    assert!(
        invocations.contains(&1) && invocations.contains(&2),
        "both original and added step must run, got {invocations:?}"
    );
    let collab = orch.get(id).await.unwrap().unwrap();
    assert_eq!(collab.plan.steps.len(), 2);
    for step in &collab.plan.steps {
        assert_eq!(step.status, StepStatus::Completed);
    }
}

// ── Tests: audit log completeness ────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn audit_log_records_full_lifecycle() {
    let t = TempDb::new();
    let (orch, _executor) = build_orchestrator(&t);
    let plan = CollaborationPlan {
        steps: vec![step_single(1, "x", 5)],
    };
    let id = orch
        .submit("s".into(), "test".into(), plan, CollaborationMode::Manual, None)
        .await
        .unwrap();
    wait_for_terminal(&orch, id).await;

    let trail = AuditTrail::new(t.db());
    let events = trail.list(id).expect("list");
    let kinds: Vec<AuditKind> = events.iter().map(|e| e.kind.clone()).collect();
    // Expected:
    //   Submitted (by System on submit)
    //   StepStarted (on dispatch)
    //   StepCompleted (on success)
    //   StepCompleted (finalize Done uses the same kind variant — see
    //     orchestrator.finalize)
    assert!(kinds.contains(&AuditKind::Submitted));
    assert!(kinds.contains(&AuditKind::StepStarted));
    assert!(kinds.contains(&AuditKind::StepCompleted));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn audit_log_records_user_confirmation() {
    let t = TempDb::new();
    let (orch, _executor) = build_orchestrator(&t);
    let plan = CollaborationPlan {
        steps: vec![
            step_parallel(1, "x", &[1, 2]),
            step_host_summary(2, vec![1]),
        ],
    };
    let id = orch
        .submit(
            "s".into(),
            "test".into(),
            plan,
            CollaborationMode::Dispatched(99),
            None,
        )
        .await
        .unwrap();
    orch.confirm(id, None).await.unwrap();
    wait_for_terminal(&orch, id).await;

    let trail = AuditTrail::new(t.db());
    let events = trail.list(id).expect("list");
    let kinds: Vec<AuditKind> = events.iter().map(|e| e.kind.clone()).collect();
    assert!(kinds.contains(&AuditKind::Confirmed));
    // The Confirmed audit must have Actor::User.
    let confirmed = events
        .iter()
        .find(|e| e.kind == AuditKind::Confirmed)
        .expect("confirmed event");
    assert_eq!(confirmed.actor, Actor::User);
}

// ── Tests: get / watch ───────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_returns_none_for_unknown_id() {
    let t = TempDb::new();
    let (orch, _executor) = build_orchestrator(&t);
    assert!(orch.get(99999).await.unwrap().is_none());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn get_reflects_step_status_after_completion() {
    let t = TempDb::new();
    let (orch, _executor) = build_orchestrator(&t);
    let plan = CollaborationPlan {
        steps: vec![step_single(1, "x", 5)],
    };
    let id = orch
        .submit("s".into(), "x".into(), plan, CollaborationMode::Manual, None)
        .await
        .unwrap();
    wait_for_terminal(&orch, id).await;

    let collab = orch.get(id).await.unwrap().unwrap();
    assert_eq!(collab.plan.steps[0].status, StepStatus::Completed);
    assert!(collab.plan.steps[0].output.is_some());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_recent_by_session_returns_newest_first() {
    let t = TempDb::new();
    let (orch, _executor) = build_orchestrator(&t);

    let mut ids = Vec::new();
    for i in 0..3 {
        let plan = CollaborationPlan {
            steps: vec![step_single(1, &format!("turn {i}"), 10)],
        };
        let id = orch
            .submit(
                "sess-1".into(),
                format!("intent {i}"),
                plan,
                CollaborationMode::Manual,
                None,
            )
            .await
            .unwrap();
        ids.push(id);
        wait_for_terminal(&orch, id).await;
        // Stagger so created_at differs.
        tokio::time::sleep(Duration::from_millis(2)).await;
    }

    let recent = orch.list_recent_by_session("sess-1", 10).expect("list");
    assert_eq!(recent.len(), 3);
    // newest first → reverse insertion order
    let recent_ids: Vec<i64> = recent.iter().map(|c| c.id).collect();
    let mut expected = ids.clone();
    expected.reverse();
    assert_eq!(recent_ids, expected);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_recent_by_session_isolates_by_session_id() {
    let t = TempDb::new();
    let (orch, _executor) = build_orchestrator(&t);

    let plan_a = CollaborationPlan {
        steps: vec![step_single(1, "x", 10)],
    };
    let id_a = orch
        .submit("sess-1".into(), "a".into(), plan_a, CollaborationMode::Manual, None)
        .await
        .unwrap();
    let plan_b = CollaborationPlan {
        steps: vec![step_single(1, "y", 11)],
    };
    let _id_b = orch
        .submit("s".into(), "b".into(), plan_b, CollaborationMode::Manual, None)
        .await
        .unwrap();
    wait_for_terminal(&orch, id_a).await;

    let only_sess1 = orch.list_recent_by_session("sess-1", 10).unwrap();
    assert_eq!(only_sess1.len(), 1);
    assert_eq!(only_sess1[0].chat_session_id, "sess-1");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn list_recent_empty_for_unknown_session() {
    let t = TempDb::new();
    let (orch, _executor) = build_orchestrator(&t);
    let recent = orch.list_recent_by_session("nonexistent", 10).unwrap();
    assert!(recent.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn watch_receives_audit_events() {
    let t = TempDb::new();
    let (orch, _executor) = build_orchestrator(&t);
    let mut rx = orch.subscribe_all();
    let plan = CollaborationPlan {
        steps: vec![step_single(1, "x", 5)],
    };
    let id = orch
        .submit("s".into(), "x".into(), plan, CollaborationMode::Manual, None)
        .await
        .unwrap();

    // Drain the first few events — submitted, step started, step completed.
    let mut got_submitted = false;
    let mut got_step_started = false;
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline && (!got_submitted || !got_step_started) {
        match tokio::time::timeout(Duration::from_millis(100), rx.recv()).await {
            Ok(Ok(app_lib::engine::collaboration::CollaborationEvent::Audit { event: a })) => {
                if a.collaboration_id != id {
                    continue;
                }
                if a.kind == AuditKind::Submitted {
                    got_submitted = true;
                }
                if a.kind == AuditKind::StepStarted {
                    got_step_started = true;
                }
            }
            _ => {}
        }
    }
    assert!(got_submitted && got_step_started, "missed audit events");
}
