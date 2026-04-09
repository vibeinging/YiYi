//! Hook system — pre/post tool execution hooks.
//!
//! Inspired by Claw Code's hook architecture. Hooks can:
//! - Intercept tool calls before execution (PreToolUse)
//! - Post-process tool results (PostToolUse)
//! - Handle tool failures (PostToolUseFailure)
//! - Modify inputs, deny execution, or inject feedback
//!
//! Hooks are configured as shell commands that receive JSON payload via stdin
//! and return JSON response via stdout. Exit codes: 0=Allow, 2=Deny, other=Failed.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

// ── Hook Events ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookEvent {
    PreToolUse,
    PostToolUse,
    PostToolUseFailure,
}

impl HookEvent {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::PreToolUse => "pre_tool_use",
            Self::PostToolUse => "post_tool_use",
            Self::PostToolUseFailure => "post_tool_use_failure",
        }
    }
}

// ── Hook Configuration ──────────────────────────────────────────────────

/// Hook commands for each lifecycle event.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HookConfig {
    #[serde(default)]
    pub pre_tool_use: Vec<String>,
    #[serde(default)]
    pub post_tool_use: Vec<String>,
    #[serde(default)]
    pub post_tool_use_failure: Vec<String>,
}

impl HookConfig {
    pub fn is_empty(&self) -> bool {
        self.pre_tool_use.is_empty()
            && self.post_tool_use.is_empty()
            && self.post_tool_use_failure.is_empty()
    }
}

// ── Abort Signal ────────────────────────────────────────────────────────

/// Thread-safe abort signal for cancelling long-running hooks.
#[derive(Debug, Clone)]
pub struct HookAbortSignal {
    aborted: Arc<AtomicBool>,
}

impl Default for HookAbortSignal {
    fn default() -> Self {
        Self::new()
    }
}

impl HookAbortSignal {
    pub fn new() -> Self {
        Self {
            aborted: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn abort(&self) {
        self.aborted.store(true, Ordering::Relaxed);
    }

    pub fn is_aborted(&self) -> bool {
        self.aborted.load(Ordering::Relaxed)
    }
}

// ── Hook Run Result ─────────────────────────────────────────────────────

/// Result of running hooks for a single event.
#[derive(Debug, Clone)]
pub struct HookRunResult {
    denied: bool,
    failed: bool,
    cancelled: bool,
    messages: Vec<String>,
    /// Hook can override permission decision (allow/deny/ask).
    permission_override: Option<PermissionOverride>,
    permission_reason: Option<String>,
    /// Hook can modify the tool input before execution.
    updated_input: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionOverride {
    Allow,
    Deny,
    Ask,
}

impl HookRunResult {
    pub fn allow(messages: Vec<String>) -> Self {
        Self {
            denied: false,
            failed: false,
            cancelled: false,
            messages,
            permission_override: None,
            permission_reason: None,
            updated_input: None,
        }
    }

    fn deny(messages: Vec<String>) -> Self {
        Self { denied: true, ..Self::allow(messages) }
    }

    fn fail(messages: Vec<String>) -> Self {
        Self { failed: true, ..Self::allow(messages) }
    }

    fn cancel(message: String) -> Self {
        Self {
            cancelled: true,
            messages: vec![message],
            ..Self::allow(vec![])
        }
    }

    pub fn is_denied(&self) -> bool { self.denied }
    pub fn is_failed(&self) -> bool { self.failed }
    pub fn is_cancelled(&self) -> bool { self.cancelled }
    pub fn is_blocked(&self) -> bool { self.denied || self.failed || self.cancelled }
    pub fn messages(&self) -> &[String] { &self.messages }
    pub fn permission_override(&self) -> Option<PermissionOverride> { self.permission_override }
    pub fn permission_reason(&self) -> Option<&str> { self.permission_reason.as_deref() }
    pub fn updated_input(&self) -> Option<&str> { self.updated_input.as_deref() }
}

// ── Hook Runner ─────────────────────────────────────────────────────────

/// Executes configured hook commands for tool lifecycle events.
pub struct HookRunner {
    config: HookConfig,
}

impl HookRunner {
    pub fn new(config: HookConfig) -> Self {
        Self { config }
    }

    /// Run pre-tool-use hooks. Can modify input, deny, or inject feedback.
    pub fn run_pre_tool_use(
        &self,
        tool_name: &str,
        tool_input: &str,
        abort_signal: Option<&HookAbortSignal>,
    ) -> HookRunResult {
        if self.config.pre_tool_use.is_empty() {
            return HookRunResult::allow(vec![]);
        }
        let payload = build_payload(HookEvent::PreToolUse, tool_name, tool_input, None, false);
        run_commands(&self.config.pre_tool_use, &payload, abort_signal)
    }

    /// Run post-tool-use hooks. Can inject feedback or mark as denied.
    pub fn run_post_tool_use(
        &self,
        tool_name: &str,
        tool_input: &str,
        tool_output: &str,
        is_error: bool,
        abort_signal: Option<&HookAbortSignal>,
    ) -> HookRunResult {
        if self.config.post_tool_use.is_empty() {
            return HookRunResult::allow(vec![]);
        }
        let payload = build_payload(HookEvent::PostToolUse, tool_name, tool_input, Some(tool_output), is_error);
        run_commands(&self.config.post_tool_use, &payload, abort_signal)
    }

    /// Run post-tool-use-failure hooks.
    pub fn run_post_tool_use_failure(
        &self,
        tool_name: &str,
        tool_input: &str,
        tool_error: &str,
        abort_signal: Option<&HookAbortSignal>,
    ) -> HookRunResult {
        if self.config.post_tool_use_failure.is_empty() {
            return HookRunResult::allow(vec![]);
        }
        let payload = build_payload(HookEvent::PostToolUseFailure, tool_name, tool_input, Some(tool_error), true);
        run_commands(&self.config.post_tool_use_failure, &payload, abort_signal)
    }

    pub fn has_hooks(&self) -> bool {
        !self.config.is_empty()
    }
}

// ── Internal: Build payload & run commands ──────────────────────────────

fn build_payload(
    event: HookEvent,
    tool_name: &str,
    tool_input: &str,
    tool_output: Option<&str>,
    is_error: bool,
) -> String {
    let mut payload = serde_json::json!({
        "hook_event_name": event.as_str(),
        "tool_name": tool_name,
        "tool_input": tool_input,
    });
    if let Some(output) = tool_output {
        payload["tool_output"] = serde_json::Value::String(output.to_string());
    }
    if is_error {
        payload["tool_result_is_error"] = serde_json::Value::Bool(true);
    }
    payload.to_string()
}

fn run_commands(
    commands: &[String],
    payload: &str,
    abort_signal: Option<&HookAbortSignal>,
) -> HookRunResult {
    let mut messages = Vec::new();
    let mut permission_override = None;
    let mut permission_reason = None;
    let mut updated_input = None;

    for cmd in commands {
        if let Some(signal) = abort_signal {
            if signal.is_aborted() {
                return HookRunResult::cancel("Hook aborted".into());
            }
        }

        match run_single_command(cmd, payload, abort_signal) {
            CommandOutcome::Allow { parsed } => {
                messages.extend(parsed.messages);
                if parsed.permission_override.is_some() {
                    permission_override = parsed.permission_override;
                }
                if parsed.permission_reason.is_some() {
                    permission_reason = parsed.permission_reason;
                }
                if parsed.updated_input.is_some() {
                    updated_input = parsed.updated_input;
                }
            }
            CommandOutcome::Deny { parsed } => {
                messages.extend(parsed.messages);
                return HookRunResult {
                    denied: true,
                    messages,
                    permission_override,
                    permission_reason,
                    updated_input,
                    ..HookRunResult::allow(vec![])
                };
            }
            CommandOutcome::Failed { message } => {
                messages.push(message);
                return HookRunResult {
                    failed: true,
                    messages,
                    permission_override,
                    permission_reason,
                    updated_input,
                    ..HookRunResult::allow(vec![])
                };
            }
            CommandOutcome::Cancelled { message } => {
                return HookRunResult::cancel(message);
            }
        }
    }

    HookRunResult {
        denied: false,
        failed: false,
        cancelled: false,
        messages,
        permission_override,
        permission_reason,
        updated_input,
    }
}

enum CommandOutcome {
    Allow { parsed: ParsedOutput },
    Deny { parsed: ParsedOutput },
    Failed { message: String },
    Cancelled { message: String },
}

struct ParsedOutput {
    messages: Vec<String>,
    permission_override: Option<PermissionOverride>,
    permission_reason: Option<String>,
    updated_input: Option<String>,
}

fn run_single_command(
    cmd: &str,
    payload: &str,
    abort_signal: Option<&HookAbortSignal>,
) -> CommandOutcome {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let mut child = match Command::new("sh")
        .args(["-lc", cmd])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return CommandOutcome::Failed {
            message: format!("Failed to spawn hook command: {e}"),
        },
    };

    // Write payload to stdin
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(payload.as_bytes()).ok();
    }

    // Poll with abort signal
    let output = loop {
        if let Some(signal) = abort_signal {
            if signal.is_aborted() {
                child.kill().ok();
                return CommandOutcome::Cancelled {
                    message: "Hook cancelled by abort signal".into(),
                };
            }
        }
        match child.try_wait() {
            Ok(Some(_)) => break child.wait_with_output(),
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(20)),
            Err(e) => return CommandOutcome::Failed {
                message: format!("Hook wait error: {e}"),
            },
        }
    };

    let output = match output {
        Ok(o) => o,
        Err(e) => return CommandOutcome::Failed {
            message: format!("Hook output error: {e}"),
        },
    };

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let parsed = parse_hook_output(&stdout);

    match output.status.code() {
        Some(0) => CommandOutcome::Allow { parsed },
        Some(2) => CommandOutcome::Deny { parsed },
        code => CommandOutcome::Failed {
            message: format!(
                "Hook exited with code {}: {}",
                code.unwrap_or(-1),
                if stdout.is_empty() {
                    String::from_utf8_lossy(&output.stderr).trim().to_string()
                } else {
                    stdout
                }
            ),
        },
    }
}

fn parse_hook_output(stdout: &str) -> ParsedOutput {
    let mut messages = Vec::new();
    let mut permission_override = None;
    let mut permission_reason = None;
    let mut updated_input = None;

    if let Ok(json) = serde_json::from_str::<serde_json::Value>(stdout) {
        // Extract message
        if let Some(msg) = json.get("reason").or(json.get("systemMessage")).and_then(|v| v.as_str()) {
            if !msg.is_empty() {
                messages.push(msg.to_string());
            }
        }
        // Check for explicit deny
        if json.get("continue").and_then(|v| v.as_bool()) == Some(false) {
            // continue: false means deny
        }
        if json.get("decision").and_then(|v| v.as_str()) == Some("block") {
            // decision: "block" means deny
        }
        // Extract hook-specific output
        if let Some(specific) = json.get("hookSpecificOutput") {
            if let Some(ctx) = specific.get("additionalContext").and_then(|v| v.as_str()) {
                if !ctx.is_empty() {
                    messages.push(ctx.to_string());
                }
            }
            match specific.get("permissionDecision").and_then(|v| v.as_str()) {
                Some("allow") => permission_override = Some(PermissionOverride::Allow),
                Some("deny") => permission_override = Some(PermissionOverride::Deny),
                Some("ask") => permission_override = Some(PermissionOverride::Ask),
                _ => {}
            }
            if let Some(reason) = specific.get("permissionDecisionReason").and_then(|v| v.as_str()) {
                permission_reason = Some(reason.to_string());
            }
            if let Some(input) = specific.get("updatedInput").and_then(|v| v.as_str()) {
                updated_input = Some(input.to_string());
            }
        }
    } else if !stdout.is_empty() {
        messages.push(stdout.to_string());
    }

    ParsedOutput {
        messages,
        permission_override,
        permission_reason,
        updated_input,
    }
}

/// Merge hook feedback messages into tool output.
pub fn merge_hook_feedback(hook_messages: &[String], output: String, is_error: bool) -> String {
    if hook_messages.is_empty() {
        return output;
    }
    let feedback = hook_messages.join("\n");
    if is_error {
        format!("{output}\n\n[Hook feedback]\n{feedback}")
    } else {
        format!("{output}\n\n[Hook feedback]\n{feedback}")
    }
}
