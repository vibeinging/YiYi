//! Shell command security analysis, classification, and output enhancement.
//!
//! Inspired by Claude Code's BashTool architecture, this module provides:
//!   - Command semantic classification (read-only / write / destructive / network)
//!   - Dangerous command & injection detection (Hardline + Block layers)
//!   - Path extraction for integration with the authorized-folder system
//!   - Exit-code semantics so the LLM understands `grep -1` ≠ error
//!   - Output enhancement for silent commands and warnings
//!
//! Sub-module map:
//!   * `hardline` — Unconditional refusals (`detect_hardline`). The only
//!     verdict layer that's NOT user-overridable.
//!   * `classify` — Tokeniser, classifier, command-set tables, plus the
//!     bypassable Block / Warn pattern checks.
//!   * `paths`    — File-path extraction from individual sub-commands.

mod classify;
mod hardline;
mod paths;

#[cfg(test)]
mod tests;

pub use hardline::detect_hardline;

use classify::{
    check_block_patterns, check_warn_patterns, classify_subcommand, extract_command_name,
    split_subcommands, SILENT_COMMANDS,
};
use paths::extract_paths_from_subcmd;

// ── Public types ────────────────────────────────────────────────────

/// Result of pre-execution command analysis.
pub struct CommandAnalysis {
    pub classification: CommandClass,
    /// The primary (first) command name, e.g. "grep".
    pub primary_command: String,
    /// File paths extracted from command arguments.
    pub extracted_paths: Vec<ExtractedPath>,
    /// Security verdict: allow, block, or warn.
    pub security_verdict: SecurityVerdict,
}

pub struct ExtractedPath {
    pub path: String,
    pub needs_write: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandClass {
    ReadOnly,
    Write,
    Destructive,
    Network,
    Unknown,
}

#[derive(Debug, Clone)]
pub enum SecurityVerdict {
    Allow,
    /// **Unconditional block** — patterns that destroy data, system, or
    /// hardware irrecoverably. Never bypassable: not by session blanket
    /// "approve all", not by yolo mode. If the user really needs to run
    /// it, they run it in their own terminal.
    Hardline { reason: String },
    /// Dangerous but recoverable — surfaced to the user as a permission
    /// dialog; can be approved per-command or via session blanket.
    Block { reason: String },
    Warn { message: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExitCodeMeaning {
    Normal,
    Info { message: String },
    Error,
}

// ── Main analysis entry point ───────────────────────────────────────

/// Analyze a shell command for classification, security, and paths.
pub fn analyze_command(command: &str) -> CommandAnalysis {
    let subcommands = split_subcommands(command);

    // Classify each sub-command and collect paths
    let mut classifications = Vec::new();
    let mut all_paths = Vec::new();
    let mut primary_command = String::new();

    for (i, sub) in subcommands.iter().enumerate() {
        let cls = classify_subcommand(sub);
        if i == 0 {
            primary_command = extract_command_name(sub);
        }
        let paths = extract_paths_from_subcmd(sub, cls);
        all_paths.extend(paths);
        classifications.push(cls);
    }

    // Overall classification: worst-case wins
    let classification = if classifications
        .iter()
        .any(|c| matches!(c, CommandClass::Destructive))
    {
        CommandClass::Destructive
    } else if classifications
        .iter()
        .all(|c| matches!(c, CommandClass::ReadOnly))
    {
        CommandClass::ReadOnly
    } else if classifications
        .iter()
        .any(|c| matches!(c, CommandClass::Network))
    {
        CommandClass::Network
    } else if classifications
        .iter()
        .any(|c| matches!(c, CommandClass::Write | CommandClass::Unknown))
    {
        CommandClass::Write
    } else {
        CommandClass::Unknown
    };

    // Security checks
    let normalized: String = command
        .trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    // Pipe-to-shell detection using already-split subcommands
    let pipe_to_shell_block = {
        static DOWNLOADERS: &[&str] = &["curl", "wget"];
        static SHELLS: &[&str] = &["sh", "bash", "zsh"];
        let mut blocked: Option<String> = None;
        if subcommands.len() >= 2 {
            for i in 0..subcommands.len() - 1 {
                let dl_name = extract_command_name(&subcommands[i]);
                let shell_name = extract_command_name(&subcommands[i + 1]);
                if DOWNLOADERS.contains(&dl_name.as_str())
                    && SHELLS.contains(&shell_name.as_str())
                {
                    blocked = Some(format!(
                        "piping download to shell ({} | {}). This is a common attack vector.",
                        dl_name, shell_name
                    ));
                    break;
                }
            }
        }
        blocked
    };

    // Hardline runs FIRST and on the raw command (regex handles whitespace);
    // it short-circuits everything else so a hardline pattern can never be
    // demoted to a bypassable Block by a downstream check.
    let security_verdict = if let Some(label) = detect_hardline(command) {
        SecurityVerdict::Hardline {
            reason: label.to_string(),
        }
    } else if let Some(reason) = pipe_to_shell_block {
        SecurityVerdict::Block { reason }
    } else if let Some(reason) = check_block_patterns(&normalized) {
        SecurityVerdict::Block { reason }
    } else if let Some(message) = check_warn_patterns(command) {
        SecurityVerdict::Warn { message }
    } else {
        SecurityVerdict::Allow
    };

    CommandAnalysis {
        classification,
        primary_command,
        extracted_paths: all_paths,
        security_verdict,
    }
}

// ── Async path access checking (delegates to tools::access_check) ───

/// Validate extracted paths against authorized folders and sensitive patterns.
pub async fn check_command_paths(analysis: &CommandAnalysis) -> Result<(), String> {
    for ep in &analysis.extracted_paths {
        // Skip relative paths without / (e.g. just filenames like "file.txt")
        // These resolve to cwd which is already the workspace
        if !ep.path.starts_with('/')
            && !ep.path.starts_with("~/")
            && !ep.path.starts_with("./")
            && !ep.path.starts_with("../")
            && ep.path != "~"
        {
            continue;
        }
        super::access_check(&ep.path, ep.needs_write).await?;
    }
    Ok(())
}

// ── Exit code semantics ─────────────────────────────────────────────

/// Interpret a non-zero exit code for common commands.
pub fn interpret_exit_code(primary_command: &str, code: i32) -> ExitCodeMeaning {
    if code == 0 {
        return ExitCodeMeaning::Normal;
    }

    match primary_command {
        // grep/rg/ag/ack: 1 = no matches, 2+ = error
        "grep" | "rg" | "ag" | "ack" | "egrep" | "fgrep" => {
            if code == 1 {
                ExitCodeMeaning::Info {
                    message: "No matches found".into(),
                }
            } else {
                ExitCodeMeaning::Error
            }
        }
        // diff/cmp: 1 = files differ, 2+ = error
        "diff" | "cmp" | "comm" => {
            if code == 1 {
                ExitCodeMeaning::Info {
                    message: "Files differ".into(),
                }
            } else {
                ExitCodeMeaning::Error
            }
        }
        // test/[: 1 = condition false, 2+ = error
        "test" | "[" => {
            if code == 1 {
                ExitCodeMeaning::Info {
                    message: "Condition is false".into(),
                }
            } else {
                ExitCodeMeaning::Error
            }
        }
        // git diff: 1 = changes exist
        "git" => {
            if code == 1 {
                ExitCodeMeaning::Info {
                    message: "Changes detected".into(),
                }
            } else {
                ExitCodeMeaning::Error
            }
        }
        _ => ExitCodeMeaning::Error,
    }
}

// ── Output enhancement ──────────────────────────────────────────────

/// Maximum characters returned to the LLM from shell output.
const MAX_OUTPUT_CHARS: usize = 8000;

/// Build the output string returned to the LLM, with semantic awareness.
pub fn enhance_output(
    analysis: &CommandAnalysis,
    stdout: &str,
    stderr: &str,
    exit_code: i32,
) -> String {
    let max_chars = MAX_OUTPUT_CHARS;
    let mut result = String::new();

    // Prepend security warning if present
    if let SecurityVerdict::Warn { message } = &analysis.security_verdict {
        result.push_str(message);
        result.push_str("\n\n");
    }

    if exit_code == 0 {
        if stdout.is_empty() {
            // Silent command awareness
            if SILENT_COMMANDS.contains(analysis.primary_command.as_str()) {
                result.push_str("Done (completed successfully)");
            } else {
                result.push_str("(completed with no output)");
            }
        } else {
            result.push_str(&super::truncate_output(stdout, max_chars));
        }
    } else {
        // Use exit code semantics
        match interpret_exit_code(&analysis.primary_command, exit_code) {
            ExitCodeMeaning::Info { message } => {
                // Not an error — present as informational
                if stdout.is_empty() && stderr.is_empty() {
                    result.push_str(&message);
                } else {
                    result.push_str(&format!("{}\n", message));
                    if !stdout.is_empty() {
                        result.push_str(&super::truncate_output(stdout, max_chars));
                    }
                }
            }
            ExitCodeMeaning::Error | ExitCodeMeaning::Normal => {
                let combined = format!(
                    "Exit code: {}\nstdout:\n{}\nstderr:\n{}",
                    exit_code, stdout, stderr
                );
                result.push_str(&super::truncate_output(&combined, max_chars));
            }
        }
    }

    result
}
