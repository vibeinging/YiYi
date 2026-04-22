//! Permission mode system — three-level tool access control.
//!
//! Borrowed from Claw Code's PermissionPolicy design:
//! - ReadOnly: can read files, search, inspect; no writes or shell execution
//! - Standard: read + write files in authorized folders; shell with confirmation
//! - Full: all tools, all operations (dangerous — requires explicit opt-in)
//!
//! Each tool has a `required_mode` and the active mode determines whether
//! it can run, needs confirmation, or is blocked outright.

use serde::{Deserialize, Serialize};

/// Permission mode levels, ordered from least to most permissive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    /// Read-only: file reads, searches, web lookups. No modifications.
    ReadOnly,
    /// Standard: reads + writes in authorized folders, shell with confirmation.
    Standard,
    /// Full access: all tools, no restrictions. Dangerous.
    Full,
}

impl Default for PermissionMode {
    fn default() -> Self {
        Self::Standard
    }
}

impl PermissionMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ReadOnly => "read_only",
            Self::Standard => "standard",
            Self::Full => "full",
        }
    }

    #[allow(dead_code)]
    pub fn from_str(s: &str) -> Self {
        match s {
            "read_only" | "readonly" => Self::ReadOnly,
            "full" | "danger" | "danger_full_access" => Self::Full,
            _ => Self::Standard,
        }
    }
}

/// Required permission for a specific tool.
#[derive(Debug, Clone)]
pub struct ToolPermission {
    pub tool_name: String,
    pub required_mode: PermissionMode,
}

/// Built-in tool permission requirements.
pub fn tool_permission_requirements() -> Vec<ToolPermission> {
    vec![
        // ReadOnly tools — always allowed
        tp("read_file", PermissionMode::ReadOnly),
        tp("list_directory", PermissionMode::ReadOnly),
        tp("grep_search", PermissionMode::ReadOnly),
        tp("glob_search", PermissionMode::ReadOnly),
        tp("web_search", PermissionMode::ReadOnly),
        tp("get_current_time", PermissionMode::ReadOnly),
        tp("desktop_screenshot", PermissionMode::ReadOnly),
        tp("memory_search", PermissionMode::ReadOnly),
        tp("memory_list", PermissionMode::ReadOnly),
        tp("read_pdf", PermissionMode::ReadOnly),
        tp("read_spreadsheet", PermissionMode::ReadOnly),
        tp("read_docx", PermissionMode::ReadOnly),
        // Standard tools — need at least Standard mode
        tp("write_file", PermissionMode::Standard),
        tp("edit_file", PermissionMode::Standard),
        tp("append_file", PermissionMode::Standard),
        tp("delete_file", PermissionMode::Standard),
        tp("create_spreadsheet", PermissionMode::Standard),
        tp("create_docx", PermissionMode::Standard),
        tp("memory_add", PermissionMode::Standard),
        tp("memory_delete", PermissionMode::Standard),
        tp("manage_skill", PermissionMode::Standard),
        tp("register_code", PermissionMode::Standard),
        tp("manage_cronjob", PermissionMode::Standard),
        tp("create_task", PermissionMode::Standard),
        tp("render_canvas", PermissionMode::Standard),
        tp("pip_install", PermissionMode::Standard),
        tp("send_bot_message", PermissionMode::Standard),
        tp("manage_bot", PermissionMode::Standard),
        // Full access tools — need explicit Full mode
        tp("execute_shell", PermissionMode::Full),
        tp("run_python", PermissionMode::Full),
        tp("run_python_script", PermissionMode::Full),
        tp("computer_control", PermissionMode::Full),
        tp("claude_code", PermissionMode::Full),
        tp("browser_use", PermissionMode::Full),
    ]
}

fn tp(name: &str, mode: PermissionMode) -> ToolPermission {
    ToolPermission {
        tool_name: name.to_string(),
        required_mode: mode,
    }
}

/// Permission policy that evaluates tool access based on mode + rules.
pub struct PermissionPolicy {
    active_mode: PermissionMode,
    tool_requirements: std::collections::HashMap<String, PermissionMode>,
}

impl PermissionPolicy {
    pub fn new(mode: PermissionMode) -> Self {
        let mut reqs = std::collections::HashMap::new();
        for tp in tool_permission_requirements() {
            reqs.insert(tp.tool_name, tp.required_mode);
        }
        Self {
            active_mode: mode,
            tool_requirements: reqs,
        }
    }

    #[allow(dead_code)]
    pub fn active_mode(&self) -> PermissionMode {
        self.active_mode
    }

    /// Get the required permission mode for a tool.
    pub fn required_mode_for(&self, tool_name: &str) -> PermissionMode {
        self.tool_requirements
            .get(tool_name)
            .copied()
            .unwrap_or(PermissionMode::Standard)
    }

    /// Check if a tool is allowed under the current mode.
    pub fn is_allowed(&self, tool_name: &str) -> PermissionOutcome {
        let required = self.required_mode_for(tool_name);

        if self.active_mode >= required {
            PermissionOutcome::Allow
        } else if self.active_mode == PermissionMode::Standard
            && required == PermissionMode::Full
        {
            // Standard mode can use Full tools with user confirmation
            PermissionOutcome::NeedsConfirmation {
                reason: format!(
                    "此操作需要更高权限，请确认是否允许执行"
                ),
            }
        } else {
            PermissionOutcome::Deny {
                reason: format!(
                    "Tool '{}' requires {} mode (current: {})",
                    tool_name,
                    required.as_str(),
                    self.active_mode.as_str(),
                ),
            }
        }
    }
}

/// Outcome of a permission check.
#[derive(Debug, Clone)]
pub enum PermissionOutcome {
    /// Tool execution is allowed.
    Allow,
    /// Tool execution requires user confirmation.
    NeedsConfirmation { reason: String },
    /// Tool execution is denied.
    Deny { reason: String },
}

impl PermissionOutcome {
    #[allow(dead_code)]
    pub fn is_allowed(&self) -> bool {
        matches!(self, Self::Allow)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_ordering_preserves_permissiveness() {
        assert!(PermissionMode::ReadOnly < PermissionMode::Standard);
        assert!(PermissionMode::Standard < PermissionMode::Full);
    }

    #[test]
    fn mode_as_str_is_snake_case() {
        assert_eq!(PermissionMode::ReadOnly.as_str(), "read_only");
        assert_eq!(PermissionMode::Standard.as_str(), "standard");
        assert_eq!(PermissionMode::Full.as_str(), "full");
    }

    #[test]
    fn mode_from_str_accepts_aliases() {
        assert_eq!(PermissionMode::from_str("read_only"), PermissionMode::ReadOnly);
        assert_eq!(PermissionMode::from_str("readonly"), PermissionMode::ReadOnly);
        assert_eq!(PermissionMode::from_str("full"), PermissionMode::Full);
        assert_eq!(PermissionMode::from_str("danger"), PermissionMode::Full);
        assert_eq!(PermissionMode::from_str("danger_full_access"), PermissionMode::Full);
        // Unknown value falls back to Standard
        assert_eq!(PermissionMode::from_str("xyz"), PermissionMode::Standard);
    }

    #[test]
    fn default_mode_is_standard() {
        assert_eq!(PermissionMode::default(), PermissionMode::Standard);
    }

    #[test]
    fn readonly_tool_allowed_in_all_modes() {
        for mode in [PermissionMode::ReadOnly, PermissionMode::Standard, PermissionMode::Full] {
            let policy = PermissionPolicy::new(mode);
            assert!(policy.is_allowed("read_file").is_allowed());
        }
    }

    #[test]
    fn standard_tool_denied_in_readonly_mode() {
        let policy = PermissionPolicy::new(PermissionMode::ReadOnly);
        let outcome = policy.is_allowed("write_file");
        assert!(matches!(outcome, PermissionOutcome::Deny { .. }));
    }

    #[test]
    fn full_tool_needs_confirmation_in_standard_mode() {
        let policy = PermissionPolicy::new(PermissionMode::Standard);
        let outcome = policy.is_allowed("execute_shell");
        assert!(matches!(outcome, PermissionOutcome::NeedsConfirmation { .. }));
    }

    #[test]
    fn full_tool_allowed_in_full_mode() {
        let policy = PermissionPolicy::new(PermissionMode::Full);
        assert!(policy.is_allowed("execute_shell").is_allowed());
    }

    #[test]
    fn unknown_tool_defaults_to_standard_requirement() {
        let policy = PermissionPolicy::new(PermissionMode::ReadOnly);
        let out = policy.is_allowed("some_unknown_tool_xyz");
        // Standard required + ReadOnly active → Deny (not NeedsConfirmation)
        assert!(matches!(out, PermissionOutcome::Deny { .. }));
        assert_eq!(
            policy.required_mode_for("some_unknown_tool_xyz"),
            PermissionMode::Standard
        );
    }

    #[test]
    fn active_mode_accessor_returns_configured_mode() {
        let policy = PermissionPolicy::new(PermissionMode::Full);
        assert_eq!(policy.active_mode(), PermissionMode::Full);
    }

    #[test]
    fn tool_permission_requirements_covers_key_tools() {
        let reqs = tool_permission_requirements();
        let names: Vec<_> = reqs.iter().map(|r| r.tool_name.as_str()).collect();
        for tool in ["read_file", "write_file", "execute_shell", "claude_code"] {
            assert!(names.contains(&tool), "missing tool: {tool}");
        }
    }
}
