//! Flash-driven tools — leverage DeepSeek V4 Flash for cheap, parallel sub-tasks
//! that would otherwise burn Pro tokens on the orchestrator.
//!
//! Two tools live here:
//!  * `compact_context` — summarize a chunk of conversation/text into a compact
//!    abstract while preserving key facts, decisions, and identifiers.
//!  * `parallel_analyze` — fan out N items to N concurrent Flash calls, each
//!    answering the same question against one item; aggregate the per-item
//!    answers for the orchestrator.

use serde_json::json;

use crate::engine::llm_client::{
    self, chat_completion_with_hint, LLMConfig, LLMMessage, MessageContent, RouteHint,
};
use crate::engine::tools::{tool_def, ToolDefinition, APP_HANDLE};

/// Tool definitions exposed to the agent.
pub fn definitions() -> Vec<ToolDefinition> {
    vec![compact_context_def(), parallel_analyze_def()]
}

fn compact_context_def() -> ToolDefinition {
    tool_def(
        "compact_context",
        "Summarize a long block of text or recent conversation into a compact abstract \
         while preserving key facts, decisions, names, file paths, and numbers. Runs on \
         DeepSeek V4 Flash so it's much cheaper than asking the orchestrator to compact \
         its own context. Use BEFORE you push verbose tool output back into the loop, \
         or to compress old turns when the context is getting long.",
        json!({
            "type": "object",
            "properties": {
                "text": {
                    "type": "string",
                    "description": "The full text to compact (conversation excerpt, large tool result, document, etc.)."
                },
                "focus": {
                    "type": "string",
                    "description": "Optional. What to keep front-and-center in the summary, e.g. 'API endpoints discussed', 'open bugs', 'user decisions'."
                },
                "max_words": {
                    "type": "integer",
                    "description": "Optional target length in words (default 200)."
                }
            },
            "required": ["text"]
        }),
    )
}

fn parallel_analyze_def() -> ToolDefinition {
    tool_def(
        "parallel_analyze",
        "Run the same question over N items in parallel using DeepSeek V4 Flash, then \
         return per-item answers. Use this instead of looping the question through the \
         orchestrator one item at a time — far faster and ~10× cheaper. Examples: \
         scoring 20 candidate files for relevance, classifying 50 messages, extracting \
         a field from each of N documents.",
        json!({
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "description": "Array of items to analyze in parallel. Each has a label (for the result key) and content (the text to analyze).",
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": { "type": "string" },
                            "content": { "type": "string" }
                        },
                        "required": ["label", "content"]
                    }
                },
                "question": {
                    "type": "string",
                    "description": "The single question/instruction to apply to every item."
                },
                "max_concurrency": {
                    "type": "integer",
                    "description": "Optional. Cap parallel Flash calls (default 8)."
                }
            },
            "required": ["items", "question"]
        }),
    )
}

// ─── implementations ────────────────────────────────────────────────────

async fn resolve_flash_config() -> Option<LLMConfig> {
    let handle = APP_HANDLE.get()?;
    use tauri::Manager;
    let state = handle.state::<crate::state::AppState>();
    let providers = state.providers.read().await;
    llm_client::resolve_config_from_providers(&providers).ok()
}

fn user_msg(text: impl Into<String>) -> LLMMessage {
    LLMMessage {
        role: "user".into(),
        content: Some(MessageContent::text(text.into())),
        tool_calls: None,
        tool_call_id: None,
    }
}

fn system_msg(text: impl Into<String>) -> LLMMessage {
    LLMMessage {
        role: "system".into(),
        content: Some(MessageContent::text(text.into())),
        tool_calls: None,
        tool_call_id: None,
    }
}

pub async fn compact_context_tool(args: &serde_json::Value) -> String {
    let Some(text) = args["text"].as_str() else {
        return "Error: `text` is required".into();
    };
    if text.trim().is_empty() {
        return "Error: `text` cannot be empty".into();
    }
    let focus = args["focus"].as_str().unwrap_or("");
    let max_words = args["max_words"].as_u64().unwrap_or(200) as usize;

    let cfg = match resolve_flash_config().await {
        Some(c) => c,
        None => return "Error: no LLM configured".into(),
    };

    let focus_clause = if focus.is_empty() {
        String::new()
    } else {
        format!("\nKeep these front-and-center: {focus}")
    };

    let system = format!(
        "You compact long text into a tight abstract. Preserve every concrete fact: \
         names, file paths, IDs, numbers, decisions, error messages, dates. Drop fluff, \
         duplicate phrasing, and pleasantries. Target {max_words} words or fewer.{focus_clause} \
         Output the abstract directly — no preamble, no headings."
    );

    let messages = vec![system_msg(system), user_msg(text.to_string())];

    match chat_completion_with_hint(RouteHint::Light, &cfg, &messages, &[]).await {
        Ok(resp) => match resp.message.content {
            Some(c) => {
                let summary = c.into_text();
                let in_chars = text.chars().count();
                let out_chars = summary.chars().count();
                let ratio = if in_chars > 0 {
                    100.0 * out_chars as f32 / in_chars as f32
                } else {
                    0.0
                };
                json!({
                    "summary": summary,
                    "input_chars": in_chars,
                    "output_chars": out_chars,
                    "compaction_ratio_pct": format!("{ratio:.1}"),
                    "model": "deepseek-v4-flash",
                })
                .to_string()
            }
            None => "Error: empty response from Flash".into(),
        },
        Err(e) => format!("Error compacting: {e}"),
    }
}

pub async fn parallel_analyze_tool(args: &serde_json::Value) -> String {
    let Some(items) = args["items"].as_array() else {
        return "Error: `items` must be an array".into();
    };
    let Some(question) = args["question"].as_str() else {
        return "Error: `question` is required".into();
    };
    if items.is_empty() {
        return "Error: `items` cannot be empty".into();
    }
    let question = question.to_string();
    let max_concurrency = args["max_concurrency"].as_u64().unwrap_or(8).max(1) as usize;

    let cfg = match resolve_flash_config().await {
        Some(c) => c,
        None => return "Error: no LLM configured".into(),
    };

    // Pre-extract (label, content) pairs to avoid borrowing args inside spawned tasks.
    let mut jobs: Vec<(String, String)> = Vec::with_capacity(items.len());
    for it in items {
        let label = it["label"].as_str().unwrap_or("").to_string();
        let content = it["content"].as_str().unwrap_or("").to_string();
        if label.is_empty() || content.is_empty() {
            continue;
        }
        jobs.push((label, content));
    }
    if jobs.is_empty() {
        return "Error: no usable items (need non-empty label and content)".into();
    }

    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(max_concurrency));
    let cfg = std::sync::Arc::new(cfg);
    let question = std::sync::Arc::new(question);

    let mut handles = Vec::with_capacity(jobs.len());
    for (label, content) in jobs {
        let permit = semaphore.clone();
        let cfg = cfg.clone();
        let question = question.clone();
        let handle = tokio::spawn(async move {
            let _p = match permit.acquire_owned().await {
                Ok(p) => p,
                Err(_) => return (label, "Error: semaphore closed".to_string()),
            };
            let system = "You answer a single question against a single document. \
                Be concise. If the document does not contain enough information, say so directly.";
            let user = format!("Question: {q}\n\n--- Document ---\n{c}", q = *question, c = content);
            let messages = vec![system_msg(system), user_msg(user)];
            let answer = match chat_completion_with_hint(RouteHint::Light, &cfg, &messages, &[]).await {
                Ok(resp) => resp
                    .message
                    .content
                    .map(|c| c.into_text())
                    .unwrap_or_else(|| "(empty response)".into()),
                Err(e) => format!("Error: {e}"),
            };
            (label, answer)
        });
        handles.push(handle);
    }

    let mut results = serde_json::Map::new();
    let mut ok = 0usize;
    let mut err = 0usize;
    for h in handles {
        match h.await {
            Ok((label, answer)) => {
                if answer.starts_with("Error:") {
                    err += 1;
                } else {
                    ok += 1;
                }
                results.insert(label, json!(answer));
            }
            Err(e) => {
                err += 1;
                results.insert(format!("__join_error_{err}"), json!(e.to_string()));
            }
        }
    }

    json!({
        "results": results,
        "succeeded": ok,
        "failed": err,
        "model": "deepseek-v4-flash",
    })
    .to_string()
}
