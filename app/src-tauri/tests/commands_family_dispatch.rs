//! 家族会话「host 上游路由」的集成测试 —— `commands/agent/family_dispatch.rs`。
//!
//! IM 心智(本次重构):session 1:1 绑 group。未绑 group → 单聊主精灵自答。
//! 绑了 group → L1 集中粗筛 + L2 个体精筛 + L3 chime-in。
//!
//! L1 + L2 形态:
//! - L1 集中粗筛:strategy 返回 `members: [...]` 候选(N≥0)。
//! - L2 个体精筛:每位候选并发跑 claim,yes 才进 ParallelAgents;
//!   全 no 但候选非空 → 沉默兜底,挑 confidence 最高的 1 位上。
//!
//! Mock 复用:wiremock 同 path 的固定 response 同时供 judge(读 members 字段)
//! 和 claim(读 claim/reason 字段)用。serde 默认忽略未知字段,所以一个 JSON
//! 可以同时表达"judge 选谁 + claim 接不接"。
//!
//! 覆盖:未绑 group 自答、空家族自答、单成员高置信派遣、多成员同框派遣、
//! 低置信自答、L2 沉默兜底、多轮 parent_id 链、不同 group 桶隔离。
//! 用 MockLlmServer 驱动 judge + claim,TempDb 隔离,#[serial]。

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

/// Mock LLM 返回的 JSON,兼容 judge + claim:
/// - judge 读顶层 `members: [{id, confidence, reason}]`
/// - claim 读顶层 `claim: bool` + `reason: string`(默认 true,所有候选都接)
///
/// `accept_all_claims=false` 时把 claim 翻成 false,用来测 L2 沉默兜底。
fn dispatch_and_claim_json(members: &[(i64, f64)], accept_all_claims: bool) -> String {
    let parts: Vec<String> = members
        .iter()
        .map(|(id, conf)| {
            format!(r#"{{"id": {id}, "confidence": {conf}, "reason": "代码评审交给它"}}"#)
        })
        .collect();
    format!(
        r#"{{"members": [{}], "claim": {}, "reason": "{}"}}"#,
        parts.join(","),
        accept_all_claims,
        if accept_all_claims { "我能帮上" } else { "话题别人更合适" },
    )
}

/// 兼容旧用法:默认 claim 全接(L1 行为等价)。
fn decision_json(members: &[(i64, f64)]) -> String {
    dispatch_and_claim_json(members, true)
}

// === 未绑 group → 主精灵自答(单聊心智的核心边界)===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn try_family_dispatch_without_group_self_answers() {
    // IM 心智:session 未绑 group_id → 这是单聊,family_dispatch 直接 SelfAnswer。
    // 哪怕家族里有 N 个 active companion 也不该被拉过来(那是 Phase A 的"全员"
    // 路径,已废弃)。
    let t = build_test_app_state().await;
    let db = t.state().db.clone();
    db.adopt_companion(&new_companion("阿狸")).unwrap();
    db.adopt_companion(&new_companion("小冰")).unwrap();
    let mock = MockLlmServer::start().await;
    mock.mock_chat_completion_response(&decision_json(&[(1, 0.9)])).await;
    seed_mock_llm_provider(t.state(), &mock, "mock-model").await;
    let cfg = resolve_llm_config(t.state()).await.unwrap();
    let sid = "solo-no-group";
    db.ensure_session(sid, "单聊", "chat", None).ok();

    let outcome = try_family_dispatch(db, cfg, sid, "随便说几句", &[])
        .await
        .unwrap();
    assert!(
        matches!(outcome, FamilyDispatchOutcome::SelfAnswer { .. }),
        "未绑 group 的 session 应永远走单聊自答,got {outcome:?}"
    );
}

// === 绑了 group 但 group 内成员为空 → 主精灵自答 ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn try_family_dispatch_with_empty_group_returns_empty_group() {
    let mock = MockLlmServer::start().await;
    let t = build_test_app_state().await;
    seed_mock_llm_provider(t.state(), &mock, "mock-model").await;
    let cfg = resolve_llm_config(t.state()).await.unwrap();
    let db = t.state().db.clone();
    let sid = "fam-empty";
    db.ensure_session(sid, "群聊测试", "chat", None).ok();
    // 建一个空 group 并把 session 绑上 —— group 里没成员,family 列表为空。
    let gid = create_companion_group_impl(t.state(), "空群".into(), Some("🪐".into()), None)
        .await
        .unwrap();
    set_session_group_impl(t.state(), sid.into(), Some(gid)).await.unwrap();

    let outcome = try_family_dispatch(db, cfg, sid, "帮我写点东西", &[])
        .await
        .unwrap();
    // 空群不再无声让主精灵冒充群成员,而是返回 EmptyGroup,由 chat.rs 给可见提示。
    assert!(
        matches!(outcome, FamilyDispatchOutcome::EmptyGroup),
        "空 group 应返回 EmptyGroup,got {outcome:?}"
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
    // IM 心智:派遣测试必须先把 session 绑到一个 group。
    let gid = create_companion_group_impl(t.state(), "小阿狸群".into(), Some("🦊".into()), None)
        .await
        .unwrap();
    add_companion_to_group_impl(t.state(), gid, cid).await.unwrap();
    set_session_group_impl(t.state(), sid.into(), Some(gid)).await.unwrap();

    let outcome = try_family_dispatch(db.clone(), cfg.clone(), sid, "帮我看看这段代码", &[])
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
    // 去中心化下 reason 固定为"群成员自主认领",confidence 固定 1.0(无 judge 评分)。
    assert_eq!(judged.payload["reason"].as_str(), Some("群成员自主认领"));
    assert!(
        (judged.payload["confidence"].as_f64().expect("confidence") - 1.0).abs() < 0.01,
    );

    // 记忆 scope 升级 FamilyGroup(gid):family_dispatch 在 submit 前把
    // participant.memory_scope 从 build_plan 默认的 Private 翻成本 group 的
    // FamilyGroup,所有群内成员共享 family_shared_{gid} 桶。
    let participant = c
        .plan
        .steps
        .first()
        .and_then(|s| s.participants.first())
        .expect("step 应含 participant");
    assert_eq!(
        participant.memory_scope,
        MemoryScope::FamilyGroup(gid),
        "派遣成员 memory_scope 应升级到本 group 的 FamilyGroup,got {:?}",
        participant.memory_scope,
    );
}

// === @点名必答:forced_ids 强制成员上场,跳过 L1/L2 智能路由 ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn try_family_dispatch_forced_mention_dispatches_named_members() {
    let t = build_test_app_state().await;
    let cid_a = t.state().db.adopt_companion(&new_companion("阿狸")).unwrap();
    let cid_b = t.state().db.adopt_companion(&new_companion("小冰")).unwrap();
    // forced 路径不调 judge LLM,但需 provider 让 resolve_llm_config 通过 + 给 detached
    // executor 一个响应(不影响本测试断言的同步 outcome)。
    let mock = MockLlmServer::start().await;
    mock.mock_chat_completion_response(&decision_json(&[(cid_a, 0.9)])).await;
    seed_mock_llm_provider(t.state(), &mock, "mock-model").await;
    let cfg = resolve_llm_config(t.state()).await.unwrap();
    let db = t.state().db.clone();
    let sid = "fam-forced";
    db.ensure_session(sid, "群", "chat", None).ok();
    let gid = create_companion_group_impl(t.state(), "群".into(), Some("👪".into()), None)
        .await
        .unwrap();
    add_companion_to_group_impl(t.state(), gid, cid_a).await.unwrap();
    add_companion_to_group_impl(t.state(), gid, cid_b).await.unwrap();
    set_session_group_impl(t.state(), sid.into(), Some(gid)).await.unwrap();

    // 只点名阿狸(cid_a)→ 必答,跳过智能路由,只派该 1 位(不带出小冰)。
    let outcome = try_family_dispatch(db, cfg, sid, "@阿狸 帮我看下", &[cid_a])
        .await
        .unwrap();
    match outcome {
        FamilyDispatchOutcome::Dispatched { members, .. } => {
            assert_eq!(members.len(), 1, "点名 1 位应只派该 1 位");
            assert_eq!(members[0].companion_id, cid_a, "应派给被点名的成员");
            assert_eq!(members[0].name, "阿狸");
        }
        other => panic!("点名必答应派遣, got {other:?}"),
    }
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

    // 去中心化:无 judge/无置信度过滤。三人都在群里,claim 全接 → 三人都上场。
    let mock = MockLlmServer::start().await;
    mock.mock_chat_completion_response(&decision_json(&[
        (cid_a, 0.85),
        (cid_b, 0.7),
        (cid_c, 0.3),
    ]))
    .await;
    seed_mock_llm_provider(t.state(), &mock, "mock-model").await;
    let cfg = resolve_llm_config(t.state()).await.unwrap();

    let sid = "fam-multi";
    db.ensure_session(sid, "家族测试", "chat", None).ok();
    // IM 心智:绑 group 才能走派遣路径。三人都加进 group。
    let gid = create_companion_group_impl(t.state(), "三人群".into(), Some("👨‍👩‍👧".into()), None)
        .await
        .unwrap();
    for c in [cid_a, cid_b, cid_c] {
        add_companion_to_group_impl(t.state(), gid, c).await.unwrap();
    }
    set_session_group_impl(t.state(), sid.into(), Some(gid)).await.unwrap();

    let outcome = try_family_dispatch(db.clone(), cfg.clone(), sid, "聊聊设计 + 写点文案", &[])
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

    // 全员 claim 接 → 三人都上场。
    assert_eq!(member_ids.len(), 3, "三人都 claim 应都派遣,got {member_ids:?}");
    assert!(member_ids.contains(&cid_a));
    assert!(member_ids.contains(&cid_b));
    assert!(member_ids.contains(&cid_c));

    // plan 是一个 ParallelAgents step,含 3 个 participant,共享 Family scope。
    let orch = SqliteOrchestrator::new(db.clone(), Arc::new(ConcreteExecutor::new(cfg)));
    let c = orch
        .list_recent_by_session(sid, 5)
        .unwrap()
        .into_iter()
        .find(|c| c.id == collab_id)
        .expect("协作已落库");
    let step = c.plan.steps.first().expect("应有 1 个 step");
    assert_eq!(step.participants.len(), 3, "ParallelAgents 应含 3 个成员");
    for p in &step.participants {
        assert_eq!(
            p.memory_scope,
            MemoryScope::FamilyGroup(gid),
            "多成员都该升级到本 group 的 FamilyGroup scope,got {:?}",
            p.memory_scope,
        );
    }

    // DispatchJudged audit 的 members 数组也应是 3 个。
    let events = AuditTrail::new(db.clone()).list(collab_id).expect("audit list");
    let judged = events
        .iter()
        .find(|e| e.kind == AuditKind::DispatchJudged)
        .expect("应写入 DispatchJudged audit");
    let members_arr = judged.payload["members"].as_array().expect("members 数组");
    assert_eq!(members_arr.len(), 3, "audit payload 应含 3 个成员");
}

// === 去中心化:全员都不接 → YiYi 群管家兜底(SelfAnswer),不再强推不想接的人 ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn try_family_dispatch_all_decline_falls_back_to_self_answer() {
    let t = build_test_app_state().await;
    let db = t.state().db.clone();
    let cid_a = db.adopt_companion(&new_companion("阿狸")).unwrap();
    let cid_b = db.adopt_companion(&new_companion("小冰")).unwrap();

    // 全员 claim=no(都说"话题别人更合适")→ 去中心化下没人上场 → YiYi 兜底自答。
    let mock = MockLlmServer::start().await;
    mock.mock_chat_completion_response(&dispatch_and_claim_json(
        &[(cid_a, 0.85), (cid_b, 0.7)],
        false, // claim all decline
    ))
    .await;
    seed_mock_llm_provider(t.state(), &mock, "mock-model").await;
    let cfg = resolve_llm_config(t.state()).await.unwrap();

    let sid = "fam-silence";
    db.ensure_session(sid, "家族测试", "chat", None).ok();
    let gid = create_companion_group_impl(t.state(), "兜底群".into(), Some("🛟".into()), None)
        .await
        .unwrap();
    for c in [cid_a, cid_b] {
        add_companion_to_group_impl(t.state(), gid, c).await.unwrap();
    }
    set_session_group_impl(t.state(), sid.into(), Some(gid)).await.unwrap();

    let outcome = try_family_dispatch(db.clone(), cfg.clone(), sid, "随便聊聊", &[])
        .await
        .unwrap();
    assert!(
        matches!(outcome, FamilyDispatchOutcome::SelfAnswer { .. }),
        "全员不接应回落 YiYi 自答,不再强推,got {outcome:?}"
    );
}

// === 去中心化:被点名成员不在群里 → 回落自答 ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn try_family_dispatch_forced_member_not_in_group_self_answers() {
    let t = build_test_app_state().await;
    let cid = t.state().db.adopt_companion(&new_companion("小冰")).unwrap();

    let mock = MockLlmServer::start().await;
    mock.mock_chat_completion_response(&decision_json(&[(cid, 0.9)])).await;
    seed_mock_llm_provider(t.state(), &mock, "mock-model").await;
    let cfg = resolve_llm_config(t.state()).await.unwrap();
    let db = t.state().db.clone();
    let sid = "fam-forced-absent";
    db.ensure_session(sid, "家族测试", "chat", None).ok();
    let gid = create_companion_group_impl(t.state(), "群".into(), Some("👪".into()), None)
        .await
        .unwrap();
    add_companion_to_group_impl(t.state(), gid, cid).await.unwrap();
    set_session_group_impl(t.state(), sid.into(), Some(gid)).await.unwrap();

    // 点名一个不在群里的 id(99999)→ forced ∩ 群成员为空 → 回落自答。
    let outcome = try_family_dispatch(db, cfg, sid, "随便聊聊", &[99999])
        .await
        .unwrap();
    assert!(
        matches!(outcome, FamilyDispatchOutcome::SelfAnswer { .. }),
        "被点名的成员不在群里应回落自答,got {outcome:?}"
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
    let gid = create_companion_group_impl(t.state(), "九尾群".into(), Some("🦊".into()), None)
        .await
        .unwrap();
    add_companion_to_group_impl(t.state(), gid, cid).await.unwrap();
    set_session_group_impl(t.state(), sid.into(), Some(gid)).await.unwrap();

    let first = match try_family_dispatch(db.clone(), cfg.clone(), sid, "第一轮", &[]).await.unwrap() {
        FamilyDispatchOutcome::Dispatched { collaboration_id, .. } => collaboration_id,
        other => panic!("第一轮应派遣，got {other:?}"),
    };
    let second = match try_family_dispatch(db.clone(), cfg.clone(), sid, "第二轮接着说", &[]).await.unwrap() {
        FamilyDispatchOutcome::Dispatched { collaboration_id, .. } => collaboration_id,
        other => panic!("第二轮应派遣，got {other:?}"),
    };
    assert_ne!(first, second, "两轮应是独立协作");

    let orch = SqliteOrchestrator::new(db.clone(), Arc::new(ConcreteExecutor::new(cfg)));
    let collabs = orch.list_recent_by_session(sid, 5).unwrap();
    let c2 = collabs.iter().find(|c| c.id == second).expect("第二轮协作应已持久化");
    assert_eq!(c2.parent_id, Some(first), "第二轮应以 parent_id 串到第一轮");
}

// === 多 group 桶隔离:不同 group 写不同 family_shared_<id> 桶,组外成员不进 roster ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn try_family_dispatch_uses_group_roster_and_isolates_buckets() {
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

    // mock claim:全员接(decision_json 默认 claim:true)。
    let mock = MockLlmServer::start().await;
    mock.mock_chat_completion_response(&decision_json(&[(cid_in_a, 0.9)])).await;
    seed_mock_llm_provider(t.state(), &mock, "mock-model").await;
    let cfg = resolve_llm_config(t.state()).await.unwrap();

    let outcome = try_family_dispatch(db.clone(), cfg.clone(), sid, "帮我想个文案", &[])
        .await
        .unwrap();
    let (collab_id, member_ids) = match outcome {
        FamilyDispatchOutcome::Dispatched { collaboration_id, members } => {
            let ids: Vec<i64> = members.iter().map(|m| m.companion_id).collect();
            (collaboration_id, ids)
        }
        other => panic!("应派遣,got {other:?}"),
    };
    // 去中心化:组内两位都 claim 接 → 都上场;组外 cid_other **不在 roster**,永不出现
    //(roster 隔离:all_members 只取本 group 的成员)。
    assert_eq!(member_ids.len(), 2, "组内两位都该上场,got {member_ids:?}");
    assert!(member_ids.contains(&cid_in_a));
    assert!(member_ids.contains(&cid_in_b));
    assert!(!member_ids.contains(&cid_other), "组外成员不该被拉进来(roster 隔离)");

    // 协作落库的 plan participant.memory_scope 是 FamilyGroup(gid) —— 桶名
    // 是 family_shared_<gid>,与其他 group 的桶完全隔离。
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
    // 桶命名约定:每个 group 独占 family_shared_<gid>。两个不同 group 的桶
    // 名一定不同 —— 桶隔离的核心保证。
    assert_eq!(family_group_bucket(gid), format!("family_shared_{}", gid));
    assert_ne!(family_group_bucket(gid), family_group_bucket(gid + 1));
}
