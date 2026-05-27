//! `propose_companion` — the main 精灵 generates a draft new family member
//! from a user description. The draft lands as an `assistant` message with
//! a `companion_draft` payload in its metadata; the frontend hydrates it
//! into a `CompanionDraftCard` where the user adopts / edits / dismisses
//! on the spot. The tool itself never writes to the `companions` table.
//!
//! Design: `docs/design/2026-05-18_companion-draft-generator.md`.

use serde::{Deserialize, Serialize};

use super::{tool_def, ToolDefinition};
use crate::engine::llm_client::{self, LLMMessage, MessageContent};
use crate::engine::usage::UsageSource;

/// Templates a draft is allowed to inherit from. Mirrors the on-disk
/// `app/src-tauri/agents/<name>/AGENT.md` builtin companion templates.
const VALID_TEMPLATES: &[&str] = &[
    "code_reviewer",
    "product_strategist",
    "life_coach",
    "blank",
];

pub fn definitions() -> Vec<ToolDefinition> {
    vec![tool_def(
        "propose_companion",
        "Generate a draft for a new family-member (companion) based on the user's description. \
         Use this when the user explicitly asks to add / create / generate a new companion \
         (e.g. 「帮我生成一个能写小红书爆款的家族成员」). The tool produces a draft companion \
         spec (name / avatar / color / role / persona) and renders an interactive card in chat. \
         The user adopts, edits, or dismisses on the card — do NOT call adopt_companion yourself.",
        serde_json::json!({
            "type": "object",
            "properties": {
                "description": {
                    "type": "string",
                    "description": "User's natural-language description of what the new companion should do / be like"
                }
            },
            "required": ["description"]
        }),
    )]
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CompanionDraft {
    pub name: String,
    pub avatar_emoji: String,
    pub color_hex: String,
    /// Tool-permission template slug (one of VALID_TEMPLATES). NOT shown
    /// in the UI — purely controls baseline tool access.
    pub agent_definition_name: String,
    /// Free-text "擅长" shown in the UI. Author this for the *user*,
    /// not the LLM (e.g. "小红书爆款写手", "数学竞赛教练", "周末烹饪小当家").
    pub role_label: String,
    pub persona_md: String,
    pub tone_preview: String,
    pub rationale: String,
}

pub async fn propose_companion_tool(args: &serde_json::Value) -> String {
    let description = args
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if description.is_empty() {
        return "Error: description is required".into();
    }

    let cfg = match super::resolve_llm_config_from_globals().await {
        Some(c) => c,
        None => return "Error: 当前没有可用的 LLM provider，无法生成草稿。".into(),
    };

    let messages = vec![
        LLMMessage {
            role: "system".into(),
            content: Some(MessageContent::text(&build_system_prompt())),
            tool_calls: None,
            tool_call_id: None,
            reasoning_content: None,
        },
        LLMMessage {
            role: "user".into(),
            content: Some(MessageContent::text(description)),
            tool_calls: None,
            tool_call_id: None,
            reasoning_content: None,
        },
    ];

    let resp = match tokio::time::timeout(
        std::time::Duration::from_secs(30),
        llm_client::chat_completion_tracked(UsageSource::Other, &cfg, &messages, &[]),
    )
    .await
    {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => return format!("Error: LLM 调用失败 — {e}"),
        Err(_) => return "Error: LLM 调用超时（30s），请再试。".into(),
    };

    let raw_text = resp
        .message
        .content
        .as_ref()
        .and_then(|c| c.as_text())
        .unwrap_or("");

    let draft = match parse_draft(raw_text) {
        Ok(d) => d,
        Err(e) => return format!("Error: 草稿格式不合法 — {e}"),
    };
    if let Err(e) = validate_draft(&draft) {
        return format!("Error: 草稿校验失败 — {e}");
    }

    let session_id = super::TASK_SESSION_ID
        .try_with(|s| s.clone())
        .unwrap_or_default();
    if session_id.is_empty() {
        return "Error: 无 session 上下文，无法落卡片。".into();
    }
    let db = match super::get_database() {
        Some(d) => d,
        None => return "Error: DB 未就绪。".into(),
    };

    let metadata = serde_json::json!({
        "companion_draft": draft,
        "draft_state": "pending",
    });
    let intro = format!(
        "我帮你想了一位伙伴 — {}（{}）。",
        draft.name, draft.avatar_emoji
    );

    if let Err(e) = db.push_message_with_metadata(
        &session_id,
        "assistant",
        &intro,
        Some(&metadata.to_string()),
    ) {
        return format!("Error: 写入 message 失败 — {e}");
    }

    format!(
        "已为用户生成 companion 草稿：{} {}（基于模板 {}）。卡片已在聊天界面展示，\
         用户会选择「收养 / 改改 / 算了」。**不要**再调 adopt_companion；\
         你接下来只需用一两句自然语言把话题收一收。",
        draft.name, draft.avatar_emoji, draft.agent_definition_name
    )
}

fn build_system_prompt() -> String {
    r##"你是 YiYi 的家族成员设计师。用户描述想要的新家族成员，你产出一份 JSON 草稿。

家族成员叫"伙伴"——是一个有性格的电子精灵，不是工具人。命名要有人格、不要功能化（❌「文案助手」 ✅「小红」「阿溪」「绿绿」）。

`agent_definition_name` 只决定**工具权限**（什么工具可调），跟 UI 显示无关：
- code_reviewer（能用代码 / git / 文件 / shell 类工具）
- product_strategist（侧重检索 / 文档 / 浏览器）
- life_coach（最轻量，主要靠对话 + 记忆）
- blank（兜底；不确定就选这个）
按"这位伙伴会用到哪类工具"来挑，不是按 UI 分类挑。

`role_label` 是给用户看的「擅长一句话」，**自由文本**，根据用户描述自己写，不要套预设词。例：「小红书爆款写手」「数学竞赛教练」「周末烹饪小当家」「读书伴侣」「PRD 把关人」。每位伙伴的 role_label 应当不同，体现各自特色。

输出**纯 JSON**（不要包 markdown 代码块），字段：
- name: 伙伴的名字（1-24 字，有人格）
- avatar_emoji: **单个** emoji（一个字符）
- color_hex: 主色，形如 "#F87171"
- agent_definition_name: 上面四选一（只为工具权限）
- role_label: 自由文本（1-30 字），描述这位伙伴的"擅长"
- persona_md: markdown，描述这个伙伴的「风格 / 擅长 / 禁区 / 口头禅」（≤ 600 字）
- tone_preview: 一句话示范这个伙伴的说话口吻（≤ 60 字）
- rationale: 给用户看的简短说明：为什么是这个 emoji / 颜色 / role_label（≤ 100 字）"##
        .to_string()
}

fn parse_draft(raw: &str) -> Result<CompanionDraft, String> {
    let trimmed = raw.trim();
    if let Ok(d) = serde_json::from_str::<CompanionDraft>(trimmed) {
        return Ok(d);
    }
    // Strip markdown ```json fences if the model wrapped its output.
    let inner = trimmed
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    serde_json::from_str::<CompanionDraft>(inner).map_err(|e| {
        format!(
            "{e}; raw={}",
            inner.chars().take(300).collect::<String>()
        )
    })
}

fn validate_draft(d: &CompanionDraft) -> Result<(), String> {
    if d.name.is_empty() || d.name.chars().count() > 24 {
        return Err("name 长度需 1-24 字".into());
    }
    if d.avatar_emoji.is_empty() {
        return Err("avatar_emoji 必填".into());
    }
    if !d.color_hex.starts_with('#') || d.color_hex.len() != 7 {
        return Err(format!(
            "color_hex 必须形如 #RRGGBB，得到 {}",
            d.color_hex
        ));
    }
    if !VALID_TEMPLATES.contains(&d.agent_definition_name.as_str()) {
        return Err(format!(
            "agent_definition_name 必须是 {:?} 之一，得到 {}",
            VALID_TEMPLATES, d.agent_definition_name
        ));
    }
    let role_label_len = d.role_label.chars().count();
    if role_label_len == 0 || role_label_len > 30 {
        return Err("role_label 长度需 1-30 字".into());
    }
    if d.persona_md.is_empty() {
        return Err("persona_md 不能为空".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok_draft() -> CompanionDraft {
        CompanionDraft {
            name: "小红".into(),
            avatar_emoji: "📝".into(),
            color_hex: "#F87171".into(),
            agent_definition_name: "blank".into(),
            role_label: "小红书爆款写手".into(),
            persona_md: "## 风格\n爆款".into(),
            tone_preview: "姐妹这条必爆".into(),
            rationale: "粉色火热".into(),
        }
    }

    #[test]
    fn parse_plain_json() {
        let raw = serde_json::to_string(&ok_draft()).unwrap();
        let d = parse_draft(&raw).expect("parse");
        assert_eq!(d.name, "小红");
    }

    #[test]
    fn parse_fenced_json() {
        let raw = format!("```json\n{}\n```", serde_json::to_string(&ok_draft()).unwrap());
        let d = parse_draft(&raw).expect("parse");
        assert_eq!(d.avatar_emoji, "📝");
    }

    #[test]
    fn validate_rejects_bad_color() {
        let mut d = ok_draft();
        d.color_hex = "F87171".into();
        assert!(validate_draft(&d).is_err());
    }

    #[test]
    fn validate_rejects_unknown_template() {
        let mut d = ok_draft();
        d.agent_definition_name = "wizard".into();
        assert!(validate_draft(&d).is_err());
    }

    #[test]
    fn validate_rejects_overlong_name() {
        let mut d = ok_draft();
        d.name = "x".repeat(25);
        assert!(validate_draft(&d).is_err());
    }

    #[test]
    fn validate_rejects_empty_role_label() {
        let mut d = ok_draft();
        d.role_label = "".into();
        assert!(validate_draft(&d).is_err());
    }

    #[test]
    fn definitions_exposes_propose_companion() {
        let defs = definitions();
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].function.name, "propose_companion");
    }
}
