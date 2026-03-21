use rusqlite::params;
use std::path::Path;

pub struct MemoryRow {
    pub id: String,
    pub session_id: Option<String>,
    pub content: String,
    pub category: String,
    pub tier: String,
    pub confidence: f64,
    pub source: String,
    pub reviewed_by_meditation: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub access_count: i64,
    pub last_accessed_at: Option<i64>,
}

/// Build an FTS5 query string from a natural-language query.
/// Splits on whitespace, wraps each token in quotes (to handle CJK characters
/// that the tokenizer may split differently), and ORs them together.
fn build_fts_query(query: &str) -> String {
    let tokens: Vec<String> = query
        .split_whitespace()
        .filter(|t| !t.is_empty())
        .map(|t| {
            // Escape double quotes inside the token
            let escaped = t.replace('"', "\"\"");
            format!("\"{}\"", escaped)
        })
        .collect();
    if tokens.is_empty() {
        return String::new();
    }
    // Use OR so partial matches are found; BM25 naturally ranks more-matching
    // entries higher.
    tokens.join(" OR ")
}

/// Split text content into separate memory entries.
/// Splits on markdown headings (## ...) or double newlines.
fn split_into_memory_entries(content: &str) -> Vec<&str> {
    let mut entries = Vec::new();
    let mut last = 0;

    for (i, line) in content.lines().enumerate() {
        let _ = i; // not needed, iterating for position
        if line.starts_with("## ") || line.starts_with("### ") {
            let pos = line.as_ptr() as usize - content.as_ptr() as usize;
            if pos > last && content[last..pos].trim().len() > 10 {
                entries.push(content[last..pos].trim());
            }
            last = pos;
        }
    }
    // Remainder
    if last < content.len() && content[last..].trim().len() > 10 {
        entries.push(content[last..].trim());
    }

    // If no headings found, split on double newlines
    if entries.is_empty() && content.trim().len() > 10 {
        entries = content.split("\n\n").filter(|s| s.trim().len() > 10).collect();
    }

    // If still just one big block, return it whole
    if entries.is_empty() && content.trim().len() > 10 {
        entries.push(content.trim());
    }

    entries
}

/// Infer memory category from topic file name.
fn infer_category_from_topic(topic: &str) -> &str {
    let lower = topic.to_lowercase();
    if lower.contains("prefer") || lower.contains("偏好") || lower.contains("喜好") {
        "preference"
    } else if lower.contains("decision") || lower.contains("决定") || lower.contains("决策") {
        "decision"
    } else if lower.contains("experience") || lower.contains("经验") || lower.contains("教训") {
        "experience"
    } else if lower.contains("fact") || lower.contains("事实") || lower.contains("信息") {
        "fact"
    } else {
        "note"
    }
}

impl super::Database {
    // === Memory CRUD (FTS5-backed) ===

    /// Add a memory entry. Returns the generated id.
    pub fn memory_add(
        &self,
        content: &str,
        category: &str,
        session_id: Option<&str>,
    ) -> Result<String, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = super::now_ts();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO memories (id, session_id, content, category, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, session_id, content, category, now, now],
        )
        .map_err(|e| format!("Failed to add memory: {}", e))?;
        Ok(id)
    }

    /// Search memories using FTS5 MATCH with BM25 ranking.
    /// Returns up to `limit` results ordered by relevance score.
    pub fn memory_search(
        &self,
        query: &str,
        category: Option<&str>,
        limit: usize,
    ) -> Result<Vec<MemoryRow>, String> {
        let conn = self.conn.lock().unwrap();

        // Build the FTS5 query. We search the content column.
        // For multi-word queries, we OR the terms so partial matches are included,
        // and BM25 will rank entries with more matching terms higher.
        let fts_query = build_fts_query(query);
        if fts_query.is_empty() {
            return Ok(Vec::new());
        }

        let sql = if category.is_some() {
            "SELECT m.id, m.session_id, m.content, m.category, m.created_at, m.updated_at, m.tier, m.confidence, m.source, m.reviewed_by_meditation, m.access_count, m.last_accessed_at
             FROM memories m
             JOIN memories_fts f ON m.rowid = f.rowid
             WHERE memories_fts MATCH ?1 AND m.category = ?2
             ORDER BY bm25(memories_fts) ASC
             LIMIT ?3"
        } else {
            "SELECT m.id, m.session_id, m.content, m.category, m.created_at, m.updated_at, m.tier, m.confidence, m.source, m.reviewed_by_meditation, m.access_count, m.last_accessed_at
             FROM memories m
             JOIN memories_fts f ON m.rowid = f.rowid
             WHERE memories_fts MATCH ?1
             ORDER BY bm25(memories_fts) ASC
             LIMIT ?2"
        };

        let mut stmt = conn.prepare(sql).map_err(|e| format!("Query error: {}", e))?;

        let mapper = |row: &rusqlite::Row| {
            Ok(MemoryRow {
                id: row.get(0)?,
                session_id: row.get(1)?,
                content: row.get(2)?,
                category: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                tier: row.get::<_, String>(6).unwrap_or_else(|_| "warm".into()),
                confidence: row.get::<_, f64>(7).unwrap_or(0.5),
                source: row.get::<_, String>(8).unwrap_or_else(|_| "extraction".into()),
                reviewed_by_meditation: row.get::<_, i32>(9).unwrap_or(0) != 0,
                access_count: row.get::<_, i64>(10).unwrap_or(0),
                last_accessed_at: row.get::<_, Option<i64>>(11).unwrap_or(None),
            })
        };

        let results: Vec<MemoryRow> = if let Some(cat) = category {
            stmt.query_map(params![fts_query, cat, limit as i64], mapper)
                .map_err(|e| format!("Query error: {}", e))?
                .filter_map(|r| r.ok())
                .collect()
        } else {
            stmt.query_map(params![fts_query, limit as i64], mapper)
                .map_err(|e| format!("Query error: {}", e))?
                .filter_map(|r| r.ok())
                .collect()
        };

        // Growth System: bump access_count for returned memories
        if !results.is_empty() {
            let now = super::now_ts();
            for mem in &results {
                conn.execute(
                    "UPDATE memories SET access_count = access_count + 1, last_accessed_at = ?1 WHERE id = ?2",
                    params![now, mem.id],
                ).ok();
            }
        }

        Ok(results)
    }

    /// Delete a memory by id.
    pub fn memory_delete(&self, id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().unwrap();
        let changed = conn
            .execute("DELETE FROM memories WHERE id = ?1", params![id])
            .map_err(|e| format!("Failed to delete memory: {}", e))?;
        Ok(changed > 0)
    }

    /// List memories, optionally filtered by category.
    pub fn memory_list(
        &self,
        category: Option<&str>,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<MemoryRow>, String> {
        let conn = self.conn.lock().unwrap();
        let (sql, rows) = if let Some(cat) = category {
            let mut stmt = conn
                .prepare(
                    "SELECT id, session_id, content, category, created_at, updated_at, tier, confidence, source, reviewed_by_meditation, access_count, last_accessed_at
                     FROM memories WHERE category = ?1
                     ORDER BY updated_at DESC LIMIT ?2 OFFSET ?3",
                )
                .map_err(|e| format!("Query error: {}", e))?;
            let r = stmt
                .query_map(params![cat, limit as i64, offset as i64], |row| {
                    Ok(MemoryRow {
                        id: row.get(0)?,
                        session_id: row.get(1)?,
                        content: row.get(2)?,
                        category: row.get(3)?,
                        created_at: row.get(4)?,
                        updated_at: row.get(5)?,
                        tier: row.get::<_, String>(6).unwrap_or_else(|_| "warm".into()),
                        confidence: row.get::<_, f64>(7).unwrap_or(0.5),
                        source: row.get::<_, String>(8).unwrap_or_else(|_| "extraction".into()),
                        reviewed_by_meditation: row.get::<_, i32>(9).unwrap_or(0) != 0,
                        access_count: row.get::<_, i64>(10).unwrap_or(0),
                        last_accessed_at: row.get::<_, Option<i64>>(11).unwrap_or(None),
                    })
                })
                .map_err(|e| format!("Query error: {}", e))?
                .filter_map(|r| r.ok())
                .collect::<Vec<_>>();
            ("filtered", r)
        } else {
            let mut stmt = conn
                .prepare(
                    "SELECT id, session_id, content, category, created_at, updated_at, tier, confidence, source, reviewed_by_meditation, access_count, last_accessed_at
                     FROM memories
                     ORDER BY updated_at DESC LIMIT ?1 OFFSET ?2",
                )
                .map_err(|e| format!("Query error: {}", e))?;
            let r = stmt
                .query_map(params![limit as i64, offset as i64], |row| {
                    Ok(MemoryRow {
                        id: row.get(0)?,
                        session_id: row.get(1)?,
                        content: row.get(2)?,
                        category: row.get(3)?,
                        created_at: row.get(4)?,
                        updated_at: row.get(5)?,
                        tier: row.get::<_, String>(6).unwrap_or_else(|_| "warm".into()),
                        confidence: row.get::<_, f64>(7).unwrap_or(0.5),
                        source: row.get::<_, String>(8).unwrap_or_else(|_| "extraction".into()),
                        reviewed_by_meditation: row.get::<_, i32>(9).unwrap_or(0) != 0,
                        access_count: row.get::<_, i64>(10).unwrap_or(0),
                        last_accessed_at: row.get::<_, Option<i64>>(11).unwrap_or(None),
                    })
                })
                .map_err(|e| format!("Query error: {}", e))?
                .filter_map(|r| r.ok())
                .collect::<Vec<_>>();
            ("all", r)
        };

        let _ = sql; // suppress unused warning
        Ok(rows)
    }

    /// Update a memory entry's content (and bump updated_at).
    /// Count total memories, optionally by category.
    pub fn memory_count(&self, category: Option<&str>) -> Result<i64, String> {
        let conn = self.conn.lock().unwrap();
        let count = if let Some(cat) = category {
            conn.query_row(
                "SELECT COUNT(*) FROM memories WHERE category = ?1",
                params![cat],
                |row| row.get(0),
            )
        } else {
            conn.query_row("SELECT COUNT(*) FROM memories", [], |row| row.get(0))
        }
        .unwrap_or(0);
        Ok(count)
    }

    /// Get memories by tier
    pub fn get_memories_by_tier(&self, tier: &str, limit: usize) -> Vec<MemoryRow> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT id, session_id, content, category, created_at, updated_at, tier, confidence, source, reviewed_by_meditation, access_count, last_accessed_at
             FROM memories WHERE tier = ?1 ORDER BY confidence DESC LIMIT ?2",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map(params![tier, limit as i64], |row| {
            Ok(MemoryRow {
                id: row.get(0)?,
                session_id: row.get(1)?,
                content: row.get(2)?,
                category: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                tier: row.get::<_, String>(6).unwrap_or_else(|_| "warm".into()),
                confidence: row.get::<_, f64>(7).unwrap_or(0.5),
                source: row.get::<_, String>(8).unwrap_or_else(|_| "extraction".into()),
                reviewed_by_meditation: row.get::<_, i32>(9).unwrap_or(0) != 0,
                access_count: row.get::<_, i64>(10).unwrap_or(0),
                last_accessed_at: row.get::<_, Option<i64>>(11).unwrap_or(None),
            })
        })
        .ok()
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
    }

    /// Update memory tier and confidence
    pub fn update_memory_tier(&self, id: &str, tier: &str, confidence: f64) {
        let conn = self.conn.lock().unwrap();
        let now = super::now_ts();
        conn.execute(
            "UPDATE memories SET tier = ?1, confidence = ?2, updated_at = ?3 WHERE id = ?4",
            params![tier, confidence, now, id],
        )
        .ok();
    }

    /// Get unreviewed memories (for meditation)
    pub fn get_unreviewed_memories(&self, limit: usize) -> Vec<MemoryRow> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT id, session_id, content, category, created_at, updated_at, tier, confidence, source, reviewed_by_meditation, access_count, last_accessed_at
             FROM memories WHERE reviewed_by_meditation = 0 ORDER BY created_at DESC LIMIT ?1",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map(params![limit as i64], |row| {
            Ok(MemoryRow {
                id: row.get(0)?,
                session_id: row.get(1)?,
                content: row.get(2)?,
                category: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                tier: row.get::<_, String>(6).unwrap_or_else(|_| "warm".into()),
                confidence: row.get::<_, f64>(7).unwrap_or(0.5),
                source: row.get::<_, String>(8).unwrap_or_else(|_| "extraction".into()),
                reviewed_by_meditation: row.get::<_, i32>(9).unwrap_or(0) != 0,
                access_count: row.get::<_, i64>(10).unwrap_or(0),
                last_accessed_at: row.get::<_, Option<i64>>(11).unwrap_or(None),
            })
        })
        .ok()
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
    }

    /// Mark memories as reviewed by meditation
    pub fn mark_memories_reviewed(&self, ids: &[&str], _meditation_id: &str) {
        if ids.is_empty() {
            return;
        }
        let conn = self.conn.lock().unwrap();
        let placeholders: Vec<String> = ids.iter().enumerate().map(|(i, _)| format!("?{}", i + 1)).collect();
        let sql = format!(
            "UPDATE memories SET reviewed_by_meditation = 1 WHERE id IN ({})",
            placeholders.join(", ")
        );
        let params: Vec<&dyn rusqlite::types::ToSql> = ids.iter().map(|id| id as &dyn rusqlite::types::ToSql).collect();
        conn.execute(&sql, params.as_slice()).ok();
    }

    // === Migration: file-based memory -> FTS5 SQLite ===

    /// Migrate existing file-based memory entries (MEMORY.md, memory/topics/*.md)
    /// into the memories table with FTS5 indexing. One-time operation.
    pub fn migrate_memory_from_files(&self, working_dir: &Path) -> Result<(), String> {
        // Check if we already have memory data
        {
            let conn = self.conn.lock().unwrap();
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM memories", [], |row| row.get(0))
                .unwrap_or(0);
            if count > 0 {
                return Ok(()); // Already migrated or has data
            }
        }

        let mut migrated = 0;

        // Migrate MEMORY.md (top-level memory file)
        let memory_md = working_dir.join("MEMORY.md");
        if memory_md.exists() {
            if let Ok(content) = std::fs::read_to_string(&memory_md) {
                // Split by headings or paragraphs to create separate memory entries
                for section in split_into_memory_entries(&content) {
                    if !section.trim().is_empty() {
                        self.memory_add(section.trim(), "note", None).ok();
                        migrated += 1;
                    }
                }
            }
        }

        // Migrate memory/topics/*.md files
        let topics_dir = working_dir.join("memory").join("topics");
        if topics_dir.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&topics_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().map_or(false, |e| e == "md") {
                        if let Ok(content) = std::fs::read_to_string(&path) {
                            let topic = path
                                .file_stem()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .to_string();
                            // Infer category from topic name
                            let category = infer_category_from_topic(&topic);
                            for section in split_into_memory_entries(&content) {
                                if !section.trim().is_empty() {
                                    self.memory_add(section.trim(), category, None).ok();
                                    migrated += 1;
                                }
                            }
                        }
                    }
                }
            }
        }

        if migrated > 0 {
            log::info!(
                "Migrated {} memory entries from files to SQLite FTS5",
                migrated
            );
        }

        Ok(())
    }
}
