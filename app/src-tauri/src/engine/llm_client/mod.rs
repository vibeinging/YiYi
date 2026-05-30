//! LLM Client module.
//!
//! YiYi is V4-only — README §"只接 DeepSeek V4". DeepSeek's API is
//! OpenAI-compatible, so the adapter set collapses to one. Anthropic
//! and Google adapters used to live next to `openai.rs`; they were
//! retired together with the multi-provider build.
//!
//! Architecture:
//!   mod.rs     — Public API (single-path dispatch into openai)
//!   types.rs   — Shared types (LLMMessage, LLMConfig, LLMResponse, etc.)
//!   stream.rs  — SSE stream parsing utilities
//!   openai.rs  — OpenAI-compatible adapter (DeepSeek Pro / Flash + any
//!                OpenAI-format third-party endpoint a user points us at)

mod multimodal;
mod openai;
pub mod retry;
pub mod route;
mod stream;
mod types;

// Re-export all public types (maintains backward compatibility)
pub use multimodal::MultimodalEnvelope;
pub use route::{apply_hint, apply_source, model_for_source, RouteHint, FLASH_MODEL, PRO_MODEL};
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

    let api_key = providers
        .providers
        .get(&active.provider_id)
        .and_then(|s| s.api_key.clone());

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

/// Whether this model can ingest image inputs. V4-only build: DeepSeek
/// Pro / Flash are both text-only, so this returns `false` unconditionally.
/// Engine code consults it to decide whether to feed tool-produced images
/// (screenshots, generated charts) into the model's context — see
/// [`MultimodalEnvelope`]. The artifact pipeline is independent: images
/// always reach the user regardless.
///
/// When a vision-capable DeepSeek model ships, branch here on
/// `config.model` rather than re-introducing the multi-provider lookup
/// that lived here pre-V4-only.
pub fn model_has_vision(_config: &LLMConfig) -> bool {
    false
}

// ── Public dispatch API ─────────────────────────────────────────────

/// Call LLM with tool definitions.
///
/// NOTE: this low-level fn does NOT record usage to the persistent log.
/// For background callsites (meditation / compaction / growth / subagent /
/// heartbeat / eval / buddy delegate), prefer `chat_completion_tracked`
/// which auto-records to the `token_usage` SQLite table — without it the
/// cost-breakdown pie chart undercounts by 30-50%.
///
/// The streaming ReAct loop uses its own in-memory `UsageTracker` for
/// per-turn display and records at stream end; it's exempt from this.
pub async fn chat_completion(
    config: &LLMConfig,
    messages: &[LLMMessage],
    tools: &[ToolDefinition],
) -> Result<LLMResponse, String> {
    openai::chat_completion(config, messages, tools, &config.native_tools).await
}

/// Same as `chat_completion` but auto-records the response's usage to the
/// persistent `token_usage` table, tagged by `source`. Use this for any
/// background / off-main-loop LLM call.
///
/// V4-only build: auto-routes between Pro and Flash based on `source`.
/// Heavy sources (Main / Subagent / BuddyDelegate / Eval / Other) → Pro.
/// Cheap sources (Compaction / Meditation / Growth / Heartbeat / TestConnection) → Flash.
/// For non-DeepSeek providers (none in V4-only build, but kept for forward compat),
/// the `config.model` is left unchanged.
pub async fn chat_completion_tracked(
    source: crate::engine::usage::UsageSource,
    config: &LLMConfig,
    messages: &[LLMMessage],
    tools: &[ToolDefinition],
) -> Result<LLMResponse, String> {
    let mut routed = config.clone();
    apply_source(&mut routed, source);
    let resp = chat_completion(&routed, messages, tools).await?;
    if let Some(usage) = resp.usage {
        crate::engine::usage::record_llm_usage(source, usage, &routed.model);
        // Live session-cost side-channel — every background call ticks the UI counter too.
        crate::engine::cost_status::report(&routed.model, &usage);
    }
    Ok(resp)
}

/// Explicit-hint variant for tool internals that want to force Pro or Flash
/// regardless of the call site. Used by Phase D Flash-driven tools
/// (`compact_context`, `parallel_analyze`, …).
pub async fn chat_completion_with_hint(
    hint: RouteHint,
    config: &LLMConfig,
    messages: &[LLMMessage],
    tools: &[ToolDefinition],
) -> Result<LLMResponse, String> {
    let mut routed = config.clone();
    apply_hint(&mut routed, hint);
    chat_completion(&routed, messages, tools).await
}

/// Streaming chat completion via SSE.
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
    openai::chat_completion_stream(config, messages, tools, &config.native_tools, on_event, cancelled).await
}

/// 流式 + usage 记账合体 —— 等于 `chat_completion_tracked` 的流式版本:按 source 路由
/// 模型 + 调用方通过 `on_event` 拿到增量 token + 结束后记账到 usage_source。
/// 给 collaboration executor 用,让群成员发言能真·流式(此前用非流式 tracked,整段
/// 一次性出现)。
pub async fn chat_completion_stream_tracked<F>(
    source: crate::engine::usage::UsageSource,
    config: &LLMConfig,
    messages: &[LLMMessage],
    tools: &[ToolDefinition],
    on_event: F,
    cancelled: Option<&std::sync::atomic::AtomicBool>,
) -> Result<LLMResponse, String>
where
    F: Fn(StreamEvent) + Send + 'static,
{
    let mut routed = config.clone();
    apply_source(&mut routed, source);
    let resp = openai::chat_completion_stream(
        &routed,
        messages,
        tools,
        &routed.native_tools,
        on_event,
        cancelled,
    )
    .await?;
    if let Some(usage) = resp.usage {
        crate::engine::usage::record_llm_usage(source, usage, &routed.model);
        crate::engine::cost_status::report(&routed.model, &usage);
    }
    Ok(resp)
}
