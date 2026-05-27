//! `delegate_to_companion` — the main 精灵 hands a task off to a named
//! family member (companion) instead of answering itself.
//!
//! When the user says 「让闪闪写文案」or 「让阿狸来 review 这段代码」,
//! the LLM should call this tool. The tool:
//!   1. Resolves the companion by name (exact, then case/whitespace
//!      tolerant fuzzy match).
//!   2. Submits a single-step collaboration to `SqliteOrchestrator` —
//!      the companion runs in the background with its own
//!      `memory_scope` and `persona.md`.
//!   3. Writes a `messages` row with the new collaboration_id so the
//!      frontend immediately renders a CollaborationMessageCard
//!      (placeholder content shows the @mention + task). On finalize,
//!      the orchestrator UPDATEs the same row to the verdict text.
//!
//! Design: `docs/design/2026-05-15_jury-collaboration-design.md` (the
//! "dispatched" mode + Phase 3 family-mode dispatch); UI integration
//! reuses the same path as the frontend @companion mention.

use std::sync::Arc;

use super::{tool_def, ToolDefinition};
use crate::engine::collaboration::{
    executor::ConcreteExecutor, orchestrator::SqliteOrchestrator, CollaborationMode,
    CollaborationOrchestrator, CollaborationPlan, Participant, Step, StepInput, StepKind,
    StepStatus,
};
use crate::engine::db::Companion;

pub fn definitions() -> Vec<ToolDefinition> {
    vec![tool_def(
        "delegate_to_companion",
        "Hand a task off to a named family member (companion). Use this whenever the user \
         names a companion (e.g. 「让闪闪写文案」「叫阿狸来 review」) OR when the task strongly \
         matches a companion's specialty (e.g. user asks for a small-red-book post and a 文案 \
         companion exists). The companion runs with their own persona and memory; the user \
         sees a collaboration card render inline. **Do NOT answer the task yourself when this \
         tool is appropriate** — the whole point of the family is to let each member specialize.",
        serde_json::json!({
            "type": "object",
            "properties": {
                "companion_name": {
                    "type": "string",
                    "description": "Companion's display name as shown in the family list. Case + whitespace tolerant."
                },
                "task": {
                    "type": "string",
                    "description": "The actual prompt to send to the companion — usually the user's request, lightly cleaned up."
                }
            },
            "required": ["companion_name", "task"]
        }),
    )]
}

pub async fn delegate_to_companion_tool(args: &serde_json::Value) -> String {
    let companion_name = args
        .get("companion_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let task = args
        .get("task")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if companion_name.is_empty() {
        return "Error: companion_name is required".into();
    }
    if task.is_empty() {
        return "Error: task is required".into();
    }

    let db = match super::get_database() {
        Some(d) => d,
        None => return "Error: DB 未就绪。".into(),
    };

    let companions = db.list_active_companions();
    let Some(companion) = find_by_name(&companions, companion_name) else {
        let known: Vec<&str> = companions.iter().map(|c| c.name.as_str()).collect();
        return format!(
            "Error: 没找到名为「{companion_name}」的家族成员。当前家族：{known:?}。\
             如果用户确实想要这位成员，先用 propose_companion 提议生成草稿。"
        );
    };

    let session_id = super::TASK_SESSION_ID
        .try_with(|s| s.clone())
        .unwrap_or_default();
    if session_id.is_empty() {
        return "Error: 无 session 上下文，无法发起协作。".into();
    }

    let cfg = match super::resolve_llm_config_from_globals().await {
        Some(c) => c,
        None => return "Error: 当前没有可用的 LLM provider，无法派遣。".into(),
    };

    let participant = Participant {
        companion_id: companion.id,
        name: companion.name.clone(),
        avatar_emoji: companion.avatar_emoji.clone(),
        color_hex: companion.color_hex.clone(),
        // Default to Private — each companion writes to their own bucket.
        // Family-shared is a Phase 3 LLM-driven decision.
        memory_scope: crate::engine::agents::MemoryScope::Private,
    };

    let plan = CollaborationPlan {
        steps: vec![Step {
            id: 1,
            kind: StepKind::SingleAgent,
            participants: vec![participant],
            depends_on: vec![],
            input: StepInput {
                prompt: task.to_string(),
                metadata: serde_json::json!({}),
            },
            output: None,
            status: StepStatus::Pending,
            started_at: None,
            finished_at: None,
        }],
    };

    let executor = Arc::new(ConcreteExecutor::new(cfg));
    let orch = SqliteOrchestrator::new(db.clone(), executor);
    let collab_id = match orch
        .submit(
            session_id.clone(),
            task.to_string(),
            plan,
            CollaborationMode::Dispatched(0), // 0 = main 精灵 as dispatcher
            None,
        )
        .await
    {
        Ok(id) => id,
        Err(e) => return format!("Error: 派遣失败 — {e}"),
    };

    // Pre-write the inline collaboration message so the user sees a card
    // immediately when this turn's main-loop chat completes (loadMessages
    // hydrates it). finalize() will UPDATE this same row to the verdict
    // text via upsert_collaboration_message.
    let placeholder = format!("@{} {}", companion.name, task);
    if let Err(e) = db.upsert_collaboration_message(&session_id, collab_id, &placeholder) {
        return format!(
            "Error: 协作已发起（id={collab_id}），但消息卡占位失败 — {e}"
        );
    }

    format!(
        "已派遣给 @{}（collaboration_id={collab_id}）。前端会在主聊天回合结束后渲染 \
         CollaborationMessageCard 显示 {} 的回复。你接下来只需用一两句自然语言收一收话题，\
         **不要**自己写答案 — 让 {} 来。",
        companion.name, companion.name, companion.name
    )
}

fn find_by_name<'a>(companions: &'a [Companion], q: &str) -> Option<&'a Companion> {
    let target = q.trim();
    // Exact match
    if let Some(c) = companions.iter().find(|c| c.name == target) {
        return Some(c);
    }
    // Whitespace-tolerant lowercase compare
    let target_norm = target.replace(char::is_whitespace, "").to_lowercase();
    companions.iter().find(|c| {
        c.name
            .replace(char::is_whitespace, "")
            .to_lowercase()
            == target_norm
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(id: i64, name: &str) -> Companion {
        Companion {
            id,
            name: name.into(),
            agent_definition_name: "blank".into(),
            avatar_emoji: "🦊".into(),
            color_hex: "#F97316".into(),
            persona_md_path: None,
            memory_user_id: format!("c_{id}"),
            adopted_at: 0,
            retired_at: None,
            personality_stats_json: None,
            invocation_count: 0,
            last_used_at: None,
            metadata_json: None,
            role_label: None,
        }
    }

    #[test]
    fn fuzzy_match_exact() {
        let arr = vec![mk(1, "闪闪"), mk(2, "阿狸")];
        assert_eq!(find_by_name(&arr, "闪闪").unwrap().id, 1);
        assert_eq!(find_by_name(&arr, "阿狸").unwrap().id, 2);
    }

    #[test]
    fn fuzzy_match_whitespace_tolerant() {
        let arr = vec![mk(1, "Code Reviewer")];
        assert_eq!(find_by_name(&arr, " code  reviewer ").unwrap().id, 1);
    }

    #[test]
    fn fuzzy_match_none() {
        let arr = vec![mk(1, "阿狸")];
        assert!(find_by_name(&arr, "不存在").is_none());
    }

    #[test]
    fn definitions_exposes_delegate() {
        let defs = definitions();
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].function.name, "delegate_to_companion");
    }
}
