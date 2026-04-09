//! Bash command validation — multi-layer security for shell execution.
//!
//! Borrowed from Claw Code's bash_validation.rs design. Provides:
//! - Semantic classification (8 intent types)
//! - Read-only mode enforcement (whitelist of safe commands)
//! - Destructive command detection
//! - Path traversal warnings
//! - Git subcommand filtering

use std::path::Path;
use crate::engine::permission_mode::PermissionMode;

// ── Command classification ──────────────────────────────────────────────

/// Semantic intent of a shell command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandIntent {
    ReadOnly,
    Write,
    Destructive,
    Network,
    ProcessManagement,
    PackageManagement,
    SystemAdmin,
    Unknown,
}

/// Validation result.
#[derive(Debug, Clone)]
pub enum BashValidation {
    Allow,
    Warn(String),
    Deny(String),
}

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

/// Classify a command's semantic intent.
pub fn classify_command(command: &str) -> CommandIntent {
    let first = extract_first_command(command);
    let base = first.rsplit('/').next().unwrap_or(&first);

    if READ_ONLY_COMMANDS.contains(&base) {
        return CommandIntent::ReadOnly;
    }
    if DESTRUCTIVE_COMMANDS.contains(&base) {
        return CommandIntent::Destructive;
    }
    if WRITE_COMMANDS.contains(&base) {
        return CommandIntent::Write;
    }
    if NETWORK_COMMANDS.contains(&base) {
        return CommandIntent::Network;
    }
    if PROCESS_COMMANDS.contains(&base) {
        return CommandIntent::ProcessManagement;
    }
    if PACKAGE_COMMANDS.contains(&base) {
        return CommandIntent::PackageManagement;
    }
    if SYSADMIN_COMMANDS.contains(&base) {
        return CommandIntent::SystemAdmin;
    }

    // Check for git subcommands
    if base == "git" {
        return classify_git_subcommand(command);
    }

    CommandIntent::Unknown
}

// ── Destructive detection ───────────────────────────────────────────────

fn detect_destructive(cmd: &str) -> Option<String> {
    // Fork bomb patterns
    if cmd.contains(":(){ :|:&") || cmd.contains(":(){") {
        return Some("Blocked: fork bomb pattern detected".into());
    }

    // rm -rf / (root deletion)
    if cmd.contains("rm ") && cmd.contains("-rf") && (cmd.contains(" /") || cmd.contains(" /*")) {
        // Check it's actually targeting root, not a subpath
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

const GIT_WRITE_COMMANDS: &[&str] = &[
    "push", "commit", "reset", "checkout", "merge", "rebase",
    "cherry-pick", "revert", "stash drop", "stash pop", "stash apply",
    "branch -d", "branch -D", "tag -d", "clean", "gc",
    "filter-branch", "subtree",
];

fn classify_git_subcommand(cmd: &str) -> CommandIntent {
    let after_git = cmd.trim_start_matches("git").trim();
    for sub in GIT_READ_ONLY_COMMANDS {
        if after_git.starts_with(sub) {
            return CommandIntent::ReadOnly;
        }
    }
    for sub in GIT_WRITE_COMMANDS {
        if after_git.starts_with(sub) {
            return CommandIntent::Write;
        }
    }
    CommandIntent::Unknown
}

fn is_git_read_only(cmd: &str) -> bool {
    let after_git = cmd.trim_start_matches("git").trim();
    // "git add" and "git stash" (without drop/pop) are allowed in read-only for inspection
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

const READ_ONLY_COMMANDS: &[&str] = &[
    "cat", "head", "tail", "less", "more", "wc", "ls", "find", "grep", "rg",
    "awk", "echo", "printf", "which", "whoami", "pwd", "env", "printenv",
    "date", "cal", "df", "du", "free", "uptime", "uname", "file", "stat",
    "diff", "sort", "uniq", "tr", "cut", "paste", "test", "true", "false",
    "type", "readlink", "realpath", "basename", "dirname", "strings", "tree",
    "jq", "yq", "id", "groups", "hostname", "arch", "ps", "pgrep", "top",
];

const WRITE_COMMANDS: &[&str] = &[
    "cp", "mv", "rm", "mkdir", "rmdir", "touch", "chmod", "chown", "chgrp",
    "ln", "install", "rsync", "tar", "zip", "unzip", "gzip", "gunzip",
    "sed", "tee", "patch", "truncate",
];

const DESTRUCTIVE_COMMANDS: &[&str] = &[
    "mkfs", "fdisk", "parted", "wipefs", "shred",
    "shutdown", "reboot", "halt", "poweroff", "init",
];

const NETWORK_COMMANDS: &[&str] = &[
    "curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "ncat",
    "telnet", "ftp", "ping", "traceroute", "dig", "nslookup", "host",
    "netstat", "ss", "ip", "ifconfig", "iptables", "nft",
];

const PROCESS_COMMANDS: &[&str] = &[
    "kill", "killall", "pkill", "nohup", "disown", "bg", "fg",
    "nice", "renice", "timeout", "watch", "screen", "tmux",
];

const PACKAGE_COMMANDS: &[&str] = &[
    "apt", "apt-get", "dpkg", "yum", "dnf", "pacman", "brew",
    "npm", "yarn", "pnpm", "pip", "pip3", "cargo", "gem", "go",
];

const SYSADMIN_COMMANDS: &[&str] = &[
    "systemctl", "service", "launchctl", "crontab", "at",
    "mount", "umount", "lsblk", "blkid", "swapon", "swapoff",
    "useradd", "userdel", "usermod", "groupadd", "passwd",
    "visudo", "su",
];
