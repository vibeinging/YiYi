use super::{SignalType, GROWTH_LLM_SEMAPHORE};
use crate::engine::llm_client::{chat_completion, LLMConfig, LLMMessage, MessageContent};

// ---------------------------------------------------------------------------
// Auto-memory extraction — extract noteworthy info from conversations
// ---------------------------------------------------------------------------

/// Extract memories from a conversation turn using LLM.
/// Called after the assistant finishes replying.
/// Runs in the background so it doesn't block the user.
pub async fn extract_memories_from_conversation(
    config: &LLMConfig,
    user_message: &str,
    assistant_reply: &str,
    session_id: Option<&str>,
) {
    use crate::engine::tools::get_database;

    let db = match get_database() {
        Some(db) => db,
        None => return,
    };

    // Skip very short conversations (greetings, etc.)
    if user_message.len() < 20 && assistant_reply.len() < 50 {
        return;
    }

    // Truncate to avoid sending huge texts to LLM
    let user_preview: String = user_message.chars().take(2000).collect();
    let assistant_preview: String = assistant_reply.chars().take(2000).collect();

    let extraction_prompt = format!(
        r#"Analyze the following conversation and extract any information worth remembering for future conversations.
Focus on:
- User preferences (likes, dislikes, habits)
- Important facts about the user (name, occupation, projects, etc.)
- Decisions made during the conversation
- Key experiences or lessons learned
- Important notes or context

For each memory, provide a category from: fact, preference, experience, decision, note

Respond ONLY with a JSON array. Each element should be an object with "content" (string) and "category" (string).
If there is nothing worth remembering, respond with an empty array: []

Conversation:
User: {user_preview}
Assistant: {assistant_preview}

Extract memories (JSON array only):"#
    );

    let messages = vec![LLMMessage {
        role: "user".into(),
        content: Some(MessageContent::text(extraction_prompt)),
        tool_calls: None,
        tool_call_id: None,
    }];

    let result = match chat_completion(config, &messages, &[]).await {
        Ok(resp) => resp.message.content.map(|c| c.into_text()).unwrap_or_default(),
        Err(e) => {
            log::warn!("Memory extraction LLM call failed: {}", e);
            return;
        }
    };

    // Parse the JSON response
    let trimmed = result.trim();
    // Handle cases where LLM wraps in ```json ... ```
    let json_str = if trimmed.starts_with("```") {
        trimmed
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim()
    } else {
        trimmed
    };

    #[derive(serde::Deserialize)]
    struct ExtractedMemory {
        content: String,
        category: String,
    }

    let memories: Vec<ExtractedMemory> = match serde_json::from_str(json_str) {
        Ok(m) => m,
        Err(e) => {
            log::debug!(
                "Memory extraction parse error: {} (response: {})",
                e,
                &result[..result.len().min(200)]
            );
            return;
        }
    };

    if memories.is_empty() {
        return;
    }

    let valid_categories = ["fact", "preference", "experience", "decision", "note"];
    let mut added = 0;
    for mem in &memories {
        let cat = if valid_categories.contains(&mem.category.as_str()) {
            &mem.category
        } else {
            "note"
        };
        if !mem.content.is_empty() {
            // Write to MemMe (single source of truth)
            if let Some(store) = crate::engine::tools::get_memme_store() {
                let importance: f32 = match cat {
                    "fact" | "preference" | "principle" => 0.8,
                    _ => 0.6,
                };
                let mut opts = crate::engine::tools::memory_tools::memme_add_opts(cat, importance);
                if let Some(sid) = session_id {
                    opts = opts.session_id(sid.to_string());
                }
                if store.add(&mem.content, opts).is_ok() {
                    added += 1;
                    // Sync HOT tier to files
                    if matches!(cat, "fact" | "preference" | "principle") {
                        if let Some(working_dir) = crate::engine::tools::get_working_dir() {
                            if let Err(e) = crate::engine::tiered_memory::sync_hot_to_files(&working_dir) {
                                log::warn!("Failed to sync hot-tier to files: {}", e);
                            }
                        }
                    }
                }
            }
            // Also write to diary (diary is separate from tiered memory)
            if let Some(working_dir) = crate::engine::tools::get_working_dir() {
                let _ = crate::engine::memory::append_diary(&working_dir, &mem.content, Some(cat));
            }
        }
    }

    if added > 0 {
        log::info!("Auto-extracted {} memories from conversation", added);
    }
}

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
  "skill_opportunity": "if this task could be automated as a reusable skill, describe it briefly (or null)"
}}

JSON only:"#
    );

    let messages = vec![LLMMessage {
        role: "user".into(),
        content: Some(MessageContent::text(reflection_prompt)),
        tool_calls: None,
        tool_call_id: None,
    }];

    let result = match chat_completion(config, &messages, &[]).await {
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

    // Parse JSON
    let trimmed = result.trim();
    let json_str = if trimmed.starts_with("```") {
        trimmed
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim()
    } else {
        trimmed
    };

    #[derive(serde::Deserialize)]
    struct ReflectionResult {
        outcome: Option<String>,
        summary: Option<String>,
        lesson: Option<String>,
        skill_opportunity: Option<String>,
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

    // Save reflection
    if let Ok(ref_id) = db.add_reflection(
        task_id, session_id, outcome, summary,
        parsed.lesson.as_deref(),
        parsed.skill_opportunity.as_deref(),
        signal_type.as_str(), signal_type.base_confidence(),
    ) {
        log::info!("Reflection saved: {} (outcome: {}, signal: {})", ref_id, outcome, signal_type.as_str());
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

    let result = match chat_completion(config, &messages, &[]).await {
        Ok(resp) => resp.message.content.map(|c| c.into_text()).unwrap_or_default(),
        Err(e) => {
            log::warn!("Feedback learning LLM call failed: {}", e);
            return;
        }
    };

    let trimmed = result.trim();
    let json_str = if trimmed.starts_with("```") {
        trimmed
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim()
    } else {
        trimmed
    };

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

    // Categorize by keywords in summary
    let categories = [
        ("coding", &["代码", "编程", "code", "programming", "编写", "函数", "bug", "refactor", "实现", "feature"][..]),
        ("documents", &["文档", "报告", "文件", "document", "report", "writing", "docx", "pdf", "pptx"]),
        ("data_analysis", &["数据", "分析", "统计", "data", "analysis", "csv", "excel", "表格"]),
        ("web_automation", &["浏览器", "网页", "browser", "web", "scrape", "自动化"]),
        ("system_ops", &["shell", "命令", "安装", "部署", "deploy", "系统", "terminal", "服务器"]),
        ("scheduling", &["定时", "提醒", "cron", "schedule", "reminder", "任务"]),
    ];

    let mut category_stats: std::collections::HashMap<&str, (usize, usize)> = std::collections::HashMap::new();

    for (outcome, summary) in &rows {
        let summary_lower = summary.to_lowercase();
        let is_success = outcome == "success";

        let mut matched = false;
        for (cat_name, keywords) in &categories {
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

    let greeting = match chat_completion(config, &messages, &[]).await {
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
    let existing_principles = crate::engine::memory::read_principles_md(working_dir);

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

    let result = match chat_completion(config, &messages, &[]).await {
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
    if let Err(e) = crate::engine::tiered_memory::sync_hot_to_files(working_dir) {
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
