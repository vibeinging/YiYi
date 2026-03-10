use super::llm_client::{chat_completion, chat_completion_stream, LLMConfig, LLMMessage, MessageContent, StreamEvent};
use super::token_counter::estimate_tokens;
use super::tools::{builtin_tools, execute_tool, ToolDefinition};

const DEFAULT_MAX_ITERATIONS: usize = 30;
/// Token threshold to trigger context compaction.
const COMPACT_THRESHOLD: usize = 80_000;

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
    let max_iter = max_iterations.unwrap_or(DEFAULT_MAX_ITERATIONS);
    let mut tools = builtin_tools();
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

    for iteration in 0..max_iter {
        log::info!("ReAct iteration {}/{}", iteration + 1, max_iter);

        let response = chat_completion(config, &messages, &tools).await?;

        // Add assistant message to history
        messages.push(response.message.clone());

        // Check if there are tool calls
        if let Some(tool_calls) = &response.message.tool_calls {
            if tool_calls.is_empty() {
                return Ok(response
                    .message
                    .content
                    .map(|c| c.into_text())
                .unwrap_or_else(|| "(no response)".into()));
            }

            // Execute each tool call
            for call in tool_calls {
                log::info!(
                    "Tool call: {}({})",
                    call.function.name,
                    call.function.arguments.chars().take(100).collect::<String>()
                );

                let result = execute_tool(call).await;

                log::info!(
                    "Tool result ({}): {}...",
                    call.function.name,
                    result.content.chars().take(200).collect::<String>()
                );

                messages.push(LLMMessage {
                    role: "tool".into(),
                    content: Some(MessageContent::text(result.content)),
                    tool_calls: None,
                    tool_call_id: Some(result.tool_call_id),
                });
            }
        } else {
            return Ok(response
                .message
                .content
                .map(|c| c.into_text())
                .unwrap_or_else(|| "(no response)".into()));
        }

        if response.finish_reason == "stop" {
            return Ok(response
                .message
                .content
                .map(|c| c.into_text())
                .unwrap_or_else(|| "(no response)".into()));
        }

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
    ToolStart { name: String, args_preview: String },
    ToolEnd { name: String, result_preview: String },
    Complete(String),
    Error(String),
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
) -> Result<String, String>
where
    F: Fn(AgentStreamEvent) + Send + Clone + 'static,
{
    let max_iter = max_iterations.unwrap_or(DEFAULT_MAX_ITERATIONS);
    let mut tools = builtin_tools();
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

    for iteration in 0..max_iter {
        log::info!("ReAct stream iteration {}/{}", iteration + 1, max_iter);

        let cb = on_event.clone();
        // Check cancellation before each LLM call
        if cancelled.map_or(false, |c| c.load(std::sync::atomic::Ordering::Relaxed)) {
            return Err("cancelled".to_string());
        }

        let response = chat_completion_stream(config, &messages, &tools, move |evt| {
            if let StreamEvent::ContentDelta(text) = evt {
                cb(AgentStreamEvent::Token(text));
            }
        }, cancelled)
        .await?;

        messages.push(response.message.clone());

        if let Some(tool_calls) = &response.message.tool_calls {
            if tool_calls.is_empty() {
                let reply = response.message.content.map(|c| c.into_text()).unwrap_or_else(|| "(no response)".into());
                on_event(AgentStreamEvent::Complete(reply.clone()));
                return Ok(reply);
            }

            for call in tool_calls {
                let args_preview: String = call.function.arguments.chars().take(100).collect();
                on_event(AgentStreamEvent::ToolStart {
                    name: call.function.name.clone(),
                    args_preview,
                });

                let result = execute_tool(call).await;

                let result_preview: String = result.content.chars().take(200).collect();
                on_event(AgentStreamEvent::ToolEnd {
                    name: call.function.name.clone(),
                    result_preview,
                });

                messages.push(LLMMessage {
                    role: "tool".into(),
                    content: Some(MessageContent::text(result.content)),
                    tool_calls: None,
                    tool_call_id: Some(result.tool_call_id),
                });
            }
        } else {
            let reply = response.message.content.map(|c| c.into_text()).unwrap_or_else(|| "(no response)".into());
            on_event(AgentStreamEvent::Complete(reply.clone()));
            return Ok(reply);
        }

        if response.finish_reason == "stop" {
            let reply = response.message.content.map(|c| c.into_text()).unwrap_or_else(|| "(no response)".into());
            on_event(AgentStreamEvent::Complete(reply.clone()));
            return Ok(reply);
        }

        compact_messages_if_needed(&mut messages, config, working_dir).await;
    }

    let err = format!("Agent reached maximum iterations ({})", max_iter);
    on_event(AgentStreamEvent::Error(err.clone()));
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

/// Append a conversation round to the session log in memory/sessions/.
pub async fn append_session_log(
    working_dir: &std::path::Path,
    session_id: &str,
    session_name: &str,
    user_message: &str,
    assistant_reply: &str,
    tools_used: &[String],
) {
    let sessions_dir = working_dir.join("memory").join("sessions");
    tokio::fs::create_dir_all(&sessions_dir).await.ok();

    // File name: {date}_{sanitized_session_name}.md
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let safe_name: String = session_name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c > '\x7f' { c } else { '_' })
        .take(50)
        .collect();
    let filename = format!("{}_{}.md", date, if safe_name.is_empty() { session_id } else { &safe_name });
    let filepath = sessions_dir.join(&filename);

    let now = chrono::Local::now().format("%Y-%m-%d %H:%M").to_string();
    let tools_str = if tools_used.is_empty() {
        "none".to_string()
    } else {
        tools_used.join(", ")
    };

    // Truncate long messages for the log
    let user_preview: String = user_message.chars().take(500).collect();
    let assistant_preview: String = assistant_reply.chars().take(1000).collect();

    let entry = format!(
        "\n## {} | session: {}\n\n**User**: {}\n\n**Assistant**: {}\n\n**Tools Used**: {}\n\n---\n",
        now, session_id, user_preview, assistant_preview, tools_str
    );

    use tokio::io::AsyncWriteExt;
    match tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&filepath)
        .await
    {
        Ok(mut file) => {
            if let Err(e) = file.write_all(entry.as_bytes()).await {
                log::error!("Failed to write session log: {}", e);
            }
        }
        Err(e) => log::error!("Failed to open session log: {}", e),
    }
}

// ---------------------------------------------------------------------------
// Persona loading & system prompt building
// ---------------------------------------------------------------------------

/// Load persona files asynchronously.
async fn load_persona(working_dir: &std::path::Path) -> String {
    let files = ["AGENTS.md", "SOUL.md", "PROFILE.md"];
    let mut parts = Vec::new();

    for name in &files {
        let path = working_dir.join(name);
        if let Ok(content) = tokio::fs::read_to_string(&path).await {
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
pub async fn build_system_prompt(
    working_dir: &std::path::Path,
    skills_content: &[String],
    language: Option<&str>,
) -> String {
    let persona = load_persona(working_dir).await;
    let lang = language.unwrap_or("zh-CN");
    let lang_instruction = if lang.starts_with("zh") {
        "Please respond in Chinese."
    } else {
        "Please respond in English."
    };

    let mut prompt = if persona.is_empty() {
        format!("You are YiClaw, a helpful AI assistant. {}\n\n", lang_instruction)
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

    // Auto-generate tool list from builtin_tools()
    let tools = builtin_tools();
    let tool_list: String = tools
        .iter()
        .map(|t| format!("- {}: {}", t.function.name, t.function.description))
        .collect::<Vec<_>>()
        .join("\n");

    // Workspace sandbox information
    let workspace_display = working_dir.to_string_lossy();
    let allowed_paths = super::tools::get_all_sandbox_paths().await;
    let allowed_paths_info = if allowed_paths.is_empty() {
        String::new()
    } else {
        format!(
            "\nAdditionally, the user has granted access to these paths:\n{}\n\
            You may freely read, write, and execute commands in these directories.\n",
            allowed_paths
                .iter()
                .map(|p| format!("- {}", p))
                .collect::<Vec<_>>()
                .join("\n")
        )
    };

    prompt.push_str(&format!(
        "\
## Workspace & Sandbox
Your workspace directory is: {workspace}
By default, all file operations and shell commands run within this directory.
If you need to access files outside the workspace, the user will be prompted to approve.
Do NOT attempt to access paths outside the workspace unless the user explicitly asks.
{allowed_paths}
## Tools
You have access to these tools:
{tool_list}

IMPORTANT: For simple document reading, prefer built-in tools (read_pdf, read_docx, \
read_spreadsheet). For advanced operations (PDF forms, PPTX creation, complex Excel), \
use run_python or run_python_script with the appropriate libraries.

When using tools:
- Think step by step about what you need to do
- Use the appropriate tool for each step
- Summarize the results for the user
- If a tool fails, try an alternative approach
- ALWAYS use delete_file instead of shell 'rm' commands to delete files or directories. \
This ensures proper permission checks and prevents accidental deletion of important files.

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
- Bot information is stored in the database, NEVER in config files — do NOT read config files to find bot info
- If the user mentions a bot name or asks to send a message to an external platform, use these tools
",
        workspace = workspace_display,
        allowed_paths = allowed_paths_info,
        tool_list = tool_list,
    ));

    // Append skill instructions
    for skill in skills_content {
        if !skill.is_empty() {
            prompt.push_str("\n---\n");
            prompt.push_str(skill);
            prompt.push('\n');
        }
    }

    prompt
}

// ---------------------------------------------------------------------------
// /compact command support
// ---------------------------------------------------------------------------

/// Manually compact chat history. Called by /compact command.
/// Keeps the most recent `keep_recent` messages, summarizes the rest,
/// and persists the summary to disk.
pub async fn manual_compact(
    config: &LLMConfig,
    history: &[LLMMessage],
    working_dir: &std::path::Path,
    keep_recent: usize,
) -> Result<String, String> {
    if history.len() <= keep_recent {
        return Ok("History is too short to compact.".into());
    }

    let split = history.len() - keep_recent;
    let to_summarize = &history[..split];

    // Build summary of old messages
    let mut summary_parts: Vec<String> = Vec::new();
    for msg in to_summarize {
        match msg.role.as_str() {
            "user" => {
                if let Some(text) = msg.content.as_ref().and_then(|c| c.as_text()) {
                    let preview: String = text.chars().take(150).collect();
                    summary_parts.push(format!("- User: {}", preview));
                }
            }
            "assistant" => {
                if let Some(text) = msg.content.as_ref().and_then(|c| c.as_text()) {
                    let preview: String = text.chars().take(150).collect();
                    summary_parts.push(format!("- Assistant: {}", preview));
                }
            }
            _ => {}
        }
    }

    // Try LLM summarization
    let summary = if summary_parts.len() > 5 {
        let request = format!(
            "Summarize this conversation concisely (max 800 chars). \
            Focus on key decisions, facts, and context:\n{}",
            summary_parts.join("\n")
        );
        let msgs = vec![LLMMessage {
            role: "user".into(),
            content: Some(MessageContent::text(request)),
            tool_calls: None,
            tool_call_id: None,
        }];
        match chat_completion(config, &msgs, &[]).await {
            Ok(resp) => resp.message.content.map(|c| c.into_text()).unwrap_or_else(|| summary_parts.join("\n")),
            Err(_) => summary_parts.join("\n"),
        }
    } else {
        summary_parts.join("\n")
    };

    // Persist summary
    let summary_path = working_dir.join(COMPACT_SUMMARY_FILE);
    tokio::fs::write(&summary_path, &summary).await.ok();

    Ok(format!(
        "Compacted {} messages into summary. Keeping {} recent messages.",
        split, keep_recent
    ))
}

// ---------------------------------------------------------------------------
// Message sanitization — fix broken tool message sequences
// ---------------------------------------------------------------------------

/// Sanitize messages to prevent API errors from malformed tool sequences.
///
/// Fixes:
/// 1. Orphan tool results (tool messages without a preceding assistant tool_call)
/// 2. Missing tool results (assistant has tool_calls but no matching tool response)
fn sanitize_messages(messages: &mut Vec<LLMMessage>) {
    // Collect all tool_call IDs from assistant messages
    let mut expected_tool_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut seen_tool_ids: std::collections::HashSet<String> = std::collections::HashSet::new();

    for msg in messages.iter() {
        if msg.role == "assistant" {
            if let Some(calls) = &msg.tool_calls {
                for call in calls {
                    expected_tool_ids.insert(call.id.clone());
                }
            }
        }
        if msg.role == "tool" {
            if let Some(id) = &msg.tool_call_id {
                seen_tool_ids.insert(id.clone());
            }
        }
    }

    // Remove orphan tool messages (tool_call_id not in any assistant's tool_calls)
    let before = messages.len();
    messages.retain(|msg| {
        if msg.role == "tool" {
            if let Some(id) = &msg.tool_call_id {
                return expected_tool_ids.contains(id);
            }
            return false; // tool message without id
        }
        true
    });

    if messages.len() != before {
        log::info!(
            "Sanitized: removed {} orphan tool messages",
            before - messages.len()
        );
    }

    // For assistant messages with tool_calls that have no matching tool result,
    // inject a placeholder tool result to keep the sequence valid
    let missing_ids: Vec<String> = expected_tool_ids
        .difference(&seen_tool_ids)
        .cloned()
        .collect();

    if !missing_ids.is_empty() {
        // Find where to insert — after the last message
        for id in &missing_ids {
            // Find the assistant message that owns this tool_call
            let assistant_idx = messages.iter().position(|m| {
                m.role == "assistant"
                    && m.tool_calls
                        .as_ref()
                        .map_or(false, |calls| calls.iter().any(|c| &c.id == id))
            });

            if let Some(idx) = assistant_idx {
                // Find the right insertion point (after the assistant message and its existing tool results)
                let mut insert_at = idx + 1;
                while insert_at < messages.len() && messages[insert_at].role == "tool" {
                    insert_at += 1;
                }

                messages.insert(
                    insert_at,
                    LLMMessage {
                        role: "tool".into(),
                        content: Some(MessageContent::text("(result unavailable — from previous session)")),
                        tool_calls: None,
                        tool_call_id: Some(id.clone()),
                    },
                );
            }
        }

        log::info!(
            "Sanitized: injected {} placeholder tool results",
            missing_ids.len()
        );
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
