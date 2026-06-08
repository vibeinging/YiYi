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

#![allow(dead_code)]

use tauri::Emitter;

use crate::engine::work::plan::{ProjectPlan, ProjectTask};

/// 发给前端的 `work://plan_proposed` 卡片载荷。
#[derive(Clone, serde::Serialize)]
struct WorkPlanCard {
    request_id: String,
    /// 一句话方案概述。
    summary: String,
    /// 任务清单(角色 / 目标 / 依赖)。
    plan: ProjectPlan,
}

pub fn definitions() -> Vec<super::types::ToolDefinition> {
    vec![super::types::tool_def(
        "propose_work_plan",
        "把项目拆成一份开工方案发给用户审阅 —— 列出每个角色要做的任务和依赖顺序。\
         需求澄清清楚后再调它(牵头者/接口人专用)。**用户点「开工」后团队才会真正开干**,在此之前别催、别自己硬扛。\
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

    let handle = match super::APP_HANDLE.get() {
        Some(h) => h,
        None => return "(当前是无界面环境,无法发开工方案。)".to_string(),
    };
    let card = WorkPlanCard {
        request_id: uuid::Uuid::new_v4().to_string(),
        summary,
        plan,
    };
    if handle.emit("work://plan_proposed", &card).is_err() {
        return "(发开工方案失败:事件发送出错。)".to_string();
    }
    format!("开工方案已发给用户审阅(共 {task_count} 个任务),等 ta 点「开工」后团队再开干。")
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
