use super::COMPACT_THRESHOLD;
use crate::engine::llm_client::{chat_completion, LLMConfig, LLMMessage, MessageContent};
use crate::engine::token_counter::estimate_tokens;
use crate::engine::tools::{get_current_session_id, get_memme_store};

// ---------------------------------------------------------------------------
// Message sanitization — fix broken tool message sequences
// ---------------------------------------------------------------------------

/// Sanitize messages to prevent API errors from malformed tool sequences.
///
/// Fixes:
/// 1. Orphan tool results (tool messages without a preceding assistant tool_call)
/// 2. Missing tool results (assistant has tool_calls but no matching tool response)
/// 3. Tool messages not immediately following their parent assistant (strict APIs like DashScope)
pub(super) fn sanitize_messages(messages: &mut Vec<LLMMessage>) {
    use std::collections::{HashMap, HashSet};

    // Phase 1: Build a map of tool_call_id → assistant message index
    let mut tool_call_to_assistant: HashMap<String, usize> = HashMap::new();
    let mut seen_tool_ids: HashSet<String> = HashSet::new();

    for (i, msg) in messages.iter().enumerate() {
        if msg.role == "assistant" {
            if let Some(calls) = &msg.tool_calls {
                for call in calls {
                    tool_call_to_assistant.insert(call.id.clone(), i);
                }
            }
        }
        if msg.role == "tool" {
            if let Some(id) = &msg.tool_call_id {
                seen_tool_ids.insert(id.clone());
            }
        }
    }

    // Phase 2: Remove orphan tool messages (no matching assistant tool_call)
    let before = messages.len();
    messages.retain(|msg| {
        if msg.role == "tool" {
            if let Some(id) = &msg.tool_call_id {
                return tool_call_to_assistant.contains_key(id);
            }
            return false;
        }
        true
    });
    if messages.len() != before {
        log::info!("Sanitized: removed {} orphan tool messages", before - messages.len());
    }

    // Phase 3: Inject placeholders for missing tool results
    let expected_ids: HashSet<String> = tool_call_to_assistant.keys().cloned().collect();
    let missing_ids: Vec<String> = expected_ids.difference(&seen_tool_ids).cloned().collect();

    if !missing_ids.is_empty() {
        for id in &missing_ids {
            let assistant_idx = messages.iter().position(|m| {
                m.role == "assistant"
                    && m.tool_calls.as_ref()
                        .map_or(false, |calls| calls.iter().any(|c| &c.id == id))
            });
            if let Some(idx) = assistant_idx {
                let mut insert_at = idx + 1;
                while insert_at < messages.len() && messages[insert_at].role == "tool" {
                    insert_at += 1;
                }
                messages.insert(insert_at, LLMMessage {
                    role: "tool".into(),
                    content: Some(MessageContent::text("(result unavailable)")),
                    tool_calls: None,
                    tool_call_id: Some(id.clone()),
                });
            }
        }
        log::info!("Sanitized: injected {} placeholder tool results", missing_ids.len());
    }

    // Phase 4: Ensure tool messages immediately follow their parent assistant.
    let mut relocated = 0usize;
    let mut i = 0;
    while i < messages.len() {
        if messages[i].role == "tool" {
            let tool_call_id = match messages[i].tool_call_id.as_deref() {
                Some(id) if !id.is_empty() => id.to_string(),
                _ => { i += 1; continue; }
            };
            let parent_idx = messages[..i].iter().rposition(|m| {
                m.role == "assistant"
                    && m.tool_calls.as_ref()
                        .map_or(false, |calls| calls.iter().any(|c| c.id == tool_call_id))
            });
            if let Some(pidx) = parent_idx {
                let mut expected_pos = pidx + 1;
                while expected_pos < messages.len()
                    && expected_pos < i
                    && messages[expected_pos].role == "tool"
                {
                    expected_pos += 1;
                }
                if expected_pos != i {
                    let tool_msg = messages.remove(i);
                    let mut insert_at = pidx + 1;
                    while insert_at < messages.len() && messages[insert_at].role == "tool" {
                        insert_at += 1;
                    }
                    messages.insert(insert_at, tool_msg);
                    relocated += 1;
                    continue;
                }
            }
        }
        i += 1;
    }
    if relocated > 0 {
        log::info!("Sanitized: relocated {} tool messages to correct positions", relocated);
    }
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/// Estimate total token count of all messages.
fn total_message_tokens(messages: &[LLMMessage]) -> usize {
    messages
        .iter()
        .map(|m| {
            let content_tokens = m.content.as_ref().and_then(|c| c.as_text()).map_or(0, estimate_tokens);
            let tool_tokens = m
                .tool_calls
                .as_ref()
                .map_or(0, |calls| {
                    calls.iter().map(|c| estimate_tokens(&c.function.arguments)).sum::<usize>()
                });
            4 + content_tokens + tool_tokens
        })
        .sum()
}

// ---------------------------------------------------------------------------
// Head / middle / tail split logic (shared)
// ---------------------------------------------------------------------------

/// Returns (keep_start, mid_end) indices for compaction split.
/// - keep_start: end of system messages (preserved)
/// - mid_end: start of tail (preserved, last min_keep messages)
fn find_compaction_split(messages: &[LLMMessage]) -> Option<(usize, usize)> {
    let keep_start = messages.iter()
        .position(|m| m.role != "system")
        .unwrap_or(1);

    let min_keep = 4;
    let mut mid_end = messages.len().saturating_sub(min_keep);
    if mid_end <= keep_start {
        return None;
    }
    while mid_end > keep_start && messages[mid_end].role == "tool" {
        mid_end -= 1;
    }
    if mid_end <= keep_start {
        return None;
    }
    Some((keep_start, mid_end))
}

// ---------------------------------------------------------------------------
// Shared SessionContext → String formatting
// ---------------------------------------------------------------------------

/// Format a MemMe SessionContext into a human-readable summary string.
fn format_session_context(ctx: &memme_core::types::SessionContext) -> Option<String> {
    if ctx.events.is_empty() && ctx.episode_summary.is_none() {
        return None;
    }

    let mut parts = Vec::new();
    if let Some(ref ep_summary) = ctx.episode_summary {
        parts.push(ep_summary.clone());
    }
    for event in &ctx.events {
        let content = event.purified_content.as_ref()
            .unwrap_or(&event.content);
        let content_preview: String = content.chars().take(200).collect();
        parts.push(format!("- [{}] {}", event.event_type.as_str(), content_preview));
    }
    Some(parts.join("\n"))
}

// ---------------------------------------------------------------------------
// Shared MemMe context retrieval helper
// ---------------------------------------------------------------------------

/// Fetch SessionContext from MemMe via spawn_blocking, returning the formatted
/// summary string. Returns None on any error (logged as warning).
async fn fetch_memme_context(session_id: &str, token_budget: usize) -> Option<String> {
    let store = get_memme_store()?;

    let context = tokio::task::spawn_blocking({
        let store = store.clone();
        let sid = session_id.to_string();
        move || {
            store.get_session_context(
                &sid,
                memme_core::types::GetSessionContextOptions::new()
                    .token_budget(token_budget)
                    .include_summary(true)
                    .include_all(),
            )
        }
    }).await;

    match context {
        Ok(Ok(ctx)) => format_session_context(&ctx),
        Ok(Err(e)) => {
            log::warn!("MemMe get_session_context failed: {}", e);
            None
        }
        Err(e) => {
            log::warn!("MemMe get_session_context task panicked: {}", e);
            None
        }
    }
}

// ---------------------------------------------------------------------------
// MemMe-backed summary generation
// ---------------------------------------------------------------------------

/// Generate context summary via MemMe's compact + get_session_context pipeline.
async fn generate_memme_summary(session_id: &str) -> Option<String> {
    let store = get_memme_store()?;

    // Compact any unprocessed events (no-op if none pending)
    let compact_result = tokio::task::spawn_blocking({
        let store = store.clone();
        let sid = session_id.to_string();
        move || store.compact(&sid)
    }).await;

    match compact_result {
        Ok(Ok(cr)) => {
            log::debug!(
                "MemMe compaction: session {} -> episode {} ({} events processed)",
                cr.session_id, cr.episode_id, cr.events_processed
            );
        }
        Ok(Err(e)) => {
            log::warn!("MemMe compact failed: {}", e);
        }
        Err(e) => {
            log::warn!("MemMe compact task panicked: {}", e);
        }
    }

    fetch_memme_context(session_id, 2000).await
}

// ---------------------------------------------------------------------------
// Legacy preview-based summary generation (fallback)
// ---------------------------------------------------------------------------

/// Generate summary from message previews, optionally using LLM for long sequences.
async fn generate_preview_summary(messages: &[LLMMessage], config: &LLMConfig) -> String {
    let (keep_start, mid_end) = match find_compaction_split(messages) {
        Some(split) => split,
        None => return String::new(),
    };

    let middle: Vec<&LLMMessage> = messages[keep_start..mid_end].iter().collect();

    let mut summary_parts: Vec<String> = Vec::new();
    for msg in &middle {
        match msg.role.as_str() {
            "assistant" => {
                if let Some(calls) = &msg.tool_calls {
                    for call in calls {
                        summary_parts.push(format!("- Called tool: {}", call.function.name));
                    }
                }
                if let Some(text) = msg.content.as_ref().and_then(|c| c.as_text()) {
                    if !text.is_empty() {
                        let preview: String = text.chars().take(200).collect();
                        summary_parts.push(format!("- Assistant: {}...", preview));
                    }
                }
            }
            "user" => {
                if let Some(text) = msg.content.as_ref().and_then(|c| c.as_text()) {
                    let preview: String = text.chars().take(100).collect();
                    summary_parts.push(format!("- User: {}...", preview));
                }
            }
            "tool" => {
                if let Some(text) = msg.content.as_ref().and_then(|c| c.as_text()) {
                    let preview: String = text.chars().take(100).collect();
                    summary_parts.push(format!("  Result: {}...", preview));
                }
            }
            _ => {}
        }
    }

    if summary_parts.len() > 10 {
        let summary_request = format!(
            "Summarize these previous interactions concisely (max 500 chars):\n{}",
            summary_parts.join("\n")
        );
        let summary_msgs = vec![LLMMessage {
            role: "user".into(),
            content: Some(MessageContent::text(summary_request)),
            tool_calls: None,
            tool_call_id: None,
        }];
        match chat_completion(config, &summary_msgs, &[]).await {
            Ok(resp) => resp
                .message
                .content
                .map(|c| c.into_text())
                .unwrap_or_else(|| summary_parts.join("\n")),
            Err(_) => summary_parts.join("\n"),
        }
    } else {
        summary_parts.join("\n")
    }
}

// ---------------------------------------------------------------------------
// Apply compaction — replace middle messages with summary
// ---------------------------------------------------------------------------

/// Apply compaction: system head + summary message + raw tail.
async fn apply_compaction(
    messages: &mut Vec<LLMMessage>,
    summary: &str,
    working_dir: Option<&std::path::Path>,
    original_total: usize,
) {
    if summary.is_empty() {
        return;
    }

    let (keep_start, mid_end) = match find_compaction_split(messages) {
        Some(split) => split,
        None => return,
    };

    let middle_count = mid_end - keep_start;

    let summary_msg = LLMMessage {
        role: "system".into(),
        content: Some(MessageContent::text(format!(
            "[Previous context compacted — {} messages summarized]\n{}",
            middle_count, summary
        ))),
        tool_calls: None,
        tool_call_id: None,
    };

    let mut new_messages = Vec::new();
    new_messages.extend(messages[..keep_start].iter().cloned());
    new_messages.push(summary_msg);
    new_messages.extend(messages[mid_end..].iter().cloned());

    let new_total = total_message_tokens(&new_messages);
    log::info!(
        "Compacted: {} → {} messages, ~{} → ~{} tokens",
        messages.len(),
        new_messages.len(),
        original_total,
        new_total
    );

    *messages = new_messages;

    // Persist to memory/compacted/ for audit
    if let Some(dir) = working_dir {
        let compacted_dir = dir.join("memory").join("compacted");
        tokio::fs::create_dir_all(&compacted_dir).await.ok();
        let date = chrono::Local::now().format("%Y-%m-%d").to_string();
        let compacted_path = compacted_dir.join(format!("compacted_{}.md", date));
        let entry = format!(
            "\n## Compacted at {}\n\n{}\n\n---\n",
            chrono::Local::now().format("%Y-%m-%d %H:%M"),
            summary
        );
        use tokio::io::AsyncWriteExt;
        if let Ok(mut f) = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&compacted_path)
            .await
        {
            f.write_all(entry.as_bytes()).await.ok();
        }
    }
}

// ---------------------------------------------------------------------------
// Context compaction entry point
// ---------------------------------------------------------------------------

/// Compact messages when context exceeds threshold.
/// Uses MemMe for summary generation when available, falls back to preview-based summary.
pub(super) async fn compact_messages_if_needed(
    messages: &mut Vec<LLMMessage>,
    config: &LLMConfig,
    working_dir: Option<&std::path::Path>,
) {
    let total = total_message_tokens(messages);
    if total < COMPACT_THRESHOLD || messages.len() < 6 {
        return;
    }
    log::info!("Context compaction triggered: ~{} tokens, {} messages", total, messages.len());
    do_compact(messages, config, working_dir, total).await;
}

/// Force compaction regardless of token count — used for context overflow recovery.
pub(super) async fn force_compact_messages(
    messages: &mut Vec<LLMMessage>,
    config: &LLMConfig,
    working_dir: Option<&std::path::Path>,
) {
    if messages.len() < 4 {
        log::warn!("Cannot force-compact: too few messages ({})", messages.len());
        return;
    }
    let total = total_message_tokens(messages);
    log::info!("Force compaction (context overflow recovery): ~{} tokens, {} messages", total, messages.len());
    do_compact(messages, config, working_dir, total).await;
}

async fn do_compact(
    messages: &mut Vec<LLMMessage>,
    config: &LLMConfig,
    working_dir: Option<&std::path::Path>,
    total: usize,
) {
    let session_id = get_current_session_id();
    let raw_summary = if !session_id.is_empty() {
        match generate_memme_summary(&session_id).await {
            Some(s) => s,
            None => generate_preview_summary(messages, config).await,
        }
    } else {
        generate_preview_summary(messages, config).await
    };

    // Compress the summary to stay within token budget
    let compressed = crate::engine::compact::compress_summary(
        &raw_summary,
        crate::engine::compact::SummaryCompressionBudget::default(),
    );
    if compressed.omitted_count > 0 || compressed.compressed_chars < compressed.original_chars {
        log::info!(
            "Compact summary compressed: {} → {} chars, {} lines omitted, {} deduped",
            compressed.original_chars, compressed.compressed_chars,
            compressed.omitted_count, compressed.dedup_count
        );
    }
    apply_compaction(messages, &compressed.summary, working_dir, total).await;
}

// ---------------------------------------------------------------------------
// Initial context loading from MemMe
// ---------------------------------------------------------------------------

/// Load session context summary from MemMe for initial context injection.
pub(crate) async fn load_memme_context(session_id: &str) -> Option<String> {
    if session_id.is_empty() {
        return None;
    }
    fetch_memme_context(session_id, 3000).await
}
