//! Code search — `grep_search` (regex) and `glob_search` (filename pattern).
//!
//! `grep_search` prefers ripgrep when available (much faster on large repos),
//! falls back to system grep, and finally falls back to a pure-Rust scanner
//! so Windows / minimal Linux installs without grep still work. The
//! pure-Rust path emits an install hint pointing users at ripgrep — it's
//! the right answer for everyone here.

use std::process::Stdio;

/// Check if ripgrep (rg) is available on the system. Result cached for the
/// process lifetime.
static RG_AVAILABLE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
fn is_rg_available() -> bool {
    *RG_AVAILABLE.get_or_init(|| {
        std::process::Command::new("rg")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    })
}

pub(crate) async fn grep_search_tool(args: &serde_json::Value) -> String {
    let pattern = args["pattern"].as_str().unwrap_or("");
    let path = args["path"].as_str().unwrap_or(".");
    let file_pattern = args["file_pattern"].as_str();
    let max_results = args["max_results"].as_u64().unwrap_or(50) as usize;
    let context_lines = args["context_lines"].as_u64().unwrap_or(0);
    let case_insensitive = args["case_insensitive"].as_bool().unwrap_or(false);

    if pattern.is_empty() {
        return "Error: pattern is required".into();
    }
    if let Err(e) = super::super::access_check(path, false).await {
        return format!("Error: {}", e);
    }

    // Prefer ripgrep for speed, fall back to grep
    let use_rg = is_rg_available();
    let mut cmd = if use_rg {
        let mut c = tokio::process::Command::new("rg");
        c.arg("-n"); // line numbers
        if let Some(fp) = file_pattern {
            c.arg("--glob").arg(fp);
        }
        if case_insensitive {
            c.arg("-i");
        }
        if context_lines > 0 {
            c.arg("-C").arg(context_lines.to_string());
        }
        c.arg("--max-count").arg("1000"); // safety cap per file
        c.arg("--").arg(pattern).arg(path);
        c
    } else {
        // No rg available — try system grep, fall back to pure-Rust search
        let mut c = tokio::process::Command::new("grep");
        c.arg("-rn");
        if let Some(fp) = file_pattern {
            c.arg(format!("--include={}", fp));
        }
        if case_insensitive {
            c.arg("-i");
        }
        if context_lines > 0 {
            c.arg(format!("-C{}", context_lines));
        }
        c.arg("--").arg(pattern).arg(path);
        c.stdout(Stdio::piped());
        c.stderr(Stdio::piped());

        match c.output().await {
            Ok(output) if output.status.success() || !output.stdout.is_empty() => {
                // grep worked, format output
                let stdout = String::from_utf8_lossy(&output.stdout);
                return format_grep_output(&stdout, max_results);
            }
            Ok(output) if output.status.code() == Some(1) => {
                // grep ran but found no matches
                return format!("No matches found for '{}' in {}", pattern, path);
            }
            _ => {
                // grep not available (Windows) — pure Rust fallback
                return grep_pure_rust(pattern, path, file_pattern, max_results, case_insensitive)
                    .await;
            }
        }
    };

    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    match cmd.output().await {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if stdout.is_empty() {
                return format!("No matches found for '{}' in {}", pattern, path);
            }
            format_grep_output(&stdout, max_results)
        }
        Err(e) => format!("Error: {}", e),
    }
}

fn format_grep_output(stdout: &str, max_results: usize) -> String {
    if stdout.is_empty() {
        return "(no matches)".into();
    }
    let lines: Vec<&str> = stdout.lines().collect();
    let total = lines.len();
    let shown = lines
        .into_iter()
        .take(max_results)
        .collect::<Vec<_>>()
        .join("\n");
    if total > max_results {
        format!(
            "{}\n\n({} total matches, showing first {})",
            shown, total, max_results
        )
    } else {
        shown
    }
}

/// Pure-Rust grep fallback when neither rg nor grep is available (e.g. Windows without rg).
async fn grep_pure_rust(
    pattern: &str,
    search_path: &str,
    file_pattern: Option<&str>,
    max_results: usize,
    case_insensitive: bool,
) -> String {
    let regex_pattern = if case_insensitive {
        format!("(?i){}", pattern)
    } else {
        pattern.to_string()
    };
    let re = match regex::Regex::new(&regex_pattern) {
        Ok(r) => r,
        Err(e) => return format!("Invalid regex pattern: {}", e),
    };

    let glob_pat = if let Some(fp) = file_pattern {
        format!("{}/**/{}", search_path, fp)
    } else {
        format!("{}/**/*", search_path)
    };

    let mut results = Vec::new();
    let entries = match glob::glob(&glob_pat) {
        Ok(e) => e,
        Err(e) => return format!("Error: {}", e),
    };

    // Directories to skip (mimic ripgrep's default ignores)
    let skip_dirs = [
        "node_modules",
        ".git",
        "target",
        "dist",
        "build",
        ".next",
        "__pycache__",
        ".venv",
        "venv",
        ".tox",
        "vendor",
        ".bundle",
        ".gradle",
        ".idea",
        ".vscode",
        "coverage",
    ];

    for entry in entries.flatten() {
        if !entry.is_file() {
            continue;
        }
        // Skip known large/generated directories
        let path_str = entry.to_string_lossy();
        if skip_dirs.iter().any(|d| {
            path_str.contains(&format!("/{}/", d)) || path_str.contains(&format!("\\{}\\", d))
        }) {
            continue;
        }
        // Skip binary files by checking extension
        let ext = entry.extension().and_then(|e| e.to_str()).unwrap_or("");
        let skip_exts = [
            "png", "jpg", "jpeg", "gif", "bmp", "ico", "woff", "woff2", "ttf", "eot", "mp3",
            "mp4", "zip", "gz", "tar", "exe", "dll", "so", "dylib", "o", "a", "class", "pyc",
            "wasm",
        ];
        if skip_exts.contains(&ext.to_lowercase().as_str()) {
            continue;
        }
        if let Ok(content) = tokio::fs::read_to_string(&entry).await {
            for (line_num, line) in content.lines().enumerate() {
                if re.is_match(line) {
                    results.push(format!("{}:{}:{}", entry.display(), line_num + 1, line));
                    if results.len() >= max_results {
                        let total_hint = format!(
                            "\n\n(reached {} result limit, may have more matches)",
                            max_results
                        );
                        return results.join("\n") + &total_hint;
                    }
                }
            }
        }
    }

    let install_hint = "\n\nTip: install ripgrep for much faster search — https://github.com/BurntSushi/ripgrep#installation";
    if results.is_empty() {
        format!(
            "No matches found for '{}' in {}{}",
            pattern, search_path, install_hint
        )
    } else {
        format!("{}{}", results.join("\n"), install_hint)
    }
}

pub(crate) async fn glob_search_tool(args: &serde_json::Value) -> String {
    let pattern = args["pattern"].as_str().unwrap_or("");
    let path = args["path"].as_str().unwrap_or(".");

    if pattern.is_empty() {
        return "Error: pattern is required".into();
    }
    if let Err(e) = super::super::access_check(path, false).await {
        return format!("Error: {}", e);
    }

    let full_pattern = format!("{}/{}", path, pattern);
    match glob::glob(&full_pattern) {
        Ok(paths) => {
            let mut results = Vec::new();
            for entry in paths.flatten() {
                results.push(entry.to_string_lossy().to_string());
                if results.len() >= 200 {
                    results.push("...(truncated at 200 results)".into());
                    break;
                }
            }
            if results.is_empty() {
                format!("No files found matching '{}' in {}", pattern, path)
            } else {
                results.join("\n")
            }
        }
        Err(e) => format!("Invalid glob pattern: {}", e),
    }
}
