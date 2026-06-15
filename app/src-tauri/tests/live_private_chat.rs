//! 真实集成测试 —— 用真实 db 配置 + 真实 DeepSeek API 跑一次**好友私聊**(1:1),
//! 实时打印流式发言。**不 mock**,验证:
//!   - 绑定单个 companion 的会话,dispatch_to_companion 让它 1:1 流式回答
//!   - 真·流式:逐字 emit Token 事件
//!
//! 2026-06-15:chat 多分身群聊已退役,本文件只保留 1:1 私聊 live 实测。
//!
//! 默认跳过(避免 CI 真实计费)。运行:
//!   YIYI_LIVE_PRIVATE=1 cargo test --features test-support --test live_private_chat -- --nocapture
//!
//! 做法:把真实 ~/.yiyi/yiyi.db copy 到临时目录再开,避免和正在运行的 app 抢 WAL。

use std::sync::Arc;
use std::time::Duration;

use app_lib::commands::agent::group_dispatch::dispatch_to_companion;
use app_lib::engine::collaboration::{events, AuditKind, CollaborationEvent};
use app_lib::engine::db::Database;
use app_lib::engine::llm_client::resolve_config_from_providers;
use app_lib::state::providers::ProvidersState;

/// 真实测试好友私聊:绑定单个 companion 的会话,dispatch_to_companion 让它 1:1 流式回答。
/// 运行:YIYI_LIVE_PRIVATE=1 cargo test --features test-support --test live_private_chat live_private_chat -- --nocapture
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
