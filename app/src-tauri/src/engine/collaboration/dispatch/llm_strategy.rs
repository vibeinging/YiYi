//! `LLMDispatchStrategy` — production `DispatchStrategy` impl.
//!
//! Phase 2B scope: only generates `SingleAgent` plans (single companion
//! call). Multi-companion jury / plan DAGs come in Phase 2C / 4 by
//! widening this same JSON schema; the orchestrator side is already
//! agnostic.
//!
//! Resilience: if the LLM call fails, the JSON is malformed, the chosen
//! companion isn't in the roster, or the family is empty — we return an
//! empty-plan `DispatchDecision` with `confidence = 0.0` and a reason
//! string. Callers gate on confidence and fall back to "主精灵 self
//! answers" rather than blocking the user on a transient classifier hiccup.

use async_trait::async_trait;
use serde::Deserialize;

use super::super::{
    CollaborationPlan, CompanionProfile, DispatchContext, DispatchDecision, Participant, Step,
    StepInput, StepKind, StepStatus,
};
use super::DispatchStrategy;
use crate::engine::agents::MemoryScope;
use crate::engine::llm_client::{chat_completion_tracked, LLMConfig, LLMMessage, MessageContent};
use crate::engine::usage::UsageSource;

/// Stateless strategy — holds the LLM config and emits a fresh call per
/// `judge`. Clone is cheap (LLMConfig fields are mostly `String` / `Arc`-
/// like).
#[derive(Clone)]
pub struct LLMDispatchStrategy {
    config: LLMConfig,
}

impl LLMDispatchStrategy {
    pub fn new(config: LLMConfig) -> Self {
        Self { config }
    }
}

/// JSON shape the LLM is asked to emit. `chosen_companion_id = 0` is the
/// "main spirit answers" sentinel — equivalent to `confidence = 0`.
#[derive(Debug, Deserialize)]
struct RawDecision {
    chosen_companion_id: i64,
    reason: String,
    #[serde(default)]
    confidence: f64,
}

/// Pure prompt builder — extracted so unit tests can verify wording
/// without an LLM round-trip.
pub(crate) fn build_dispatch_prompt(ctx: &DispatchContext) -> String {
    let mut s = String::new();
    s.push_str(
        "你是 YiYi 家族的调度官。用户刚提了一个请求，你要决定让家族里哪位伙伴来回应，\
         或者让主小精灵自己回。\n\n",
    );

    s.push_str("【可调度的家族成员】\n");
    if ctx.family.is_empty() {
        s.push_str("（暂无家族成员）\n");
    } else {
        for c in &ctx.family {
            s.push_str(&format!(
                "- id={} {} {} — {}\n",
                c.id, c.avatar_emoji, c.name, c.description
            ));
        }
    }

    s.push_str("\n【用户请求】\n");
    s.push_str(&ctx.user_intent);
    s.push('\n');

    if !ctx.recent_corrections.is_empty() {
        s.push_str("\n【最近的用户改派 / 反馈】(用来调整这次判断)\n");
        for sig in ctx.recent_corrections.iter().take(8) {
            s.push_str(&format!("- {}\n", summarize_signal(sig)));
        }
    }

    s.push_str(
        "\n【输出格式】严格 JSON，仅包含以下字段（不要 markdown 围栏）：\n\
         {\n\
         \"chosen_companion_id\": 整数（家族里某位的 id；0 表示主小精灵自答）,\n\
         \"reason\": \"一句话说明为啥派给他/她，给用户看的\",\n\
         \"confidence\": 0.0 到 1.0\n\
         }\n",
    );
    s
}

fn summarize_signal(sig: &super::super::learning::LearningSignal) -> String {
    use super::super::learning::LearningSignal::*;
    match sig {
        DispatchRecalled { collaboration_id, .. } => {
            format!("协作 {} 用户召回了派遣", collaboration_id)
        }
        DispatchChanged { collaboration_id, .. } => {
            format!("协作 {} 用户改了派遣阵容", collaboration_id)
        }
        VerdictAccepted { collaboration_id } => {
            format!("协作 {} 用户接受了结论", collaboration_id)
        }
        VerdictRejected { collaboration_id, user_note } => {
            format!("协作 {} 用户反驳：{}", collaboration_id, user_note)
        }
        StepRetried { collaboration_id, step_id } => {
            format!("协作 {} step {} 被重叫", collaboration_id, step_id)
        }
        PlanAborted { collaboration_id, .. } => {
            format!("协作 {} 用户中止了", collaboration_id)
        }
    }
}

/// Pure parser — strips common LLM oddities (markdown fences, leading
/// whitespace) before attempting to deserialize.
pub(crate) fn parse_decision(raw: &str) -> Result<RawDecision, String> {
    let cleaned = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    serde_json::from_str::<RawDecision>(cleaned)
        .map_err(|e| format!("parse dispatch JSON: {e} (raw: {})", &cleaned[..cleaned.len().min(200)]))
}

/// Build the empty/fallback decision used when the LLM call fails or the
/// chosen companion isn't valid. Caller checks `confidence == 0.0` and
/// routes to "self" mode.
fn fallback(reason: impl Into<String>) -> DispatchDecision {
    DispatchDecision {
        plan: CollaborationPlan::default(),
        reason: reason.into(),
        confidence: 0.0,
    }
}

/// Build a SingleAgent plan from the chosen companion. Step id 1 is fine —
/// the orchestrator's composite PK scopes ids per collaboration.
fn build_plan(intent: &str, companion: &CompanionProfile) -> CollaborationPlan {
    let participant = Participant {
        companion_id: companion.id,
        name: companion.name.clone(),
        avatar_emoji: companion.avatar_emoji.clone(),
        color_hex: companion.color_hex.clone(),
        // Phase 2B: companion-dispatched single agents always use their
        // own private bucket. Shared / Family are explicit opt-ins via
        // memory_tools `scope` arg.
        memory_scope: MemoryScope::Private,
    };
    CollaborationPlan {
        steps: vec![Step {
            id: 1,
            kind: StepKind::SingleAgent,
            participants: vec![participant],
            depends_on: vec![],
            input: StepInput {
                prompt: intent.to_string(),
                metadata: serde_json::Value::Null,
            },
            output: None,
            status: StepStatus::Pending,
            started_at: None,
            finished_at: None,
        }],
    }
}

#[async_trait]
impl DispatchStrategy for LLMDispatchStrategy {
    async fn judge(&self, ctx: &DispatchContext) -> Result<DispatchDecision, String> {
        if ctx.family.is_empty() {
            return Ok(fallback("家族还没有成员，主精灵自答"));
        }

        let prompt = build_dispatch_prompt(ctx);
        let messages = vec![LLMMessage {
            role: "user".into(),
            content: Some(MessageContent::text(prompt)),
            tool_calls: None,
            tool_call_id: None,
            reasoning_content: None,
        }];

        let resp = match chat_completion_tracked(
            UsageSource::CollabDispatch,
            &self.config,
            &messages,
            &[],
        )
        .await
        {
            Ok(r) => r,
            Err(e) => return Ok(fallback(format!("调度判断 LLM 调用失败：{e}，主精灵自答"))),
        };

        let raw_text = resp
            .message
            .content
            .map(|c| c.into_text())
            .unwrap_or_default();
        let decision = match parse_decision(&raw_text) {
            Ok(d) => d,
            Err(e) => return Ok(fallback(format!("调度判断输出无法解析：{e}，主精灵自答"))),
        };

        if decision.chosen_companion_id == 0 || decision.confidence <= 0.0 {
            return Ok(fallback(decision.reason));
        }

        let chosen = ctx
            .family
            .iter()
            .find(|c| c.id == decision.chosen_companion_id);
        let Some(chosen) = chosen else {
            return Ok(fallback(format!(
                "调度选了 id={} 但不在家族里，主精灵自答",
                decision.chosen_companion_id
            )));
        };

        Ok(DispatchDecision {
            plan: build_plan(&ctx.user_intent, chosen),
            reason: decision.reason,
            confidence: decision.confidence.clamp(0.0, 1.0),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::collaboration::CompanionProfile;

    fn profile(id: i64, name: &str) -> CompanionProfile {
        CompanionProfile {
            id,
            name: name.into(),
            agent_definition_name: "code_reviewer".into(),
            avatar_emoji: "🦊".into(),
            color_hex: "#000".into(),
            description: format!("test profile {name}"),
            last_used_at: None,
        }
    }

    fn ctx_with(family: Vec<CompanionProfile>, intent: &str) -> DispatchContext {
        DispatchContext {
            user_intent: intent.into(),
            chat_history: vec![],
            family,
            recent_corrections: vec![],
        }
    }

    #[test]
    fn prompt_lists_every_family_member() {
        let ctx = ctx_with(
            vec![profile(1, "阿狸"), profile(2, "小冰"), profile(3, "九尾")],
            "帮我看代码",
        );
        let p = build_dispatch_prompt(&ctx);
        assert!(p.contains("阿狸"));
        assert!(p.contains("小冰"));
        assert!(p.contains("九尾"));
        assert!(p.contains("帮我看代码"));
        assert!(p.contains("chosen_companion_id"));
    }

    #[test]
    fn prompt_handles_empty_family() {
        let ctx = ctx_with(vec![], "anything");
        let p = build_dispatch_prompt(&ctx);
        assert!(p.contains("暂无家族成员"));
    }

    #[test]
    fn parse_decision_accepts_plain_json() {
        let raw = r#"{"chosen_companion_id": 7, "reason": "代码评审", "confidence": 0.9}"#;
        let d = parse_decision(raw).expect("parse");
        assert_eq!(d.chosen_companion_id, 7);
        assert!((d.confidence - 0.9).abs() < 0.001);
    }

    #[test]
    fn parse_decision_strips_markdown_fences() {
        let raw = "```json\n{\"chosen_companion_id\": 5, \"reason\": \"x\", \"confidence\": 0.7}\n```";
        let d = parse_decision(raw).expect("parse");
        assert_eq!(d.chosen_companion_id, 5);
    }

    #[test]
    fn parse_decision_defaults_confidence_when_missing() {
        let raw = r#"{"chosen_companion_id": 0, "reason": "self"}"#;
        let d = parse_decision(raw).expect("parse");
        assert_eq!(d.chosen_companion_id, 0);
        assert_eq!(d.confidence, 0.0);
    }

    #[test]
    fn parse_decision_rejects_garbage() {
        assert!(parse_decision("not json at all").is_err());
        assert!(parse_decision("{}").is_err()); // missing required field
    }

    #[test]
    fn build_plan_produces_single_agent_step() {
        let plan = build_plan("hello", &profile(42, "阿狸"));
        assert_eq!(plan.steps.len(), 1);
        let step = &plan.steps[0];
        assert_eq!(step.kind, StepKind::SingleAgent);
        assert_eq!(step.participants.len(), 1);
        assert_eq!(step.participants[0].companion_id, 42);
        assert_eq!(step.participants[0].name, "阿狸");
        assert_eq!(step.participants[0].memory_scope, MemoryScope::Private);
        assert_eq!(step.input.prompt, "hello");
        assert!(step.depends_on.is_empty());
    }

    #[test]
    fn fallback_carries_reason_and_zero_confidence() {
        let d = fallback("custom reason");
        assert_eq!(d.reason, "custom reason");
        assert_eq!(d.confidence, 0.0);
        assert!(d.plan.steps.is_empty());
    }

    #[test]
    fn summarize_signal_covers_all_variants() {
        use super::super::super::learning::LearningSignal::*;
        use crate::engine::collaboration::CollaborationPlan;

        let cases = vec![
            DispatchRecalled {
                collaboration_id: 1,
                original_plan: CollaborationPlan::default(),
            },
            DispatchChanged {
                collaboration_id: 2,
                original_plan: CollaborationPlan::default(),
                edited_plan: CollaborationPlan::default(),
            },
            VerdictAccepted { collaboration_id: 3 },
            VerdictRejected {
                collaboration_id: 4,
                user_note: "不行".into(),
            },
            StepRetried {
                collaboration_id: 5,
                step_id: 1,
            },
            PlanAborted {
                collaboration_id: 6,
                at_step: None,
            },
        ];
        for sig in cases {
            let s = summarize_signal(&sig);
            assert!(!s.is_empty(), "signal {sig:?} produced empty summary");
        }
    }
}
