//! Bash command validation — multi-layer security for shell execution.
//!
//! Provides:
//! - Read-only mode enforcement (whitelist of safe commands)
//! - Destructive command detection
//! - Path traversal warnings

use std::path::Path;
use crate::engine::permission_mode::PermissionMode;

/// Validation result.
#[derive(Debug, Clone)]
pub enum BashValidation {
    Allow,
    Warn(String),
    Deny(String),
}

#[allow(dead_code)]
impl BashValidation {
    pub fn is_denied(&self) -> bool { matches!(self, Self::Deny(_)) }
    pub fn is_warning(&self) -> bool { matches!(self, Self::Warn(_)) }
    pub fn message(&self) -> Option<&str> {
        match self {
            Self::Allow => None,
            Self::Warn(m) | Self::Deny(m) => Some(m),
        }
    }
}

/// Validate a bash command against the permission mode and workspace.
pub fn validate_bash_command(
    command: &str,
    mode: PermissionMode,
    workspace_root: Option<&Path>,
) -> BashValidation {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return BashValidation::Deny("Empty command".into());
    }

    // 1. Destructive pattern detection (always blocked regardless of mode)
    if let Some(reason) = detect_destructive(trimmed) {
        return BashValidation::Deny(reason);
    }

    // 2. Mode-specific validation
    match mode {
        PermissionMode::ReadOnly => validate_read_only(trimmed, workspace_root),
        PermissionMode::Standard => validate_standard(trimmed, workspace_root),
        PermissionMode::Full => {
            // Full mode allows everything except destructive patterns (checked above)
            if let Some(warning) = detect_path_traversal(trimmed, workspace_root) {
                BashValidation::Warn(warning)
            } else {
                BashValidation::Allow
            }
        }
    }
}

// ── Destructive detection ───────────────────────────────────────────────

fn detect_destructive(cmd: &str) -> Option<String> {
    // Fork bomb patterns
    if cmd.contains(":(){ :|:&") || cmd.contains(":(){") {
        return Some("Blocked: fork bomb pattern detected".into());
    }

    // rm -rf / (root deletion) — detect both short and long flag forms
    let has_rm = cmd.contains("rm ");
    let has_recursive_force = cmd.contains("-rf") || cmd.contains("-fr")
        || (cmd.contains("--recursive") && cmd.contains("--force"));
    if has_rm && has_recursive_force && (cmd.contains(" /") || cmd.contains(" /*")) {
        if cmd.contains(" / ") || cmd.ends_with(" /") || cmd.contains(" /* ") || cmd.ends_with(" /*") {
            return Some("Blocked: recursive deletion of root filesystem".into());
        }
    }

    // dd to block devices
    if cmd.contains("dd ") && cmd.contains("of=/dev/") {
        return Some("Blocked: writing to block device".into());
    }

    // mkfs on devices
    if cmd.starts_with("mkfs") || cmd.contains(" mkfs") {
        return Some("Blocked: filesystem formatting".into());
    }

    // chmod/chown on system directories
    if (cmd.contains("chmod") || cmd.contains("chown")) && cmd.contains("-R") {
        for sys_dir in &[" /", " /etc", " /usr", " /sys", " /var", " /bin", " /sbin"] {
            if cmd.contains(sys_dir) {
                return Some(format!("Blocked: recursive permission change on system directory"));
            }
        }
    }

    // System shutdown/reboot
    if cmd.starts_with("shutdown") || cmd.starts_with("reboot") || cmd.starts_with("halt") || cmd.starts_with("init 0") {
        return Some("Blocked: system shutdown/reboot command".into());
    }

    None
}

// ── Read-only mode validation ───────────────────────────────────────────

fn validate_read_only(cmd: &str, workspace_root: Option<&Path>) -> BashValidation {
    // Check for output redirection (>, >>)
    if has_output_redirect(cmd) {
        return BashValidation::Deny("Read-only mode: output redirection (>, >>) not allowed".into());
    }

    // Check for in-place editing flags
    if has_inplace_flag(cmd) {
        return BashValidation::Deny("Read-only mode: in-place editing (-i) not allowed".into());
    }

    let first = extract_first_command(cmd);
    let base = first.rsplit('/').next().unwrap_or(&first);

    // Git: only allow read-only subcommands
    if base == "git" {
        if !is_git_read_only(cmd) {
            return BashValidation::Deny(format!(
                "Read-only mode: git write command not allowed. Allowed: {}",
                GIT_READ_ONLY_COMMANDS.join(", ")
            ));
        }
        return BashValidation::Allow;
    }

    // Allow whitelisted read-only commands
    if READ_ONLY_SAFE_LIST.contains(&base) {
        if let Some(warning) = detect_path_traversal(cmd, workspace_root) {
            return BashValidation::Warn(warning);
        }
        return BashValidation::Allow;
    }

    BashValidation::Deny(format!(
        "Read-only mode: command '{}' not in safe list. Use Standard or Full mode for write operations.",
        base
    ))
}

// ── Standard mode validation ────────────────────────────────────────────

fn validate_standard(cmd: &str, workspace_root: Option<&Path>) -> BashValidation {
    // Standard mode allows most commands but warns about dangerous patterns
    if let Some(warning) = detect_path_traversal(cmd, workspace_root) {
        return BashValidation::Warn(warning);
    }

    // Warn about potentially dangerous commands
    let first = extract_first_command(cmd);
    let base = first.rsplit('/').next().unwrap_or(&first);

    if SYSADMIN_COMMANDS.contains(&base) {
        return BashValidation::Warn(format!(
            "System admin command '{}' — use with caution", base
        ));
    }

    BashValidation::Allow
}

// ── Path traversal detection ────────────────────────────────────────────

fn detect_path_traversal(cmd: &str, workspace_root: Option<&Path>) -> Option<String> {
    // Check for ../ patterns that might escape workspace
    if cmd.contains("../") {
        if let Some(ws) = workspace_root {
            return Some(format!(
                "Warning: command contains '../' which may escape workspace {}",
                ws.display()
            ));
        }
    }

    // Check for sensitive system directory access
    for dir in &["/etc/passwd", "/etc/shadow", "/etc/sudoers", "/proc/", "/sys/kernel"] {
        if cmd.contains(dir) {
            return Some(format!("Warning: command accesses sensitive path {}", dir));
        }
    }

    None
}

// ── Git subcommand handling ─────────────────────────────────────────────

const GIT_READ_ONLY_COMMANDS: &[&str] = &[
    "status", "log", "diff", "show", "branch", "tag", "describe",
    "rev-parse", "ls-files", "ls-tree", "cat-file", "reflog",
    "shortlog", "blame", "bisect", "stash list", "remote",
    "config --list", "config --get", "rev-list", "name-rev",
    "for-each-ref", "count-objects", "fsck", "verify-pack",
];

fn is_git_read_only(cmd: &str) -> bool {
    let after_git = cmd.trim_start_matches("git").trim();
    for sub in GIT_READ_ONLY_COMMANDS {
        if after_git.starts_with(sub) {
            return true;
        }
    }
    false
}

// ── Redirect & in-place detection ───────────────────────────────────────

fn has_output_redirect(cmd: &str) -> bool {
    // Simple heuristic — check for > or >> not inside quotes
    // This is intentionally conservative (may false-positive inside strings)
    let mut in_single_quote = false;
    let mut in_double_quote = false;
    let chars: Vec<char> = cmd.chars().collect();
    for i in 0..chars.len() {
        match chars[i] {
            '\'' if !in_double_quote => in_single_quote = !in_single_quote,
            '"' if !in_single_quote => in_double_quote = !in_double_quote,
            '>' if !in_single_quote && !in_double_quote => {
                // Make sure it's not part of a comparison (e.g., 2>&1)
                if i > 0 && chars[i - 1] == '&' {
                    continue; // This is a fd redirect like 2>&1
                }
                return true;
            }
            _ => {}
        }
    }
    false
}

fn has_inplace_flag(cmd: &str) -> bool {
    // Check for sed -i or perl -i patterns
    let words: Vec<&str> = cmd.split_whitespace().collect();
    for (i, word) in words.iter().enumerate() {
        if (*word == "-i" || word.starts_with("-i.") || word.starts_with("--in-place"))
            && i > 0
            && (words[i - 1].ends_with("sed") || words[i - 1].ends_with("perl"))
        {
            return true;
        }
    }
    false
}

// ── Helper: extract first command from pipeline ─────────────────────────

fn extract_first_command(cmd: &str) -> String {
    let trimmed = cmd.trim();
    // Handle: env VAR=val cmd, sudo cmd, etc.
    let stripped = trimmed
        .strip_prefix("sudo ")
        .or_else(|| trimmed.strip_prefix("env "))
        .unwrap_or(trimmed)
        .trim();

    // Skip env var assignments (FOO=bar cmd)
    let mut parts = stripped.split_whitespace();
    loop {
        match parts.next() {
            Some(p) if p.contains('=') && !p.starts_with('-') => continue,
            Some(p) => return p.to_string(),
            None => return String::new(),
        }
    }
}

// ── Command category lists ──────────────────────────────────────────────

/// Commands safe for read-only execution.
const READ_ONLY_SAFE_LIST: &[&str] = &[
    "cat", "head", "tail", "less", "more", "wc", "ls", "find", "grep", "rg",
    "awk", "sed", "echo", "printf", "which", "where", "whoami", "pwd",
    "env", "printenv", "date", "cal", "df", "du", "free", "uptime", "uname",
    "file", "stat", "diff", "sort", "uniq", "tr", "cut", "paste", "tee",
    "xargs", "test", "true", "false", "type", "readlink", "realpath",
    "basename", "dirname", "sha256sum", "md5sum", "xxd", "hexdump", "od",
    "strings", "tree", "jq", "yq",
    "git", "gh", "id", "groups", "hostname", "arch",
    "sw_vers", "sysctl", "nproc", "lscpu", "top", "ps", "pgrep",
];

const SYSADMIN_COMMANDS: &[&str] = &[
    "systemctl", "service", "launchctl", "crontab", "at",
    "mount", "umount", "lsblk", "blkid", "swapon", "swapoff",
    "useradd", "userdel", "usermod", "groupadd", "passwd",
    "visudo", "su",
];
