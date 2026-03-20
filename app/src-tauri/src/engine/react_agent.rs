use super::llm_client::{chat_completion, chat_completion_stream, LLMConfig, LLMMessage, MessageContent, StreamEvent};
use super::token_counter::estimate_tokens;
use super::tools::{builtin_tools_filtered, execute_tool, ToolDefinition};
use std::sync::Arc;

// ---------------------------------------------------------------------------
// Tool persistence callback types
// ---------------------------------------------------------------------------

/// Events emitted for persisting tool calls to the database.
#[derive(Debug, Clone)]
pub enum ToolPersistEvent {
    /// Assistant message that contains tool_calls
    AssistantWithToolCalls {
        content: String,
        tool_calls_json: String, // serialized [{id, name, arguments}]
    },
    /// Tool result message
    ToolResult {
        tool_call_id: String,
        tool_name: String,
        result_content: String, // truncated
    },
}

pub type PersistToolFn = Arc<dyn Fn(ToolPersistEvent) + Send + Sync>;

/// Classification of growth signals for confidence scoring.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SignalType {
    ExplicitCorrection,   // User said "wrong/不对" → confidence 0.90
    ExplicitPraise,       // User said "perfect/完美" → confidence 0.85
    ToolError,            // Tool returned error → confidence 0.70
    MaxIterations,        // Hit iteration limit → confidence 0.65
    AgentError,           // Agent execution error → confidence 0.70
    SilentCompletion,     // No explicit feedback → confidence 0.35
}

impl SignalType {
    pub fn base_confidence(&self) -> f64 {
        match self {
            Self::ExplicitCorrection => 0.90,
            Self::ExplicitPraise => 0.85,
            Self::ToolError => 0.70,
            Self::MaxIterations => 0.65,
            Self::AgentError => 0.70,
            Self::SilentCompletion => 0.35,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ExplicitCorrection => "explicit_correction",
            Self::ExplicitPraise => "explicit_praise",
            Self::ToolError => "tool_error",
            Self::MaxIterations => "max_iterations",
            Self::AgentError => "agent_error",
            Self::SilentCompletion => "silent_completion",
        }
    }
}

const DEFAULT_MAX_ITERATIONS: usize = 200;
/// Token threshold to trigger context compaction.
const COMPACT_THRESHOLD: usize = 80_000;

/// Semaphore to limit concurrent background LLM calls (reflections, feedback learning).
/// Prevents API rate limit exhaustion when many tasks complete simultaneously.
static GROWTH_LLM_SEMAPHORE: std::sync::LazyLock<tokio::sync::Semaphore> =
    std::sync::LazyLock::new(|| tokio::sync::Semaphore::new(3));

/// Compact summary file name within working_dir.
const COMPACT_SUMMARY_FILE: &str = ".compact_summary.txt";

/// Bootstrap completed flag file.
const BOOTSTRAP_COMPLETED: &str = ".bootstrap_completed";

/// Run a ReAct agent loop (single-turn, no history).
/// Used by channels, scheduler, heartbeat, cronjobs.
pub async fn run_react(
    config: &LLMConfig,
    system_prompt: &str,
    user_message: &str,
    extra_tools: &[ToolDefinition],
) -> Result<String, String> {
    run_react_with_options(config, system_prompt, user_message, extra_tools, &[], None, None).await
}

/// Run ReAct loop with conversation history, configurable max iterations,
/// and optional working_dir for persisting compact summaries.
pub async fn run_react_with_options(
    config: &LLMConfig,
    system_prompt: &str,
    user_message: &str,
    extra_tools: &[ToolDefinition],
    history: &[LLMMessage],
    max_iterations: Option<usize>,
    working_dir: Option<&std::path::Path>,
) -> Result<String, String> {
    run_react_with_options_persist(config, system_prompt, user_message, extra_tools, history, max_iterations, working_dir, None).await
}

/// Run ReAct loop with optional tool persistence callback.
pub async fn run_react_with_options_persist(
    config: &LLMConfig,
    system_prompt: &str,
    user_message: &str,
    extra_tools: &[ToolDefinition],
    history: &[LLMMessage],
    max_iterations: Option<usize>,
    working_dir: Option<&std::path::Path>,
    persist_fn: Option<PersistToolFn>,
) -> Result<String, String> {
    let max_iter = max_iterations.unwrap_or(DEFAULT_MAX_ITERATIONS);
    let mut tools = builtin_tools_filtered().await;
    tools.extend(extra_tools.iter().cloned());

    let mut messages: Vec<LLMMessage> = vec![
        LLMMessage {
            role: "system".into(),
            content: Some(MessageContent::text(system_prompt)),
            tool_calls: None,
            tool_call_id: None,
        },
    ];

    // Load persisted compact summary as system message
    if let Some(dir) = working_dir {
        let summary_path = dir.join(COMPACT_SUMMARY_FILE);
        if let Ok(summary) = tokio::fs::read_to_string(&summary_path).await {
            if !summary.trim().is_empty() {
                messages.push(LLMMessage {
                    role: "system".into(),
                    content: Some(MessageContent::text(format!(
                        "<previous-summary>\n{}\n</previous-summary>\n\
                        The above is a summary of previous conversation. \
                        Use it as context to maintain continuity.",
                        summary.trim()
                    ))),
                    tool_calls: None,
                    tool_call_id: None,
                });
            }
        }
    }

    // Insert conversation history between system prompt and current user message
    if !history.is_empty() {
        messages.extend(history.iter().cloned());
    }

    messages.push(LLMMessage {
        role: "user".into(),
        content: Some(MessageContent::text(user_message)),
        tool_calls: None,
        tool_call_id: None,
    });

    // Sanitize history messages (fix orphan tool results from previous sessions)
    sanitize_messages(&mut messages);

    // Pre-compact if history made context too large before first LLM call
    compact_messages_if_needed(&mut messages, config, working_dir).await;

    const MAX_EMPTY_RETRIES: usize = 3;
    let mut consecutive_empty = 0u8;

    for iteration in 0..max_iter {
        log::info!("ReAct iteration {}/{}", iteration + 1, max_iter);

        let response = chat_completion(config, &messages, &tools).await?;

        // Add assistant message to history
        messages.push(response.message.clone());

        // Determine whether we got valid tool calls
        let has_tool_calls = response.message.tool_calls.as_ref()
            .map_or(false, |tc| !tc.is_empty());

        if has_tool_calls {
            consecutive_empty = 0;
            let tool_calls = response.message.tool_calls.as_ref().unwrap();

            // Persist assistant message with tool_calls
            if let Some(ref pfn) = persist_fn {
                let content_text = response.message.content.as_ref()
                    .map(|c| c.as_text().unwrap_or("").to_string())
                    .unwrap_or_default();
                let tc_json: Vec<serde_json::Value> = tool_calls.iter().map(|tc| {
                    serde_json::json!({
                        "id": tc.id,
                        "name": tc.function.name,
                        "arguments": tc.function.arguments.chars().take(500).collect::<String>(),
                    })
                }).collect();
                pfn(ToolPersistEvent::AssistantWithToolCalls {
                    content: content_text,
                    tool_calls_json: serde_json::to_string(&tc_json).unwrap_or_default(),
                });
            }

            // Execute all tool calls concurrently, preserving original order
            for call in tool_calls {
                log::info!(
                    "Tool call: {}({})",
                    call.function.name,
                    call.function.arguments.chars().take(100).collect::<String>()
                );
            }

            let futures: Vec<_> = tool_calls
                .iter()
                .map(|call| async move { execute_tool(call).await })
                .collect();
            let results = futures::future::join_all(futures).await;

            for (call, result) in tool_calls.iter().zip(results.into_iter()) {
                log::info!(
                    "Tool result ({}): {}...",
                    call.function.name,
                    result.content.chars().take(200).collect::<String>()
                );

                // Persist tool result
                if let Some(ref pfn) = persist_fn {
                    pfn(ToolPersistEvent::ToolResult {
                        tool_call_id: result.tool_call_id.clone(),
                        tool_name: call.function.name.clone(),
                        result_content: result.content.chars().take(2000).collect(),
                    });
                }

                let content = if result.images.is_empty() {
                    MessageContent::text(result.content)
                } else {
                    MessageContent::with_images(&result.content, &result.images)
                };
                messages.push(LLMMessage {
                    role: "tool".into(),
                    content: Some(content),
                    tool_calls: None,
                    tool_call_id: Some(result.tool_call_id),
                });
            }
        } else {
            // No tool calls — check if we got a text response
            let text = response.message.content
                .map(|c| c.into_text())
                .unwrap_or_default();
            let text = text.trim().to_string();

            if !text.is_empty() {
                // Valid final text response
                return Ok(text);
            }

            // Empty response — retry with a nudge
            consecutive_empty += 1;
            log::warn!(
                "LLM returned empty response (retry {}/{})",
                consecutive_empty, MAX_EMPTY_RETRIES
            );

            if (consecutive_empty as usize) >= MAX_EMPTY_RETRIES {
                log::error!("LLM returned empty response {} times, giving up", MAX_EMPTY_RETRIES);
                return Ok(String::new());
            }

            // Remove the empty assistant message we just pushed
            messages.pop();

            // Push a nudge to coax the LLM into responding
            messages.push(LLMMessage {
                role: "user".into(),
                content: Some(MessageContent::text(
                    "Please provide your response. Summarize what was done or answer the question."
                )),
                tool_calls: None,
                tool_call_id: None,
            });
        }

        // After executing tool calls, always continue the loop so the LLM
        // can produce a final text response based on tool results.
        // Do NOT check finish_reason here — some providers return "stop"
        // even when tool_calls are present, and the content would be None.

        compact_messages_if_needed(&mut messages, config, working_dir).await;
    }

    Err(format!(
        "Agent reached maximum iterations ({})",
        max_iter
    ))
}

// ---------------------------------------------------------------------------
// Streaming ReAct agent
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub enum AgentStreamEvent {
    Token(String),
    Thinking(String),
    ToolStart { name: String, args_preview: String },
    ToolEnd { name: String, result_preview: String },
    Complete,
    Error,
}

/// Streaming version of run_react_with_options.
/// Calls `on_event` for each stream event (tokens, tool status, completion).
pub async fn run_react_with_options_stream<F>(
    config: &LLMConfig,
    system_prompt: &str,
    user_message: &str,
    extra_tools: &[ToolDefinition],
    history: &[LLMMessage],
    max_iterations: Option<usize>,
    working_dir: Option<&std::path::Path>,
    on_event: F,
    cancelled: Option<&std::sync::atomic::AtomicBool>,
    persist_fn: Option<PersistToolFn>,
) -> Result<String, String>
where
    F: Fn(AgentStreamEvent) + Send + Clone + 'static,
{
    let max_iter = max_iterations.unwrap_or(DEFAULT_MAX_ITERATIONS);
    let mut tools = builtin_tools_filtered().await;
    tools.extend(extra_tools.iter().cloned());

    let mut messages: Vec<LLMMessage> = vec![LLMMessage {
        role: "system".into(),
        content: Some(MessageContent::text(system_prompt)),
        tool_calls: None,
        tool_call_id: None,
    }];

    // Load persisted compact summary
    if let Some(dir) = working_dir {
        let summary_path = dir.join(COMPACT_SUMMARY_FILE);
        if let Ok(summary) = tokio::fs::read_to_string(&summary_path).await {
            if !summary.trim().is_empty() {
                messages.push(LLMMessage {
                    role: "system".into(),
                    content: Some(MessageContent::text(format!(
                        "<previous-summary>\n{}\n</previous-summary>\n\
                        The above is a summary of previous conversation. \
                        Use it as context to maintain continuity.",
                        summary.trim()
                    ))),
                    tool_calls: None,
                    tool_call_id: None,
                });
            }
        }
    }

    if !history.is_empty() {
        messages.extend(history.iter().cloned());
    }

    messages.push(LLMMessage {
        role: "user".into(),
        content: Some(MessageContent::text(user_message)),
        tool_calls: None,
        tool_call_id: None,
    });

    sanitize_messages(&mut messages);
    compact_messages_if_needed(&mut messages, config, working_dir).await;

    const MAX_EMPTY_RETRIES: usize = 3;
    let mut consecutive_empty = 0u8;

    for iteration in 0..max_iter {
        log::info!("ReAct stream iteration {}/{}", iteration + 1, max_iter);

        let cb = on_event.clone();
        // Check cancellation before each LLM call
        if cancelled.map_or(false, |c| c.load(std::sync::atomic::Ordering::Relaxed)) {
            return Err("cancelled".to_string());
        }

        let response = chat_completion_stream(config, &messages, &tools, move |evt| {
            match evt {
                StreamEvent::ContentDelta(text) => cb(AgentStreamEvent::Token(text)),
                StreamEvent::ReasoningDelta(text) => cb(AgentStreamEvent::Thinking(text)),
                _ => {}
            }
        }, cancelled)
        .await?;

        messages.push(response.message.clone());

        // Determine whether we got valid tool calls
        let has_tool_calls = response.message.tool_calls.as_ref()
            .map_or(false, |tc| !tc.is_empty());

        if has_tool_calls {
            consecutive_empty = 0;
            let tool_calls = response.message.tool_calls.as_ref().unwrap();

            // Persist assistant message with tool_calls
            if let Some(ref pfn) = persist_fn {
                let content_text = response.message.content.as_ref()
                    .map(|c| c.as_text().unwrap_or("").to_string())
                    .unwrap_or_default();
                let tc_json: Vec<serde_json::Value> = tool_calls.iter().map(|tc| {
                    serde_json::json!({
                        "id": tc.id,
                        "name": tc.function.name,
                        "arguments": tc.function.arguments.chars().take(500).collect::<String>(),
                    })
                }).collect();
                pfn(ToolPersistEvent::AssistantWithToolCalls {
                    content: content_text,
                    tool_calls_json: serde_json::to_string(&tc_json).unwrap_or_default(),
                });
            }

            // Emit all ToolStart events upfront
            for call in tool_calls {
                let args_preview: String = call.function.arguments.chars().take(100).collect();
                on_event(AgentStreamEvent::ToolStart {
                    name: call.function.name.clone(),
                    args_preview,
                });
            }

            // Check cancellation before starting tool execution
            if cancelled.map_or(false, |c| c.load(std::sync::atomic::Ordering::Relaxed)) {
                return Err("cancelled".to_string());
            }

            // Execute all tool calls concurrently, preserving original order
            let futures: Vec<_> = tool_calls
                .iter()
                .map(|call| async move { execute_tool(call).await })
                .collect();
            let results = futures::future::join_all(futures).await;

            // Check cancellation after tool execution, before feeding results back to LLM
            if cancelled.map_or(false, |c| c.load(std::sync::atomic::Ordering::Relaxed)) {
                return Err("cancelled".to_string());
            }

            // Emit ToolEnd events and push results in order
            for (call, result) in tool_calls.iter().zip(results.into_iter()) {
                let result_preview: String = result.content.chars().take(200).collect();
                on_event(AgentStreamEvent::ToolEnd {
                    name: call.function.name.clone(),
                    result_preview,
                });

                // Persist tool result
                if let Some(ref pfn) = persist_fn {
                    pfn(ToolPersistEvent::ToolResult {
                        tool_call_id: result.tool_call_id.clone(),
                        tool_name: call.function.name.clone(),
                        result_content: result.content.chars().take(2000).collect(),
                    });
                }

                let content = if result.images.is_empty() {
                    MessageContent::text(result.content)
                } else {
                    MessageContent::with_images(&result.content, &result.images)
                };
                messages.push(LLMMessage {
                    role: "tool".into(),
                    content: Some(content),
                    tool_calls: None,
                    tool_call_id: Some(result.tool_call_id),
                });
            }
        } else {
            // No tool calls — check if we got a text response
            let text = response.message.content
                .map(|c| c.into_text())
                .unwrap_or_default();
            let text = text.trim().to_string();

            if !text.is_empty() {
                // Valid final text response
                on_event(AgentStreamEvent::Complete);
                return Ok(text);
            }

            // Empty response — retry with a nudge
            consecutive_empty += 1;
            log::warn!(
                "LLM returned empty response (retry {}/{})",
                consecutive_empty, MAX_EMPTY_RETRIES
            );

            if (consecutive_empty as usize) >= MAX_EMPTY_RETRIES {
                log::error!("LLM returned empty response {} times, giving up", MAX_EMPTY_RETRIES);
                on_event(AgentStreamEvent::Complete);
                return Ok(String::new());
            }

            // Remove the empty assistant message we just pushed
            messages.pop();

            // Push a nudge to coax the LLM into responding
            messages.push(LLMMessage {
                role: "user".into(),
                content: Some(MessageContent::text(
                    "Please provide your response. Summarize what was done or answer the question."
                )),
                tool_calls: None,
                tool_call_id: None,
            });
        }

        // After executing tool calls, always continue the loop so the LLM
        // can produce a final text response based on tool results.
        // Do NOT check finish_reason here — some providers return "stop"
        // even when tool_calls are present, and the content would be None.

        compact_messages_if_needed(&mut messages, config, working_dir).await;
    }

    let err = format!("Agent reached maximum iterations ({})", max_iter);
    on_event(AgentStreamEvent::Error);
    Err(err)
}

// ---------------------------------------------------------------------------
// Template seeding with multi-language support
// ---------------------------------------------------------------------------

/// Seed default persona templates into working_dir if they don't exist.
/// Language determines which template set (zh/en) to use.
pub fn seed_default_templates(working_dir: &std::path::Path, language: &str) {
    let (agents, soul, bootstrap) = if language.starts_with("zh") {
        (
            include_str!("templates/zh/AGENTS.md"),
            include_str!("templates/zh/SOUL.md"),
            include_str!("templates/zh/BOOTSTRAP.md"),
        )
    } else {
        (
            include_str!("templates/en/AGENTS.md"),
            include_str!("templates/en/SOUL.md"),
            include_str!("templates/en/BOOTSTRAP.md"),
        )
    };

    let templates: &[(&str, &str)] = &[
        ("AGENTS.md", agents),
        ("SOUL.md", soul),
        ("BOOTSTRAP.md", bootstrap),
    ];

    // Only seed BOOTSTRAP.md if bootstrap hasn't been completed
    let bootstrap_done = working_dir.join(BOOTSTRAP_COMPLETED).exists();

    for (name, content) in templates {
        if *name == "BOOTSTRAP.md" && bootstrap_done {
            continue;
        }
        let path = working_dir.join(name);
        if !path.exists() {
            std::fs::write(&path, content).ok();
            log::info!("Seeded default template ({}): {}", language, name);
        }
    }

    // Ensure memory directory exists
    let memory_dir = working_dir.join("memory");
    std::fs::create_dir_all(&memory_dir).ok();

    // Create memory subdirectories
    for sub in &["sessions", "topics", "compacted"] {
        std::fs::create_dir_all(memory_dir.join(sub)).ok();
    }
}

// ---------------------------------------------------------------------------
// Persona loading & system prompt building
// ---------------------------------------------------------------------------

/// Load persona files asynchronously.
/// Checks both working_dir (~/.yiyi/) and user_workspace (~/Documents/YiYi/),
/// with user_workspace taking priority (user may customize SOUL.md there via SetupWizard).
async fn load_persona(working_dir: &std::path::Path, user_workspace: Option<&std::path::Path>) -> String {
    let files = ["AGENTS.md", "SOUL.md", "PROFILE.md"];
    let mut parts = Vec::new();

    for name in &files {
        // Prefer user_workspace version, fallback to working_dir
        let content = if let Some(ws) = user_workspace {
            let ws_path = ws.join(name);
            match tokio::fs::read_to_string(&ws_path).await {
                Ok(c) => Some(c),
                Err(_) => tokio::fs::read_to_string(working_dir.join(name)).await.ok(),
            }
        } else {
            tokio::fs::read_to_string(working_dir.join(name)).await.ok()
        };

        if let Some(content) = content {
            let stripped = strip_yaml_frontmatter(&content);
            if !stripped.trim().is_empty() {
                parts.push(format!("# {}\n\n{}", name, stripped));
            }
        }
    }

    parts.join("\n\n")
}

/// Strip YAML frontmatter (--- delimited block at the start of a markdown file).
fn strip_yaml_frontmatter(content: &str) -> String {
    let trimmed = content.trim_start();
    if trimmed.starts_with("---") {
        if let Some(end) = trimmed[3..].find("\n---") {
            let after = &trimmed[3 + end + 4..];
            return after.trim_start_matches('\n').to_string();
        }
    }
    content.to_string()
}

/// Build the system prompt asynchronously.
/// Tool list is auto-generated from builtin_tools() to stay in sync.
/// Sanitize a string before injecting into system prompt.
/// Truncates, forces single-line, and strips injection-like patterns.
fn sanitize_prompt_field(s: &str, max_chars: usize) -> String {
    let truncated: String = s.chars().take(max_chars).collect();
    // Force single line (strip newlines that could break prompt structure)
    let single_line = truncated.replace('\n', " ").replace('\r', " ");
    // Strip patterns that look like prompt injection attempts
    let cleaned = single_line
        .replace("ignore", "")
        .replace("IGNORE", "")
        .replace("override", "")
        .replace("OVERRIDE", "")
        .replace("new role", "")
        .replace("forget", "");
    cleaned.trim().to_string()
}

pub async fn build_system_prompt(
    working_dir: &std::path::Path,
    user_workspace: Option<&std::path::Path>,
    skill_index: &[crate::commands::agent::SkillIndexEntry],
    always_active_skills: &[String],
    language: Option<&str>,
    mcp_tools: Option<&[super::mcp_runtime::MCPTool]>,
    unavailable_servers: Option<&[String]>,
) -> String {
    let persona = load_persona(working_dir, user_workspace).await;
    let lang = language.unwrap_or("zh-CN");
    let lang_instruction = if lang.starts_with("zh") {
        "Please respond in Chinese."
    } else {
        "Please respond in English."
    };

    let mut prompt = if persona.is_empty() {
        format!("You are YiYi, a helpful AI assistant. {}\n\n", lang_instruction)
    } else {
        format!("{}\n\n{}\n\n", persona, lang_instruction)
    };

    // Bootstrap guidance: check flag file to prevent re-triggering
    let bootstrap_done = working_dir.join(BOOTSTRAP_COMPLETED);
    if !bootstrap_done.exists() {
        let bootstrap_path = working_dir.join("BOOTSTRAP.md");
        if let Ok(bootstrap) = tokio::fs::read_to_string(&bootstrap_path).await {
            let stripped = strip_yaml_frontmatter(&bootstrap);
            if !stripped.trim().is_empty() {
                prompt.push_str(&stripped);
                prompt.push_str("\n\n");
                // Tell agent to create flag after completing bootstrap
                prompt.push_str(&format!(
                    "After completing bootstrap setup, create a flag file at '{}' \
                    (any content) to prevent re-triggering.\n\n",
                    bootstrap_done.to_string_lossy()
                ));
            }
        }
    }

    // Auto-generate tool list from builtin_tools() and MCP tools
    let tools = builtin_tools_filtered().await;
    let mut tool_lines: Vec<String> = tools
        .iter()
        .map(|t| format!("- {}: {}", t.function.name, t.function.description))
        .collect();

    // Append MCP tools in unified format
    if let Some(mcp) = mcp_tools {
        if !mcp.is_empty() {
            tool_lines.push("\n### MCP Server Tools (external)".to_string());
            for t in mcp {
                let server_hint = if t.server_key.is_empty() {
                    String::new()
                } else {
                    format!(" [server: {}]", t.server_key)
                };
                tool_lines.push(format!(
                    "- {}: {}{}",
                    t.name, t.description, server_hint
                ));
            }
        }
    }

    // Note any unavailable MCP servers
    if let Some(unavail) = unavailable_servers {
        if !unavail.is_empty() {
            tool_lines.push(format!(
                "\nNote: The following MCP servers are currently unavailable: {}. \
                Their tools cannot be used until they reconnect.",
                unavail.join(", ")
            ));
        }
    }

    let tool_list = tool_lines.join("\n");

    // Workspace & authorized folders information
    let output_dir = user_workspace
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| working_dir.to_string_lossy().to_string());
    let authorized_paths = super::tools::get_all_authorized_paths().await;
    let authorized_info = if authorized_paths.is_empty() {
        String::new()
    } else {
        format!(
            "\nAuthorized folders (you can freely access these):\n{}\n",
            authorized_paths
                .iter()
                .map(|p| format!("- {}", p))
                .collect::<Vec<_>>()
                .join("\n")
        )
    };

    // Detect Claude Code CLI availability and inject guidance (language-aware)
    let claude_code_guidance = if super::tools::is_claude_cli_available().await {
        if lang.starts_with("zh") {
            "\n\
### Claude Code 编码助手 (IMPORTANT)\n\
你的工具列表中有 `claude_code` 工具。对于**复杂编码任务**（多文件修改、架构分析、大规模重构），优先使用它：\n\
- 代码编写/修改/重构（新功能、bug修复、多文件修改）\n\
- 代码搜索/分析（查找定义、理解架构、分析调用链）\n\
- 测试编写和运行\n\
- Git 操作（提交、分支管理，但不自动 push）\n\
- 构建/调试（编译错误修复、依赖排查）\n\n\
Claude Code 拥有完整的代码理解、编辑、搜索和终端能力，比内置工具更高效。\n\
调用时通过 `prompt` 参数描述具体任务，通过 `context` 参数传递项目约定或对话背景。\n\
多次调用会自动保持上下文连续性。完成后必须向用户展示成果（代码diff、运行结果等），不要只说「已完成」。\n\
简单的单文件查看或小修改可直接使用内置工具（read_file、edit_file）。\n"
        } else {
            "\n\
### Claude Code Coding Assistant (IMPORTANT)\n\
You have a `claude_code` tool available. For **complex coding tasks** (multi-file changes, architecture analysis, large refactors), prefer using it:\n\
- Code writing/modification/refactoring\n\
- Code search/analysis (find definitions, understand architecture)\n\
- Test writing and execution\n\
- Git operations (commit, branch management — no auto push)\n\
- Build/debug (compile errors, dependency issues)\n\n\
Claude Code has full code understanding, editing, search, and terminal capabilities.\n\
Use `prompt` to describe the task, `context` to pass project conventions or conversation background.\n\
Multiple calls automatically maintain session continuity. Always show results to the user after completion.\n\
For simple single-file reads or small edits, use built-in tools (read_file, edit_file) directly.\n"
        }
    } else {
        ""
    };

    prompt.push_str(&format!(
        "\
## Workspace & File Access
Your default output directory is: {output_dir}
When creating files (documents, spreadsheets, reports, etc.), save them here unless the user specifies a different path.
{authorized_info}
Files outside authorized folders are blocked. If the user asks you to access a path that is blocked, \
tell them to add the folder in Settings > Workspace.
Sensitive files (.env, .ssh, .pem, credentials) are always blocked for security.

## Tools
You have access to these tools:
{tool_list}

IMPORTANT: For simple document reading, prefer built-in tools (read_pdf, read_docx, \
read_spreadsheet). For advanced operations (PDF forms, PPTX creation, complex Excel), \
use run_python or run_python_script with the appropriate libraries.
{claude_code_guidance}
When using tools:
- Think step by step about what you need to do
- Use the appropriate tool for each step
- Summarize the results for the user
- If a tool fails, try an alternative approach
- ALWAYS use delete_file instead of shell 'rm' commands to delete files or directories. \
This ensures proper permission checks and prevents accidental deletion of important files.

## 后台任务 (IMPORTANT)
任何需要**创建文件**或**设置定时任务**的请求，都必须使用 `create_task` 创建后台任务。\
后台任务在独立工作空间中执行，不影响主对话窗口的问答。

### 必须使用 `create_task` 的场景：
- 需要创建、写入、生成任何文件（代码、文档、网页、配置等）
- 需要设置定时任务或周期性执行
- 需要多步骤操作（构建项目、分析文档、批量处理等）
- Examples: 帮我建个网站, 写一份报告, 创建一个脚本, 设置定时备份

### 不需要使用 `create_task` 的场景：
- 纯问答、解释概念、翻译文本
- 只需要读取/搜索信息（不产生文件）
- 简单的单步计算或查询

### CRITICAL 规则：
1. 不要在主对话中直接创建文件，一律通过 `create_task` 后台执行
2. 创建任务后，立即用简短文字告知用户：任务已在后台开始执行，可以在右侧面板查看进度，不影响继续对话
3. 不需要询问用户是否要后台执行，直接创建任务即可

## Presenting Results (IMPORTANT)
After completing a task, you MUST make the results immediately visible to the user:
- **Website/HTML**: Use browser_use(action='start', headed=true) to launch a visible browser, \
then browser_use(action='goto', url=...) to open the page. Start a local server if needed.
- **Script/CLI tool**: Run it once with execute_shell and show the output.
- **Algorithm/function**: Show the code and a sample run with input/output.
- **Modified project**: Show a summary of changes and run tests/build to confirm.
- NEVER just say 'done' — always show tangible results the user can see or use immediately.
- NEVER package output as a zip for the user to unpack manually.

When a skill references Python scripts (e.g. `python scripts/xxx.py`), \
use the run_python_script tool with the full absolute path. \
The script path is relative to the skill directory shown in [Skill directory: ...]. \
Example: run_python_script with script_path=<skill_directory>/scripts/xxx.py

If a required Python package is missing, use pip_install to install it first.

## Scheduled Tasks & Reminders
Choose the right tool based on timing:
- **Short delay** (< 30 min, e.g. '5分钟后提醒我'): manage_cronjob with schedule_type='delay', delay_minutes=N
- **Specific time today** (e.g. '下午3点提醒我'): manage_cronjob with schedule_type='once', schedule_at (ISO 8601)
- **Long-term reminder** (hours/days/weeks, e.g. '明天9点', '下周三提醒我'): add_calendar_event — adds to system calendar with alert
- **Recurring** (e.g. '每天9点提醒我'): manage_cronjob with schedule_type='cron', cron expression (6 fields: sec min hour day month weekday)
IMPORTANT: Do NOT use cron for one-time tasks. For reminders > 30 min away, prefer add_calendar_event.

## Bots & External Messaging
Users can bind external platform bots (Discord, Telegram, QQ, Feishu, DingTalk, etc.) to chat sessions.
- To check which bots are bound: call the `list_bound_bots` tool
- To send a message through a bot: call the `send_bot_message` tool
- To create/manage bots: call the `manage_bot` tool
- Bot information is stored in the database, NEVER in config files — do NOT read config files to find bot info
- If the user mentions a bot name or asks to send a message to an external platform, use these tools

## Web Search (web_search tool)
Use `web_search` for quick information lookup. It searches DuckDuckGo and returns results instantly — no browser needed.
- Prefer `web_search` over `browser_use` for simple searches
- If you need more detail from a search result, use `browser_use` to open the URL

## Browser Usage (browser_use tool)
You have a full Chromium browser for web automation. Use it when you need to:
- **Browse websites** — open and interact with specific URLs
- **Operate platforms** — post content, manage accounts, perform actions on websites
- **Set up platform bots** — navigate developer consoles, extract credentials
- **Scrape or extract data** — read page content, find elements, collect information
- **Deep search** — when `web_search` results are insufficient, open a URL from the results to read the full page

### Decision flow:
1. If the user asks to search for information → **use web_search** first for quick results
2. If you need to read a full page or interact with a website → **use browser_use**
3. If the task involves any web interaction (clicking, filling forms, etc.) → **use browser_use**
4. NEVER tell the user you cannot access a website or search the web.

### Common workflow:
1. `browser_use(action='start', headed=true)` — start visible browser
2. `browser_use(action='open', url='...')` — open the target URL
3. `browser_use(action='screenshot')` — see the page visually (the screenshot is sent to you as an image)
4. `browser_use(action='snapshot')` — read the page text content
5. Use click/type/scroll/find_elements to interact with the page
6. Use `list_frames` + `evaluate_in_frame` if the page has iframes
7. `browser_use(action='stop')` — close when done

### Platform bot setup:
When setting up bots, open the developer console:
- Feishu: https://open.feishu.cn/app
- Discord: https://discord.com/developers/applications
- Telegram: https://t.me/BotFather
- DingTalk: https://open-dev.dingtalk.com/
- QQ: https://q.qq.com/

### Key principles:
- Use `headed=true` so the user can see and interact with the browser
- Take screenshots frequently — you can see them as images to understand the page
- When user action is needed (login, QR scan, CAPTCHA): tell the user \"请在浏览器中完成登录/扫码，完成后告诉我\"
- NEVER try to fill in passwords — let the user do it
- Be patient — wait for user confirmation between steps
- When browsing Chinese sites (小红书、微博、抖音等), navigate directly to the website URL
",
        output_dir = output_dir,
        authorized_info = authorized_info,
        tool_list = tool_list,
    ));

    // Load HOT-tier context from DB (unified principles + long-term memory)
    if let Some(db) = super::tools::get_database() {
        let hot_context = super::tiered_memory::load_hot_context(&db, 2500);
        if !hot_context.is_empty() {
            prompt.push_str(&hot_context);
        } else {
            // Fallback: if no HOT-tier memories yet, inject high-confidence corrections directly
            let corrections = db.get_high_confidence_corrections(5, 0.60);
            if !corrections.is_empty() {
                prompt.push_str("\n\n## Learned Behaviors (from past feedback)\n");
                for (trigger, _, behavior, _confidence) in &corrections {
                    let safe_trigger = sanitize_prompt_field(trigger, 80);
                    let safe_behavior = sanitize_prompt_field(behavior, 150);
                    prompt.push_str(&format!("- {}: {}\n", safe_trigger, safe_behavior));
                }
            }
        }
    }

    // Skill genesis + consolidation trigger
    if let Some(db) = super::tools::get_database() {
        if let Some(suggestion) = detect_skill_opportunity(&db) {
            prompt.push_str(&format!(
                "\n\n## Proactive Suggestion\n{}\n\
                 If the user agrees, use manage_skill(action='create') to create the skill.\n",
                suggestion
            ));
        }
    }

    // Inject code library summary (so LLM knows what scripts are available)
    if let Some(db) = super::tools::get_database() {
        let code_entries = db.search_code_registry("", 10);
        if !code_entries.is_empty() {
            prompt.push_str("\n\n## My Code Library (scripts I've created)\n\
                             Before writing new code, check if something similar exists here. Use `search_my_code` for details.\n");
            for entry in code_entries.iter().take(10) {
                let status = if let Some(ref err) = entry.last_error {
                    {
                        // Sanitize error: remove potential sensitive paths
                        let sanitized: String = err.chars().take(50).collect();
                        format!(" [LAST ERROR: {}]", sanitized.replace(|c: char| c == '/' || c == '\\', "_"))
                    }
                } else if entry.run_count > 0 {
                    format!(" [{}/{} runs OK]", entry.success_count, entry.run_count)
                } else {
                    " [never run]".into()
                };
                let safe_desc = sanitize_prompt_field(&entry.description, 120);
                prompt.push_str(&format!("- **{}** ({}): {}{}\n",
                    entry.name, entry.language, safe_desc, status
                ));
            }
            if code_entries.len() > 10 {
                prompt.push_str(&format!("  ...and {} more. Use search_my_code to find them.\n", code_entries.len() - 10));
            }
        }
    }

    // Long-term memory is now included in HOT-tier context loaded above (via tiered_memory::load_hot_context).
    // No separate MEMORY.md file read needed.

    // Skill index — model calls activate_skills tool to load full content on demand
    if !skill_index.is_empty() {
        prompt.push_str("\n\n## Available Skills (call `activate_skills` tool to load detailed instructions)\n");
        for entry in skill_index {
            if entry.description.is_empty() {
                prompt.push_str(&format!("- {}\n", entry.name));
            } else {
                prompt.push_str(&format!("- **{}**: {}\n", entry.name, entry.description));
            }
        }
    }

    // Always-active skills — injected directly (e.g. auto_continue)
    for skill in always_active_skills {
        if !skill.is_empty() {
            prompt.push_str("\n---\n");
            prompt.push_str(skill);
            prompt.push('\n');
        }
    }

    prompt
}

// build_agent_system_prompt removed — switched to dynamic agent spawning.

// ---------------------------------------------------------------------------
// /compact command support
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Message sanitization — fix broken tool message sequences
// ---------------------------------------------------------------------------

/// Sanitize messages to prevent API errors from malformed tool sequences.
///
/// Fixes:
/// 1. Orphan tool results (tool messages without a preceding assistant tool_call)
/// 2. Missing tool results (assistant has tool_calls but no matching tool response)
/// 3. Tool messages not immediately following their parent assistant (strict APIs like DashScope)
fn sanitize_messages(messages: &mut Vec<LLMMessage>) {
    use std::collections::{HashMap, HashSet};

    // Phase 1: Build a map of tool_call_id → assistant message index
    let mut tool_call_to_assistant: HashMap<String, usize> = HashMap::new();
    let mut seen_tool_ids: HashSet<String> = HashSet::new();

    for (i, msg) in messages.iter().enumerate() {
        if msg.role == "assistant" {
            if let Some(calls) = &msg.tool_calls {
                for call in calls {
                    tool_call_to_assistant.insert(call.id.clone(), i);
                }
            }
        }
        if msg.role == "tool" {
            if let Some(id) = &msg.tool_call_id {
                seen_tool_ids.insert(id.clone());
            }
        }
    }

    // Phase 2: Remove orphan tool messages (no matching assistant tool_call)
    let before = messages.len();
    messages.retain(|msg| {
        if msg.role == "tool" {
            if let Some(id) = &msg.tool_call_id {
                return tool_call_to_assistant.contains_key(id);
            }
            return false;
        }
        true
    });
    if messages.len() != before {
        log::info!("Sanitized: removed {} orphan tool messages", before - messages.len());
    }

    // Phase 3: Inject placeholders for missing tool results
    let expected_ids: HashSet<String> = tool_call_to_assistant.keys().cloned().collect();
    let missing_ids: Vec<String> = expected_ids.difference(&seen_tool_ids).cloned().collect();

    if !missing_ids.is_empty() {
        for id in &missing_ids {
            let assistant_idx = messages.iter().position(|m| {
                m.role == "assistant"
                    && m.tool_calls.as_ref()
                        .map_or(false, |calls| calls.iter().any(|c| &c.id == id))
            });
            if let Some(idx) = assistant_idx {
                let mut insert_at = idx + 1;
                while insert_at < messages.len() && messages[insert_at].role == "tool" {
                    insert_at += 1;
                }
                messages.insert(insert_at, LLMMessage {
                    role: "tool".into(),
                    content: Some(MessageContent::text("(result unavailable)")),
                    tool_calls: None,
                    tool_call_id: Some(id.clone()),
                });
            }
        }
        log::info!("Sanitized: injected {} placeholder tool results", missing_ids.len());
    }

    // Phase 4: Ensure tool messages immediately follow their parent assistant.
    // Some API providers (DashScope/Qwen) require strict ordering:
    // assistant(tool_calls) must be immediately followed by its tool results.
    // Re-arrange by collecting tool messages and re-inserting after their parent assistant.
    let mut relocated = 0usize;
    let mut i = 0;
    while i < messages.len() {
        if messages[i].role == "tool" {
            let tool_call_id = match messages[i].tool_call_id.as_deref() {
                Some(id) if !id.is_empty() => id.to_string(),
                _ => { i += 1; continue; } // skip tool messages without valid ID
            };
            // Find the parent assistant
            let parent_idx = messages[..i].iter().rposition(|m| {
                m.role == "assistant"
                    && m.tool_calls.as_ref()
                        .map_or(false, |calls| calls.iter().any(|c| c.id == tool_call_id))
            });
            if let Some(pidx) = parent_idx {
                // Check if this tool message is already in the correct position
                // (immediately after parent assistant and any sibling tool messages)
                let mut expected_pos = pidx + 1;
                while expected_pos < messages.len()
                    && expected_pos < i
                    && messages[expected_pos].role == "tool"
                {
                    expected_pos += 1;
                }
                if expected_pos != i {
                    // Need to relocate: remove from current position, insert after parent's tool block
                    let tool_msg = messages.remove(i);
                    let mut insert_at = pidx + 1;
                    while insert_at < messages.len() && messages[insert_at].role == "tool" {
                        insert_at += 1;
                    }
                    messages.insert(insert_at, tool_msg);
                    relocated += 1;
                    continue; // don't increment i since we removed an element
                }
            }
        }
        i += 1;
    }
    if relocated > 0 {
        log::info!("Sanitized: relocated {} tool messages to correct positions", relocated);
    }
}

// ---------------------------------------------------------------------------
// Context compaction
// ---------------------------------------------------------------------------

/// Estimate total token count of all messages.
fn total_message_tokens(messages: &[LLMMessage]) -> usize {
    messages
        .iter()
        .map(|m| {
            let content_tokens = m.content.as_ref().and_then(|c| c.as_text()).map_or(0, estimate_tokens);
            let tool_tokens = m
                .tool_calls
                .as_ref()
                .map_or(0, |calls| {
                    calls.iter().map(|c| estimate_tokens(&c.function.arguments)).sum::<usize>()
                });
            4 + content_tokens + tool_tokens
        })
        .sum()
}

/// Compact messages when context exceeds threshold.
async fn compact_messages_if_needed(
    messages: &mut Vec<LLMMessage>,
    config: &LLMConfig,
    working_dir: Option<&std::path::Path>,
) {
    let total = total_message_tokens(messages);
    if total < COMPACT_THRESHOLD || messages.len() < 6 {
        return;
    }

    log::info!(
        "Context compaction triggered: ~{} tokens, {} messages",
        total,
        messages.len()
    );

    // Find where the "head" (system messages) ends
    let keep_start = messages.iter()
        .position(|m| m.role != "system")
        .unwrap_or(1);

    let min_keep = 4;
    let mut mid_end = messages.len().saturating_sub(min_keep);
    if mid_end <= keep_start {
        return;
    }
    while mid_end > keep_start && messages[mid_end].role == "tool" {
        mid_end -= 1;
    }
    if mid_end <= keep_start {
        return;
    }
    let middle: Vec<&LLMMessage> = messages[keep_start..mid_end].iter().collect();

    let mut summary_parts: Vec<String> = Vec::new();
    for msg in &middle {
        match msg.role.as_str() {
            "assistant" => {
                if let Some(calls) = &msg.tool_calls {
                    for call in calls {
                        summary_parts.push(format!("- Called tool: {}", call.function.name));
                    }
                }
                if let Some(text) = msg.content.as_ref().and_then(|c| c.as_text()) {
                    if !text.is_empty() {
                        let preview: String = text.chars().take(200).collect();
                        summary_parts.push(format!("- Assistant: {}...", preview));
                    }
                }
            }
            "user" => {
                if let Some(text) = msg.content.as_ref().and_then(|c| c.as_text()) {
                    let preview: String = text.chars().take(100).collect();
                    summary_parts.push(format!("- User: {}...", preview));
                }
            }
            "tool" => {
                if let Some(text) = msg.content.as_ref().and_then(|c| c.as_text()) {
                    let preview: String = text.chars().take(100).collect();
                    summary_parts.push(format!("  Result: {}...", preview));
                }
            }
            _ => {}
        }
    }

    let summary = if summary_parts.len() > 10 {
        let summary_request = format!(
            "Summarize these previous interactions concisely (max 500 chars):\n{}",
            summary_parts.join("\n")
        );
        let summary_msgs = vec![LLMMessage {
            role: "user".into(),
            content: Some(MessageContent::text(summary_request)),
            tool_calls: None,
            tool_call_id: None,
        }];
        match chat_completion(config, &summary_msgs, &[]).await {
            Ok(resp) => resp
                .message
                .content
                .map(|c| c.into_text())
                .unwrap_or_else(|| summary_parts.join("\n")),
            Err(_) => summary_parts.join("\n"),
        }
    } else {
        summary_parts.join("\n")
    };

    let summary_msg = LLMMessage {
        role: "system".into(),
        content: Some(MessageContent::text(format!(
            "[Previous context compacted — {} messages summarized]\n{}",
            middle.len(),
            summary
        ))),
        tool_calls: None,
        tool_call_id: None,
    };

    let mut new_messages = Vec::new();
    new_messages.extend(messages[..keep_start].iter().cloned());
    new_messages.push(summary_msg);
    new_messages.extend(messages[mid_end..].iter().cloned());

    let new_total = total_message_tokens(&new_messages);
    log::info!(
        "Compacted: {} → {} messages, ~{} → ~{} tokens",
        messages.len(),
        new_messages.len(),
        total,
        new_total
    );

    *messages = new_messages;

    if let Some(dir) = working_dir {
        let summary_path = dir.join(COMPACT_SUMMARY_FILE);
        tokio::fs::write(&summary_path, &summary).await.ok();
        log::info!("Persisted compact summary to {}", summary_path.display());

        // Also write to memory/compacted/
        let compacted_dir = dir.join("memory").join("compacted");
        tokio::fs::create_dir_all(&compacted_dir).await.ok();
        let date = chrono::Local::now().format("%Y-%m-%d").to_string();
        let compacted_path = compacted_dir.join(format!("compacted_{}.md", date));
        let entry = format!(
            "\n## Compacted at {}\n\n{}\n\n---\n",
            chrono::Local::now().format("%Y-%m-%d %H:%M"),
            summary
        );
        use tokio::io::AsyncWriteExt;
        if let Ok(mut f) = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&compacted_path)
            .await
        {
            f.write_all(entry.as_bytes()).await.ok();
        }
    }
}

// ---------------------------------------------------------------------------
// Auto-memory extraction — extract noteworthy info from conversations
// ---------------------------------------------------------------------------

/// Extract memories from a conversation turn using LLM.
/// Called after the assistant finishes replying.
/// Runs in the background so it doesn't block the user.
pub async fn extract_memories_from_conversation(
    config: &LLMConfig,
    user_message: &str,
    assistant_reply: &str,
    session_id: Option<&str>,
) {
    use super::tools::get_database;

    let db = match get_database() {
        Some(db) => db,
        None => return,
    };

    // Skip very short conversations (greetings, etc.)
    if user_message.len() < 20 && assistant_reply.len() < 50 {
        return;
    }

    // Truncate to avoid sending huge texts to LLM
    let user_preview: String = user_message.chars().take(2000).collect();
    let assistant_preview: String = assistant_reply.chars().take(2000).collect();

    let extraction_prompt = format!(
        r#"Analyze the following conversation and extract any information worth remembering for future conversations.
Focus on:
- User preferences (likes, dislikes, habits)
- Important facts about the user (name, occupation, projects, etc.)
- Decisions made during the conversation
- Key experiences or lessons learned
- Important notes or context

For each memory, provide a category from: fact, preference, experience, decision, note

Respond ONLY with a JSON array. Each element should be an object with "content" (string) and "category" (string).
If there is nothing worth remembering, respond with an empty array: []

Conversation:
User: {user_preview}
Assistant: {assistant_preview}

Extract memories (JSON array only):"#
    );

    let messages = vec![LLMMessage {
        role: "user".into(),
        content: Some(MessageContent::text(extraction_prompt)),
        tool_calls: None,
        tool_call_id: None,
    }];

    let result = match chat_completion(config, &messages, &[]).await {
        Ok(resp) => resp.message.content.map(|c| c.into_text()).unwrap_or_default(),
        Err(e) => {
            log::warn!("Memory extraction LLM call failed: {}", e);
            return;
        }
    };

    // Parse the JSON response
    let trimmed = result.trim();
    // Handle cases where LLM wraps in ```json ... ```
    let json_str = if trimmed.starts_with("```") {
        trimmed
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim()
    } else {
        trimmed
    };

    #[derive(serde::Deserialize)]
    struct ExtractedMemory {
        content: String,
        category: String,
    }

    let memories: Vec<ExtractedMemory> = match serde_json::from_str(json_str) {
        Ok(m) => m,
        Err(e) => {
            log::debug!(
                "Memory extraction parse error: {} (response: {})",
                e,
                &result[..result.len().min(200)]
            );
            return;
        }
    };

    if memories.is_empty() {
        return;
    }

    let valid_categories = ["fact", "preference", "experience", "decision", "note"];
    let mut added = 0;
    for mem in &memories {
        let cat = if valid_categories.contains(&mem.category.as_str()) {
            &mem.category
        } else {
            "note"
        };
        if !mem.content.is_empty() {
            if let Ok(mem_id) = db.memory_add(&mem.content, cat, session_id) {
                added += 1;

                // Auto-promote high-value memories to HOT tier if there's room
                if matches!(cat, "fact" | "preference" | "principle") {
                    let hot_count = db.get_memories_by_tier("hot", 20).len();
                    if hot_count < 15 {
                        db.update_memory_tier(&mem_id, "hot", 0.8);
                        // Sync to files immediately for non-meditation users
                        if let Some(working_dir) = super::tools::get_working_dir() {
                            super::tiered_memory::sync_hot_to_files(&db, &working_dir);
                        }
                    }
                }
            }
            // Also write to diary (diary is separate from tiered memory)
            if let Some(working_dir) = super::tools::get_working_dir() {
                let _ = super::memory::append_diary(&working_dir, &mem.content, Some(cat));
            }
        }
    }

    if added > 0 {
        log::info!("Auto-extracted {} memories from conversation", added);
    }
}

// ---------------------------------------------------------------------------
// Growth System — Post-task reflection
// ---------------------------------------------------------------------------

/// Reflect on a completed task: assess outcome, extract lessons, identify skill opportunities.
/// Runs in the background after task completion. Stores results in reflections table.
pub async fn reflect_on_task(
    config: &LLMConfig,
    task_id: Option<&str>,
    session_id: Option<&str>,
    task_description: &str,
    result_text: &str,
    was_successful: bool,
    signal_type: SignalType,
) {
    use super::tools::get_database;

    // Rate limit: max 3 concurrent background LLM calls
    let _permit = match GROWTH_LLM_SEMAPHORE.try_acquire() {
        Ok(p) => p,
        Err(_) => {
            log::debug!("Growth reflection skipped: too many concurrent LLM calls");
            return;
        }
    };

    let db = match get_database() {
        Some(db) => db,
        None => return,
    };

    // Skip trivial tasks
    if task_description.len() < 10 && result_text.len() < 30 {
        return;
    }

    let desc_preview: String = task_description.chars().take(1500).collect();
    let result_preview: String = result_text.chars().take(1500).collect();
    let outcome_hint = if was_successful { "success" } else { "failure" };
    let signal_hint = signal_type.as_str();

    let reflection_prompt = format!(
        r#"You are reflecting on a completed task. Analyze what happened and extract lessons.

Task: {desc_preview}
Outcome: {outcome_hint}
Signal: {signal_hint}
Result: {result_preview}

Respond ONLY with a JSON object:
{{
  "outcome": "success" | "partial" | "failure",
  "summary": "one-sentence summary of what happened",
  "lesson": "generalizable lesson for future tasks (or null if none)",
  "skill_opportunity": "if this task could be automated as a reusable skill, describe it briefly (or null)"
}}

JSON only:"#
    );

    let messages = vec![LLMMessage {
        role: "user".into(),
        content: Some(MessageContent::text(reflection_prompt)),
        tool_calls: None,
        tool_call_id: None,
    }];

    let result = match chat_completion(config, &messages, &[]).await {
        Ok(resp) => resp.message.content.map(|c| c.into_text()).unwrap_or_default(),
        Err(e) => {
            log::warn!("Reflection LLM call failed: {}", e);
            // Still save a basic reflection without LLM analysis
            db.add_reflection(
                task_id, session_id, outcome_hint,
                &format!("Task completed ({outcome_hint}), LLM reflection unavailable"),
                None, None,
                signal_type.as_str(), signal_type.base_confidence(),
            ).ok();
            return;
        }
    };

    // Parse JSON
    let trimmed = result.trim();
    let json_str = if trimmed.starts_with("```") {
        trimmed
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim()
    } else {
        trimmed
    };

    #[derive(serde::Deserialize)]
    struct ReflectionResult {
        outcome: Option<String>,
        summary: Option<String>,
        lesson: Option<String>,
        skill_opportunity: Option<String>,
    }

    let parsed: ReflectionResult = match serde_json::from_str(json_str) {
        Ok(r) => r,
        Err(e) => {
            log::debug!("Reflection parse error: {} (response: {})", e, &result[..result.len().min(200)]);
            db.add_reflection(
                task_id, session_id, outcome_hint,
                &format!("Task {outcome_hint}"),
                None, None,
                signal_type.as_str(), signal_type.base_confidence(),
            ).ok();
            return;
        }
    };

    let outcome = parsed.outcome.as_deref().unwrap_or(outcome_hint);
    let summary = parsed.summary.as_deref().unwrap_or("(no summary)");

    // Save reflection
    if let Ok(ref_id) = db.add_reflection(
        task_id, session_id, outcome, summary,
        parsed.lesson.as_deref(),
        parsed.skill_opportunity.as_deref(),
        signal_type.as_str(), signal_type.base_confidence(),
    ) {
        log::info!("Reflection saved: {} (outcome: {}, signal: {})", ref_id, outcome, signal_type.as_str());
    }

    // Only promote lessons from explicit signals — silence is not approval
    if signal_type != SignalType::SilentCompletion {
        if let Some(ref lesson) = parsed.lesson {
            if !lesson.is_empty() {
                db.memory_add(lesson, "experience", session_id).ok();
            }
        }
    }
}

/// Analyze user feedback and generate behavioral corrections.
/// Called when user provides negative feedback (thumbs down, "redo", corrections).
pub async fn learn_from_feedback(
    config: &LLMConfig,
    user_feedback: &str,
    original_request: &str,
    agent_response: &str,
) {
    use super::tools::get_database;

    // Rate limit: max 3 concurrent background LLM calls
    let _permit = match GROWTH_LLM_SEMAPHORE.try_acquire() {
        Ok(p) => p,
        Err(_) => {
            log::debug!("Feedback learning skipped: too many concurrent LLM calls");
            return;
        }
    };

    let db = match get_database() {
        Some(db) => db,
        None => return,
    };

    if user_feedback.len() < 5 {
        return;
    }

    let feedback_preview: String = user_feedback.chars().take(1000).collect();
    let request_preview: String = original_request.chars().take(800).collect();
    let response_preview: String = agent_response.chars().take(800).collect();

    let correction_prompt = format!(
        r#"The user gave negative feedback about an AI assistant's response. Analyze and create a behavioral correction rule.

User's original request: {request_preview}
AI's response (that the user didn't like): {response_preview}
User's feedback: {feedback_preview}

Create a correction rule. Respond ONLY with a JSON object:
{{
  "trigger": "when the user asks/does X...",
  "wrong_behavior": "I previously did Y...",
  "correct_behavior": "I should do Z instead..."
}}

JSON only:"#
    );

    let messages = vec![LLMMessage {
        role: "user".into(),
        content: Some(MessageContent::text(correction_prompt)),
        tool_calls: None,
        tool_call_id: None,
    }];

    let result = match chat_completion(config, &messages, &[]).await {
        Ok(resp) => resp.message.content.map(|c| c.into_text()).unwrap_or_default(),
        Err(e) => {
            log::warn!("Feedback learning LLM call failed: {}", e);
            return;
        }
    };

    let trimmed = result.trim();
    let json_str = if trimmed.starts_with("```") {
        trimmed
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim()
    } else {
        trimmed
    };

    #[derive(serde::Deserialize)]
    struct CorrectionResult {
        trigger: String,
        wrong_behavior: Option<String>,
        correct_behavior: String,
    }

    let parsed: CorrectionResult = match serde_json::from_str(json_str) {
        Ok(r) => r,
        Err(e) => {
            log::debug!("Correction parse error: {}", e);
            return;
        }
    };

    match db.add_correction(
        &parsed.trigger,
        parsed.wrong_behavior.as_deref(),
        &parsed.correct_behavior,
        Some("user_feedback"),
        0.90,
    ) {
        Ok(id) => {
            log::info!("Correction rule saved: {}", id);
            // Auto-consolidate when corrections accumulate (every 5 new corrections)
            let count = db.count_active_corrections();
            if count >= 3 && count % 5 == 0 {
                if let Some(working_dir) = super::tools::get_working_dir() {
                    let cfg = config.clone();
                    let wd = working_dir.clone();
                    tokio::spawn(async move {
                        match consolidate_corrections_to_principles(&cfg, &super::tools::get_database().unwrap(), &wd).await {
                            Ok(msg) => log::info!("Auto-consolidation: {}", msg),
                            Err(e) => log::warn!("Auto-consolidation failed: {}", e),
                        }
                    });
                }
            }
        }
        Err(e) => log::warn!("Failed to save correction: {}", e),
    }
}

// ---------------------------------------------------------------------------
// Growth System — Growth Report & Skill Genesis
// ---------------------------------------------------------------------------

/// Generate a growth report from recent reflections.
/// Returns a summary of success rate, failure patterns, and recommended actions.
pub fn generate_growth_report(db: &super::db::Database) -> Option<GrowthReport> {
    let reflections = db.get_recent_reflections(50);
    if reflections.is_empty() {
        return None;
    }

    let total = reflections.len();
    let successes = reflections.iter().filter(|(o, _, _)| o == "success").count();
    let failures = reflections.iter().filter(|(o, _, _)| o == "failure").count();
    let partials = total - successes - failures;

    // Collect lessons
    let lessons: Vec<&str> = reflections
        .iter()
        .filter_map(|(_, _, l)| l.as_deref())
        .filter(|l| !l.is_empty())
        .collect();

    // Skill opportunities are handled separately by detect_skill_opportunity()

    Some(GrowthReport {
        total_tasks: total,
        success_count: successes,
        failure_count: failures,
        partial_count: partials,
        success_rate: successes as f64 / total as f64,
        top_lessons: lessons.into_iter().take(5).map(String::from).collect(),
    })
}

/// Growth report data structure.
#[derive(Debug, Clone, serde::Serialize)]
pub struct GrowthReport {
    pub total_tasks: usize,
    pub success_count: usize,
    pub failure_count: usize,
    pub partial_count: usize,
    pub success_rate: f64,
    pub top_lessons: Vec<String>,
}

/// Check if there are recurring skill opportunities in reflections.
/// Returns a suggestion message if a pattern is detected (3+ similar opportunities).
pub fn detect_skill_opportunity(db: &super::db::Database) -> Option<String> {
    let conn = match db.get_conn() {
        Some(c) => c,
        None => return None,
    };

    // Query skill_opportunity from reflections where it's not null
    let mut stmt = conn
        .prepare(
            "SELECT skill_opportunity FROM reflections
             WHERE skill_opportunity IS NOT NULL AND skill_opportunity != ''
             ORDER BY created_at DESC LIMIT 20",
        )
        .ok()?;

    let opportunities: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .ok()?
        .filter_map(|r| r.ok())
        .collect();

    if opportunities.len() < 3 {
        return None;
    }

    // Simple frequency detection: if 3+ opportunities mention similar words
    // (this is a heuristic; a more sophisticated version would use embeddings)
    let first = &opportunities[0];
    let similar_count = opportunities
        .iter()
        .skip(1)
        .filter(|o| {
            // Check if they share at least 2 significant words
            let words_a: std::collections::HashSet<&str> = first.split_whitespace()
                .filter(|w| w.len() > 3)
                .collect();
            let words_b: std::collections::HashSet<&str> = o.split_whitespace()
                .filter(|w| w.len() > 3)
                .collect();
            words_a.intersection(&words_b).count() >= 2
        })
        .count();

    if similar_count >= 2 {
        Some(format!(
            "I've noticed a recurring pattern in your tasks: \"{}\". Would you like me to create a reusable skill for this?",
            first
        ))
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Growth System — Capability Profile
// ---------------------------------------------------------------------------

/// A single capability dimension with success metrics.
#[derive(Debug, Clone, serde::Serialize)]
pub struct CapabilityDimension {
    pub name: String,
    pub success_rate: f64,
    pub sample_count: usize,
    pub confidence: String, // "low" (<5), "medium" (5-15), "high" (>15)
}

/// Build a capability profile from reflection summaries.
/// Groups reflections by detected task category and computes success rates.
pub fn build_capability_profile(db: &super::db::Database) -> Vec<CapabilityDimension> {
    let conn = match db.get_conn() {
        Some(c) => c,
        None => return Vec::new(),
    };

    // Get all reflections with outcome and summary
    let mut stmt = match conn.prepare(
        "SELECT outcome, summary FROM reflections ORDER BY created_at DESC LIMIT 200",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let rows: Vec<(String, String)> = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .ok()
        .map(|r| r.flatten().collect())
        .unwrap_or_default();

    if rows.is_empty() {
        return Vec::new();
    }

    // Categorize by keywords in summary
    let categories = [
        ("coding", &["代码", "编程", "code", "programming", "编写", "函数", "bug", "refactor", "实现", "feature"][..]),
        ("documents", &["文档", "报告", "文件", "document", "report", "writing", "docx", "pdf", "pptx"]),
        ("data_analysis", &["数据", "分析", "统计", "data", "analysis", "csv", "excel", "表格"]),
        ("web_automation", &["浏览器", "网页", "browser", "web", "scrape", "自动化"]),
        ("system_ops", &["shell", "命令", "安装", "部署", "deploy", "系统", "terminal", "服务器"]),
        ("scheduling", &["定时", "提醒", "cron", "schedule", "reminder", "任务"]),
    ];

    let mut category_stats: std::collections::HashMap<&str, (usize, usize)> = std::collections::HashMap::new();

    for (outcome, summary) in &rows {
        let summary_lower = summary.to_lowercase();
        let is_success = outcome == "success";

        let mut matched = false;
        for (cat_name, keywords) in &categories {
            if keywords.iter().any(|kw| summary_lower.contains(kw)) {
                let entry = category_stats.entry(cat_name).or_insert((0, 0));
                entry.0 += 1; // total
                if is_success {
                    entry.1 += 1; // successes
                }
                matched = true;
                break;
            }
        }
        if !matched {
            let entry = category_stats.entry("other").or_insert((0, 0));
            entry.0 += 1;
            if is_success {
                entry.1 += 1;
            }
        }
    }

    let display_names: std::collections::HashMap<&str, &str> = [
        ("coding", "Coding"),
        ("documents", "Documents"),
        ("data_analysis", "Data Analysis"),
        ("web_automation", "Web Automation"),
        ("system_ops", "System Ops"),
        ("scheduling", "Scheduling"),
        ("other", "Other"),
    ].into_iter().collect();

    let mut profile: Vec<CapabilityDimension> = category_stats
        .iter()
        .map(|(name, (total, successes))| {
            let confidence = if *total < 5 {
                "low"
            } else if *total < 15 {
                "medium"
            } else {
                "high"
            };
            CapabilityDimension {
                name: display_names.get(name).unwrap_or(name).to_string(),
                success_rate: if *total > 0 { *successes as f64 / *total as f64 } else { 0.0 },
                sample_count: *total,
                confidence: confidence.to_string(),
            }
        })
        .collect();

    profile.sort_by(|a, b| b.sample_count.cmp(&a.sample_count));
    profile
}

// ---------------------------------------------------------------------------
// Growth System — Morning Reflection (Proactive Greeting)
// ---------------------------------------------------------------------------

/// Generate a proactive morning greeting with actionable suggestions.
/// Called on first user interaction of the day.
pub async fn generate_morning_reflection(
    config: &LLMConfig,
    db: &super::db::Database,
) -> Option<String> {
    // Check if we already did morning reflection today
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    if let Some(conn) = db.get_conn() {
        let already_done: bool = conn
            .prepare("SELECT 1 FROM reflections WHERE task_id = ?1 LIMIT 1")
            .and_then(|mut stmt| stmt.exists(rusqlite::params![format!("morning:{}", today)]))
            .unwrap_or(false);
        if already_done {
            return None;
        }
    }

    // Gather context
    let report = generate_growth_report(db);
    let corrections = db.get_active_corrections(3);
    let profile = build_capability_profile(db);

    // Build a context summary for LLM
    let report_summary = match &report {
        Some(r) => format!(
            "Recent performance: {} tasks, {:.0}% success rate. Top lessons: {}",
            r.total_tasks,
            r.success_rate * 100.0,
            if r.top_lessons.is_empty() { "none yet".into() } else { r.top_lessons.join("; ") }
        ),
        None => "Not enough task history yet.".into(),
    };

    let corrections_summary = if corrections.is_empty() {
        "No behavioral corrections recorded.".into()
    } else {
        corrections.iter()
            .map(|(t, b, _)| format!("{}: {}", t, b))
            .collect::<Vec<_>>()
            .join("; ")
    };

    let profile_summary = if profile.is_empty() {
        "No capability data yet.".into()
    } else {
        profile.iter()
            .take(4)
            .map(|d| format!("{}: {:.0}% ({} tasks)", d.name, d.success_rate * 100.0, d.sample_count))
            .collect::<Vec<_>>()
            .join(", ")
    };

    let prompt_text = format!(
        r#"You are YiYi, an AI companion starting a new day with your user. Generate a brief, warm morning greeting (2-4 sentences) with 1-2 proactive suggestions based on this context:

Growth data: {report_summary}
Learned corrections: {corrections_summary}
Capability profile: {profile_summary}

Guidelines:
- Be warm but concise, like a thoughtful friend
- If you have growth data, mention one insight naturally
- Suggest 1-2 actionable things (not generic)
- If no data yet, just be welcoming and offer help
- Respond in the user's likely language (Chinese if context suggests it)

Morning greeting:"#
    );

    let messages = vec![LLMMessage {
        role: "user".into(),
        content: Some(MessageContent::text(prompt_text)),
        tool_calls: None,
        tool_call_id: None,
    }];

    let greeting = match chat_completion(config, &messages, &[]).await {
        Ok(resp) => resp.message.content.map(|c| c.into_text()),
        Err(e) => {
            log::warn!("Morning reflection LLM call failed: {}", e);
            None
        }
    }?;

    // Mark as done for today
    db.add_reflection(
        Some(&format!("morning:{}", today)),
        None,
        "success",
        &format!("Morning reflection: {}", &greeting.chars().take(100).collect::<String>()),
        None,
        None,
        "silent_completion",
        0.50,
    ).ok();

    Some(greeting)
}

/// Growth milestone events for the timeline.
#[derive(Debug, Clone, serde::Serialize)]
pub struct GrowthMilestone {
    pub date: String,
    pub event_type: String, // "first_task", "skill_created", "lesson_learned", "correction", "capability_up"
    pub title: String,
    pub description: String,
}

/// Build a growth timeline from stored data.
pub fn build_growth_timeline(db: &super::db::Database, limit: usize) -> Vec<GrowthMilestone> {
    let conn = match db.get_conn() {
        Some(c) => c,
        None => return Vec::new(),
    };

    let mut milestones = Vec::new();

    // Reflections with lessons → "lesson_learned" milestones
    if let Ok(mut stmt) = conn.prepare(
        "SELECT created_at, summary, lesson FROM reflections
         WHERE lesson IS NOT NULL AND lesson != ''
         ORDER BY created_at DESC LIMIT ?1",
    ) {
        if let Ok(rows) = stmt.query_map(rusqlite::params![limit as i64], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        }) {
            for row in rows.flatten() {
                let date = chrono::DateTime::from_timestamp(row.0, 0)
                    .map(|dt| dt.format("%Y-%m-%d").to_string())
                    .unwrap_or_default();
                milestones.push(GrowthMilestone {
                    date,
                    event_type: "lesson_learned".into(),
                    title: "Learned from experience".into(),
                    description: row.2,
                });
            }
        }
    }

    // Corrections → "correction" milestones
    if let Ok(mut stmt) = conn.prepare(
        "SELECT created_at, trigger_pattern, correct_behavior FROM corrections
         ORDER BY created_at DESC LIMIT ?1",
    ) {
        if let Ok(rows) = stmt.query_map(rusqlite::params![limit as i64], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        }) {
            for row in rows.flatten() {
                let date = chrono::DateTime::from_timestamp(row.0, 0)
                    .map(|dt| dt.format("%Y-%m-%d").to_string())
                    .unwrap_or_default();
                milestones.push(GrowthMilestone {
                    date,
                    event_type: "correction".into(),
                    title: format!("Behavioral adjustment: {}", row.1),
                    description: row.2,
                });
            }
        }
    }

    // Sort by date descending
    milestones.sort_by(|a, b| b.date.cmp(&a.date));
    milestones.truncate(limit);
    milestones
}

// ---------------------------------------------------------------------------
// Growth System — Principles Consolidation
// ---------------------------------------------------------------------------

/// Consolidate active corrections into PRINCIPLES.md.
/// Called periodically (e.g. when correction count exceeds threshold).
/// Uses LLM to merge, deduplicate, and resolve conflicts between raw corrections.
pub async fn consolidate_corrections_to_principles(
    config: &LLMConfig,
    db: &super::db::Database,
    working_dir: &std::path::Path,
) -> Result<String, String> {
    let _permit = match GROWTH_LLM_SEMAPHORE.try_acquire() {
        Ok(p) => p,
        Err(_) => return Err("Too many concurrent growth LLM calls".into()),
    };

    let all_corrections_raw = db.get_all_active_corrections();
    if all_corrections_raw.is_empty() {
        return Ok("No active corrections to consolidate.".into());
    }

    // Filter out low-confidence corrections before sending to LLM
    let all_corrections: Vec<_> = all_corrections_raw
        .iter()
        .filter(|(_, _, _, confidence)| *confidence >= 0.50)
        .collect();
    if all_corrections.is_empty() {
        return Ok("No high-confidence corrections to consolidate.".into());
    }

    // Load existing principles for context
    let existing_principles = super::memory::read_principles_md(working_dir);

    // Build correction list for LLM (include confidence info)
    let mut corrections_text = String::new();
    for (i, (trigger, behavior, _, confidence)) in all_corrections.iter().enumerate() {
        corrections_text.push_str(&format!(
            "{}. [confidence: {:.2}] When {}: {}\n",
            i + 1, confidence, trigger, behavior
        ));
    }

    let prompt_text = format!(
        r#"You are consolidating behavioral correction rules into a concise set of principles.

Raw correction rules ({count} total):
{corrections}
{existing_context}
Each correction has a confidence score. Higher confidence corrections should take priority.

Task: Merge these into a concise list of behavioral principles (max 10 items).
- Combine similar/overlapping rules
- Resolve contradictions: later rules (higher number) override earlier ones — the user's most recent feedback is the truth
- Higher confidence corrections take priority over lower confidence ones
- Write each principle as a short, actionable statement
- Remove redundant or trivial rules
- Drop rules that are clearly outdated or superseded by newer ones
- Keep the language matching the original rules (Chinese or English)

Respond with ONLY the consolidated principles, one per line, prefixed with "- ".
Example:
- Always confirm before git push
- Prefer edit_file over write_file for existing files
- Keep responses concise unless user asks for detail

Consolidated principles:"#,
        count = all_corrections.len(),
        corrections = corrections_text,
        existing_context = if existing_principles.is_empty() {
            String::new()
        } else {
            format!("\nExisting principles (update/extend these):\n{}\n", existing_principles)
        },
    );

    let messages = vec![LLMMessage {
        role: "user".into(),
        content: Some(MessageContent::text(prompt_text)),
        tool_calls: None,
        tool_call_id: None,
    }];

    let result = match chat_completion(config, &messages, &[]).await {
        Ok(resp) => resp.message.content.map(|c| c.into_text()).unwrap_or_default(),
        Err(e) => return Err(format!("LLM consolidation failed: {}", e)),
    };

    // Extract only lines starting with "- " or "* ", strip the prefix
    let principles: Vec<String> = result
        .lines()
        .map(|l| l.trim())
        .filter(|l| l.starts_with("- ") || l.starts_with("* "))
        .map(|l| l.trim_start_matches("- ").trim_start_matches("* ").trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    if principles.is_empty() {
        return Err("LLM returned no valid principles".into());
    }

    // Before adding new consolidated principles, demote old HOT-tier principles to WARM.
    // Consolidation replaces (not appends), so old principles should give way to new ones.
    let old_hot_principles = db.get_memories_by_tier("hot", 100);
    for old in &old_hot_principles {
        if old.category == "principle" || old.category == "learned_rule" {
            db.update_memory_tier(&old.id, "warm", old.confidence * 0.5);
        }
    }

    // Save each principle as a separate HOT-tier memory entry
    let mut saved = 0;
    for principle in &principles {
        if let Ok(mem_id) = db.memory_add(principle, "principle", None) {
            db.update_memory_tier(&mem_id, "hot", 0.9);
            saved += 1;
        }
    }

    // Sync HOT-tier to files (updates PRINCIPLES.md and MEMORY.md cache)
    super::tiered_memory::sync_hot_to_files(db, working_dir);

    // Deactivate consumed corrections
    if let Some(conn) = db.get_conn() {
        conn.execute(
            "UPDATE corrections SET active = 0 WHERE active = 1",
            [],
        ).ok();
    }

    log::info!(
        "Consolidated {} corrections into {} principle memories (HOT tier)",
        all_corrections.len(),
        saved
    );

    Ok(format!(
        "Consolidated {} corrections into {} principles.",
        all_corrections.len(),
        saved
    ))
}
