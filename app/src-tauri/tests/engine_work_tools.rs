//! `propose_work_plan` 工具的持久化契约测试。
//!
//! 回归保护:方案落库(work_plan 消息 + job 状态机推进 pending_commit)必须发生在
//! APP_HANDLE 检查**之前** —— headless(无界面)环境下方案不能丢。曾经的顺序缺陷:
//! early return 在落库前,导致集成测试/跑批里 PM 调了 propose_work_plan 但方案蒸发、
//! job 永远卡在 clarifying。
//!
//! 注意:`engine::tools::DATABASE` 是进程级 OnceLock —— 本文件靠"集成测试 = 独立
//! 二进制/进程"来安全地 set_database,且只设一次(全部测试共用同一个 TempDb)。

mod common;

#[allow(unused_imports)]
use common::*;
use serial_test::serial;

use app_lib::engine::tools::{propose_work_plan_tool, with_work_ctx};

#[tokio::test(flavor = "multi_thread")]
#[serial]
async fn propose_work_plan_persists_plan_and_advances_job_without_app_handle() {
    let t = TempDb::new();
    let db = t.db();
    // 本测试二进制内没有 Tauri app → APP_HANDLE 必然未设,正好复现 headless 场景。
    app_lib::engine::tools::set_database(db.clone());

    let sid = "work-propose-headless";
    db.ensure_session(sid, "做个 app", "work", None).unwrap();
    db.create_work_job(sid, "做个 app", Some(1)).unwrap();

    let args = serde_json::json!({
        "summary": "拆成前后端两条任务",
        "tasks": [
            { "role": "backend_dev", "objective": "写 API" },
            { "role": "frontend_dev", "objective": "写界面", "depends_on": [0] }
        ]
    });
    let reply = with_work_ctx(sid.to_string(), 42, propose_work_plan_tool(&args)).await;

    // headless 降级:方案已记录(而非旧的「无法发开工方案」整体丢弃)。
    assert!(
        reply.contains("已记录"),
        "headless 下应落库并降级提示,got: {reply}"
    );

    // 方案消息落库:context_type=work_plan + metadata 含完整 plan(前端重渲染的依据)。
    let msgs = db.get_messages(sid, None).unwrap();
    let plan_msg = msgs
        .iter()
        .find(|m| m.context_type.as_deref() == Some("work_plan"))
        .expect("work_plan 消息应已落库");
    let meta: serde_json::Value =
        serde_json::from_str(plan_msg.metadata.as_deref().unwrap()).unwrap();
    assert_eq!(meta["type"], "work_plan");
    assert_eq!(meta["plan"]["tasks"].as_array().unwrap().len(), 2);
    assert_eq!(meta["plan"]["tasks"][1]["depends_on"][0], 0);

    // job 状态机推进:clarifying → pending_commit(用户可点「开工」)。
    assert_eq!(
        db.get_work_job_status(sid).as_deref(),
        Some("pending_commit"),
        "方案发出后 job 应进入待开工态",
    );
}
