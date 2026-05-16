//! Property-based tests for `SqliteOrchestrator`: regardless of the DAG
//! shape we throw at it, the orchestrator must always reach a terminal
//! state and never deadlock at `Running`.
//!
//! The properties asserted here are the contractual invariants of the
//! state machine — if any of them ever fail with a `cargo test` run,
//! the orchestrator implementation has a real bug, not a flaky test.

mod common;

#[allow(unused_imports)]
use common::*;
use app_lib::engine::agents::MemoryScope;
use app_lib::engine::collaboration::{
    orchestrator::SqliteOrchestrator, CollaborationId, CollaborationMode,
    CollaborationOrchestrator, CollaborationPlan, CollaborationStatus, Executor, ExecutorHandle,
    Participant, Step, StepId, StepInput, StepKind, StepOutput, StepStatus, TokenUsage,
};
use async_trait::async_trait;
use proptest::prelude::*;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Pure-success executor: any step it runs returns immediately with a
/// trivial success output. Used for property tests where the focus is the
/// state machine, not failure handling.
struct AlwaysSucceedExecutor;

#[async_trait]
impl Executor for AlwaysSucceedExecutor {
    async fn run_step(
        &self,
        _collab_id: CollaborationId,
        _step: &Step,
        _upstream: &[(StepId, StepOutput)],
    ) -> Result<StepOutput, String> {
        Ok(StepOutput {
            summary: String::new(),
            full_output: String::new(),
            tokens_used: TokenUsage::default(),
            duration_ms: 0,
        })
    }
}

fn ensure_session(t: &TempDb, session_id: &str) {
    let db = t.db();
    let conn = db.get_conn().unwrap();
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT OR IGNORE INTO sessions (id, name, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?3)",
        rusqlite::params![session_id, "test", now],
    )
    .unwrap();
}

fn participant(id: i64) -> Participant {
    Participant {
        companion_id: id,
        name: format!("p{id}"),
        avatar_emoji: "🦊".into(),
        color_hex: "#000".into(),
        memory_scope: MemoryScope::Private,
    }
}

/// Build a random DAG of `n` SingleAgent steps. Step `i` may depend on any
/// step `< i` (forming a valid acyclic graph). Returns a complete plan ready
/// to submit.
fn arb_plan(n: usize) -> impl Strategy<Value = CollaborationPlan> {
    let n = n.max(1);
    proptest::collection::vec(
        proptest::collection::vec(any::<bool>(), 0..n),
        n,
    )
    .prop_map(move |dep_matrix| {
        let mut steps = Vec::with_capacity(n);
        for i in 0..n {
            let mut depends_on = Vec::new();
            if let Some(row) = dep_matrix.get(i) {
                for (j, take) in row.iter().enumerate() {
                    if j < i && *take {
                        depends_on.push(j as StepId + 1);
                    }
                }
            }
            steps.push(Step {
                id: i as StepId + 1,
                kind: StepKind::SingleAgent,
                participants: vec![participant(100 + i as i64)],
                depends_on,
                input: StepInput {
                    prompt: format!("step {}", i + 1),
                    metadata: serde_json::Value::Null,
                },
                output: None,
                status: StepStatus::Pending,
                started_at: None,
                finished_at: None,
            });
        }
        CollaborationPlan { steps }
    })
}

async fn wait_for_terminal(orch: &SqliteOrchestrator, id: CollaborationId) -> CollaborationStatus {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let collab = orch.get(id).await.unwrap().unwrap();
        if collab.status.is_terminal() {
            return collab.status;
        }
        if Instant::now() >= deadline {
            panic!(
                "collab {id} stuck at {:?} after 5s — DAG: {:?}",
                collab.status, collab.plan
            );
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

fn run_property_case(plan: CollaborationPlan) -> Result<(), proptest::test_runner::TestCaseError> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let t = TempDb::new();
        ensure_session(&t, "s");
        let executor: ExecutorHandle = Arc::new(AlwaysSucceedExecutor);
        let orch = SqliteOrchestrator::new(t.db(), executor);
        let n_steps = plan.steps.len();
        let id = orch
            .submit("s".into(), "x".into(), plan, CollaborationMode::Manual, None)
            .await
            .unwrap();
        let final_status = wait_for_terminal(&orch, id).await;

        prop_assert!(
            matches!(final_status, CollaborationStatus::Done),
            "expected Done, got {final_status:?}"
        );

        // Every step finished and produced output.
        let collab = orch.get(id).await.unwrap().unwrap();
        for step in &collab.plan.steps {
            prop_assert_eq!(
                step.status.clone(),
                StepStatus::Completed,
                "step {} not completed (DAG had {} steps)",
                step.id,
                n_steps
            );
            prop_assert!(step.output.is_some(), "step {} missing output", step.id);
        }
        Ok(())
    })
}

proptest! {
    #![proptest_config(ProptestConfig {
        // Each case spawns a full TempDb + runtime; cap iterations to keep
        // the suite under a few seconds. 50 cases × ~50ms each ≈ 2.5s.
        cases: 50,
        .. ProptestConfig::default()
    })]

    #[test]
    fn random_single_agent_dag_always_terminates(plan in arb_plan(6)) {
        run_property_case(plan)?;
    }

    #[test]
    fn larger_random_dag_terminates(plan in arb_plan(10)) {
        run_property_case(plan)?;
    }
}

// Deterministic edge cases that proptest would unlikely hit precisely.

#[tokio::test(flavor = "multi_thread")]
#[serial_test::serial]
async fn singleton_plan_terminates() {
    let t = TempDb::new();
    ensure_session(&t, "s");
    let executor: ExecutorHandle = Arc::new(AlwaysSucceedExecutor);
    let orch = SqliteOrchestrator::new(t.db(), executor);
    let plan = CollaborationPlan {
        steps: vec![Step {
            id: 1,
            kind: StepKind::SingleAgent,
            participants: vec![participant(1)],
            depends_on: vec![],
            input: StepInput {
                prompt: "lone".into(),
                metadata: serde_json::Value::Null,
            },
            output: None,
            status: StepStatus::Pending,
            started_at: None,
            finished_at: None,
        }],
    };
    let id = orch
        .submit("s".into(), "x".into(), plan, CollaborationMode::Manual, None)
        .await
        .unwrap();
    let status = wait_for_terminal(&orch, id).await;
    assert!(matches!(status, CollaborationStatus::Done));
}

#[tokio::test(flavor = "multi_thread")]
#[serial_test::serial]
async fn linear_chain_terminates_in_order() {
    let t = TempDb::new();
    ensure_session(&t, "s");
    let executor: ExecutorHandle = Arc::new(AlwaysSucceedExecutor);
    let orch = SqliteOrchestrator::new(t.db(), executor);
    let plan = CollaborationPlan {
        steps: (1..=5)
            .map(|i| Step {
                id: i,
                kind: StepKind::SingleAgent,
                participants: vec![participant(i)],
                depends_on: if i > 1 { vec![i - 1] } else { vec![] },
                input: StepInput {
                    prompt: format!("step {i}"),
                    metadata: serde_json::Value::Null,
                },
                output: None,
                status: StepStatus::Pending,
                started_at: None,
                finished_at: None,
            })
            .collect(),
    };
    let id = orch
        .submit("s".into(), "x".into(), plan, CollaborationMode::Manual, None)
        .await
        .unwrap();
    let status = wait_for_terminal(&orch, id).await;
    assert!(matches!(status, CollaborationStatus::Done));
}

#[tokio::test(flavor = "multi_thread")]
#[serial_test::serial]
async fn diamond_dag_terminates() {
    // 1 → 2, 3 → 4 (diamond): step 4 must wait for both 2 and 3.
    let t = TempDb::new();
    ensure_session(&t, "s");
    let executor: ExecutorHandle = Arc::new(AlwaysSucceedExecutor);
    let orch = SqliteOrchestrator::new(t.db(), executor);
    let mk = |id, deps: Vec<StepId>| Step {
        id,
        kind: StepKind::SingleAgent,
        participants: vec![participant(id)],
        depends_on: deps,
        input: StepInput {
            prompt: format!("s{id}"),
            metadata: serde_json::Value::Null,
        },
        output: None,
        status: StepStatus::Pending,
        started_at: None,
        finished_at: None,
    };
    let plan = CollaborationPlan {
        steps: vec![mk(1, vec![]), mk(2, vec![1]), mk(3, vec![1]), mk(4, vec![2, 3])],
    };
    let id = orch
        .submit("s".into(), "x".into(), plan, CollaborationMode::Manual, None)
        .await
        .unwrap();
    let status = wait_for_terminal(&orch, id).await;
    assert!(matches!(status, CollaborationStatus::Done));
}
