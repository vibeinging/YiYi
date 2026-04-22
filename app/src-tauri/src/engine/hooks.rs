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
    #[allow(dead_code)]
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

    #[allow(dead_code)]
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
    #[allow(dead_code)]
    permission_override: Option<PermissionOverride>,
    #[allow(dead_code)]
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

    #[allow(dead_code)]
    fn deny(messages: Vec<String>) -> Self {
        Self { denied: true, ..Self::allow(messages) }
    }

    #[allow(dead_code)]
    fn fail(messages: Vec<String>) -> Self {
        Self { failed: true, ..Self::allow(messages) }
    }

    #[allow(dead_code)]
    fn cancel(message: String) -> Self {
        Self {
            cancelled: true,
            messages: vec![message],
            ..Self::allow(vec![])
        }
    }

    #[allow(dead_code)]
    pub fn is_denied(&self) -> bool { self.denied }
    #[allow(dead_code)]
    pub fn is_failed(&self) -> bool { self.failed }
    #[allow(dead_code)]
    pub fn is_cancelled(&self) -> bool { self.cancelled }
    pub fn is_blocked(&self) -> bool { self.denied || self.failed || self.cancelled }
    pub fn messages(&self) -> &[String] { &self.messages }
    #[allow(dead_code)]
    pub fn permission_override(&self) -> Option<PermissionOverride> { self.permission_override }
    #[allow(dead_code)]
    pub fn permission_reason(&self) -> Option<&str> { self.permission_reason.as_deref() }
    pub fn updated_input(&self) -> Option<&str> { self.updated_input.as_deref() }
}

// ── Hook Runner ─────────────────────────────────────────────────────────

/// Executes configured hook commands for tool lifecycle events.
#[derive(Clone)]
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

    #[allow(dead_code)]
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
pub fn merge_hook_feedback(hook_messages: &[String], output: String, _is_error: bool) -> String {
    if hook_messages.is_empty() {
        return output;
    }
    let feedback = hook_messages.join("\n");
    format!("{output}\n\n[Hook feedback]\n{feedback}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_as_str_matches_snake_case() {
        assert_eq!(HookEvent::PreToolUse.as_str(), "pre_tool_use");
        assert_eq!(HookEvent::PostToolUse.as_str(), "post_tool_use");
        assert_eq!(HookEvent::PostToolUseFailure.as_str(), "post_tool_use_failure");
    }

    #[test]
    fn hook_config_empty_is_empty() {
        let cfg = HookConfig::default();
        assert!(cfg.is_empty());
    }

    #[test]
    fn hook_config_with_commands_is_not_empty() {
        let cfg = HookConfig {
            pre_tool_use: vec!["echo x".into()],
            ..Default::default()
        };
        assert!(!cfg.is_empty());
    }

    #[test]
    fn abort_signal_starts_inactive() {
        let sig = HookAbortSignal::new();
        assert!(!sig.is_aborted());
    }

    #[test]
    fn abort_signal_flips_to_aborted() {
        let sig = HookAbortSignal::new();
        sig.abort();
        assert!(sig.is_aborted());
    }

    #[test]
    fn hook_run_result_allow_is_not_blocked() {
        let r = HookRunResult::allow(vec!["ok".into()]);
        assert!(!r.is_denied());
        assert!(!r.is_blocked());
        assert_eq!(r.messages(), &["ok".to_string()]);
    }

    #[test]
    fn hook_run_result_deny_is_blocked() {
        let r = HookRunResult::deny(vec!["nope".into()]);
        assert!(r.is_denied());
        assert!(r.is_blocked());
    }

    #[test]
    fn hook_run_result_fail_is_blocked() {
        let r = HookRunResult::fail(vec!["bad".into()]);
        assert!(r.is_failed());
        assert!(r.is_blocked());
    }

    #[test]
    fn hook_run_result_cancel_is_blocked() {
        let r = HookRunResult::cancel("aborted".into());
        assert!(r.is_cancelled());
        assert!(r.is_blocked());
    }

    #[test]
    fn runner_with_empty_config_allows_everything() {
        let runner = HookRunner::new(HookConfig::default());
        let r = runner.run_pre_tool_use("x", "{}", None);
        assert!(!r.is_blocked());
        assert!(!runner.has_hooks());
    }

    #[test]
    fn runner_with_config_has_hooks() {
        let runner = HookRunner::new(HookConfig {
            post_tool_use: vec!["echo x".into()],
            ..Default::default()
        });
        assert!(runner.has_hooks());
    }

    #[test]
    fn build_payload_shape_is_correct() {
        let payload = build_payload(
            HookEvent::PreToolUse,
            "read_file",
            "{\"path\":\"x\"}",
            None,
            false,
        );
        let v: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(v["hook_event_name"], "pre_tool_use");
        assert_eq!(v["tool_name"], "read_file");
        assert!(v.get("tool_output").is_none());
        assert!(v.get("tool_result_is_error").is_none());
    }

    #[test]
    fn build_payload_includes_output_and_error_flag() {
        let payload = build_payload(
            HookEvent::PostToolUse,
            "x",
            "in",
            Some("out"),
            true,
        );
        let v: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(v["tool_output"], "out");
        assert_eq!(v["tool_result_is_error"], true);
    }

    #[test]
    fn parse_hook_output_reads_reason_message() {
        let parsed = parse_hook_output(r#"{"reason":"blocked by policy"}"#);
        assert_eq!(parsed.messages, vec!["blocked by policy"]);
    }

    #[test]
    fn parse_hook_output_reads_permission_decision() {
        let parsed = parse_hook_output(r#"{
            "hookSpecificOutput": {
                "permissionDecision": "allow",
                "permissionDecisionReason": "trusted",
                "updatedInput": "new-in",
                "additionalContext": "extra info"
            }
        }"#);
        assert_eq!(parsed.permission_override, Some(PermissionOverride::Allow));
        assert_eq!(parsed.permission_reason.as_deref(), Some("trusted"));
        assert_eq!(parsed.updated_input.as_deref(), Some("new-in"));
        assert!(parsed.messages.iter().any(|m| m == "extra info"));
    }

    #[test]
    fn parse_hook_output_non_json_becomes_plain_message() {
        let parsed = parse_hook_output("plain text output");
        assert_eq!(parsed.messages, vec!["plain text output"]);
    }

    #[test]
    fn parse_hook_output_handles_deny_decision() {
        let parsed = parse_hook_output(r#"{"hookSpecificOutput":{"permissionDecision":"deny"}}"#);
        assert_eq!(parsed.permission_override, Some(PermissionOverride::Deny));
    }

    #[test]
    fn merge_hook_feedback_appends_section() {
        let merged = merge_hook_feedback(
            &["msg A".into(), "msg B".into()],
            "original output".into(),
            false,
        );
        assert!(merged.contains("original output"));
        assert!(merged.contains("[Hook feedback]"));
        assert!(merged.contains("msg A"));
        assert!(merged.contains("msg B"));
    }

    #[test]
    fn merge_hook_feedback_returns_output_unchanged_when_no_messages() {
        let merged = merge_hook_feedback(&[], "original".into(), false);
        assert_eq!(merged, "original");
    }
}
