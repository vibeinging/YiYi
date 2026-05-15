//! Core tool-call types shared by the dispatcher and every tool implementation.
//!
//! `ToolDefinition` is what the LLM sees in its `tools` parameter; `ToolCall`
//! is what comes back in the LLM's response; `ToolResult` is what we feed
//! back to the LLM in the next turn. Serialisation follows the OpenAI
//! function-calling shape so DeepSeek (which mirrors that schema) just works.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub r#type: String,
    pub function: FunctionDef,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionDef {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub r#type: String,
    pub function: FunctionCall,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionCall {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub tool_call_id: String,
    pub content: String,
    /// Base64 data URIs for images (e.g. screenshots) — fed to LLM as multimodal content.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
}

/// Build a `ToolDefinition` from `(name, description, JSON-schema parameters)`.
/// Used by every tool module's `definitions()` function — keep the call site
/// tight so adding a new tool stays one-liner.
pub(crate) fn tool_def(name: &str, desc: &str, params: serde_json::Value) -> ToolDefinition {
    ToolDefinition {
        r#type: "function".into(),
        function: FunctionDef {
            name: name.into(),
            description: desc.into(),
            parameters: params,
        },
    }
}
