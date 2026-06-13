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

/// 并发回归(2026-06-13 review BUG2):同一 work 会话同时跑多个 work_dispatch 协作
/// (用户 @ 直达任务 + 别的协作)时,**先完成的那个不能把整个 job 误标「已交付」**。
/// 只有最后一个活动协作收尾才推 job 终态。没有这个守卫,一个直达小任务先完成就弹
/// 「✅ 已交付」、误撤 PM 正在等用户答的提问。
#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn concurrent_work_dispatch_fast_one_finishing_keeps_job_running() {
    let t = TempDb::new();
    let sid = "concurrency-sess";
    ensure_session(&t, sid);
    let db = t.db();
    db.create_work_job(sid, "做个东西", Some(1)).unwrap();
    db.set_work_job_status(sid, "running").unwrap();

    // 执行器全局 300ms 延迟:B(1 步,~300ms)先于 A(2 步串行,~600ms)收尾。
    let executor = Arc::new(MockExecutor::with_delay(Duration::from_millis(300)));
    let orch = SqliteOrchestrator::new(db.clone(), executor.handle());

    // A:两步串行(step2 依赖 step1),活得久。
    let plan_a = CollaborationPlan {
        steps: vec![step_single(1, "A1", 10), {
            let mut s = step_single(2, "A2", 11);
            s.depends_on = vec![1];
            s
        }],
    };
    let a = orch
        .submit_kinded(sid.into(), "A".into(), plan_a, CollaborationMode::Dispatched(0), None, Some("work_dispatch"))
        .await
        .unwrap();
    // B:单步,先收尾。
    let plan_b = CollaborationPlan { steps: vec![step_single(1, "B1", 12)] };
    let b = orch
        .submit_kinded(sid.into(), "B".into(), plan_b, CollaborationMode::Dispatched(0), None, Some("work_dispatch"))
        .await
        .unwrap();

    // B 先到终态。等一拍让 finalize 的 job-sync 尾巴跑完。
    wait_for_terminal(&orch, b).await;
    tokio::time::sleep(Duration::from_millis(40)).await;
    // 关键断言:A 还在跑 → B 完成不该把 job 推「done」。
    assert_eq!(
        db.get_work_job_status(sid).as_deref(),
        Some("running"),
        "另一个协作还在跑时,先完成的协作不该把 job 标为已交付",
    );

    // A 收尾后(已无其它活动协作)→ job 落 done。
    wait_for_terminal(&orch, a).await;
    let deadline = Instant::now() + Duration::from_millis(500);
    while db.get_work_job_status(sid).as_deref() != Some("done") && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        db.get_work_job_status(sid).as_deref(),
        Some("done"),
        "最后一个协作收尾后 job 应落 done",
    );
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

/// 终态守卫回归(防屎山修复 D1):abort 把协作置 Aborted 后,一个在 abort 时仍
/// 在跑、稍后才完成的 step,其晚到的 complete_step → finalize(Done) 必须被守卫
/// 拦住 —— 协作维持 Aborted,不被翻回 Done,也不写出矛盾的"已完成"裁决。
#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn abort_then_late_step_completion_keeps_aborted() {
    let t = TempDb::new();
    ensure_session(&t, "s");
    // 带延迟的 executor:step 提交后会 running 一段时间才完成,给我们 abort 的窗口。
    let executor = Arc::new(MockExecutor::with_delay(Duration::from_millis(200)));
    let orch = SqliteOrchestrator::new(t.db(), executor.clone().handle());
    let plan = CollaborationPlan {
        steps: vec![step_single(1, "x", 7)],
    };
    let id = orch
        .submit("s".into(), "x".into(), plan, CollaborationMode::Manual, None)
        .await
        .unwrap();

    // 等 step 真正进入 running(executor 已被调用)再 abort。
    tokio::time::sleep(Duration::from_millis(50)).await;
    orch.abort(id).await.expect("abort");
    let c = orch.get(id).await.unwrap().unwrap();
    assert!(matches!(c.status, CollaborationStatus::Aborted), "abort 后应为 Aborted");

    // 等延迟 step 完成,其晚到的 complete_step 回调触发 finalize(Done)。
    tokio::time::sleep(Duration::from_millis(300)).await;
    let c = orch.get(id).await.unwrap().unwrap();
    assert!(
        matches!(c.status, CollaborationStatus::Aborted),
        "晚到的完成回调不得把 Aborted 翻回 Done,实际 {:?}",
        c.status
    );
}

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
async fn dispatched_with_parallel_agents_runs_immediately() {
    // 产品砍掉 jury 的"拍板确认"卡后:Dispatched + ParallelAgents plan 提交即跑,
    // 不再卡 AwaitingConfirm(否则群聊永远卡死——见 P0-1 修复 / 陪审团报告)。
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
            "group chat".into(),
            plan,
            CollaborationMode::Dispatched(99),
            None,
        )
        .await
        .expect("submit");

    // 无需 confirm —— 直接跑到终态。
    let final_status = wait_for_terminal(&orch, id).await;
    assert!(matches!(final_status, CollaborationStatus::Done));

    // 两个 step 都被执行:ParallelAgents + HostSummarize。
    let mut invoked = executor.invocations();
    invoked.sort();
    assert_eq!(invoked, vec![1, 2]);
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn abort_in_awaiting_confirm_transitions_to_aborted() {
    let t = TempDb::new();
    let (orch, _executor) = build_orchestrator(&t);
    // AwaitingConfirm 现在只由显式 UserConfirmation step 触发(产品砍掉 jury
    // 拍板卡后,ParallelAgents 不再隐式触发确认)。首个 step 即确认门 → submit
    // 立刻进 AwaitingConfirm。
    let plan = CollaborationPlan {
        steps: vec![
            step_user_confirmation(1, vec![]),
            {
                let mut s = step_single(2, "after confirm", 1);
                s.depends_on = vec![1];
                s
            },
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

    // submit 即应处于 AwaitingConfirm(含 UserConfirmation step → 不跳过确认)。
    let collab = orch.get(id).await.unwrap().unwrap();
    assert!(matches!(collab.status, CollaborationStatus::AwaitingConfirm));

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
async fn retry_step_double_click_rejected_while_step_rerunning() {
    // 防连点竞态:RetryStep 只对 failed/skipped 步合法(CAS)。没有这个条件时,第一次
    // 重试把步拉回 running 后,第二次点击会把 running 步再次重置 pending → schedule 的
    // pending→running 守卫再次放行 → 同一步 N 路并发执行体(实测用户连点 4 下 =
    // 4 个同名成员并发互踩)。用带 delay 的 executor 让步停留在 running 复现连点窗口。
    let t = TempDb::new();
    ensure_session(&t, "s");
    let executor = Arc::new(MockExecutor::with_delay(Duration::from_millis(400)));
    let orch = SqliteOrchestrator::new(t.db(), executor.clone().handle());
    executor.fail_step(1, "transient");
    let plan = CollaborationPlan {
        steps: vec![step_single(1, "x", 7)],
    };
    let id = orch
        .submit("s".into(), "x".into(), plan, CollaborationMode::Manual, None)
        .await
        .unwrap();
    wait_for_status(&orch, id, 3000, |s| matches!(s, CollaborationStatus::Failed(_))).await;

    // 第一次重试:合法(步 failed → pending → running,delay 内停留 running)。
    orch.mutate(id, Mutation::RetryStep { step_id: 1 })
        .await
        .expect("first retry");
    // 执行体在 detached spawn 上启动 —— 等它真正拉起(invocations: 原始 1 + 重试 1)。
    let deadline = Instant::now() + Duration::from_millis(1000);
    while executor.invocations().len() < 2 && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(executor.invocations().len(), 2, "第一次重试应已拉起执行体");

    // 连点第二次:步在 running(delay 窗口内)→ CAS 拒绝,不再拉起新执行体。
    let err = orch
        .mutate(id, Mutation::RetryStep { step_id: 1 })
        .await
        .expect_err("retry while step rerunning must be rejected");
    assert!(err.contains("重跑") || err.contains("可重试"), "拒绝文案应可读:{err}");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(executor.invocations().len(), 2, "被拒的重试不该再拉起执行体");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn work_job_terminal_expires_pending_questions() {
    // 失败收口一致性:work job 进终态时,该会话挂着的未答提问应被撤销(expired)——
    // 没人会再收答案的提问卡不该留在会话里诱导用户回答。
    let t = TempDb::new();
    let (orch, executor) = build_orchestrator(&t);
    let db = t.db();
    ensure_session(&t, "sess-wjq");
    db.create_work_job("sess-wjq", "做个东西", Some(7)).unwrap();
    db.insert_pending_question(&app_lib::engine::db::PendingQuestion {
        request_id: "q-orphan".into(),
        session_id: "sess-wjq".into(),
        collaboration_id: None,
        step_id: None,
        companion_id: 7,
        asker_name: "tester".into(),
        question: "还要继续吗?".into(),
        options_json: None,
        kind: "text".into(),
        status: "pending".into(),
        answer: None,
        created_at: 1,
        answered_at: None,
    })
    .unwrap();

    executor.fail_step(1, "炸了");
    let plan = CollaborationPlan {
        steps: vec![step_single(1, "x", 7)],
    };
    let id = orch
        .submit_kinded(
            "sess-wjq".into(),
            "做个东西".into(),
            plan,
            CollaborationMode::Dispatched(7),
            None,
            Some("work_dispatch"),
        )
        .await
        .unwrap();
    wait_for_status(&orch, id, 2000, |s| matches!(s, CollaborationStatus::Failed(_))).await;

    assert_eq!(db.get_work_job_status("sess-wjq").as_deref(), Some("failed"));
    assert!(
        db.list_pending_questions("sess-wjq").is_empty(),
        "job 终态后未答提问应被撤销",
    );
    let q = db.get_pending_question("q-orphan").expect("行还在");
    assert_eq!(q.status, "expired", "撤销走 expired,不污染 answered 的去重命中");
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

// ── Tests: verdict message persistence ───────────────────────────────

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn done_collaboration_writes_verdict_message_to_session() {
    let t = TempDb::new();
    let (orch, _executor) = build_orchestrator(&t);
    let plan = CollaborationPlan {
        steps: vec![step_single(1, "hi", 7)],
    };
    let id = orch
        .submit(
            "sess-1".into(),
            "用户问的事".into(),
            plan,
            CollaborationMode::Manual,
            None,
        )
        .await
        .unwrap();
    let status = wait_for_terminal(&orch, id).await;
    assert!(matches!(status, CollaborationStatus::Done));

    let msgs = t.db().get_messages("sess-1", None).expect("messages");
    let verdict: Vec<_> = msgs.iter().filter(|m| m.collaboration_id == Some(id)).collect();
    assert_eq!(verdict.len(), 1, "exactly one verdict message expected");
    let m = verdict[0];
    assert_eq!(m.role, "assistant");
    // step_single() uses name "tester"; default mock output is "mock full output".
    assert!(m.content.contains("tester"), "name missing: {}", m.content);
    assert!(
        m.content.contains("mock full output"),
        "body missing: {}",
        m.content
    );
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn failed_collaboration_writes_failure_verdict() {
    let t = TempDb::new();
    let (orch, executor) = build_orchestrator(&t);
    executor.fail_step(1, "ran out of magic");
    let plan = CollaborationPlan {
        steps: vec![step_single(1, "hi", 7)],
    };
    let id = orch
        .submit(
            "sess-1".into(),
            "用户问的事".into(),
            plan,
            CollaborationMode::Manual,
            None,
        )
        .await
        .unwrap();
    wait_for_status(&orch, id, 2000, |s| matches!(s, CollaborationStatus::Failed(_))).await;

    let msgs = t.db().get_messages("sess-1", None).expect("messages");
    let verdict: Vec<_> = msgs.iter().filter(|m| m.collaboration_id == Some(id)).collect();
    assert_eq!(verdict.len(), 1);
    assert!(verdict[0].content.contains("未完成"));
    assert!(verdict[0].content.contains("ran out of magic"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn aborted_collaboration_writes_aborted_verdict() {
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
            "用户问的事".into(),
            plan,
            CollaborationMode::Dispatched(99),
            None,
        )
        .await
        .unwrap();
    orch.abort(id).await.unwrap();
    wait_for_status(&orch, id, 2000, |s| matches!(s, CollaborationStatus::Aborted)).await;

    let msgs = t.db().get_messages("sess-1", None).expect("messages");
    let verdict: Vec<_> = msgs.iter().filter(|m| m.collaboration_id == Some(id)).collect();
    assert_eq!(verdict.len(), 1);
    assert!(verdict[0].content.contains("已中止"));
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn verdict_message_is_idempotent_across_retries() {
    // Two transitions to Done shouldn't write two verdicts (the underlying
    // INSERT is guarded by collaboration_id uniqueness).
    let t = TempDb::new();
    let (orch, executor) = build_orchestrator(&t);
    executor.fail_step(1, "boom");
    let plan = CollaborationPlan {
        steps: vec![step_single(1, "hi", 7)],
    };
    let id = orch
        .submit(
            "sess-1".into(),
            "用户问的事".into(),
            plan,
            CollaborationMode::Manual,
            None,
        )
        .await
        .unwrap();
    wait_for_status(&orch, id, 2000, |s| matches!(s, CollaborationStatus::Failed(_))).await;

    // Switch the mock to success, then retry.
    executor.succeed_with(1, default_success_output());
    orch.mutate(id, Mutation::RetryStep { step_id: 1 })
        .await
        .unwrap();
    wait_for_status(&orch, id, 2000, |s| matches!(s, CollaborationStatus::Done)).await;

    let msgs = t.db().get_messages("sess-1", None).expect("messages");
    let verdict: Vec<_> = msgs.iter().filter(|m| m.collaboration_id == Some(id)).collect();
    assert_eq!(
        verdict.len(),
        1,
        "verdict must be idempotent; got {}",
        verdict.len()
    );
    // The first finalize (Failed) wins because it lands first; that's fine,
    // the panel still shows the live state via the orchestrator. What matters
    // is that we don't double-insert.
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
    // AwaitingConfirm 现在只由显式 UserConfirmation step 触发(产品砍掉 jury 拍板
    // 卡后,ParallelAgents 提交即跑)。首个 step 即确认门 → submit 即 AwaitingConfirm,
    // 可被 confirm() 释放并记 Confirmed 审计。
    let plan = CollaborationPlan {
        steps: vec![
            step_user_confirmation(1, vec![]),
            {
                let mut s = step_single(2, "after confirm", 7);
                s.depends_on = vec![1];
                s
            },
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
    // 处于 AwaitingConfirm → confirm() 记录 Confirmed 审计(Actor::User)。
    orch.confirm(id, None).await.unwrap();
    // confirm 后 UserConfirmation step 仍会把状态再切回 AwaitingConfirm;
    // skip 掉这道门让 DAG 走完到终态。
    orch.mutate(id, Mutation::SkipStep { step_id: 1 })
        .await
        .unwrap();
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
