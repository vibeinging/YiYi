use chrono::TimeZone;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeditationSession {
    pub id: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub status: String,
    pub sessions_reviewed: i32,
    pub memories_updated: i32,
    pub principles_changed: i32,
    pub memories_archived: i32,
    pub journal: Option<String>,
    pub error: Option<String>,
    #[serde(default = "default_meditation_depth")]
    pub depth: Option<String>,
    #[serde(default)]
    pub phases_completed: Option<String>,
    #[serde(default)]
    pub tomorrow_intentions: Option<String>,
    #[serde(default)]
    pub growth_synthesis: Option<String>,
}

fn default_meditation_depth() -> Option<String> {
    Some("standard".to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuddyDecision {
    pub id: String,
    pub question: String,
    pub context: String,
    pub buddy_answer: String,
    pub buddy_confidence: f64,
    /// "good" | "bad" | null (pending)
    pub user_feedback: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TrustStats {
    pub total: u32,
    pub good: u32,
    pub bad: u32,
    pub pending: u32,
    pub accuracy: f64,
    pub by_context: std::collections::HashMap<String, ContextTrust>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ContextTrust {
    pub total: u32,
    pub good: u32,
    pub bad: u32,
    pub accuracy: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CodeRegistryEntry {
    pub name: String,
    pub path: String,
    pub description: String,
    pub language: String,
    pub invoke_hint: Option<String>,
    pub skill_name: Option<String>,
    pub run_count: i64,
    pub success_count: i64,
    pub last_error: Option<String>,
}

/// Base stat value for all personality traits (before signals are applied).
pub const PERSONALITY_BASE_STAT: f64 = 50.0;

/// Cached personality aggregates. Invalidated when new signals are added.
static PERSONALITY_CACHE: std::sync::OnceLock<std::sync::Mutex<Option<(std::time::Instant, Vec<(String, f64)>)>>> = std::sync::OnceLock::new();

fn get_personality_cache() -> &'static std::sync::Mutex<Option<(std::time::Instant, Vec<(String, f64)>)>> {
    PERSONALITY_CACHE.get_or_init(|| std::sync::Mutex::new(None))
}

/// Invalidate personality cache (call after adding new signals).
pub fn invalidate_personality_cache() {
    if let Ok(mut guard) = get_personality_cache().lock() {
        *guard = None;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersonalitySignal {
    pub trait_name: String,
    pub delta: f64,
    pub evidence: String,
    pub memory_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PersonalitySignalRow {
    pub id: i64,
    pub trait_name: String,
    pub delta: f64,
    pub evidence: String,
    pub memory_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SparklingMemory {
    pub id: String,
    pub content: String,
    pub category: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecallCandidate {
    pub id: String,
    pub content: String,
    pub category: String,
    pub confidence: f64,
    pub created_at: i64,
}

impl super::Database {
    // -----------------------------------------------------------------------
    // Reflections & Corrections (Growth System)
    // -----------------------------------------------------------------------

    /// Save a post-task reflection.
    pub fn add_reflection(
        &self,
        task_id: Option<&str>,
        session_id: Option<&str>,
        outcome: &str,
        summary: &str,
        lesson: Option<&str>,
        skill_opportunity: Option<&str>,
        signal_type: &str,
        confidence: f64,
    ) -> Result<String, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = super::now_ts();
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "INSERT INTO reflections (id, task_id, session_id, outcome, summary, lesson, skill_opportunity, signal_type, confidence, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![id, task_id, session_id, outcome, summary, lesson, skill_opportunity, signal_type, confidence, now],
        )
        .map_err(|e| format!("Failed to add reflection: {}", e))?;
        Ok(id)
    }

    /// Save a behavioral correction learned from user feedback.
    pub fn add_correction(
        &self,
        trigger_pattern: &str,
        wrong_behavior: Option<&str>,
        correct_behavior: &str,
        source: Option<&str>,
        confidence: f64,
    ) -> Result<String, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = super::now_ts();
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "INSERT INTO corrections (id, trigger_pattern, wrong_behavior, correct_behavior, source, confidence, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, trigger_pattern, wrong_behavior, correct_behavior, source, confidence, now],
        )
        .map_err(|e| format!("Failed to add correction: {}", e))?;
        Ok(id)
    }

    /// Get active corrections for system prompt injection (most recent first, limited).
    pub fn get_active_corrections(&self, limit: usize) -> Vec<(String, String, String)> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = match conn.prepare(
            "SELECT trigger_pattern, correct_behavior, source
             FROM corrections WHERE active = 1
             ORDER BY hit_count DESC, created_at DESC LIMIT ?1",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map(params![limit as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2).unwrap_or_default(),
            ))
        })
        .ok()
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
    }

    /// Get all active corrections ordered by time ASC (for consolidation -- newer = higher priority).
    pub fn get_all_active_corrections(&self) -> Vec<(String, String, String, f64)> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = match conn.prepare(
            "SELECT trigger_pattern, correct_behavior, source, confidence
             FROM corrections WHERE active = 1
             ORDER BY created_at ASC",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2).unwrap_or_default(),
                row.get::<_, f64>(3).unwrap_or(0.80),
            ))
        })
        .ok()
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
    }

    /// Count active corrections.
    pub fn count_active_corrections(&self) -> usize {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row("SELECT COUNT(*) FROM corrections WHERE active = 1", [], |r| r.get::<_, i64>(0))
            .unwrap_or(0) as usize
    }

    /// Get corrections created since a given timestamp (millis), with wrong_behavior included.
    /// Returns (trigger_pattern, wrong_behavior, correct_behavior, source, created_at).
    pub fn get_corrections_since(
        &self,
        since_timestamp: i64,
    ) -> Vec<(String, Option<String>, String, String, i64)> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = match conn.prepare(
            "SELECT trigger_pattern, wrong_behavior, correct_behavior, source, created_at
             FROM corrections WHERE active = 1 AND created_at >= ?1
             ORDER BY created_at ASC",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map(params![since_timestamp], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3).unwrap_or_default(),
                row.get::<_, i64>(4)?,
            ))
        })
        .ok()
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
    }

    /// Disable a correction by id.
    pub fn disable_correction(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute("UPDATE corrections SET active = 0 WHERE id = ?1", params![id])
            .map_err(|e| format!("Failed to disable correction: {}", e))?;
        Ok(())
    }

    /// Get recent reflections for growth analysis.
    pub fn get_recent_reflections(&self, limit: usize) -> Vec<(String, String, Option<String>)> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = match conn.prepare(
            "SELECT outcome, summary, lesson FROM reflections
             ORDER BY created_at DESC LIMIT ?1",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map(params![limit as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .ok()
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
    }

    // -----------------------------------------------------------------------
    // Code Registry (Growth System -- self-created tools)
    // -----------------------------------------------------------------------

    /// Register a script/tool that YiYi has created.
    pub fn register_code(
        &self,
        name: &str,
        path: &str,
        description: &str,
        language: &str,
        invoke_hint: Option<&str>,
        skill_name: Option<&str>,
    ) -> Result<String, String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let id = uuid::Uuid::new_v4().to_string();
        let now = super::now_ts();

        // Atomic UPSERT: INSERT or UPDATE on name conflict (no race condition)
        conn.execute(
            "INSERT INTO code_registry (id, name, path, description, language, invoke_hint, skill_name, run_count, success_count, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 0, ?8, ?9)
             ON CONFLICT(name) DO UPDATE SET
               path = excluded.path,
               description = excluded.description,
               language = excluded.language,
               invoke_hint = excluded.invoke_hint,
               skill_name = excluded.skill_name,
               updated_at = excluded.updated_at",
            params![id, name, path, description, language, invoke_hint, skill_name, now, now],
        ).map_err(|e| format!("Upsert error: {}", e))?;

        // Return the actual id (may be existing or new)
        let actual_id: String = conn
            .query_row("SELECT id FROM code_registry WHERE name = ?1", params![name], |r| r.get(0))
            .map_err(|e| format!("Query error: {}", e))?;
        Ok(actual_id)
    }

    /// Record a script execution result (success or failure with error).
    #[allow(dead_code)]
    pub fn record_code_execution(&self, name: &str, success: bool, error: Option<&str>) {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = super::now_ts();
        if success {
            conn.execute(
                "UPDATE code_registry SET run_count = run_count + 1, success_count = success_count + 1, last_error = NULL, updated_at = ?1 WHERE name = ?2",
                params![now, name],
            ).ok();
        } else {
            conn.execute(
                "UPDATE code_registry SET run_count = run_count + 1, last_error = ?1, updated_at = ?2 WHERE name = ?3",
                params![error.unwrap_or("unknown error"), now, name],
            ).ok();
        }
    }

    /// Record execution by path (more reliable than name matching).
    pub fn record_code_execution_by_path(&self, path: &str, success: bool, error: Option<&str>) {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = super::now_ts();
        // Try exact path match first, then fall back to name match using file stem
        let sql_success = "UPDATE code_registry SET run_count = run_count + 1, success_count = success_count + 1, last_error = NULL, updated_at = ?1 WHERE path = ?2";
        let sql_failure = "UPDATE code_registry SET run_count = run_count + 1, last_error = ?1, updated_at = ?2 WHERE path = ?3";

        let affected = if success {
            conn.execute(sql_success, params![now, path]).unwrap_or(0)
        } else {
            conn.execute(sql_failure, params![error.unwrap_or("unknown"), now, path]).unwrap_or(0)
        };

        // If no path match, try by file stem -- but only if exactly one match exists
        if affected == 0 {
            let stem = std::path::Path::new(path)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("");
            if !stem.is_empty() {
                // Check uniqueness before updating to prevent cross-contamination
                let count: i64 = conn
                    .query_row("SELECT COUNT(*) FROM code_registry WHERE name = ?1", params![stem], |r| r.get(0))
                    .unwrap_or(0);
                if count == 1 {
                    if success {
                        conn.execute(
                            "UPDATE code_registry SET run_count = run_count + 1, success_count = success_count + 1, last_error = NULL, updated_at = ?1 WHERE name = ?2",
                            params![now, stem],
                        ).ok();
                    } else {
                        conn.execute(
                            "UPDATE code_registry SET run_count = run_count + 1, last_error = ?1, updated_at = ?2 WHERE name = ?3",
                            params![error.unwrap_or("unknown"), now, stem],
                        ).ok();
                    }
                }
                // If count > 1, skip to avoid contaminating wrong entry
            }
        }
    }

    /// Search code registry by name or description keywords.
    pub fn search_code_registry(&self, query: &str, limit: usize) -> Vec<CodeRegistryEntry> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let pattern = format!("%{}%", query);
        let mut stmt = match conn.prepare(
            "SELECT name, path, description, language, invoke_hint, skill_name, run_count, success_count, last_error
             FROM code_registry
             WHERE name LIKE ?1 OR description LIKE ?1
             ORDER BY run_count DESC, updated_at DESC
             LIMIT ?2",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map(params![pattern, limit as i64], |row| {
            Ok(CodeRegistryEntry {
                name: row.get(0)?,
                path: row.get(1)?,
                description: row.get(2)?,
                language: row.get(3)?,
                invoke_hint: row.get(4)?,
                skill_name: row.get(5)?,
                run_count: row.get(6)?,
                success_count: row.get(7)?,
                last_error: row.get(8)?,
            })
        })
        .ok()
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
    }

    /// List all registered code entries.
    #[allow(dead_code)]
    pub fn list_code_registry(&self) -> Vec<CodeRegistryEntry> {
        self.search_code_registry("", 100)
    }

    // ---- Meditation Sessions ----

    pub fn create_meditation_session(&self, id: &str) {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = super::now_ts();
        conn.execute(
            "INSERT INTO meditation_sessions (id, started_at, status) VALUES (?1, ?2, 'running')",
            params![id, now],
        )
        .ok();
    }

    pub fn update_meditation_session(
        &self,
        id: &str,
        status: &str,
        sessions_reviewed: i32,
        memories_updated: i32,
        principles_changed: i32,
        memories_archived: i32,
        journal: Option<&str>,
        error: Option<&str>,
    ) {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = super::now_ts();
        conn.execute(
            "UPDATE meditation_sessions SET
                status = ?2,
                finished_at = ?3,
                sessions_reviewed = ?4,
                memories_updated = ?5,
                principles_changed = ?6,
                memories_archived = ?7,
                journal = ?8,
                error = ?9
             WHERE id = ?1",
            params![id, status, now, sessions_reviewed, memories_updated, principles_changed, memories_archived, journal, error],
        )
        .ok();
    }

    pub fn get_latest_meditation_session(&self) -> Option<MeditationSession> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = conn
            .prepare(
                "SELECT id, started_at, finished_at, status, sessions_reviewed,
                        memories_updated, principles_changed, memories_archived, journal, error,
                        depth, phases_completed, tomorrow_intentions, growth_synthesis
                 FROM meditation_sessions ORDER BY started_at DESC LIMIT 1",
            )
            .ok()?;
        stmt.query_row([], |row| {
            Ok(MeditationSession {
                id: row.get(0)?,
                started_at: row.get(1)?,
                finished_at: row.get(2)?,
                status: row.get(3)?,
                sessions_reviewed: row.get(4)?,
                memories_updated: row.get(5)?,
                principles_changed: row.get(6)?,
                memories_archived: row.get(7)?,
                journal: row.get(8)?,
                error: row.get(9)?,
                depth: row.get(10).ok().flatten(),
                phases_completed: row.get(11).ok().flatten(),
                tomorrow_intentions: row.get(12).ok().flatten(),
                growth_synthesis: row.get(13).ok().flatten(),
            })
        })
        .optional()
        .ok()?
    }

    /// Get the latest meditation session that is NOT currently running.
    /// Used to determine the "since" timestamp for a new meditation session.
    pub fn get_latest_completed_meditation_session(&self) -> Option<MeditationSession> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = conn
            .prepare(
                "SELECT id, started_at, finished_at, status, sessions_reviewed,
                        memories_updated, principles_changed, memories_archived, journal, error,
                        depth, phases_completed, tomorrow_intentions, growth_synthesis
                 FROM meditation_sessions WHERE status != 'running' ORDER BY started_at DESC LIMIT 1",
            )
            .ok()?;
        stmt.query_row([], |row| {
            Ok(MeditationSession {
                id: row.get(0)?,
                started_at: row.get(1)?,
                finished_at: row.get(2)?,
                status: row.get(3)?,
                sessions_reviewed: row.get(4)?,
                memories_updated: row.get(5)?,
                principles_changed: row.get(6)?,
                memories_archived: row.get(7)?,
                journal: row.get(8)?,
                error: row.get(9)?,
                depth: row.get(10).ok().flatten(),
                phases_completed: row.get(11).ok().flatten(),
                tomorrow_intentions: row.get(12).ok().flatten(),
                growth_synthesis: row.get(13).ok().flatten(),
            })
        })
        .optional()
        .ok()?
    }

    /// List recent meditation sessions (completed or failed, not running).
    pub fn list_meditation_sessions(&self, limit: usize) -> Vec<MeditationSession> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = match conn.prepare(
            "SELECT id, started_at, finished_at, status, sessions_reviewed,
                    memories_updated, principles_changed, memories_archived, journal, error,
                    depth, phases_completed, tomorrow_intentions, growth_synthesis
             FROM meditation_sessions WHERE status != 'running'
             ORDER BY started_at DESC LIMIT ?1",
        ) {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        stmt.query_map(params![limit as i64], |row| {
            Ok(MeditationSession {
                id: row.get(0)?,
                started_at: row.get(1)?,
                finished_at: row.get(2)?,
                status: row.get(3)?,
                sessions_reviewed: row.get(4)?,
                memories_updated: row.get(5)?,
                principles_changed: row.get(6)?,
                memories_archived: row.get(7)?,
                journal: row.get(8)?,
                error: row.get(9)?,
                depth: row.get(10).ok().flatten(),
                phases_completed: row.get(11).ok().flatten(),
                tomorrow_intentions: row.get(12).ok().flatten(),
                growth_synthesis: row.get(13).ok().flatten(),
            })
        })
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
    }

    /// Get today's chat messages for meditation review: (session_id, role, content)
    pub fn get_today_sessions_messages(&self) -> Vec<(String, String, String)> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        // Calculate start of today in milliseconds
        let today_start = {
            let now = chrono::Local::now();
            let start_of_day = now.date_naive().and_hms_opt(0, 0, 0).unwrap();
            let local_start = chrono::Local
                .from_local_datetime(&start_of_day)
                .unwrap();
            local_start.timestamp_millis()
        };
        let mut stmt = match conn.prepare(
            "SELECT m.session_id, m.role, m.content
             FROM messages m
             WHERE m.timestamp >= ?1
             ORDER BY m.timestamp ASC",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map(params![today_start], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|r| r.map_err(|e| log::warn!("Row parse error: {}", e)).ok())
        .collect()
    }

    /// Get corrections with confidence >= threshold
    pub fn get_high_confidence_corrections(&self, limit: usize, min_confidence: f64) -> Vec<(String, Option<String>, String, f64)> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = match conn.prepare(
            "SELECT trigger_pattern, wrong_behavior, correct_behavior, confidence
             FROM corrections WHERE active = 1 AND confidence >= ?1
             ORDER BY confidence DESC, created_at DESC LIMIT ?2",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map(params![min_confidence, limit as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, f64>(3).unwrap_or(0.80),
            ))
        })
        .ok()
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
    }

    /// Update meditation session with extended V2 fields
    #[allow(dead_code)]
    pub fn update_meditation_extended(
        &self,
        id: &str,
        depth: &str,
        phases_completed: &str,
        tomorrow_intentions: Option<&str>,
        growth_synthesis: Option<&str>,
    ) {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "UPDATE meditation_sessions SET depth = ?1, phases_completed = ?2, tomorrow_intentions = ?3, growth_synthesis = ?4 WHERE id = ?5",
            params![depth, phases_completed, tomorrow_intentions, growth_synthesis, id],
        )
        .ok();
    }

    // -----------------------------------------------------------------------
    // Buddy Decision Log
    // -----------------------------------------------------------------------

    /// Log a buddy delegation decision.
    pub fn log_buddy_decision(
        &self,
        id: &str,
        question: &str,
        context: &str,
        answer: &str,
        confidence: f64,
    ) {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = super::now_ts();
        conn.execute(
            "INSERT OR REPLACE INTO buddy_decisions (id, question, context, buddy_answer, buddy_confidence, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, question, context, answer, confidence, now],
        )
        .ok();
    }

    /// Record user feedback on a buddy decision.
    pub fn set_decision_feedback(&self, id: &str, feedback: &str) {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "UPDATE buddy_decisions SET user_feedback = ?1 WHERE id = ?2",
            params![feedback, id],
        )
        .ok();
    }

    /// List recent buddy decisions.
    pub fn list_buddy_decisions(&self, limit: usize) -> Vec<BuddyDecision> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = match conn.prepare(
            "SELECT id, question, context, buddy_answer, buddy_confidence, user_feedback, created_at
             FROM buddy_decisions ORDER BY created_at DESC LIMIT ?1",
        ) {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        stmt.query_map(params![limit as i64], |row| {
            Ok(BuddyDecision {
                id: row.get(0)?,
                question: row.get(1)?,
                context: row.get(2)?,
                buddy_answer: row.get(3)?,
                buddy_confidence: row.get(4)?,
                user_feedback: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
    }

    /// Calculate trust statistics from decision history.
    pub fn get_trust_stats(&self) -> TrustStats {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());

        // Overall counts (single query)
        let (total, good, bad) = conn
            .query_row(
                "SELECT COUNT(*),
                        SUM(CASE WHEN user_feedback = 'good' THEN 1 ELSE 0 END),
                        SUM(CASE WHEN user_feedback = 'bad' THEN 1 ELSE 0 END)
                 FROM buddy_decisions",
                [],
                |r| Ok((r.get::<_, u32>(0)?, r.get::<_, u32>(1).unwrap_or(0), r.get::<_, u32>(2).unwrap_or(0))),
            )
            .unwrap_or((0, 0, 0));
        let rated = good + bad;
        let accuracy = if rated > 0 { good as f64 / rated as f64 } else { 0.5 };

        // Per-context breakdown
        let mut by_context = std::collections::HashMap::new();
        if let Ok(mut stmt) = conn.prepare(
            "SELECT context,
                    COUNT(*) as total,
                    SUM(CASE WHEN user_feedback = 'good' THEN 1 ELSE 0 END) as good,
                    SUM(CASE WHEN user_feedback = 'bad' THEN 1 ELSE 0 END) as bad
             FROM buddy_decisions GROUP BY context"
        ) {
            if let Ok(rows) = stmt.query_map([], |row| {
                let ctx: String = row.get(0)?;
                let t: u32 = row.get(1)?;
                let g: u32 = row.get(2)?;
                let b: u32 = row.get(3)?;
                let r = g + b;
                Ok((ctx, ContextTrust {
                    total: t,
                    good: g,
                    bad: b,
                    accuracy: if r > 0 { g as f64 / r as f64 } else { 0.5 },
                }))
            }) {
                for row in rows.flatten() {
                    by_context.insert(row.0, row.1);
                }
            }
        }

        TrustStats {
            total,
            good,
            bad,
            pending: total - good - bad,
            accuracy,
            by_context,
        }
    }

    // -----------------------------------------------------------------------
    // Personality Signals (Buddy personality evolution)
    // -----------------------------------------------------------------------

    pub fn add_personality_signals(
        &self,
        signals: &[PersonalitySignal],
        meditation_session_id: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = chrono::Utc::now().to_rfc3339();
        let tx = conn.unchecked_transaction()
            .map_err(|e| format!("Failed to start transaction: {}", e))?;
        for sig in signals {
            tx.execute(
                "INSERT INTO personality_signals (trait, delta, evidence, memory_id, meditation_session_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![sig.trait_name, sig.delta, sig.evidence, sig.memory_id, meditation_session_id, now],
            ).map_err(|e| format!("Failed to insert personality_signal: {}", e))?;
        }
        tx.commit().map_err(|e| format!("Failed to commit signals: {}", e))?;
        invalidate_personality_cache();
        Ok(())
    }

    /// Aggregate personality stats using time-decayed weighted sum (single query, cached).
    /// Cache expires after 60 seconds or when invalidated by `invalidate_personality_cache()`.
    pub fn get_personality_aggregates(&self) -> Vec<(String, f64)> {
        // Check cache first (avoids DB query on every prompt build)
        if let Ok(guard) = get_personality_cache().lock() {
            if let Some((ts, cached)) = guard.as_ref() {
                if ts.elapsed().as_secs() < 60 {
                    return cached.clone();
                }
            }
        }

        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = chrono::Utc::now();

        // Single query for all traits
        let mut stmt = match conn.prepare(
            "SELECT trait, delta, created_at FROM personality_signals ORDER BY created_at ASC"
        ) {
            Ok(s) => s,
            Err(_) => {
                return ["energy", "warmth", "mischief", "wit", "sass"]
                    .iter().map(|t| (t.to_string(), 0.0)).collect();
            }
        };

        let rows: Vec<(String, f64, String)> = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?, row.get::<_, String>(2)?))
            })
            .ok()
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default();

        // Group by trait and compute time-decayed weighted sum
        let mut sums: std::collections::HashMap<&str, f64> = std::collections::HashMap::new();
        for (trait_name, delta, created_at_str) in &rows {
            let days_ago = if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(created_at_str) {
                (now - dt.with_timezone(&chrono::Utc)).num_days() as f64
            } else {
                0.0
            };
            // Half-life of 30 days: signals from 30 days ago have half weight
            let weight = (0.5_f64).powf(days_ago / 30.0);
            *sums.entry(trait_name.as_str()).or_insert(0.0) += delta * weight;
        }

        let result: Vec<(String, f64)> = ["energy", "warmth", "mischief", "wit", "sass"]
            .iter()
            .map(|t| (t.to_string(), sums.get(t).copied().unwrap_or(0.0).clamp(-50.0, 50.0)))
            .collect();

        // Store in cache
        if let Ok(mut guard) = get_personality_cache().lock() {
            *guard = Some((std::time::Instant::now(), result.clone()));
        }

        result
    }

    /// Get recent personality signals for timeline display.
    pub fn list_personality_signals(&self, limit: i64) -> Vec<PersonalitySignalRow> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = match conn.prepare(
            "SELECT id, trait, delta, evidence, memory_id, created_at
             FROM personality_signals ORDER BY created_at DESC LIMIT ?1"
        ) {
            Ok(s) => s,
            Err(_) => return vec![],
        };

        stmt.query_map(params![limit], |row| {
            Ok(PersonalitySignalRow {
                id: row.get(0)?,
                trait_name: row.get(1)?,
                delta: row.get(2)?,
                evidence: row.get(3)?,
                memory_id: row.get(4)?,
                created_at: row.get(5)?,
            })
        })
        .ok()
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
    }

    // -----------------------------------------------------------------------
    // 闪光记忆 (Sparkling Memories)
    // -----------------------------------------------------------------------

    pub fn toggle_sparkling_memory(&self, memory_id: &str, sparkling: bool) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "UPDATE memories SET is_sparkling = ?1 WHERE id = ?2",
            params![sparkling as i32, memory_id],
        ).map_err(|e| format!("Failed to toggle sparkling: {}", e))?;
        Ok(())
    }

    pub fn list_sparkling_memories(&self) -> Vec<SparklingMemory> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = match conn.prepare(
            "SELECT id, content, category, created_at FROM memories WHERE is_sparkling = 1 ORDER BY created_at DESC"
        ) {
            Ok(s) => s,
            Err(_) => return vec![],
        };

        stmt.query_map([], |row| {
            Ok(SparklingMemory {
                id: row.get(0)?,
                content: row.get(1)?,
                category: row.get(2)?,
                created_at: row.get(3)?,
            })
        })
        .ok()
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
    }

    /// Get stale memories eligible for recall bubble ("还记得那天...").
    /// Returns memories older than 7 days with importance >= 0.6.
    pub fn get_recall_candidates(&self, limit: i64) -> Vec<RecallCandidate> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let seven_days_ago = chrono::Utc::now().timestamp() - (7 * 24 * 3600);
        let mut stmt = match conn.prepare(
            "SELECT id, content, category, confidence, created_at FROM memories
             WHERE created_at < ?1 AND confidence >= 0.6
             ORDER BY RANDOM() LIMIT ?2"
        ) {
            Ok(s) => s,
            Err(_) => return vec![],
        };

        stmt.query_map(params![seven_days_ago, limit], |row| {
            Ok(RecallCandidate {
                id: row.get(0)?,
                content: row.get(1)?,
                category: row.get(2)?,
                confidence: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .ok()
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
    }
}
