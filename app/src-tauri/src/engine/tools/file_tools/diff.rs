//! Unified-diff generator used by `write_file`, `edit_file`, and `undo_edit`
//! to show the LLM exactly which lines moved.
//!
//! The model wrote the change blind to the surrounding file — feeding back a
//! diff (rather than just "ok, written") lets it spot off-by-one errors,
//! accidental whitespace damage, or a `replace_all` that hit more places than
//! it expected. Format mirrors `git diff` so the LLM uses its own training to
//! interpret it.

/// Generate a unified diff between old and new content for AI perception.
/// Shows exactly what lines changed with context, so the LLM understands
/// the spatial impact of its edits.
pub(crate) fn generate_diff(old: &str, new: &str, path: &str) -> String {
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

        let mut hunk = format!(
            "@@ -{},{} +{},{} @@\n",
            hunk_start_i + 1,
            0, // line counts filled later
            hunk_start_j + 1,
            0,
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
        while i < old_lines.len()
            && (j >= new_lines.len()
                || (i < old_lines.len() && j < new_lines.len() && old_lines[i] != new_lines[j]))
        {
            i += 1;
        }
        while j < new_lines.len()
            && (i >= old_lines.len()
                || (i < old_lines.len() && j < new_lines.len() && old_lines[i] != new_lines[j]))
        {
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
