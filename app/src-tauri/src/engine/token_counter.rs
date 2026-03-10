/// Estimate token count for a string.
///
/// Uses a heuristic: CJK characters ≈ 1 token each,
/// other characters ≈ 1 token per 4 chars.
/// This is a rough approximation that works well enough for context management.
pub fn estimate_tokens(text: &str) -> usize {
    let mut cjk_chars = 0usize;
    let mut other_chars = 0usize;

    for ch in text.chars() {
        if is_cjk(ch) {
            cjk_chars += 1;
        } else {
            other_chars += 1;
        }
    }

    // CJK: ~1 token per char, Latin: ~1 token per 4 chars
    cjk_chars + (other_chars + 3) / 4
}

/// Estimate total tokens for a sequence of messages (role + content).
pub fn estimate_messages_tokens(messages: &[(String, String)]) -> usize {
    messages
        .iter()
        .map(|(role, content)| {
            // Each message has ~4 overhead tokens for role/formatting
            4 + estimate_tokens(role) + estimate_tokens(content)
        })
        .sum()
}

fn is_cjk(ch: char) -> bool {
    matches!(ch,
        '\u{4E00}'..='\u{9FFF}' |   // CJK Unified
        '\u{3400}'..='\u{4DBF}' |   // CJK Extension A
        '\u{F900}'..='\u{FAFF}' |   // CJK Compatibility
        '\u{3000}'..='\u{303F}' |   // CJK Symbols
        '\u{3040}'..='\u{309F}' |   // Hiragana
        '\u{30A0}'..='\u{30FF}' |   // Katakana
        '\u{AC00}'..='\u{D7AF}'     // Hangul
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_english_tokens() {
        // "hello world" = 11 chars → ~3 tokens
        assert!(estimate_tokens("hello world") >= 2);
        assert!(estimate_tokens("hello world") <= 5);
    }

    #[test]
    fn test_chinese_tokens() {
        // "你好世界" = 4 CJK chars → 4 tokens
        assert_eq!(estimate_tokens("你好世界"), 4);
    }

    #[test]
    fn test_mixed() {
        // "Hello 你好" = 6 latin + 2 CJK → ~2 + 2 = 4
        let tokens = estimate_tokens("Hello 你好");
        assert!(tokens >= 3 && tokens <= 5);
    }
}
