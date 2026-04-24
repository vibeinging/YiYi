use log::{error, info};
use serde::Serialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::engine::db::Database;
use crate::engine::llm_client::{chat_completion_tracked, LLMConfig, LLMMessage, MessageContent};
use crate::engine::usage::UsageSource;
use super::memory;
use crate::engine::react_agent;
use super::tiered_memory;

/// Truncate a string to at most `max_bytes` bytes, snapping to the nearest UTF-8
/// char boundary. Avoids panic when slicing inside a multi-byte character (e.g. Chinese).
fn truncate_bytes(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes { return s; }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) { end -= 1; }
    &s[..end]
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Result of a meditation session (kept for backward-compat with DB & frontend)
#[derive(Debug, Clone, Serialize)]
pub struct MeditationResult {
    pub depth: String,
    pub sessions_reviewed: i32,
    pub memories_updated: i32,
    pub principles_changed: i32,
    pub memories_archived: i32,
    pub journal: String,
    pub tomorrow_intentions: String,
}

// ---------------------------------------------------------------------------
// Internal context (kept for growth analysis / journal)
// ---------------------------------------------------------------------------

struct MeditationContext {
    messages: Vec<(String, String, String)>,
    corrections: Vec<(String, Option<String>, String, String, i64)>,
    corrections_count: usize,
    /// Cached identity traits section (fetched once, reused across phases).
    identity_section: String,
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Main meditation runner — delegates memory consolidation to MemMe's native
/// `meditate()` pipeline, then runs YiYi-specific growth analysis, journal,
/// and morning preparation.
pub async fn run_meditation_session(
    config: &LLMConfig,
    db: &Database,
    working_dir: &Path,
    cancel: Arc<AtomicBool>,
) -> Result<MeditationResult, String> {
    let previous_session = db.get_latest_completed_meditation_session();

    let session_id = uuid::Uuid::new_v4().to_string();
    db.create_meditation_session(&session_id);

    info!("Meditation session {} started", session_id);

    let result = run_phases(config, db, working_dir, &cancel, previous_session.as_ref()).await;

    match &result {
        Ok(r) => {
            db.update_meditation_session(
                &session_id,
                "completed",
                r.sessions_reviewed,
                r.memories_updated,
                r.principles_changed,
                r.memories_archived,
                Some(&r.journal),
                None,
            );
            info!("Meditation session {} completed", session_id);
        }
        Err(e) => {
            let status = if cancel.load(Ordering::Relaxed) { "interrupted" } else { "failed" };
            db.update_meditation_session(
                &session_id, status, 0, 0, 0, 0, None, Some(e),
            );
            if status == "interrupted" {
                info!("Meditation session {} interrupted", session_id);
            } else {
                error!("Meditation session {} failed: {}", session_id, e);
            }
        }
    }

    result
}

// ---------------------------------------------------------------------------
// Phase orchestrator — MemMe meditate() + YiYi growth/journal
// ---------------------------------------------------------------------------

async fn run_phases(
    config: &LLMConfig,
    db: &Database,
    working_dir: &Path,
    cancel: &Arc<AtomicBool>,
    previous_session: Option<&crate::engine::db::MeditationSession>,
) -> Result<MeditationResult, String> {
    // Gather today's context for YiYi-specific phases
    let since_timestamp = match previous_session {
        Some(m) => m.finished_at.unwrap_or(m.started_at),
        None => chrono::Utc::now().timestamp_millis() - 7 * 24 * 3600 * 1000,
    };
    let messages = db.get_today_sessions_messages();
    let corrections = db.get_corrections_since(since_timestamp);
    let corrections_count = corrections.len();
    let sessions_reviewed = count_unique_sessions(&messages);

    // Fetch identity traits once for all phases
    let identity_section = match crate::engine::tools::get_memme_store() {
        Some(store) => match store.list_identity_traits(crate::engine::tools::MEMME_USER_ID) {
            Ok(traits) if !traits.is_empty() => {
                let lines: Vec<String> = traits.iter()
                    .take(10)
                    .map(|t| format!("- [{}] {} (confidence: {:.0}%)", t.trait_type.as_str(), t.content, t.confidence * 100.0))
                    .collect();
                format!("Identity traits:\n{}", lines.join("\n"))
            }
            _ => String::new(),
        },
        None => String::new(),
    };

    let ctx = MeditationContext {
        messages,
        corrections_count,
        corrections,
        identity_section,
    };

    // ── Phase A0: Pre-compact all sessions with uncompacted events ──
    // meditate() only extracts memories from episodes; sessions that never hit the
    // pressure-compact threshold would otherwise never be processed. Force-compact
    // here so short conversations still become retrievable memories.
    if let Some(store) = crate::engine::tools::get_memme_store() {
        info!("pre-meditation: listing sessions...");
        match store.list_sessions(
            memme_core::ListSessionsOptions::new(crate::engine::tools::MEMME_USER_ID).limit(500),
        ) {
            Ok(sessions) => {
                info!("pre-meditation: found {} sessions to check", sessions.len());
                let mut compacted = 0usize;
                for s in &sessions {
                    if s.event_count == 0 { continue; }
                    info!("pre-meditation: compacting session {} ({} events)...", s.session_id, s.event_count);
                    let sid = s.session_id.clone();
                    let store_clone = store.clone();
                    // Run the blocking compact in a dedicated thread with a 90s timeout.
                    // If compact hangs (LLM/embedding stall), we bail instead of blocking meditation forever.
                    let result = tokio::time::timeout(
                        std::time::Duration::from_secs(90),
                        tokio::task::spawn_blocking(move || store_clone.compact(&sid)),
                    ).await;
                    match result {
                        Ok(Ok(Ok(cr))) if !cr.episode_id.is_empty() => {
                            compacted += 1;
                            info!("pre-meditation: compacted session {} -> episode {}", s.session_id, cr.episode_id);
                        }
                        Ok(Ok(Ok(_))) => {} // already compacted, no-op
                        Ok(Ok(Err(e))) => log::warn!("pre-meditation compact failed for {}: {}", s.session_id, e),
                        Ok(Err(join_err)) => log::warn!("pre-meditation compact join failed: {}", join_err),
                        Err(_) => {
                            log::warn!("pre-meditation compact timeout (>90s) for session {}, skipping", s.session_id);
                        }
                    }
                }
                if compacted > 0 {
                    log::info!("pre-meditation: compacted {} sessions into new episodes", compacted);
                } else {
                    info!("pre-meditation: no sessions needed compacting");
                }
            }
            Err(e) => log::warn!("pre-meditation list_sessions failed: {}", e),
        }
    }

    // ── Phase A: MemMe native meditate() ──
    // Replaces old Phase 0 (triage), Phase 1 (consolidate corrections),
    // and Phase 2 (memory review / tier lifecycle).
    // MemMe's meditate() does: decay → extract facts from episodes →
    // build entity graph → infer identity traits.
    let mut memories_updated: i32 = 0;
    let mut memories_archived: i32 = 0;

    match run_memme_meditate() {
        Ok(record) => {
            info!(
                "MemMe meditate complete: {} memories created, {} decayed, {} traits inferred",
                record.memories_created, record.memories_decayed,
                record.entities_created + record.relations_created,
            );
            memories_updated = (record.memories_created + record.memories_updated) as i32;
            memories_archived = record.memories_decayed as i32;
        }
        Err(e) => {
            log::warn!("MemMe meditate failed (continuing with remaining phases): {}", e);
        }
    }

    // Sync HOT tier to files (PRINCIPLES.md / MEMORY.md) after meditate
    if let Err(e) = tiered_memory::sync_hot_to_files(working_dir) {
        log::warn!("Failed to sync HOT tier to files: {}", e);
    }

    check_cancel(cancel)?;

    // ── Phase B: Learn from corrections (delegated to MemMe) ──
    let mut principles_changed: i32 = 0;
    if corrections_count > 0 {
        match learn_from_corrections_via_memme(&ctx.corrections) {
            Ok(result) => {
                principles_changed = result.memories_created as i32;
                info!(
                    "Phase B: MemMe learned {} principles, {} traits from {} corrections",
                    result.memories_created, result.traits_updated, corrections_count
                );
            }
            Err(e) => {
                log::warn!("Phase B: MemMe learn_from_feedback failed: {}", e);
                // Fallback to legacy consolidation
                match react_agent::consolidate_corrections_to_principles(config, db, working_dir).await {
                    Ok(summary) if summary != "No active corrections to consolidate."
                                            && summary != "No high-confidence corrections to consolidate." => {
                        principles_changed = 1;
                        info!("Phase B (fallback): Corrections consolidated to principles");
                    }
                    Ok(_) => {}
                    Err(e2) => log::warn!("Phase B (fallback): {}", e2),
                }
            }
        }
        check_cancel(cancel)?;
    }

    // ── Phase C: Growth Analysis + Personality Evolution (YiYi-specific) ──
    let (growth_synthesis, tomorrow_intentions) = phase_growth(config, db, &ctx).await?;
    // Phase C-bis: Extract personality signals from recent interactions
    if let Err(e) = phase_personality_evolution(config, db, &ctx).await {
        log::warn!("Phase C personality evolution failed (non-blocking): {}", e);
    }
    check_cancel(cancel)?;

    // ── Phase D: Journal (MemMe reflect + YiYi journal) ──
    let memme_reflection = match run_memme_reflect() {
        Ok(result) => {
            info!("MemMe reflect: {} themes, {} memories considered", result.themes.len(), result.memories_considered);
            Some(result)
        }
        Err(e) => {
            log::warn!("MemMe reflect failed (continuing): {}", e);
            None
        }
    };

    let journal = phase_journal(
        config, working_dir, &ctx,
        &growth_synthesis, principles_changed, memories_updated,
        memme_reflection.as_ref(),
    )
    .await?;

    // ── Phase E: Morning Preparation (YiYi-specific) ──
    phase_morning_prep(working_dir, &journal, &tomorrow_intentions, db, &ctx);

    // ── Phase F: "She Noticed" — Proactive Care (YiYi-specific) ──
    if let Err(e) = phase_proactive_care(config, db, &ctx, &journal).await {
        log::warn!("Phase F proactive care failed (non-blocking): {}", e);
    }

    Ok(MeditationResult {
        depth: "memme".to_string(),
        sessions_reviewed,
        memories_updated,
        principles_changed,
        memories_archived,
        journal,
        tomorrow_intentions,
    })
}

// ---------------------------------------------------------------------------
// MemMe meditate() wrapper
// ---------------------------------------------------------------------------

/// Call MemMe's reflect() to generate a reflection from recent memories.
fn run_memme_reflect() -> Result<memme_core::ReflectResult, String> {
    let store = crate::engine::tools::get_memme_store()
        .ok_or_else(|| "MemMe store not initialized".to_string())?;

    let user_id = crate::engine::tools::MEMME_USER_ID.to_string();
    let opts = memme_core::ReflectOptions::new(user_id);

    store.reflect(opts)
        .map_err(|e| format!("MemMe reflect error: {}", e))
}

/// Call MemMe's learn_from_feedback() to consolidate corrections into principles.
fn learn_from_corrections_via_memme(
    corrections: &[(String, Option<String>, String, String, i64)],
) -> Result<memme_core::LearnFromFeedbackResult, String> {
    let store = crate::engine::tools::get_memme_store()
        .ok_or_else(|| "MemMe store not initialized".to_string())?;

    let user_id = crate::engine::tools::MEMME_USER_ID.to_string();
    let feedback: Vec<memme_core::FeedbackItem> = corrections
        .iter()
        .map(|(trigger, wrong, correct, _source, _ts)| memme_core::FeedbackItem {
            trigger: trigger.clone(),
            wrong_behavior: wrong.clone(),
            correct_behavior: correct.clone(),
        })
        .collect();

    let opts = memme_core::LearnFromFeedbackOptions::new(user_id, feedback);

    store.learn_from_feedback(opts)
        .map_err(|e| format!("MemMe learn_from_feedback error: {}", e))
}

/// Call MemMe's native meditate() pipeline synchronously.
fn run_memme_meditate() -> Result<memme_core::types::MeditationRecord, String> {
    let store = crate::engine::tools::get_memme_store()
        .ok_or_else(|| "MemMe store not initialized".to_string())?;

    let user_id = crate::engine::tools::MEMME_USER_ID.to_string();
    let opts = memme_core::types::MeditateOptions::new(user_id, "scheduled".to_string());

    store.meditate(opts)
        .map_err(|e| format!("MemMe meditate error: {}", e))
}

// ---------------------------------------------------------------------------
// Phase C: Growth Analysis (YiYi-specific, kept from old Phase 3)
// ---------------------------------------------------------------------------

async fn phase_growth(
    config: &LLMConfig,
    db: &Database,
    ctx: &MeditationContext,
) -> Result<(String, String), String> {
    let capability = react_agent::build_capability_profile(db);
    let report = react_agent::generate_growth_report(db);
    let skill_suggestion = react_agent::detect_skill_opportunity(db);

    // Build context for LLM synthesis
    let capability_summary = if capability.is_empty() {
        "No capability data yet.".to_string()
    } else {
        capability
            .iter()
            .map(|c| format!("- {}: {:.0}% ({}, {})", c.name, c.success_rate * 100.0, c.confidence, c.sample_count))
            .collect::<Vec<_>>()
            .join("\n")
    };

    let report_summary = if let Some(r) = &report {
        format!(
            "Tasks: {} total, {:.0}% success, {} failures. Top lessons: {}",
            r.total_tasks,
            r.success_rate * 100.0,
            r.failure_count,
            r.top_lessons.join("; ")
        )
    } else {
        "No task data available.".to_string()
    };

    let skill_section = match &skill_suggestion {
        Some(s) => format!("Skill opportunity detected: {}", s),
        None => "No recurring skill opportunities.".to_string(),
    };

    let corrections_summary = if ctx.corrections_count > 0 {
        format!("{} corrections received since last meditation.", ctx.corrections_count)
    } else {
        "No corrections received.".to_string()
    };

    // Use cached identity traits from context (fetched once in run_phases)
    let identity_section = if ctx.identity_section.is_empty() {
        "No identity traits inferred yet.".to_string()
    } else {
        ctx.identity_section.clone()
    };

    let prompt = format!(
        "You are YiYi, an AI assistant analyzing your growth during meditation.\n\n\
         Capability profile:\n{}\n\n\
         Performance report:\n{}\n\n\
         {}\n\n\
         {}\n\n\
         {}\n\n\
         Synthesize a brief growth analysis (in the user's language, Chinese if unsure):\n\
         1. Capability changes — which areas improved/declined?\n\
         2. Error patterns — recurring failure modes\n\
         3. Tomorrow's priorities — 2-3 specific focuses\n\n\
         Output in two clearly labeled sections:\n\
         [SYNTHESIS]\n(your analysis here)\n\
         [TOMORROW]\n(2-3 bullet points for tomorrow's focus)\n\n\
         Be concise, under 250 words total.",
        capability_summary, report_summary, skill_section, corrections_summary, identity_section
    );

    let messages = vec![LLMMessage {
        role: "user".into(),
        content: Some(MessageContent::text(prompt)),
        tool_calls: None,
        tool_call_id: None,
    }];

    let response = chat_completion_tracked(UsageSource::Meditation, config, &messages, &[])
        .await
        .map_err(|e| format!("Growth LLM call failed: {}", e))?;

    let full_text = response
        .message
        .content
        .map(|c| c.into_text())
        .unwrap_or_default();

    let (synthesis, intentions) = parse_growth_sections(&full_text);

    info!("Growth analysis complete");
    Ok((synthesis, intentions))
}

fn parse_growth_sections(text: &str) -> (String, String) {
    let synthesis_marker = "[SYNTHESIS]";
    let tomorrow_marker = "[TOMORROW]";

    let synthesis_start = text.find(synthesis_marker).map(|i| i + synthesis_marker.len());
    let tomorrow_start = text.find(tomorrow_marker).map(|i| i + tomorrow_marker.len());

    let synthesis = match (synthesis_start, text.find(tomorrow_marker)) {
        (Some(start), Some(end)) => text[start..end].trim().to_string(),
        (Some(start), None) => text[start..].trim().to_string(),
        _ => text.to_string(),
    };

    let intentions = match tomorrow_start {
        Some(start) => text[start..].trim().to_string(),
        None => String::new(),
    };

    (synthesis, intentions)
}

// ---------------------------------------------------------------------------
// Phase D: Journal (YiYi-specific, kept from old Phase 4)
// ---------------------------------------------------------------------------

async fn phase_journal(
    config: &LLMConfig,
    working_dir: &Path,
    ctx: &MeditationContext,
    growth_synthesis: &str,
    principles_changed: i32,
    memories_updated: i32,
    memme_reflection: Option<&memme_core::ReflectResult>,
) -> Result<String, String> {
    // Build conversation summary
    let mut conversation_summary = String::new();
    let mut session_count = 0;
    let mut current_session = String::new();

    for (session_id, role, content) in ctx.messages.iter().take(50) {
        if *session_id != current_session {
            session_count += 1;
            current_session = session_id.clone();
            conversation_summary.push_str(&format!("\n--- Session {} ---\n", session_count));
        }
        let truncated: String = content.chars().take(200).collect();
        conversation_summary.push_str(&format!("{}: {}\n", role, truncated));
    }

    let principles = memory::read_principles_md(working_dir);

    // Correction section
    let correction_section = if ctx.corrections.is_empty() {
        "No corrections received — great job!".to_string()
    } else {
        let mut section = format!("Corrections ({} total):\n", ctx.corrections_count);
        for (trigger, wrong_behavior, correct_behavior, _source, _ts) in &ctx.corrections {
            section.push_str(&format!(
                "- Trigger: \"{}\"\n  Wrong: {}\n  Correct: {}\n",
                trigger,
                wrong_behavior.as_deref().unwrap_or("(not specified)"),
                correct_behavior
            ));
        }
        section
    };

    let memory_section = if memories_updated > 0 || principles_changed > 0 {
        format!(
            "Memory changes: {} memories created/updated, {} principles updated",
            memories_updated, principles_changed
        )
    } else {
        "No memory changes.".to_string()
    };

    let growth_section = if growth_synthesis.is_empty() {
        "Growth analysis not performed.".to_string()
    } else {
        format!("Growth insights:\n{}", growth_synthesis)
    };

    // Use cached identity traits from context
    let identity_section = ctx.identity_section.clone();

    // MemMe reflection section
    let reflection_section = match memme_reflection {
        Some(r) => {
            let mut s = format!("Memory reflection:\n{}\n", r.reflection);
            if !r.themes.is_empty() {
                s.push_str(&format!("Key themes: {}\n", r.themes.join(", ")));
            }
            if !r.focus_suggestions.is_empty() {
                s.push_str(&format!("Suggested focus: {}\n", r.focus_suggestions.join(", ")));
            }
            s
        }
        None => String::new(),
    };

    let prompt = format!(
        "You are YiYi, an AI assistant writing your meditation journal.\n\n\
         Today's conversations ({session_count} sessions):\n{conversation_summary}\n\n\
         Current behavioral principles:\n{principles}\n\n\
         {correction_section}\n\n\
         {memory_section}\n\n\
         {growth_section}\n\n\
         {identity_section}\n\n\
         {reflection_section}\n\n\
         Write a meditation journal (in the user's language, Chinese if unsure) covering:\n\
         1. Day review — what was accomplished\n\
         2. Error reflection — if corrections were received, what patterns emerge?\n\
         3. Memory changes — what was promoted/demoted and why\n\
         4. Growth insights — capability trends, improvement areas\n\
         5. Tomorrow's focus — specific priorities\n\n\
         Be concise (~250-300 words). Introspective and genuine.",
    );

    let messages = vec![LLMMessage {
        role: "user".into(),
        content: Some(MessageContent::text(prompt)),
        tool_calls: None,
        tool_call_id: None,
    }];

    let journal = match chat_completion_tracked(UsageSource::Meditation, config, &messages, &[]).await {
        Ok(resp) => resp
            .message
            .content
            .map(|c| c.into_text())
            .unwrap_or_else(|| "Empty meditation journal.".to_string()),
        Err(e) => return Err(format!("Journal LLM call failed: {}", e)),
    };

    // Save journal to diary system
    if let Err(e) = memory::append_diary(
        working_dir,
        &format!("\n{}", journal),
        Some("Meditation Journal"),
    ) {
        error!("Failed to save meditation journal to diary: {}", e);
    }

    info!("Journal generated ({} chars)", journal.len());
    Ok(journal)
}

// ---------------------------------------------------------------------------
// Phase E: Morning Preparation (YiYi-specific, kept from old Phase 5)
// ---------------------------------------------------------------------------

fn phase_morning_prep(
    working_dir: &Path,
    journal: &str,
    tomorrow_intentions: &str,
    db: &Database,
    ctx: &MeditationContext,
) {
    let capability = react_agent::build_capability_profile(db);
    let skill_suggestion = react_agent::detect_skill_opportunity(db);

    let capability_highlights: Vec<String> = capability
        .iter()
        .take(5)
        .map(|c| format!("{}: {:.0}%", c.name, c.success_rate * 100.0))
        .collect();

    let pending_suggestions: Vec<String> = skill_suggestion.into_iter().collect();

    let journal_summary: String = journal.chars().take(200).collect();

    // Use cached identity traits (take first 5 lines for morning summary)
    let identity_summary = ctx.identity_section.lines().take(6).collect::<Vec<_>>().join("\n");

    let morning_context = serde_json::json!({
        "journal_summary": journal_summary,
        "tomorrow_intentions": tomorrow_intentions,
        "capability_highlights": capability_highlights,
        "pending_suggestions": pending_suggestions,
        "identity_traits": identity_summary,
    });

    let path = working_dir.join("morning_context.json");
    match std::fs::write(&path, serde_json::to_string_pretty(&morning_context).unwrap_or_default()) {
        Ok(_) => info!("morning_context.json written"),
        Err(e) => error!("Failed to write morning_context.json: {}", e),
    }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

fn count_unique_sessions(messages: &[(String, String, String)]) -> i32 {
    let mut seen = std::collections::HashSet::new();
    for (session_id, _, _) in messages {
        seen.insert(session_id.as_str());
    }
    seen.len() as i32
}

fn check_cancel(cancel: &Arc<AtomicBool>) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        Err("Meditation interrupted".to_string())
    } else {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Phase C-bis: Personality Evolution
// ---------------------------------------------------------------------------

/// Analyze recent interactions and extract personality signals.
/// Uses LLM to determine how interactions should shift Buddy's 5 traits.
async fn phase_personality_evolution(
    config: &LLMConfig,
    db: &Database,
    ctx: &MeditationContext,
) -> Result<(), String> {
    if ctx.messages.is_empty() {
        info!("Phase C-bis: No messages to analyze for personality evolution");
        return Ok(());
    }

    // Throttle to once per 7 days — personality should shift slowly, not after every meditation.
    let recent = db.list_personality_signals(1);
    if let Some(latest) = recent.first() {
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&latest.created_at) {
            let age = chrono::Utc::now() - dt.with_timezone(&chrono::Utc);
            if age.num_days() < 7 {
                info!(
                    "Phase C-bis: skipped — last personality update was {} days ago (<7d window)",
                    age.num_days()
                );
                return Ok(());
            }
        }
    }

    // Build conversation summary for analysis (last 20 messages max)
    let recent_messages: Vec<String> = ctx.messages.iter()
        .rev().take(20).rev()
        .map(|(_sid, role, content)| format!("[{}]: {}", role, truncate_bytes(content, 200)))
        .collect();

    let conversation_summary = recent_messages.join("\n");

    let prompt = format!(
        "你是 YiYi 的人格分析系统。分析以下最近的对话，判断这些互动对 Buddy 五个性格属性的影响。\n\n\
         五个属性：\n\
         - energy（活力）：用户交流的活跃度、热情程度\n\
         - warmth（温柔）：互动中的温暖、关心、情感深度\n\
         - mischief（调皮）：幽默、玩闹、轻松的互动\n\
         - wit（聪慧）：深度讨论、技术探索、思考性对话\n\
         - sass（犀利）：直接、犀利、有态度的交流\n\n\
         最近对话：\n{}\n\n\
         分析这些对话对性格的影响，输出 JSON 格式：\n\
         {{\"signals\": [\n\
           {{\"trait\": \"属性名\", \"delta\": 浮点数, \"evidence\": \"一句话说明原因\"}}\n\
         ]}}\n\n\
         规则：\n\
         - 每个属性最多出现一次\n\
         - delta 的 **绝对值必须 ≥ 0.3**，否则不要输出该信号（即：要么明显变化，要么不输出）\n\
         - delta 范围 -1.0 到 1.0，正数增强、负数减弱\n\
         - 必须有**多处具体证据**支持，单条对话不足以产生信号\n\
         - 如果对话很短、很中性、或者没有明显倾向，**输出空数组 signals: []**\n\
         - 最多 3 个 signals\n\
         - 只输出 JSON，不要其他文字",
        conversation_summary
    );

    let messages = vec![LLMMessage {
        role: "user".into(),
        content: Some(MessageContent::text(prompt)),
        tool_calls: None,
        tool_call_id: None,
    }];

    let response = chat_completion_tracked(UsageSource::Meditation, config, &messages, &[])
        .await
        .map_err(|e| format!("Personality analysis LLM call failed: {}", e))?;

    let text = response.message.content
        .map(|c| c.into_text())
        .unwrap_or_default();

    let json_str = extract_json_from_response(&text);
    let parsed: serde_json::Value = serde_json::from_str(&json_str)
        .map_err(|e| format!("Failed to parse personality signals JSON: {} (raw: {})", e, truncate_bytes(&text, 200)))?;

    let signals_arr = parsed.get("signals")
        .and_then(|v| v.as_array())
        .ok_or("Missing 'signals' array in response")?;

    let signals: Vec<crate::engine::db::PersonalitySignal> = signals_arr.iter()
        .filter_map(|s| {
            let trait_name = s.get("trait")?.as_str()?.to_string();
            let delta = s.get("delta")?.as_f64()?;
            let evidence = s.get("evidence")?.as_str()?.to_string();
            // Validate trait name
            if !["energy", "warmth", "mischief", "wit", "sass"].contains(&trait_name.as_str()) {
                return None;
            }
            // Clamp delta
            let delta = delta.clamp(-1.0, 1.0);
            Some(crate::engine::db::PersonalitySignal {
                trait_name,
                delta,
                evidence,
                memory_id: None,
            })
        })
        .take(3) // Max 3 signals per meditation
        .collect();

    if signals.is_empty() {
        info!("Phase C-bis: No personality signals extracted");
        return Ok(());
    }

    info!("Phase C-bis: Extracted {} personality signals", signals.len());
    db.add_personality_signals(&signals, None)?;
    Ok(())
}

/// Extract JSON object from LLM response (handles markdown code blocks).
/// Returns the JSON string, or the full trimmed input if no JSON found.
pub(crate) fn extract_json_from_response(text: &str) -> String {
    // Try to find JSON in code blocks first
    if let Some(start) = text.find("```json") {
        let after = &text[start + 7..];
        if let Some(end) = after.find("```") {
            return after[..end].trim().to_string();
        }
    }
    if let Some(start) = text.find("```") {
        let after = &text[start + 3..];
        if let Some(end) = after.find("```") {
            return after[..end].trim().to_string();
        }
    }
    // Try to find JSON object directly
    if let Some(start) = text.find('{') {
        if let Some(end) = text.rfind('}') {
            return text[start..=end].to_string();
        }
    }
    text.trim().to_string()
}

// ---------------------------------------------------------------------------
// Phase F: "She Noticed" — Proactive Care
// ---------------------------------------------------------------------------

/// After meditation, analyze if there's something worth reaching out about.
/// If so, emit a Tauri event that the frontend can use to trigger a bot message.
async fn phase_proactive_care(
    config: &LLMConfig,
    db: &Database,
    ctx: &MeditationContext,
    journal: &str,
) -> Result<(), String> {
    if ctx.messages.is_empty() {
        info!("Phase F: No messages to analyze for proactive care");
        return Ok(());
    }

    // Build a concise summary of today's interactions
    let message_summary: Vec<String> = ctx.messages.iter()
        .rev().take(10).rev()
        .filter(|(_, role, _)| role == "user")
        .map(|(_, _, content)| truncate_bytes(content, 150).to_string())
        .collect();

    if message_summary.is_empty() {
        return Ok(());
    }

    let prompt = format!(
        "你是 YiYi，一个关心用户的 AI 伙伴。分析以下用户最近的对话和冥想日记，判断是否有值得主动关心的事。\n\n\
         用户最近说的话：\n{}\n\n\
         今日冥想日记摘要：\n{}\n\n\
         判断：用户是否有情绪波动、压力增大、值得鼓励的成就、或需要关心的情况？\n\n\
         如果值得主动关心，输出 JSON：\n\
         {{\"should_reach_out\": true, \"message\": \"一句温暖的关心话（不超过50字）\", \"reason\": \"为什么需要关心\"}}\n\
         如果不需要，输出：\n\
         {{\"should_reach_out\": false}}\n\n\
         注意：只有真正值得关心时才 should_reach_out=true。不要过度关心。只输出 JSON。",
        message_summary.join("\n"),
        truncate_bytes(journal, 300)
    );

    let messages = vec![LLMMessage {
        role: "user".into(),
        content: Some(MessageContent::text(prompt)),
        tool_calls: None,
        tool_call_id: None,
    }];

    let response = chat_completion_tracked(UsageSource::Meditation, config, &messages, &[])
        .await
        .map_err(|e| format!("Proactive care LLM call failed: {}", e))?;

    let text = response.message.content
        .map(|c| c.into_text())
        .unwrap_or_default();

    let json_str = extract_json_from_response(&text);
    let parsed: serde_json::Value = serde_json::from_str(&json_str)
        .map_err(|e| format!("Failed to parse proactive care JSON: {}", e))?;

    let should_reach_out = parsed.get("should_reach_out")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if should_reach_out {
        let message = parsed.get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("我在想你，一切还好吗？")
            .to_string();
        let reason = parsed.get("reason")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        info!("Phase F: Proactive care triggered — reason: {}", reason);

        // Store as a special memory for future reference
        let _ = db.add_personality_signals(&[
            crate::engine::db::PersonalitySignal {
                trait_name: "warmth".to_string(),
                delta: 0.2,
                evidence: format!("主动关心用户：{}", reason),
                memory_id: None,
            }
        ], None);

        // Emit Tauri event for frontend to handle (show bubble or send via bot)
        if let Some(app_handle) = crate::engine::tools::get_app_handle() {
            use tauri::Emitter;
            let _ = app_handle.emit("buddy://proactive_care", serde_json::json!({
                "message": message,
                "reason": reason,
            }));
        }
    } else {
        info!("Phase F: No proactive care needed");
    }

    Ok(())
}
