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
        llm_client::chat_completion_tracked(crate::engine::usage::UsageSource::BuddyDelegate, config, &messages, &[]),
    )
    .await
    .ok()?
    .ok()?;

    let text = response.message.content.as_ref()
        .and_then(|c| c.as_text())
        .unwrap_or("")
        .to_string();

    let result = parse_delegate_response(&text);

    // Log decision + increment counter
    if let Some(ref res) = result {
        if let Some(handle) = crate::engine::tools::APP_HANDLE.get() {
            use tauri::Manager;
            let state: tauri::State<'_, crate::state::AppState> = handle.state();

            // Log to buddy_decisions table
            let decision_id = uuid::Uuid::new_v4().to_string();
            let context_str = match context {
                DelegateContext::TaskDecision => "task_decision",
                DelegateContext::SkillReview => "skill_review",
            };
            state.inner().db.log_buddy_decision(
                &decision_id,
                question,
                context_str,
                &res.answer,
                res.confidence,
            );

            // Increment delegation counter (trust recalculation deferred to user feedback)
            if let Ok(mut cfg) = state.inner().config.try_write() {
                cfg.buddy.delegation_count += 1;
                let _ = cfg.save(&state.inner().working_dir);
            }
        }
    }

    result
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

// ── Task routing ─────────────────────────────────────────────────────

/// Execution route for a user request.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TaskRoute {
    /// Handle directly in main chat (simple/conversational).
    Direct,
    /// Spawn as background task (medium complexity coding).
    BackgroundTask,
    /// Delegate to external coding agent like Claude Code (complex multi-file coding).
    DelegateCoding,
}

/// Cached availability of external coding tools (checked once on first use).
static EXTERNAL_CODER_AVAILABLE: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();

/// Check if an external coding CLI (claude, codex) is available in PATH.
fn detect_external_coder() -> Option<String> {
    for cmd in &["claude", "codex"] {
        if std::process::Command::new(cmd)
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_or(false, |s| s.success())
        {
            log::info!("External coding tool detected: {}", cmd);
            return Some(cmd.to_string());
        }
    }
    log::info!("No external coding tool (claude/codex) found in PATH");
    None
}

/// Get the available external coding tool name, or None.
pub fn external_coder() -> Option<&'static String> {
    EXTERNAL_CODER_AVAILABLE.get_or_init(detect_external_coder).as_ref()
}

/// Heuristic signals extracted from user message for routing.
struct RouteSignals {
    mentions_coding: bool,
    mentions_new_project: bool,
    mentions_refactor: bool,
    mentions_review: bool,
    mentions_simple: bool,
    estimated_file_count: u8,
    message_length: usize,
}

/// Determine the execution route for a user message.
/// Uses fast heuristics (no LLM call) — suitable for hot path.
/// If no external coder is installed, DelegateCoding falls back to BackgroundTask.
pub fn route_task(message: &str) -> TaskRoute {
    let msg = message.to_lowercase();
    let signals = extract_route_signals(&msg);
    let has_external = external_coder().is_some();

    // Explicit delegation requests — only if tool available
    if msg.contains("用 claude code") || msg.contains("用 codex") || msg.contains("delegate") {
        return if has_external { TaskRoute::DelegateCoding } else { TaskRoute::BackgroundTask };
    }

    // Simple tasks — direct execution
    if signals.mentions_simple || signals.message_length < 50 {
        return TaskRoute::Direct;
    }

    // Complex coding — delegate if available, otherwise background
    if signals.mentions_new_project || (signals.mentions_refactor && signals.estimated_file_count > 3) {
        return if has_external { TaskRoute::DelegateCoding } else { TaskRoute::BackgroundTask };
    }

    // Medium coding — background task
    if signals.mentions_coding && (signals.estimated_file_count > 1 || signals.message_length > 300) {
        return TaskRoute::BackgroundTask;
    }

    // Review tasks — background
    if signals.mentions_review {
        return TaskRoute::BackgroundTask;
    }

    // Default: direct
    TaskRoute::Direct
}

fn extract_route_signals(msg: &str) -> RouteSignals {
    let coding_keywords = ["写代码", "实现", "开发", "编码", "重构", "修复bug", "添加功能",
        "implement", "build", "create", "develop", "refactor", "fix bug", "add feature",
        "写一个", "做一个", "搭建"];
    let new_project_keywords = ["新项目", "从零", "搭建", "new project", "bootstrap", "scaffold",
        "创建项目", "初始化项目"];
    let refactor_keywords = ["重构", "refactor", "重写", "rewrite", "迁移", "migrate"];
    let review_keywords = ["review", "审查", "检查代码", "code review", "PR review"];
    let simple_keywords = ["改一下", "修一下", "调整", "改个", "加个", "删掉", "换成",
        "fix typo", "rename", "update config"];

    let file_hints = msg.matches("文件").count()
        + msg.matches("file").count()
        + msg.matches(".ts").count()
        + msg.matches(".rs").count()
        + msg.matches(".tsx").count()
        + msg.matches(".py").count();

    RouteSignals {
        mentions_coding: coding_keywords.iter().any(|k| msg.contains(k)),
        mentions_new_project: new_project_keywords.iter().any(|k| msg.contains(k)),
        mentions_refactor: refactor_keywords.iter().any(|k| msg.contains(k)),
        mentions_review: review_keywords.iter().any(|k| msg.contains(k)),
        mentions_simple: simple_keywords.iter().any(|k| msg.contains(k)),
        estimated_file_count: file_hints.min(255) as u8,
        message_length: msg.len(),
    }
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
