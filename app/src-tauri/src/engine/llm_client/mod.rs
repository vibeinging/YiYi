//! LLM Client module — Strategy pattern with provider-specific adapters.
//!
//! Architecture:
//!   mod.rs     — Public API (auto-dispatches to correct provider)
//!   types.rs   — Shared types (LLMMessage, LLMConfig, LLMResponse, etc.)
//!   stream.rs  — SSE stream parsing utilities
//!   openai.rs  — OpenAI-compatible adapter (also: DeepSeek, DashScope, Zhipu, Moonshot, MiniMax)
//!   anthropic.rs — Anthropic Messages API adapter
//!   google.rs  — Google Gemini API adapter

mod anthropic;
mod google;
mod openai;
pub mod retry;
mod stream;
mod types;

// Re-export all public types (maintains backward compatibility)
pub use types::*;

/// User-Agent sent to Coding Plan endpoints that require a recognised coding agent.
pub const CODING_AGENT_UA: &str = "openclaw/1.0.0";

/// Check if a URL points to a Coding Plan endpoint that needs a coding-agent UA.
pub fn needs_coding_agent_ua(url: &str) -> bool {
    url.contains("coding.dashscope.aliyuncs.com")
}

use super::tools::ToolDefinition;

// ---------------------------------------------------------------------------
// Shared HTTP client — reuses connection pool & TLS across all LLM adapters
// ---------------------------------------------------------------------------

/// Return a reference to the shared HTTP client for LLM requests.
/// Uses `OnceLock` to lazily initialise a single `reqwest::Client` with
/// generous timeouts suitable for LLM streaming responses.
pub(crate) fn http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .pool_max_idle_per_host(5)
            .build()
            .expect("Failed to build LLM HTTP client")
    })
}

// ── Shared config resolution ────────────────────────────────────────

/// Resolve LLM configuration from the providers state.
/// Shared between commands layer and agent runner.
pub fn resolve_config_from_providers(
    providers: &crate::state::providers::ProvidersState,
) -> Result<LLMConfig, String> {
    let active = providers
        .active_llm
        .as_ref()
        .ok_or("No active model configured. Please set a model first.")?;

    let all_providers = providers.get_all_providers();
    let provider = all_providers
        .iter()
        .find(|p| p.id == active.provider_id)
        .ok_or_else(|| format!("Provider '{}' not found", active.provider_id))?;

    let base_url = provider
        .base_url
        .as_deref()
        .unwrap_or(&provider.default_base_url)
        .to_string();

    let api_key = if let Some(custom) = providers.custom_providers.get(&active.provider_id) {
        custom.settings.api_key.clone()
    } else {
        providers
            .providers
            .get(&active.provider_id)
            .and_then(|s| s.api_key.clone())
    };

    let api_key_prefix = provider.api_key_prefix.clone();
    let model = active.model.clone();
    let provider_id = active.provider_id.clone();

    let api_key = api_key
        .or_else(|| std::env::var(&api_key_prefix).ok())
        .ok_or_else(|| format!("No API key configured for provider '{provider_id}'"))?;

    let native_tools =
        crate::state::providers::resolve_native_injections(&provider.native_tools, &model);

    Ok(LLMConfig {
        base_url,
        api_key,
        model,
        provider_id,
        native_tools,
    })
}

// ── Provider format detection (Strategy selection) ──────────────────

/// Determine API format from provider_id or base_url
fn api_format(config: &LLMConfig) -> &'static str {
    match config.provider_id.as_str() {
        "anthropic" => "anthropic",
        "google" => "google",
        _ => {
            let url = config.base_url.to_lowercase();
            if url.contains("anthropic.com") {
                "anthropic"
            } else if url.contains("generativelanguage.googleapis.com") {
                "google"
            } else {
                "openai"
            }
        }
    }
}

// ── Public dispatch API ─────────────────────────────────────────────

/// Call LLM with tool definitions (auto-detects provider and dispatches)
pub async fn chat_completion(
    config: &LLMConfig,
    messages: &[LLMMessage],
    tools: &[ToolDefinition],
) -> Result<LLMResponse, String> {
    match api_format(config) {
        "anthropic" => anthropic::chat_completion(config, messages, tools).await,
        "google" => google::chat_completion(config, messages, tools).await,
        _ => openai::chat_completion(config, messages, tools, &config.native_tools).await,
    }
}

/// Streaming chat completion via SSE (auto-detects provider and dispatches)
pub async fn chat_completion_stream<F>(
    config: &LLMConfig,
    messages: &[LLMMessage],
    tools: &[ToolDefinition],
    on_event: F,
    cancelled: Option<&std::sync::atomic::AtomicBool>,
) -> Result<LLMResponse, String>
where
    F: Fn(StreamEvent) + Send + 'static,
{
    match api_format(config) {
        "anthropic" => {
            anthropic::chat_completion_stream(config, messages, tools, on_event, cancelled).await
        }
        "google" => {
            google::chat_completion_stream(config, messages, tools, on_event, cancelled).await
        }
        _ => {
            openai::chat_completion_stream(config, messages, tools, &config.native_tools, on_event, cancelled).await
        }
    }
}
