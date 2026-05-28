//! 家族会话「host 上游路由」的集成测试 —— `commands/agent/family_dispatch.rs`。
//!
//! L1 多成员模型:judge 现在返回 `members: [{id, confidence, reason}, ...]`,
//! family_dispatch 转成 ParallelAgents plan(1+ 成员)。本文件覆盖:
//! family_mode 持久化、空家族自答、单成员高置信派遣、多成员同框派遣、
//! 低置信自答(测 confidence 门控)、多轮 parent_id 链、Approach B 组绑定。
//! 用 MockLlmServer 驱动 judge,TempDb 隔离,#[serial](SQLite + 全局 usage 追踪)。

mod common;

#[allow(unused_imports)]
use common::*;

use std::sync::Arc;

use app_lib::commands::agent::family_dispatch::{try_family_dispatch, FamilyDispatchOutcome};
use app_lib::commands::agent::resolve_llm_config;
use app_lib::commands::companion_groups::{
    add_companion_to_group_impl, create_companion_group_impl, set_session_group_impl,
};
use app_lib::engine::agents::MemoryScope;
use app_lib::engine::collaboration::audit::AuditTrail;
use app_lib::engine::collaboration::executor::ConcreteExecutor;
use app_lib::engine::collaboration::orchestrator::SqliteOrchestrator;
use app_lib::engine::collaboration::{family_group_bucket, AuditKind, CollaborationMode};
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

/// Mock LLM 返回的 dispatch JSON —— 新形态 `members` 数组。
/// 传一个 `(companion_id, confidence)` 列表,每项理由固定一句话(测试只关心
/// id/confidence 走通 judge,文案细节归 strategy 单测)。
fn decision_json(members: &[(i64, f64)]) -> String {
    let parts: Vec<String> = members
        .iter()
        .map(|(id, conf)| {
            format!(r#"{{"id": {id}, "confidence": {conf}, "reason": "代码评审交给它"}}"#)
        })
        .collect();
    format!(r#"{{"members": [{}]}}"#, parts.join(","))
}

// === family_mode 持久化 ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn family_mode_persists_round_trip() {
    let t = build_test_app_state().await;
    let db = &t.state().db;
    db.create_session("会话A").ok();
    let sid = "fam-roundtrip";
    db.set_session_family_mode(sid, true).unwrap(); // UPSERT 建行

    // 默认关、设开、设关都应正确读回。
    assert!(db.get_session_family_mode(sid));
    db.set_session_family_mode(sid, false).unwrap();
    assert!(!db.get_session_family_mode(sid));
    // 不存在的 session 默认关。
    assert!(!db.get_session_family_mode("never-existed"));
}

// === 空家族 → 主精灵自答 ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn try_family_dispatch_with_empty_family_self_answers() {
    let mock = MockLlmServer::start().await;
    let t = build_test_app_state().await;
    seed_mock_llm_provider(t.state(), &mock, "mock-model").await;
    let cfg = resolve_llm_config(t.state()).await.unwrap();
    let db = t.state().db.clone();
    db.ensure_session("fam-empty", "家族测试", "chat", None).ok();

    // 没有任何 active companion —— judge 在 LLM 调用前就 fallback。
    let outcome = try_family_dispatch(db, cfg, "fam-empty", "帮我写点东西")
        .await
        .unwrap();
    assert!(
        matches!(outcome, FamilyDispatchOutcome::SelfAnswer { .. }),
        "空家族应主精灵自答，got {outcome:?}"
    );
}

// === 高置信单成员 → 派遣 ParallelAgents(1 人)===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn try_family_dispatch_high_confidence_single_member_dispatches() {
    let t = build_test_app_state().await;
    let cid = t.state().db.adopt_companion(&new_companion("阿狸")).unwrap();

    let mock = MockLlmServer::start().await;
    mock.mock_chat_completion_response(&decision_json(&[(cid, 0.9)])).await;
    seed_mock_llm_provider(t.state(), &mock, "mock-model").await;
    let cfg = resolve_llm_config(t.state()).await.unwrap();
    let db = t.state().db.clone();
    let sid = "fam-dispatch";
    db.ensure_session(sid, "家族测试", "chat", None).ok();

    let outcome = try_family_dispatch(db.clone(), cfg.clone(), sid, "帮我看看这段代码")
        .await
        .unwrap();

    let collab_id = match outcome {
        FamilyDispatchOutcome::Dispatched {
            collaboration_id,
            members,
        } => {
            assert_eq!(members.len(), 1, "高置信单选应只派 1 人");
            assert_eq!(members[0].companion_id, cid, "应派给被 judge 选中的成员");
            assert_eq!(members[0].name, "阿狸");
            collaboration_id
        }
        other => panic!("高置信应派遣，got {other:?}"),
    };

    // 协作已落库,mode = Dispatched(0)（主精灵派遣）,首轮无 parent。
    let orch = SqliteOrchestrator::new(db.clone(), Arc::new(ConcreteExecutor::new(cfg)));
    let collabs = orch.list_recent_by_session(sid, 5).unwrap();
    let c = collabs
        .iter()
        .find(|c| c.id == collab_id)
        .expect("collaboration 应已持久化");
    assert_eq!(c.mode, CollaborationMode::Dispatched(0));
    assert_eq!(c.parent_id, None);

    // 路由理由持久化:DispatchJudged audit 用 `members` 数组(L1 多成员),top-level
    // 还有 reason / confidence。刷新/重放可读出。
    let events = AuditTrail::new(db.clone()).list(collab_id).expect("audit list");
    let judged = events
        .iter()
        .find(|e| e.kind == AuditKind::DispatchJudged)
        .expect("应写入 DispatchJudged audit");
    let members_arr = judged.payload["members"].as_array().expect("members 数组");
    assert_eq!(members_arr.len(), 1, "audit payload 应含 1 个成员");
    assert_eq!(
        members_arr[0]["companion_id"].as_i64().expect("companion_id"),
        cid,
    );
    assert_eq!(members_arr[0]["name"].as_str(), Some("阿狸"));
    // top-level reason 是 strategy 拼的摘要("挑了 1 位成员:阿狸"),含 name。
    let reason = judged.payload["reason"].as_str().unwrap_or("");
    assert!(reason.contains("阿狸"), "reason 应含成员名,got: {reason:?}");
    assert!(
        (judged.payload["confidence"].as_f64().expect("confidence") - 0.9).abs() < 0.01,
    );

    // 记忆 scope 升级 Family:family_dispatch 在 submit 前把 participant.memory_scope
    // 从 build_plan 默认的 Private 翻成 Family,共享 family_shared bucket。
    let participant = c
        .plan
        .steps
        .first()
        .and_then(|s| s.participants.first())
        .expect("step 应含 participant");
    assert!(
        matches!(participant.memory_scope, MemoryScope::Family),
        "派遣成员 memory_scope 应升级为 Family,got {:?}",
        participant.memory_scope,
    );
}

// === L1 核心:多成员同框 → ParallelAgents(N 人)===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn try_family_dispatch_multi_member_dispatches_in_one_step() {
    let t = build_test_app_state().await;
    let db = t.state().db.clone();
    let cid_a = db.adopt_companion(&new_companion("阿狸")).unwrap();
    let cid_b = db.adopt_companion(&new_companion("小冰")).unwrap();
    let cid_c = db.adopt_companion(&new_companion("九尾")).unwrap();

    // judge 挑 A + B(高置信),C 沾边但 confidence 不足 → 应被 strategy 阈值过滤。
    let mock = MockLlmServer::start().await;
    mock.mock_chat_completion_response(&decision_json(&[
        (cid_a, 0.85),
        (cid_b, 0.7),
        (cid_c, 0.3), // 低于 0.5 阈值,strategy 应自己丢弃
    ]))
    .await;
    seed_mock_llm_provider(t.state(), &mock, "mock-model").await;
    let cfg = resolve_llm_config(t.state()).await.unwrap();

    let sid = "fam-multi";
    db.ensure_session(sid, "家族测试", "chat", None).ok();

    let outcome = try_family_dispatch(db.clone(), cfg.clone(), sid, "聊聊设计 + 写点文案")
        .await
        .unwrap();
    let (collab_id, member_ids) = match outcome {
        FamilyDispatchOutcome::Dispatched {
            collaboration_id,
            members,
        } => {
            let ids: Vec<i64> = members.iter().map(|m| m.companion_id).collect();
            (collaboration_id, ids)
        }
        other => panic!("多成员高置信应派遣,got {other:?}"),
    };

    // strategy 应过滤掉 C(0.3 < 0.5)而保留 A、B。
    assert_eq!(member_ids.len(), 2, "应只派 2 人(C 被阈值过滤),got {member_ids:?}");
    assert!(member_ids.contains(&cid_a));
    assert!(member_ids.contains(&cid_b));
    assert!(!member_ids.contains(&cid_c), "C 置信度不足应被丢弃");

    // plan 是一个 ParallelAgents step,含 2 个 participant,共享 Family scope。
    let orch = SqliteOrchestrator::new(db.clone(), Arc::new(ConcreteExecutor::new(cfg)));
    let c = orch
        .list_recent_by_session(sid, 5)
        .unwrap()
        .into_iter()
        .find(|c| c.id == collab_id)
        .expect("协作已落库");
    let step = c.plan.steps.first().expect("应有 1 个 step");
    assert_eq!(step.participants.len(), 2, "ParallelAgents 应含 2 个成员");
    for p in &step.participants {
        assert!(
            matches!(p.memory_scope, MemoryScope::Family),
            "多成员都该升级到 Family scope,got {:?}",
            p.memory_scope,
        );
    }

    // DispatchJudged audit 的 members 数组也应是 2 个。
    let events = AuditTrail::new(db.clone()).list(collab_id).expect("audit list");
    let judged = events
        .iter()
        .find(|e| e.kind == AuditKind::DispatchJudged)
        .expect("应写入 DispatchJudged audit");
    let members_arr = judged.payload["members"].as_array().expect("members 数组");
    assert_eq!(members_arr.len(), 2, "audit payload 应含 2 个成员");
}

// === 低置信 → 主精灵自答（测 confidence 门控）===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn try_family_dispatch_low_confidence_self_answers() {
    let t = build_test_app_state().await;
    let cid = t.state().db.adopt_companion(&new_companion("小冰")).unwrap();

    let mock = MockLlmServer::start().await;
    // judge 内部阈值 0.5:0.3 直接被 strategy 过滤,selected 空 → fallback 自答。
    mock.mock_chat_completion_response(&decision_json(&[(cid, 0.3)])).await;
    seed_mock_llm_provider(t.state(), &mock, "mock-model").await;
    let cfg = resolve_llm_config(t.state()).await.unwrap();
    let db = t.state().db.clone();
    db.ensure_session("fam-lowconf", "家族测试", "chat", None).ok();

    let outcome = try_family_dispatch(db, cfg, "fam-lowconf", "随便聊聊")
        .await
        .unwrap();
    assert!(
        matches!(outcome, FamilyDispatchOutcome::SelfAnswer { .. }),
        "置信度 0.3 < 0.5 应主精灵自答，got {outcome:?}"
    );
}

// === 多轮接力 → parent_id 链 ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn try_family_dispatch_chains_parent_id_across_turns() {
    let t = build_test_app_state().await;
    let cid = t.state().db.adopt_companion(&new_companion("九尾")).unwrap();

    let mock = MockLlmServer::start().await;
    mock.mock_chat_completion_response(&decision_json(&[(cid, 0.95)])).await;
    seed_mock_llm_provider(t.state(), &mock, "mock-model").await;
    let cfg = resolve_llm_config(t.state()).await.unwrap();
    let db = t.state().db.clone();
    let sid = "fam-chain";
    db.ensure_session(sid, "家族测试", "chat", None).ok();

    let first = match try_family_dispatch(db.clone(), cfg.clone(), sid, "第一轮").await.unwrap() {
        FamilyDispatchOutcome::Dispatched { collaboration_id, .. } => collaboration_id,
        other => panic!("第一轮应派遣，got {other:?}"),
    };
    let second = match try_family_dispatch(db.clone(), cfg.clone(), sid, "第二轮接着说").await.unwrap() {
        FamilyDispatchOutcome::Dispatched { collaboration_id, .. } => collaboration_id,
        other => panic!("第二轮应派遣，got {other:?}"),
    };
    assert_ne!(first, second, "两轮应是独立协作");

    let orch = SqliteOrchestrator::new(db.clone(), Arc::new(ConcreteExecutor::new(cfg)));
    let collabs = orch.list_recent_by_session(sid, 5).unwrap();
    let c2 = collabs.iter().find(|c| c.id == second).expect("第二轮协作应已持久化");
    assert_eq!(c2.parent_id, Some(first), "第二轮应以 parent_id 串到第一轮");
}

// === Approach B:绑定具名家族后,roster 从组取 + scope 升级到 FamilyGroup ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn try_family_dispatch_uses_group_roster_and_scope_when_session_bound() {
    let t = build_test_app_state().await;
    let db = t.state().db.clone();

    // Setup:adopt 3 个 companion, 把其中 2 个加进"创作小队" group,session 绑这个组。
    let cid_in_a = db.adopt_companion(&new_companion("阿狸")).unwrap();
    let cid_in_b = db.adopt_companion(&new_companion("小冰")).unwrap();
    let cid_other = db.adopt_companion(&new_companion("九尾")).unwrap();
    let gid = create_companion_group_impl(t.state(), "创作小队".into(), Some("📝".into()), None)
        .await
        .unwrap();
    add_companion_to_group_impl(t.state(), gid, cid_in_a).await.unwrap();
    add_companion_to_group_impl(t.state(), gid, cid_in_b).await.unwrap();
    // cid_other 故意不加 —— 验证它**不会**出现在 dispatch 候选里。

    let sid = "fam-group-binding";
    db.ensure_session(sid, "家族测试", "chat", None).unwrap();
    set_session_group_impl(t.state(), sid.into(), Some(gid)).await.unwrap();

    // mock judge:返回组内成员 cid_in_a 高置信度。
    let mock = MockLlmServer::start().await;
    mock.mock_chat_completion_response(&decision_json(&[(cid_in_a, 0.9)])).await;
    seed_mock_llm_provider(t.state(), &mock, "mock-model").await;
    let cfg = resolve_llm_config(t.state()).await.unwrap();

    let outcome = try_family_dispatch(db.clone(), cfg.clone(), sid, "帮我想个文案")
        .await
        .unwrap();
    let collab_id = match outcome {
        FamilyDispatchOutcome::Dispatched { collaboration_id, members } => {
            assert_eq!(members.len(), 1);
            assert_eq!(members[0].companion_id, cid_in_a, "应派给组内成员阿狸");
            collaboration_id
        }
        other => panic!("应派遣,got {other:?}"),
    };

    // 协作落库的 plan participant.memory_scope 是 FamilyGroup(gid) —— 桶名
    // 是 family_shared_<gid>,与 Phase A 单桶 family_shared 隔离。
    let orch = SqliteOrchestrator::new(db.clone(), Arc::new(ConcreteExecutor::new(cfg)));
    let collabs = orch.list_recent_by_session(sid, 5).unwrap();
    let c = collabs.iter().find(|c| c.id == collab_id).expect("协作已落库");
    let participant = c
        .plan
        .steps
        .first()
        .and_then(|s| s.participants.first())
        .expect("step 应含 participant");
    assert_eq!(
        participant.memory_scope,
        MemoryScope::FamilyGroup(gid),
        "scope 应升级为该组的 FamilyGroup",
    );
    // 桶命名约定:family_shared_<gid>,不应等于 Phase A 单桶。
    assert_eq!(family_group_bucket(gid), format!("family_shared_{}", gid));
    assert_ne!(family_group_bucket(gid), "family_shared");

    // 反向验证:组外的 cid_other 没法被 judge 选到 —— 它根本不在 DispatchContext.family
    // 里。这里通过让 mock 试图选 cid_other 来验:judge 的 roster 校验会让它回落自答。
    let mock2 = MockLlmServer::start().await;
    mock2.mock_chat_completion_response(&decision_json(&[(cid_other, 0.95)])).await;
    seed_mock_llm_provider(t.state(), &mock2, "mock-model").await;
    let cfg2 = resolve_llm_config(t.state()).await.unwrap();
    let outcome2 = try_family_dispatch(db, cfg2, sid, "另一个问题").await.unwrap();
    assert!(
        matches!(outcome2, FamilyDispatchOutcome::SelfAnswer { .. }),
        "组外成员 cid_other 不在 roster 里,judge 应回落自答,got {outcome2:?}",
    );
}
