//! Structural command classification: tokenise the input into sub-commands,
//! identify each one's command name, and tag it `ReadOnly` / `Write` /
//! `Destructive` / `Network` / `Unknown`.
//!
//! Also hosts the pattern-based `check_block_patterns` (bypassable destructive
//! patterns like `rm -rf /home`) and `check_warn_patterns` (env-var injection,
//! command substitution, suspicious POSTs) since they share the tokenizer.

use std::collections::HashSet;
use std::sync::LazyLock;

use super::CommandClass;

pub(super) static READ_ONLY_COMMANDS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        "cat", "head", "tail", "less", "more",
        "grep", "rg", "ag", "ack",
        "find", "fd", "locate",
        "ls", "tree", "du", "df",
        "wc", "stat", "file", "strings",
        "diff", "cmp", "comm",
        "sort", "uniq", "cut", "tr", "awk", "jq", "yq",
        "which", "whereis", "type", "command",
        "echo", "printf", "true", "false",
        "date", "cal",
        "pwd", "hostname", "uname", "arch",
        "env", "printenv",
        "whoami", "id", "groups",
        "ps", "top", "htop", "free", "uptime", "lsof",
        "man", "help", "info",
        "realpath", "basename", "dirname",
        "sha256sum", "sha1sum", "md5sum", "cksum",
        "xxd", "hexdump", "od",
    ].into_iter().collect()
});

pub(super) static READ_ONLY_GIT_SUBCOMMANDS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        "status", "log", "diff", "show", "branch", "tag",
        "remote", "describe", "shortlog", "blame", "whatchanged",
        "ls-files", "ls-tree", "ls-remote",
        "rev-parse", "rev-list", "cat-file",
        "config", // read-only when no --set/--unset
        "stash",  // "stash list" is read-only, handled below
    ].into_iter().collect()
});

pub(super) static DESTRUCTIVE_GIT_PATTERNS: &[&str] = &[
    "clean -f", "clean -d", "clean -fd", "clean -fdx",
    "reset --hard",
    "push --force", "push -f",
    "checkout -- .",
];

pub(super) static SILENT_COMMANDS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        "mv", "cp", "mkdir", "rmdir", "chmod", "chown", "chgrp",
        "touch", "ln", "cd", "export", "unset",
    ].into_iter().collect()
});

pub(super) static NETWORK_COMMANDS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        "curl", "wget", "ssh", "scp", "rsync", "sftp",
        "nc", "ncat", "netcat", "telnet", "ftp",
        "ping", "traceroute", "dig", "nslookup", "host",
    ].into_iter().collect()
});

// ── Quote-aware command splitter ────────────────────────────────────

/// Split a command string on unquoted `|`, `;`, `&&`, `||` delimiters.
/// Returns individual sub-command strings (trimmed).
pub(super) fn split_subcommands(command: &str) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    let chars: Vec<char> = command.chars().collect();
    let len = chars.len();
    let mut i = 0;
    let mut in_single = false;
    let mut in_double = false;

    while i < len {
        let c = chars[i];

        // Track quote state
        if c == '\'' && !in_double {
            in_single = !in_single;
            current.push(c);
            i += 1;
            continue;
        }
        if c == '"' && !in_single {
            in_double = !in_double;
            current.push(c);
            i += 1;
            continue;
        }
        if c == '\\' && i + 1 < len {
            current.push(c);
            current.push(chars[i + 1]);
            i += 2;
            continue;
        }

        // Only split when outside quotes
        if !in_single && !in_double {
            // &&
            if c == '&' && i + 1 < len && chars[i + 1] == '&' {
                let trimmed = current.trim().to_string();
                if !trimmed.is_empty() {
                    parts.push(trimmed);
                }
                current.clear();
                i += 2;
                continue;
            }
            // ||
            if c == '|' && i + 1 < len && chars[i + 1] == '|' {
                let trimmed = current.trim().to_string();
                if !trimmed.is_empty() {
                    parts.push(trimmed);
                }
                current.clear();
                i += 2;
                continue;
            }
            // | (single pipe)
            if c == '|' {
                let trimmed = current.trim().to_string();
                if !trimmed.is_empty() {
                    parts.push(trimmed);
                }
                current.clear();
                i += 1;
                continue;
            }
            // ;
            if c == ';' {
                let trimmed = current.trim().to_string();
                if !trimmed.is_empty() {
                    parts.push(trimmed);
                }
                current.clear();
                i += 1;
                continue;
            }
        }

        current.push(c);
        i += 1;
    }

    let trimmed = current.trim().to_string();
    if !trimmed.is_empty() {
        parts.push(trimmed);
    }
    parts
}

/// Extract the base command name from a sub-command string.
/// Strips leading environment variable assignments (FOO=bar) and safe wrappers (nice, timeout).
pub(super) fn extract_command_name(subcmd: &str) -> String {
    static SAFE_WRAPPERS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
        ["nice", "nohup", "timeout", "time", "stdbuf", "ionice"]
            .into_iter()
            .collect()
    });

    let tokens: Vec<&str> = subcmd.split_whitespace().collect();
    let mut idx = 0;

    // Skip env var assignments (KEY=value)
    while idx < tokens.len() {
        let t = tokens[idx];
        if t.contains('=') && !t.starts_with('-') && !t.starts_with('/') {
            // Looks like KEY=value
            let key = t.split('=').next().unwrap_or("");
            if key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && !key.is_empty() {
                idx += 1;
                continue;
            }
        }
        break;
    }

    // Skip safe wrapper commands and their arguments
    while idx < tokens.len() {
        let t = tokens[idx];
        if SAFE_WRAPPERS.contains(t) {
            idx += 1;
            // Skip wrapper arguments: flags (-n, --signal, etc.) and their values,
            // plus positional args that look like numbers (e.g. `timeout 300`, `nice -n 10`)
            while idx < tokens.len() {
                let arg = tokens[idx];
                if arg.starts_with('-') {
                    idx += 1;
                    // Flag might take a value
                    if idx < tokens.len() && !tokens[idx].starts_with('-') {
                        idx += 1;
                    }
                } else if arg.chars().all(|c| c.is_ascii_digit() || c == '.') {
                    // Positional numeric arg (e.g. timeout 300, nice 10)
                    idx += 1;
                } else {
                    break; // Found the actual command
                }
            }
            continue;
        }
        break;
    }

    if idx < tokens.len() {
        tokens[idx].to_string()
    } else {
        String::new()
    }
}

/// Get the git subcommand (e.g. "status" from "git -C /path status").
fn extract_git_subcommand(subcmd: &str) -> Option<String> {
    let tokens: Vec<&str> = subcmd.split_whitespace().collect();
    let git_idx = tokens.iter().position(|t| *t == "git")?;
    let mut i = git_idx + 1;
    // Skip git global flags
    while i < tokens.len() {
        let t = tokens[i];
        if t.starts_with('-') {
            i += 1;
            // Flags that take an argument: -C, -c, --git-dir, --work-tree
            if matches!(t, "-C" | "-c" | "--git-dir" | "--work-tree") && i < tokens.len() {
                i += 1;
            }
        } else {
            return Some(t.to_string());
        }
    }
    None
}

/// Classify a single sub-command.
pub(super) fn classify_subcommand(subcmd: &str) -> CommandClass {
    let cmd_name = extract_command_name(subcmd);
    if cmd_name.is_empty() {
        return CommandClass::Unknown;
    }

    // Git special handling
    if cmd_name == "git" {
        if let Some(git_sub) = extract_git_subcommand(subcmd) {
            // Check destructive git patterns first
            let normalized = subcmd.to_lowercase();
            for pattern in DESTRUCTIVE_GIT_PATTERNS {
                if normalized.contains(pattern) {
                    return CommandClass::Destructive;
                }
            }
            if READ_ONLY_GIT_SUBCOMMANDS.contains(git_sub.as_str()) {
                return CommandClass::ReadOnly;
            }
            return CommandClass::Write;
        }
        return CommandClass::Unknown;
    }

    // rm with -rf or -r is destructive
    if cmd_name == "rm" {
        let lower = subcmd.to_lowercase();
        if lower.contains("-rf") || lower.contains("-r -f") || lower.contains("-fr") {
            return CommandClass::Destructive;
        }
        return CommandClass::Write;
    }

    if READ_ONLY_COMMANDS.contains(cmd_name.as_str()) {
        // sed -i is NOT read-only
        if cmd_name == "sed" || cmd_name == "awk" {
            let lower = subcmd.to_lowercase();
            if lower.contains(" -i") {
                return CommandClass::Write;
            }
        }
        return CommandClass::ReadOnly;
    }

    if NETWORK_COMMANDS.contains(cmd_name.as_str()) {
        return CommandClass::Network;
    }

    if SILENT_COMMANDS.contains(cmd_name.as_str()) {
        return CommandClass::Write;
    }

    // tee writes to files
    if cmd_name == "tee" {
        return CommandClass::Write;
    }

    // Common write commands
    if matches!(
        cmd_name.as_str(),
        "npm" | "yarn"
            | "pnpm"
            | "pip"
            | "pip3"
            | "cargo"
            | "brew"
            | "apt"
            | "apt-get"
            | "yum"
            | "dnf"
            | "pacman"
            | "docker"
            | "kubectl"
            | "terraform"
    ) {
        return CommandClass::Write;
    }

    CommandClass::Unknown
}

// ── Block / Warn pattern checks ─────────────────────────────────────

/// Dangerous command patterns — returns Block reason if matched.
pub(super) fn check_block_patterns(normalized: &str) -> Option<String> {
    let patterns: &[(&str, &str)] = &[
        // Filesystem destruction
        ("rm -rf /", "rm -rf / (wipe root filesystem)"),
        ("rm -rf /*", "rm -rf /* (wipe root filesystem)"),
        ("rm -r -f /", "rm -rf / (wipe root filesystem)"),
        ("rm -rf ~", "rm -rf ~ (wipe home directory)"),
        ("rm -r -f ~", "rm -rf ~ (wipe home directory)"),
        ("rm -fr /", "rm -rf / (wipe root filesystem)"),
        ("rm -fr ~", "rm -rf ~ (wipe home directory)"),
        // Disk/device
        ("mkfs.", "mkfs (format disk)"),
        ("dd if=/dev/zero of=/dev/", "dd write to device"),
        ("dd if=/dev/random of=/dev/", "dd write to device"),
        ("> /dev/sd", "write to raw device"),
        ("> /dev/nvme", "write to raw device"),
        // Fork bomb
        (":(){ :|:& };:", "fork bomb"),
        (".() { .|.& }; .", "fork bomb variant"),
        // System config overwrite
        ("> /etc/passwd", "overwrite /etc/passwd"),
        ("> /etc/shadow", "overwrite /etc/shadow"),
        // chmod / chown root
        ("chmod -r 777 /", "chmod 777 / (open all permissions)"),
        ("chmod -r 777 /*", "chmod 777 /* (open all permissions)"),
        ("chown -r root /", "recursive chown root on /"),
        ("chown -r root:root /", "recursive chown root on /"),
        // Sudo + destructive
        ("sudo rm -rf /", "sudo rm -rf /"),
        ("sudo rm -rf ~", "sudo rm -rf ~"),
        ("sudo mkfs", "sudo mkfs (format disk)"),
        ("sudo dd if=/dev", "sudo dd to device"),
    ];

    for (pattern, label) in patterns {
        if normalized.contains(pattern) {
            return Some(format!(
                "命令匹配危险模式 ({})，可能造成不可逆损害",
                label
            ));
        }
    }

    // Encoded/obfuscated command detection
    if (normalized.contains("$'\\x") || normalized.contains("\\x")) && normalized.contains("eval")
    {
        return Some("检测到编码/混淆命令 (hex escape + eval)，可能是命令注入".into());
    }

    None
}

/// Warning patterns — returns Warn message if matched.
pub(super) fn check_warn_patterns(command: &str) -> Option<String> {
    let mut warnings = Vec::new();

    // Dangerous environment variables
    let dangerous_env = [
        "PATH=",
        "LD_PRELOAD=",
        "LD_LIBRARY_PATH=",
        "DYLD_",
        "IFS=",
        "PYTHONPATH=",
        "NODE_PATH=",
        "RUBYLIB=",
    ];
    let normalized_lower = command.to_lowercase();
    for var in dangerous_env {
        if normalized_lower.contains(&var.to_lowercase()) {
            warnings.push(format!(
                "设置了危险的环境变量 ({})",
                var.trim_end_matches('=')
            ));
        }
    }

    // Command substitution (outside single quotes)
    let has_cmd_sub = {
        let mut in_single = false;
        let chars: Vec<char> = command.chars().collect();
        let mut found = false;
        for i in 0..chars.len() {
            if chars[i] == '\'' {
                in_single = !in_single;
                continue;
            }
            if !in_single {
                // $( pattern
                if chars[i] == '$' && i + 1 < chars.len() && chars[i + 1] == '(' {
                    found = true;
                    break;
                }
                // backtick
                if chars[i] == '`' {
                    found = true;
                    break;
                }
            }
        }
        found
    };
    if has_cmd_sub {
        warnings.push("包含命令替换 ($() 或反引号)".into());
    }

    // Data exfiltration hints
    if (normalized_lower.contains("curl")
        && (normalized_lower.contains("--data") || normalized_lower.contains("-d ")))
        || (normalized_lower.contains("wget") && normalized_lower.contains("--post-data"))
    {
        let sensitive = [
            ".env",
            ".ssh",
            "passwd",
            "shadow",
            "credentials",
            "secret",
            "token",
            "key",
        ];
        for s in sensitive {
            if normalized_lower.contains(s) {
                warnings.push(format!("可能通过 HTTP POST 泄露敏感数据 ({})", s));
                break;
            }
        }
    }

    // Newlines in command
    if command.contains('\n') {
        warnings.push("包含换行符（可能隐藏命令）".into());
    }

    if warnings.is_empty() {
        None
    } else {
        Some(format!("[注意] {}", warnings.join("；")))
    }
}
