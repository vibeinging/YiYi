//! `propose_work_plan` 工具(缝 8 归位):牵头者把拆好的开工方案发给用户审阅。
//!
//! 从 `engine/tools/project_tools.rs` **复制**(S4/S5:复制不删,原件 S8 删):
//!   - 工具名 `propose_project_plan` → `propose_work_plan`;
//!   - 事件名 `chat://project_plan` → `work://plan_proposed`(work 表面独立事件,前端
//!     `useProjectPlanBridge` S7 改监听它);
//!   - 计划类型改读 `engine/work/plan`(work 表面的归位)。
//!
//! 工具只负责"产出结构化计划 + 发卡 + 返回让牵头者等";用户点「开工」后由前端调
//! `commit_work_plan` 命令真正派工(白盒:用户既定决策 —— 开工需拍板一次)。
//!
//! **S5 现状**:本工具**未注册进现有工具表 / 未改 dynamic.rs 档位**(S6 接线时注册到
//! Coordinator 档 + dispatch 路由)。`#[allow(dead_code)]` 压住未接线告警。

use tauri::Emitter;

use crate::engine::work::plan::{ProjectPlan, ProjectTask};

tokio::task_local! {
    /// 当前 work 步的 (session_id, collab_id) —— worker 执行 intake 时包一层,
    /// 让 propose_work_plan 知道方案属于哪个工作会话(载荷带 session_id 防跨会话错派、
    /// 方案锚点落对会话、job 状态机推进到 pending_commit)。
    static WORK_CTX: (String, i64);
}

/// 在 fut 期间绑定当前 work 步的会话上下文(worker::run_work_step 包)。
pub async fn with_work_ctx<F, R>(session_id: String, collab_id: i64, fut: F) -> R
where
    F: std::future::Future<Output = R>,
{
    WORK_CTX.scope((session_id, collab_id), fut).await
}

fn current_work_ctx() -> Option<(String, i64)> {
    WORK_CTX.try_with(|c| c.clone()).ok()
}

/// 发给前端的 `work://plan_proposed` 卡片载荷。
#[derive(Clone, serde::Serialize)]
struct WorkPlanCard {
    request_id: String,
    /// 方案所属的 work 会话(R3:防全局单槽跨会话错派;空串 = 旧版无上下文)。
    session_id: String,
    /// 一句话方案概述。
    summary: String,
    /// 任务清单(角色 / 目标 / 依赖)。
    plan: ProjectPlan,
}

pub fn definitions() -> Vec<super::types::ToolDefinition> {
    vec![super::types::tool_def(
        "propose_work_plan",
        "把项目拆成任务并**立即派工给队友开干**(调用即派发,不需要用户确认;方案会作为\
         记录卡展示给用户)。需求澄清清楚后再调它(牵头者/接口人专用)。\
         tasks 每条:role(**填队友的标识** —— 见系统提示里给你的「队友名单」,如 frontend_dev / \
         creative_director 等,必须和名单里的 role 完全一致才派得动)、objective(这条要做什么)、\
         depends_on(依赖哪些任务的下标,0-based,无依赖留空 —— 比如前端依赖后端接口,就把后端那条的下标填进来)。",
        serde_json::json!({
            "type": "object",
            "properties": {
                "summary": { "type": "string", "description": "一句话概括这个方案要做什么" },
                "tasks": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "role": { "type": "string", "description": "执行角色 = 队友的标识(见系统提示「队友名单」里的 role,必须完全一致)" },
                            "objective": { "type": "string", "description": "这个角色这条任务要做什么" },
                            "depends_on": { "type": "array", "items": { "type": "integer" }, "description": "依赖的上游任务下标(0-based),无则留空" }
                        },
                        "required": ["role", "objective"]
                    }
                }
            },
            "required": ["tasks"]
        }),
    )]
}

/// 工具入口:`propose_work_plan(summary?, tasks)`。
pub async fn propose_work_plan_tool(args: &serde_json::Value) -> String {
    let tasks_val = match args.get("tasks").and_then(|v| v.as_array()) {
        Some(a) if !a.is_empty() => a,
        _ => return "propose_work_plan 需要一个非空的 tasks 数组".to_string(),
    };

    let mut tasks = Vec::with_capacity(tasks_val.len());
    for t in tasks_val {
        let role = t.get("role").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        let objective = t
            .get("objective")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if role.is_empty() || objective.is_empty() {
            return "每条任务都要有 role 和 objective".to_string();
        }
        let depends_on = t
            .get("depends_on")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_u64().map(|n| n as usize)).collect())
            .unwrap_or_default();
        tasks.push(ProjectTask { role, objective, depends_on });
    }

    let summary = args
        .get("summary")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let plan = ProjectPlan { tasks };
    let task_count = plan.tasks.len();

    let ctx = current_work_ctx();
    let Some((sid, _collab)) = ctx else {
        return "(没有工作上下文,无法派工 —— propose_work_plan 只在 work 任务里可用。)".into();
    };
    let Some(db) = super::get_database() else {
        return "(数据库不可用,无法派工。)".into();
    };
    let Some(cfg) = super::resolve_llm_config_from_globals().await else {
        return "(没有可用的模型配置,无法派工。)".into();
    };

    // 2026-06-11 用户决策:开工确认环节多余 —— **调用即直接派工**,队友立刻开干。
    // 先派工后落卡:派工失败(role 不在群/会话没绑群)时不留假的「已开工」记录卡。
    if let Err(e) =
        crate::engine::work::launcher::dispatch_work_plan(db.clone(), cfg, &sid, &plan).await
    {
        return format!(
            "派工失败:{e}。检查 tasks 里的 role 是否用了队友名单里的标识,修正后重试。"
        );
    }

    // 方案落库作**记录卡**(committed 态:前端渲染 ✅ 已开工,无按钮,纯透明展示
    // 「活是怎么拆的」)。best-effort:落库失败不影响已派出去的工。
    let card = WorkPlanCard {
        request_id: uuid::Uuid::new_v4().to_string(),
        session_id: sid.clone(),
        summary,
        plan,
    };
    let meta = serde_json::json!({
        "type": "work_plan",
        "request_id": card.request_id,
        "summary": card.summary,
        "plan": card.plan,
        "committed": true,
    });
    let _ = db.push_message_with_context(
        &sid,
        "assistant",
        "📋 开工方案",
        Some(&meta.to_string()),
        "work_plan",
    );

    // 事件触发前端即时重载(方案记录卡 + 派工锚点一起进流);headless 无 handle 跳过。
    if let Some(handle) = super::APP_HANDLE.get() {
        let _ = handle.emit("work://plan_proposed", &card);
    }
    format!(
        "✅ 已按方案直接派工(共 {task_count} 个任务),队友们开干了。\
         不用等用户确认;接下来等队友交付,或继续回应用户的新消息。"
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn parses_tasks_with_optional_deps() {
        let args = serde_json::json!({
            "tasks": [
                { "role": "backend_dev", "objective": "写 API" },
                { "role": "frontend_dev", "objective": "写前端", "depends_on": [0] }
            ]
        });
        let arr = args["tasks"].as_array().unwrap();
        assert_eq!(arr.len(), 2);
        // 第二条带依赖。
        let dep: Vec<usize> = arr[1]["depends_on"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|x| x.as_u64().map(|n| n as usize))
            .collect();
        assert_eq!(dep, vec![0]);
    }
}
