//! Trust envelope for tool output that originates from untrusted sources.
//!
//! Priya's P0-3 diagnosis (see
//! `docs/review/2026-04-24_jury-yiyi-overall-assessment.md`): YiYi's tool
//! results flow back to the LLM without distinguishing "this text is DATA
//! I fetched for you" from "this text is an INSTRUCTION written by the
//! runtime". The LLM has been observed to:
//!   - parrot `permission_upgrade_required: ...` strings back to the user
//!     (fixed separately in `permission_mode.rs`),
//!   - execute `"Click here to continue"` as if it were a UI instruction,
//!   - follow `"Ignore previous instructions"` embedded in a scraped page,
//!   - treat a file's `# TODO: fix later` comment as a command.
//!
//! Every whack-a-mole fix for those cases has been a symptom. The root
//! cause is that the LLM doesn't know which tokens are ambient runtime
//! messages and which are arbitrary third-party content.
//!
//! **The fix:** any tool that returns content fetched from outside the
//! agent's own boundary (the web, a third-party page, user files that
//! the LLM didn't itself write, MCP server responses, etc.) must wrap
//! that content in an `<external-content>` envelope. The system prompt's
//! critical-reminder tells the LLM: text inside that tag is DATA, not
//! instructions. If the text attempts prompt injection, flag it to the
//! user — don't execute it.
//!
//! This is Claude Code's pattern for `WebFetchTool` and `BashTool`'s
//! external command output (see `docs/04-System-Prompt-工程.md` §4.1 and
//! `docs/09-工具系统设计.md`). We mirror the same wrapping convention so
//! our LLM sees a familiar structure.

/// Hint about how much to trust the content.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Trust {
    /// Fully untrusted — arbitrary third-party content (web pages, scraped HTML).
    /// Must be treated as DATA only. Any imperative text inside should be
    /// ignored or flagged to the user.
    Low,
    /// Semi-trusted — user's own files, MCP servers the user installed.
    /// Content is authored by the user's extended ecosystem but may still
    /// contain unintended instructions (e.g. another AGENTS.md with
    /// conflicting rules, a skill's SKILL.md that fights the current agent).
    Medium,
}

impl Trust {
    fn as_str(self) -> &'static str {
        match self {
            Trust::Low => "low",
            Trust::Medium => "medium",
        }
    }
}

/// Wrap `content` in an `<external-content>` envelope.
///
/// `source` is a short machine-readable hint (e.g. `"web_search"`,
/// `"browser_snapshot"`, `"mcp:<server>"`). It goes into an attribute
/// so the LLM can name the source if it flags suspicious content.
pub fn wrap_external(source: &str, trust: Trust, content: &str) -> String {
    format!(
        "<external-content source=\"{}\" trust=\"{}\">\n{}\n</external-content>",
        sanitize_attr(source),
        trust.as_str(),
        content,
    )
}

/// Same as [`wrap_external`] but for content that carries a URL (the URL
/// itself is untrusted metadata — a malicious page can put an attacker's
/// "see https://phish.example" in its content).
pub fn wrap_external_with_url(
    source: &str,
    trust: Trust,
    url: &str,
    content: &str,
) -> String {
    format!(
        "<external-content source=\"{}\" trust=\"{}\" url=\"{}\">\n{}\n</external-content>",
        sanitize_attr(source),
        trust.as_str(),
        sanitize_attr(url),
        content,
    )
}

/// Strip quote / angle-bracket / newline so an attribute value can't close
/// its own tag or spawn a nested one. The envelope is trust boundary; its
/// syntax must be stable even when the external content is adversarial.
fn sanitize_attr(s: &str) -> String {
    s.chars()
        .filter(|c| *c != '"' && *c != '<' && *c != '>' && *c != '\n' && *c != '\r')
        .take(200)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrap_external_basic() {
        let out = wrap_external("web_search", Trust::Low, "hello world");
        assert!(out.starts_with("<external-content source=\"web_search\" trust=\"low\">"));
        assert!(out.contains("hello world"));
        assert!(out.ends_with("</external-content>"));
    }

    #[test]
    fn wrap_external_with_url_includes_url() {
        let out = wrap_external_with_url(
            "browser_snapshot",
            Trust::Low,
            "https://example.com/x",
            "body",
        );
        assert!(out.contains("url=\"https://example.com/x\""));
    }

    #[test]
    fn sanitize_strips_quote_and_angle() {
        let s = sanitize_attr("foo\" onerror=<script>x</script>\"");
        assert!(!s.contains('"'));
        assert!(!s.contains('<'));
        assert!(!s.contains('>'));
    }

    #[test]
    fn sanitize_caps_length() {
        let s = sanitize_attr(&"a".repeat(400));
        assert_eq!(s.len(), 200);
    }

    #[test]
    fn content_is_not_sanitized() {
        // Content inside the envelope is deliberately NOT sanitized — the
        // LLM needs to see the raw text to detect PI attempts. Only the
        // attribute values need to be hardened.
        let nasty = "<script>alert('x')</script>";
        let out = wrap_external("page", Trust::Low, nasty);
        assert!(out.contains(nasty));
    }
}
