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
/// 把 MCP server 返回的内容包进 trust 信封 —— MCP 输出是第三方不可信外部内容,
/// 不包则恶意 MCP server 的注入文本会被 LLM 当可信指令执行。系统提示词
/// (prompt.rs)已向 LLM 承诺 MCP 内容会被 `<external-content>` 包裹,这里兑现。
/// 见防屎山修复 C。
fn wrap_mcp_output(server_key: &str, result: &str) -> String {
    super::output_envelope::wrap_external(
        &format!("mcp:{server_key}"),
        super::output_envelope::Trust::Medium,
        &truncate_output(result, 8000),
    )
}

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
                Ok(result) => return Some(wrap_mcp_output(&tool.server_key, &result)),
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
                Ok(result) => return Some(wrap_mcp_output(key, &result)),
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

/// Scavenge:DeepSeek/R1 有时把工具调用写进 `content` 或 `reasoning_content` 的
/// 文本里,而**没有**走结构化 `tool_calls` 字段。不捞回来的话,这次工具调用会被
/// 当成最终答案吐给用户、工具根本不执行 → 任务静默失败 + 重试膨胀 + 拉低 cache。
///
/// 保守策略防误判:只有当文本里解析出的对象带 `name` 字段、**且 name ∈ 已知工具名**
/// 时才认定为工具调用。先扫 content 再扫 reasoning,任一命中即返回。见缓存 P0-3。
pub(crate) fn scavenge_tool_calls(
    content: &str,
    reasoning: &str,
    known_tool_names: &[String],
) -> Vec<super::types::ToolCall> {
    for src in [content, reasoning] {
        if src.trim().is_empty() {
            continue;
        }
        if let Some(v) = extract_json_candidate(src) {
            let calls = collect_scavenged_calls(&v, known_tool_names);
            if !calls.is_empty() {
                return calls;
            }
        }
    }
    Vec::new()
}

/// 从一段可能夹杂散文/围栏/`<tool_call>` 包裹的文本里,提取最可能的 JSON 候选。
fn extract_json_candidate(s: &str) -> Option<serde_json::Value> {
    let mut t = s.trim();
    // 去 <tool_call>...</tool_call> 包裹(DSML 风格)。
    if let Some(rest) = t.strip_prefix("<tool_call>") {
        t = rest.strip_suffix("</tool_call>").unwrap_or(rest).trim();
    }
    // 整段先试(repair_json 已处理 ```json 围栏 + 截断闭合)。
    if let Some(v) = repair_json(t) {
        if v.is_object() || v.is_array() {
            return Some(v);
        }
    }
    // 散文包裹的 JSON:取第一个 '{' 到最后一个 '}'(都是 ASCII,字节切片安全)。
    let start = t.find('{')?;
    let end = t.rfind('}')?;
    if end > start {
        repair_json(&t[start..=end]).filter(|v| v.is_object() || v.is_array())
    } else {
        None
    }
}

fn collect_scavenged_calls(
    v: &serde_json::Value,
    known: &[String],
) -> Vec<super::types::ToolCall> {
    match v {
        serde_json::Value::Array(arr) => arr
            .iter()
            .enumerate()
            .filter_map(|(i, x)| one_scavenged_call(x, known, i))
            .collect(),
        obj => one_scavenged_call(obj, known, 0).into_iter().collect(),
    }
}

fn one_scavenged_call(
    v: &serde_json::Value,
    known: &[String],
    idx: usize,
) -> Option<super::types::ToolCall> {
    let name = v.get("name")?.as_str()?;
    // 关键防误判:name 必须是已知工具,否则不认(避免把含 "name" 字段的普通 JSON
    // 数据误当工具调用)。
    if !known.iter().any(|k| k == name) {
        return None;
    }
    let args = v.get("arguments").or_else(|| v.get("parameters"));
    let arguments = match args {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
        None => "{}".to_string(),
    };
    Some(super::types::ToolCall {
        id: format!("scavenged_{idx}_{name}"),
        r#type: "function".into(),
        function: super::types::FunctionCall {
            name: name.to_string(),
            arguments,
        },
    })
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


#[cfg(test)]
mod scavenge_tests {
    use super::scavenge_tool_calls;

    fn known() -> Vec<String> {
        vec!["read_file".to_string(), "execute_shell".to_string()]
    }

    #[test]
    fn scavenges_bare_json_object_with_known_tool() {
        let c = r#"{"name": "read_file", "arguments": {"path": "a.txt"}}"#;
        let calls = scavenge_tool_calls(c, "", &known());
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].function.name, "read_file");
        assert!(calls[0].function.arguments.contains("a.txt"));
    }

    #[test]
    fn scavenges_from_reasoning_when_content_empty() {
        let r = r#"I should call {"name": "execute_shell", "arguments": {"cmd": "ls"}} now"#;
        let calls = scavenge_tool_calls("", r, &known());
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].function.name, "execute_shell");
    }

    #[test]
    fn scavenges_tool_call_wrapper() {
        let c = r#"<tool_call>{"name": "read_file", "arguments": {"path": "x"}}</tool_call>"#;
        assert_eq!(scavenge_tool_calls(c, "", &known()).len(), 1);
    }

    #[test]
    fn ignores_unknown_tool_name() {
        // 防误判:name 不在已知工具里 → 不当工具调用。
        let c = r#"{"name": "some_random_thing", "arguments": {}}"#;
        assert!(scavenge_tool_calls(c, "", &known()).is_empty());
    }

    #[test]
    fn ignores_plain_prose_with_name_field() {
        // 普通含 "name" 字段的数据 JSON,工具名不匹配 → 不误判。
        let c = r#"Here is some data: {"name": "Alice", "age": 30}"#;
        assert!(scavenge_tool_calls(c, "", &known()).is_empty());
    }

    #[test]
    fn ignores_plain_text() {
        assert!(scavenge_tool_calls("Just a normal answer, no tools.", "", &known()).is_empty());
    }
}
