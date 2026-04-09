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

// ── Summary compression ─────────────────────────────────────────────────

/// Configuration for summary compression.
#[derive(Debug, Clone, Copy)]
pub struct CompressionConfig {
    pub max_chars: usize,
    pub max_lines: usize,
    pub max_line_chars: usize,
}

impl Default for CompressionConfig {
    fn default() -> Self {
        Self {
            max_chars: 1200,
            max_lines: 24,
            max_line_chars: 160,
        }
    }
}

/// Compressed summary with metrics.
pub struct CompressedSummary {
    pub text: String,
    pub original_chars: usize,
    pub compressed_chars: usize,
    pub lines_removed: usize,
}

/// Compress a summary to fit within budget.
pub fn compress_summary(summary: &str, config: CompressionConfig) -> CompressedSummary {
    let original_chars = summary.len();
    let lines: Vec<&str> = summary.lines().collect();

    // 1. Deduplicate consecutive identical lines
    let mut deduped: Vec<String> = Vec::new();
    for line in &lines {
        let trimmed = line.trim();
        if deduped.last().map_or(true, |prev: &String| prev.trim() != trimmed) {
            deduped.push(line.to_string());
        }
    }

    // 2. Truncate long lines
    for line in deduped.iter_mut() {
        if line.chars().count() > config.max_line_chars {
            *line = format!("{}...", line.chars().take(config.max_line_chars - 3).collect::<String>());
        }
    }

    // 3. Collapse multiple blank lines
    let mut collapsed: Vec<String> = Vec::new();
    let mut prev_blank = false;
    for line in &deduped {
        let is_blank = line.trim().is_empty();
        if is_blank && prev_blank {
            continue;
        }
        collapsed.push(line.clone());
        prev_blank = is_blank;
    }

    // 4. Trim to max_lines (keep head + tail)
    let lines_removed;
    let result = if collapsed.len() > config.max_lines {
        let head = 3;
        let tail = config.max_lines.saturating_sub(head + 1);
        let omitted = collapsed.len() - head - tail;
        lines_removed = omitted;
        let mut out: Vec<String> = collapsed[..head].to_vec();
        out.push(format!("[... {} lines omitted ...]", omitted));
        out.extend(collapsed[collapsed.len() - tail..].iter().cloned());
        out
    } else {
        lines_removed = 0;
        collapsed
    };

    // 5. Join and truncate total chars
    let mut text = result.join("\n");
    if text.len() > config.max_chars {
        text = format!(
            "{}... [truncated]",
            text.chars().take(config.max_chars - 15).collect::<String>()
        );
    }

    let compressed_chars = text.len();
    CompressedSummary {
        text,
        original_chars,
        compressed_chars,
        lines_removed,
    }
}

/// Generate a stable fingerprint for a workspace path (FNV-1a 64-bit).
pub fn workspace_fingerprint(path: &std::path::Path) -> String {
    let s = path.to_string_lossy();
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in s.bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{:016x}", hash)
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
