//! Tool catalog: which tools are advertised to the LLM, in which buckets.
//!
//! YiYi splits its tool surface into two tiers:
//!   * **Core** — always present in the LLM's `tools` parameter. Roughly a
//!     dozen Claw-Code-style essentials (file I/O, shell, web fetch, memory,
//!     skills, spawn_agents).
//!   * **Deferred** — discoverable on demand via the `tool_search` tool. The
//!     agent finds them by query, the result emits a `[TOOLS_DISCOVERED:…]`
//!     tag, and the agent loop injects them into the next API call. Keeps
//!     the upfront tools-array small while still exposing the full library.
//!
//! Plus stubs for deferred MCP servers — tools the user hasn't installed yet
//! that we still expose so the agent can plan around them and trigger the
//! install dialog on first invocation.

use super::types::{tool_def, ToolDefinition};
use super::{
    ask_user, bot_tools, canvas_tools, cheap_browser, companion_tools, cron_tools, delegate_tools,
    file_tools, flash_tools, git_tools, lsp_tools, memory_tools, skill_tools, snapshot_tools,
    spawn_tools, system_tools, task_tools, web_tools,
};

/// Tools whose only purpose is to feed image data BACK INTO the model.
/// V4 build: DeepSeek V4 Pro/Flash are text-only — surfacing these tools
/// would have the model "look" at things it can't actually see.
///
/// `desktop_screenshot` is intentionally NOT in this list. Even with a
/// text-only model the tool is useful: the artifact pipeline saves the PNG
/// and shows it to the *user* as an inline card. The model itself just gets
/// a text confirmation. (See `desktop_screenshot_tool` — its result text
/// instructs the model to acknowledge, not describe.)
const VISION_DISABLED_TOOLS: &[&str] = &["browser_screenshot", "browser_use"];

/// Core tools — always loaded. Everything else discoverable via tool_search.
pub fn core_tools() -> Vec<ToolDefinition> {
    static CACHE: std::sync::OnceLock<Vec<ToolDefinition>> = std::sync::OnceLock::new();
    CACHE
        .get_or_init(|| {
            let core_names = [
                // File operations (Claw Code MVP)
                "read_file",
                "write_file",
                "edit_file",
                "list_directory",
                "grep_search",
                "glob_search",
                // Shell (Claw Code MVP)
                "execute_shell",
                // Web (text-only path — DeepSeek V4 has no vision, so
                // browser_screenshot is suppressed via VISION_DISABLED_TOOLS)
                "web_search",
                "browser_fetch",
                // YiYi identity — memory and skills make YiYi who she is
                "memory_search",
                "memory_add",
                "activate_skills",
                // Multi-step execution
                "spawn_agents",
                // Human-in-the-loop — ask the user an open question and wait
                "ask_user",
            ];

            let mut all = Vec::new();
            all.extend(file_tools::definitions());
            all.extend(system_tools::definitions());
            all.extend(web_tools::definitions());
            // Screenshot kept registered behind VISION_DISABLED_TOOLS — see
            // const above. Reinstate the line below once V4 has vision.
            // all.push(cheap_browser::screenshot_def());
            all.push(cheap_browser::fetch_def());
            all.extend(memory_tools::definitions());
            all.extend(skill_tools::definitions());
            all.extend(spawn_tools::definitions());
            all.extend(ask_user::definitions());

            all.into_iter()
                .filter(|t| core_names.contains(&t.function.name.as_str()))
                .filter(|t| !VISION_DISABLED_TOOLS.contains(&t.function.name.as_str()))
                .collect()
        })
        .clone()
}

/// Static portion of the deferred-tool pool — same content every call,
/// safe to cache. Dynamic stubs (deferred MCP servers) are appended by
/// `deferred_tools()` below since their set changes at runtime as users
/// install / remove MCP prerequisites.
fn deferred_tools_static() -> &'static Vec<ToolDefinition> {
    static CACHE: std::sync::OnceLock<Vec<ToolDefinition>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| {
        let core_names = [
            "read_file",
            "write_file",
            "edit_file",
            "list_directory",
            "grep_search",
            "glob_search",
            "execute_shell",
            "web_search",
            "memory_search",
            "memory_add",
            "activate_skills",
            "spawn_agents",
        ];

        let mut tools = Vec::new();
        // Collect ALL definitions from ALL modules
        tools.extend(system_tools::definitions());
        tools.extend(file_tools::definitions());
        tools.extend(web_tools::definitions());
        // browser_tools is vision-dependent — suppressed via VISION_DISABLED_TOOLS
        // until DeepSeek V4 has multimodal. Browser automation goes through the
        // Playwright MCP server (ARIA snapshots) in the meantime.
        // tools.extend(browser_tools::definitions());
        tools.extend(memory_tools::definitions());
        tools.extend(cron_tools::definitions());
        tools.extend(bot_tools::definitions());
        tools.extend(skill_tools::definitions());
        tools.extend(task_tools::definitions());
        tools.extend(canvas_tools::definitions());
        tools.extend(spawn_tools::definitions());
        // Desktop control: the prior in-process `computer_control` (CGEvent-based)
        // was removed because it stole the user's cursor/focus and was unusable
        // without a vision model. The replacement is the `cua-driver` MCP server
        // (background SkyLight-based, macOS only) — seeded in
        // `seed_default_mcp_servers` and enabled by the user from Settings → MCP.
        tools.extend(lsp_tools::definitions());
        tools.extend(git_tools::definitions());
        tools.extend(flash_tools::definitions());
        tools.extend(snapshot_tools::definitions());
        tools.extend(companion_tools::definitions());
        tools.extend(delegate_tools::definitions());

        // Buddy delegate tool — consult the user's digital twin
        tools.push(tool_def(
            "ask_buddy",
            "Ask the user's digital twin (buddy) a question. The buddy knows the user's preferences, \
             work style, and decision patterns. Use this instead of asking the user directly for \
             routine decisions like: tech stack choices, coding style preferences, quality judgments. \
             Returns the buddy's answer and confidence level.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description": "The question or decision to delegate to the buddy"
                    },
                    "context": {
                        "type": "string",
                        "description": "Additional context (task description, options being considered, etc.)"
                    }
                },
                "required": ["question"]
            }),
        ));

        // Remove core tools (they're already loaded)
        tools.retain(|t| !core_names.contains(&t.function.name.as_str()));
        tools.retain(|t| !VISION_DISABLED_TOOLS.contains(&t.function.name.as_str()));
        tools
    })
}

/// Extended tools loaded on demand via tool_search.
/// Includes ALL tools not in core set, plus runtime-resolved stubs for
/// any deferred MCP servers (so the agent can plan around capabilities
/// it doesn't have yet and trigger lazy install on first invocation).
pub fn deferred_tools() -> Vec<ToolDefinition> {
    let mut tools = deferred_tools_static().clone();
    tools.extend(crate::engine::infra::deferred_mcp::stubs_for_active_deferrals());
    tools
}

/// All tools (core + deferred). Used by execute_tool dispatch.
#[allow(dead_code)]
pub(crate) fn all_tools() -> Vec<ToolDefinition> {
    let mut all = core_tools();
    all.extend(deferred_tools());
    all
}

/// Tag embedded in tool_search output for the agent loop to parse discovered tool names.
pub(crate) const TOOLS_DISCOVERED_TAG: &str = "[TOOLS_DISCOVERED:";

/// Search deferred tools by name or keyword. Returns matching tool names + schemas.
/// Appends a `[TOOLS_DISCOVERED:]` tag that the agent loop parses for dynamic injection.
pub(crate) fn execute_tool_search(args: &serde_json::Value) -> String {
    let query = args["query"].as_str().unwrap_or("").trim().to_lowercase();
    let max_results = args["max_results"].as_u64().unwrap_or(5) as usize;

    if query.is_empty() {
        return "Error: query is required".into();
    }

    let deferred = deferred_tools();

    // Support "select:tool1,tool2" for exact name loading
    let matches: Vec<&ToolDefinition> = if let Some(selection) = query.strip_prefix("select:") {
        let wanted: Vec<&str> = selection.split(',').map(|s| s.trim()).collect();
        deferred
            .iter()
            .filter(|t| wanted.contains(&t.function.name.as_str()))
            .collect()
    } else {
        // Score-based search
        let mut scored: Vec<(&ToolDefinition, i32)> = deferred
            .iter()
            .map(|t| {
                let name = t.function.name.to_lowercase();
                let desc = t.function.description.to_lowercase();
                let mut score = 0i32;
                if name == query {
                    score += 8;
                } else if name.contains(&query) {
                    score += 4;
                }
                if desc.contains(&query) {
                    score += 2;
                }
                // Check individual query words
                for word in query.split_whitespace() {
                    if name.contains(word) {
                        score += 3;
                    }
                    if desc.contains(word) {
                        score += 1;
                    }
                }
                (t, score)
            })
            .filter(|(_, s)| *s > 0)
            .collect();
        scored.sort_by(|a, b| b.1.cmp(&a.1));
        scored
            .into_iter()
            .take(max_results)
            .map(|(t, _)| t)
            .collect()
    };

    if matches.is_empty() {
        let available: Vec<&str> = deferred.iter().map(|t| t.function.name.as_str()).collect();
        return format!(
            "No tools found for '{}'. Available deferred tools: {}",
            query,
            available.join(", ")
        );
    }

    // Build structured response with tool names for dynamic injection
    let tool_names: Vec<&str> = matches.iter().map(|t| t.function.name.as_str()).collect();
    let results: Vec<serde_json::Value> = matches
        .iter()
        .map(|t| {
            serde_json::json!({
                "name": t.function.name,
                "description": t.function.description,
                "parameters": t.function.parameters,
            })
        })
        .collect();

    // The [TOOLS_DISCOVERED:...] tag is parsed by the agent loop to dynamically
    // inject these tools into the next API call's `tools` parameter (Claw Code pattern).
    format!(
        "Found {} tool(s). These tools are now available for use:\n\n{}\n\n[TOOLS_DISCOVERED:{}]",
        results.len(),
        serde_json::to_string_pretty(&results).unwrap_or_default(),
        tool_names.join(","),
    )
}

/// Resolve deferred tool definitions by exact names.
/// Used by the agent loop to dynamically inject tools discovered via tool_search.
pub fn resolve_deferred_tools(names: &[&str]) -> Vec<ToolDefinition> {
    let deferred = deferred_tools();
    deferred
        .into_iter()
        .filter(|t| names.contains(&t.function.name.as_str()))
        .collect()
}

/// Default tool set for conversations. Returns core tools + tool_search.
/// LLM uses tool_search to discover and load deferred tools on demand.
pub fn builtin_tools() -> Vec<ToolDefinition> {
    let mut tools = core_tools();
    // Add tool_search so LLM can discover deferred tools
    tools.push(tool_def(
        "tool_search",
        "Search for additional specialized tools by name or keyword. \
         Not all tools are loaded by default — use this to find tools for: \
         browser automation, bot messaging, scheduled tasks, computer control, \
         canvas rendering, code intelligence (LSP), git operations, and more.",
        serde_json::json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query: tool name, keyword, or 'select:tool1,tool2' for exact names"
                },
                "max_results": {
                    "type": "integer",
                    "description": "Maximum results to return. Default 5."
                }
            },
            "required": ["query"]
        }),
    ));
    tools
}

#[cfg(test)]
#[test]
#[ignore = "audit-only: run with --ignored to print tool list"]
fn audit_visible_tools() {
    let core = core_tools();
    let deferred = deferred_tools();
    eprintln!("\nCORE ({}):", core.len());
    for t in &core {
        eprintln!(
            "  {} — {}",
            t.function.name,
            t.function
                .description
                .lines()
                .next()
                .unwrap_or("")
                .chars()
                .take(80)
                .collect::<String>()
        );
    }
    eprintln!("\nDEFERRED ({}):", deferred.len());
    for t in &deferred {
        eprintln!(
            "  {} — {}",
            t.function.name,
            t.function
                .description
                .lines()
                .next()
                .unwrap_or("")
                .chars()
                .take(80)
                .collect::<String>()
        );
    }
    eprintln!("\nTOTAL agent-visible: {}", core.len() + deferred.len());
}
