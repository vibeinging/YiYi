//! Summary compression — intelligent truncation for compacted session summaries.

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
