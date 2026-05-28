//! `LLMDispatchStrategy` — production `DispatchStrategy` impl.
//!
//! 家族会话 L1 模型(多成员并行):strategy 不再选 1 个,而是从家族里挑出"该响应的所有成员"
//! 组成 `ParallelAgents` plan,让 UI 同框冒出多个气泡(群聊感)。0 个相关 → host 自答
//! (空 plan + confidence 0)。
//!
//! L2 会在此基础上替换"集中 judge"为"每成员自决 claim"(slock 风格),
//! L3 加 chime-in 第 2 轮。当前是 L1 的集中判断版本。
//!
//! Resilience: LLM 调用失败 / JSON 坏 / 选出的 id 不在家族里 / 没选到任何人 →
//! 都返回空 plan + confidence 0.0 + reason 字符串。caller 据此 fallback 主精灵自答。

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

/// 每成员入选时的最低 confidence(LLM 在 prompt 里被告知用 0.6 为强相关基准,
/// 实际过滤用 0.5 留一档缓冲)。低于此值的不算入选。
const MEMBER_CONFIDENCE_THRESHOLD: f64 = 0.5;

/// Stateless strategy —— 持 LLMConfig,每次 judge() 一次 LLM 调用。Clone 廉价。
#[derive(Clone)]
pub struct LLMDispatchStrategy {
    config: LLMConfig,
}

impl LLMDispatchStrategy {
    pub fn new(config: LLMConfig) -> Self {
        Self { config }
    }
}

/// LLM 输出的 JSON 形态。空 `members` 数组 = 没人合适(等价于主精灵自答兜底)。
#[derive(Debug, Deserialize)]
pub(crate) struct RawDecision {
    #[serde(default)]
    pub members: Vec<RawMember>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RawMember {
    pub id: i64,
    #[serde(default)]
    pub confidence: f64,
    #[serde(default)]
    pub reason: String,
}

/// Pure prompt builder —— 提取出来让单测可独立校验文案(无 LLM 往返)。
pub(crate) fn build_dispatch_prompt(ctx: &DispatchContext) -> String {
    let mut s = String::new();
    s.push_str(
        "你看着这个家族群聊。用户刚说了一句话,你要挑出应该响应的成员 —— 可以挑 0 个\
         (没人合适,让主精灵自答)、挑 1 个、或挑多个(多人同时回,群聊感)。\n\n",
    );

    s.push_str("【家族成员】\n");
    if ctx.family.is_empty() {
        s.push_str("(暂无家族成员)\n");
    } else {
        for c in &ctx.family {
            s.push_str(&format!(
                "- id={} {} {} — {}\n",
                c.id, c.avatar_emoji, c.name, c.description
            ));
        }
    }

    s.push_str("\n【用户消息】\n");
    s.push_str(&ctx.user_intent);
    s.push('\n');

    if !ctx.recent_corrections.is_empty() {
        s.push_str("\n【最近的用户改派 / 反馈】(用来调整这次判断)\n");
        for sig in ctx.recent_corrections.iter().take(8) {
            s.push_str(&format!("- {}\n", summarize_signal(sig)));
        }
    }

    s.push_str(
        r#"
【挑选规则】
- 强相关此成员的特长 → 加入,confidence ≥ 0.6
- 沾边但有人更合适 → 不加入(留给主战场)
- 不相关 → 不加入
- 群感优先:话题宽时多挑几个(2-3 个);话题窄就 1 个;实在没人合适就空数组

【输出格式】严格 JSON,不要 markdown 围栏:
{
  "members": [
    {"id": 整数, "confidence": 0.0-1.0, "reason": "一句话理由"}
  ]
}
"#,
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
            format!("协作 {} 用户反驳:{}", collaboration_id, user_note)
        }
        StepRetried { collaboration_id, step_id } => {
            format!("协作 {} step {} 被重叫", collaboration_id, step_id)
        }
        PlanAborted { collaboration_id, .. } => {
            format!("协作 {} 用户中止了", collaboration_id)
        }
    }
}

/// Pure parser —— 剥常见的 LLM 噪音(markdown fence/前后空白)后反序列化。
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

/// 空兜底决策 —— LLM 调用失败 / 没人入选 / 选错 id 时返回。caller 看
/// `confidence == 0.0` 走主精灵自答。
fn fallback(reason: impl Into<String>) -> DispatchDecision {
    DispatchDecision {
        plan: CollaborationPlan::default(),
        reason: reason.into(),
        confidence: 0.0,
    }
}

/// 用挑中的 N 个成员构造 ParallelAgents plan(N≥1)。Step id 1 即可 —— 编排器的
/// 复合主键按 collaboration 限定 id 范围。
///
/// 注意:所有 participant 默认 `MemoryScope::Private`,family_dispatch wiring 那层
/// 会根据 session.group_id 翻成 `Family` 或 `FamilyGroup(id)`。
fn build_plan(intent: &str, members: &[&CompanionProfile]) -> CollaborationPlan {
    let participants: Vec<Participant> = members
        .iter()
        .map(|c| Participant {
            companion_id: c.id,
            name: c.name.clone(),
            avatar_emoji: c.avatar_emoji.clone(),
            color_hex: c.color_hex.clone(),
            memory_scope: MemoryScope::Private,
        })
        .collect();

    CollaborationPlan {
        steps: vec![Step {
            id: 1,
            kind: StepKind::ParallelAgents,
            participants,
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
            return Ok(fallback("家族还没有成员,主精灵自答"));
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
            Err(e) => return Ok(fallback(format!("调度判断 LLM 调用失败:{e},主精灵自答"))),
        };

        let raw_text = resp
            .message
            .content
            .map(|c| c.into_text())
            .unwrap_or_default();
        let decision = match parse_decision(&raw_text) {
            Ok(d) => d,
            Err(e) => return Ok(fallback(format!("调度判断输出无法解析:{e},主精灵自答"))),
        };

        // 过滤:confidence ≥ 阈值 + id 在家族里。LLM 偶尔幻觉个不存在的 id,丢弃。
        let selected: Vec<&CompanionProfile> = decision
            .members
            .iter()
            .filter(|m| m.confidence >= MEMBER_CONFIDENCE_THRESHOLD)
            .filter_map(|m| ctx.family.iter().find(|c| c.id == m.id))
            .collect();

        if selected.is_empty() {
            return Ok(fallback("没有合适成员响应,主精灵自答"));
        }

        // 入选成员的最高 confidence 作为 plan 整体 confidence(safety net 用)。
        let max_conf = decision
            .members
            .iter()
            .filter(|m| selected.iter().any(|s| s.id == m.id))
            .map(|m| m.confidence)
            .fold(0.0_f64, f64::max)
            .clamp(0.0, 1.0);
        let names: Vec<&str> = selected.iter().map(|c| c.name.as_str()).collect();
        let summary_reason = format!("挑了 {} 位成员:{}", selected.len(), names.join("、"));

        Ok(DispatchDecision {
            plan: build_plan(&ctx.user_intent, &selected),
            reason: summary_reason,
            confidence: max_conf,
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
        assert!(p.contains("\"members\""), "prompt 应描述新的 members 输出形态");
    }

    #[test]
    fn prompt_handles_empty_family() {
        let ctx = ctx_with(vec![], "anything");
        let p = build_dispatch_prompt(&ctx);
        assert!(p.contains("暂无家族成员"));
    }

    #[test]
    fn parse_decision_accepts_multi_member_json() {
        let raw = r#"{"members":[{"id":7,"confidence":0.9,"reason":"代码评审"},{"id":3,"confidence":0.7,"reason":"视觉化"}]}"#;
        let d = parse_decision(raw).expect("parse");
        assert_eq!(d.members.len(), 2);
        assert_eq!(d.members[0].id, 7);
        assert!((d.members[0].confidence - 0.9).abs() < 0.001);
        assert_eq!(d.members[1].id, 3);
    }

    #[test]
    fn parse_decision_strips_markdown_fences() {
        let raw = "```json\n{\"members\":[{\"id\":5,\"confidence\":0.7,\"reason\":\"x\"}]}\n```";
        let d = parse_decision(raw).expect("parse");
        assert_eq!(d.members.len(), 1);
        assert_eq!(d.members[0].id, 5);
    }

    #[test]
    fn parse_decision_empty_members_means_self_answer() {
        // LLM 觉得没人合适,合法返回空 members。caller(judge)会走 fallback。
        let raw = r#"{"members":[]}"#;
        let d = parse_decision(raw).expect("parse");
        assert!(d.members.is_empty());
    }

    #[test]
    fn parse_decision_rejects_garbage() {
        assert!(parse_decision("not json at all").is_err());
        // 无 members 字段,serde default 给空数组,parse 仍成功 —— 算法 fallback。
        let d = parse_decision("{}").expect("missing members → default []");
        assert!(d.members.is_empty());
    }

    #[test]
    fn build_plan_produces_parallel_agents_step_with_members() {
        let a = profile(42, "阿狸");
        let b = profile(7, "小冰");
        let plan = build_plan("hello", &[&a, &b]);
        assert_eq!(plan.steps.len(), 1);
        let step = &plan.steps[0];
        assert_eq!(step.kind, StepKind::ParallelAgents);
        assert_eq!(step.participants.len(), 2);
        assert_eq!(step.participants[0].companion_id, 42);
        assert_eq!(step.participants[1].companion_id, 7);
        // 各 participant 默认 Private;family_dispatch wiring 翻 Family/FamilyGroup。
        assert_eq!(step.participants[0].memory_scope, MemoryScope::Private);
        assert_eq!(step.input.prompt, "hello");
        assert!(step.depends_on.is_empty());
    }

    #[test]
    fn build_plan_single_member_still_uses_parallel_agents_for_uniform_ui() {
        // 即便只挑了 1 人,也走 ParallelAgents —— 让群聊 UI(气泡同框)统一,
        // 不再有 SingleAgent 卡片这种"独白"形态。
        let a = profile(42, "阿狸");
        let plan = build_plan("hello", &[&a]);
        assert_eq!(plan.steps[0].kind, StepKind::ParallelAgents);
        assert_eq!(plan.steps[0].participants.len(), 1);
    }

    #[test]
    fn fallback_carries_reason_and_zero_confidence() {
        let d = fallback("custom reason");
        assert_eq!(d.reason, "custom reason");
        assert_eq!(d.confidence, 0.0);
        assert!(d.plan.steps.is_empty());
    }
}
