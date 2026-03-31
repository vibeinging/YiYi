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
    previous_session: Option<&super::db::MeditationSession>,
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

    let ctx = MeditationContext {
        messages,
        corrections_count,
        corrections,
    };

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
                record.identity_traits_created + record.identity_traits_updated,
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

    // ── Phase B: Consolidate corrections (YiYi-specific) ──
    let mut principles_changed: i32 = 0;
    if corrections_count > 0 {
        match react_agent::consolidate_corrections_to_principles(config, db, working_dir).await {
            Ok(summary) if summary != "No active corrections to consolidate."
                                    && summary != "No high-confidence corrections to consolidate." => {
                principles_changed = 1;
                info!("Phase B: Corrections consolidated to principles");
            }
            Ok(_) => {
                info!("Phase B: No corrections to consolidate");
            }
            Err(e) => {
                log::warn!("Phase B: Corrections consolidation skipped: {}", e);
            }
        }
        check_cancel(cancel)?;
    }

    // ── Phase C: Growth Analysis (YiYi-specific) ──
    let (growth_synthesis, tomorrow_intentions) = phase_growth(config, db, &ctx).await?;
    check_cancel(cancel)?;

    // ── Phase D: Journal (YiYi-specific) ──
    let journal = phase_journal(
        config, working_dir, &ctx,
        &growth_synthesis, principles_changed, memories_updated,
    )
    .await?;

    // ── Phase E: Morning Preparation (YiYi-specific) ──
    phase_morning_prep(working_dir, &journal, &tomorrow_intentions, db);

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

    // Optionally enrich with MemMe identity traits
    let identity_section = match crate::engine::tools::get_memme_store() {
        Some(store) => match store.list_identity_traits(crate::engine::tools::MEMME_USER_ID) {
            Ok(traits) if !traits.is_empty() => {
                let lines: Vec<String> = traits.iter()
                    .take(10)
                    .map(|t| format!("- [{}] {} (confidence: {:.0}%)", t.trait_type.as_str(), t.content, t.confidence * 100.0))
                    .collect();
                format!("Identity traits:\n{}", lines.join("\n"))
            }
            _ => "No identity traits inferred yet.".to_string(),
        },
        None => "MemMe store not available.".to_string(),
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

    let response = chat_completion(config, &messages, &[])
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

    // Enrich with MemMe identity traits
    let identity_section = match crate::engine::tools::get_memme_store() {
        Some(store) => match store.list_identity_traits(crate::engine::tools::MEMME_USER_ID) {
            Ok(traits) if !traits.is_empty() => {
                let lines: Vec<String> = traits.iter()
                    .take(10)
                    .map(|t| format!("- [{}] {}", t.trait_type.as_str(), t.content))
                    .collect();
                format!("Identity insights:\n{}", lines.join("\n"))
            }
            _ => String::new(),
        },
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

    let journal = match chat_completion(config, &messages, &[]).await {
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

    // Enrich with MemMe identity traits
    let identity_summary = match crate::engine::tools::get_memme_store() {
        Some(store) => match store.list_identity_traits(crate::engine::tools::MEMME_USER_ID) {
            Ok(traits) if !traits.is_empty() => {
                traits.iter()
                    .take(5)
                    .map(|t| format!("- {}: {}", t.trait_type.as_str(), t.content))
                    .collect::<Vec<_>>()
                    .join("\n")
            }
            _ => String::new(),
        },
        None => String::new(),
    };

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
