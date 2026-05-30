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

use app_lib::commands::agent::family_dispatch::{
    dispatch_group_discussion, dispatch_to_companion, try_family_dispatch, FamilyDispatchOutcome,
};
use app_lib::engine::collaboration::executor::ConcreteExecutor;
use app_lib::engine::collaboration::orchestrator::SqliteOrchestrator;
use app_lib::engine::collaboration::{events, AuditKind, CollaborationEvent, CollaborationOrchestrator};
use app_lib::engine::db::Database;
use app_lib::engine::llm_client::resolve_config_from_providers;
use app_lib::state::providers::ProvidersState;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn live_group_chat_decentralized() {
    if std::env::var("YIYI_LIVE_GROUP").is_err() {
        eprintln!("SKIP live_group_chat:设 YIYI_LIVE_GROUP=1 才跑(会真实调用 DeepSeek API)");
        return;
    }

    // 1. copy 真实 db(含 WAL/SHM)到临时 working_dir,不碰运行中的 app。
    let home = std::env::var("HOME").unwrap();
    let real_db = format!("{home}/.yiyi/yiyi.db");
    let tmp = std::env::temp_dir().join(format!("yiyi_live_{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    std::fs::copy(&real_db, tmp.join("yiyi.db")).expect("copy yiyi.db");
    for ext in ["-wal", "-shm"] {
        let src = format!("{real_db}{ext}");
        if std::path::Path::new(&src).exists() {
            let _ = std::fs::copy(&src, tmp.join(format!("yiyi.db{ext}")));
        }
    }

    // 2. 开 db + 真实 provider 配置。
    let db = Arc::new(Database::open(&tmp).expect("open db"));
    let providers = ProvidersState::load(db.clone());
    let cfg = resolve_config_from_providers(&providers).expect("有 active provider");
    eprintln!("\n========== LIVE 群聊去中心化实测 ==========");
    eprintln!("model = {}  base = {}", cfg.model, cfg.base_url);

    // 3. 找一个有 ≥2 成员的群(优先 id=3 聊天群)。
    let gid = [3i64, 2, 1]
        .into_iter()
        .find(|g| db.list_group_members(*g).len() >= 2)
        .expect("需要一个有 ≥2 成员的群");
    let members = db.list_group_members(gid);
    eprintln!(
        "群 {gid} 成员: {}",
        members.iter().map(|m| format!("{}({})", m.name, m.id)).collect::<Vec<_>>().join(", ")
    );

    // 4. 新建一个绑该群的临时 session(不污染真实会话历史)。
    let sid = format!("live-test-{}", std::process::id());
    db.ensure_session(&sid, "实测群聊", "chat", None).ok();
    db.set_session_group(&sid, Some(gid)).expect("bind group");

    // 5. **先订阅**(进程级全局事件总线)再派遣,实时收 Token 流。
    let mut rx = events::subscribe();
    let id_to_name: HashMap<i64, String> =
        members.iter().map(|m| (m.id, m.name.clone())).collect();
    let id_map_for_printer = id_to_name.clone();
    let printer = tokio::spawn(async move {
        let id_to_name = id_map_for_printer;
        let mut acc: HashMap<i64, String> = HashMap::new();
        let mut last_speaker: i64 = -999;
        loop {
            match tokio::time::timeout(Duration::from_secs(45), rx.recv()).await {
                Ok(Ok(CollaborationEvent::Token { companion_id, delta, .. })) => {
                    if companion_id != last_speaker {
                        let who = id_to_name.get(&companion_id).cloned().unwrap_or_else(|| format!("#{companion_id}"));
                        eprint!("\n🗣  {who}: ");
                        last_speaker = companion_id;
                    }
                    eprint!("{delta}");
                    acc.entry(companion_id).or_default().push_str(&delta);
                }
                Ok(Ok(CollaborationEvent::Audit { event })) => {
                    if matches!(
                        event.kind,
                        AuditKind::CollaborationCompleted | AuditKind::Aborted | AuditKind::Failed
                    ) {
                        eprintln!("\n-- 协作终态: {:?} --", event.kind);
                        break;
                    }
                }
                Ok(Ok(_)) => {}
                _ => {
                    eprintln!("\n-- 事件流超时/结束 --");
                    break;
                }
            }
        }
        acc
    });

    // 6. 派遣(真实 LLM:全员并发各自 claim → 接的并发流式回复)。
    let msg = std::env::var("YIYI_LIVE_MSG")
        .unwrap_or_else(|_| "我想做个桌面 AI 助理,你们觉得核心差异化卖点该往哪打?".to_string());
    eprintln!("\n👤 我: {msg}\n--- 群成员各自判断要不要接 ---");
    let outcome = try_family_dispatch(db.clone(), cfg, &sid, &msg, &[]).await.unwrap();
    match &outcome {
        FamilyDispatchOutcome::Dispatched { members, .. } => {
            eprintln!(
                "✅ 派遣 {} 位(自主认领): {}",
                members.len(),
                members.iter().map(|m| m.name.clone()).collect::<Vec<_>>().join(", ")
            );
        }
        FamilyDispatchOutcome::SelfAnswer { reason } => {
            eprintln!("ℹ️ 全员不接 → YiYi 兜底自答。reason: {reason}");
        }
        FamilyDispatchOutcome::EmptyGroup => eprintln!("⚠️ 空群"),
    }

    // 7. 等流式打印完(成员后台并发执行)。
    let acc = tokio::time::timeout(Duration::from_secs(90), printer)
        .await
        .ok()
        .and_then(|r| r.ok())
        .unwrap_or_default();
    eprintln!("\n========== 各成员最终发言 ==========");
    for (cid, text) in &acc {
        let who = id_to_name.get(cid).cloned().unwrap_or_else(|| format!("#{cid}"));
        eprintln!("【{who}】{}\n", text.trim());
    }
    eprintln!("========== LIVE 实测结束 ==========\n");

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

/// 真实测试群讨论模式:多轮成员发言(后轮看到前轮)+ YiYi 总结结论。
/// 运行:YIYI_LIVE_DISCUSS=1 cargo test --features test-support --test live_group_chat live_group_discussion -- --nocapture
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn live_group_discussion() {
    if std::env::var("YIYI_LIVE_DISCUSS").is_err() {
        eprintln!("SKIP live_group_discussion:设 YIYI_LIVE_DISCUSS=1 才跑(真实调用 DeepSeek)");
        return;
    }
    let home = std::env::var("HOME").unwrap();
    let real_db = format!("{home}/.yiyi/yiyi.db");
    let tmp = std::env::temp_dir().join(format!("yiyi_disc_{}", std::process::id()));
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

    let gid = [3i64, 2, 1]
        .into_iter()
        .find(|g| db.list_group_members(*g).len() >= 2)
        .expect("需要 ≥2 成员的群");
    let members = db.list_group_members(gid);
    let id_to_name: HashMap<i64, String> = members.iter().map(|m| (m.id, m.name.clone())).collect();
    eprintln!("\n========== LIVE 群讨论实测 ==========");
    eprintln!("model = {}  群 {gid} 成员: {}", cfg.model,
        members.iter().map(|m| m.name.clone()).collect::<Vec<_>>().join(", "));

    let sid = format!("live-disc-{}", std::process::id());
    db.ensure_session(&sid, "讨论测试", "chat", None).ok();
    db.set_session_group(&sid, Some(gid)).expect("bind group");

    let mut rx = events::subscribe();
    let printer = tokio::spawn(async move {
        let mut last: i64 = -999;
        loop {
            match tokio::time::timeout(Duration::from_secs(60), rx.recv()).await {
                Ok(Ok(CollaborationEvent::Token { companion_id, delta, .. })) => {
                    if companion_id != last {
                        let who = if companion_id == 0 {
                            "YiYi(结论)".to_string()
                        } else {
                            id_to_name.get(&companion_id).cloned().unwrap_or_else(|| format!("#{companion_id}"))
                        };
                        eprint!("\n🗣  {who}: ");
                        last = companion_id;
                    }
                    eprint!("{delta}");
                }
                Ok(Ok(CollaborationEvent::Audit { event }))
                    if matches!(event.kind, AuditKind::StepCompleted) =>
                {
                    eprint!("  [step {} 完成]", event.payload.get("step_id").and_then(|v| v.as_i64()).unwrap_or(-1));
                }
                Ok(Ok(CollaborationEvent::Audit { event }))
                    if matches!(event.kind, AuditKind::CollaborationCompleted | AuditKind::Aborted | AuditKind::Failed) =>
                {
                    eprintln!("\n-- 终态: {:?} --", event.kind);
                    break;
                }
                Ok(Ok(_)) => {}
                _ => break,
            }
        }
    });

    let topic = "讨论一下:为什么 AI 能促进生产力?多聊几轮,最后给我一个结论。";
    eprintln!("👤 我: {topic}");
    let collab_id = dispatch_group_discussion(db.clone(), cfg, &sid, topic).await.expect("发起讨论");
    eprintln!("✅ 群讨论已发起 collab {collab_id}(2 轮成员发言 + YiYi 总结)\n");

    let _ = tokio::time::timeout(Duration::from_secs(180), printer).await;

    // 校验:协作终态 Done,且最后一步(host_summarize)有非空结论。
    let orch = SqliteOrchestrator::new(db.clone(), Arc::new(ConcreteExecutor::new(
        resolve_config_from_providers(&ProvidersState::load(db.clone())).unwrap(),
    )));
    if let Ok(Some(c)) = orch.get(collab_id).await {
        eprintln!("\n\n========== 完整对话回放 ==========");
        eprintln!("协作 {} 步,终态 {:?}\n", c.plan.steps.len(), c.status);
        let total = c.plan.steps.len();
        for (i, step) in c.plan.steps.iter().enumerate() {
            let label = if i + 1 == total { "【YiYi 结论】".to_string() } else { format!("【第 {} 轮】", i + 1) };
            let text = step.output.as_ref().map(|o| o.full_output.clone()).unwrap_or_default();
            eprintln!("{label}\n{}\n", text.trim());
        }
        let concl = c.plan.steps.last().and_then(|s| s.output.as_ref()).map(|o| o.full_output.clone()).unwrap_or_default();
        assert!(!concl.trim().is_empty(), "YiYi 应给出非空结论");
    }
    eprintln!("========== 群讨论实测结束 ==========\n");
    let _ = std::fs::remove_dir_all(&tmp);
}
