//! Snapshot tool — `revert_turn` lets the agent restore the workspace to
//! a previous turn's snapshot.

use crate::engine::side_git;

pub(super) fn definitions() -> Vec<super::ToolDefinition> {
    vec![super::tool_def(
        "revert_turn",
        "Restore the workspace to a previous turn's snapshot (side-git). \
         Useful when an agent edit went wrong and you want to roll back \
         without touching the user's real .git. Returns the list of \
         restored and removed files.",
        serde_json::json!({
            "type": "object",
            "properties": {
                "turn_index": {
                    "type": "integer",
                    "description": "The turn index to restore. Snapshots are indexed by turn number starting at 1."
                },
                "phase": {
                    "type": "string",
                    "enum": ["pre", "post"],
                    "description": "Which snapshot to restore: 'pre' (before that turn ran) or 'post' (after). Default 'pre'."
                }
            },
            "required": ["turn_index"]
        }),
    )]
}

pub(super) async fn revert_turn_tool(args: &serde_json::Value) -> String {
    let turn_index = match args.get("turn_index").and_then(|v| v.as_u64()) {
        Some(n) => n as u32,
        None => return "Error: turn_index (integer) is required".to_string(),
    };
    let phase = args
        .get("phase")
        .and_then(|v| v.as_str())
        .unwrap_or("pre")
        .to_string();
    if phase != "pre" && phase != "post" {
        return format!("Error: phase must be 'pre' or 'post', got '{phase}'");
    }

    let session_id = super::get_current_session_id();
    if session_id.is_empty() {
        return "Error: no active session — cannot determine which snapshot to restore".to_string();
    }
    let workspace = super::get_effective_workspace();

    match side_git::restore(&session_id, turn_index, &phase, &workspace).await {
        Ok(report) => serde_json::to_string_pretty(&serde_json::json!({
            "success": true,
            "turn_index": turn_index,
            "phase": phase,
            "restored_files": report.restored_files,
            "removed_files": report.removed_files,
        }))
        .unwrap_or_else(|_| "{}".to_string()),
        Err(e) => format!("Error: {e}"),
    }
}
