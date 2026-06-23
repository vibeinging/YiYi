//! group_dispatch — chat 单聊会话的派遣 + 停止意图识别。
//!
//! 2026-06-15:chat **多分身群聊/家族已退役**(与 work 多 agent 重叠、易混淆)。
//! 本模块只剩两件 chat 侧仍需要的:
//!   - `dispatch_to_companion`:1:1 分身私聊(session 绑单个 companion)。
//!   - `is_stop_intent`:停止意图识别(work 的 followup 也复用,见 commands/work.rs)。
//! 原放养群聊路由(`try_group_dispatch` + `conversation_driver` 放养引擎)已删。

use std::sync::Arc;

use crate::engine::agents::MemoryScope;
use crate::engine::collaboration::executor::ConcreteExecutor;
use crate::engine::collaboration::orchestrator::SqliteOrchestrator;
use crate::engine::collaboration::{
    CollaborationMode, CollaborationOrchestrator, CollaborationPlan, Participant, Step, StepInput,
    StepKind, StepStatus,
};
use crate::engine::db::Database;
use crate::engine::llm_client::LLMConfig;

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
