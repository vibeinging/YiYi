//! 真实集成测试 —— 用真实 db 配置 + 真实 DeepSeek API 跑一次群聊去中心化派遣,
//! 实时打印每个成员的流式发言。**不 mock**,验证:
//!   - 去中心化:群成员各自 claim,接的并发回复(无 L1 集中预选)
//!   - 真·流式:每个成员逐字 emit Token 事件
//!   - @点名必答(可选,改 forced 参数)
//!
//! 默认跳过(避免 CI 真实计费)。运行:
//!   YIYI_LIVE_GROUP=1 cargo test --features test-support --test live_group_chat -- --nocapture
//!
//! 做法:把真实 ~/.yiyi/yiyi.db copy 到临时目录再开,避免和正在运行的 app 抢 WAL。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use app_lib::commands::agent::group_dispatch::{
    dispatch_to_companion, try_group_dispatch, GroupDispatchOutcome,
};
use app_lib::engine::collaboration::executor::ConcreteExecutor;
use app_lib::engine::collaboration::orchestrator::SqliteOrchestrator;
use app_lib::engine::collaboration::{
    events, AuditKind, Collaboration, CollaborationEvent, CollaborationOrchestrator,
};
use app_lib::engine::db::{Database, NewCompanion};
use app_lib::engine::llm_client::resolve_config_from_providers;
use app_lib::state::providers::ProvidersState;

/// 把真实 ~/.yiyi/yiyi.db copy 到临时目录再开(拿真 provider 配置,不碰运行中的 app)。
fn open_copied_db(tag: &str) -> (Arc<Database>, std::path::PathBuf) {
    let home = std::env::var("HOME").unwrap();
    let real_db = format!("{home}/.yiyi/yiyi.db");
    let tmp = std::env::temp_dir().join(format!("yiyi_{tag}_{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    std::fs::copy(&real_db, tmp.join("yiyi.db")).expect("copy yiyi.db");
    for ext in ["-wal", "-shm"] {
        let src = format!("{real_db}{ext}");
        if std::path::Path::new(&src).exists() {
            let _ = std::fs::copy(&src, tmp.join(format!("yiyi.db{ext}")));
        }
    }
    (Arc::new(Database::open(&tmp).expect("open db")), tmp)
}

/// 造一个"窄人设"成员 —— 名字直接表达专长(executor 的 group_round system prompt
/// 用 name,模型据此判断接不接;这样能确定性触发"相关回复 / 不相关 <pass>")。
fn narrow_companion(name: &str, emoji: &str) -> NewCompanion {
    NewCompanion {
        name: name.into(),
        agent_definition_name: "code_reviewer".into(),
        avatar_emoji: emoji.into(),
        color_hex: "#F97316".into(),
        persona_md_path: None,
        memory_user_id: format!("live_{name}"),
        metadata_json: None,
        role_label: Some(name.into()),
    }
}

/// 轮询协作直到终态(Driver 后台异步推进),返回最终快照。
async fn wait_terminal(orch: &SqliteOrchestrator, id: i64, secs: u64) -> Option<Collaboration> {
    for _ in 0..(secs * 2) {
        if let Ok(Some(c)) = orch.get(id).await {
            if c.status.is_terminal() {
                return Some(c);
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    orch.get(id).await.ok().flatten()
}

/// 跑一个群场景:先订阅 → 派遣 → 实时打印(正文 + 思考分流)→ 轮询到终态 →
/// 回放落库的每一步产出。返回终态快照供断言。
async fn run_scenario(
    db: Arc<Database>,
    cfg: app_lib::engine::llm_client::LLMConfig,
    orch: &SqliteOrchestrator,
    sid: &str,
    title: &str,
    msg: &str,
    forced: &[i64],
) -> Option<Collaboration> {
    eprintln!("\n\n══════════ {title} ══════════");
    eprintln!("👤 我: {msg}");
    if !forced.is_empty() {
        eprintln!("(@点名必答: {forced:?})");
    }

    let mut rx = events::subscribe();
    let printer = tokio::spawn(async move {
        let mut last: (i64, bool) = (-999, false);
        loop {
            match tokio::time::timeout(Duration::from_secs(60), rx.recv()).await {
                Ok(Ok(CollaborationEvent::Token { companion_id, delta, reasoning, .. })) => {
                    if (companion_id, reasoning) != last {
                        let who = if companion_id == 0 { "YiYi".to_string() } else { format!("#{companion_id}") };
                        eprint!("\n{} {who}: ", if reasoning { "💭" } else { "🗣 " });
                        last = (companion_id, reasoning);
                    }
                    eprint!("{delta}");
                }
                Ok(Ok(CollaborationEvent::Audit { event }))
                    if matches!(
                        event.kind,
                        AuditKind::CollaborationCompleted | AuditKind::Aborted | AuditKind::Failed
                    ) =>
                {
                    eprintln!("\n-- 终态: {:?} --", event.kind);
                    break;
                }
                Ok(Ok(_)) => {}
                _ => break,
            }
        }
    });

    let outcome = try_group_dispatch(db.clone(), cfg, sid, msg, forced).await.unwrap();
    let collab_id = match &outcome {
        GroupDispatchOutcome::Dispatched { collaboration_id, members } => {
            eprintln!(
                "✅ 派遣 collab {collaboration_id},入轮 {} 位: {}",
                members.len(),
                members.iter().map(|m| m.name.clone()).collect::<Vec<_>>().join(", ")
            );
            *collaboration_id
        }
        GroupDispatchOutcome::SelfAnswer { reason } => {
            eprintln!("ℹ️ SelfAnswer(主精灵自答): {reason}");
            return None;
        }
        GroupDispatchOutcome::EmptyGroup => {
            eprintln!("⚠️ 空群");
            return None;
        }
    };

    let _ = tokio::time::timeout(Duration::from_secs(120), printer).await;
    let c = wait_terminal(orch, collab_id, 120).await.expect("应到终态");

    eprintln!("\n────── 落库回放(终态 {:?},{} 步)──────", c.status, c.plan.steps.len());
    for step in &c.plan.steps {
        let out = step.output.as_ref().map(|o| o.full_output.trim().to_string()).unwrap_or_default();
        eprintln!("[{:?} / {:?}] {}", step.kind, step.status, if out.is_empty() { "(空/全员<pass>)".into() } else { out });
    }
    Some(c)
}

/// 群聊全场景 live 实测:① 相关消息(部分成员接、其余 <pass>)② 全让兜底(全员
/// <pass> → YiYi 兜底位接)③ @点名必答(被点者无 <pass> 余地必答)。
/// 用窄人设成员确定性触发,轮询到终态后断言落库产出。
/// 运行:YIYI_LIVE_GROUP=1 cargo test --features test-support --test live_group_chat live_group_all_scenarios -- --nocapture
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn live_group_all_scenarios() {
    if std::env::var("YIYI_LIVE_GROUP").is_err() {
        eprintln!("SKIP live_group_all_scenarios:设 YIYI_LIVE_GROUP=1 才跑(真实调用 DeepSeek)");
        return;
    }
    let (db, tmp) = open_copied_db("live");
    let providers = ProvidersState::load(db.clone());
    let cfg = resolve_config_from_providers(&providers).expect("有 active provider");
    let orch = SqliteOrchestrator::new(db.clone(), Arc::new(ConcreteExecutor::new(cfg.clone())));
    eprintln!("\n========== LIVE 群聊全场景实测 ==========");
    eprintln!("model = {}  base = {}", cfg.model, cfg.base_url);

    // 造可控群:代码审查员 + 英语老师(名字即专长,触发确定性)。
    let coder = db.adopt_companion(&narrow_companion("代码审查员", "🦊")).unwrap();
    let teacher = db.adopt_companion(&narrow_companion("英语老师", "📖")).unwrap();
    let gid = db.create_companion_group("实测小队", Some("🧪"), None).unwrap();
    db.add_group_member(gid, coder).unwrap();
    db.add_group_member(gid, teacher).unwrap();
    let sid = format!("live-all-{}", std::process::id());
    db.ensure_session(&sid, "全场景实测", "chat", None).ok();
    db.set_session_group(&sid, Some(gid)).expect("bind group");
    eprintln!("群 {gid}: 代码审查员({coder}) + 英语老师({teacher})");

    // ① 相关消息(代码)—— 期望代码审查员接、英语老师 <pass>。
    let c1 = run_scenario(
        db.clone(), cfg.clone(), &orch, &sid,
        "① 相关消息(代码,部分成员接)",
        "帮我看看这段 Python 有没有 bug:\ndef add(a, b):\n    retrun a + b",
        &[],
    ).await.expect("① 应派遣");
    let round1 = c1.plan.steps.first().and_then(|s| s.output.as_ref()).map(|o| o.full_output.clone()).unwrap_or_default();
    assert!(!round1.trim().is_empty(), "① 至少应有成员接话(代码审查员)");

    // ② 全让兜底 —— 跟两人专长都不沾,期望全员 <pass> → YiYi 兜底位接。
    let c2 = run_scenario(
        db.clone(), cfg.clone(), &orch, &sid,
        "② 全让兜底(全员 <pass> → YiYi)",
        "帮我订一张明天从上海飞东京的机票,要靠窗。",
        &[],
    ).await.expect("② 应派遣");
    let yiyi_step = c2.plan.steps.iter().find(|s| s.participants.iter().any(|p| p.companion_id == 0));
    assert!(yiyi_step.is_some(), "② 全员 <pass> 时应追加 YiYi 兜底位 step");
    let yiyi_out = yiyi_step.and_then(|s| s.output.as_ref()).map(|o| o.full_output.clone()).unwrap_or_default();
    assert!(!yiyi_out.trim().is_empty(), "② YiYi 兜底应有非空回答");

    // ③ @点名必答 —— 点英语老师答一个代码问题,期望它无 <pass> 余地必答,且不带出代码审查员。
    let c3 = run_scenario(
        db.clone(), cfg.clone(), &orch, &sid,
        "③ @点名必答(英语老师)",
        "@英语老师 帮我把 'hello world' 翻译成正式的中文。",
        &[teacher],
    ).await.expect("③ 应派遣");
    let only = c3.plan.steps.first().map(|s| s.participants.clone()).unwrap_or_default();
    assert_eq!(only.len(), 1, "③ 点名 1 位应只派该 1 位");
    assert_eq!(only[0].companion_id, teacher, "③ 应是被点名的英语老师");
    let r3 = c3.plan.steps.first().and_then(|s| s.output.as_ref()).map(|o| o.full_output.clone()).unwrap_or_default();
    assert!(!r3.trim().is_empty(), "③ 被点名者必答,应有非空回复");

    eprintln!("\n========== 全场景实测结束(①②③ 通过)==========\n");
    let _ = std::fs::remove_dir_all(&tmp);
}

/// 真实测试好友私聊:绑定单个 companion 的会话,dispatch_to_companion 让它 1:1 流式回答。
/// 运行:YIYI_LIVE_PRIVATE=1 cargo test --features test-support --test live_group_chat live_private_chat -- --nocapture
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn live_private_chat() {
    if std::env::var("YIYI_LIVE_PRIVATE").is_err() {
        eprintln!("SKIP live_private_chat:设 YIYI_LIVE_PRIVATE=1 才跑(真实调用 DeepSeek)");
        return;
    }
    let home = std::env::var("HOME").unwrap();
    let real_db = format!("{home}/.yiyi/yiyi.db");
    let tmp = std::env::temp_dir().join(format!("yiyi_priv_{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    std::fs::copy(&real_db, tmp.join("yiyi.db")).expect("copy db");
    for ext in ["-wal", "-shm"] {
        let src = format!("{real_db}{ext}");
        if std::path::Path::new(&src).exists() {
            let _ = std::fs::copy(&src, tmp.join(format!("yiyi.db{ext}")));
        }
    }
    let db = Arc::new(Database::open(&tmp).expect("open db"));
    let providers = ProvidersState::load(db.clone());
    let cfg = resolve_config_from_providers(&providers).expect("有 active provider");

    // 取第一个 companion 当私聊对象。
    let cid: i64 = db
        .list_companion_groups()
        .iter()
        .flat_map(|g| db.list_group_members(g.id))
        .next()
        .map(|c| c.id)
        .or_else(|| db.list_group_members(3).first().map(|c| c.id))
        .expect("需要至少一个 companion");
    let name = db.get_companion(cid).map(|c| c.name).unwrap_or_default();
    eprintln!("\n========== LIVE 好友私聊实测 ==========");
    eprintln!("model = {}  私聊对象 = {name}({cid})", cfg.model);

    // 建会话 + 绑 companion(模拟好友列表点进去)。
    let sid = format!("live-priv-{}", std::process::id());
    db.ensure_session(&sid, &name, "chat", None).ok();
    db.set_session_companion(&sid, Some(cid)).expect("bind companion");
    assert_eq!(db.get_session_companion(&sid), Some(cid), "session 应绑定该 companion");

    let mut rx = events::subscribe();
    let printer = tokio::spawn(async move {
        let mut acc = String::new();
        eprint!("\n🗣  {name}: ");
        loop {
            match tokio::time::timeout(Duration::from_secs(45), rx.recv()).await {
                Ok(Ok(CollaborationEvent::Token { delta, .. })) => {
                    eprint!("{delta}");
                    acc.push_str(&delta);
                }
                Ok(Ok(CollaborationEvent::Audit { event }))
                    if matches!(
                        event.kind,
                        AuditKind::CollaborationCompleted | AuditKind::Aborted | AuditKind::Failed
                    ) =>
                {
                    eprintln!("\n-- 终态: {:?} --", event.kind);
                    break;
                }
                Ok(Ok(_)) => {}
                _ => break,
            }
        }
        acc
    });

    let msg = "你好,简单介绍下你自己,顺便说说你最擅长帮我做什么?";
    eprintln!("👤 我: {msg}");
    let collab_id = dispatch_to_companion(db.clone(), cfg, &sid, msg, cid)
        .await
        .expect("私聊派遣");
    eprintln!("✅ 私聊已派遣 collab {collab_id}(单 companion,private scope)");

    let reply = tokio::time::timeout(Duration::from_secs(90), printer)
        .await
        .ok()
        .and_then(|r| r.ok())
        .unwrap_or_default();
    assert!(!reply.trim().is_empty(), "私聊应收到流式回复");
    eprintln!("========== 私聊实测结束 ==========\n");
    let _ = std::fs::remove_dir_all(&tmp);
}

