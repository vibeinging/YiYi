//! group_dispatch — 群会话的入口路由。
//!
//! 当一个 session 绑定了群（`db.get_session_group` 返回 Some），把消息交给对话循环
//! 引擎（`conversation_driver`）而不是主精灵自答：
//! - **@点名必答**(`forced_ids` 非空)→ 被点成员直接进静态 ParallelAgents 必答。
//! - **非点名**(去中心化)→ 全员进 `dispatch_group_conversation` 第 1 轮,各自
//!   reply-or-`<pass>`,全员不接则 YiYi 兜底位接。"谁该说话"不再前置 judge,是发言
//!   本身的一部分(见 docs/design/2026-05-31 §A 对话循环引擎)。
//!
//! 历史:旧版的 `LLMDispatchStrategy::judge` 中心化预选 + L2 claim + L3 chime 已全
//! 退役(`dispatch` / `claim` 模块删除)。
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

    // ── (a) @点名必答 ── 被点的人(取群内交集)直接上场,跳过自决。静态 plan,
    //    executor 给默认人设 prompt(无 <pass> 余地 = 必答),无 YiYi 兜底位。
    if !forced_ids.is_empty() {
        let forced_present: Vec<CompanionProfile> = forced_ids
            .iter()
            .filter_map(|id| members.iter().find(|c| c.id == *id).cloned())
            .collect();
        if forced_present.is_empty() {
            return Ok(GroupDispatchOutcome::SelfAnswer {
                reason: "被点名的成员不在这个群里".into(),
            });
        }
        let participants: Vec<Participant> = forced_present
            .iter()
            .map(|c| Participant {
                companion_id: c.id,
                name: c.name.clone(),
                avatar_emoji: c.avatar_emoji.clone(),
                color_hex: c.color_hex.clone(),
                memory_scope: group_scope,
            })
            .collect();
        let plan = CollaborationPlan {
            steps: vec![Step {
                id: 1,
                kind: StepKind::ParallelAgents,
                participants: participants.clone(),
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
        let mention = participants
            .iter()
            .map(|p| format!("@{}", p.name))
            .collect::<Vec<_>>()
            .join(" ");
        let _ = db.upsert_collaboration_message(
            session_id,
            collab_id,
            &format!("{mention} {user_message}"),
        );
        let members = participants
            .into_iter()
            .map(|p| DispatchedMember {
                companion_id: p.companion_id,
                name: p.name,
                avatar_emoji: p.avatar_emoji,
                color_hex: p.color_hex,
            })
            .collect();
        return Ok(GroupDispatchOutcome::Dispatched {
            collaboration_id: collab_id,
            members,
        });
    }

    // ── (b) 去中心化群聊 ── 全员进对话循环引擎,各自 reply-or-<pass>;全让 → YiYi
    //    兜底。"谁该说话"不再前置判断,是发言本身的一部分(见对话循环引擎 §A)。
    let (collab_id, participants) = conversation_driver::dispatch_group_conversation(
        db.clone(),
        cfg,
        session_id,
        user_message,
        &members,
        &chat_history,
        group_scope,
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


/// 是否"群讨论"意图 —— 关键词触发(用户决策:关键词自动触发)。命中则走多轮讨论
/// 模式,而非普通的去中心化各自应答。
pub fn is_discussion_intent(msg: &str) -> bool {
    const KW: &[&str] = &[
        "讨论", "辩论", "争论", "你们聊", "你们说说", "你们都说说", "你们怎么看",
        "各抒己见", "头脑风暴", "多轮", "给个结论", "给我一个结论", "给我个结论",
        "你们觉得呢", "都来说说",
    ];
    KW.iter().any(|k| msg.contains(k))
}

