/// Git write tools: commit, branch, diff, log, status.

pub(super) fn definitions() -> Vec<super::ToolDefinition> {
    vec![
        super::tool_def(
            "git_commit",
            "Create a git commit. Optionally stage specific files first. \
             If files are provided, runs `git add` on them before committing.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "message": { "type": "string", "description": "Commit message" },
                    "files": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Files to stage before committing. If omitted, commits whatever is already staged."
                    }
                },
                "required": ["message"]
            }),
        ),
        super::tool_def(
            "git_create_branch",
            "Create a new git branch. Optionally check it out immediately.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Branch name to create" },
                    "checkout": { "type": "boolean", "description": "Check out the new branch after creation. Default false." }
                },
                "required": ["name"]
            }),
        ),
        super::tool_def(
            "git_diff",
            "Show git diff output. Use staged=true to see staged changes (--staged).",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "staged": { "type": "boolean", "description": "Show staged changes only (git diff --staged). Default false." }
                }
            }),
        ),
        super::tool_def(
            "git_log",
            "Show recent git log in oneline format.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "count": { "type": "integer", "description": "Number of commits to show. Default 10." }
                }
            }),
        ),
        super::tool_def(
            "git_status",
            "Show git status in short format.",
            serde_json::json!({
                "type": "object",
                "properties": {}
            }),
        ),
    ]
}

/// Run a git command in the effective workspace directory.
async fn run_git(args_list: &[&str]) -> Result<String, String> {
    let cwd = super::get_effective_workspace();
    let output = tokio::process::Command::new("git")
        .args(args_list)
        .current_dir(&cwd)
        .output()
        .await
        .map_err(|e| format!("Failed to run git: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        if stdout.is_empty() && !stderr.is_empty() {
            // Some git commands write informational output to stderr
            Ok(stderr)
        } else {
            Ok(stdout)
        }
    } else {
        Err(format!(
            "git {} failed (exit {}):\n{}{}",
            args_list.first().unwrap_or(&""),
            output.status.code().unwrap_or(-1),
            stderr,
            if !stdout.is_empty() { format!("\n{}", stdout) } else { String::new() }
        ))
    }
}

pub(super) async fn git_commit_tool(args: &serde_json::Value) -> String {
    let message = match args["message"].as_str() {
        Some(m) if !m.is_empty() => m,
        _ => return "Error: message is required".into(),
    };

    // Stage files if provided
    if let Some(files) = args["files"].as_array() {
        let file_paths: Vec<&str> = files
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        if !file_paths.is_empty() {
            // Validate each file path against access control
            for path in &file_paths {
                if let Err(e) = super::access_check(path, false).await {
                    return format!("Error: file path '{}' not authorized: {}", path, e);
                }
            }
            let mut add_args = vec!["add", "--"];
            add_args.extend(file_paths.iter());
            if let Err(e) = run_git(&add_args).await {
                return format!("Error staging files: {}", e);
            }
        }
    }

    match run_git(&["commit", "-m", message]).await {
        Ok(output) => super::truncate_output(&output, 5000),
        Err(e) => e,
    }
}

pub(super) async fn git_create_branch_tool(args: &serde_json::Value) -> String {
    let name = match args["name"].as_str() {
        Some(n) if !n.is_empty() => n,
        _ => return "Error: name is required".into(),
    };
    let checkout = args["checkout"].as_bool().unwrap_or(false);

    if checkout {
        match run_git(&["checkout", "-b", name]).await {
            Ok(output) => {
                if output.is_empty() {
                    format!("Created and checked out branch '{}'", name)
                } else {
                    output
                }
            }
            Err(e) => e,
        }
    } else {
        match run_git(&["branch", name]).await {
            Ok(output) => {
                if output.is_empty() {
                    format!("Created branch '{}'", name)
                } else {
                    output
                }
            }
            Err(e) => e,
        }
    }
}

pub(super) async fn git_diff_tool(args: &serde_json::Value) -> String {
    let staged = args["staged"].as_bool().unwrap_or(false);

    let result = if staged {
        run_git(&["diff", "--staged"]).await
    } else {
        run_git(&["diff"]).await
    };

    match result {
        Ok(output) => {
            if output.is_empty() {
                "No changes.".into()
            } else {
                super::truncate_output(&output, 30000)
            }
        }
        Err(e) => e,
    }
}

pub(super) async fn git_log_tool(args: &serde_json::Value) -> String {
    let count = args["count"].as_u64().unwrap_or(10);
    let count_str = format!("-n{}", count);

    match run_git(&["log", "--oneline", &count_str]).await {
        Ok(output) => {
            if output.is_empty() {
                "No commits found.".into()
            } else {
                super::truncate_output(&output, 10000)
            }
        }
        Err(e) => e,
    }
}

pub(super) async fn git_status_tool(_args: &serde_json::Value) -> String {
    match run_git(&["status", "--short"]).await {
        Ok(output) => {
            if output.is_empty() {
                "Working tree clean.".into()
            } else {
                super::truncate_output(&output, 10000)
            }
        }
        Err(e) => e,
    }
}
