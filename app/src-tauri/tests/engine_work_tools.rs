//! `propose_work_plan` 工具的**直接派工**契约测试(2026-06-11 用户决策:开工确认
//! 环节多余,调用即派发)。
//!
//! 验:① 成功路径 —— PM 调工具即派工:work_dispatch 协作建出、job 状态机直入
//! running(跳过 pending_commit)、方案落库为 committed 记录卡(前端渲染 ✅ 已开工,
//! 纯透明展示);② 失败路径 —— role 不在群 → 返回引导错误,不留假记录卡、job 不动;
//! ③ `mark_work_plans_committed` 的 json_set 不破坏 plan 载荷。
//!
//! 注意:`engine::tools` 的 DATABASE / PROVIDERS 是进程级 OnceLock —— 本文件靠
//! "集成测试 = 独立二进制/进程"安全地设置全局,且全部用例共用同一 TempDb/Providers
//! (集中在一个测试函数里串联,避免 OnceLock 跨用例污染)。

mod common;

#[allow(unused_imports)]
use common::*;
use serial_test::serial;

use app_lib::engine::db::NewCompanion;
use app_lib::engine::tools::{propose_work_plan_tool, with_work_ctx};
use app_lib::state::providers::{ModelSlotConfig, ProviderSettings, ProvidersState};

fn companion(slug: &str) -> NewCompanion {
    NewCompanion {
        name: format!("{slug}-同学"),
        agent_definition_name: slug.into(),
        avatar_emoji: "🤖".into(),
        color_hex: "#10B981".into(),
        persona_md_path: None,
        memory_user_id: format!("c_{slug}"),
        metadata_json: None,
        role_label: None,
    }
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn propose_work_plan_dispatches_immediately_without_user_confirm() {
    let t = TempDb::new();
    let db = t.db();
    app_lib::engine::tools::set_database(db.clone());

    // 全局 providers(propose 内 resolve_llm_config_from_globals 读)指向 mock LLM,
    // 让派工后的 detached 执行体有地方请求。
    let mock = MockLlmServer::start().await;
    mock.mock_chat_completion_response("收到任务,这就做。").await;
    let providers = std::sync::Arc::new(tokio::sync::RwLock::new(ProvidersState::load(db.clone())));
    {
        let mut p = providers.write().await;
        p.providers.insert(
            "deepseek".into(),
            ProviderSettings {
                base_url: Some(mock.uri()),
                api_key: Some("test-fake-key".into()),
                extra_models: vec![],
            },
        );
        p.active_llm = Some(ModelSlotConfig { provider_id: "deepseek".into(), model: "mock-model".into() });
    }
    app_lib::engine::tools::set_providers(providers);

    // 团队:frontend_dev 入群;work 会话绑群;job 初始 clarifying。
    let fe = db.adopt_companion(&companion("frontend_dev")).unwrap();
    let gid = db.create_companion_group("软件公司", None, None).unwrap();
    db.add_group_member(gid, fe).unwrap();
    let sid = "work-direct-dispatch";
    db.ensure_session(sid, "做个 app", "work", None).unwrap();
    db.set_session_group(sid, Some(gid)).unwrap();
    db.create_work_job(sid, "做个 app", Some(fe)).unwrap();

    // ── 失败路径:role 不在群 → 引导错误,不落假记录卡、job 不动 ──
    let bad = serde_json::json!({ "tasks": [{ "role": "backend_dev", "objective": "写 API" }] });
    let reply = with_work_ctx(sid.to_string(), 42, propose_work_plan_tool(&bad)).await;
    assert!(reply.contains("派工失败"), "role 不在群应报派工失败,got: {reply}");
    assert_eq!(
        db.get_work_job_status(sid).as_deref(),
        Some("clarifying"),
        "派工失败 job 不该动",
    );
    assert!(
        db.get_messages(sid, None)
            .unwrap()
            .iter()
            .all(|m| m.context_type.as_deref() != Some("work_plan")),
        "派工失败不该留方案记录卡",
    );

    // ── 成功路径:调用即派工,不等用户确认 ──
    let args = serde_json::json!({
        "summary": "单条前端任务",
        "tasks": [{ "role": "frontend_dev", "objective": "写界面" }]
    });
    let reply = with_work_ctx(sid.to_string(), 42, propose_work_plan_tool(&args)).await;
    assert!(reply.contains("已按方案直接派工"), "应直接派工,got: {reply}");

    // job 状态机直入 running(跳过 pending_commit —— 不再有人工确认态)。
    assert_eq!(db.get_work_job_status(sid).as_deref(), Some("running"));

    // 派工协作建出且 kind=work_dispatch(finalize 据此走 work 分支)。
    assert!(
        !db.list_collaborations_by_kind("work_dispatch").is_empty(),
        "应建出 work_dispatch 派工协作",
    );

    // 方案落库为 committed **记录卡**(前端渲染 ✅ 已开工,无按钮)。
    let msgs = db.get_messages(sid, None).unwrap();
    let plan_msg = msgs
        .iter()
        .find(|m| m.context_type.as_deref() == Some("work_plan"))
        .expect("方案记录卡应已落库");
    let meta: serde_json::Value =
        serde_json::from_str(plan_msg.metadata.as_deref().unwrap()).unwrap();
    assert_eq!(meta["committed"], true, "记录卡应生而 committed");
    assert_eq!(meta["plan"]["tasks"].as_array().unwrap().len(), 1);

    // 派工锚点消息在(前端 CollaborationMessageCard 的挂载点)。
    assert!(
        msgs.iter().any(|m| m.content.contains("🛠️ 开工")),
        "应有派工锚点消息",
    );
}

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn mark_work_plans_committed_preserves_plan_payload() {
    let t = TempDb::new();
    let db = t.db();
    let sid = "work-mark-committed";
    db.ensure_session(sid, "x", "work", None).unwrap();
    let meta = serde_json::json!({
        "type": "work_plan",
        "request_id": "r1",
        "summary": "s",
        "plan": { "tasks": [{ "role": "frontend_dev", "objective": "写界面", "depends_on": [] }] },
    });
    db.push_message_with_context(sid, "assistant", "📋 开工方案", Some(&meta.to_string()), "work_plan")
        .unwrap();

    db.mark_work_plans_committed(sid).unwrap();
    let msgs = db.get_messages(sid, None).unwrap();
    let m: serde_json::Value =
        serde_json::from_str(msgs[0].metadata.as_deref().unwrap()).unwrap();
    assert_eq!(m["committed"], true);
    assert_eq!(m["plan"]["tasks"][0]["role"], "frontend_dev", "json_set 不应破坏 plan 载荷");
}
