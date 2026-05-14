//! Multimodal envelope — tool-output dispatch keyed on provider capability.
//!
//! Lives in `llm_client/` (not `tools/`) because the dispatch decision is
//! a property of the LLM client, not of any individual tool. A tool
//! produces an envelope; [`MultimodalEnvelope::dispatch_for`] folds it
//! down to the `(text, images)` pair the active provider can actually
//! consume.
//!
//! Previously co-located with [`super::super::tools::output_envelope`]'s
//! `wrap_external` (a pure string-wrapping helper for untrusted content),
//! but those two abstractions are unrelated — only the word "envelope"
//! tied them together. Trust-wrapping stays in `tools/`; capability
//! dispatch is here next to [`super::model_has_vision`].
//!
//! See `engine/react_agent/core.rs` for the single call site that lifts
//! a tool's `(content, images)` return tuple into an envelope and
//! dispatches it.

/// What a tool with non-text output (screenshots, charts, future audio /
/// video) hands back to the runtime. The runtime, not the tool, decides
/// which fields make it into the LLM context based on provider capability.
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
    fn text_only_yields_empty_image_vec_either_way() {
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
    fn with_images_dispatches_images_only_to_vision_providers() {
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
    fn text_only_provider_drops_images() {
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
    fn dispatch_clones_so_envelope_can_be_reused() {
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
    fn from_tuple_compat_shim_preserves_payload() {
        // Old call sites still hand back a (String, Vec<String>) tuple.
        // The `From` impl exists so the dispatch site can lift them
        // uniformly into an envelope.
        let env: MultimodalEnvelope = ("hello".to_string(), vec!["data:x".to_string()]).into();
        assert_eq!(env.text_summary(), "hello");
        assert_eq!(env.images(), &["data:x".to_string()]);
    }

    #[test]
    fn empty_image_vec_still_treated_as_text_only() {
        // Bug guard: with_images called with an empty Vec must NOT
        // accidentally trigger the image-dispatch branch.
        let env = MultimodalEnvelope::with_images("text", vec![]);
        assert!(!env.has_visual_payload());
        let (_, imgs) = env.dispatch_for(true);
        assert!(imgs.is_empty());
    }
}
