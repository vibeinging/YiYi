//! family_dispatch — 家族会话的「host 上游路由」。
//!
//! 当一个 session 开启了家族模式（见 `db.get_session_family_mode`），主精灵
//! 在自己回答之前先用 `LLMDispatchStrategy::judge` 扫一遍当前 active 家族：
//! 若它以足够置信度选中某个成员，就**派遣**一个单 companion 协作（复用 Phase 2B
//! 的 `delegate_to_companion` → orchestrator 路径）而不是自答；否则主精灵照常自答。
//!
//! 设计：`docs/design/2026-05-27_家族会话-host调度群聊.md`（Approach A）。
//! 路由 strategy（`judge`）本体已实现 + 测试，这里只是把它接进 chat 路径：
//! 组装 `DispatchContext` → judge → 按 confidence 门控 → `submit(Dispatched)`。
//!
//! 本函数刻意**不持有 `AppHandle`**：它只碰 db + LLM，返回一个
//! [`FamilyDispatchOutcome`]，由调用方（chat 命令）负责 emit Tauri 事件、决定
//! 是否还要跑主精灵自答。这样核心路由逻辑可在 TempDb + mock LLM 下直接测。

use std::sync::Arc;

use crate::engine::collaboration::audit::AuditTrail;
use crate::engine::collaboration::dispatch::llm_strategy::LLMDispatchStrategy;
use crate::engine::collaboration::dispatch::DispatchStrategy;
use crate::engine::collaboration::executor::ConcreteExecutor;
use crate::engine::collaboration::learning::sqlite_sink::SqliteLearningSink;
use crate::engine::collaboration::learning::LearningSink;
use crate::engine::collaboration::orchestrator::SqliteOrchestrator;
use crate::engine::collaboration::{
    Actor, AuditKind, ChatTurnSummary, CollaborationMode, CollaborationOrchestrator,
    CompanionProfile, DispatchContext,
};
use crate::engine::db::Database;
use crate::engine::llm_client::LLMConfig;

/// 喂给路由判断的最近对话轮数。有界，免得家族聊久了把（高频、本应便宜的）
/// 路由 prompt 撑大 —— 见设计 Open Question 5。
const DISPATCH_HISTORY_TURNS: usize = 6;
/// 取多少条最近的用户改派/反馈信号给路由参考。
const RECENT_CORRECTIONS: usize = 8;
/// 低于此置信度主精灵自答。与 `DispatchDecision` 文档及 judge 的 fallback 一致。
const DISPATCH_CONFIDENCE_FLOOR: f64 = 0.5;

/// 一次家族路由的结果。调用方据此 emit 路由卡事件、决定是否继续跑主精灵自答。
#[derive(Debug, Clone)]
pub enum FamilyDispatchOutcome {
    /// 主精灵自答 —— 置信度不足 / 家族为空 / judge 兜底。`reason` 可展示给用户。
    SelfAnswer { reason: String },
    /// 已路由给某位家族成员，对应协作正在后台执行。
    Dispatched {
        collaboration_id: i64,
        companion_id: i64,
        companion_name: String,
        avatar_emoji: String,
        color_hex: String,
        reason: String,
        confidence: f64,
    },
}

/// 在家族模式下尝试把 `user_message` 路由给某位成员。
///
/// `cfg` 同时用于路由判断（judge）与被选成员的执行（ConcreteExecutor）。Phase A
/// 复用 session 的 LLM 配置；未来可让 judge 走更便宜的小模型（Open Question 3）。
pub async fn try_family_dispatch(
    db: Arc<Database>,
    cfg: LLMConfig,
    session_id: &str,
    user_message: &str,
) -> Result<FamilyDispatchOutcome, String> {
    // 1. 组家族 roster（Phase A：所有 active companions）。
    let family: Vec<CompanionProfile> = db
        .list_active_companions()
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

    // 2. 近 N 轮对话 + 最近学习信号 → DispatchContext。
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
    let recent_corrections = SqliteLearningSink::new(db.clone())
        .recent(RECENT_CORRECTIONS)
        .await
        .unwrap_or_default();

    let ctx = DispatchContext {
        user_intent: user_message.to_string(),
        chat_history,
        family,
        recent_corrections,
    };

    // 3. 路由判断。strategy 从不硬失败：任何错误都回落到空 plan + confidence 0.0。
    let decision = LLMDispatchStrategy::new(cfg.clone()).judge(&ctx).await?;

    // 4. 门控：空 plan 或置信度不足 → 主精灵自答。
    let Some(participant) = decision
        .plan
        .steps
        .first()
        .and_then(|s| s.participants.first())
        .cloned()
    else {
        return Ok(FamilyDispatchOutcome::SelfAnswer { reason: decision.reason });
    };
    if decision.confidence < DISPATCH_CONFIDENCE_FLOOR {
        return Ok(FamilyDispatchOutcome::SelfAnswer { reason: decision.reason });
    }

    // 5. 派遣：提交单 companion 协作，并以 parent_id 串到本 session 上一个协作
    //    （每轮独立可审计 —— 设计步骤 5 拍板用 parent_id 链）。
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
            decision.plan,
            CollaborationMode::Dispatched(0), // 0 = 主精灵 as dispatcher
            parent_id,
        )
        .await?;

    // 持久化路由决策 —— `DispatchJudged` audit 让刷新 / 重放也能看到 judge 给的理由。
    // emit 同时广播到 collaboration://event 流（live 推送），collab_id 与 actor=Companion(0)
    // 与 `Dispatched(0)` 派遣者身份一致。emit 失败不应阻断派遣，故 `let _`。
    let _ = AuditTrail::new(db.clone()).emit(
        collab_id,
        Actor::Companion(0),
        AuditKind::DispatchJudged,
        serde_json::json!({
            "companion_id": participant.companion_id,
            "companion_name": &participant.name,
            "avatar_emoji": &participant.avatar_emoji,
            "color_hex": &participant.color_hex,
            "reason": &decision.reason,
            "confidence": decision.confidence,
        }),
    );

    // 预写内联 collaboration 消息，turn 结束时前端立刻渲染卡片（同 delegate_to_companion）。
    let placeholder = format!("@{} {}", participant.name, user_message);
    let _ = db.upsert_collaboration_message(session_id, collab_id, &placeholder);

    Ok(FamilyDispatchOutcome::Dispatched {
        collaboration_id: collab_id,
        companion_id: participant.companion_id,
        companion_name: participant.name,
        avatar_emoji: participant.avatar_emoji,
        color_hex: participant.color_hex,
        reason: decision.reason,
        confidence: decision.confidence,
    })
}
