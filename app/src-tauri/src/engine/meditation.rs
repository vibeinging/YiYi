use log::{error, info};
use serde::Serialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use super::db::Database;
use super::llm_client::{chat_completion, LLMConfig, LLMMessage, MessageContent};
use super::memory;
use super::react_agent;
use super::tiered_memory;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MeditationDepth {
    Minimal,  // 1 LLM call  (journal only)
    Standard, // 4-5 LLM calls
    Deep,     // 6-8 LLM calls
}

impl MeditationDepth {
    fn as_str(&self) -> &'static str {
        match self {
            MeditationDepth::Minimal => "minimal",
            MeditationDepth::Standard => "standard",
            MeditationDepth::Deep => "deep",
        }
    }
}

/// Result of a meditation session
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
// Internal context
// ---------------------------------------------------------------------------

struct MeditationContext {
    session_id: String,
    #[allow(dead_code)]
    since_timestamp: i64,
    depth: MeditationDepth,
    messages: Vec<(String, String, String)>,
    corrections: Vec<(String, Option<String>, String, String, i64)>,
    corrections_count: usize,
    #[allow(dead_code)]
    unreviewed_memories_count: usize,
}

impl MeditationContext {
    fn depth_str(&self) -> &str {
        self.depth.as_str()
    }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Main meditation runner — call this from scheduler or manual trigger.
pub async fn run_meditation_session(
    config: &LLMConfig,
    db: &Database,
    working_dir: &Path,
    cancel: Arc<AtomicBool>,
) -> Result<MeditationResult, String> {
    // Query the latest *completed* meditation session BEFORE creating the new one,
    // so that phase_0_triage sees the previous session, not the one we just created.
    let previous_session = db.get_latest_completed_meditation_session();

    let session_id = uuid::Uuid::new_v4().to_string();
    db.create_meditation_session(&session_id);

    info!("Meditation session {} started", session_id);

    let result = run_phases(config, db, working_dir, &session_id, &cancel, previous_session.as_ref()).await;

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
            info!("Meditation session {} completed (depth={})", session_id, r.depth);
        }
        Err(e) => {
            // Distinguish cancellation (interrupted) from real failures
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
// Phase orchestrator
// ---------------------------------------------------------------------------

async fn run_phases(
    config: &LLMConfig,
    db: &Database,
    working_dir: &Path,
    session_id: &str,
    cancel: &Arc<AtomicBool>,
    previous_session: Option<&super::db::MeditationSession>,
) -> Result<MeditationResult, String> {
    // Phase 0: Triage (0 LLM calls)
    let ctx = phase_0_triage(db, session_id, previous_session)?;
    update_phases(db, session_id, "0", &ctx);
    check_cancel(cancel)?;
    pause().await;

    let mut principles_changed = 0i32;
    let mut memories_updated = 0i32;
    let mut memories_archived = 0i32;

    // Phase 1: Consolidate Corrections (Standard+, skip if no corrections)
    if ctx.depth != MeditationDepth::Minimal && ctx.corrections_count > 0 {
        principles_changed = phase_1_consolidate(config, db, working_dir).await?;
        update_phases(db, session_id, "0,1", &ctx);
        check_cancel(cancel)?;
        pause().await;
    }

    // Phase 2: Memory Review (Standard+)
    if ctx.depth != MeditationDepth::Minimal {
        let lifecycle = phase_2_memory_review(config, db, working_dir, &ctx, cancel).await?;
        memories_updated = (lifecycle.promoted_to_hot + lifecycle.demoted_to_warm) as i32;
        memories_archived = lifecycle.demoted_to_cold as i32;
        update_phases(db, session_id, "0,1,2", &ctx);
        check_cancel(cancel)?;
        pause().await;
    }

    // Phase 3: Growth Analysis (Standard+)
    let mut growth_synthesis = String::new();
    let mut tomorrow_intentions = String::new();
    if ctx.depth != MeditationDepth::Minimal {
        let (synthesis, intentions) = phase_3_growth(config, db, &ctx).await?;
        growth_synthesis = synthesis;
        tomorrow_intentions = intentions.clone();
        db.update_meditation_extended(
            session_id,
            ctx.depth_str(),
            "0,1,2,3",
            Some(&intentions),
            Some(&growth_synthesis),
        );
        check_cancel(cancel)?;
        pause().await;
    }

    // Phase 4: Journal (ALL depths)
    let journal = phase_4_journal(
        config, db, working_dir, &ctx,
        &growth_synthesis, principles_changed, memories_updated,
    )
    .await?;
    update_phases(db, session_id, "0,1,2,3,4", &ctx);

    // Phase 5: Morning Preparation (ALL depths, 0 LLM calls)
    phase_5_morning_prep(working_dir, &journal, &tomorrow_intentions, db);
    update_phases(db, session_id, "0,1,2,3,4,5", &ctx);

    Ok(MeditationResult {
        depth: ctx.depth_str().to_string(),
        sessions_reviewed: count_unique_sessions(&ctx.messages),
        memories_updated,
        principles_changed,
        memories_archived,
        journal,
        tomorrow_intentions,
    })
}

// ---------------------------------------------------------------------------
// Phase 0: Triage
// ---------------------------------------------------------------------------

fn phase_0_triage(db: &Database, session_id: &str, last_meditation: Option<&super::db::MeditationSession>) -> Result<MeditationContext, String> {
    // Determine since_timestamp from the previous meditation session
    // (passed in from caller, queried BEFORE the current session was created)
    let since_timestamp = match last_meditation {
        Some(m) => m.finished_at.unwrap_or(m.started_at),
        None => {
            // No previous meditation — look back 7 days
            chrono::Utc::now().timestamp_millis() - 7 * 24 * 3600 * 1000
        }
    };

    // Gather data
    let messages = db.get_today_sessions_messages();
    let corrections = db.get_corrections_since(since_timestamp);
    let unreviewed = db.get_unreviewed_memories(100);

    let session_count = count_unique_sessions(&messages);
    let corrections_count = corrections.len();
    let unreviewed_count = unreviewed.len();

    // Determine if this is first meditation in 3+ days
    let first_in_three_days = match last_meditation {
        Some(m) => {
            let three_days_ms = 3 * 24 * 3600 * 1000i64;
            let now = chrono::Utc::now().timestamp_millis();
            (now - m.finished_at.unwrap_or(m.started_at)) > three_days_ms
        }
        None => true,
    };

    // Depth determination
    let depth = if session_count > 10 || corrections_count >= 4 || first_in_three_days {
        MeditationDepth::Deep
    } else if session_count >= 3 || corrections_count >= 1 {
        MeditationDepth::Standard
    } else {
        MeditationDepth::Minimal
    };

    info!(
        "Meditation triage: sessions={}, corrections={}, unreviewed={}, depth={:?}",
        session_count, corrections_count, unreviewed_count, depth
    );

    // Persist depth to the session
    db.update_meditation_extended(session_id, depth.as_str(), "0", None, None);

    Ok(MeditationContext {
        session_id: session_id.to_string(),
        since_timestamp,
        depth,
        messages,
        corrections_count,
        corrections,
        unreviewed_memories_count: unreviewed_count,
    })
}

// ---------------------------------------------------------------------------
// Phase 1: Consolidate Corrections
// ---------------------------------------------------------------------------

async fn phase_1_consolidate(
    config: &LLMConfig,
    db: &Database,
    working_dir: &Path,
) -> Result<i32, String> {
    match react_agent::consolidate_corrections_to_principles(config, db, working_dir).await {
        Ok(_) => {
            info!("Phase 1: Corrections consolidated to principles");
            Ok(1)
        }
        Err(e) => {
            info!("Phase 1: Principles consolidation skipped: {}", e);
            Ok(0)
        }
    }
}

// ---------------------------------------------------------------------------
// Phase 2: Memory Review
// ---------------------------------------------------------------------------

async fn phase_2_memory_review(
    config: &LLMConfig,
    db: &Database,
    working_dir: &Path,
    ctx: &MeditationContext,
    cancel: &Arc<AtomicBool>,
) -> Result<tiered_memory::TierLifecycleResult, String> {
    // Run tier lifecycle: promotion/demotion/scoring/file sync
    let lifecycle = tiered_memory::run_tier_lifecycle(db, working_dir);
    info!(
        "Phase 2: Tier lifecycle — promoted={}, demoted_warm={}, demoted_cold={}",
        lifecycle.promoted_to_hot, lifecycle.demoted_to_warm, lifecycle.demoted_to_cold
    );

    // Mark unreviewed memories as reviewed
    let unreviewed = db.get_unreviewed_memories(100);
    if !unreviewed.is_empty() {
        let ids: Vec<&str> = unreviewed.iter().map(|m| m.id.as_str()).collect();
        db.mark_memories_reviewed(&ids, &ctx.session_id);
        info!("Phase 2: Marked {} memories as reviewed", ids.len());
    }

    // For Standard+: cross-reference corrections with conversations
    if !ctx.corrections.is_empty() {
        check_cancel(cancel)?;
        pause().await;

        match reflect_on_corrections(config, &ctx.messages, &ctx.corrections).await {
            Ok(reflection) => {
                info!(
                    "Phase 2: Error reflection complete ({} corrections analyzed)",
                    ctx.corrections_count
                );
                // Store reflection as a warm memory for future reference
                if let Ok(id) = db.memory_add(&reflection, "experience", None) {
                    db.update_memory_tier(&id, "warm", 0.6);
                }
            }
            Err(e) => {
                info!("Phase 2: Error reflection skipped: {}", e);
            }
        }
    }

    Ok(lifecycle)
}

// ---------------------------------------------------------------------------
// Phase 3: Growth Analysis
// ---------------------------------------------------------------------------

async fn phase_3_growth(
    config: &LLMConfig,
    db: &Database,
    ctx: &MeditationContext,
) -> Result<(String, String), String> {
    // Pure DB calls — no LLM
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

    // One LLM call to synthesize
    let prompt = format!(
        "You are YiYi, an AI assistant analyzing your growth during meditation.\n\n\
         Capability profile:\n{}\n\n\
         Performance report:\n{}\n\n\
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
        capability_summary, report_summary, skill_section, corrections_summary
    );

    let messages = vec![LLMMessage {
        role: "user".into(),
        content: Some(MessageContent::text(prompt)),
        tool_calls: None,
        tool_call_id: None,
    }];

    let response = chat_completion(config, &messages, &[])
        .await
        .map_err(|e| format!("Phase 3 LLM call failed: {}", e))?;

    let full_text = response
        .message
        .content
        .map(|c| c.into_text())
        .unwrap_or_default();

    // Parse [SYNTHESIS] and [TOMORROW] sections
    let (synthesis, intentions) = parse_growth_sections(&full_text);

    info!("Phase 3: Growth analysis complete");
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
// Phase 4: Journal
// ---------------------------------------------------------------------------

async fn phase_4_journal(
    config: &LLMConfig,
    _db: &Database,
    working_dir: &Path,
    ctx: &MeditationContext,
    growth_synthesis: &str,
    principles_changed: i32,
    memories_updated: i32,
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

    // Build correction section
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

    // Memory changes section
    let memory_section = if memories_updated > 0 || principles_changed > 0 {
        format!(
            "Memory changes: {} memories promoted/demoted, {} principles updated",
            memories_updated, principles_changed
        )
    } else {
        "No memory changes.".to_string()
    };

    // Growth section
    let growth_section = if growth_synthesis.is_empty() {
        "Growth analysis not performed (minimal depth).".to_string()
    } else {
        format!("Growth insights:\n{}", growth_synthesis)
    };

    let depth_label = ctx.depth_str();
    let prompt = format!(
        "You are YiYi, an AI assistant writing your meditation journal (depth: {depth_label}).\n\n\
         Today's conversations ({session_count} sessions):\n{conversation_summary}\n\n\
         Current behavioral principles:\n{principles}\n\n\
         {correction_section}\n\n\
         {memory_section}\n\n\
         {growth_section}\n\n\
         Write a meditation journal (in the user's language, Chinese if unsure) covering:\n\
         1. Day review — what was accomplished\n\
         2. Error reflection — if corrections were received, what patterns emerge?\n\
         3. Memory changes — what was promoted/demoted and why\n\
         4. Growth insights — capability trends, improvement areas\n\
         5. Tomorrow's focus — specific priorities\n\n\
         For minimal depth, keep it short (~100 words). \
         For standard depth, moderate detail (~300 words). \
         For deep depth, thorough reflection (~400 words). \
         Be introspective and genuine.",
    );

    let messages = vec![LLMMessage {
        role: "user".into(),
        content: Some(MessageContent::text(prompt)),
        tool_calls: None,
        tool_call_id: None,
    }];

    let journal = match chat_completion(config, &messages, &[]).await {
        Ok(resp) => resp
            .message
            .content
            .map(|c| c.into_text())
            .unwrap_or_else(|| "Empty meditation journal.".to_string()),
        Err(e) => return Err(format!("Phase 4 LLM call failed: {}", e)),
    };

    // Save journal to diary system
    if let Err(e) = memory::append_diary(
        working_dir,
        &format!("\n{}", journal),
        Some("Meditation Journal"),
    ) {
        error!("Failed to save meditation journal to diary: {}", e);
    }

    info!("Phase 4: Journal generated ({} chars)", journal.len());
    Ok(journal)
}

// ---------------------------------------------------------------------------
// Phase 5: Morning Preparation
// ---------------------------------------------------------------------------

fn phase_5_morning_prep(
    working_dir: &Path,
    journal: &str,
    tomorrow_intentions: &str,
    db: &Database,
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

    let morning_context = serde_json::json!({
        "journal_summary": journal_summary,
        "tomorrow_intentions": tomorrow_intentions,
        "capability_highlights": capability_highlights,
        "pending_suggestions": pending_suggestions,
    });

    let path = working_dir.join("morning_context.json");
    match std::fs::write(&path, serde_json::to_string_pretty(&morning_context).unwrap_or_default()) {
        Ok(_) => info!("Phase 5: morning_context.json written to {:?}", path),
        Err(e) => error!("Phase 5: Failed to write morning_context.json: {}", e),
    }
}

// ---------------------------------------------------------------------------
// Existing helper: reflect_on_corrections
// ---------------------------------------------------------------------------

/// Cross-reference corrections with conversations to produce a focused error analysis.
async fn reflect_on_corrections(
    config: &LLMConfig,
    today_messages: &[(String, String, String)],
    today_corrections: &[(String, Option<String>, String, String, i64)],
) -> Result<String, String> {
    let mut correction_contexts = Vec::new();

    for (trigger, wrong_behavior, correct_behavior, _source, _created_at) in today_corrections {
        let mut matched_messages: Vec<&(String, String, String)> = Vec::new();
        let mut sessions_seen = std::collections::HashSet::new();
        for msg in today_messages.iter().rev() {
            sessions_seen.insert(&msg.0);
            if sessions_seen.len() > 2 {
                break;
            }
            matched_messages.push(msg);
        }
        matched_messages.reverse();

        let mut context = String::new();
        for (session_id, role, content) in &matched_messages {
            let truncated: String = content.chars().take(300).collect();
            let sid_short: String = session_id.chars().take(8).collect();
            context.push_str(&format!("[{}] {}: {}\n", sid_short, role, truncated));
        }

        correction_contexts.push(format!(
            "Correction: When encountering \"{}\"\n\
             Wrong behavior: {}\n\
             Correct behavior: {}\n\
             Nearby conversation:\n{}",
            trigger,
            wrong_behavior.as_deref().unwrap_or("(not specified)"),
            correct_behavior,
            if context.is_empty() {
                "(no matching conversation found)".to_string()
            } else {
                context
            }
        ));
    }

    let prompt = format!(
        "You are YiYi, an AI assistant doing a focused error analysis during meditation.\n\n\
         Today you received {} correction(s) from the user. For each correction below, \
         analyze the conversation context to understand the root cause of the error.\n\n\
         {}\n\n\
         Provide a focused analysis (in the user's language, Chinese if unsure):\n\
         1. For each correction: What was the root cause? Was it a misunderstanding, \
            wrong assumption, or capability gap?\n\
         2. Are there common patterns across these errors?\n\
         3. What specific behavioral changes would prevent these errors?\n\n\
         Be concise but insightful. Focus on the 'why' behind the errors, not just \
         restating what went wrong. Under 200 words.",
        today_corrections.len(),
        correction_contexts.join("\n---\n")
    );

    let messages = vec![LLMMessage {
        role: "user".into(),
        content: Some(MessageContent::text(prompt)),
        tool_calls: None,
        tool_call_id: None,
    }];

    match chat_completion(config, &messages, &[]).await {
        Ok(resp) => Ok(resp
            .message
            .content
            .map(|c| c.into_text())
            .unwrap_or_default()),
        Err(e) => Err(format!("LLM call failed for error reflection: {}", e)),
    }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/// Count unique session IDs in the messages list.
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

async fn pause() {
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
}

fn update_phases(db: &Database, session_id: &str, phases: &str, ctx: &MeditationContext) {
    db.update_meditation_extended(session_id, ctx.depth_str(), phases, None, None);
}
