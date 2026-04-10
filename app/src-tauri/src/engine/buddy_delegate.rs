//! Buddy Delegate — the user's digital twin that makes decisions on their behalf.
//!
//! The buddy carries USER.md profile + MemMe memories + behavioral corrections,
//! and can answer questions that would otherwise interrupt the user.
//! Used by: skill improvement review, task decisions, permission auto-approval, agent coordination.

use crate::engine::llm_client::{self, LLMConfig, LLMMessage, MessageContent};
use std::collections::HashSet;
use std::sync::Mutex;

/// Per-session hosted flags: tracks which sessions have buddy in control.
static HOSTED_SESSIONS: std::sync::OnceLock<Mutex<HashSet<String>>> = std::sync::OnceLock::new();

fn hosted_set() -> &'static Mutex<HashSet<String>> {
    HOSTED_SESSIONS.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Enable buddy-hosted mode for a specific session.
pub fn enable_session_hosted() {
    let sid = crate::engine::tools::get_current_session_id();
    if !sid.is_empty() {
        hosted_set().lock().unwrap_or_else(|e| e.into_inner()).insert(sid.clone());
        log::info!("Buddy hosted mode: enabled for session {}", sid);
    }
}

/// Disable buddy-hosted mode for a specific session.
pub fn disable_session_hosted() {
    let sid = crate::engine::tools::get_current_session_id();
    if !sid.is_empty() {
        hosted_set().lock().unwrap_or_else(|e| e.into_inner()).remove(&sid);
    }
}

/// Check if buddy is in control (either global hosted mode or per-session).
pub fn is_hosted() -> bool {
    // Per-session flag
    let sid = crate::engine::tools::get_current_session_id();
    if !sid.is_empty() {
        if let Ok(set) = hosted_set().try_lock() {
            if set.contains(&sid) { return true; }
        }
    }
    // Global hosted mode from config
    if let Some(handle) = crate::engine::tools::APP_HANDLE.get() {
        use tauri::Manager;
        let state: tauri::State<'_, crate::state::AppState> = handle.state();
        if let Ok(config) = state.inner().config.try_read() {
            return config.buddy.hosted_mode;
        }
    }
    false
}

/// The result of a buddy delegation.
#[derive(Debug, Clone)]
pub struct DelegateResult {
    /// The buddy's decision or answer.
    pub answer: String,
    /// Confidence level (0.0 - 1.0). Below 0.5 = should ask the user instead.
    pub confidence: f64,
    /// Whether this should be shown to the user for review.
    pub needs_review: bool,
}

/// Context categories for delegation — determines what knowledge the buddy draws on.
#[derive(Debug, Clone, Copy)]
pub enum DelegateContext {
    /// Technical decision during task execution (e.g., "React or Vue?")
    TaskDecision,
    /// Review a skill improvement before applying
    SkillReview,
    /// Evaluate task quality ("Is this result good enough?")
    QualityJudgment,
    /// Respond on behalf of the user (bot messages, etc.)
    UserProxy,
}

/// Delegate a decision to the buddy (user's digital twin).
///
/// The buddy uses USER.md + MemMe memories to answer as if it were the user.
/// Returns `None` if no LLM is configured or the buddy isn't hatched.
pub async fn delegate(
    config: &LLMConfig,
    question: &str,
    context: DelegateContext,
    extra_context: &str,
) -> Option<DelegateResult> {
    // Load user profile
    let working_dir = crate::engine::tools::get_working_dir()?;
    let user_profile = crate::engine::mem::user_model::load_user_model(&working_dir);

    // Load recent memories for additional context
    let memory_context = load_memory_context();

    // Load behavioral corrections (learned preferences)
    let corrections = load_corrections();

    let context_instruction = match context {
        DelegateContext::TaskDecision => {
            "你正在代替用户做一个技术决策。根据用户的偏好和工作风格做出选择。\
             如果你不确定用户会怎么选，confidence 设为低值。"
        }
        DelegateContext::SkillReview => {
            "你正在审核一个 AI 技能的改进。判断这个改动是否符合用户的使用习惯和质量标准。\
             回答 approve（批准）或 reject（拒绝）并说明理由。"
        }
        DelegateContext::QualityJudgment => {
            "你正在评价一个任务的执行结果。根据用户的标准判断质量是否合格。\
             回答 pass（合格）或 fail（不合格）并说明原因。"
        }
        DelegateContext::UserProxy => {
            "你正在代替用户回复消息。用用户的语气和风格回复，要自然，像用户本人在说话。\
             不要暴露你是 AI，也不要说「作为用户的代理」之类的话。"
        }
    };

    let system_prompt = format!(
        "你是用户的数字分身——你了解用户的一切：性格、偏好、工作风格、技术栈、决策习惯。\n\
         你的任务是代替用户做判断，就像用户本人在做决定一样。\n\n\
         {context_instruction}\n\n\
         ## 用户画像\n{profile}\n\n\
         ## 用户的行为偏好\n{corrections}\n\n\
         ## 相关记忆\n{memories}\n\n\
         回复格式（仅 JSON）：\n\
         {{\"answer\": \"你的回答/决定\", \"confidence\": 0.0-1.0, \"needs_review\": true/false}}\n\n\
         - confidence: 你有多确定用户会这么决定。低于 0.5 表示应该去问用户本人\n\
         - needs_review: 这个决定是否重要到需要让用户事后确认",
        context_instruction = context_instruction,
        profile = if user_profile.is_empty() { "（暂无用户画像）".into() } else {
            user_profile.chars().take(800).collect::<String>()
        },
        corrections = if corrections.is_empty() { "（暂无）".into() } else { corrections },
        memories = if memory_context.is_empty() { "（暂无相关记忆）".into() } else { memory_context },
    );

    let messages = vec![
        LLMMessage {
            role: "system".into(),
            content: Some(MessageContent::text(&system_prompt)),
            tool_calls: None,
            tool_call_id: None,
        },
        LLMMessage {
            role: "user".into(),
            content: Some(MessageContent::text(&format!(
                "需要你做决定的问题：{}\n\n附加背景：{}",
                question,
                if extra_context.is_empty() { "无" } else { extra_context }
            ))),
            tool_calls: None,
            tool_call_id: None,
        },
    ];

    let response = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        llm_client::chat_completion(config, &messages, &[]),
    )
    .await
    .ok()?
    .ok()?;

    let text = response.message.content.as_ref()
        .and_then(|c| c.as_text())
        .unwrap_or("")
        .to_string();

    parse_delegate_response(&text)
}

/// Quick delegation for yes/no questions. Returns true/false.
pub async fn delegate_yes_no(
    config: &LLMConfig,
    question: &str,
    context: DelegateContext,
) -> Option<bool> {
    let result = delegate(config, question, context, "").await?;
    let answer_lower = result.answer.to_lowercase();
    if result.confidence < 0.5 {
        return None; // Not confident enough — ask the user
    }
    Some(
        answer_lower.contains("approve")
            || answer_lower.contains("pass")
            || answer_lower.contains("yes")
            || answer_lower.contains("是")
            || answer_lower.contains("批准")
            || answer_lower.contains("合格")
    )
}

// ── Internal helpers ──────────────────────────────────────────────────

fn load_memory_context() -> String {
    let store = match crate::engine::tools::get_memme_store() {
        Some(s) => s,
        None => return String::new(),
    };

    // Search for recent high-importance memories
    match store.list_traces(
        memme_core::ListOptions::new(crate::engine::tools::MEMME_USER_ID)
            .limit(10),
    ) {
        Ok(traces) => {
            traces.iter()
                .filter(|t| t.importance.unwrap_or(0.0) >= 0.6)
                .take(5)
                .map(|t| format!("- {}", t.content.chars().take(150).collect::<String>()))
                .collect::<Vec<_>>()
                .join("\n")
        }
        Err(_) => String::new(),
    }
}

fn load_corrections() -> String {
    let db = match crate::engine::tools::get_database() {
        Some(d) => d,
        None => return String::new(),
    };
    let corrections = db.get_active_corrections(5);
    if corrections.is_empty() {
        return String::new();
    }
    corrections.iter()
        .map(|(trigger, behavior, _)| format!("- {}: {}", trigger, behavior))
        .collect::<Vec<_>>()
        .join("\n")
}

fn parse_delegate_response(text: &str) -> Option<DelegateResult> {
    // Try to extract JSON
    let json_str = if let Some(start) = text.find('{') {
        if let Some(end) = text.rfind('}') {
            &text[start..=end]
        } else {
            text
        }
    } else {
        text
    };

    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(json_str) {
        let answer = parsed["answer"].as_str().unwrap_or(text).to_string();
        let confidence = parsed["confidence"].as_f64().unwrap_or(0.5);
        let needs_review = parsed["needs_review"].as_bool().unwrap_or(true);
        Some(DelegateResult { answer, confidence, needs_review })
    } else {
        // Fallback: treat entire text as answer with medium confidence
        Some(DelegateResult {
            answer: text.trim().to_string(),
            confidence: 0.4,
            needs_review: true,
        })
    }
}
