//! File I/O tools — read / write / edit / append / delete / undo, plus
//! directory inspection and code search. Every CRUD operation routes
//! through `super::access_check` (authorization) and snapshots to a single
//! central backup so `undo_edit` has a uniform recovery surface.
//!
//! Sub-module map:
//!   * `backup`  — single-revision backup store (`backup_to_central`,
//!     `backup_slot_for`).
//!   * `diff`    — unified-diff generator for AI perception.
//!   * `crud`    — the six CRUD tool fns.
//!   * `dir`     — directory inspection (`list_directory`, `project_tree`).
//!   * `search`  — code search (`grep_search`, `glob_search`).
//!   * `tests`   — end-to-end coverage (gated on
//!     `feature = "test-support"`).

mod backup;
mod crud;
mod dir;
mod diff;
mod search;

#[cfg(all(test, feature = "test-support"))]
mod tests;

// Lift the tool fns into mod scope so `dispatch::execute_tool` can call
// them as `file_tools::xxx_tool`. The `backup` / `diff` helpers stay
// reachable via their sub-modules for sibling impls and tests; no need to
// re-export them here.
pub(super) use crud::{
    append_file_tool, delete_file_tool, edit_file_tool, read_file_tool, undo_edit_tool,
    write_file_tool,
};
pub(super) use dir::{list_directory_tool, project_tree_tool};
pub(super) use search::{glob_search_tool, grep_search_tool};

/// File I/O tool definitions. The catalog wires these into the LLM-facing
/// tool list via `super::catalog::core_tools` / `deferred_tools_static`.
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
            "Restore a single file from its most recent automatic backup. \
             Backups are written before every write_file / edit_file / \
             append_file / delete_file call (one revision per path). \
             For delete_file, this re-materialises the file. Use this \
             when a single tool call introduced an error you want to \
             reverse — for multi-file or whole-turn rollback, restore \
             from the turn-level checkpoint instead.",
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
