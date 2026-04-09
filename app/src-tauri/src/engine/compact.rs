//! Session compaction — summarize old messages to free context window.
//!
//! When a conversation exceeds the token threshold, old messages are removed
//! and replaced with a concise summary, preserving recent messages verbatim.

/// Configuration for session compaction.
#[derive(Debug, Clone, Copy)]
pub struct CompactionConfig {
    /// Number of recent messages to preserve verbatim.
    pub preserve_recent_messages: usize,
    /// Compact when estimated tokens exceed this threshold.
    pub max_estimated_tokens: usize,
}

impl Default for CompactionConfig {
    fn default() -> Self {
        Self {
            preserve_recent_messages: 4,
            max_estimated_tokens: 10_000,
        }
    }
}

/// Result of a compaction operation.
pub struct CompactionResult {
    /// Summary text of removed messages.
    pub summary: String,
    /// Number of messages removed.
    pub removed_message_count: usize,
}

/// Rough token estimate for a text string (~4 chars per token).
pub fn estimate_tokens(text: &str) -> usize {
    text.len() / 4 + 1
}

/// Check if compaction is needed based on message count and token estimate.
pub fn should_compact(
    message_count: usize,
    total_estimated_tokens: usize,
    config: &CompactionConfig,
) -> bool {
    let compactable = message_count.saturating_sub(config.preserve_recent_messages);
    compactable > 0 && total_estimated_tokens >= config.max_estimated_tokens
}

/// Build a summary of messages to be removed.
/// Takes the messages that will be compacted (not the preserved ones).
pub fn summarize_messages(messages: &[(String, String)]) -> String {
    // messages: Vec<(role, content)>
    let user_count = messages.iter().filter(|(r, _)| r == "user").count();
    let assistant_count = messages.iter().filter(|(r, _)| r == "assistant").count();
    let tool_count = messages.iter().filter(|(r, _)| r == "tool").count();

    // Collect unique tool names mentioned
    let mut tool_names: Vec<String> = Vec::new();
    for (role, content) in messages {
        if role == "tool" || role == "assistant" {
            // Simple heuristic: look for tool-like patterns
            for word in content.split_whitespace() {
                if word.contains('_') && word.len() > 3 && word.len() < 40 {
                    let clean = word.trim_matches(|c: char| !c.is_alphanumeric() && c != '_');
                    if !tool_names.contains(&clean.to_string()) {
                        tool_names.push(clean.to_string());
                    }
                }
            }
        }
    }

    // Last few user messages as context
    let recent_user: Vec<&str> = messages
        .iter()
        .filter(|(r, _)| r == "user")
        .map(|(_, c)| c.as_str())
        .rev()
        .take(3)
        .collect();

    let mut summary = String::new();
    summary.push_str(&format!(
        "Compacted {} messages ({} user, {} assistant, {} tool).\n",
        messages.len(), user_count, assistant_count, tool_count
    ));

    if !tool_names.is_empty() {
        tool_names.truncate(10);
        summary.push_str(&format!("Tools used: {}\n", tool_names.join(", ")));
    }

    if !recent_user.is_empty() {
        summary.push_str("Recent user requests:\n");
        for msg in recent_user.iter().rev() {
            let truncated: String = msg.chars().take(160).collect();
            let suffix = if msg.len() > 160 { "..." } else { "" };
            summary.push_str(&format!("- {truncated}{suffix}\n"));
        }
    }

    summary
}

/// Build the continuation message that replaces compacted content.
pub fn build_continuation_message(summary: &str, recent_messages_preserved: usize) -> String {
    let mut msg = String::from(
        "This session is being continued from a previous conversation that ran out of context. \
         The summary below covers the earlier portion of the conversation.\n\n",
    );
    msg.push_str("Summary:\n");
    msg.push_str(summary);
    msg.push('\n');
    if recent_messages_preserved > 0 {
        msg.push_str(&format!(
            "The most recent {} messages are preserved verbatim below.\n",
            recent_messages_preserved
        ));
    }
    msg.push_str(
        "Continue the conversation from where it left off. \
         Do not acknowledge the summary or recap what was happening.",
    );
    msg
}
