use std::process::Stdio;

/// File I/O tool definitions.
pub(super) fn definitions() -> Vec<super::ToolDefinition> {
    vec![
        super::tool_def(
            "read_file",
            "Read the contents of a file with line numbers. Supports offset/limit for large files. \
            Always read a file before editing it.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to the file" },
                    "offset": { "type": "integer", "description": "Start reading from this line number (1-based). Default: 1" },
                    "limit": { "type": "integer", "description": "Maximum number of lines to read. Default: reads up to 2000 lines." }
                },
                "required": ["path"]
            }),
        ),
        super::tool_def(
            "write_file",
            "Write content to a file (full overwrite). Creates the file if it doesn't exist. \
            Prefer edit_file for modifying existing files. Only use write_file for new files or complete rewrites.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to the file" },
                    "content": { "type": "string", "description": "Content to write" }
                },
                "required": ["path", "content"]
            }),
        ),
        super::tool_def(
            "edit_file",
            "Perform exact string replacement in a file. The old_text must be unique in the file — \
            if it matches multiple locations the edit will FAIL. Provide more surrounding context to make it unique. \
            Set replace_all=true to replace every occurrence. Always read_file before editing.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to the file" },
                    "old_text": { "type": "string", "description": "Exact text to find. Must be unique in the file unless replace_all is true." },
                    "new_text": { "type": "string", "description": "Replacement text (must differ from old_text)" },
                    "replace_all": { "type": "boolean", "description": "Replace all occurrences instead of requiring uniqueness. Default false." }
                },
                "required": ["path", "old_text", "new_text"]
            }),
        ),
        super::tool_def(
            "append_file",
            "Append content to the end of a file.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to the file" },
                    "content": { "type": "string", "description": "Content to append" }
                },
                "required": ["path", "content"]
            }),
        ),
        super::tool_def(
            "delete_file",
            "Delete a file or directory. Use this instead of 'rm' in shell commands for safety.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to the file or directory to delete" },
                    "recursive": { "type": "boolean", "description": "If true, delete directory and all contents (like rm -rf). Default false." }
                },
                "required": ["path"]
            }),
        ),
        super::tool_def(
            "undo_edit",
            "Undo the last edit to a file by restoring from backup. Use when an edit introduced errors.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to the file to restore" }
                },
                "required": ["path"]
            }),
        ),
        super::tool_def(
            "list_directory",
            "List files and directories in a given path.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Directory path to list" }
                },
                "required": ["path"]
            }),
        ),
        super::tool_def(
            "project_tree",
            "Show the file tree of a project workspace. Cached for 60s. \
             Use this FIRST when working on an unfamiliar project to understand its structure.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Project root directory" }
                },
                "required": ["path"]
            }),
        ),
        super::tool_def(
            "grep_search",
            "Search for a regex pattern in files recursively. Uses ripgrep when available for speed. \
            Returns matching lines with file paths and line numbers.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "Search pattern (regex supported)" },
                    "path": { "type": "string", "description": "Directory or file to search in" },
                    "file_pattern": { "type": "string", "description": "File glob filter, e.g. '*.ts'" },
                    "max_results": { "type": "integer", "description": "Max matching lines to return. Default 50." },
                    "context_lines": { "type": "integer", "description": "Lines of context before and after each match (like grep -C). Default 0." },
                    "case_insensitive": { "type": "boolean", "description": "Case insensitive search. Default false." }
                },
                "required": ["pattern", "path"]
            }),
        ),
        super::tool_def(
            "glob_search",
            "Find files matching a glob pattern recursively.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "Glob pattern, e.g. '**/*.rs'" },
                    "path": { "type": "string", "description": "Base directory to search from" }
                },
                "required": ["pattern", "path"]
            }),
        ),
    ]
}

pub(super) async fn read_file_tool(args: &serde_json::Value) -> String {
    let path = args["path"].as_str().unwrap_or("");
    if path.is_empty() {
        return "Error: path is required".into();
    }
    if let Err(e) = super::access_check(path, false).await {
        return format!("Error: {}", e);
    }
    // Reject files larger than 10MB to prevent OOM
    match tokio::fs::metadata(path).await {
        Ok(meta) => {
            let size = meta.len();
            if size > 10 * 1024 * 1024 {
                return format!(
                    "Error: file is too large ({:.1} MB). Use grep_search or execute_shell with head/tail for large files.",
                    size as f64 / 1024.0 / 1024.0
                );
            }
        }
        Err(e) => return format!("Error: {}", e),
    }

    // Reject binary files (NUL byte detection in first 8KB)
    if let Ok(mut f) = tokio::fs::File::open(path).await {
        use tokio::io::AsyncReadExt;
        let mut probe = vec![0u8; 8192];
        if let Ok(n) = f.read(&mut probe).await {
            if probe[..n].contains(&0) {
                return format!("Error: '{}' appears to be a binary file. Use execute_shell to inspect binary files.", path);
            }
        }
    }

    let offset = args["offset"].as_u64().unwrap_or(1).max(1) as usize;
    let limit = args["limit"].as_u64().unwrap_or(2000) as usize;

    // Use BufReader to avoid reading entire file into memory
    match tokio::fs::File::open(path).await {
        Ok(file) => {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let reader = BufReader::new(file);
            let mut lines_iter = reader.lines();
            let start = offset - 1;
            let mut line_num = 0usize;
            let mut selected: Vec<String> = Vec::with_capacity(limit);

            // Skip to offset
            while line_num < start {
                match lines_iter.next_line().await {
                    Ok(Some(_)) => line_num += 1,
                    Ok(None) => break,
                    Err(e) => return format!("Error reading file: {}", e),
                }
            }

            // Read `limit` lines
            while selected.len() < limit {
                match lines_iter.next_line().await {
                    Ok(Some(line)) => {
                        line_num += 1;
                        selected.push(line);
                    }
                    Ok(None) => break,
                    Err(e) => return format!("Error reading file: {}", e),
                }
            }

            // Count remaining lines for total
            let mut total = line_num;
            loop {
                match lines_iter.next_line().await {
                    Ok(Some(_)) => total += 1,
                    _ => break,
                }
            }

            if selected.is_empty() {
                return format!("(empty file or offset {} beyond {} total lines)", offset, total);
            }

            let end = start + selected.len();
            let width = format!("{}", end).len();
            let mut result = String::with_capacity(selected.len() * 80);
            for (i, line) in selected.iter().enumerate() {
                let ln = start + i + 1;
                result.push_str(&format!("{:>width$}\t{}\n", ln, line, width = width));
            }

            if end < total {
                result.push_str(&format!("\n({} total lines, showing {}-{})", total, offset, end));
            }

            super::truncate_output(&result, 30000)
        }
        Err(e) => format!("Error reading file: {}", e),
    }
}

pub(super) async fn write_file_tool(args: &serde_json::Value) -> String {
    let path = args["path"].as_str().unwrap_or("");
    let content = args["content"].as_str().unwrap_or("");
    if path.is_empty() {
        return "Error: path is required".into();
    }
    if let Err(e) = super::access_check(path, true).await {
        return format!("Error: {}", e);
    }
    if let Some(parent) = std::path::Path::new(path).parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }
    // Read original content for diff (if file exists)
    let original = tokio::fs::read_to_string(path).await.ok();
    let is_create = original.is_none();

    match tokio::fs::write(path, content).await {
        Ok(_) => {
            // Auto-register scripts in code library
            let script_exts = [".py", ".js", ".ts", ".sh", ".bash", ".rb", ".pl"];
            let is_script = script_exts.iter().any(|ext| path.ends_with(ext));
            if is_script {
                if let Some(db) = super::DATABASE.get() {
                    let stem = std::path::Path::new(path)
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("unnamed");
                    let lang = if path.ends_with(".py") { "python" }
                        else if path.ends_with(".js") || path.ends_with(".ts") { "javascript" }
                        else if path.ends_with(".sh") || path.ends_with(".bash") { "bash" }
                        else { "other" };
                    let desc = content.lines()
                        .find(|l| l.starts_with('#') || l.starts_with("//") || l.starts_with("\"\"\""))
                        .map(|l| l.trim_matches(['#', '/', ' ', '"', '!', '\'']).trim().to_string())
                        .filter(|d| d.len() > 5)
                        .unwrap_or_else(|| format!("Script: {}", stem));
                    db.register_code(stem, path, &desc, lang, None, None).ok();
                }
            }

            // Generate structured diff for AI perception
            let kind = if is_create { "created" } else { "updated" };
            let diff = generate_diff(original.as_deref().unwrap_or(""), content, path);
            let mut result = format!("File {} ({}, {} bytes).\n\n{}", path, kind, content.len(), diff);

            // Auto-test: run project checks after write
            if let Some(test_result) = crate::engine::coding::auto_test::run_auto_test(path).await {
                result.push_str(&crate::engine::coding::auto_test::format_test_result(&test_result));
            }

            result
        }
        Err(e) => format!("Error writing file: {}", e),
    }
}

pub(super) async fn edit_file_tool(args: &serde_json::Value) -> String {
    let path = args["path"].as_str().unwrap_or("");
    let old_text = args["old_text"].as_str().unwrap_or("");
    let new_text = args["new_text"].as_str().unwrap_or("");
    let replace_all = args["replace_all"].as_bool().unwrap_or(false);

    if path.is_empty() || old_text.is_empty() {
        return "Error: path and old_text are required".into();
    }
    if old_text == new_text {
        return "Error: new_text must be different from old_text".into();
    }
    if let Err(e) = super::access_check(path, true).await {
        return format!("Error: {}", e);
    }

    match tokio::fs::read_to_string(path).await {
        Ok(content) => {
            let match_count = content.matches(old_text).count();
            if match_count == 0 {
                return format!("Error: old_text not found in {}. Read the file first to get the exact text.", path);
            }
            if !replace_all && match_count > 1 {
                return format!(
                    "Error: old_text matches {} locations in {}. Provide more surrounding context to make it unique, or set replace_all=true.",
                    match_count, path
                );
            }
            // Create backup in ~/.yiyi/backups/ (not next to source file)
            if let Some(home) = dirs::home_dir() {
                let backup_dir = home.join(".yiyi").join("backups");
                tokio::fs::create_dir_all(&backup_dir).await.ok();
                // Encode path as filename: replace / with __
                let safe_name = path.replace(['/', '\\'], "__");
                let backup_path = backup_dir.join(format!("{}.backup", safe_name));
                if let Err(e) = tokio::fs::write(&backup_path, &content).await {
                    log::warn!("Failed to create backup for {}: {}", path, e);
                }
            }
            let new_content = if replace_all {
                content.replace(old_text, new_text)
            } else {
                content.replacen(old_text, new_text, 1)
            };
            match tokio::fs::write(path, &new_content).await {
                Ok(_) => {
                    // Generate structured diff so the AI can see exactly what changed
                    let diff = generate_diff(&content, &new_content, path);
                    let replace_info = if replace_all && match_count > 1 {
                        format!(" ({} replacements)", match_count)
                    } else {
                        String::new()
                    };
                    let mut result = format!("Edited {}{}\n\n{}", path, replace_info, diff);

                    // Auto-test: run project checks after edit
                    if let Some(test_result) = crate::engine::coding::auto_test::run_auto_test(path).await {
                        result.push_str(&crate::engine::coding::auto_test::format_test_result(&test_result));
                    }

                    result
                }
                Err(e) => format!("Error writing: {}", e),
            }
        }
        Err(e) => format!("Error reading: {}", e),
    }
}

pub(super) async fn append_file_tool(args: &serde_json::Value) -> String {
    let path = args["path"].as_str().unwrap_or("");
    let content = args["content"].as_str().unwrap_or("");

    if path.is_empty() {
        return "Error: path is required".into();
    }
    if let Err(e) = super::access_check(path, true).await {
        return format!("Error: {}", e);
    }

    use tokio::io::AsyncWriteExt;
    match tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await
    {
        Ok(mut file) => match file.write_all(content.as_bytes()).await {
            Ok(_) => format!("Appended {} bytes to {}", content.len(), path),
            Err(e) => format!("Error appending: {}", e),
        },
        Err(e) => format!("Error opening file: {}", e),
    }
}

pub(super) async fn delete_file_tool(args: &serde_json::Value) -> String {
    let path = args["path"].as_str().unwrap_or("");
    let recursive = args["recursive"].as_bool().unwrap_or(false);

    if path.is_empty() {
        return "Error: path is required".into();
    }

    // Access check — verify path is in authorized folders
    if let Err(e) = super::access_check(path, true).await {
        return format!("Error: {}", e);
    }

    let resolved = super::resolve_path(path);

    // Safety: block deletion of critical system paths
    let blocked = ["/", "/usr", "/bin", "/sbin", "/etc", "/var", "/tmp", "/System", "/Library", "/Applications"];
    let resolved_str = resolved.to_string_lossy();
    for b in &blocked {
        if resolved_str == *b {
            return format!("Error: refusing to delete system path '{}'", b);
        }
    }

    // Check existence
    let metadata = match tokio::fs::metadata(&resolved).await {
        Ok(m) => m,
        Err(e) => return format!("Error: '{}' not found: {}", path, e),
    };

    if metadata.is_dir() {
        if !recursive {
            return format!(
                "Error: '{}' is a directory. Set recursive=true to delete it and all its contents.",
                path
            );
        }
        match tokio::fs::remove_dir_all(&resolved).await {
            Ok(_) => format!("Deleted directory '{}'", path),
            Err(e) => format!("Error deleting directory: {}", e),
        }
    } else {
        match tokio::fs::remove_file(&resolved).await {
            Ok(_) => format!("Deleted file '{}'", path),
            Err(e) => format!("Error deleting file: {}", e),
        }
    }
}

pub(super) async fn project_tree_tool(args: &serde_json::Value) -> String {
    let path = args["path"].as_str().unwrap_or(".");
    if let Err(e) = super::access_check(path, false).await {
        return format!("Error: {}", e);
    }
    let workspace = std::path::Path::new(path);
    if !workspace.is_dir() {
        return format!("Error: '{}' is not a directory", path);
    }

    let tree = crate::engine::coding::project_tree::get_project_tree(workspace);

    // Also detect project type and show info
    let info = crate::engine::coding::project_detect::detect_project(workspace);
    let project_info = crate::engine::coding::project_detect::project_summary(&info);

    format!("{}\n\n{}", project_info, tree)
}

pub(super) async fn undo_edit_tool(args: &serde_json::Value) -> String {
    let path = args["path"].as_str().unwrap_or("");
    if path.is_empty() {
        return "Error: path is required".into();
    }

    let safe_name = path.replace(['/', '\\'], "__");
    let backup_path = dirs::home_dir()
        .unwrap_or_default()
        .join(".yiyi")
        .join("backups")
        .join(format!("{}.backup", safe_name));

    if !backup_path.exists() {
        return format!("Error: no backup found for {}. Backups are created automatically when edit_file is used.", path);
    }

    match tokio::fs::read_to_string(&backup_path).await {
        Ok(backup_content) => {
            // Read current content for diff
            let current = tokio::fs::read_to_string(path).await.unwrap_or_default();

            match tokio::fs::write(path, &backup_content).await {
                Ok(_) => {
                    let diff = generate_diff(&current, &backup_content, path);
                    format!("Restored {} from backup.\n\n{}", path, diff)
                }
                Err(e) => format!("Error restoring: {}", e),
            }
        }
        Err(e) => format!("Error reading backup: {}", e),
    }
}

pub(super) async fn list_directory_tool(args: &serde_json::Value) -> String {
    let path = args["path"].as_str().unwrap_or(".");
    if let Err(e) = super::access_check(path, false).await {
        return format!("Error: {}", e);
    }

    match tokio::fs::read_dir(path).await {
        Ok(mut entries) => {
            let mut items = Vec::new();
            while let Ok(Some(entry)) = entries.next_entry().await {
                let name = entry.file_name().to_string_lossy().to_string();
                let meta = entry.metadata().await.ok();
                let is_dir = meta.as_ref().map_or(false, |m| m.is_dir());
                let size = meta.as_ref().map_or(0, |m| m.len());
                if is_dir {
                    items.push(format!("  [DIR] {}/", name));
                } else {
                    items.push(format!("  {} ({} bytes)", name, size));
                }
            }
            if items.is_empty() {
                format!("{}: (empty)", path)
            } else {
                format!("{}:\n{}", path, items.join("\n"))
            }
        }
        Err(e) => format!("Error: {}", e),
    }
}

/// Check if ripgrep (rg) is available on the system.
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

pub(super) async fn grep_search_tool(args: &serde_json::Value) -> String {
    let pattern = args["pattern"].as_str().unwrap_or("");
    let path = args["path"].as_str().unwrap_or(".");
    let file_pattern = args["file_pattern"].as_str();
    let max_results = args["max_results"].as_u64().unwrap_or(50) as usize;
    let context_lines = args["context_lines"].as_u64().unwrap_or(0);
    let case_insensitive = args["case_insensitive"].as_bool().unwrap_or(false);

    if pattern.is_empty() {
        return "Error: pattern is required".into();
    }
    if let Err(e) = super::access_check(path, false).await {
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
                return grep_pure_rust(pattern, path, file_pattern, max_results, case_insensitive).await;
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
    let shown = lines.into_iter().take(max_results).collect::<Vec<_>>().join("\n");
    if total > max_results {
        format!("{}\n\n({} total matches, showing first {})", shown, total, max_results)
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
        "node_modules", ".git", "target", "dist", "build", ".next",
        "__pycache__", ".venv", "venv", ".tox", "vendor", ".bundle",
        ".gradle", ".idea", ".vscode", "coverage",
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
        let skip_exts = ["png", "jpg", "jpeg", "gif", "bmp", "ico", "woff", "woff2",
                         "ttf", "eot", "mp3", "mp4", "zip", "gz", "tar", "exe", "dll",
                         "so", "dylib", "o", "a", "class", "pyc", "wasm"];
        if skip_exts.contains(&ext.to_lowercase().as_str()) {
            continue;
        }
        if let Ok(content) = tokio::fs::read_to_string(&entry).await {
            for (line_num, line) in content.lines().enumerate() {
                if re.is_match(line) {
                    results.push(format!("{}:{}:{}", entry.display(), line_num + 1, line));
                    if results.len() >= max_results {
                        let total_hint = format!("\n\n(reached {} result limit, may have more matches)", max_results);
                        return results.join("\n") + &total_hint;
                    }
                }
            }
        }
    }

    let install_hint = "\n\nTip: install ripgrep for much faster search — https://github.com/BurntSushi/ripgrep#installation";
    if results.is_empty() {
        format!("No matches found for '{}' in {}{}", pattern, search_path, install_hint)
    } else {
        format!("{}{}", results.join("\n"), install_hint)
    }
}

pub(super) async fn glob_search_tool(args: &serde_json::Value) -> String {
    let pattern = args["pattern"].as_str().unwrap_or("");
    let path = args["path"].as_str().unwrap_or(".");

    if pattern.is_empty() {
        return "Error: pattern is required".into();
    }
    if let Err(e) = super::access_check(path, false).await {
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

// ── Structured diff generation ──────────────────────────────────────────

/// Generate a unified diff between old and new content for AI perception.
/// Shows exactly what lines changed with context, so the LLM understands
/// the spatial impact of its edits.
fn generate_diff(old: &str, new: &str, path: &str) -> String {
    let old_lines: Vec<&str> = old.lines().collect();
    let new_lines: Vec<&str> = new.lines().collect();

    if old_lines == new_lines {
        return "No changes.".into();
    }

    // For small files or complete rewrites, show summary only
    if old.is_empty() {
        return format!("New file with {} lines.", new_lines.len());
    }
    if new.is_empty() {
        return format!("File cleared (was {} lines).", old_lines.len());
    }

    // Generate simplified unified diff (context = 3 lines)
    let mut hunks: Vec<String> = Vec::new();
    let mut i = 0;
    let mut j = 0;
    let context = 3;

    while i < old_lines.len() || j < new_lines.len() {
        // Skip matching lines
        if i < old_lines.len() && j < new_lines.len() && old_lines[i] == new_lines[j] {
            i += 1;
            j += 1;
            continue;
        }

        // Found a difference — collect the hunk
        let hunk_start_i = i.saturating_sub(context);
        let hunk_start_j = j.saturating_sub(context);

        let mut hunk = format!("@@ -{},{} +{},{} @@\n",
            hunk_start_i + 1, 0, // line counts filled later
            hunk_start_j + 1, 0,
        );

        // Context before
        let ctx_start = i.saturating_sub(context);
        for k in ctx_start..i {
            if k < old_lines.len() {
                hunk.push_str(&format!(" {}\n", old_lines[k]));
            }
        }

        // Changed lines: find end of difference
        let diff_start_i = i;
        let diff_start_j = j;
        while i < old_lines.len() && j < new_lines.len() && old_lines[i] != new_lines[j] {
            i += 1;
            j += 1;
        }
        // Handle length differences
        while i < old_lines.len() && (j >= new_lines.len() || (i < old_lines.len() && j < new_lines.len() && old_lines[i] != new_lines[j])) {
            i += 1;
        }
        while j < new_lines.len() && (i >= old_lines.len() || (i < old_lines.len() && j < new_lines.len() && old_lines[i] != new_lines[j])) {
            j += 1;
        }

        for k in diff_start_i..i.min(old_lines.len()) {
            hunk.push_str(&format!("-{}\n", old_lines[k]));
        }
        for k in diff_start_j..j.min(new_lines.len()) {
            hunk.push_str(&format!("+{}\n", new_lines[k]));
        }

        // Context after
        for k in i..i.saturating_add(context).min(old_lines.len()) {
            hunk.push_str(&format!(" {}\n", old_lines[k]));
        }

        hunks.push(hunk);

        // Skip ahead past context
        i = i.saturating_add(context).min(old_lines.len());
        j = j.saturating_add(context).min(new_lines.len());

        // Limit hunks to prevent giant diffs
        if hunks.len() >= 10 {
            hunks.push("... (diff truncated, more changes follow)".into());
            break;
        }
    }

    if hunks.is_empty() {
        // Fallback: show line count change
        return format!("Changed: {} → {} lines", old_lines.len(), new_lines.len());
    }

    let header = format!("--- a/{}\n+++ b/{}\n", path, path);
    format!("```diff\n{}{}\n```", header, hunks.join("\n"))
}
