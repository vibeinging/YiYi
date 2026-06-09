//! group_dispatch — 群会话的入口路由。
//!
//! 当一个 session 绑定了群（`db.get_session_group` 返回 Some），把消息交给对话循环
//! 引擎（`conversation_driver`）而不是主精灵自答。所有消息统一走放养异步事件循环
//! （`dispatch_group_loop`）：被 @ 点名的成员 wave-1 立即回（delay=0），其余变速；
//! YiYi 也作为一员入群，冷场自然收口。
//!
//! 本函数刻意**不持有 `AppHandle`**：它只碰 db + LLM，返回一个
//! [`GroupDispatchOutcome`]，由调用方（chat 命令）负责 emit Tauri 事件、决定
//! 是否还要跑主精灵自答。这样核心路由逻辑可在 TempDb + mock LLM 下直接测。

use std::sync::Arc;

use crate::engine::agents::MemoryScope;
use crate::engine::collaboration::conversation_driver;
use crate::engine::collaboration::executor::ConcreteExecutor;
use crate::engine::collaboration::orchestrator::SqliteOrchestrator;
use crate::engine::collaboration::{
    ChatTurnSummary, CollaborationMode, CollaborationOrchestrator, CollaborationPlan,
    CompanionProfile, Participant, Step, StepInput, StepKind, StepStatus,
};
use crate::engine::db::Database;
use crate::engine::llm_client::LLMConfig;

/// 喂给群成员的最近对话轮数。有界,免得群聊久了把 prompt 撑大、破坏缓存。
const DISPATCH_HISTORY_TURNS: usize = 6;

/// 一次群路由的结果。调用方据此决定是否继续跑主精灵自答。
///
/// L1 多成员模型:Dispatched 携带 N 个成员(1+);UI 同框冒出多个气泡(群聊感)。
/// 没有路由卡 —— "谁选的、为什么"沉到 audit / 日志,前台只见成员发言。
#[derive(Debug, Clone)]
pub enum GroupDispatchOutcome {
    /// 主精灵自答 —— 没人入选 / judge 兜底。`reason` 仅用于日志和 audit。
    SelfAnswer { reason: String },
    /// 群已绑定但 0 成员 —— 不能无声让主精灵冒充群成员回答(信任级 bug)。
    /// 调用方应给用户一条可见提示,引导去管理面板拉人。
    EmptyGroup,
    /// 已派遣给 N 位群成员(1 或多个),对应 ParallelAgents 协作正在后台并发执行。
    Dispatched {
        collaboration_id: i64,
        /// 入选成员快照,顺序与 plan 中 participants 一致。
        members: Vec<DispatchedMember>,
    },
}

/// 派遣成员的轻量快照 —— 给上层日志 / 后续可能的事件回播用。
#[derive(Debug, Clone)]
pub struct DispatchedMember {
    pub companion_id: i64,
    pub name: String,
    pub avatar_emoji: String,
    pub color_hex: String,
}

/// 在群模式下尝试把 `user_message` 路由给某位成员。
///
/// `cfg` 同时用于路由判断（judge）与被选成员的执行（ConcreteExecutor）。Phase A
/// 复用 session 的 LLM 配置；未来可让 judge 走更便宜的小模型（Open Question 3）。
/// `forced_ids`:用户在群里 @ 点名的成员 id。非空 = **点名必答**,跳过 L1 粗筛 +
/// L2 认领的智能路由,强制这些成员(取与群成员的交集)上场。空 = 走智能路由。
pub async fn try_group_dispatch(
    db: Arc<Database>,
    cfg: LLMConfig,
    session_id: &str,
    user_message: &str,
    forced_ids: &[i64],
) -> Result<GroupDispatchOutcome, String> {
    // 1. session 必须绑定具名 group(IM 心智:group = 群聊窗口,1:1)。
    //    未绑 → 直接当单聊,回退主精灵自答。caller 应已用 group_id 判断,
    //    这里再守一遍。
    let Some(gid) = db.get_session_group(session_id) else {
        return Ok(GroupDispatchOutcome::SelfAnswer {
            reason: "session 未绑群,单聊主精灵".into(),
        });
    };
    let companions = db.list_group_members(gid);
    // 空群:群存在但没成员。**不能**无声回落主精灵自答(用户在"群里"发言却被
    // 一个不在成员列表的 YiYi 冒充回答 = 信任级 bug)。返回 EmptyGroup,由
    // chat.rs 给一条可见系统提示。见 P0-2 修复 / 陪审团报告。
    if companions.is_empty() {
        return Ok(GroupDispatchOutcome::EmptyGroup);
    }
    let group_scope = crate::engine::agents::MemoryScope::Group(gid);
    let members: Vec<CompanionProfile> = companions
        .into_iter()
        .map(|c| CompanionProfile {
            id: c.id,
            name: c.name,
            avatar_emoji: c.avatar_emoji,
            color_hex: c.color_hex,
            // 一行角色描述：优先用户设的 role_label，缺省回落到 agent 定义名。
            description: c.role_label.unwrap_or_else(|| c.agent_definition_name.clone()),
            agent_definition_name: c.agent_definition_name,
            last_used_at: c.last_used_at,
        })
        .collect();

    // 近 N 轮对话 —— 喂给成员看上下文(发言要看历史,否则指代消解塌方)。
    let chat_history: Vec<ChatTurnSummary> = db
        .get_recent_messages(session_id, DISPATCH_HISTORY_TURNS)
        .unwrap_or_default()
        .into_iter()
        .map(|m| ChatTurnSummary {
            role: m.role,
            text: m.content,
            timestamp: m.timestamp,
        })
        .collect();

    // chat×work 2×2:**群聊(chat 入口)永远放养** —— 不在这里猜"这条是不是工作"。
    // 两个入口已把 chat/work 分开:work 从「工作」入口显式发起(`launch_work_job` →
    // work::launcher::launch_intake),所以这里**不再做任何 work 检测**(原 should_launch_work /
    // is_project_build_intent 硬编码词表已退役)。不论"做个X"还是"你们觉得呢",在群里都只是聊天。

    // 放养事件循环 —— @ 与非 @ 统一进 v2:被 @ 的成员 wave-1 立即回(delay=0)、其余变速 5–30 秒,
    // YiYi 也作为一员入群,冷场自然收口。旧的单轮 / 讨论同步模型已退役删除。
    let (collab_id, participants) = conversation_driver::dispatch_group_loop(
        db.clone(), cfg, session_id, user_message, &members, &chat_history, group_scope, forced_ids,
    )
    .await?;
    let members = participants
        .into_iter()
        .map(|p| DispatchedMember {
            companion_id: p.companion_id,
            name: p.name,
            avatar_emoji: p.avatar_emoji,
            color_hex: p.color_hex,
        })
        .collect();
    Ok(GroupDispatchOutcome::Dispatched {
        collaboration_id: collab_id,
        members,
    })
}

/// 好友私聊:把这一轮消息派遣给单个 companion(private scope,它必答、流式)。
/// 返回 collaboration_id;前端 chat://complete 后 loadMessages 拉到协作消息渲染。
/// 与群聊不同:private scope(私有记忆,不进群桶)、单成员、无路由判断(它就是这个
/// 会话的对象,必答)。
pub async fn dispatch_to_companion(
    db: Arc<Database>,
    cfg: LLMConfig,
    session_id: &str,
    user_message: &str,
    companion_id: i64,
) -> Result<i64, String> {
    let companion = db
        .get_companion(companion_id)
        .ok_or_else(|| format!("companion {companion_id} 不存在"))?;
    let participant = Participant {
        companion_id: companion.id,
        name: companion.name.clone(),
        avatar_emoji: companion.avatar_emoji.clone(),
        color_hex: companion.color_hex.clone(),
        memory_scope: MemoryScope::Private,
    };
    let plan = CollaborationPlan {
        steps: vec![Step {
            id: 1,
            kind: StepKind::ParallelAgents, // 1 人也走 ParallelAgents(流式气泡渲染)
            participants: vec![participant.clone()],
            depends_on: vec![],
            input: StepInput {
                prompt: user_message.to_string(),
                metadata: serde_json::Value::Null,
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
            CollaborationMode::Dispatched(0),
            parent_id,
        )
        .await?;
    let placeholder = format!("@{} {}", participant.name, user_message);
    let _ = db.upsert_collaboration_message(session_id, collab_id, &placeholder);
    Ok(collab_id)
}

/// S2②:项目群的建造任务由 PM 接手 —— 单 PM 的协作(group 记忆 scope,共享团队上下文
/// + 项目工作区),绕开放养循环。PM 据其 persona 用 ask_user 澄清需求、给方案;真正派工
/// 给各角色是 S2③。结构同 `dispatch_to_companion`,差别:participant 用 Group scope、
/// CollaborationMode 标 PM。
/// S6:已迁 engine/work/launcher::launch_intake,路由不再调用本函数;死代码 S8 删。
#[allow(dead_code)]
async fn dispatch_project_intake(
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

    // 队友名单:接口人用 propose_project_plan 派工时,role 字段要填队友的 agent_definition_name。
    // 动态团队的接口人不认识队友 slug,靠这份名单才能写对计划。排除接口人自己。
    // 复用调用方已查好的 members(CompanionProfile.description 已是 role_label→slug 的回落),
    // 不再二次查 list_group_members。
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
                // mode=intake:牵头者接手步,run_one_guarded 给宽裕总超时(ask_user 阻塞等答);
                // roster=队友名单,run_one_react 注入接口人 prompt,让它知道派工时 role 填谁。
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

/// 找项目接管的牵头成员(G3):软件公司 PM,或自定义团队里 coordinator 档位的协调者。
/// coordinator 判定读 registry 里该角色定义的 `permission_profile`(G1/G2 动态角色有此元数据)。
/// app handle / registry 不可达(headless)→ 退化为只认 "pm" slug。
/// S6:已迁 engine/work/launcher,路由改用 work::should_launch_work;死代码 S8 删。
#[allow(dead_code)]
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

/// 用户喊"停"——放养群聊里任何消息都会起新一轮,所以"停"得显式识别:命中则只取消当前循环、
/// 不再起新的(否则"停"被当成新话题又点燃,用户根本喊不停)。见用户反馈 2026-06-02。
pub fn is_stop_intent(msg: &str) -> bool {
    let m = msg.trim();
    // 极短的纯停止 —— 整条就是个"停"。
    const EXACT: &[&str] = &[
        "停", "停停", "停!", "停!", "停。", "别说了", "别聊了", "安静", "闭嘴", "够了", "打住",
        "stop", "Stop", "STOP",
    ];
    if EXACT.iter().any(|k| m == *k) {
        return true;
    }
    // 含明确停止短语。
    const KW: &[&str] = &[
        "别聊了", "别说了", "别说话", "都别说", "都别聊", "停下来", "停一下", "先停", "停止",
        "安静点", "安静会", "别吵", "你们停", "你们别说", "给我停", "可以停了", "别再说",
        "不要说了", "都停", "停一停",
    ];
    KW.iter().any(|k| m.contains(k))
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

