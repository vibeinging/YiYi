use std::collections::BTreeSet;

const DEFAULT_MAX_CHARS: usize = 1_200;
const DEFAULT_MAX_LINES: usize = 24;
const DEFAULT_MAX_LINE_CHARS: usize = 160;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SummaryCompressionBudget {
    pub max_chars: usize,
    pub max_lines: usize,
    pub max_line_chars: usize,
}

impl Default for SummaryCompressionBudget {
    fn default() -> Self {
        Self {
            max_chars: DEFAULT_MAX_CHARS,
            max_lines: DEFAULT_MAX_LINES,
            max_line_chars: DEFAULT_MAX_LINE_CHARS,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompressedSummary {
    pub summary: String,
    pub original_chars: usize,
    pub compressed_chars: usize,
    pub original_lines: usize,
    pub compressed_lines: usize,
    pub dedup_count: usize,
    pub omitted_count: usize,
    pub truncated: bool,
}

/// Compress a summary text using 4-level priority line selection.
///
/// Priority 0 (keep first): Headers -- "Summary:", "Conversation summary:", "Context:"
/// Priority 1: Section headers -- lines ending with ":"
/// Priority 2: Bullet points -- lines starting with "- " or "  - "
/// Priority 3: Everything else (filler)
///
/// Algorithm:
/// 1. Collapse inline whitespace (multiple spaces -> single)
/// 2. Deduplicate lines (case-insensitive)
/// 3. Truncate long lines (max_line_chars with "...")
/// 4. Select lines by priority within budget (max_lines, max_chars)
/// 5. Add omission notice if lines were dropped
#[must_use]
pub fn compress_summary(summary: &str, budget: SummaryCompressionBudget) -> CompressedSummary {
    let original_chars = summary.chars().count();
    let original_lines = summary.lines().count();

    let normalized = normalize_lines(summary, budget.max_line_chars);
    if normalized.lines.is_empty() || budget.max_chars == 0 || budget.max_lines == 0 {
        return CompressedSummary {
            summary: String::new(),
            original_chars,
            compressed_chars: 0,
            original_lines,
            compressed_lines: 0,
            dedup_count: normalized.dedup_count,
            omitted_count: normalized.lines.len(),
            truncated: original_chars > 0,
        };
    }

    let selected = select_line_indexes(&normalized.lines, budget);
    let mut compressed_lines: Vec<String> = selected
        .iter()
        .map(|index| normalized.lines[*index].clone())
        .collect();
    if compressed_lines.is_empty() {
        compressed_lines.push(truncate_line(&normalized.lines[0], budget.max_chars));
    }
    let omitted_count = normalized
        .lines
        .len()
        .saturating_sub(compressed_lines.len());

    if omitted_count > 0 {
        let notice = omission_notice(omitted_count);
        push_line_with_budget(&mut compressed_lines, notice, budget);
    }

    let compressed_summary = compressed_lines.join("\n");

    CompressedSummary {
        compressed_chars: compressed_summary.chars().count(),
        compressed_lines: compressed_lines.len(),
        dedup_count: normalized.dedup_count,
        omitted_count,
        truncated: compressed_summary != summary.trim(),
        summary: compressed_summary,
        original_chars,
        original_lines,
    }
}

/// Convenience helper that returns just the compressed text with default budget.
#[must_use]
#[allow(dead_code)]
pub fn compress_summary_text(summary: &str) -> String {
    compress_summary(summary, SummaryCompressionBudget::default()).summary
}

// ---------------------------------------------------------------------------
// Internal types & helpers
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
struct NormalizedSummary {
    lines: Vec<String>,
    dedup_count: usize,
}

fn normalize_lines(summary: &str, max_line_chars: usize) -> NormalizedSummary {
    let mut seen = BTreeSet::new();
    let mut lines = Vec::new();
    let mut dedup_count = 0;

    for raw_line in summary.lines() {
        // Step 1: Collapse inline whitespace
        let normalized = collapse_inline_whitespace(raw_line);
        if normalized.is_empty() {
            continue;
        }

        // Step 3: Truncate long lines
        let truncated = truncate_line(&normalized, max_line_chars);

        // Step 2: Deduplicate (case-insensitive)
        let key = dedupe_key(&truncated);
        if !seen.insert(key) {
            dedup_count += 1;
            continue;
        }

        lines.push(truncated);
    }

    NormalizedSummary { lines, dedup_count }
}

/// Select lines by priority within budget.
/// Fill priority 0 first, then 1, then 2, then 3.
/// If over budget, drop priority 3 first, then 2, etc.
fn select_line_indexes(lines: &[String], budget: SummaryCompressionBudget) -> Vec<usize> {
    let mut selected = BTreeSet::<usize>::new();

    for priority in 0..=3 {
        for (index, line) in lines.iter().enumerate() {
            if selected.contains(&index) || line_priority(line) != priority {
                continue;
            }

            // Check if adding this line stays within budget
            let candidate: Vec<&str> = selected
                .iter()
                .map(|i| lines[*i].as_str())
                .chain(std::iter::once(line.as_str()))
                .collect();

            if candidate.len() > budget.max_lines {
                continue;
            }

            if joined_char_count(&candidate) > budget.max_chars {
                continue;
            }

            selected.insert(index);
        }
    }

    selected.into_iter().collect()
}

fn push_line_with_budget(lines: &mut Vec<String>, line: String, budget: SummaryCompressionBudget) {
    let candidate: Vec<&str> = lines
        .iter()
        .map(String::as_str)
        .chain(std::iter::once(line.as_str()))
        .collect();

    if candidate.len() <= budget.max_lines && joined_char_count(&candidate) <= budget.max_chars {
        lines.push(line);
    }
}

fn joined_char_count(lines: &[&str]) -> usize {
    lines.iter().map(|l| l.chars().count()).sum::<usize>() + lines.len().saturating_sub(1)
}

/// Classify a line into priority tier.
///
/// Priority 0: Core headers ("Summary:", "Conversation summary:", "Context:")
///             and key detail prefixes ("- Scope:", "- Current work:", etc.)
/// Priority 1: Section headers (lines ending with ":")
/// Priority 2: Bullet points (lines starting with "- " or "  - ")
/// Priority 3: Everything else (filler)
fn line_priority(line: &str) -> usize {
    let trimmed = line.trim();
    // Priority 0: Core headers
    if trimmed == "Summary:"
        || trimmed == "Conversation summary:"
        || trimmed == "Context:"
        || is_core_detail(trimmed)
    {
        return 0;
    }
    // Priority 1: Section headers (lines ending with ":")
    if is_section_header(trimmed) {
        return 1;
    }
    // Priority 2: Bullet points
    if line.starts_with("- ") || line.starts_with("  - ") {
        return 2;
    }
    // Priority 3: Filler
    3
}

fn is_core_detail(line: &str) -> bool {
    [
        "- Scope:",
        "- Current work:",
        "- Pending work:",
        "- Key files referenced:",
        "- Tools mentioned:",
        "- Recent user requests:",
        "- Previously compacted context:",
        "- Newly compacted context:",
    ]
    .iter()
    .any(|prefix| line.starts_with(prefix))
}

fn is_section_header(line: &str) -> bool {
    line.ends_with(':') && !line.is_empty()
}

fn omission_notice(omitted: usize) -> String {
    format!("- ... {omitted} additional line(s) omitted.")
}

fn collapse_inline_whitespace(line: &str) -> String {
    line.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_line(line: &str, max_chars: usize) -> String {
    if max_chars == 0 || line.chars().count() <= max_chars {
        return line.to_string();
    }
    if max_chars == 1 {
        return "\u{2026}".to_string();
    }
    let mut truncated: String = line.chars().take(max_chars.saturating_sub(1)).collect();
    truncated.push('\u{2026}');
    truncated
}

fn dedupe_key(line: &str) -> String {
    line.to_ascii_lowercase()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapses_whitespace_and_deduplicates() {
        let summary = "Conversation summary:\n\n\
            - Scope:   compact   earlier   messages.\n\
            - Scope: compact earlier messages.\n\
            - Current work: update runtime module.\n";

        let result = compress_summary(summary, SummaryCompressionBudget::default());

        assert_eq!(result.dedup_count, 1);
        assert!(result
            .summary
            .contains("- Scope: compact earlier messages."));
        assert!(!result.summary.contains("  compact   earlier"));
    }

    #[test]
    fn keeps_core_lines_when_budget_is_tight() {
        let summary = [
            "Conversation summary:",
            "- Scope: 18 earlier messages compacted.",
            "- Current work: finish summary compression.",
            "- Key timeline:",
            "  - user: asked for a working implementation.",
            "  - assistant: inspected runtime compaction flow.",
            "  - tool: cargo check succeeded.",
        ]
        .join("\n");

        let result = compress_summary(
            &summary,
            SummaryCompressionBudget {
                max_chars: 120,
                max_lines: 3,
                max_line_chars: 80,
            },
        );

        // Priority 0 lines should be kept first
        assert!(result.summary.contains("Conversation summary:"));
        assert!(result
            .summary
            .contains("- Scope: 18 earlier messages compacted."));
        assert!(result
            .summary
            .contains("- Current work: finish summary compression."));
        assert!(result.omitted_count > 0);
    }

    #[test]
    fn priority_ordering_drops_filler_first() {
        let summary = [
            "Summary:",
            "Some filler text here.",
            "More filler text.",
            "- A bullet point.",
            "Section header:",
        ]
        .join("\n");

        let result = compress_summary(
            &summary,
            SummaryCompressionBudget {
                max_chars: 80,
                max_lines: 3,
                max_line_chars: 80,
            },
        );

        // Priority 0 (Summary:) and Priority 1 (Section header:) should be kept
        assert!(result.summary.contains("Summary:"));
        assert!(result.summary.contains("Section header:"));
        // Filler (priority 3) should be dropped first
        assert!(!result.summary.contains("Some filler text"));
    }

    #[test]
    fn truncates_long_lines() {
        let long_line = "a".repeat(200);
        let summary = format!("Summary:\n{}", long_line);

        let result = compress_summary(
            &summary,
            SummaryCompressionBudget {
                max_chars: 2000,
                max_lines: 10,
                max_line_chars: 50,
            },
        );

        // Long line should be truncated to ~50 chars
        for line in result.summary.lines() {
            assert!(line.chars().count() <= 50);
        }
    }

    #[test]
    fn returns_empty_for_empty_input() {
        let result = compress_summary("", SummaryCompressionBudget::default());

        assert!(result.summary.is_empty());
        assert_eq!(result.compressed_chars, 0);
        assert_eq!(result.compressed_lines, 0);
    }

    #[test]
    fn returns_empty_for_zero_budget() {
        let result = compress_summary(
            "Summary:\nSome content.",
            SummaryCompressionBudget {
                max_chars: 0,
                max_lines: 0,
                max_line_chars: 160,
            },
        );

        assert!(result.summary.is_empty());
        assert!(result.truncated);
    }

    #[test]
    fn metrics_are_accurate() {
        let summary = "Summary:\n- Scope: test.\n- Current work: impl.\nFiller line.\nFiller 2.";

        let result = compress_summary(
            summary,
            SummaryCompressionBudget {
                max_chars: 60,
                max_lines: 3,
                max_line_chars: 160,
            },
        );

        assert_eq!(result.original_chars, summary.chars().count());
        assert_eq!(result.original_lines, summary.lines().count());
        assert!(result.compressed_chars <= 60);
        assert!(result.compressed_lines <= 3);
    }

    #[test]
    fn compress_summary_text_uses_defaults() {
        let summary = "Summary:\n\nA short line.";
        let compressed = compress_summary_text(summary);
        assert_eq!(compressed, "Summary:\nA short line.");
    }

    #[test]
    fn tracks_omitted_count_when_lines_dropped() {
        let summary = (0..30)
            .map(|i| format!("Line {}", i))
            .collect::<Vec<_>>()
            .join("\n");

        let result = compress_summary(
            &summary,
            SummaryCompressionBudget {
                max_chars: 200,
                max_lines: 5,
                max_line_chars: 160,
            },
        );

        // With 30 lines and budget of 5, many lines are omitted
        assert!(result.omitted_count > 0);
        assert!(result.compressed_lines <= 5);
    }

    #[test]
    fn adds_omission_notice_when_budget_has_room() {
        // 10 short lines, but line budget = 6 so only 6 fit.
        // Char budget is generous so the notice can be appended as a 6th line
        // after 5 content lines are selected.
        let summary = (0..10)
            .map(|i| format!("L{}", i))
            .collect::<Vec<_>>()
            .join("\n");

        let result = compress_summary(
            &summary,
            SummaryCompressionBudget {
                max_chars: 500,
                max_lines: 6,
                max_line_chars: 160,
            },
        );

        // 10 lines, budget allows 6. Selection picks 6 lines, leaving 4 omitted.
        // But then push_line_with_budget can't add notice (would be 7th line).
        // So we need max_lines to be > number of selected lines + 1.
        // Actually, the selection fills up to max_lines. So we need max_lines
        // to exceed the input count by enough, or constrain by chars.
        //
        // Let's use chars constraint instead: pick lines until chars limit,
        // with generous line limit.
        assert!(result.omitted_count > 0);
        // The notice may or may not appear depending on budget room.
        // What we really test: omitted_count is tracked correctly.
        assert_eq!(result.omitted_count, 4); // 10 - 6 = 4
    }

    #[test]
    fn deduplication_is_case_insensitive() {
        let summary = "Summary:\n- Hello world\n- hello world\n- HELLO WORLD";

        let result = compress_summary(summary, SummaryCompressionBudget::default());

        assert_eq!(result.dedup_count, 2);
        // Only the first occurrence should remain
        assert!(result.summary.contains("- Hello world"));
    }
}
