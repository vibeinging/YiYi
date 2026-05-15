//! File-path extraction from a shell sub-command. Used by
//! `analyze_command` to feed the surrounding authorized-folder /
//! sensitive-pattern check (`check_command_paths`) so the LLM can't
//! write through a shell command into a folder it would have been
//! denied via `write_file`.

use super::{CommandClass, ExtractedPath};

/// Extract file paths from a sub-command string.
pub(super) fn extract_paths_from_subcmd(
    subcmd: &str,
    cmd_class: CommandClass,
) -> Vec<ExtractedPath> {
    let needs_write = !matches!(cmd_class, CommandClass::ReadOnly);
    let tokens: Vec<&str> = subcmd.split_whitespace().collect();
    let mut paths = Vec::new();
    let mut i = 0;

    while i < tokens.len() {
        let t = tokens[i];

        // Redirect targets are always write paths
        if matches!(t, ">" | ">>" | "2>" | "2>>") {
            if i + 1 < tokens.len() {
                let target = tokens[i + 1];
                if looks_like_path(target) {
                    paths.push(ExtractedPath {
                        path: target.to_string(),
                        needs_write: true,
                    });
                }
                i += 2;
                continue;
            }
        }
        // >file (no space)
        if (t.starts_with('>') || t.starts_with("2>")) && t.len() > 1 {
            let target = t.trim_start_matches("2>").trim_start_matches('>');
            if looks_like_path(target) {
                paths.push(ExtractedPath {
                    path: target.to_string(),
                    needs_write: true,
                });
            }
            i += 1;
            continue;
        }

        // Regular arguments that look like paths
        if !t.starts_with('-') && looks_like_path(t) {
            paths.push(ExtractedPath {
                path: t.to_string(),
                needs_write,
            });
        }

        i += 1;
    }

    paths
}

/// Heuristic: does this token look like a file path?
pub(super) fn looks_like_path(token: &str) -> bool {
    // Skip URLs
    if token.starts_with("http://")
        || token.starts_with("https://")
        || token.starts_with("ftp://")
    {
        return false;
    }
    // Skip bare options that happen to contain /
    if token.starts_with('-') {
        return false;
    }
    // Must look path-like
    token.starts_with('/')
        || token.starts_with("~/")
        || token.starts_with("./")
        || token.starts_with("../")
        || token == "~"
        || token == "."
        || token == ".."
}
