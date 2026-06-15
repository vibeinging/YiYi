//! work 发起 / followup 路由的集成测试 —— `commands/work.rs` + `engine/work/launcher.rs`。
//!
//! 2026-06-15:chat 群聊(放养 / conversation_driver)已退役,本文件只保留 **work**
//! 侧契约:
//! - `launch_work_job_impl`:从「工作」入口显式发起 → 牵头者 intake(work_intake)、
//!   会话绑团队群、job 入状态机(clarifying)。
//! - `dispatch_work_followup`:停止意图中止 job、intake 在跑时插话收下、@ 工人直达派活、
//!   pending question 兜底投递。
//! - `dispatch_work_plan`:团队有 QA 但方案漏排 → 自动追加验证步;已排则不重复。
//!
//! Mock 固定响应即可(同步路径不依赖 LLM 内容),TempDb 隔离,#[serial]。

mod common;

#[allow(unused_imports)]
use common::*;

use std::sync::Arc;

use app_lib::commands::agent::resolve_llm_config;
use app_lib::commands::companion_groups::{add_companion_to_group_impl, create_companion_group_impl};
use app_lib::engine::collaboration::executor::ConcreteExecutor;
use app_lib::engine::collaboration::orchestrator::SqliteOrchestrator;
use app_lib::engine::db::NewCompanion;
use serial_test::serial;

fn new_companion(name: &str) -> NewCompanion {
    NewCompanion {
        name: name.into(),
        agent_definition_name: "code_reviewer".into(),
        avatar_emoji: "🦊".into(),
        color_hex: "#F97316".into(),
        persona_md_path: None,
        memory_user_id: format!("c_{name}"),
        metadata_json: None,
        role_label: Some("代码评审员".into()),
    }
}

/// Mock LLM 返回的 judge JSON:顶层 `members: [{id, confidence, reason}]`。
/// work intake / 派工的牵头者选择读这个。
fn decision_json(members: &[(i64, f64)]) -> String {
    let parts: Vec<String> = members
        .iter()
        .map(|(id, conf)| {
            format!(r#"{{"id": {id}, "confidence": {conf}, "reason": "交给它"}}"#)
        })
        .collect();
    format!(r#"{{"members": [{}]}}"#, parts.join(","))
}

fn new_pm(name: &str) -> NewCompanion {
    NewCompanion {
        name: name.into(),
        agent_definition_name: "pm".into(),
        avatar_emoji: "🧭".into(),
        color_hex: "#6366F1".into(),
        persona_md_path: None,
        memory_user_id: format!("pm_{name}"),
        metadata_json: None,
        role_label: Some("产品经理".into()),
    }
}


#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn launch_work_job_creates_work_dispatch_collab() {
    use app_lib::commands::work::launch_work_job_impl;
    // 「工作」入口的「新建工作」走这条:显式发起 → 牵头者接手 intake。
    let t = build_test_app_state().await;
    let db = t.state().db.clone();
    let pm = db.adopt_companion(&new_pm("产品经理")).unwrap();
    let mock = MockLlmServer::start().await;
    mock.mock_chat_completion_response(&decision_json(&[(pm, 0.9)])).await;
    seed_mock_llm_provider(t.state(), &mock, "mock-model").await;
    let gid = create_companion_group_impl(t.state(), "软件公司".into(), None, None)
        .await
        .unwrap();
    db.set_group_workspace(gid, "/tmp/yiyi_ws_launch").unwrap();
    add_companion_to_group_impl(t.state(), gid, pm).await.unwrap();

    let launched = launch_work_job_impl(t.state(), gid, "做个 todo 网页应用", None)
        .await
        .unwrap();

    // 产出一个 work job:intake 协作标 kind=work_intake(R3:intake ≠ 交付,与派工协作
    // work_dispatch 分治)、会话绑团队群、job 入 work_jobs 状态机(clarifying)并进列表。
    assert_eq!(
        db.get_collaboration_kind(launched.collaboration_id).as_deref(),
        Some("work_intake"),
        "显式发起的 intake 协作应标 work_intake",
    );
    assert_eq!(db.get_session_group(&launched.session_id), Some(gid), "work 会话应绑团队群");
    let jobs = db.list_work_jobs();
    let job = jobs
        .iter()
        .find(|j| j.session_id == launched.session_id)
        .expect("应出现在 work job 列表");
    assert_eq!(job.status, "clarifying", "新发起的 job 应在澄清态,而不是已交付");
    // 用户任务原文应落成 user 气泡(原始请求可见、followup 历史块带得上)。
    let msgs = db.get_recent_messages(&launched.session_id, 10).unwrap();
    assert!(
        msgs.iter().any(|m| m.role == "user" && m.content.contains("todo")),
        "任务原文应是 user 消息",
    );
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn work_followup_stop_intent_aborts_job_instead_of_new_intake() {
    use app_lib::commands::work::{dispatch_work_followup, launch_work_job_impl, WorkFollowup};
    let t = build_test_app_state().await;
    let db = t.state().db.clone();
    let pm = db.adopt_companion(&new_pm("产品经理")).unwrap();
    let mock = MockLlmServer::start().await;
    mock.mock_chat_completion_response(&decision_json(&[(pm, 0.9)])).await;
    seed_mock_llm_provider(t.state(), &mock, "mock-model").await;
    let gid = create_companion_group_impl(t.state(), "软件公司".into(), None, None)
        .await
        .unwrap();
    add_companion_to_group_impl(t.state(), gid, pm).await.unwrap();
    let launched = launch_work_job_impl(t.state(), gid, "做个 app", None).await.unwrap();

    // 「停」是停止意图,不是新任务:中止 job,不新建 intake。
    let out = dispatch_work_followup(t.state(), &launched.session_id, "停", &[]).await.unwrap();
    assert!(matches!(out, WorkFollowup::Notice(_)), "停止意图应以提示收束,不起新 intake");
    assert_eq!(
        db.get_work_job_status(&launched.session_id).as_deref(),
        Some("aborted"),
        "job 应被中止",
    );
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn work_followup_while_intake_active_queues_message_instead_of_reject() {
    use app_lib::commands::work::{dispatch_work_followup, launch_work_job_impl, WorkFollowup};
    let t = build_test_app_state().await;
    let db = t.state().db.clone();
    let pm = db.adopt_companion(&new_pm("产品经理")).unwrap();
    let mock = MockLlmServer::start().await;
    mock.mock_chat_completion_response(&decision_json(&[(pm, 0.9)])).await;
    seed_mock_llm_provider(t.state(), &mock, "mock-model").await;
    let gid = create_companion_group_impl(t.state(), "软件公司".into(), None, None)
        .await
        .unwrap();
    add_companion_to_group_impl(t.state(), gid, pm).await.unwrap();
    let launched = launch_work_job_impl(t.state(), gid, "做个 app", None).await.unwrap();

    // launch 的 intake 协作仍在跑(mock LLM 不会真收尾)→ 闸 2b:插话**收下**而非拒绝
    // (消息已落库,intake 收尾后 finalize 检测积压自动续轮),且不并发起新 intake。
    assert!(db.has_active_work_intake(&launched.session_id), "前置:intake 应在跑");
    let out = dispatch_work_followup(t.state(), &launched.session_id, "再加个深色模式", &[])
        .await
        .unwrap();
    match out {
        WorkFollowup::Notice(text) => assert!(text.contains("收到"), "应确认收下而非拒绝:{text}"),
        WorkFollowup::Intake(_) => panic!("intake 在跑时不应再起新 intake(并发竞态)"),
    }
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn work_followup_mention_routes_directly_to_worker_not_lead() {
    use app_lib::commands::work::{dispatch_work_followup, launch_work_job_impl, WorkFollowup};
    // 2026-06-12 @ 通信规则:消息默认给牵头者;@ 某个工人 → 任务直达该成员(单步
    // project_task 协作),不经牵头者、不受 intake 互斥闸约束。
    let t = build_test_app_state().await;
    let db = t.state().db.clone();
    let pm = db.adopt_companion(&new_pm("产品经理")).unwrap();
    let fe = db.adopt_companion(&new_companion("前端工人")).unwrap();
    let mock = MockLlmServer::start().await;
    mock.mock_chat_completion_response(&decision_json(&[(pm, 0.9)])).await;
    seed_mock_llm_provider(t.state(), &mock, "mock-model").await;
    let gid = create_companion_group_impl(t.state(), "软件公司".into(), None, None)
        .await
        .unwrap();
    add_companion_to_group_impl(t.state(), gid, pm).await.unwrap();
    add_companion_to_group_impl(t.state(), gid, fe).await.unwrap();
    let launched = launch_work_job_impl(t.state(), gid, "做个 app", None).await.unwrap();
    let sid = launched.session_id.clone();

    // intake 还在跑(mock 不收尾)—— @ 工人不受互斥闸拦截,直达派活。
    assert!(db.has_active_work_intake(&sid), "前置:intake 应在跑");
    let out = dispatch_work_followup(t.state(), &sid, "按钮改成蓝色", &[fe])
        .await
        .unwrap();
    let collab_id = match out {
        WorkFollowup::Intake(id) => id,
        WorkFollowup::Notice(text) => panic!("@ 工人应直达派活,不该被闸拦:{text}"),
    };
    // 直达协作:kind=work_dispatch(完成走 work 交付分支),参与者是被 @ 的工人。
    assert_eq!(
        db.get_collaboration_kind(collab_id).as_deref(),
        Some("work_dispatch"),
        "直达任务应标 work_dispatch",
    );
    assert_eq!(db.get_work_job_status(&sid).as_deref(), Some("running"), "有人干活 → running");
    // 锚点消息直达样式(🔧 @名字)。
    let msgs = db.get_recent_messages(&sid, 10).unwrap();
    assert!(
        msgs.iter().any(|m| m.content.contains("🔧 @前端工人")),
        "应有直达锚点消息",
    );
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn work_followup_answers_pending_question_while_intake_active() {
    use app_lib::commands::work::{dispatch_work_followup, launch_work_job_impl, WorkFollowup};
    use app_lib::engine::db::PendingQuestion;
    let t = build_test_app_state().await;
    let db = t.state().db.clone();
    let pm = db.adopt_companion(&new_pm("产品经理")).unwrap();
    let mock = MockLlmServer::start().await;
    mock.mock_chat_completion_response(&decision_json(&[(pm, 0.9)])).await;
    seed_mock_llm_provider(t.state(), &mock, "mock-model").await;
    let gid = create_companion_group_impl(t.state(), "软件公司".into(), None, None)
        .await
        .unwrap();
    add_companion_to_group_impl(t.state(), gid, pm).await.unwrap();
    let launched = launch_work_job_impl(t.state(), gid, "做个游戏", None).await.unwrap();
    let sid = launched.session_id.clone();

    // 闸 2a:牵头者阻塞在 ask_user 等答案(pending_questions 有未答行)时,用户在输入框
    // 发的消息**就是答案** —— 后端兜底投递(前端提问卡未恢复/事件丢失时不再死锁)。
    assert!(db.has_active_work_intake(&sid), "前置:intake 应在跑");
    db.insert_pending_question(&PendingQuestion {
        request_id: "q-genre".into(),
        session_id: sid.clone(),
        collaboration_id: Some(launched.collaboration_id),
        step_id: None,
        companion_id: pm,
        asker_name: "产品经理".into(),
        question: "做什么类型的游戏?".into(),
        options_json: None,
        kind: "text".into(),
        status: "pending".into(),
        answer: None,
        created_at: chrono::Utc::now().timestamp_millis(),
        answered_at: None,
    })
    .unwrap();

    let out = dispatch_work_followup(t.state(), &sid, "模拟经营类", &[]).await.unwrap();
    assert!(
        matches!(out, WorkFollowup::Notice(ref text) if text.is_empty()),
        "答案投递后静默收束(牵头者会接着说),不另发提示",
    );
    let q = db.get_pending_question("q-genre").expect("问题仍在库");
    assert_eq!(q.status, "answered", "用户消息应被投递为答案");
    assert_eq!(q.answer.as_deref(), Some("模拟经营类"));
}

fn new_role(name: &str, slug: &str) -> NewCompanion {
    NewCompanion {
        name: name.into(),
        agent_definition_name: slug.into(),
        avatar_emoji: "🤖".into(),
        color_hex: "#10B981".into(),
        persona_md_path: None,
        memory_user_id: format!("{slug}_{name}"),
        metadata_json: None,
        role_label: Some(slug.into()),
    }
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn dispatch_auto_appends_verify_step_when_team_has_qa() {
    use app_lib::engine::work::launcher::dispatch_work_plan;
    use app_lib::engine::work::plan::{ProjectPlan, ProjectTask};
    // #2 验证门:方案只派了前端、没排 QA,但团队里有 QA → dispatch 自动追加一个验证步,
    // 依赖前端步(最后跑)。PM 忘了排 QA 也兜得住。
    let t = build_test_app_state().await;
    let db = t.state().db.clone();
    let fe = db.adopt_companion(&new_role("前端", "frontend_dev")).unwrap();
    let qa = db.adopt_companion(&new_role("质检", "qa_engineer")).unwrap();
    let mock = MockLlmServer::start().await;
    mock.mock_chat_completion_response(&decision_json(&[(fe, 0.9)])).await;
    seed_mock_llm_provider(t.state(), &mock, "mock-model").await;
    let cfg = resolve_llm_config(t.state()).await.unwrap();
    let gid = create_companion_group_impl(t.state(), "软件公司".into(), None, None)
        .await
        .unwrap();
    add_companion_to_group_impl(t.state(), gid, fe).await.unwrap();
    add_companion_to_group_impl(t.state(), gid, qa).await.unwrap();
    let sid = "work-verify-gate";
    db.ensure_session(sid, "做个 app", "work", None).unwrap();
    db.set_session_group(sid, Some(gid)).unwrap();
    db.create_work_job(sid, "做个 app", None).unwrap();

    let plan = ProjectPlan {
        tasks: vec![ProjectTask { role: "frontend_dev".into(), objective: "写界面".into(), depends_on: vec![] }],
    };
    let collab_id = dispatch_work_plan(db.clone(), cfg.clone(), sid, &plan).await.unwrap();

    let orch = SqliteOrchestrator::new(db.clone(), Arc::new(ConcreteExecutor::new(cfg)));
    let c = orch
        .list_recent_by_session(sid, 5)
        .unwrap()
        .into_iter()
        .find(|c| c.id == collab_id)
        .expect("派工协作应落库");
    // 1 个前端步 + 1 个自动追加的 QA 验证步。
    assert_eq!(c.plan.steps.len(), 2, "应自动追加 QA 验证步,got {} 步", c.plan.steps.len());
    let verify = &c.plan.steps[1];
    assert_eq!(verify.participants[0].companion_id, qa, "验证步应派给 QA");
    assert_eq!(verify.depends_on, vec![c.plan.steps[0].id], "验证步应依赖前面所有步");
    assert!(verify.input.prompt.contains("验证"), "验证步 prompt 应是检查交付");
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn dispatch_no_verify_step_when_qa_already_in_plan() {
    use app_lib::engine::work::launcher::dispatch_work_plan;
    use app_lib::engine::work::plan::{ProjectPlan, ProjectTask};
    // PM 已经把 QA 排进方案 → 不重复追加。
    let t = build_test_app_state().await;
    let db = t.state().db.clone();
    let fe = db.adopt_companion(&new_role("前端", "frontend_dev")).unwrap();
    let qa = db.adopt_companion(&new_role("质检", "qa_engineer")).unwrap();
    let mock = MockLlmServer::start().await;
    mock.mock_chat_completion_response(&decision_json(&[(fe, 0.9)])).await;
    seed_mock_llm_provider(t.state(), &mock, "mock-model").await;
    let cfg = resolve_llm_config(t.state()).await.unwrap();
    let gid = create_companion_group_impl(t.state(), "软件公司".into(), None, None).await.unwrap();
    add_companion_to_group_impl(t.state(), gid, fe).await.unwrap();
    add_companion_to_group_impl(t.state(), gid, qa).await.unwrap();
    let sid = "work-verify-already";
    db.ensure_session(sid, "x", "work", None).unwrap();
    db.set_session_group(sid, Some(gid)).unwrap();
    db.create_work_job(sid, "x", None).unwrap();

    let plan = ProjectPlan {
        tasks: vec![
            ProjectTask { role: "frontend_dev".into(), objective: "写界面".into(), depends_on: vec![] },
            ProjectTask { role: "qa_engineer".into(), objective: "测".into(), depends_on: vec![0] },
        ],
    };
    let collab_id = dispatch_work_plan(db.clone(), cfg.clone(), sid, &plan).await.unwrap();
    let orch = SqliteOrchestrator::new(db.clone(), Arc::new(ConcreteExecutor::new(cfg)));
    let c = orch.list_recent_by_session(sid, 5).unwrap().into_iter().find(|c| c.id == collab_id).unwrap();
    assert_eq!(c.plan.steps.len(), 2, "QA 已在方案里,不该再追加,got {} 步", c.plan.steps.len());
}
