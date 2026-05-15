//! Internal helpers shared by the dispatcher and the tool implementations.
//!
//! These are the small utilities that aren't tied to a single tool — JSON
//! repair for malformed LLM output, output truncation, MCP fallback dispatch,
//! YAML frontmatter stripping, atomic progress writes. Plus thin facade
//! wrappers around `task_tools` that the rest of the app prefers to call via
//! `crate::engine::tools::*` rather than reaching into the sub-module.
//!
//! Nothing here owns state — it's all stateless functions over inputs.

use std::collections::HashMap;
use std::path::Path;

use super::super::infra::mcp_runtime::MCPRuntime;

/// Truncate output, keeping head (80%) and tail (20%) so both opening context
/// and trailing errors survive. Returns the original string if it's already
/// within `max_chars`.
pub(crate) fn truncate_output(s: &str, max_chars: usize) -> String {
    let char_count = s.chars().count();
    if char_count <= max_chars {
        return s.to_string();
    }
    let head_chars = max_chars * 4 / 5;
    let tail_chars = max_chars - head_chars;
    let head: String = s.chars().take(head_chars).collect();
    let tail: String = s.chars().skip(char_count - tail_chars).collect();
    format!(
        "{}\n\n... [truncated {} of {} chars] ...\n\n{}",
        head,
        char_count - max_chars,
        char_count,
        tail
    )
}

/// Try to execute a tool via MCP runtime.
pub(crate) async fn try_mcp_tool(
    runtime: &MCPRuntime,
    tool_name: &str,
    args: &serde_json::Value,
) -> Option<String> {
    let all_tools = runtime.get_all_tools().await;
    if let Some(tool) = all_tools.iter().find(|t| t.name == tool_name) {
        if !tool.server_key.is_empty() {
            match runtime
                .call_tool(&tool.server_key, tool_name, args.clone())
                .await
            {
                Ok(result) => return Some(truncate_output(&result, 8000)),
                Err(e) => return Some(format!("MCP tool error: {}", e)),
            }
        }
    }

    // Fallback: scan all clients (for backwards compatibility)
    let clients = runtime.get_all_client_keys().await;
    for key in &clients {
        let tools = runtime.get_tools(key).await;
        if tools.iter().any(|t| t.name == tool_name) {
            match runtime.call_tool(key, tool_name, args.clone()).await {
                Ok(result) => return Some(truncate_output(&result, 8000)),
                Err(e) => return Some(format!("MCP tool error: {}", e)),
            }
        }
    }
    None
}

/// Attempt lightweight repair of malformed JSON from LLM tool calls.
pub fn repair_json(raw: &str) -> Option<serde_json::Value> {
    let mut s = raw.trim().to_string();

    // Strip markdown code fences: ```json ... ```
    if s.starts_with("```") {
        if let Some(start) = s.find('\n') {
            s = s[start + 1..].to_string();
        }
        if s.ends_with("```") {
            s.truncate(s.len() - 3);
            s = s.trim_end().to_string();
        }
    }

    // Remove trailing commas before } or ]
    s = remove_trailing_commas(&s);

    // Try parsing after basic cleanup
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
        return Some(v);
    }

    // Count unclosed braces/brackets and close them
    let mut brace_depth: i32 = 0;
    let mut bracket_depth: i32 = 0;
    let mut in_string = false;
    let mut prev_char = '\0';
    for ch in s.chars() {
        if in_string {
            if ch == '"' && prev_char != '\\' {
                in_string = false;
            }
        } else {
            match ch {
                '"' => in_string = true,
                '{' => brace_depth += 1,
                '}' => brace_depth -= 1,
                '[' => bracket_depth += 1,
                ']' => bracket_depth -= 1,
                _ => {}
            }
        }
        prev_char = ch;
    }

    // If we're still inside a string, close it
    if in_string {
        s.push('"');
    }

    // Close unclosed brackets/braces
    for _ in 0..bracket_depth {
        s.push(']');
    }
    for _ in 0..brace_depth {
        s.push('}');
    }

    // Remove trailing commas again after closing
    s = remove_trailing_commas(&s);

    serde_json::from_str::<serde_json::Value>(&s).ok()
}

/// Remove trailing commas before closing braces/brackets: `,}` -> `}`, `,]` -> `]`
fn remove_trailing_commas(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == ',' {
            // Look ahead past whitespace for } or ]
            let mut j = i + 1;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            if j < chars.len() && (chars[j] == '}' || chars[j] == ']') {
                // Skip this comma
                i += 1;
                continue;
            }
        }
        result.push(chars[i]);
        i += 1;
    }
    result
}

/// Strip YAML frontmatter (between --- delimiters) from SKILL.md content.
#[allow(dead_code)]
pub(crate) fn strip_frontmatter(content: &str) -> &str {
    let trimmed = content.trim();
    if !trimmed.starts_with("---") {
        return content;
    }
    let rest = &trimmed[3..];
    match rest.find("---") {
        Some(end) => rest[end + 3..].trim_start(),
        None => content,
    }
}

/// Atomically write progress.json (tmp + rename) for crash recovery.
pub fn write_progress_json(progress_dir: &Path, data: &serde_json::Value) {
    if let Ok(json) = serde_json::to_string_pretty(data) {
        let tmp_path = progress_dir.join("progress.json.tmp");
        let final_path = progress_dir.join("progress.json");
        if std::fs::write(&tmp_path, &json).is_ok() {
            std::fs::rename(&tmp_path, &final_path).ok();
        }
    }
}

/// Strip `[STAGE_COMPLETE: N]` markers from text.
/// Re-exported for use from `commands/agent/chat.rs`.
pub fn strip_stage_markers(text: &str) -> String {
    super::task_tools::strip_stage_markers(text)
}

/// Background task that executes a created task via a ReAct Agent.
/// Re-exported for use from `commands/tasks.rs` and `lib.rs`.
pub fn spawn_task_execution(
    task_id: String,
    session_id: String,
    title: String,
    description: String,
    plan: Vec<String>,
    total_stages: i32,
) {
    super::task_tools::spawn_task_execution(task_id, session_id, title, description, plan, total_stages);
}

/// Build a map of server_key -> skill override description from config and working dir.
pub fn build_mcp_skill_overrides(
    mcp_config: &HashMap<String, crate::state::config::MCPClientConfig>,
    working_dir: &Path,
) -> HashMap<String, String> {
    let mut overrides = HashMap::new();
    let active_dir = working_dir.join("active_skills");
    for (key, cfg) in mcp_config {
        if let Some(skill_name) = &cfg.skill_override {
            let skill_md = active_dir.join(skill_name).join("SKILL.md");
            if let Ok(content) = std::fs::read_to_string(&skill_md) {
                overrides.insert(key.clone(), content);
            }
        }
    }
    overrides
}

