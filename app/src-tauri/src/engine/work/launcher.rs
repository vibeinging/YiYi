//! work/launcher(缝 4 归位):work 启动决策 + 牵头者选取 + intake 入口。
//!
//! 从 `commands/agent/group_dispatch.rs` **复制**(S4:复制不删,原件 work 分支 S6 删)的
//! work 启动三件套:`find_project_lead` / `pick_project_lead_idx` / `dispatch_project_intake`
//! (改名 `launch_intake`)。**新增** `should_launch_work` —— 把"是否 launch work job"的决策
//! 从 chat 路由(`try_group_dispatch` 里的 `is_project_group`)上移成显式判据,**恢复 WIP 删掉
//! 的 build-intent 语义**(缝 4 / §7 收口)。
//!
//! S4:整模块未接线(S6 在 `chat.rs` 调 `should_launch_work` 分流 → `launch_intake`),
//! `#[allow(dead_code)]` 压住未接线告警。

#![allow(dead_code)]

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

/// 是否该为这条群消息 launch 一个 work job(缝 4 / §7 收口)。
///
/// 北极星:work 是从 chat 里**显式发起**的任务,不靠措辞乱猜;但工作群里"开始吧 / 继续"这类
/// 非建造措辞落进放养循环 = N 人七嘴八舌、没人主导 = 卡死(WIP 的倒退)。所以这里用**规则**
/// (不花 token)三道判据全中才启动:
///
///   1. **群是 work 视角** —— 暂仍用 `workspace_path.is_some()`(按蓝图 §3-S4:本轮先沿用,
///      §7-P-low 提示 S6 改读 `collaborations.kind`/群配置、与 S8 删列解耦;S4 不接线,先保最小复制)。
///   2. **含 coordinator / PM 档成员** —— 有人能主导拆解 / 阻塞式澄清(`find_project_lead` 能选出
///      牵头者)。纯执行团队(无协调角色)→ 没人拆解,落回放养更合适。
///   3. **非闲聊(build-intent)** —— **恢复 WIP 删掉的 `is_project_build_intent` gate**:消息是明确的
///      "建造"意图(做个 / 开发 / 实现一个 / build a …)才接手。讨论 / 提问 / 反馈(如"你们觉得这方向
///      对吗?")→ 不触发 PM,照常放养闲聊。判错 = 工作群没法纯闲聊 = WIP 倒退。
///
/// 另:用户 @ 点名了具体成员(`forced_ids` 非空)= 点名必答,绕过 work 启动(走 chat 放养的
/// wave-1 立即回),所以 `forced_ids` 非空直接返回 false。
pub async fn should_launch_work(
    db: &Database,
    gid: i64,
    msg: &str,
    forced_ids: &[i64],
    members: &[CompanionProfile],
) -> bool {
    // @ 点名 → 点名必答,不启动 work(走 chat 放养)。
    if !forced_ids.is_empty() {
        return false;
    }
    // 判据 1:群是 work 视角(本轮先沿用 workspace_path;S6 改读 kind)。
    let is_work_view = db
        .get_companion_group(gid)
        .and_then(|g| g.workspace_path)
        .is_some();
    if !is_work_view {
        return false;
    }
    // 判据 3:非闲聊 / 是建造意图(恢复 build-intent gate)。
    if !is_project_build_intent(msg) {
        return false;
    }
    // 判据 2:有牵头者(coordinator / PM 档)能接手。
    find_project_lead(members).await.is_some()
}

/// 建造意图启发式(缝 4 / §7 收口:恢复 WIP 删掉的 `is_project_build_intent`)。
///
/// 命中"做个 / 开发 / 实现一个 / build a …"等明确建造措辞 → true(该走 PM intake)。
/// 讨论 / 提问 / 反馈 / 太短 → false(走放养闲聊)。判据是**规则启发式**(不花 token),
/// 故意保守:宁可漏判(落回放养,用户可再明确说"做个X")也别误判(把闲聊当建造,PM 强行接手)。
/// 实现参照 git 历史里被 WIP 删掉的同名函数(commit 17ecd67),不改判据。
pub fn is_project_build_intent(msg: &str) -> bool {
    let m = msg.trim();
    // 太短 → 不可能是个明确的建造诉求("嗯""好的"等)。
    if m.chars().count() < 4 {
        return false;
    }
    const BUILD_CUES: &[&str] = &[
        "做个", "做一个", "做一款", "做款", "开发", "搭一个", "搭个", "搭建",
        "实现一个", "写一个", "帮我做", "帮我写", "帮我开发", "做出来",
        "build", "develop", "create a", "make a", "make an", "build a", "build me",
    ];
    let lower = m.to_lowercase();
    BUILD_CUES.iter().any(|cue| lower.contains(&cue.to_lowercase()))
}

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
    let placeholder = format!("@{} {}", participant.name, user_message);
    let _ = db.upsert_collaboration_message(session_id, collab_id, &placeholder);
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
async fn find_project_lead(members: &[CompanionProfile]) -> Option<&CompanionProfile> {
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
    use super::{is_project_build_intent, pick_project_lead_idx};

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

    #[test]
    fn build_intent_recognizes_explicit_tasks() {
        assert!(is_project_build_intent("做个 todo 网页应用"));
        assert!(is_project_build_intent("帮我开发一个记账 app"));
        assert!(is_project_build_intent("实现一个登录页面"));
        assert!(is_project_build_intent("Build a REST API for notes"));
        assert!(is_project_build_intent("Make an onboarding flow"));
    }

    #[test]
    fn build_intent_ignores_chat_and_short_messages() {
        // 讨论 / 提问 / 反馈 → 走放养,不该被 PM 接手。
        assert!(!is_project_build_intent("你们觉得这个方向对吗?"));
        assert!(!is_project_build_intent("这个 bug 怎么修?"));
        assert!(!is_project_build_intent("辛苦了"));
        // 太短 → false。
        assert!(!is_project_build_intent("嗯"));
        assert!(!is_project_build_intent("好的"));
    }
}
