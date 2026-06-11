//! 群会话路由的集成测试 —— `commands/agent/group_dispatch.rs`。
//!
//! IM 心智:session 1:1 绑 group。未绑 group → 单聊主精灵自答;空群 → EmptyGroup。
//!
//! 路由(v2 对话循环引擎 = conversation_driver::dispatch_group_loop):
//! - **全员 + YiYi 入轮**:participants = 全部群成员(按成员顺序)+ 末尾追加 YiYi
//!   (companion_id=0,name "YiYi",emoji 🦊,color #6366F1;群里已有 id=0 则不重复加)。
//!   @点名与非点名走的是**同一条**路径,都把全员拉进第 1 波。
//! - **forced 只决定谁先开口,不过滤成员**:被 @ 点名的成员 wave-1 立即回(delay=0)、
//!   其余变速。forced **不再排他** —— 点 1 个人,其余成员和 YiYi 照样入轮。@ 一个
//!   不在群里的 id 也**不再触发自答兜底**:群照常派遣,只是没有对应成员立即开口。
//! - **wave-1 结构**:N+1 个**各含 1 个 participant** 的独立 step(每成员一个,id 1..N),
//!   而不是一个 ParallelAgents step 含 N 个 participant。mode = Dispatched(0),
//!   所有 participant 的 memory_scope = Group(gid)。
//!
//! 本文件验**同步契约**:try_group_dispatch 的返回(SelfAnswer / EmptyGroup /
//! Dispatched)+ 协作落库形态(plan / mode / parent_id / 成员 scope)。Driver 的
//! 运行时收口(谁发言 / 谁 `<pass>` / 冷场收口)需内容感知 mock,留待集成测试。
//! Mock 固定响应即可(同步路径不依赖 LLM 内容),TempDb 隔离,#[serial]。

mod common;

#[allow(unused_imports)]
use common::*;

use std::sync::Arc;

use app_lib::commands::agent::group_dispatch::{try_group_dispatch, GroupDispatchOutcome};
use app_lib::commands::agent::resolve_llm_config;
use app_lib::commands::companion_groups::{
    add_companion_to_group_impl, create_companion_group_impl, set_session_group_impl,
};
use app_lib::engine::agents::MemoryScope;
use app_lib::engine::collaboration::executor::ConcreteExecutor;
use app_lib::engine::collaboration::orchestrator::SqliteOrchestrator;
use app_lib::engine::collaboration::{group_bucket, CollaborationMode};
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
async fn try_group_dispatch_without_group_self_answers() {
    // IM 心智:session 未绑 group_id → 这是单聊,group_dispatch 直接 SelfAnswer。
    // 哪怕群里有 N 个 active companion 也不该被拉过来(那是 Phase A 的"全员"
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

    let outcome = try_group_dispatch(db, cfg, sid, "随便说几句", &[])
        .await
        .unwrap();
    assert!(
        matches!(outcome, GroupDispatchOutcome::SelfAnswer { .. }),
        "未绑 group 的 session 应永远走单聊自答,got {outcome:?}"
    );
}

// === 绑了 group 但 group 内成员为空 → 主精灵自答 ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn try_group_dispatch_with_empty_group_returns_empty_group() {
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

    let outcome = try_group_dispatch(db, cfg, sid, "帮我写点东西", &[])
        .await
        .unwrap();
    // 空群不再无声让主精灵冒充群成员,而是返回 EmptyGroup,由 chat.rs 给可见提示。
    assert!(
        matches!(outcome, GroupDispatchOutcome::EmptyGroup),
        "空 group 应返回 EmptyGroup,got {outcome:?}"
    );
}

// === 非点名:单群成员 → 全员(含 YiYi 兜底)入轮 ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn try_group_dispatch_high_confidence_single_member_dispatches() {
    let t = build_test_app_state().await;
    let cid = t.state().db.adopt_companion(&new_companion("阿狸")).unwrap();

    let mock = MockLlmServer::start().await;
    mock.mock_chat_completion_response(&decision_json(&[(cid, 0.9)])).await;
    seed_mock_llm_provider(t.state(), &mock, "mock-model").await;
    let cfg = resolve_llm_config(t.state()).await.unwrap();
    let db = t.state().db.clone();
    let sid = "fam-dispatch";
    db.ensure_session(sid, "群测试", "chat", None).ok();
    // IM 心智:派遣测试必须先把 session 绑到一个 group。
    let gid = create_companion_group_impl(t.state(), "小阿狸群".into(), Some("🦊".into()), None)
        .await
        .unwrap();
    add_companion_to_group_impl(t.state(), gid, cid).await.unwrap();
    set_session_group_impl(t.state(), sid.into(), Some(gid)).await.unwrap();

    let outcome = try_group_dispatch(db.clone(), cfg.clone(), sid, "帮我看看这段代码", &[])
        .await
        .unwrap();

    let collab_id = match outcome {
        GroupDispatchOutcome::Dispatched {
            collaboration_id,
            members,
        } => {
            // v2:全员入轮 + 末尾追加 YiYi 兜底 → [阿狸, YiYi]。
            assert_eq!(members.len(), 2, "非点名:全员(含 YiYi 兜底)入轮");
            assert_eq!(members[0].companion_id, cid, "群成员排在前");
            assert_eq!(members[0].name, "阿狸");
            assert_eq!(members[1].companion_id, 0, "YiYi(id=0)追加在末尾");
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

    // 对话循环引擎:非 @点名路径不再前置 judge/claim,"谁该说话"是发言本身(fused
    // reply-or-<pass>)。因此不再写 DispatchJudged audit —— Driver 用 Submitted
    // (driven:true)记录。这里只验派遣 + 落库 + scope。

    // 记忆 scope 升级 Group(gid):group_dispatch 在 submit 前把
    // participant.memory_scope 从 build_plan 默认的 Private 翻成本 group 的
    // Group,所有群内成员共享 group_shared_{gid} 桶。
    let participant = c
        .plan
        .steps
        .first()
        .and_then(|s| s.participants.first())
        .expect("step 应含 participant");
    assert_eq!(
        participant.memory_scope,
        MemoryScope::Group(gid),
        "派遣成员 memory_scope 应升级到本 group 的 Group,got {:?}",
        participant.memory_scope,
    );
}

// === v2:@点名只让被点的先开口,不排他;全员 + YiYi 照样入轮 ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn try_group_dispatch_forced_mention_dispatches_named_members() {
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

    // 只点名阿狸(cid_a)→ v2 forced **不排他**:阿狸 wave-1 立即开口,小冰 + YiYi
    // 照样入轮(变速接话)。members = [阿狸, 小冰, YiYi]。
    let outcome = try_group_dispatch(db, cfg, sid, "@阿狸 帮我看下", &[cid_a])
        .await
        .unwrap();
    match outcome {
        GroupDispatchOutcome::Dispatched { members, .. } => {
            let ids: Vec<i64> = members.iter().map(|m| m.companion_id).collect();
            assert_eq!(ids.len(), 3, "@点名不排他:全员 + YiYi 入轮,got {ids:?}");
            assert!(ids.contains(&cid_a), "被点名的阿狸在轮里(且 delay=0 先开口)");
            assert!(ids.contains(&cid_b), "未被点名的小冰照样入轮(forced 不排他)");
            assert!(ids.contains(&0), "YiYi(id=0)兜底入轮");
        }
        other => panic!("@点名应派遣(全员入轮), got {other:?}"),
    }
}

// === 多成员:全员 + YiYi 入轮,wave-1 = N+1 个各 1-participant 的独立 step ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn try_group_dispatch_multi_member_dispatches_in_one_step() {
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
    db.ensure_session(sid, "群测试", "chat", None).ok();
    // IM 心智:绑 group 才能走派遣路径。三人都加进 group。
    let gid = create_companion_group_impl(t.state(), "三人群".into(), Some("👨‍👩‍👧".into()), None)
        .await
        .unwrap();
    for c in [cid_a, cid_b, cid_c] {
        add_companion_to_group_impl(t.state(), gid, c).await.unwrap();
    }
    set_session_group_impl(t.state(), sid.into(), Some(gid)).await.unwrap();

    let outcome = try_group_dispatch(db.clone(), cfg.clone(), sid, "聊聊设计 + 写点文案", &[])
        .await
        .unwrap();
    let (collab_id, member_ids) = match outcome {
        GroupDispatchOutcome::Dispatched {
            collaboration_id,
            members,
        } => {
            let ids: Vec<i64> = members.iter().map(|m| m.companion_id).collect();
            (collaboration_id, ids)
        }
        other => panic!("多成员高置信应派遣,got {other:?}"),
    };

    // v2:全员入轮 + 末尾追加 YiYi → 三人 + YiYi = 4 位。
    assert_eq!(member_ids.len(), 4, "三人 + YiYi 都入轮,got {member_ids:?}");
    assert!(member_ids.contains(&cid_a));
    assert!(member_ids.contains(&cid_b));
    assert!(member_ids.contains(&cid_c));

    // v2 wave-1 结构:N+1 个**各含 1 个 participant** 的独立 step(每成员一个),
    // 而非一个 ParallelAgents step 含 N 个 participant。所有 participant scope = Group(gid)。
    let orch = SqliteOrchestrator::new(db.clone(), Arc::new(ConcreteExecutor::new(cfg)));
    let c = orch
        .list_recent_by_session(sid, 5)
        .unwrap()
        .into_iter()
        .find(|c| c.id == collab_id)
        .expect("协作已落库");
    assert_eq!(c.plan.steps.len(), 4, "wave-1 应是 4 个独立 step(三人 + YiYi)");
    for step in &c.plan.steps {
        assert_eq!(step.participants.len(), 1, "每个 step 只含 1 个 participant");
        for p in &step.participants {
            assert_eq!(
                p.memory_scope,
                MemoryScope::Group(gid),
                "成员都该升级到本 group 的 Group scope,got {:?}",
                p.memory_scope,
            );
        }
    }
    // 对话循环引擎:不再有 DispatchJudged(无前置 judge/claim)。全员入第 1 轮,
    // 谁发言谁 <pass> 在运行时由 fused prompt 自决。
}

// === 对话循环引擎:非 @点名 = 全员进第 1 轮(不再前置 claim 过滤 / 同步兜底)===
// 旧行为(全员 claim=no → 同步 SelfAnswer)已退役:"接不接"现在是发言本身
// (fused reply-or-`<pass>`)。全员 `<pass>` → YiYi 兜底是 Driver 运行时的下一步
// (异步,需内容感知 mock 才能确定性验证,留待集成测试)。这里验同步契约:返回
// Dispatched 且全员入轮。

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn try_group_dispatch_non_forced_puts_all_members_in_round() {
    let t = build_test_app_state().await;
    let db = t.state().db.clone();
    let cid_a = db.adopt_companion(&new_companion("阿狸")).unwrap();
    let cid_b = db.adopt_companion(&new_companion("小冰")).unwrap();

    let mock = MockLlmServer::start().await;
    mock.mock_chat_completion_response(&decision_json(&[(cid_a, 0.85), (cid_b, 0.7)]))
        .await;
    seed_mock_llm_provider(t.state(), &mock, "mock-model").await;
    let cfg = resolve_llm_config(t.state()).await.unwrap();

    let sid = "fam-allin";
    db.ensure_session(sid, "群测试", "chat", None).ok();
    let gid = create_companion_group_impl(t.state(), "全员群".into(), Some("🛟".into()), None)
        .await
        .unwrap();
    for c in [cid_a, cid_b] {
        add_companion_to_group_impl(t.state(), gid, c).await.unwrap();
    }
    set_session_group_impl(t.state(), sid.into(), Some(gid)).await.unwrap();

    let outcome = try_group_dispatch(db.clone(), cfg.clone(), sid, "随便聊聊", &[])
        .await
        .unwrap();
    match outcome {
        GroupDispatchOutcome::Dispatched { members, .. } => {
            let ids: Vec<i64> = members.iter().map(|m| m.companion_id).collect();
            // v2:两位群成员 + 末尾追加 YiYi = 3 位入轮。
            assert_eq!(ids.len(), 3, "非点名应把全员 + YiYi 放进第 1 轮,got {ids:?}");
            assert!(ids.contains(&cid_a) && ids.contains(&cid_b));
            assert!(ids.contains(&0), "YiYi(id=0)兜底入轮");
        }
        other => panic!("非点名应派遣(全员入轮),got {other:?}"),
    }
}

// === v2:@ 一个不在群的 id 不再触发自答兜底,群照常派遣 ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn try_group_dispatch_forced_member_not_in_group_self_answers() {
    let t = build_test_app_state().await;
    let cid = t.state().db.adopt_companion(&new_companion("小冰")).unwrap();

    let mock = MockLlmServer::start().await;
    mock.mock_chat_completion_response(&decision_json(&[(cid, 0.9)])).await;
    seed_mock_llm_provider(t.state(), &mock, "mock-model").await;
    let cfg = resolve_llm_config(t.state()).await.unwrap();
    let db = t.state().db.clone();
    let sid = "fam-forced-absent";
    db.ensure_session(sid, "群测试", "chat", None).ok();
    let gid = create_companion_group_impl(t.state(), "群".into(), Some("👪".into()), None)
        .await
        .unwrap();
    add_companion_to_group_impl(t.state(), gid, cid).await.unwrap();
    set_session_group_impl(t.state(), sid.into(), Some(gid)).await.unwrap();

    // 点名一个不在群里的 id(99999)。v2 **没有** "@非成员 → SelfAnswer 兜底" 了 ——
    // 照样进 dispatch_group_loop:全员 + YiYi 入轮。forced 仅影响开口顺序,99999 无对应
    // 成员即无人立即开口,但群照常派遣。members = [小冰, YiYi]。
    let outcome = try_group_dispatch(db, cfg, sid, "随便聊聊", &[99999])
        .await
        .unwrap();
    match outcome {
        GroupDispatchOutcome::Dispatched { members, .. } => {
            let ids: Vec<i64> = members.iter().map(|m| m.companion_id).collect();
            assert_eq!(ids.len(), 2, "群照常派遣:小冰 + YiYi,got {ids:?}");
            assert!(ids.contains(&cid), "在群的成员照常入轮");
            assert!(ids.contains(&0), "YiYi(id=0)兜底入轮");
        }
        other => panic!("@非成员不再自答兜底,应照常派遣,got {other:?}"),
    }
}

// === 多轮接力 → parent_id 链 ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn try_group_dispatch_chains_parent_id_across_turns() {
    let t = build_test_app_state().await;
    let cid = t.state().db.adopt_companion(&new_companion("九尾")).unwrap();

    let mock = MockLlmServer::start().await;
    mock.mock_chat_completion_response(&decision_json(&[(cid, 0.95)])).await;
    seed_mock_llm_provider(t.state(), &mock, "mock-model").await;
    let cfg = resolve_llm_config(t.state()).await.unwrap();
    let db = t.state().db.clone();
    let sid = "fam-chain";
    db.ensure_session(sid, "群测试", "chat", None).ok();
    let gid = create_companion_group_impl(t.state(), "九尾群".into(), Some("🦊".into()), None)
        .await
        .unwrap();
    add_companion_to_group_impl(t.state(), gid, cid).await.unwrap();
    set_session_group_impl(t.state(), sid.into(), Some(gid)).await.unwrap();

    let first = match try_group_dispatch(db.clone(), cfg.clone(), sid, "第一轮", &[]).await.unwrap() {
        GroupDispatchOutcome::Dispatched { collaboration_id, .. } => collaboration_id,
        other => panic!("第一轮应派遣，got {other:?}"),
    };
    let second = match try_group_dispatch(db.clone(), cfg.clone(), sid, "第二轮接着说", &[]).await.unwrap() {
        GroupDispatchOutcome::Dispatched { collaboration_id, .. } => collaboration_id,
        other => panic!("第二轮应派遣，got {other:?}"),
    };
    assert_ne!(first, second, "两轮应是独立协作");

    let orch = SqliteOrchestrator::new(db.clone(), Arc::new(ConcreteExecutor::new(cfg)));
    let collabs = orch.list_recent_by_session(sid, 5).unwrap();
    let c2 = collabs.iter().find(|c| c.id == second).expect("第二轮协作应已持久化");
    assert_eq!(c2.parent_id, Some(first), "第二轮应以 parent_id 串到第一轮");
}

// === 多 group 桶隔离:不同 group 写不同 group_shared_<id> 桶,组外成员不进 roster ===

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn try_group_dispatch_uses_group_roster_and_isolates_buckets() {
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
    db.ensure_session(sid, "群测试", "chat", None).unwrap();
    set_session_group_impl(t.state(), sid.into(), Some(gid)).await.unwrap();

    // mock claim:全员接(decision_json 默认 claim:true)。
    let mock = MockLlmServer::start().await;
    mock.mock_chat_completion_response(&decision_json(&[(cid_in_a, 0.9)])).await;
    seed_mock_llm_provider(t.state(), &mock, "mock-model").await;
    let cfg = resolve_llm_config(t.state()).await.unwrap();

    let outcome = try_group_dispatch(db.clone(), cfg.clone(), sid, "帮我想个文案", &[])
        .await
        .unwrap();
    let (collab_id, member_ids) = match outcome {
        GroupDispatchOutcome::Dispatched { collaboration_id, members } => {
            let ids: Vec<i64> = members.iter().map(|m| m.companion_id).collect();
            (collaboration_id, ids)
        }
        other => panic!("应派遣,got {other:?}"),
    };
    // v2:组内两位 + 末尾追加 YiYi = 3 位上场;组外 cid_other **不在 roster**,永不出现
    //(roster 隔离:dispatch_group_loop 只拿到本 group 的成员)。
    assert_eq!(member_ids.len(), 3, "组内两位 + YiYi 上场,got {member_ids:?}");
    assert!(member_ids.contains(&cid_in_a));
    assert!(member_ids.contains(&cid_in_b));
    assert!(member_ids.contains(&0), "YiYi(id=0)兜底入轮");
    assert!(!member_ids.contains(&cid_other), "组外成员不该被拉进来(roster 隔离)");

    // 协作落库的 plan participant.memory_scope 是 Group(gid) —— 桶名
    // 是 group_shared_<gid>,与其他 group 的桶完全隔离。
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
        MemoryScope::Group(gid),
        "scope 应升级为该组的 Group",
    );
    // 桶命名约定:每个 group 独占 group_shared_<gid>。两个不同 group 的桶
    // 名一定不同 —— 桶隔离的核心保证。
    assert_eq!(group_bucket(gid), format!("group_shared_{}", gid));
    assert_ne!(group_bucket(gid), group_bucket(gid + 1));
}

// === S6 切流量回归:工作群(有工作区)路由 work 还是 chat ===
// 核心:恢复被 WIP 删的 build-intent gate —— 工作群里**明确建造意图**才让牵头者接手(work),
// **闲聊/讨论**照常放养(chat)。判错 = 工作群没法纯闲聊 = WIP 倒退。
// headless(无 app handle)下 find_project_lead 只认 "pm" slug,故牵头者用 agent_def="pm"。

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
async fn workspace_group_message_no_longer_auto_launches_work() {
    // chat×work 2×2 双入口落地后:**群聊永远放养,不再在 chat 里猜 work**(原 should_launch_work
    // + 硬编码建造词表已退役)。work 改从「工作」入口显式发起(launch_work_job)。所以哪怕是
    // 工作区群 + "做个X"(以前会触发 PM 接手),现在也只走放养(全员 + YiYi)。
    let t = build_test_app_state().await;
    let db = t.state().db.clone();
    let pm = db.adopt_companion(&new_pm("产品经理")).unwrap();
    let mock = MockLlmServer::start().await;
    mock.mock_chat_completion_response(&decision_json(&[(pm, 0.9)])).await;
    seed_mock_llm_provider(t.state(), &mock, "mock-model").await;
    let cfg = resolve_llm_config(t.state()).await.unwrap();
    let sid = "ws-retire";
    db.ensure_session(sid, "工作群", "chat", None).ok();
    let gid = create_companion_group_impl(t.state(), "软件公司".into(), None, None)
        .await
        .unwrap();
    db.set_group_workspace(gid, "/tmp/yiyi_ws_retire").unwrap(); // 有工作区也一样放养
    add_companion_to_group_impl(t.state(), gid, pm).await.unwrap();
    set_session_group_impl(t.state(), sid.into(), Some(gid)).await.unwrap();

    // 以前的"建造意图" → 现在也只放养,不再单点 PM intake。
    let outcome = try_group_dispatch(db, cfg, sid, "做个 todo 网页应用", &[])
        .await
        .unwrap();
    match outcome {
        GroupDispatchOutcome::Dispatched { members, .. } => {
            let ids: Vec<i64> = members.iter().map(|m| m.companion_id).collect();
            assert!(ids.contains(&0), "群聊永远放养(含 YiYi 兜底位),不再自动起 work,got {ids:?}");
            assert!(ids.contains(&pm), "放养应含群成员 pm");
            assert!(members.len() >= 2, "放养是全员+YiYi,不是单点 PM intake,got {ids:?}");
        }
        other => panic!("群聊应走放养(work 改从工作入口显式发起),got {other:?}"),
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
    let out = dispatch_work_followup(t.state(), &launched.session_id, "停").await.unwrap();
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
    let out = dispatch_work_followup(t.state(), &launched.session_id, "再加个深色模式")
        .await
        .unwrap();
    match out {
        WorkFollowup::Notice(text) => assert!(text.contains("收到"), "应确认收下而非拒绝:{text}"),
        WorkFollowup::Intake(_) => panic!("intake 在跑时不应再起新 intake(并发竞态)"),
    }
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

    let out = dispatch_work_followup(t.state(), &sid, "模拟经营类").await.unwrap();
    assert!(
        matches!(out, WorkFollowup::Notice(ref text) if text.is_empty()),
        "答案投递后静默收束(牵头者会接着说),不另发提示",
    );
    let q = db.get_pending_question("q-genre").expect("问题仍在库");
    assert_eq!(q.status, "answered", "用户消息应被投递为答案");
    assert_eq!(q.answer.as_deref(), Some("模拟经营类"));
}
