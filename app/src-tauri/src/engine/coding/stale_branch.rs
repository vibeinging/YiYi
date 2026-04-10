#![allow(dead_code)]
use std::path::Path;
use std::process::Command;

/// How fresh a branch is relative to its base branch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BranchFreshness {
    /// Branch is up-to-date with base.
    Fresh,
    /// Branch is behind base by some commits.
    Stale {
        commits_behind: usize,
        missing_fixes: Vec<String>,
    },
    /// Branch has diverged from base (both ahead and behind).
    Diverged {
        commits_ahead: usize,
        commits_behind: usize,
    },
}

/// Policy for how to handle a stale branch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StalePolicy {
    /// Only warn the user, do not block.
    WarnOnly,
    /// Block the operation until the branch is updated.
    Block,
    /// Automatically rebase onto the base branch.
    AutoRebase,
}

/// Action to take based on freshness check and policy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StaleAction {
    /// No action needed.
    Noop,
    /// Warn the user with a message.
    Warn { message: String },
    /// Block the operation with a message.
    Block { message: String },
    /// Attempt an automatic rebase.
    Rebase,
}

/// Check how fresh `branch` is relative to `base` in the given workspace.
///
/// Uses `git rev-list --count` to determine ahead/behind counts,
/// and `git log --format=%s` to extract missing commit subjects.
pub fn check_branch_freshness(
    workspace: &Path,
    branch: &str,
    base: &str,
) -> BranchFreshness {
    let behind = rev_list_count(base, branch, workspace);
    let ahead = rev_list_count(branch, base, workspace);

    if behind == 0 {
        return BranchFreshness::Fresh;
    }

    if ahead > 0 {
        return BranchFreshness::Diverged {
            commits_ahead: ahead,
            commits_behind: behind,
        };
    }

    let missing_fixes = missing_fix_subjects(base, branch, workspace);
    BranchFreshness::Stale {
        commits_behind: behind,
        missing_fixes,
    }
}

/// Apply a policy to a freshness result and return the appropriate action.
pub fn apply_policy(freshness: &BranchFreshness, policy: StalePolicy) -> StaleAction {
    match freshness {
        BranchFreshness::Fresh => StaleAction::Noop,
        BranchFreshness::Stale {
            commits_behind,
            missing_fixes,
        } => match policy {
            StalePolicy::WarnOnly => StaleAction::Warn {
                message: format!(
                    "Branch is {} commit(s) behind base. Missing fixes: {}",
                    commits_behind,
                    format_missing_fixes(missing_fixes),
                ),
            },
            StalePolicy::Block => StaleAction::Block {
                message: format!(
                    "Branch is {} commit(s) behind base and must be updated before proceeding.",
                    commits_behind,
                ),
            },
            StalePolicy::AutoRebase => StaleAction::Rebase,
        },
        BranchFreshness::Diverged {
            commits_ahead,
            commits_behind,
        } => match policy {
            StalePolicy::WarnOnly => StaleAction::Warn {
                message: format!(
                    "Branch has diverged: {} commit(s) ahead, {} commit(s) behind base.",
                    commits_ahead, commits_behind,
                ),
            },
            StalePolicy::Block => StaleAction::Block {
                message: format!(
                    "Branch has diverged ({} ahead, {} behind) and must be reconciled before proceeding.",
                    commits_ahead, commits_behind,
                ),
            },
            StalePolicy::AutoRebase => StaleAction::Rebase,
        },
    }
}

/// Format a human-readable warning message for a stale or diverged branch.
/// Returns `None` if the branch is fresh.
pub fn format_stale_warning(freshness: &BranchFreshness, branch: &str) -> Option<String> {
    match freshness {
        BranchFreshness::Fresh => None,
        BranchFreshness::Stale {
            commits_behind,
            missing_fixes,
        } => Some(format!(
            "Branch '{}' is {} commit(s) behind base.\nMissing commits:\n{}",
            branch,
            commits_behind,
            if missing_fixes.is_empty() {
                "  (none)".to_string()
            } else {
                missing_fixes
                    .iter()
                    .map(|s| format!("  - {}", s))
                    .collect::<Vec<_>>()
                    .join("\n")
            },
        )),
        BranchFreshness::Diverged {
            commits_ahead,
            commits_behind,
        } => Some(format!(
            "Branch '{}' has diverged: {} commit(s) ahead, {} commit(s) behind base.",
            branch, commits_ahead, commits_behind,
        )),
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn format_missing_fixes(fixes: &[String]) -> String {
    if fixes.is_empty() {
        "(none)".to_string()
    } else {
        fixes.join("; ")
    }
}

fn rev_list_count(a: &str, b: &str, repo_path: &Path) -> usize {
    let output = Command::new("git")
        .args(["rev-list", "--count", &format!("{b}..{a}")])
        .current_dir(repo_path)
        .output();
    match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .trim()
            .parse::<usize>()
            .unwrap_or(0),
        _ => 0,
    }
}

fn missing_fix_subjects(a: &str, b: &str, repo_path: &Path) -> Vec<String> {
    let output = Command::new("git")
        .args(["log", "--format=%s", &format!("{b}..{a}")])
        .current_dir(repo_path)
        .output();
    match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .filter(|l| !l.is_empty())
            .map(String::from)
            .collect(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_branch_returns_noop() {
        let freshness = BranchFreshness::Fresh;
        let action = apply_policy(&freshness, StalePolicy::WarnOnly);
        assert_eq!(action, StaleAction::Noop);
    }

    #[test]
    fn stale_branch_warn_policy() {
        let freshness = BranchFreshness::Stale {
            commits_behind: 3,
            missing_fixes: vec!["fix: timeout".into(), "fix: null ptr".into()],
        };
        let action = apply_policy(&freshness, StalePolicy::WarnOnly);
        match action {
            StaleAction::Warn { message } => {
                assert!(message.contains("3 commit(s) behind"));
                assert!(message.contains("fix: timeout"));
            }
            other => panic!("expected Warn, got {:?}", other),
        }
    }

    #[test]
    fn stale_branch_block_policy() {
        let freshness = BranchFreshness::Stale {
            commits_behind: 1,
            missing_fixes: vec![],
        };
        let action = apply_policy(&freshness, StalePolicy::Block);
        match action {
            StaleAction::Block { message } => {
                assert!(message.contains("1 commit(s) behind"));
            }
            other => panic!("expected Block, got {:?}", other),
        }
    }

    #[test]
    fn stale_branch_auto_rebase_policy() {
        let freshness = BranchFreshness::Stale {
            commits_behind: 2,
            missing_fixes: vec![],
        };
        let action = apply_policy(&freshness, StalePolicy::AutoRebase);
        assert_eq!(action, StaleAction::Rebase);
    }

    #[test]
    fn format_warning_fresh_returns_none() {
        assert!(format_stale_warning(&BranchFreshness::Fresh, "main").is_none());
    }

    #[test]
    fn format_warning_stale_returns_message() {
        let freshness = BranchFreshness::Stale {
            commits_behind: 2,
            missing_fixes: vec!["fix: bug".into()],
        };
        let msg = format_stale_warning(&freshness, "feature/x").unwrap();
        assert!(msg.contains("feature/x"));
        assert!(msg.contains("2 commit(s) behind"));
        assert!(msg.contains("fix: bug"));
    }
}
