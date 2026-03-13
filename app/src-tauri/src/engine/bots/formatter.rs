/// Platform-specific message formatting utilities.
///
/// Converts Markdown content from the agent's response into the most appropriate
/// format for each bot platform. Every function provides a plain-text fallback
/// so that message delivery is never blocked by formatting issues.

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

/// Discord natively supports Markdown, so we mostly pass through.
/// The only thing we need to do is split long messages at the 2000-char limit
/// on paragraph boundaries (not mid-word).
pub fn format_discord(content: &str) -> Vec<String> {
    split_on_boundaries(content, 2000)
}

// ---------------------------------------------------------------------------
// Telegram  – MarkdownV2
// ---------------------------------------------------------------------------

/// Characters that must be escaped in Telegram MarkdownV2 *outside* of code spans/blocks.
const TELEGRAM_SPECIAL: &[char] = &[
    '_', '*', '[', ']', '(', ')', '~', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!',
];

/// Convert Markdown to Telegram MarkdownV2 format.
/// Returns `(text, parse_mode)`.  If conversion looks risky we fall back to
/// plain text (`parse_mode = None`).
pub fn format_telegram(content: &str) -> (String, Option<&'static str>) {
    match try_convert_telegram_md(content) {
        Some(converted) => (converted, Some("MarkdownV2")),
        None => (content.to_string(), None),
    }
}

/// Best-effort conversion.  Returns `None` when the input is too complex
/// to safely convert (e.g. deeply nested formatting).
fn try_convert_telegram_md(content: &str) -> Option<String> {
    let mut result = String::with_capacity(content.len() * 2);
    let mut chars = content.chars().peekable();
    let mut in_code_block = false;
    let mut in_inline_code = false;

    while let Some(ch) = chars.next() {
        // --- code blocks (```) ---
        if ch == '`' && chars.peek() == Some(&'`') {
            // Check for triple backtick
            let second = chars.next(); // consume second `
            if chars.peek() == Some(&'`') {
                let _third = chars.next(); // consume third `
                in_code_block = !in_code_block;
                result.push_str("```");
                if in_code_block {
                    // skip language identifier on same line
                    while let Some(&c) = chars.peek() {
                        if c == '\n' {
                            break;
                        }
                        result.push(chars.next().unwrap());
                    }
                }
                continue;
            } else {
                // It was just two backticks — treat as inline code boundary
                // Push them back as-is
                if in_code_block {
                    result.push('`');
                    if let Some(s) = second {
                        result.push(s);
                    }
                } else {
                    result.push('`');
                    if let Some(s) = second {
                        result.push(s);
                    }
                }
                continue;
            }
        }

        // --- inline code (`) ---
        if ch == '`' && !in_code_block {
            in_inline_code = !in_inline_code;
            result.push('`');
            continue;
        }

        // Inside code blocks/spans: only escape ` and `\`
        if in_code_block || in_inline_code {
            if ch == '\\' {
                result.push_str("\\\\");
            } else if ch == '`' {
                result.push_str("\\`");
            } else {
                result.push(ch);
            }
            continue;
        }

        // Outside code: escape Telegram special chars
        if TELEGRAM_SPECIAL.contains(&ch) {
            result.push('\\');
            result.push(ch);
        } else {
            result.push(ch);
        }
    }

    // If we ended with unclosed code blocks, bail to plain text
    if in_code_block || in_inline_code {
        return None;
    }

    Some(result)
}

/// Split Telegram messages at the 4096-char API limit.
pub fn split_telegram(text: &str) -> Vec<String> {
    split_on_boundaries(text, 4000)
}

// ---------------------------------------------------------------------------
// DingTalk
// ---------------------------------------------------------------------------

/// Format content for DingTalk markdown message type.
/// Returns `(title, text)` for use with `msgtype: "markdown"`.
/// DingTalk supports: bold, links, ordered/unordered lists, headings.
pub fn format_dingtalk(content: &str) -> (String, String) {
    let title = extract_title(content, 20);
    // DingTalk markdown is close to standard Markdown; pass through as-is.
    (title, content.to_string())
}

// ---------------------------------------------------------------------------
// Feishu
// ---------------------------------------------------------------------------

/// Determine whether the content contains markdown formatting that would
/// benefit from rich-text rendering.
pub fn has_markdown_formatting(content: &str) -> bool {
    // Check for common markdown patterns
    content.contains("```")
        || content.contains("**")
        || content.contains("##")
        || content.contains("- ")
        || content.contains("1. ")
        || content.contains("[](")
        || content.contains("](")
}

/// Format content for Feishu.
/// For simple messages, returns `("text", json_content_string)`.
/// For messages with markdown, still uses "text" type since Feishu's text
/// messages render basic markdown-like patterns reasonably well.
/// The caller can decide to use "post" type for more complex cases.
pub fn format_feishu(content: &str) -> (&'static str, String) {
    // Feishu "text" msg_type expects: {"text": "..."} as a JSON string
    // For now, always use text type — Feishu's text rendering handles
    // basic formatting and the "post" type requires complex nested JSON
    // that is hard to auto-generate from arbitrary markdown.
    ("text", serde_json::json!({"text": content}).to_string())
}

/// Build a Feishu "post" (rich text) message for content that has a clear
/// title and body.  This is a simplified builder that puts the whole text
/// into a single paragraph.
pub fn format_feishu_post(content: &str) -> (&'static str, String) {
    let title = extract_title(content, 30);
    // Build the post structure with a single text element per line
    let lines: Vec<serde_json::Value> = content
        .lines()
        .map(|line| {
            serde_json::json!([{"tag": "text", "text": format!("{}\n", line)}])
        })
        .collect();

    let post = serde_json::json!({
        "zh_cn": {
            "title": title,
            "content": lines,
        }
    });
    ("post", post.to_string())
}

// ---------------------------------------------------------------------------
// QQ
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// WeCom (WeChat Work)
// ---------------------------------------------------------------------------

/// Format content for WeCom.
/// WeCom's text message type doesn't support markdown.
/// The "markdown" msgtype only works in certain message card scenarios.
/// For now, send as plain text.
pub fn format_wecom(content: &str) -> String {
    strip_markdown_keep_code(content)
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// Split text into chunks not exceeding `max_len` characters.
/// Tries to split on paragraph boundaries (double newlines), then single
/// newlines, then spaces.  Never splits mid-word unless unavoidable.
fn split_on_boundaries(text: &str, max_len: usize) -> Vec<String> {
    if text.len() <= max_len {
        return vec![text.to_string()];
    }

    let mut chunks = Vec::new();
    let mut remaining = text;

    while !remaining.is_empty() {
        if remaining.len() <= max_len {
            chunks.push(remaining.to_string());
            break;
        }

        // Find a split point within max_len
        let search_region = &remaining[..max_len];

        // Try paragraph boundary (double newline)
        let split_pos = search_region
            .rfind("\n\n")
            // Then try single newline
            .or_else(|| search_region.rfind('\n'))
            // Then try space
            .or_else(|| search_region.rfind(' '))
            // Last resort: hard split at max_len
            .unwrap_or(max_len);

        // Ensure we actually make progress
        let split_pos = if split_pos == 0 { max_len.min(remaining.len()) } else { split_pos };

        let (chunk, rest) = remaining.split_at(split_pos);
        chunks.push(chunk.to_string());

        // Skip the delimiter character(s)
        remaining = rest.trim_start_matches('\n').trim_start_matches(' ');
        if remaining.is_empty() {
            break;
        }
    }

    chunks
}

/// Extract a title from the content. Uses the first heading if present,
/// otherwise takes the first N characters of the first line.
fn extract_title(content: &str, max_chars: usize) -> String {
    for line in content.lines() {
        let trimmed = line.trim();
        // Check for markdown heading
        if let Some(heading) = trimmed.strip_prefix('#') {
            let heading = heading.trim_start_matches('#').trim();
            if !heading.is_empty() {
                return truncate_str(heading, max_chars);
            }
        }
        // Use first non-empty line
        if !trimmed.is_empty() {
            return truncate_str(trimmed, max_chars);
        }
    }
    "Reply".to_string()
}

/// Truncate a string to at most `max` characters, appending "..." if truncated.
fn truncate_str(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(max.saturating_sub(3)).collect();
        format!("{}...", truncated)
    }
}

/// Strip markdown formatting but keep code blocks readable.
/// This is a simple best-effort conversion for platforms that don't support markdown.
fn strip_markdown_keep_code(content: &str) -> String {
    let mut result = String::with_capacity(content.len());
    let mut in_code_block = false;

    for line in content.lines() {
        let trimmed = line.trim();

        // Toggle code block
        if trimmed.starts_with("```") {
            in_code_block = !in_code_block;
            if in_code_block {
                result.push_str("---\n");
            } else {
                result.push_str("---\n");
            }
            continue;
        }

        if in_code_block {
            // Keep code as-is
            result.push_str(line);
            result.push('\n');
            continue;
        }

        // Strip heading markers
        let line_out = if trimmed.starts_with('#') {
            let stripped = trimmed.trim_start_matches('#').trim();
            stripped.to_string()
        } else {
            // Strip bold/italic markers
            line.replace("**", "")
                .replace("__", "")
                .replace('*', "")
                .replace('_', " ")
        };

        result.push_str(&line_out);
        result.push('\n');
    }

    result.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_split_on_boundaries_short() {
        let text = "Hello world";
        let chunks = split_on_boundaries(text, 2000);
        assert_eq!(chunks, vec!["Hello world"]);
    }

    #[test]
    fn test_split_on_boundaries_long() {
        let text = "A".repeat(2500);
        let chunks = split_on_boundaries(&text, 2000);
        assert_eq!(chunks.len(), 2);
        assert!(chunks[0].len() <= 2000);
    }

    #[test]
    fn test_split_on_paragraph() {
        let text = format!("{}\n\n{}", "A".repeat(100), "B".repeat(100));
        let chunks = split_on_boundaries(&text, 150);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0], "A".repeat(100));
    }

    #[test]
    fn test_telegram_escape() {
        let (text, mode) = format_telegram("Hello *world* and [link](http://example.com)");
        assert_eq!(mode, Some("MarkdownV2"));
        assert!(text.contains("\\*"));
        assert!(text.contains("\\["));
    }

    #[test]
    fn test_telegram_code_block_preserved() {
        let input = "Before\n```rust\nlet x = 1;\n```\nAfter";
        let (text, mode) = format_telegram(input);
        assert_eq!(mode, Some("MarkdownV2"));
        assert!(text.contains("```"));
        assert!(text.contains("let x = 1;"));
    }

    #[test]
    fn test_dingtalk_title() {
        let (title, text) = format_dingtalk("# My Heading\n\nSome content here");
        assert_eq!(title, "My Heading");
        assert_eq!(text, "# My Heading\n\nSome content here");
    }

    #[test]
    fn test_extract_title_no_heading() {
        let title = extract_title("Just some text without headings", 20);
        assert_eq!(title, "Just some text wi...");
    }

    #[test]
    fn test_has_markdown_formatting() {
        assert!(has_markdown_formatting("**bold**"));
        assert!(has_markdown_formatting("```code```"));
        assert!(!has_markdown_formatting("plain text"));
    }
}
