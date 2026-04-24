/// Memory tools powered by MemMe vector memory engine (single source of truth).
///
/// All structured memory operations go through MemMe's DuckDB-backed store.
/// File-based operations (diary, MEMORY.md) remain as complementary markdown layers.

use super::MEMME_USER_ID;

pub(super) fn definitions() -> Vec<super::ToolDefinition> {
    // Priya P1-4 + P1-5 consolidation: the LLM surface is deliberately just
    // `memory_add` (write on-demand) and `memory_search` (read on-demand).
    //
    // Previously exposed but removed (execution fns kept below for internal
    // callers / BuddyPanel UI):
    //   - memory_list    → Buddy UI shows lists; LLM uses memory_search
    //   - memory_delete  → Buddy UI has a delete button; LLM has no need
    //   - memory_read    → MEMORY.md is legacy; use read_file if needed
    //   - memory_write   → ditto; use write_file
    //   - diary_write    → diary is session journal, owned by meditation engine
    //   - diary_read     → ditto
    //
    // Rationale: the LLM was misusing list/read as a cheap way to "dump
    // everything", which polluted context. Forcing on-demand search with a
    // query tells the agent to think about WHAT it's looking for.
    vec![
        super::tool_def(
            "memory_add",
            "Save a fact / preference / decision / principle to long-term memory. Use sparingly — only for information that should survive across conversations.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "content": { "type": "string", "description": "The memory content to store" },
                    "category": { "type": "string", "enum": ["fact", "preference", "experience", "decision", "note", "principle"], "description": "Category (default: fact)" },
                    "importance": { "type": "number", "description": "0.0-1.0 (default: 0.5)" }
                },
                "required": ["content"]
            }),
        ),
        super::tool_def(
            "memory_search",
            "Recall relevant memories via vector + keyword hybrid search. Use when the user references past work or when their current request might have a precedent.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Natural-language query (zh/en)" },
                    "category": { "type": "string", "enum": ["fact", "preference", "experience", "decision", "note", "principle"], "description": "Optional filter" },
                    "max_results": { "type": "integer", "description": "Default: 10" }
                },
                "required": ["query"]
            }),
        ),
    ]
}

// ── Helpers ──────────────────────────────────────────────────────────

/// Build MemMe AddOptions with common defaults.
pub(crate) fn memme_add_opts(category: &str, importance: f32) -> memme_core::AddOptions {
    memme_core::AddOptions::new(MEMME_USER_ID)
        .categories(vec![category.to_string()])
        .importance(importance)
}

/// Build MemMe AddOptions with session from task-local context.
fn memme_add_opts_with_session(category: &str, importance: f32) -> memme_core::AddOptions {
    let mut opts = memme_add_opts(category, importance);
    let sid = super::get_current_session_id();
    if !sid.is_empty() {
        opts = opts.session_id(sid);
    }
    opts
}

// ── Tool implementations ─────────────────────────────────────────────

pub(super) async fn memory_add_tool(args: &serde_json::Value) -> String {
    let content = args["content"].as_str().unwrap_or("");
    let category = args["category"].as_str().unwrap_or("fact");
    let importance = args["importance"].as_f64().unwrap_or(0.5) as f32;

    if content.is_empty() {
        return "Error: content is required".into();
    }

    let store = match super::require_memme() {
        Ok(s) => s,
        Err(e) => return e,
    };

    let opts = memme_add_opts_with_session(category, importance);
    match store.add(content, opts) {
        Ok(result) => format!(
            "Memory added (id: {}, category: {}, importance: {:.1})",
            result.id, category, importance
        ),
        Err(e) => format!("Error adding memory: {}", e),
    }
}

pub(super) async fn memory_search_tool(args: &serde_json::Value) -> String {
    let query = args["query"].as_str().unwrap_or("");
    let category = args["category"].as_str();
    let max_results = args["max_results"].as_u64().unwrap_or(10) as usize;

    if query.is_empty() {
        return "Error: query is required".into();
    }

    let store = match super::require_memme() {
        Ok(s) => s,
        Err(e) => return e,
    };

    let mut options = memme_core::SearchOptions::new(MEMME_USER_ID)
        .limit(max_results)
        .keyword_search(true);
    if let Some(cat) = category {
        options = options.filter(memme_core::FilterExpression::contains("categories", cat));
    }

    match store.search(query, options) {
        Ok(results) if !results.is_empty() => {
            let entries: Vec<String> = results
                .iter()
                .map(|m| {
                    let cats = m.categories.as_ref()
                        .map(|c| c.join(", "))
                        .unwrap_or_else(|| "未归类".into());
                    let score = m.score.map(|s| format!("{:.3}", s)).unwrap_or_default();
                    let imp = m.importance.map(|i| format!("{:.1}", i)).unwrap_or_else(|| "-".into());
                    format!(
                        "[{}] (score: {}, importance: {})\n{}\n  -- id: {} | created: {}",
                        cats, score, imp, m.content, m.id, m.created_at,
                    )
                })
                .collect();
            format!("Found {} memories matching '{}':\n\n{}", entries.len(), query, entries.join("\n---\n"))
        }
        Ok(_) => format!("No memories found matching '{}'", query),
        Err(e) => format!("Error searching memories: {}", e),
    }
}

pub(super) async fn memory_delete_tool(args: &serde_json::Value) -> String {
    let id = args["id"].as_str().unwrap_or("");
    if id.is_empty() {
        return "Error: id is required".into();
    }

    let store = match super::require_memme() {
        Ok(s) => s,
        Err(e) => return e,
    };

    match store.delete_trace(id) {
        Ok(()) => format!("Memory deleted (id: {})", id),
        Err(e) => format!("Error deleting memory: {}", e),
    }
}

pub(super) async fn memory_list_tool(args: &serde_json::Value) -> String {
    let category = args["category"].as_str();
    let limit = args["limit"].as_u64().unwrap_or(20) as usize;

    let store = match super::require_memme() {
        Ok(s) => s,
        Err(e) => return e,
    };

    let mut options = memme_core::ListOptions::new(MEMME_USER_ID).limit(limit);
    if let Some(cat) = category {
        options = options.filter(memme_core::FilterExpression::contains("categories", cat));
    }

    match store.list_traces(options) {
        Ok(rows) if !rows.is_empty() => {
            let entries: Vec<String> = rows
                .iter()
                .map(|m| {
                    let cats = m.categories.as_ref()
                        .map(|c| c.join(", "))
                        .unwrap_or_else(|| "未归类".into());
                    let imp = m.importance.map(|i| format!("{:.1}", i)).unwrap_or_else(|| "-".into());
                    format!(
                        "- [{}] (importance: {}) {} (id: {}, updated: {})",
                        cats, imp, super::truncate_output(&m.content, 200), m.id, m.updated_at,
                    )
                })
                .collect();
            format!("Memories ({} entries):\n{}", rows.len(), entries.join("\n"))
        }
        Ok(_) => {
            if let Some(cat) = category {
                format!("No memories found in category '{}'", cat)
            } else {
                "No memories stored yet.".into()
            }
        }
        Err(e) => format!("Error listing memories: {}", e),
    }
}

pub(super) async fn diary_write_tool(args: &serde_json::Value) -> Result<String, String> {
    let content = args["content"].as_str().ok_or("Error: content is required")?;
    let topic = args["topic"].as_str();
    let working_dir = super::WORKING_DIR.get().cloned().ok_or("Error: working directory not set")?;
    super::memory::append_diary(&working_dir, content, topic).map_err(|e| format!("Error: {e}"))?;

    // Also store in MemMe for vector search
    if let Ok(store) = super::require_memme() {
        let opts = memme_add_opts_with_session("diary", 0.4);
        let _ = store.add(content, opts);
    }
    Ok("Diary entry written.".into())
}

pub(super) async fn diary_read_tool(args: &serde_json::Value) -> Result<String, String> {
    let working_dir = super::WORKING_DIR.get().cloned().ok_or("Error: working directory not set")?;
    if let Some(date) = args.get("date").and_then(|d| d.as_str()) {
        match super::memory::read_diary(&working_dir, date) {
            Err(e) => Ok(e),
            Ok(c) if c.is_empty() => Ok(format!("No diary entry found for {date}.")),
            Ok(c) => Ok(c),
        }
    } else {
        let days = args.get("days").and_then(|d| d.as_u64()).unwrap_or(3).min(30) as usize;
        let entries = super::memory::read_recent_diaries(&working_dir, days);
        if entries.is_empty() {
            Ok("No recent diary entries found.".into())
        } else {
            let mut out = String::new();
            for (date, content) in entries {
                out.push_str(&format!("--- {date} ---\n{content}\n\n"));
            }
            Ok(out)
        }
    }
}

pub(super) async fn memory_read_tool() -> Result<String, String> {
    let working_dir = super::WORKING_DIR.get().cloned().ok_or("Error: working directory not set")?;
    let content = super::memory::read_memory_md(&working_dir);
    if content.is_empty() {
        Ok("MEMORY.md is empty. No long-term memories stored yet.".into())
    } else {
        Ok(content)
    }
}

pub(super) async fn memory_write_tool(args: &serde_json::Value) -> Result<String, String> {
    let content = args["content"].as_str().ok_or("Error: content is required")?;
    let working_dir = super::WORKING_DIR.get().cloned().ok_or("Error: working directory not set")?;
    super::memory::write_memory_md(&working_dir, content).map_err(|e| format!("Error: {e}"))?;
    Ok("MEMORY.md updated successfully.".into())
}
