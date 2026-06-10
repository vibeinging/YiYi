//! work/launcher(缝 4 归位):work 启动决策 + 牵头者选取 + intake 入口。
//!
//! 从 `commands/agent/group_dispatch.rs` **复制**(S4:复制不删,原件 work 分支 S6 删)的
//! work 启动三件套:`find_project_lead` / `pick_project_lead_idx` / `dispatch_project_intake`
//! (改名 `launch_intake`)。**新增** `should_launch_work` —— 把"是否 launch work job"的决策
//! 从 chat 路由(`try_group_dispatch` 里的 `is_project_group`)上移成显式判据,**恢复 WIP 删掉
//! 的 build-intent 语义**(缝 4 / §7 收口)。
//!
//! S4:整模块未接线(S6 在 `chat.rs` 调 `should_launch_work` 分流 → `launch_intake`),



use std::sync::Arc;

use crate::engine::agents::MemoryScope;
use crate::engine::collaboration::executor::ConcreteExecutor;
use crate::engine::collaboration::orchestrator::SqliteOrchestrator;
use crate::engine::collaboration::{
    CollaborationMode, CollaborationOrchestrator, CollaborationPlan, CompanionProfile, Participant,
    Step, StepInput, StepKind, StepStatus,
};
use crate::engine::db::Database;
use crate::engine::llm_client::LLMConfig;

// 退役说明:原 `should_launch_work` + `is_project_build_intent`(硬编码建造措辞词表)已删。
// chat×work 2×2 双入口落地后,**不再在 chat 里猜"这条是不是工作"** —— work 一律从「工作」
// 入口显式发起(commands::work::launch_work_job → 下面的 launch_intake),群聊永远放养。
// 措辞检测脆(换个说法就漏)、且与"显式 launch"的决策 X 相悖,故整套退役。

/// work job 的 intake 入口(缝 4 归位,从 `dispatch_project_intake` 复制改名)。
///
/// 工作群的建造任务由牵头者/接口人接手 —— 单牵头者的协作(group 记忆 scope,共享团队
/// 上下文 + 项目工作区),绕开放养循环。牵头者据其 persona 用 ask_user 澄清需求、给方案;
/// 真正派工给各角色由 `propose_work_plan` → `commit_work_plan` 闭环。participant 用 Group
/// scope、step mode 标 `intake`(worker 据此给主导推进指令 + roster)。
///
/// **§7-P0-2 注**:intake 锚点的 `upsert_collaboration_message` 与 `kind=work_dispatch` 标记
/// 由 S6 接线时收口(标 `context_type=work_job` + `set_collaboration_kind`);S4 先原样复制
/// 结构,不接线、不改库标记。
pub async fn launch_intake(
    db: Arc<Database>,
    cfg: LLMConfig,
    session_id: &str,
    gid: i64,
    pm: &CompanionProfile,
    members: &[CompanionProfile],
    user_message: &str,
) -> Result<i64, String> {
    let participant = Participant {
        companion_id: pm.id,
        name: pm.name.clone(),
        avatar_emoji: pm.avatar_emoji.clone(),
        color_hex: pm.color_hex.clone(),
        memory_scope: MemoryScope::Group(gid),
    };

    // 队友名单:接口人用 propose_work_plan 派工时,role 字段要填队友的 agent_definition_name。
    // 动态团队的接口人不认识队友 slug,靠这份名单才能写对计划。排除接口人自己。
    let roster = members
        .iter()
        .filter(|m| m.id != pm.id)
        .map(|m| format!("- {}(派工 role=`{}`):{}", m.name, m.agent_definition_name, m.description))
        .collect::<Vec<_>>()
        .join("\n");

    let plan = CollaborationPlan {
        steps: vec![Step {
            id: 1,
            kind: StepKind::ParallelAgents, // 1 人也走 ParallelAgents(流式气泡渲染)
            participants: vec![participant.clone()],
            depends_on: vec![],
            input: StepInput {
                prompt: user_message.to_string(),
                // mode=intake:牵头者接手步,worker 给宽裕总超时(ask_user 阻塞等答);
                // roster=队友名单,worker 注入接口人 prompt,让它知道派工时 role 填谁。
                metadata: serde_json::json!({ "mode": "intake", "roster": roster }),
            },
            output: None,
            status: StepStatus::Pending,
            started_at: None,
            finished_at: None,
        }],
    };
    let executor = Arc::new(ConcreteExecutor::new(cfg));
    let orch = SqliteOrchestrator::new(db.clone(), executor);
    let parent_id = orch
        .list_recent_by_session(session_id, 1)
        .ok()
        .and_then(|v| v.into_iter().next())
        .map(|c| c.id);
    let collab_id = orch
        .submit(
            session_id.to_string(),
            user_message.to_string(),
            plan,
            CollaborationMode::Dispatched(pm.id),
            parent_id,
        )
        .await?;
    // S6 / §7-P0-2:这条协作是 work job → 标 kind=work_dispatch(让 finalize 走 work 结论分叉);
    // intake 锚点消息标 context_type=work_job(让前端按 work 分流渲染,而非群聊气泡)。
    let _ = db.set_collaboration_kind(collab_id, "work_dispatch");
    let placeholder = format!("@{} {}", participant.name, user_message);
    let _ = db.upsert_collaboration_message_ctx(session_id, collab_id, &placeholder, "work_job");
    Ok(collab_id)
}

/// 在成员的 `(slug, is_coordinator)` 中选项目牵头者下标:**PM slug 优先**(软件公司),
/// 否则**首个 coordinator 档位成员**(自定义团队)。都没有 → None。纯函数,可测。
fn pick_project_lead_idx(members: &[(&str, bool)]) -> Option<usize> {
    if let Some(i) = members.iter().position(|(slug, _)| *slug == "pm") {
        return Some(i);
    }
    members.iter().position(|(_, is_coord)| *is_coord)
}

/// 找项目接管的牵头成员:软件公司 PM,或自定义团队里 coordinator 档位的协调者。
/// coordinator 判定读 registry 里该角色定义的 `permission_profile`(G1/G2 动态角色有此元数据)。
/// app handle / registry 不可达(headless)→ 退化为只认 "pm" slug。
pub(crate) async fn find_project_lead(members: &[CompanionProfile]) -> Option<&CompanionProfile> {
    let coord_flags: Vec<bool> = match crate::engine::tools::get_app_handle() {
        Some(handle) => {
            use tauri::Manager;
            let state = handle.state::<crate::state::AppState>();
            let registry = state.agent_registry.read().await;
            members
                .iter()
                .map(|m| {
                    registry.get(&m.agent_definition_name).and_then(|d| d.permission_profile())
                        == Some("coordinator")
                })
                .collect()
        }
        None => vec![false; members.len()],
    };
    let pairs: Vec<(&str, bool)> = members
        .iter()
        .zip(coord_flags.iter())
        .map(|(m, &c)| (m.agent_definition_name.as_str(), c))
        .collect();
    pick_project_lead_idx(&pairs).map(|i| &members[i])
}

#[cfg(test)]
mod tests {
    use super::pick_project_lead_idx;

    #[test]
    fn pick_lead_prefers_pm_then_first_coordinator() {
        // 软件公司:有 pm slug → 选 pm(即便前面有 coordinator 档位成员)。
        assert_eq!(
            pick_project_lead_idx(&[("designer", false), ("pm", false), ("coord", true)]),
            Some(1),
        );
        // 自定义团队:无 pm → 选首个 coordinator 档位成员。
        assert_eq!(
            pick_project_lead_idx(&[("builder_x", false), ("lead_y", true), ("qa_z", false)]),
            Some(1),
        );
        // 纯执行团队(无 pm、无 coordinator)→ None,落回放养(没人拆解/澄清)。
        assert_eq!(pick_project_lead_idx(&[("builder_x", false), ("qa_z", false)]), None);
    }

}
