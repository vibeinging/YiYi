use super::COMPACT_THRESHOLD;
use super::COMPACT_SUMMARY_FILE;
use crate::engine::llm_client::{chat_completion, LLMConfig, LLMMessage, MessageContent};
use crate::engine::token_counter::estimate_tokens;

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
    // Some API providers (DashScope/Qwen) require strict ordering:
    // assistant(tool_calls) must be immediately followed by its tool results.
    // Re-arrange by collecting tool messages and re-inserting after their parent assistant.
    let mut relocated = 0usize;
    let mut i = 0;
    while i < messages.len() {
        if messages[i].role == "tool" {
            let tool_call_id = match messages[i].tool_call_id.as_deref() {
                Some(id) if !id.is_empty() => id.to_string(),
                _ => { i += 1; continue; } // skip tool messages without valid ID
            };
            // Find the parent assistant
            let parent_idx = messages[..i].iter().rposition(|m| {
                m.role == "assistant"
                    && m.tool_calls.as_ref()
                        .map_or(false, |calls| calls.iter().any(|c| c.id == tool_call_id))
            });
            if let Some(pidx) = parent_idx {
                // Check if this tool message is already in the correct position
                // (immediately after parent assistant and any sibling tool messages)
                let mut expected_pos = pidx + 1;
                while expected_pos < messages.len()
                    && expected_pos < i
                    && messages[expected_pos].role == "tool"
                {
                    expected_pos += 1;
                }
                if expected_pos != i {
                    // Need to relocate: remove from current position, insert after parent's tool block
                    let tool_msg = messages.remove(i);
                    let mut insert_at = pidx + 1;
                    while insert_at < messages.len() && messages[insert_at].role == "tool" {
                        insert_at += 1;
                    }
                    messages.insert(insert_at, tool_msg);
                    relocated += 1;
                    continue; // don't increment i since we removed an element
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
// Context compaction
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

/// Compact messages when context exceeds threshold.
pub(super) async fn compact_messages_if_needed(
    messages: &mut Vec<LLMMessage>,
    config: &LLMConfig,
    working_dir: Option<&std::path::Path>,
) {
    let total = total_message_tokens(messages);
    if total < COMPACT_THRESHOLD || messages.len() < 6 {
        return;
    }

    log::info!(
        "Context compaction triggered: ~{} tokens, {} messages",
        total,
        messages.len()
    );

    // Find where the "head" (system messages) ends
    let keep_start = messages.iter()
        .position(|m| m.role != "system")
        .unwrap_or(1);

    let min_keep = 4;
    let mut mid_end = messages.len().saturating_sub(min_keep);
    if mid_end <= keep_start {
        return;
    }
    while mid_end > keep_start && messages[mid_end].role == "tool" {
        mid_end -= 1;
    }
    if mid_end <= keep_start {
        return;
    }
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

    let summary = if summary_parts.len() > 10 {
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
    };

    let summary_msg = LLMMessage {
        role: "system".into(),
        content: Some(MessageContent::text(format!(
            "[Previous context compacted — {} messages summarized]\n{}",
            middle.len(),
            summary
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
        total,
        new_total
    );

    *messages = new_messages;

    if let Some(dir) = working_dir {
        let summary_path = dir.join(COMPACT_SUMMARY_FILE);
        tokio::fs::write(&summary_path, &summary).await.ok();
        log::info!("Persisted compact summary to {}", summary_path.display());

        // Also write to memory/compacted/
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
