//! 家族会话 L2:per-member self-claim 协议(slock.ai 风格)。
//!
//! L1 是主精灵粗筛 N 个候选;L2 让每个候选**自己**决定要不要接茬 ——
//! 每位带自己的人设 + 群内上下文 + 用户消息,独立跑一次轻量 LLM 调用,
//! 输出 `{claim: true/false, reason}`。yes 的进 ParallelAgents,no 的让位。
//!
//! 为什么要这一步:L1 一个 LLM 帮所有人决定"谁该接",还是中心化思维;L2
//! 让每个成员看到相同消息,各自基于自身专长 / 心情自决,真正去中心化的
//! 群聊感。这也是 slock 多 agent 协作的核心姿态。
//!
//! 防沉默螺旋:候选非空但全 no → caller 退回到 confidence 最高那位上场,
//! 保证至少有人回(避免用户呼喊但群里没人接)。具体回退逻辑由 caller
//! 处理(本模块只产出 per-member 决定)。
//!
//! Resilience:
//! - 单个 claim 调用失败 / JSON 坏 → 该成员 claimed=false(保守不抢话)
//! - 并发用 `futures::future::join_all`,wall clock ≈ 单次调用
//! - 候选为空 → 直接返回空 Vec,不发 LLM 调用

use futures::future::join_all;
use serde::Deserialize;

use super::{ChatTurnSummary, CompanionProfile};
use crate::engine::llm_client::{chat_completion_tracked, LLMConfig, LLMMessage, MessageContent};
use crate::engine::usage::UsageSource;

/// 一位候选的 claim 决定。
#[derive(Debug, Clone, PartialEq)]
pub struct ClaimDecision {
    pub companion_id: i64,
    pub claimed: bool,
    pub reason: String,
}

/// LLM 输出的 claim JSON 形态。
#[derive(Debug, Deserialize)]
struct RawClaim {
    #[serde(default)]
    claim: bool,
    #[serde(default)]
    reason: String,
}

/// 给一位成员看的 claim prompt —— 自决要不要接茬。带成员名 / 人设 / 头像,
/// 让 LLM 站在该成员的视角(而不是上帝视角)做决定。
pub fn build_claim_prompt(
    profile: &CompanionProfile,
    user_intent: &str,
    chat_history: &[ChatTurnSummary],
) -> String {
    let mut s = String::new();
    s.push_str(&format!(
        "你是 {} {},角色:{}。你和其他几位 AI 一起在用户的家族群聊里。\n\n",
        profile.avatar_emoji, profile.name, profile.description,
    ));

    if !chat_history.is_empty() {
        s.push_str("【最近群聊】\n");
        // 取最近 6 条;太老的不在视野内。
        for turn in chat_history.iter().rev().take(6).rev() {
            s.push_str(&format!("- {}: {}\n", turn.role, turn.text));
        }
        s.push('\n');
    }

    s.push_str("【用户刚说】\n");
    s.push_str(user_intent);
    s.push_str("\n\n");

    s.push_str(
        r#"【你要不要接茬】
判断原则:
- 强相关你的特长 / 你最擅长这件事 → 接(claim: true)
- 沾边但别人更合适 / 你不是最佳人选 → 不接(让位给主战场)
- 不相关 → 不接
- 群感:话题大家都能说就接;话题专业别人更懂就让

不要客气也不要抢戏 —— 接茬的标准是"我真的能帮上",不是"群里没人说就我说"。

【输出格式】严格 JSON,不要 markdown 围栏:
{"claim": true/false, "reason": "一句话理由"}
"#,
    );
    s
}

/// 解析单次 claim 调用的输出。剥常见 LLM 噪音(markdown fence)后反序列化。
/// 解析失败 → 默认 claim=false(保守)。
pub fn parse_claim_response(raw: &str) -> ClaimDecision {
    let cleaned = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    match serde_json::from_str::<RawClaim>(cleaned) {
        Ok(c) => ClaimDecision {
            companion_id: 0, // caller 填,本函数只解析 JSON
            claimed: c.claim,
            reason: c.reason,
        },
        Err(_) => ClaimDecision {
            companion_id: 0,
            claimed: false,
            reason: "解析失败,保守不接茬".into(),
        },
    }
}

/// 对 `candidates` 列表里每位成员并发跑一次 claim 调用。
///
/// 输出按 candidates 顺序对齐(每位一定有一条 decision,失败默认 claimed=false)。
/// LLM 调用走 `UsageSource::CollabDispatch` 与 L1 judge 同源,便于审计成本。
///
/// 候选为空 → 直接返回空 Vec,不打扰 LLM。
pub async fn run_claim_round(
    cfg: &LLMConfig,
    user_intent: &str,
    chat_history: &[ChatTurnSummary],
    candidates: &[CompanionProfile],
) -> Vec<ClaimDecision> {
    if candidates.is_empty() {
        return Vec::new();
    }

    let futures = candidates.iter().map(|profile| {
        let cfg = cfg.clone();
        let prompt = build_claim_prompt(profile, user_intent, chat_history);
        let cid = profile.id;
        async move {
            let messages = vec![LLMMessage {
                role: "user".into(),
                content: Some(MessageContent::text(prompt)),
                tool_calls: None,
                tool_call_id: None,
                reasoning_content: None,
            }];
            let resp =
                match chat_completion_tracked(UsageSource::CollabDispatch, &cfg, &messages, &[])
                    .await
                {
                    Ok(r) => r,
                    Err(e) => {
                        return ClaimDecision {
                            companion_id: cid,
                            claimed: false,
                            reason: format!("claim 调用失败:{e}"),
                        };
                    }
                };
            let raw_text = resp
                .message
                .content
                .map(|c| c.into_text())
                .unwrap_or_default();
            let mut decision = parse_claim_response(&raw_text);
            decision.companion_id = cid;
            decision
        }
    });

    join_all(futures).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(id: i64, name: &str, description: &str) -> CompanionProfile {
        CompanionProfile {
            id,
            name: name.into(),
            agent_definition_name: "code_reviewer".into(),
            avatar_emoji: "🦊".into(),
            color_hex: "#000".into(),
            description: description.into(),
            last_used_at: None,
        }
    }

    #[test]
    fn prompt_mentions_profile_name_and_role() {
        let p = profile(7, "阿狸", "代码评审员");
        let prompt = build_claim_prompt(&p, "帮我看看这段代码", &[]);
        assert!(prompt.contains("阿狸"), "prompt 应含成员名");
        assert!(prompt.contains("代码评审员"), "prompt 应含角色描述");
        assert!(prompt.contains("帮我看看这段代码"), "prompt 应含用户消息");
        assert!(prompt.contains("claim"), "prompt 应描述输出格式");
    }

    #[test]
    fn prompt_includes_recent_chat_when_present() {
        let p = profile(1, "小冰", "视觉设计");
        let history = vec![
            ChatTurnSummary {
                role: "user".into(),
                text: "上次讨论了配色".into(),
                timestamp: 0,
            },
            ChatTurnSummary {
                role: "assistant".into(),
                text: "用了暖色系".into(),
                timestamp: 1,
            },
        ];
        let prompt = build_claim_prompt(&p, "再改改主题色", &history);
        assert!(prompt.contains("配色"), "prompt 应含历史对话");
        assert!(prompt.contains("暖色系"), "prompt 应含 assistant 回复");
    }

    #[test]
    fn parse_yes_claim() {
        let raw = r#"{"claim": true, "reason": "我擅长代码评审"}"#;
        let d = parse_claim_response(raw);
        assert!(d.claimed);
        assert!(d.reason.contains("代码评审"));
    }

    #[test]
    fn parse_no_claim() {
        let raw = r#"{"claim": false, "reason": "话题更适合别人"}"#;
        let d = parse_claim_response(raw);
        assert!(!d.claimed);
        assert!(d.reason.contains("别人"));
    }

    #[test]
    fn parse_strips_markdown_fences() {
        let raw = "```json\n{\"claim\":true,\"reason\":\"接\"}\n```";
        let d = parse_claim_response(raw);
        assert!(d.claimed);
    }

    #[test]
    fn parse_garbage_defaults_to_no_claim() {
        // 解析坏 JSON 不能 panic,默认 no(保守不抢话)。
        let d = parse_claim_response("not a json at all");
        assert!(!d.claimed);
        assert!(d.reason.contains("解析失败"));
    }

    #[test]
    fn parse_empty_object_defaults_to_no_claim() {
        // serde default 应给 claim=false / reason=""。
        let d = parse_claim_response("{}");
        assert!(!d.claimed);
    }
}
