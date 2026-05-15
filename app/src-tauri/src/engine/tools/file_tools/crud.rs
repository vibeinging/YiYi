//! The six CRUD tools — `read_file`, `write_file`, `edit_file`, `append_file`,
//! `delete_file`, `undo_edit`. Each enforces `access_check` (authorization),
//! threads through `backup_to_central` so a later `undo_edit` can roll back,
//! and emits a unified diff so the LLM can verify what it wrote.

use super::backup::{backup_slot_for, backup_to_central};
use super::diff::generate_diff;

pub(crate) async fn read_file_tool(args: &serde_json::Value) -> String {
    let path = args["path"].as_str().unwrap_or("");
    if path.is_empty() {
        return "Error: path is required".into();
    }
    if let Err(e) = super::super::access_check(path, false).await {
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
                return format!(
                    "Error: '{}' appears to be a binary file. Use execute_shell to inspect binary files.",
                    path
                );
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
                return format!(
                    "(empty file or offset {} beyond {} total lines)",
                    offset, total
                );
            }

            let end = start + selected.len();
            let width = format!("{}", end).len();
            let mut result = String::with_capacity(selected.len() * 80);
            for (i, line) in selected.iter().enumerate() {
                let ln = start + i + 1;
                result.push_str(&format!("{:>width$}\t{}\n", ln, line, width = width));
            }

            if end < total {
                result.push_str(&format!(
                    "\n({} total lines, showing {}-{})",
                    total, offset, end
                ));
            }

            super::super::file_state_mark_read(path);
            super::super::truncate_output(&result, 30000)
        }
        Err(e) => format!("Error reading file: {}", e),
    }
}

pub(crate) async fn write_file_tool(args: &serde_json::Value) -> String {
    let path = args["path"].as_str().unwrap_or("");
    let content = args["content"].as_str().unwrap_or("");
    if path.is_empty() {
        return "Error: path is required".into();
    }
    if let Err(e) = super::super::access_check(path, true).await {
        return format!("Error: {}", e);
    }
    if let Some(parent) = std::path::Path::new(path).parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }
    // Read original content for diff (if file exists)
    let original = tokio::fs::read_to_string(path).await.ok();

    // Enforce read-before-write for existing files (new file creation is OK)
    if original.is_some() && !super::super::file_state_was_read(path) {
        return format!(
            "Error: You must read_file '{}' before overwriting it. This ensures you have the current contents.",
            path
        );
    }
    let is_create = original.is_none();

    // Safety: warn if overwrite would shrink file by >50% (likely truncated LLM output)
    if let Some(ref orig) = original {
        let orig_len = orig.len();
        let new_len = content.len();
        if orig_len > 500 && new_len < orig_len / 2 {
            return format!(
                "Error: write_file would shrink '{}' from {} to {} bytes ({:.0}% reduction). \
                 This usually means the content was truncated. Use edit_file for partial changes instead of rewriting the entire file.",
                path,
                orig_len,
                new_len,
                (1.0 - new_len as f64 / orig_len as f64) * 100.0
            );
        }
    }

    // P2.1: route every pre-write snapshot through the central store so
    // `undo_edit` can roll write_file changes back the same way it rolls
    // edit_file changes back.
    if original.is_some() {
        let _ = backup_to_central(path).await;
    }

    match tokio::fs::write(path, content).await {
        Ok(_) => {
            // Auto-register scripts in code library
            let script_exts = [".py", ".js", ".ts", ".sh", ".bash", ".rb", ".pl"];
            let is_script = script_exts.iter().any(|ext| path.ends_with(ext));
            if is_script {
                if let Some(db) = super::super::DATABASE.get() {
                    let stem = std::path::Path::new(path)
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("unnamed");
                    let lang = if path.ends_with(".py") {
                        "python"
                    } else if path.ends_with(".js") || path.ends_with(".ts") {
                        "javascript"
                    } else if path.ends_with(".sh") || path.ends_with(".bash") {
                        "bash"
                    } else {
                        "other"
                    };
                    let desc = content
                        .lines()
                        .find(|l| l.starts_with('#') || l.starts_with("//") || l.starts_with("\"\"\""))
                        .map(|l| {
                            l.trim_matches(['#', '/', ' ', '"', '!', '\'']).trim().to_string()
                        })
                        .filter(|d| d.len() > 5)
                        .unwrap_or_else(|| format!("Script: {}", stem));
                    db.register_code(stem, path, &desc, lang, None, None).ok();
                }
            }

            // Generate structured diff for AI perception
            let kind = if is_create { "created" } else { "updated" };
            let diff = generate_diff(original.as_deref().unwrap_or(""), content, path);
            let mut result = format!(
                "File {} ({}, {} bytes).\n\n{}",
                path,
                kind,
                content.len(),
                diff
            );

            // Auto-test: run project checks after write
            if let Some(test_result) = crate::engine::coding::auto_test::run_auto_test(path).await {
                crate::engine::coding::auto_test::update_green_contract(&test_result);
                result.push_str(&crate::engine::coding::auto_test::format_test_result(&test_result));
            }

            result
        }
        Err(e) => format!("Error writing file: {}", e),
    }
}

pub(crate) async fn edit_file_tool(args: &serde_json::Value) -> String {
    let path = args["path"].as_str().unwrap_or("");
    let old_text = args["old_text"].as_str().unwrap_or("");
    let new_text = args["new_text"].as_str().unwrap_or("");
    let replace_all = args["replace_all"].as_bool().unwrap_or(false);

    if path.is_empty() || old_text.is_empty() {
        return "Error: path and old_text are required. You must provide: {\"path\": \"/absolute/path\", \"old_text\": \"exact text to find\", \"new_text\": \"replacement\"}. Read the file first with read_file to get the exact text.".into();
    }
    if old_text == new_text {
        return "Error: new_text must be different from old_text".into();
    }
    // Enforce read-before-edit
    if !super::super::file_state_was_read(path) {
        return format!(
            "Error: You must read_file '{}' before editing it. This ensures you have the current file contents.",
            path
        );
    }
    if let Err(e) = super::super::access_check(path, true).await {
        return format!("Error: {}", e);
    }

    match tokio::fs::read_to_string(path).await {
        Ok(content) => {
            let match_count = content.matches(old_text).count();
            if match_count == 0 {
                return format!(
                    "Error: old_text not found in {}. Read the file first to get the exact text.",
                    path
                );
            }
            if !replace_all && match_count > 1 {
                return format!(
                    "Error: old_text matches {} locations in {}. Provide more surrounding context to make it unique, or set replace_all=true.",
                    match_count, path
                );
            }
            // P2.1: same central backup slot as write_file / append_file /
            // delete_file — undo_edit reads from this single location.
            let _ = backup_to_central(path).await;
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
                    if let Some(test_result) =
                        crate::engine::coding::auto_test::run_auto_test(path).await
                    {
                        crate::engine::coding::auto_test::update_green_contract(&test_result);
                        result.push_str(&crate::engine::coding::auto_test::format_test_result(
                            &test_result,
                        ));
                    }

                    result
                }
                Err(e) => format!("Error writing: {}", e),
            }
        }
        Err(e) => format!("Error reading: {}", e),
    }
}

pub(crate) async fn append_file_tool(args: &serde_json::Value) -> String {
    let path = args["path"].as_str().unwrap_or("");
    let content = args["content"].as_str().unwrap_or("");

    if path.is_empty() {
        return "Error: path is required".into();
    }
    if let Err(e) = super::super::access_check(path, true).await {
        return format!("Error: {}", e);
    }

    // P2.1: snapshot pre-append contents so undo_edit can restore the file
    // to its state-before-this-append. No-op when path doesn't exist yet.
    let _ = backup_to_central(path).await;

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

pub(crate) async fn delete_file_tool(args: &serde_json::Value) -> String {
    let path = args["path"].as_str().unwrap_or("");
    let recursive = args["recursive"].as_bool().unwrap_or(false);

    if path.is_empty() {
        return "Error: path is required".into();
    }

    // Access check — verify path is in authorized folders
    if let Err(e) = super::super::access_check(path, true).await {
        return format!("Error: {}", e);
    }

    let resolved = super::super::resolve_path(path);

    // Safety: block deletion of critical system paths
    let blocked = [
        "/",
        "/usr",
        "/bin",
        "/sbin",
        "/etc",
        "/var",
        "/tmp",
        "/System",
        "/Library",
        "/Applications",
    ];
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
        // Directory deletion has no single-file backup analogue — the
        // turn-level checkpoint (engine::checkpoint) covers this case
        // via `restore` if the user reverts the whole turn.
        match tokio::fs::remove_dir_all(&resolved).await {
            Ok(_) => format!("Deleted directory '{}'", path),
            Err(e) => format!("Error deleting directory: {}", e),
        }
    } else {
        // P2.1: capture contents before deletion so undo_edit can
        // resurrect the file by writing the backup blob back.
        let _ = backup_to_central(path).await;
        match tokio::fs::remove_file(&resolved).await {
            Ok(_) => format!("Deleted file '{}'", path),
            Err(e) => format!("Error deleting file: {}", e),
        }
    }
}

pub(crate) async fn undo_edit_tool(args: &serde_json::Value) -> String {
    let path = args["path"].as_str().unwrap_or("");
    if path.is_empty() {
        return "Error: path is required".into();
    }

    let Some(backup_path) = backup_slot_for(path) else {
        return "Error: could not determine home directory for backup lookup".into();
    };

    if !backup_path.exists() {
        return format!(
            "Error: no backup found for {}. Backups are written automatically by \
             write_file / edit_file / append_file / delete_file — one per path, \
             single revision. Nothing to roll back here.",
            path
        );
    }

    let backup_content = match tokio::fs::read(&backup_path).await {
        Ok(b) => b,
        Err(e) => return format!("Error reading backup: {}", e),
    };

    // The path may not exist anymore (delete_file was the last tool to touch
    // it). Create parent dirs so the restore re-materialises the file.
    if let Some(parent) = std::path::Path::new(path).parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            return format!("Error preparing parent dir for restore: {}", e);
        }
    }

    let current_existed = tokio::fs::metadata(path).await.is_ok();
    let current_text = if current_existed {
        tokio::fs::read_to_string(path).await.unwrap_or_default()
    } else {
        String::new()
    };

    match tokio::fs::write(path, &backup_content).await {
        Ok(_) => {
            // Only emit a unified-style diff when both sides are UTF-8 text
            // (backups of binary files restore correctly but can't be
            // diff-printed).
            let backup_text = std::str::from_utf8(&backup_content).ok();
            match backup_text {
                Some(new_text) if current_existed => {
                    let diff = generate_diff(&current_text, new_text, path);
                    format!("Restored {} from backup.\n\n{}", path, diff)
                }
                Some(_) => format!(
                    "Restored {} from backup (file had been deleted; recreated with prior contents).",
                    path
                ),
                None => format!(
                    "Restored {} from backup ({} bytes of binary content).",
                    path,
                    backup_content.len()
                ),
            }
        }
        Err(e) => format!("Error restoring: {}", e),
    }
}
