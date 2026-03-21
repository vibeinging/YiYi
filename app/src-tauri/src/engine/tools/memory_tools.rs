/// Memory CRUD + diary tool definitions.
pub(super) fn definitions() -> Vec<super::ToolDefinition> {
    vec![
        super::tool_def(
            "memory_add",
            "Add a memory entry to the persistent knowledge store. Use this to save important facts, user preferences, project decisions, or experiences that should be remembered across conversations. Each memory has a category for organization.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "content": { "type": "string", "description": "The memory content to store" },
                    "category": { "type": "string", "enum": ["fact", "preference", "experience", "decision", "note"], "description": "Category of the memory (default: fact). fact=factual info, preference=user likes/dislikes, experience=lessons learned, decision=choices made, note=general notes" }
                },
                "required": ["content"]
            }),
        ),
        super::tool_def(
            "memory_search",
            "Search stored memories using full-text search with BM25 relevance ranking. Supports Chinese and English. Use before answering questions about prior work, decisions, preferences, or past conversations.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search query (keywords or phrases, supports Chinese and English)" },
                    "category": { "type": "string", "enum": ["fact", "preference", "experience", "decision", "note"], "description": "Optional: filter by category" },
                    "max_results": { "type": "integer", "description": "Maximum results to return (default: 10)" }
                },
                "required": ["query"]
            }),
        ),
        super::tool_def(
            "memory_delete",
            "Delete a specific memory entry by its ID. Use memory_search or memory_list first to find the ID.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "The memory ID to delete" }
                },
                "required": ["id"]
            }),
        ),
        super::tool_def(
            "memory_list",
            "List stored memories, optionally filtered by category. Shows content, category, and timestamps.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "category": { "type": "string", "enum": ["fact", "preference", "experience", "decision", "note"], "description": "Optional: filter by category" },
                    "limit": { "type": "integer", "description": "Maximum entries to return (default: 20)" },
                    "offset": { "type": "integer", "description": "Number of entries to skip (default: 0, for pagination)" }
                }
            }),
        ),
        // --- Markdown diary & long-term memory tools ---
        super::tool_def(
            "diary_write",
            "Write an entry to today's diary. Use this to record important events, learnings, decisions, and interactions from the current session.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "content": {
                        "type": "string",
                        "description": "The diary entry content"
                    },
                    "topic": {
                        "type": "string",
                        "description": "Brief topic/title for this entry"
                    }
                },
                "required": ["content"]
            }),
        ),
        super::tool_def(
            "diary_read",
            "Read diary entries. Can read a specific date or recent days. Returns chronological diary content.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "date": {
                        "type": "string",
                        "description": "Specific date in YYYY-MM-DD format. If omitted, reads recent days."
                    },
                    "days": {
                        "type": "integer",
                        "description": "Number of recent days to read (default: 3, max: 30)"
                    }
                }
            }),
        ),
        super::tool_def(
            "memory_read",
            "Read the long-term memory file (MEMORY.md). Contains important persistent facts, user preferences, key decisions, and knowledge accumulated over time.",
            serde_json::json!({
                "type": "object",
                "properties": {}
            }),
        ),
        super::tool_def(
            "memory_write",
            "Update the long-term memory file (MEMORY.md). Use this to promote important information from diary or conversation to persistent memory. Overwrites the entire file - read first, then write the updated version.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "content": {
                        "type": "string",
                        "description": "The complete MEMORY.md content to write"
                    }
                },
                "required": ["content"]
            }),
        ),
    ]
}

/// Add a memory entry to the SQLite FTS5 knowledge store.
pub(super) async fn memory_add_tool(args: &serde_json::Value) -> String {
    let content = args["content"].as_str().unwrap_or("");
    let category = args["category"].as_str().unwrap_or("fact");

    if content.is_empty() {
        return "Error: content is required".into();
    }

    let db = match super::require_db() {
        Ok(db) => db,
        Err(e) => return e,
    };

    // Use the current task-local session_id if available
    let sid = super::get_current_session_id();
    let session_id: Option<String> = if sid.is_empty() { None } else { Some(sid) };

    match db.memory_add(content, category, session_id.as_deref()) {
        Ok(id) => format!("Memory added (id: {}, category: {})", id, category),
        Err(e) => format!("Error adding memory: {}", e),
    }
}

/// Search memories using FTS5 MATCH with BM25 ranking.
pub(super) async fn memory_search_tool(args: &serde_json::Value) -> String {
    let query = args["query"].as_str().unwrap_or("");
    let category = args["category"].as_str();
    let max_results = args["max_results"].as_u64().unwrap_or(10) as usize;

    if query.is_empty() {
        return "Error: query is required".into();
    }

    let db = match super::require_db() {
        Ok(db) => db,
        Err(e) => return e,
    };

    match db.memory_search(query, category, max_results) {
        Ok(rows) => {
            if rows.is_empty() {
                return format!("No memories found matching '{}'", query);
            }
            let results: Vec<String> = rows
                .iter()
                .map(|m| {
                    format!(
                        "[{}] ({})\n{}\n  -- id: {} | created: {}",
                        m.category,
                        super::format_timestamp(m.updated_at),
                        m.content,
                        m.id,
                        super::format_timestamp(m.created_at),
                    )
                })
                .collect();
            format!(
                "Found {} memories matching '{}':\n\n{}",
                results.len(),
                query,
                results.join("\n---\n")
            )
        }
        Err(e) => format!("Error searching memories: {}", e),
    }
}

/// Delete a memory entry by ID.
pub(super) async fn memory_delete_tool(args: &serde_json::Value) -> String {
    let id = args["id"].as_str().unwrap_or("");
    if id.is_empty() {
        return "Error: id is required".into();
    }

    let db = match super::require_db() {
        Ok(db) => db,
        Err(e) => return e,
    };

    match db.memory_delete(id) {
        Ok(true) => format!("Memory deleted (id: {})", id),
        Ok(false) => format!("No memory found with id: {}", id),
        Err(e) => format!("Error deleting memory: {}", e),
    }
}

/// List memories with optional category filter and pagination.
pub(super) async fn memory_list_tool(args: &serde_json::Value) -> String {
    let category = args["category"].as_str();
    let limit = args["limit"].as_u64().unwrap_or(20) as usize;
    let offset = args["offset"].as_u64().unwrap_or(0) as usize;

    let db = match super::require_db() {
        Ok(db) => db,
        Err(e) => return e,
    };

    let total = db.memory_count(category).unwrap_or(0);

    match db.memory_list(category, limit, offset) {
        Ok(rows) => {
            if rows.is_empty() {
                return if category.is_some() {
                    format!("No memories found in category '{}'", category.unwrap())
                } else {
                    "No memories stored yet.".into()
                };
            }
            let entries: Vec<String> = rows
                .iter()
                .map(|m| {
                    format!(
                        "- [{}] {} (id: {}, updated: {})",
                        m.category,
                        super::truncate_output(&m.content, 200),
                        m.id,
                        super::format_timestamp(m.updated_at),
                    )
                })
                .collect();
            format!(
                "Memories ({} total, showing {}-{}):\n{}",
                total,
                offset + 1,
                offset + rows.len(),
                entries.join("\n")
            )
        }
        Err(e) => format!("Error listing memories: {}", e),
    }
}

/// diary_write inline handler
pub(super) async fn diary_write_tool(args: &serde_json::Value) -> Result<String, String> {
    let content = args["content"].as_str().ok_or_else(|| "Error: content is required".to_string())?;
    let topic = args["topic"].as_str();
    let working_dir = super::WORKING_DIR.get().cloned().ok_or_else(|| "Error: working directory not set".to_string())?;
    match super::memory::append_diary(&working_dir, content, topic) {
        Ok(()) => {
            // Also store in DB for search
            if let Some(db) = super::DATABASE.get() {
                let sid = super::get_current_session_id();
                let session_id: Option<&str> = if sid.is_empty() { None } else { Some(&sid) };
                let _ = db.memory_add(content, "note", session_id);
            }
            Ok("Diary entry written.".into())
        }
        Err(e) => Ok(format!("Error: {e}")),
    }
}

/// diary_read inline handler
pub(super) async fn diary_read_tool(args: &serde_json::Value) -> Result<String, String> {
    let working_dir = super::WORKING_DIR.get().cloned().ok_or_else(|| "Error: working directory not set".to_string())?;
    if let Some(date) = args.get("date").and_then(|d| d.as_str()) {
        match super::memory::read_diary(&working_dir, date) {
            Err(e) => Ok(e),
            Ok(content) if content.is_empty() => Ok(format!("No diary entry found for {date}.")),
            Ok(content) => Ok(content),
        }
    } else {
        let days = args.get("days").and_then(|d| d.as_u64()).unwrap_or(3).min(30) as usize;
        let entries = super::memory::read_recent_diaries(&working_dir, days);
        if entries.is_empty() {
            Ok("No recent diary entries found.".into())
        } else {
            let mut output = String::new();
            for (date, content) in entries {
                output.push_str(&format!("--- {date} ---\n{content}\n\n"));
            }
            Ok(output)
        }
    }
}

/// memory_read inline handler
pub(super) async fn memory_read_tool() -> Result<String, String> {
    let working_dir = super::WORKING_DIR.get().cloned().ok_or_else(|| "Error: working directory not set".to_string())?;
    let content = super::memory::read_memory_md(&working_dir);
    if content.is_empty() {
        Ok("MEMORY.md is empty. No long-term memories stored yet.".into())
    } else {
        Ok(content)
    }
}

/// memory_write inline handler
pub(super) async fn memory_write_tool(args: &serde_json::Value) -> Result<String, String> {
    let content = args["content"].as_str().ok_or_else(|| "Error: content is required".to_string())?;
    let working_dir = super::WORKING_DIR.get().cloned().ok_or_else(|| "Error: working directory not set".to_string())?;
    match super::memory::write_memory_md(&working_dir, content) {
        Ok(()) => Ok("MEMORY.md updated successfully.".into()),
        Err(e) => Ok(format!("Error: {e}")),
    }
}
