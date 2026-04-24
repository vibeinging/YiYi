use super::{SignalType, GROWTH_LLM_SEMAPHORE};
use crate::engine::llm_client::{chat_completion_tracked, LLMConfig, LLMMessage, MessageContent};
use crate::engine::usage::UsageSource;

// ─────────────────────────────────────────────────────────────────────────
// Silent-completion reflection sampler (cost jury P0 #3)
//
// `reflect_on_task` used to fire on EVERY user message that triggered any
// tool call. Thomas's audit: for an active user (20 tool-turns/day) that's
// ~1.2M tokens/month of reflection alone — potentially the biggest single
// sink in the whole system.
//
// Strategy: keep the rare high-signal triggers (correction / praise /
// agent-error) as immediate, but the common SilentCompletion / ToolError /
// MaxIterations path — which fires 95% of the time — only actually runs
// the LLM call every Nth invocation per session. Skipped turns still get
// a lightweight non-LLM record written to the reflections table so we
// don't lose the fact that work happened.
// ─────────────────────────────────────────────────────────────────────────

use std::collections::HashMap;
use std::sync::Mutex;

/// How often (per session) the silent-completion path calls the LLM.
/// 1 = never sample (always reflect), ∞ = never reflect.
pub const SILENT_REFLECT_SAMPLE_EVERY: u32 = 5;

static SILENT_COUNTERS: std::sync::OnceLock<Mutex<HashMap<String, u32>>> =
    std::sync::OnceLock::new();

fn silent_counters() -> &'static Mutex<HashMap<String, u32>> {
    SILENT_COUNTERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Returns true if this silent-completion turn should actually run the
/// LLM reflection (vs. be sampled out). Increments a per-session counter.
pub fn should_reflect_silent(session_id: &str) -> bool {
    let mut map = silent_counters().lock().unwrap_or_else(|e| e.into_inner());
    let counter = map.entry(session_id.to_string()).or_insert(0);
    *counter += 1;
    let fire = *counter % SILENT_REFLECT_SAMPLE_EVERY == 1;
    // Cap per-session counter growth — hash map could grow unbounded across
    // long-lived processes with many short sessions. Reset once we've seen
    // enough turns that the sampling is stable.
    if *counter > 10_000 {
        *counter = 0;
    }
    fire
}

#[cfg(test)]
pub fn reset_silent_counter_for_test(session_id: &str) {
    let mut map = silent_counters().lock().unwrap_or_else(|e| e.into_inner());
    map.remove(session_id);
}

/// Shared capability category keywords used by both reflect_on_task and build_capability_profile.
const CAPABILITY_CATEGORIES: &[(&str, &[&str])] = &[
    ("coding", &["代码", "编程", "code", "programming", "编写", "函数", "bug", "refactor", "实现", "feature"]),
    ("documents", &["文档", "报告", "文件", "document", "report", "writing", "docx", "pdf", "pptx"]),
    ("data_analysis", &["数据", "分析", "统计", "data", "analysis", "csv", "excel", "表格"]),
    ("web_automation", &["浏览器", "网页", "browser", "web", "scrape", "自动化"]),
    ("system_ops", &["shell", "命令", "安装", "部署", "deploy", "系统", "terminal", "服务器"]),
    ("scheduling", &["定时", "提醒", "cron", "schedule", "reminder", "任务"]),
];

/// Strip markdown code fences (```json ... ```) from LLM responses.
fn strip_code_fence(s: &str) -> &str {
    let trimmed = s.trim();
    if trimmed.starts_with("```") {
        trimmed
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim()
    } else {
        trimmed
    }
}

// ---------------------------------------------------------------------------
// Memory extraction: delegated to MemMe's meditation pipeline (runs nightly).
// Short-term memory lives in the last 50 messages in the prompt.
// Long-term facts get extracted during `store.meditate()`.
// Removed: extract_memories_from_conversation (was duplicating MemMe's work).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Growth System — Post-task reflection
// ---------------------------------------------------------------------------

/// Reflect on a completed task: assess outcome, extract lessons, identify skill opportunities.
/// Runs in the background after task completion. Stores results in reflections table.
pub async fn reflect_on_task(
    config: &LLMConfig,
    task_id: Option<&str>,
    session_id: Option<&str>,
    task_description: &str,
    result_text: &str,
    was_successful: bool,
    signal_type: SignalType,
) {
    use crate::engine::tools::get_database;

    // Rate limit: max 3 concurrent background LLM calls
    let _permit = match GROWTH_LLM_SEMAPHORE.try_acquire() {
        Ok(p) => p,
        Err(_) => {
            log::debug!("Growth reflection skipped: too many concurrent LLM calls");
            return;
        }
    };

    let db = match get_database() {
        Some(db) => db,
        None => return,
    };

    // Skip trivial tasks
    if task_description.len() < 10 && result_text.len() < 30 {
        return;
    }

    let desc_preview: String = task_description.chars().take(1500).collect();
    let result_preview: String = result_text.chars().take(1500).collect();
    let outcome_hint = if was_successful { "success" } else { "failure" };
    let signal_hint = signal_type.as_str();

    let reflection_prompt = format!(
        r#"You are reflecting on a completed task. Analyze what happened and extract lessons.

Task: {desc_preview}
Outcome: {outcome_hint}
Signal: {signal_hint}
Result: {result_preview}

Respond ONLY with a JSON object:
{{
  "outcome": "success" | "partial" | "failure",
  "summary": "one-sentence summary of what happened",
  "lesson": "generalizable lesson for future tasks (or null if none)",
  "skill_opportunity": null or {{
    "type": "skill" | "code" | "workflow",
    "name": "suggested short name",
    "description": "what it does and why it's reusable",
    "reason": "why this should be persisted"
  }}
}}

skill_opportunity guidelines:
- "skill": reusable domain knowledge/instructions (e.g. writing patterns, platform guides)
- "code": a script or tool the user might run again (e.g. data processor, automation script)
- "workflow": a multi-step process worth remembering (e.g. deploy flow, review checklist)
- Only suggest if the work has genuine reuse value. Most simple Q&A has none.
- Threshold: would the user benefit from having this ready-made next time? If yes, suggest it.

JSON only:"#
    );

    let messages = vec![LLMMessage {
        role: "user".into(),
        content: Some(MessageContent::text(reflection_prompt)),
        tool_calls: None,
        tool_call_id: None,
    }];

    let result = match chat_completion_tracked(UsageSource::Growth, config, &messages, &[]).await {
        Ok(resp) => resp.message.content.map(|c| c.into_text()).unwrap_or_default(),
        Err(e) => {
            log::warn!("Reflection LLM call failed: {}", e);
            // Still save a basic reflection without LLM analysis
            db.add_reflection(
                task_id, session_id, outcome_hint,
                &format!("Task completed ({outcome_hint}), LLM reflection unavailable"),
                None, None,
                signal_type.as_str(), signal_type.base_confidence(),
            ).ok();
            return;
        }
    };

    let json_str = strip_code_fence(&result);

    #[derive(serde::Deserialize)]
    struct SkillOpportunity {
        #[serde(rename = "type")]
        opp_type: String,
        name: String,
        description: String,
        reason: Option<String>,
    }

    #[derive(serde::Deserialize)]
    struct ReflectionResult {
        outcome: Option<String>,
        summary: Option<String>,
        lesson: Option<String>,
        skill_opportunity: Option<SkillOpportunity>,
    }

    let parsed: ReflectionResult = match serde_json::from_str(json_str) {
        Ok(r) => r,
        Err(e) => {
            log::debug!("Reflection parse error: {} (response: {})", e, &result[..result.len().min(200)]);
            db.add_reflection(
                task_id, session_id, outcome_hint,
                &format!("Task {outcome_hint}"),
                None, None,
                signal_type.as_str(), signal_type.base_confidence(),
            ).ok();
            return;
        }
    };

    let outcome = parsed.outcome.as_deref().unwrap_or(outcome_hint);
    let summary = parsed.summary.as_deref().unwrap_or("(no summary)");

    // Serialize skill_opportunity as JSON for DB storage (preserves structure)
    let skill_opp_str = parsed.skill_opportunity.as_ref().map(|o| {
        serde_json::json!({
            "type": o.opp_type,
            "name": o.name,
            "description": o.description,
            "reason": o.reason,
        }).to_string()
    });

    // Save reflection
    if let Ok(ref_id) = db.add_reflection(
        task_id, session_id, outcome, summary,
        parsed.lesson.as_deref(),
        skill_opp_str.as_deref(),
        signal_type.as_str(), signal_type.base_confidence(),
    ) {
        log::info!("Reflection saved: {} (outcome: {}, signal: {})", ref_id, outcome, signal_type.as_str());
    }

    // "第一次" detection: detect capability category and emit event for first-time achievement
    if was_successful {
        let summary_lower = summary.to_lowercase();
        for (cat, keywords) in CAPABILITY_CATEGORIES {
            if keywords.iter().any(|kw| summary_lower.contains(kw)) {
                if let Some(handle) = crate::engine::tools::APP_HANDLE.get() {
                    use tauri::Emitter;
                    let _ = handle.emit("growth://new_capability", serde_json::json!({ "category": cat }));
                }
                break;
            }
        }
    }

    // Notify frontend immediately when a persist-worthy opportunity is detected
    if let Some(ref opp) = parsed.skill_opportunity {
        if let Some(handle) = crate::engine::tools::APP_HANDLE.get() {
            use tauri::Emitter;
            let payload = serde_json::json!({
                "type": opp.opp_type,
                "name": opp.name,
                "description": opp.description,
                "reason": opp.reason,
                "session_id": session_id,
                "task_id": task_id,
            });
            if let Err(e) = handle.emit("growth://persist_suggestion", &payload) {
                log::warn!("Failed to emit persist_suggestion event: {}", e);
            }
            log::info!(
                "Persist suggestion: [{}] {} — {}",
                opp.opp_type, opp.name, opp.description
            );
        }
    }

    // Only promote lessons from explicit signals — silence is not approval
    if signal_type != SignalType::SilentCompletion {
        if let Some(ref lesson) = parsed.lesson {
            if !lesson.is_empty() {
                if let Some(store) = crate::engine::tools::get_memme_store() {
                    let mut opts = crate::engine::tools::memory_tools::memme_add_opts("experience", 0.7);
                    if let Some(sid) = session_id {
                        opts = opts.session_id(sid.to_string());
                    }
                    let _ = store.add(lesson, opts);
                }
            }
        }
    }

    // Skill improvement: if skills were activated during this task, try to improve them
    let activated = crate::engine::tools::skill_tools::drain_recent_activations();
    if !activated.is_empty() && was_successful {
        for skill_name in activated {
            let cfg = config.clone();
            let desc = task_description.to_string();
            let res = result_text.to_string();
            tokio::spawn(async move {
                improve_skill_from_experience(&cfg, &skill_name, &desc, &res, true).await;
            });
        }
    }
}

// ---------------------------------------------------------------------------
// Skill Self-Improvement — refine skill instructions after successful use
// ---------------------------------------------------------------------------

/// Improve a skill's instructions based on task execution experience.
/// Reads the existing SKILL.md, asks LLM whether it can be improved, and
/// writes the updated content back to both `active_skills/` and `customized_skills/`.
pub async fn improve_skill_from_experience(
    config: &LLMConfig,
    skill_name: &str,
    task_description: &str,
    task_result: &str,
    was_successful: bool,
) {
    let _permit = match GROWTH_LLM_SEMAPHORE.try_acquire() {
        Ok(p) => p,
        Err(_) => {
            log::debug!("Skill improvement skipped ({}): too many concurrent LLM calls", skill_name);
            return;
        }
    };

    let working_dir = match crate::engine::tools::get_working_dir() {
        Some(wd) => wd,
        None => return,
    };

    let active_path = working_dir.join("active_skills").join(skill_name).join("SKILL.md");
    let current_content = match tokio::fs::read_to_string(&active_path).await {
        Ok(c) => c,
        Err(_) => {
            log::debug!("Skill improvement: SKILL.md not found for '{}'", skill_name);
            return;
        }
    };

    let content_preview: String = current_content.chars().take(3000).collect();
    let desc_preview: String = task_description.chars().take(1000).collect();
    let result_preview: String = task_result.chars().take(1000).collect();
    let outcome = if was_successful { "successful" } else { "failed" };

    let prompt = format!(
        r#"You are reviewing a skill's instructions after it was used to complete a task.
Analyze whether the instructions could be improved based on the execution experience.

Skill name: {skill_name}
Current SKILL.md content:
```
{content_preview}
```

Task description: {desc_preview}
Task outcome: {outcome}
Task result: {result_preview}

If the skill instructions are already good and no improvement is needed, respond with exactly: UNCHANGED

Otherwise, respond with the COMPLETE improved SKILL.md content (including YAML frontmatter if present).
Improvements might include:
- Adding edge cases or tips discovered during execution
- Clarifying ambiguous instructions
- Adding common pitfalls or error handling guidance
- Removing outdated or incorrect information
- Better organizing the instructions

Respond with either UNCHANGED or the complete improved SKILL.md:"#
    );

    let messages = vec![LLMMessage {
        role: "user".into(),
        content: Some(MessageContent::text(prompt)),
        tool_calls: None,
        tool_call_id: None,
    }];

    let result = match chat_completion_tracked(UsageSource::Growth, config, &messages, &[]).await {
        Ok(resp) => resp.message.content.map(|c| c.into_text()).unwrap_or_default(),
        Err(e) => {
            log::warn!("Skill improvement LLM call failed for '{}': {}", skill_name, e);
            return;
        }
    };

    let trimmed = result.trim();
    if trimmed == "UNCHANGED" || trimmed.is_empty() {
        log::debug!("Skill '{}': no improvement needed", skill_name);
        return;
    }

    // Strip markdown code fences if present
    let improved = strip_code_fence(trimmed);

    // Buddy review: let the user's digital twin approve the improvement
    let review_question = format!(
        "技能「{}」被提议改进。\n原版摘要：{}字\n改进版摘要：{}字\n这个改动是否合理？",
        skill_name,
        current_content.chars().count(),
        improved.chars().count(),
    );
    if let Some(approved) = crate::engine::buddy_delegate::delegate_yes_no(
        config, &review_question, crate::engine::buddy_delegate::DelegateContext::SkillReview,
    ).await {
        if !approved {
            log::info!("Buddy rejected skill improvement for '{}'", skill_name);
            return;
        }
    }
    // If buddy returns None (not confident), proceed anyway — improvement is low risk

    // Write back to active_skills and customized_skills
    let custom_path = working_dir.join("customized_skills").join(skill_name).join("SKILL.md");

    if let Err(e) = tokio::fs::write(&active_path, improved).await {
        log::warn!("Failed to write improved SKILL.md to active_skills for '{}': {}", skill_name, e);
        return;
    }

    // Ensure customized_skills directory exists and write there too
    if let Some(parent) = custom_path.parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }
    if let Err(e) = tokio::fs::write(&custom_path, improved).await {
        log::warn!("Failed to write improved SKILL.md to customized_skills for '{}': {}", skill_name, e);
    }

    log::info!("Skill '{}' improved based on task experience", skill_name);
}

// ---------------------------------------------------------------------------
// User Model — structured USER.md maintained over time
// ---------------------------------------------------------------------------

/// Update the persistent USER.md user profile based on conversation content.
/// Only runs every ~5 conversations to avoid excessive LLM calls.
pub async fn update_user_model(
    config: &LLMConfig,
    user_message: &str,
    assistant_reply: &str,
) {
    // Only run occasionally (1 in 5 conversations)
    use std::sync::atomic::{AtomicU32, Ordering};
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    if COUNTER.fetch_add(1, Ordering::Relaxed) % 5 != 0 {
        return;
    }

    let working_dir = match crate::engine::tools::get_working_dir() {
        Some(wd) => wd,
        None => return,
    };

    let _permit = match GROWTH_LLM_SEMAPHORE.try_acquire() {
        Ok(p) => p,
        Err(_) => {
            log::debug!("User model update skipped: too many concurrent LLM calls");
            return;
        }
    };

    let existing = crate::engine::mem::user_model::load_user_model(&working_dir);

    let existing_display = if existing.is_empty() {
        "(empty — first time)".to_string()
    } else {
        existing.clone()
    };

    let user_preview: String = user_message.chars().take(1000).collect();
    let assistant_preview: String = assistant_reply.chars().take(1000).collect();

    let prompt = format!(
        r#"You maintain a structured user profile in markdown format. Based on the latest conversation, update the profile.

Current profile:
{existing_display}

Latest conversation:
User: {user_preview}
Assistant: {assistant_preview}

Update the profile with any new information learned. Keep the following structure:
## Basic Info
(name, role, occupation if known)

## Work Style
(how they work, what tools they prefer, communication style)

## Preferences
(likes, dislikes, formatting preferences)

## Domain Knowledge
(what they know about, expertise areas)

## Current Projects
(what they're working on)

If nothing new to add, respond with exactly: UNCHANGED
Otherwise respond with the COMPLETE updated profile (not just the changes)."#
    );

    let messages = vec![LLMMessage {
        role: "user".into(),
        content: Some(MessageContent::text(prompt)),
        tool_calls: None,
        tool_call_id: None,
    }];

    let result = match chat_completion_tracked(UsageSource::Growth, config, &messages, &[]).await {
        Ok(resp) => resp.message.content.map(|c| c.into_text()).unwrap_or_default(),
        Err(e) => {
            log::warn!("User model update LLM call failed: {}", e);
            return;
        }
    };

    let trimmed = result.trim();
    if trimmed == "UNCHANGED" || trimmed.is_empty() {
        log::debug!("User model: no updates needed");
        return;
    }

    // Strip markdown code fences if present
    let updated = strip_code_fence(trimmed);

    if let Err(e) = crate::engine::mem::user_model::save_user_model(&working_dir, updated) {
        log::warn!("Failed to save USER.md: {}", e);
    } else {
        log::info!("USER.md user model updated");
    }
}

/// Analyze user feedback and generate behavioral corrections.
/// Called when user provides negative feedback (thumbs down, "redo", corrections).
pub async fn learn_from_feedback(
    config: &LLMConfig,
    user_feedback: &str,
    original_request: &str,
    agent_response: &str,
) {
    use crate::engine::tools::get_database;

    // Rate limit: max 3 concurrent background LLM calls
    let _permit = match GROWTH_LLM_SEMAPHORE.try_acquire() {
        Ok(p) => p,
        Err(_) => {
            log::debug!("Feedback learning skipped: too many concurrent LLM calls");
            return;
        }
    };

    let db = match get_database() {
        Some(db) => db,
        None => return,
    };

    if user_feedback.len() < 5 {
        return;
    }

    let feedback_preview: String = user_feedback.chars().take(1000).collect();
    let request_preview: String = original_request.chars().take(800).collect();
    let response_preview: String = agent_response.chars().take(800).collect();

    let correction_prompt = format!(
        r#"The user gave negative feedback about an AI assistant's response. Analyze and create a behavioral correction rule.

User's original request: {request_preview}
AI's response (that the user didn't like): {response_preview}
User's feedback: {feedback_preview}

Create a correction rule. Respond ONLY with a JSON object:
{{
  "trigger": "when the user asks/does X...",
  "wrong_behavior": "I previously did Y...",
  "correct_behavior": "I should do Z instead..."
}}

JSON only:"#
    );

    let messages = vec![LLMMessage {
        role: "user".into(),
        content: Some(MessageContent::text(correction_prompt)),
        tool_calls: None,
        tool_call_id: None,
    }];

    let result = match chat_completion_tracked(UsageSource::Growth, config, &messages, &[]).await {
        Ok(resp) => resp.message.content.map(|c| c.into_text()).unwrap_or_default(),
        Err(e) => {
            log::warn!("Feedback learning LLM call failed: {}", e);
            return;
        }
    };

    let json_str = strip_code_fence(&result);

    #[derive(serde::Deserialize)]
    struct CorrectionResult {
        trigger: String,
        wrong_behavior: Option<String>,
        correct_behavior: String,
    }

    let parsed: CorrectionResult = match serde_json::from_str(json_str) {
        Ok(r) => r,
        Err(e) => {
            log::debug!("Correction parse error: {}", e);
            return;
        }
    };

    match db.add_correction(
        &parsed.trigger,
        parsed.wrong_behavior.as_deref(),
        &parsed.correct_behavior,
        Some("user_feedback"),
        0.90,
    ) {
        Ok(id) => {
            log::info!("Correction rule saved: {}", id);
            // Auto-consolidate when corrections accumulate (every 5 new corrections)
            let count = db.count_active_corrections();
            if count >= 3 && count % 5 == 0 {
                if let Some(working_dir) = crate::engine::tools::get_working_dir() {
                    let cfg = config.clone();
                    let wd = working_dir.clone();
                    tokio::spawn(async move {
                        match consolidate_corrections_to_principles(&cfg, &crate::engine::tools::get_database().unwrap(), &wd).await {
                            Ok(msg) => log::info!("Auto-consolidation: {}", msg),
                            Err(e) => log::warn!("Auto-consolidation failed: {}", e),
                        }
                    });
                }
            }
        }
        Err(e) => log::warn!("Failed to save correction: {}", e),
    }
}

// ---------------------------------------------------------------------------
// Growth System — Growth Report & Skill Genesis
// ---------------------------------------------------------------------------

/// Growth report data structure.
#[derive(Debug, Clone, serde::Serialize)]
pub struct GrowthReport {
    pub total_tasks: usize,
    pub success_count: usize,
    pub failure_count: usize,
    pub partial_count: usize,
    pub success_rate: f64,
    pub top_lessons: Vec<String>,
}

/// Generate a growth report from recent reflections.
/// Returns a summary of success rate, failure patterns, and recommended actions.
pub fn generate_growth_report(db: &crate::engine::db::Database) -> Option<GrowthReport> {
    let reflections = db.get_recent_reflections(50);
    if reflections.is_empty() {
        return None;
    }

    let total = reflections.len();
    let successes = reflections.iter().filter(|(o, _, _)| o == "success").count();
    let failures = reflections.iter().filter(|(o, _, _)| o == "failure").count();
    let partials = total - successes - failures;

    // Collect lessons
    let lessons: Vec<&str> = reflections
        .iter()
        .filter_map(|(_, _, l)| l.as_deref())
        .filter(|l| !l.is_empty())
        .collect();

    // Skill opportunities are handled separately by detect_skill_opportunity()

    Some(GrowthReport {
        total_tasks: total,
        success_count: successes,
        failure_count: failures,
        partial_count: partials,
        success_rate: successes as f64 / total as f64,
        top_lessons: lessons.into_iter().take(5).map(String::from).collect(),
    })
}

/// Check if there are recurring skill opportunities in reflections.
/// Returns a suggestion message if a pattern is detected (3+ similar opportunities).
pub fn detect_skill_opportunity(db: &crate::engine::db::Database) -> Option<String> {
    let conn = match db.get_conn() {
        Some(c) => c,
        None => return None,
    };

    // Query skill_opportunity from reflections where it's not null
    let mut stmt = conn
        .prepare(
            "SELECT skill_opportunity FROM reflections
             WHERE skill_opportunity IS NOT NULL AND skill_opportunity != ''
             ORDER BY created_at DESC LIMIT 20",
        )
        .ok()?;

    let opportunities: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .ok()?
        .filter_map(|r| r.ok())
        .collect();

    if opportunities.len() < 3 {
        return None;
    }

    // Simple frequency detection: if 3+ opportunities mention similar words
    // (this is a heuristic; a more sophisticated version would use embeddings)
    let first = &opportunities[0];
    let similar_count = opportunities
        .iter()
        .skip(1)
        .filter(|o| {
            // Check if they share at least 2 significant words
            let words_a: std::collections::HashSet<&str> = first.split_whitespace()
                .filter(|w| w.len() > 3)
                .collect();
            let words_b: std::collections::HashSet<&str> = o.split_whitespace()
                .filter(|w| w.len() > 3)
                .collect();
            words_a.intersection(&words_b).count() >= 2
        })
        .count();

    if similar_count >= 2 {
        Some(format!(
            "I've noticed a recurring pattern in your tasks: \"{}\". Would you like me to create a reusable skill for this?",
            first
        ))
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Growth System — Capability Profile
// ---------------------------------------------------------------------------

/// A single capability dimension with success metrics.
#[derive(Debug, Clone, serde::Serialize)]
pub struct CapabilityDimension {
    pub name: String,
    pub success_rate: f64,
    pub sample_count: usize,
    pub confidence: String, // "low" (<5), "medium" (5-15), "high" (>15)
}

/// Build a capability profile from reflection summaries.
/// Groups reflections by detected task category and computes success rates.
pub fn build_capability_profile(db: &crate::engine::db::Database) -> Vec<CapabilityDimension> {
    let conn = match db.get_conn() {
        Some(c) => c,
        None => return Vec::new(),
    };

    // Get all reflections with outcome and summary
    let mut stmt = match conn.prepare(
        "SELECT outcome, summary FROM reflections ORDER BY created_at DESC LIMIT 200",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let rows: Vec<(String, String)> = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .ok()
        .map(|r| r.flatten().collect())
        .unwrap_or_default();

    if rows.is_empty() {
        return Vec::new();
    }

    let mut category_stats: std::collections::HashMap<&str, (usize, usize)> = std::collections::HashMap::new();

    for (outcome, summary) in &rows {
        let summary_lower = summary.to_lowercase();
        let is_success = outcome == "success";

        let mut matched = false;
        for (cat_name, keywords) in CAPABILITY_CATEGORIES {
            if keywords.iter().any(|kw| summary_lower.contains(kw)) {
                let entry = category_stats.entry(cat_name).or_insert((0, 0));
                entry.0 += 1; // total
                if is_success {
                    entry.1 += 1; // successes
                }
                matched = true;
                break;
            }
        }
        if !matched {
            let entry = category_stats.entry("other").or_insert((0, 0));
            entry.0 += 1;
            if is_success {
                entry.1 += 1;
            }
        }
    }

    let display_names: std::collections::HashMap<&str, &str> = [
        ("coding", "Coding"),
        ("documents", "Documents"),
        ("data_analysis", "Data Analysis"),
        ("web_automation", "Web Automation"),
        ("system_ops", "System Ops"),
        ("scheduling", "Scheduling"),
        ("other", "Other"),
    ].into_iter().collect();

    let mut profile: Vec<CapabilityDimension> = category_stats
        .iter()
        .map(|(name, (total, successes))| {
            let confidence = if *total < 5 {
                "low"
            } else if *total < 15 {
                "medium"
            } else {
                "high"
            };
            CapabilityDimension {
                name: display_names.get(name).unwrap_or(name).to_string(),
                success_rate: if *total > 0 { *successes as f64 / *total as f64 } else { 0.0 },
                sample_count: *total,
                confidence: confidence.to_string(),
            }
        })
        .collect();

    profile.sort_by(|a, b| b.sample_count.cmp(&a.sample_count));
    profile
}

// ---------------------------------------------------------------------------
// Growth System — Morning Reflection (Proactive Greeting)
// ---------------------------------------------------------------------------

/// Generate a proactive morning greeting with actionable suggestions.
/// Called on first user interaction of the day.
pub async fn generate_morning_reflection(
    config: &LLMConfig,
    db: &crate::engine::db::Database,
) -> Option<String> {
    // Check if we already did morning reflection today
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    if let Some(conn) = db.get_conn() {
        let already_done: bool = conn
            .prepare("SELECT 1 FROM reflections WHERE task_id = ?1 LIMIT 1")
            .and_then(|mut stmt| stmt.exists(rusqlite::params![format!("morning:{}", today)]))
            .unwrap_or(false);
        if already_done {
            return None;
        }
    }

    // Gather context
    let report = generate_growth_report(db);
    let corrections = db.get_active_corrections(3);
    let profile = build_capability_profile(db);

    // Build a context summary for LLM
    let report_summary = match &report {
        Some(r) => format!(
            "Recent performance: {} tasks, {:.0}% success rate. Top lessons: {}",
            r.total_tasks,
            r.success_rate * 100.0,
            if r.top_lessons.is_empty() { "none yet".into() } else { r.top_lessons.join("; ") }
        ),
        None => "Not enough task history yet.".into(),
    };

    let corrections_summary = if corrections.is_empty() {
        "No behavioral corrections recorded.".into()
    } else {
        corrections.iter()
            .map(|(t, b, _)| format!("{}: {}", t, b))
            .collect::<Vec<_>>()
            .join("; ")
    };

    let profile_summary = if profile.is_empty() {
        "No capability data yet.".into()
    } else {
        profile.iter()
            .take(4)
            .map(|d| format!("{}: {:.0}% ({} tasks)", d.name, d.success_rate * 100.0, d.sample_count))
            .collect::<Vec<_>>()
            .join(", ")
    };

    let prompt_text = format!(
        r#"You are YiYi, an AI companion starting a new day with your user. Generate a brief, warm morning greeting (2-4 sentences) with 1-2 proactive suggestions based on this context:

Growth data: {report_summary}
Learned corrections: {corrections_summary}
Capability profile: {profile_summary}

Guidelines:
- Be warm but concise, like a thoughtful friend
- If you have growth data, mention one insight naturally
- Suggest 1-2 actionable things (not generic)
- If no data yet, just be welcoming and offer help
- Respond in the user's likely language (Chinese if context suggests it)

Morning greeting:"#
    );

    let messages = vec![LLMMessage {
        role: "user".into(),
        content: Some(MessageContent::text(prompt_text)),
        tool_calls: None,
        tool_call_id: None,
    }];

    let greeting = match chat_completion_tracked(UsageSource::Growth, config, &messages, &[]).await {
        Ok(resp) => resp.message.content.map(|c| c.into_text()),
        Err(e) => {
            log::warn!("Morning reflection LLM call failed: {}", e);
            None
        }
    }?;

    // Mark as done for today
    db.add_reflection(
        Some(&format!("morning:{}", today)),
        None,
        "success",
        &format!("Morning reflection: {}", &greeting.chars().take(100).collect::<String>()),
        None,
        None,
        "silent_completion",
        0.50,
    ).ok();

    Some(greeting)
}

/// Growth milestone events for the timeline.
#[derive(Debug, Clone, serde::Serialize)]
pub struct GrowthMilestone {
    pub date: String,
    pub event_type: String, // "first_task", "skill_created", "lesson_learned", "correction", "capability_up"
    pub title: String,
    pub description: String,
}

/// Build a growth timeline from stored data.
pub fn build_growth_timeline(db: &crate::engine::db::Database, limit: usize) -> Vec<GrowthMilestone> {
    let conn = match db.get_conn() {
        Some(c) => c,
        None => return Vec::new(),
    };

    let mut milestones = Vec::new();

    // Reflections with lessons → "lesson_learned" milestones
    if let Ok(mut stmt) = conn.prepare(
        "SELECT created_at, summary, lesson FROM reflections
         WHERE lesson IS NOT NULL AND lesson != ''
         ORDER BY created_at DESC LIMIT ?1",
    ) {
        if let Ok(rows) = stmt.query_map(rusqlite::params![limit as i64], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        }) {
            for row in rows.flatten() {
                let date = chrono::DateTime::from_timestamp(row.0, 0)
                    .map(|dt| dt.format("%Y-%m-%d").to_string())
                    .unwrap_or_default();
                milestones.push(GrowthMilestone {
                    date,
                    event_type: "lesson_learned".into(),
                    title: "Learned from experience".into(),
                    description: row.2,
                });
            }
        }
    }

    // Corrections → "correction" milestones
    if let Ok(mut stmt) = conn.prepare(
        "SELECT created_at, trigger_pattern, correct_behavior FROM corrections
         ORDER BY created_at DESC LIMIT ?1",
    ) {
        if let Ok(rows) = stmt.query_map(rusqlite::params![limit as i64], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        }) {
            for row in rows.flatten() {
                let date = chrono::DateTime::from_timestamp(row.0, 0)
                    .map(|dt| dt.format("%Y-%m-%d").to_string())
                    .unwrap_or_default();
                milestones.push(GrowthMilestone {
                    date,
                    event_type: "correction".into(),
                    title: format!("Behavioral adjustment: {}", row.1),
                    description: row.2,
                });
            }
        }
    }

    // Sort by date descending
    milestones.sort_by(|a, b| b.date.cmp(&a.date));
    milestones.truncate(limit);
    milestones
}

// ---------------------------------------------------------------------------
// Growth System — Principles Consolidation
// ---------------------------------------------------------------------------

/// Consolidate active corrections into PRINCIPLES.md.
/// Called periodically (e.g. when correction count exceeds threshold).
/// Uses LLM to merge, deduplicate, and resolve conflicts between raw corrections.
pub async fn consolidate_corrections_to_principles(
    config: &LLMConfig,
    db: &crate::engine::db::Database,
    working_dir: &std::path::Path,
) -> Result<String, String> {
    let _permit = match GROWTH_LLM_SEMAPHORE.try_acquire() {
        Ok(p) => p,
        Err(_) => return Err("Too many concurrent growth LLM calls".into()),
    };

    let all_corrections_raw = db.get_all_active_corrections();
    if all_corrections_raw.is_empty() {
        return Ok("No active corrections to consolidate.".into());
    }

    // Filter out low-confidence corrections before sending to LLM
    let all_corrections: Vec<_> = all_corrections_raw
        .iter()
        .filter(|(_, _, _, confidence)| *confidence >= 0.50)
        .collect();
    if all_corrections.is_empty() {
        return Ok("No high-confidence corrections to consolidate.".into());
    }

    // Load existing principles for context
    let existing_principles = crate::engine::mem::memory::read_principles_md(working_dir);

    // Build correction list for LLM (include confidence info)
    let mut corrections_text = String::new();
    for (i, (trigger, behavior, _, confidence)) in all_corrections.iter().enumerate() {
        corrections_text.push_str(&format!(
            "{}. [confidence: {:.2}] When {}: {}\n",
            i + 1, confidence, trigger, behavior
        ));
    }

    let prompt_text = format!(
        r#"You are consolidating behavioral correction rules into a concise set of principles.

Raw correction rules ({count} total):
{corrections}
{existing_context}
Each correction has a confidence score. Higher confidence corrections should take priority.

Task: Merge these into a concise list of behavioral principles (max 10 items).
- Combine similar/overlapping rules
- Resolve contradictions: later rules (higher number) override earlier ones — the user's most recent feedback is the truth
- Higher confidence corrections take priority over lower confidence ones
- Write each principle as a short, actionable statement
- Remove redundant or trivial rules
- Drop rules that are clearly outdated or superseded by newer ones
- Keep the language matching the original rules (Chinese or English)

Respond with ONLY the consolidated principles, one per line, prefixed with "- ".
Example:
- Always confirm before git push
- Prefer edit_file over write_file for existing files
- Keep responses concise unless user asks for detail

Consolidated principles:"#,
        count = all_corrections.len(),
        corrections = corrections_text,
        existing_context = if existing_principles.is_empty() {
            String::new()
        } else {
            format!("\nExisting principles (update/extend these):\n{}\n", existing_principles)
        },
    );

    let messages = vec![LLMMessage {
        role: "user".into(),
        content: Some(MessageContent::text(prompt_text)),
        tool_calls: None,
        tool_call_id: None,
    }];

    let result = match chat_completion_tracked(UsageSource::Growth, config, &messages, &[]).await {
        Ok(resp) => resp.message.content.map(|c| c.into_text()).unwrap_or_default(),
        Err(e) => return Err(format!("LLM consolidation failed: {}", e)),
    };

    // Extract only lines starting with "- " or "* ", strip the prefix
    let principles: Vec<String> = result
        .lines()
        .map(|l| l.trim())
        .filter(|l| l.starts_with("- ") || l.starts_with("* "))
        .map(|l| l.trim_start_matches("- ").trim_start_matches("* ").trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    if principles.is_empty() {
        return Err("LLM returned no valid principles".into());
    }

    // Save each principle as a high-importance memory in MemMe
    let mut saved = 0;
    if let Some(store) = crate::engine::tools::get_memme_store() {
        // Demote old principles before adding new consolidated ones
        if let Ok(existing) = store.list_traces(
            memme_core::ListOptions::new(crate::engine::tools::MEMME_USER_ID).limit(200),
        ) {
            for old in &existing {
                let cats = old.categories.as_ref().map(|c| c.join(",")).unwrap_or_default();
                if cats.contains("principle") && old.importance.unwrap_or(0.0) >= 0.7 {
                    let _ = store.update_importance(&old.id, 0.4); // demote to warm
                }
            }
        }

        for principle in &principles {
            let opts = crate::engine::tools::memory_tools::memme_add_opts("principle", 0.9);
            if store.add(principle, opts).is_ok() {
                saved += 1;
            }
        }
    }

    if saved == 0 {
        return Err("Failed to save principles to MemMe (store unavailable or all adds failed)".into());
    }

    // Sync HOT-tier to files (updates PRINCIPLES.md and MEMORY.md cache)
    if let Err(e) = crate::engine::mem::tiered_memory::sync_hot_to_files(working_dir) {
        log::warn!("Failed to sync hot-tier to files: {}", e);
    }

    // Only deactivate corrections after principles are successfully saved
    if let Some(conn) = db.get_conn() {
        conn.execute(
            "UPDATE corrections SET active = 0 WHERE active = 1",
            [],
        ).ok();
    }

    log::info!(
        "Consolidated {} corrections into {} principle memories (HOT tier)",
        all_corrections.len(),
        saved
    );

    Ok(format!(
        "Consolidated {} corrections into {} principles.",
        all_corrections.len(),
        saved
    ))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::db::Database;
    use serial_test::serial;
    use tempfile::TempDir;

    fn mk_db() -> (TempDir, Database) {
        let dir = TempDir::new().expect("tempdir");
        let db = Database::open(dir.path()).expect("open db");
        (dir, db)
    }

    // ── strip_code_fence ──────────────────────────────────────────

    #[test]
    fn strip_code_fence_removes_json_fenced_block() {
        let input = "```json\n{\"a\": 1}\n```";
        assert_eq!(strip_code_fence(input), "{\"a\": 1}");
    }

    #[test]
    fn strip_code_fence_removes_plain_fence() {
        let input = "```\nsome text\n```";
        assert_eq!(strip_code_fence(input), "some text");
    }

    #[test]
    fn strip_code_fence_returns_input_when_no_fence() {
        let input = "{\"a\": 1}";
        assert_eq!(strip_code_fence(input), "{\"a\": 1}");
    }

    #[test]
    fn strip_code_fence_trims_leading_whitespace() {
        let input = "   \n   hello";
        assert_eq!(strip_code_fence(input), "hello");
    }

    // ── SignalType::base_confidence ───────────────────────────────

    #[test]
    fn signal_type_base_confidence_matches_documented_values() {
        assert!((SignalType::ExplicitCorrection.base_confidence() - 0.90).abs() < 1e-9);
        assert!((SignalType::ExplicitPraise.base_confidence() - 0.85).abs() < 1e-9);
        assert!((SignalType::ToolError.base_confidence() - 0.70).abs() < 1e-9);
        assert!((SignalType::MaxIterations.base_confidence() - 0.65).abs() < 1e-9);
        assert!((SignalType::AgentError.base_confidence() - 0.70).abs() < 1e-9);
        assert!((SignalType::SilentCompletion.base_confidence() - 0.35).abs() < 1e-9);
    }

    #[test]
    fn signal_type_confidence_ordering_reflects_signal_strength() {
        // Explicit feedback is more confident than silent completion.
        assert!(
            SignalType::ExplicitCorrection.base_confidence()
                > SignalType::SilentCompletion.base_confidence()
        );
        assert!(
            SignalType::ExplicitPraise.base_confidence()
                > SignalType::SilentCompletion.base_confidence()
        );
    }

    // ── SignalType::as_str ────────────────────────────────────────

    #[test]
    fn signal_type_as_str_stringifies_each_variant() {
        assert_eq!(SignalType::ExplicitCorrection.as_str(), "explicit_correction");
        assert_eq!(SignalType::ExplicitPraise.as_str(), "explicit_praise");
        assert_eq!(SignalType::ToolError.as_str(), "tool_error");
        assert_eq!(SignalType::MaxIterations.as_str(), "max_iterations");
        assert_eq!(SignalType::AgentError.as_str(), "agent_error");
        assert_eq!(SignalType::SilentCompletion.as_str(), "silent_completion");
    }

    // ── generate_growth_report ────────────────────────────────────

    #[test]
    #[serial]
    fn generate_growth_report_returns_none_for_empty_reflections() {
        let (_d, db) = mk_db();
        assert!(generate_growth_report(&db).is_none());
    }

    #[test]
    #[serial]
    fn generate_growth_report_aggregates_reflections_by_outcome() {
        let (_d, db) = mk_db();
        // 3 successes, 1 failure, 1 partial.
        db.add_reflection(None, None, "success", "did thing", Some("lesson-A"), None, "explicit_praise", 0.85).unwrap();
        db.add_reflection(None, None, "success", "did thing 2", Some("lesson-B"), None, "explicit_praise", 0.85).unwrap();
        db.add_reflection(None, None, "success", "did thing 3", None, None, "silent_completion", 0.35).unwrap();
        db.add_reflection(None, None, "failure", "bad", None, None, "tool_error", 0.70).unwrap();
        db.add_reflection(None, None, "partial", "meh", None, None, "silent_completion", 0.35).unwrap();

        let report = generate_growth_report(&db).expect("report present");
        assert_eq!(report.total_tasks, 5);
        assert_eq!(report.success_count, 3);
        assert_eq!(report.failure_count, 1);
        assert_eq!(report.partial_count, 1);
        assert!((report.success_rate - 0.6).abs() < 1e-9);
        assert!(report.top_lessons.iter().any(|l| l.contains("lesson")));
        assert!(report.top_lessons.len() <= 5);
    }

    // ── detect_skill_opportunity ──────────────────────────────────

    #[test]
    #[serial]
    fn detect_skill_opportunity_returns_none_with_few_opportunities() {
        let (_d, db) = mk_db();
        db.add_reflection(
            None, None, "success", "s", None, Some("build weekly data pipeline"),
            "explicit_praise", 0.85,
        ).unwrap();
        // Fewer than 3 opportunities => None.
        assert!(detect_skill_opportunity(&db).is_none());
    }

    #[test]
    #[serial]
    fn detect_skill_opportunity_flags_recurring_similar_patterns() {
        let (_d, db) = mk_db();
        // 3 opportunities that all share the words "build", "weekly", "pipeline" (>3 chars each).
        for _ in 0..3 {
            db.add_reflection(
                None, None, "success", "s", None,
                Some("build weekly pipeline reporting"),
                "explicit_praise", 0.85,
            ).unwrap();
        }
        let suggestion = detect_skill_opportunity(&db);
        assert!(suggestion.is_some(), "expected suggestion when 3 similar opportunities exist");
        let text = suggestion.unwrap();
        assert!(text.contains("recurring pattern"));
    }

    // ── build_capability_profile ──────────────────────────────────

    #[test]
    #[serial]
    fn build_capability_profile_returns_empty_for_no_data() {
        let (_d, db) = mk_db();
        assert!(build_capability_profile(&db).is_empty());
    }

    #[test]
    #[serial]
    fn build_capability_profile_categorizes_summaries_by_keyword() {
        let (_d, db) = mk_db();
        // 3 coding tasks (successes) and 2 document tasks (1 success, 1 failure).
        db.add_reflection(None, None, "success", "wrote code for bug fix", None, None, "explicit_praise", 0.85).unwrap();
        db.add_reflection(None, None, "success", "refactor programming module", None, None, "explicit_praise", 0.85).unwrap();
        db.add_reflection(None, None, "success", "implement feature", None, None, "explicit_praise", 0.85).unwrap();
        db.add_reflection(None, None, "success", "wrote a report", None, None, "explicit_praise", 0.85).unwrap();
        db.add_reflection(None, None, "failure", "document draft failed", None, None, "tool_error", 0.70).unwrap();

        let profile = build_capability_profile(&db);
        assert!(!profile.is_empty());
        // Sorted by sample_count desc.
        for w in profile.windows(2) {
            assert!(w[0].sample_count >= w[1].sample_count);
        }
        let coding = profile.iter().find(|d| d.name == "Coding");
        assert!(coding.is_some(), "coding bucket missing: {:?}", profile);
        let coding = coding.unwrap();
        assert_eq!(coding.sample_count, 3);
        assert!((coding.success_rate - 1.0).abs() < 1e-9);
        // 3 samples => "low" confidence (< 5).
        assert_eq!(coding.confidence, "low");
    }

    #[test]
    #[serial]
    fn build_capability_profile_marks_high_confidence_for_large_buckets() {
        let (_d, db) = mk_db();
        // 16 coding reflections => high confidence.
        for i in 0..16 {
            let outcome = if i % 4 == 0 { "failure" } else { "success" };
            db.add_reflection(
                None, None, outcome, "code refactor done", None, None,
                "explicit_praise", 0.85,
            ).unwrap();
        }
        let profile = build_capability_profile(&db);
        let coding = profile.iter().find(|d| d.name == "Coding").expect("coding bucket");
        assert_eq!(coding.confidence, "high");
        assert_eq!(coding.sample_count, 16);
    }

    // ── build_growth_timeline ─────────────────────────────────────

    #[test]
    #[serial]
    fn build_growth_timeline_returns_empty_for_no_data() {
        let (_d, db) = mk_db();
        let timeline = build_growth_timeline(&db, 10);
        assert!(timeline.is_empty());
    }

    #[test]
    #[serial]
    fn build_growth_timeline_emits_lesson_and_correction_milestones() {
        let (_d, db) = mk_db();
        db.add_reflection(
            None, None, "success", "did work",
            Some("key takeaway from this task"),
            None, "explicit_praise", 0.85,
        ).unwrap();
        db.add_correction(
            "when user asks X",
            Some("I did Y"),
            "do Z instead",
            Some("user_feedback"),
            0.9,
        ).unwrap();
        let timeline = build_growth_timeline(&db, 10);
        assert_eq!(timeline.len(), 2);
        assert!(timeline.iter().any(|m| m.event_type == "lesson_learned"));
        assert!(timeline.iter().any(|m| m.event_type == "correction"));
    }

    #[test]
    #[serial]
    fn build_growth_timeline_respects_limit() {
        let (_d, db) = mk_db();
        for i in 0..5 {
            db.add_reflection(
                None, None, "success", "did work",
                Some(&format!("lesson {i}")),
                None, "explicit_praise", 0.85,
            ).unwrap();
        }
        let timeline = build_growth_timeline(&db, 3);
        assert_eq!(timeline.len(), 3);
    }
}

#[cfg(test)]
mod silent_sampler_tests {
    use super::{reset_silent_counter_for_test, should_reflect_silent, SILENT_REFLECT_SAMPLE_EVERY};

    #[test]
    fn first_call_fires_then_sampled() {
        let sid = "test-session-sampler-1";
        reset_silent_counter_for_test(sid);

        // Counter %N==1 hits on calls 1, N+1, 2N+1, ...
        let mut fires = Vec::new();
        for i in 1..=20 {
            if should_reflect_silent(sid) {
                fires.push(i);
            }
        }
        // With SAMPLE_EVERY=5 we expect fires at 1, 6, 11, 16 → 4 times in 20 turns.
        let expected_rate = 20 / SILENT_REFLECT_SAMPLE_EVERY as usize;
        assert!(
            fires.len() == expected_rate || fires.len() == expected_rate + 1,
            "over 20 turns, expected ~{} fires (N={}), got {} at {:?}",
            expected_rate,
            SILENT_REFLECT_SAMPLE_EVERY,
            fires.len(),
            fires,
        );
    }

    #[test]
    fn different_sessions_counter_independently() {
        let a = "sess-a";
        let b = "sess-b";
        reset_silent_counter_for_test(a);
        reset_silent_counter_for_test(b);

        assert!(should_reflect_silent(a)); // a:1 → fire
        assert!(should_reflect_silent(b)); // b:1 → fire (independent)
        assert!(!should_reflect_silent(a)); // a:2 → skip
        assert!(!should_reflect_silent(b)); // b:2 → skip
    }

    #[test]
    fn sample_constant_is_stable() {
        // Regression guard so a future "optimisation" doesn't silently set
        // this to 1 (every turn) and undo the savings.
        assert!(SILENT_REFLECT_SAMPLE_EVERY >= 3);
    }
}
