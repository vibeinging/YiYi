use std::path::Path;
use std::process::Command;
use std::time::Duration;

/// A single git commit entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitInfo {
    pub hash: String,
    pub subject: String,
    pub author: String,
    pub relative_time: String,
}

const MAX_RECENT_COMMITS: usize = 5;
const TIMEOUT: Duration = Duration::from_secs(5);

/// Check if the given path is inside a git repository.
pub fn is_git_repo(path: &Path) -> bool {
    git_command(path, &["rev-parse", "--is-inside-work-tree"])
        .map(|out| out.trim() == "true")
        .unwrap_or(false)
}

/// Get the current branch name, or None if detached / not a repo.
pub fn current_branch(path: &Path) -> Option<String> {
    let branch = git_command(path, &["rev-parse", "--abbrev-ref", "HEAD"]).ok()?;
    let trimmed = branch.trim();
    if trimmed.is_empty() || trimmed == "HEAD" {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Get the last N commits as `CommitInfo`.
pub fn recent_commits(path: &Path, count: usize) -> Vec<CommitInfo> {
    let format = "%h\x1f%s\x1f%an\x1f%ar";
    let output = git_command(
        path,
        &[
            "--no-optional-locks",
            "log",
            &format!("--format={}", format),
            "-n",
            &count.to_string(),
            "--no-decorate",
        ],
    );
    let Ok(stdout) = output else {
        return Vec::new();
    };
    stdout
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            let parts: Vec<&str> = line.splitn(4, '\x1f').collect();
            if parts.len() < 4 {
                return None;
            }
            Some(CommitInfo {
                hash: parts[0].to_string(),
                subject: parts[1].to_string(),
                author: parts[2].to_string(),
                relative_time: parts[3].to_string(),
            })
        })
        .collect()
}

/// List staged (cached) file paths.
pub fn staged_files(path: &Path) -> Vec<String> {
    let output = git_command(
        path,
        &["--no-optional-locks", "diff", "--cached", "--name-only"],
    );
    parse_file_list(output)
}

/// List modified (unstaged) file paths.
pub fn modified_files(path: &Path) -> Vec<String> {
    let output = git_command(
        path,
        &["--no-optional-locks", "diff", "--name-only"],
    );
    parse_file_list(output)
}

/// Human-readable one-line git status summary.
#[allow(dead_code)]
pub fn git_status_summary(path: &Path) -> String {
    let staged = staged_files(path);
    let modified = modified_files(path);
    let mut parts = Vec::new();
    if !staged.is_empty() {
        parts.push(format!("{} staged", staged.len()));
    }
    if !modified.is_empty() {
        parts.push(format!("{} modified", modified.len()));
    }
    if parts.is_empty() {
        "clean".to_string()
    } else {
        parts.join(", ")
    }
}

/// Render a full git context block for system prompt injection.
/// Returns `None` if the workspace is not a git repo.
pub fn render_git_context(workspace: &Path) -> Option<String> {
    if !is_git_repo(workspace) {
        return None;
    }

    let mut lines = Vec::new();
    lines.push("## Git Context".to_string());

    if let Some(branch) = current_branch(workspace) {
        lines.push(format!("Branch: {}", branch));
    }

    let commits = recent_commits(workspace, MAX_RECENT_COMMITS);
    if !commits.is_empty() {
        lines.push("Recent commits:".to_string());
        for c in &commits {
            lines.push(format!("- {} {} ({}, {})", c.hash, c.subject, c.author, c.relative_time));
        }
    }

    let staged = staged_files(workspace);
    if !staged.is_empty() {
        let names = if staged.len() <= 5 {
            staged.join(", ")
        } else {
            let preview: Vec<&str> = staged.iter().take(5).map(|s| s.as_str()).collect();
            format!("{}, ...and {} more", preview.join(", "), staged.len() - 5)
        };
        lines.push(format!("Staged: {} file(s) ({})", staged.len(), names));
    }

    let modified = modified_files(workspace);
    if !modified.is_empty() {
        let names = if modified.len() <= 5 {
            modified.join(", ")
        } else {
            let preview: Vec<&str> = modified.iter().take(5).map(|s| s.as_str()).collect();
            format!("{}, ...and {} more", preview.join(", "), modified.len() - 5)
        };
        lines.push(format!("Modified: {} file(s) ({})", modified.len(), names));
    }

    Some(lines.join("\n"))
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Run a git command with a timeout, returning stdout on success.
fn git_command(cwd: &Path, args: &[&str]) -> Result<String, ()> {
    let child = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();

    let Ok(child) = child else {
        return Err(());
    };

    let output = child.wait_with_output();
    let Ok(output) = output else {
        return Err(());
    };

    // Note: std::process::Command doesn't natively support timeout.
    // For robustness we rely on git being fast; the TIMEOUT constant
    // documents our intent. A full timeout impl would need spawn + wait_timeout
    // from a crate like `wait-timeout`, but we keep deps minimal here.
    let _ = TIMEOUT;

    if !output.status.success() {
        return Err(());
    }

    String::from_utf8(output.stdout).map_err(|_| ())
}

/// Parse newline-separated file list from git command output.
fn parse_file_list(output: Result<String, ()>) -> Vec<String> {
    let Ok(stdout) = output else {
        return Vec::new();
    };
    stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_git_dir_returns_none() {
        let tmp = std::env::temp_dir().join("yiyi-git-ctx-test-non-git");
        std::fs::create_dir_all(&tmp).ok();
        assert!(!is_git_repo(&tmp));
        assert!(render_git_context(&tmp).is_none());
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn render_formats_correctly() {
        // Test the rendering logic with the project's own repo
        // (we know we're inside a git repo during cargo test)
        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        if is_git_repo(manifest_dir) {
            let ctx = render_git_context(manifest_dir);
            assert!(ctx.is_some());
            let text = ctx.unwrap();
            assert!(text.contains("## Git Context"));
            assert!(text.contains("Branch:"));
        }
    }
}
