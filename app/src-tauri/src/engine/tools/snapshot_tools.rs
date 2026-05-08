//! Snapshot tool — `revert_turn` lets the agent restore the workspace to
//! a previous turn's checkpoint.

use crate::engine::checkpoint::{self, Phase};

pub(super) fn definitions() -> Vec<super::ToolDefinition> {
    vec![super::tool_def(
        "revert_turn",
        "Restore the workspace to a previous turn's checkpoint. Useful \
         when an edit went wrong and you want to roll back without \
         touching the user's real .git. Returns the list of restored \
         and removed files, plus a stash commit oid if any hand-edits \
         were captured before the restore.",
        serde_json::json!({
            "type": "object",
            "properties": {
                "turn_index": {
                    "type": "integer",
                    "description": "The turn index to restore. Checkpoints are indexed by turn number starting at 1."
                },
                "phase": {
                    "type": "string",
                    "enum": ["pre", "post"],
                    "description": "Which checkpoint to restore: 'pre' (before that turn ran) or 'post' (after). Default 'pre'."
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
    let phase_str = args.get("phase").and_then(|v| v.as_str()).unwrap_or("pre");
    let phase = match Phase::parse(phase_str) {
        Ok(p) => p,
        Err(e) => return format!("Error: {e}"),
    };

    let session_id = super::get_current_session_id();
    if session_id.is_empty() {
        return "Error: no active session — cannot determine which checkpoint to restore".to_string();
    }
    let workspace = super::get_effective_workspace();

    match checkpoint::restore(&session_id, turn_index, phase, &workspace, None).await {
        Ok(report) => serde_json::to_string_pretty(&serde_json::json!({
            "success": true,
            "turn_index": turn_index,
            "phase": phase_str,
            "restored_files": report.restored_files,
            "removed_files": report.removed_files,
            "stash_commit": report.stash_commit,
        }))
        .unwrap_or_else(|_| "{}".to_string()),
        Err(e) => format!("Error: {e}"),
    }
}
