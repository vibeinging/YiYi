//! Tool-output envelopes.
//!
//! Two distinct envelope concepts live here, deliberately co-located so
//! anyone touching tool I/O sees both ideas next to each other:
//!
//! ## 1. Trust envelope (`<external-content>`)
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
//!
//! ## 2. Multimodal envelope ([`MultimodalEnvelope`])
//!
//! Tools whose primary product is non-text (screenshots, generated
//! charts, in the future audio / video) used to return an implicit
//! `(String, Vec<String>)` tuple. Every callsite then re-derived "does
//! this provider support vision?" before deciding whether to feed the
//! images into the model. The condition was inlined in core.rs and
//! easy to forget at new callsites; adding audio support would mean
//! editing every dispatch point.
//!
//! [`MultimodalEnvelope`] makes the protocol explicit: a tool produces
//! one envelope; the runtime calls [`MultimodalEnvelope::dispatch_for`]
//! once, the envelope decides what each provider class actually receives.
//! When a future vision-less provider (or vice versa) shows up, the
//! decision lives in one place.

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

// ─────────────────────────────────────────────────────────────────────
// Multimodal envelope
// ─────────────────────────────────────────────────────────────────────

/// What a tool with non-text output (screenshots, charts) hands back to
/// the runtime. The runtime, not the tool, decides which fields make it
/// into the LLM context based on provider capability.
///
/// Use the constructors ([`text_only`](Self::text_only) /
/// [`with_images`](Self::with_images)) rather than building the struct
/// directly — future fields (audio, video, structured data) can land
/// without breaking call sites.
#[derive(Debug, Clone, Default)]
pub struct MultimodalEnvelope {
    /// Always populated. Self-contained text the model can read on its
    /// own — vision-less providers see only this. Should describe what
    /// the visual artifact contains so a text-only model isn't left
    /// guessing (e.g. "screenshot 1280x800, ~380 KB, primary window
    /// shows VS Code editing prompt.rs").
    text_summary: String,
    /// Image data URIs (`data:image/<mime>;base64,...`). Empty when the
    /// tool produced no images. Vision-capable providers receive these
    /// as OpenAI-style `image_url` content parts; text-only providers
    /// don't see them at all.
    images: Vec<String>,
}

impl MultimodalEnvelope {
    /// Build an envelope with only a text payload.
    pub fn text_only(summary: impl Into<String>) -> Self {
        Self {
            text_summary: summary.into(),
            images: Vec::new(),
        }
    }

    /// Build an envelope that pairs a text summary with one or more image
    /// data URIs. Empty `images` is allowed and behaves like
    /// [`text_only`](Self::text_only).
    pub fn with_images(summary: impl Into<String>, images: Vec<String>) -> Self {
        Self {
            text_summary: summary.into(),
            images,
        }
    }

    /// Plain-text body. Always defined, even when images are present —
    /// vision-less providers consume this field directly.
    pub fn text_summary(&self) -> &str {
        &self.text_summary
    }

    /// Borrow the image data URIs. Empty slice when there are none.
    pub fn images(&self) -> &[String] {
        &self.images
    }

    /// True when the envelope contains payload that vision-less
    /// providers cannot consume. Callers can use this to skip the
    /// vision-capability lookup entirely when no images are involved.
    pub fn has_visual_payload(&self) -> bool {
        !self.images.is_empty()
    }

    /// Decide what the LLM actually sees, given a provider capability
    /// flag. Returns `(text, images)`:
    ///
    /// * `vision_capable == true`  → `(text_summary, images)` — both flow
    ///   into the tool message; with_images gets to do its job.
    /// * `vision_capable == false` → `(text_summary, [])` — images are
    ///   dropped because the provider would error / hallucinate on them.
    ///
    /// The runtime should fold this into an `LLMMessage::tool` content
    /// using `MessageContent::text` (no images) or
    /// `MessageContent::with_images` (with images).
    pub fn dispatch_for(&self, vision_capable: bool) -> (String, Vec<String>) {
        if vision_capable && !self.images.is_empty() {
            (self.text_summary.clone(), self.images.clone())
        } else {
            (self.text_summary.clone(), Vec::new())
        }
    }
}

impl From<(String, Vec<String>)> for MultimodalEnvelope {
    /// Compatibility shim for tools that still hand back a raw
    /// `(text, images)` tuple. New tools should call
    /// [`MultimodalEnvelope::with_images`] directly.
    fn from((text, images): (String, Vec<String>)) -> Self {
        Self::with_images(text, images)
    }
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

    // ── MultimodalEnvelope ────────────────────────────────────────────

    #[test]
    fn multimodal_text_only_yields_empty_image_vec_either_way() {
        let env = MultimodalEnvelope::text_only("just text");
        let (text, imgs) = env.dispatch_for(true);
        assert_eq!(text, "just text");
        assert!(imgs.is_empty());

        let (text2, imgs2) = env.dispatch_for(false);
        assert_eq!(text2, "just text");
        assert!(imgs2.is_empty());
        assert!(!env.has_visual_payload());
    }

    #[test]
    fn multimodal_with_images_dispatches_images_only_to_vision_providers() {
        let env = MultimodalEnvelope::with_images(
            "screenshot 1280x800",
            vec!["data:image/jpeg;base64,/9j/A".to_string()],
        );
        let (text, imgs) = env.dispatch_for(true);
        assert_eq!(text, "screenshot 1280x800");
        assert_eq!(imgs.len(), 1);
        assert!(env.has_visual_payload());
    }

    #[test]
    fn multimodal_text_only_provider_drops_images() {
        let env = MultimodalEnvelope::with_images(
            "screenshot 1280x800",
            vec!["data:image/jpeg;base64,/9j/A".to_string()],
        );
        let (text, imgs) = env.dispatch_for(false);
        assert_eq!(text, "screenshot 1280x800",
            "text summary must still reach text-only providers");
        assert!(imgs.is_empty(),
            "images must be dropped for vision-less providers");
    }

    #[test]
    fn multimodal_dispatch_clones_so_envelope_can_be_reused() {
        // The same envelope might be inspected twice — once to log the
        // visual payload count, once to dispatch into a message — so
        // dispatch_for must not consume the envelope.
        let env = MultimodalEnvelope::with_images("body", vec!["data:1".into(), "data:2".into()]);
        let (_, a) = env.dispatch_for(true);
        let (_, b) = env.dispatch_for(true);
        assert_eq!(a, b);
        assert_eq!(env.images().len(), 2);
    }

    #[test]
    fn multimodal_from_tuple_compat_shim_preserves_payload() {
        // Old call sites still hand back a (String, Vec<String>) tuple.
        // The `From` impl exists so the dispatch site can lift them
        // uniformly into an envelope.
        let env: MultimodalEnvelope = ("hello".to_string(), vec!["data:x".to_string()]).into();
        assert_eq!(env.text_summary(), "hello");
        assert_eq!(env.images(), &["data:x".to_string()]);
    }

    #[test]
    fn multimodal_empty_image_vec_still_treated_as_text_only() {
        // Bug guard: with_images called with an empty Vec must NOT
        // accidentally trigger the image-dispatch branch.
        let env = MultimodalEnvelope::with_images("text", vec![]);
        assert!(!env.has_visual_payload());
        let (_, imgs) = env.dispatch_for(true);
        assert!(imgs.is_empty());
    }
}
