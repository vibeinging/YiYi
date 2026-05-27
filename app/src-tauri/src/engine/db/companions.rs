//! Companions CRUD — user-adopted agent instances.
//!
//! A `companion` row represents the relationship between the user and an
//! agent role. The role itself lives in an `AgentDefinition` (parsed from
//! AGENT.md); a companion is the user's *instance* of that role, with their
//! own name, avatar, persona overrides, and memory bucket. One agent
//! definition can spawn multiple companions (e.g. two "code reviewers" with
//! different personalities).
//!
//! See `docs/design/2026-05-15_companions-system.md` for the broader design.

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

/// Full companion row.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Companion {
    pub id: i64,
    /// 用户起的名字（如「阿狸」），全局唯一。
    pub name: String,
    /// Slug of the underlying `AgentDefinition` (e.g. "code_reviewer").
    pub agent_definition_name: String,
    pub avatar_emoji: String,
    /// 主色 (e.g. "#F97316").
    pub color_hex: String,
    /// Optional path to a user-edited persona Markdown file.
    pub persona_md_path: Option<String>,
    /// MemMe user_id used to isolate this companion's memories.
    pub memory_user_id: String,
    pub adopted_at: i64,
    /// `None` = active; `Some(ts)` = retired (soft-deleted, awaiting GC).
    pub retired_at: Option<i64>,
    /// Phase 2: personality stats JSON. NULL in Phase 1.
    pub personality_stats_json: Option<String>,
    pub invocation_count: i64,
    pub last_used_at: Option<i64>,
    pub metadata_json: Option<String>,
    /// Human-readable role label shown in the UI (e.g. "小红书爆款写手").
    /// Decoupled from `agent_definition_name` which is just the underlying
    /// tool-permission template. Old rows may have `None`; the frontend
    /// falls back to a template-derived label in that case.
    pub role_label: Option<String>,
}

/// New companion payload for `adopt_companion`. Fields not listed default
/// at the DB level or are filled by the impl (id, adopted_at, counts).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewCompanion {
    pub name: String,
    pub agent_definition_name: String,
    pub avatar_emoji: String,
    pub color_hex: String,
    pub persona_md_path: Option<String>,
    pub memory_user_id: String,
    pub metadata_json: Option<String>,
    pub role_label: Option<String>,
}

/// Partial update payload for `update_companion`. Each `Some` is applied;
/// each `None` leaves the field unchanged.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CompanionUpdate {
    pub name: Option<String>,
    pub avatar_emoji: Option<String>,
    pub color_hex: Option<String>,
    pub persona_md_path: Option<Option<String>>,
    pub personality_stats_json: Option<Option<String>>,
    pub metadata_json: Option<Option<String>>,
    pub role_label: Option<Option<String>>,
}

fn map_row(row: &rusqlite::Row) -> rusqlite::Result<Companion> {
    Ok(Companion {
        id: row.get(0)?,
        name: row.get(1)?,
        agent_definition_name: row.get(2)?,
        avatar_emoji: row.get(3)?,
        color_hex: row.get(4)?,
        persona_md_path: row.get(5)?,
        memory_user_id: row.get(6)?,
        adopted_at: row.get(7)?,
        retired_at: row.get(8)?,
        personality_stats_json: row.get(9)?,
        invocation_count: row.get(10)?,
        last_used_at: row.get(11)?,
        metadata_json: row.get(12)?,
        role_label: row.get(13)?,
    })
}

const SELECT_COLS: &str =
    "id, name, agent_definition_name, avatar_emoji, color_hex, persona_md_path, \
     memory_user_id, adopted_at, retired_at, personality_stats_json, \
     invocation_count, last_used_at, metadata_json, role_label";

impl super::Database {
    /// Adopt a new companion. Returns the newly assigned id.
    /// Errors if `name` or `memory_user_id` is not unique.
    pub fn adopt_companion(&self, new: &NewCompanion) -> Result<i64, String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = super::now_ts();
        conn.execute(
            "INSERT INTO companions
                (name, agent_definition_name, avatar_emoji, color_hex, persona_md_path,
                 memory_user_id, adopted_at, invocation_count, metadata_json, role_label)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9)",
            params![
                new.name,
                new.agent_definition_name,
                new.avatar_emoji,
                new.color_hex,
                new.persona_md_path,
                new.memory_user_id,
                now,
                new.metadata_json,
                new.role_label,
            ],
        )
        .map_err(|e| format!("adopt_companion: {}", e))?;
        Ok(conn.last_insert_rowid())
    }

    pub fn get_companion(&self, id: i64) -> Option<Companion> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            &format!("SELECT {} FROM companions WHERE id = ?1", SELECT_COLS),
            params![id],
            map_row,
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn get_companion_by_name(&self, name: &str) -> Option<Companion> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            &format!("SELECT {} FROM companions WHERE name = ?1", SELECT_COLS),
            params![name],
            map_row,
        )
        .optional()
        .ok()
        .flatten()
    }

    /// Active companions (retired_at IS NULL), most recently used first.
    pub fn list_active_companions(&self) -> Vec<Companion> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = match conn.prepare(&format!(
            "SELECT {} FROM companions
             WHERE retired_at IS NULL
             ORDER BY COALESCE(last_used_at, adopted_at) DESC, id DESC",
            SELECT_COLS
        )) {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        stmt.query_map([], map_row)
            .map(|it| it.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
    }

    /// Retired companions still within their GC window.
    pub fn list_retired_companions(&self) -> Vec<Companion> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = match conn.prepare(&format!(
            "SELECT {} FROM companions
             WHERE retired_at IS NOT NULL
             ORDER BY retired_at DESC",
            SELECT_COLS
        )) {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        stmt.query_map([], map_row)
            .map(|it| it.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
    }

    /// Apply a partial update. Returns `true` if a row was changed.
    pub fn update_companion(&self, id: i64, upd: &CompanionUpdate) -> Result<bool, String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut sets: Vec<&str> = Vec::new();
        let mut vals: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(v) = &upd.name {
            sets.push("name = ?");
            vals.push(Box::new(v.clone()));
        }
        if let Some(v) = &upd.avatar_emoji {
            sets.push("avatar_emoji = ?");
            vals.push(Box::new(v.clone()));
        }
        if let Some(v) = &upd.color_hex {
            sets.push("color_hex = ?");
            vals.push(Box::new(v.clone()));
        }
        if let Some(v) = &upd.persona_md_path {
            sets.push("persona_md_path = ?");
            vals.push(Box::new(v.clone()));
        }
        if let Some(v) = &upd.personality_stats_json {
            sets.push("personality_stats_json = ?");
            vals.push(Box::new(v.clone()));
        }
        if let Some(v) = &upd.metadata_json {
            sets.push("metadata_json = ?");
            vals.push(Box::new(v.clone()));
        }
        if let Some(v) = &upd.role_label {
            sets.push("role_label = ?");
            vals.push(Box::new(v.clone()));
        }
        if sets.is_empty() {
            return Ok(false);
        }
        let sql = format!("UPDATE companions SET {} WHERE id = ?", sets.join(", "));
        vals.push(Box::new(id));
        let params_slice: Vec<&dyn rusqlite::ToSql> = vals.iter().map(|b| b.as_ref()).collect();
        let affected = conn
            .execute(&sql, rusqlite::params_from_iter(params_slice))
            .map_err(|e| format!("update_companion: {}", e))?;
        Ok(affected > 0)
    }

    /// Soft-retire: mark `retired_at` to now. The companion stops appearing
    /// in active listings but is preserved for 30 days before GC.
    pub fn retire_companion(&self, id: i64) -> Result<bool, String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = super::now_ts();
        let affected = conn
            .execute(
                "UPDATE companions SET retired_at = ?1 WHERE id = ?2 AND retired_at IS NULL",
                params![now, id],
            )
            .map_err(|e| format!("retire_companion: {}", e))?;
        Ok(affected > 0)
    }

    /// Permanently remove a companion. Caller is responsible for cleaning up
    /// the companion's MemMe bucket separately.
    pub fn hard_delete_companion(&self, id: i64) -> Result<bool, String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let affected = conn
            .execute("DELETE FROM companions WHERE id = ?1", params![id])
            .map_err(|e| format!("hard_delete_companion: {}", e))?;
        Ok(affected > 0)
    }

    /// Bump `invocation_count` and `last_used_at`. Idempotent (always +1).
    pub fn increment_companion_invocation(&self, id: i64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = super::now_ts();
        conn.execute(
            "UPDATE companions
                SET invocation_count = invocation_count + 1, last_used_at = ?1
                WHERE id = ?2",
            params![now, id],
        )
        .map(|_| ())
        .map_err(|e| format!("increment_companion_invocation: {}", e))
    }

    /// Hard-delete companions retired for ≥ `max_age_days`. Returns the list
    /// of `memory_user_id`s that were just GC'd so callers can clean up the
    /// matching MemMe buckets atomically.
    ///
    /// Idempotent — designed for the idle-tick maintenance loop, mirroring
    /// `archive_stale_inbox_items`.
    pub fn gc_retired_companions(&self, max_age_days: i64) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let cutoff = super::now_ts() - max_age_days * 86_400_000;
        // Collect memory_user_ids first so we can return them.
        let mut stmt = conn
            .prepare(
                "SELECT memory_user_id FROM companions
                 WHERE retired_at IS NOT NULL AND retired_at < ?1",
            )
            .map_err(|e| format!("gc_retired_companions(prepare): {}", e))?;
        let user_ids: Vec<String> = stmt
            .query_map(params![cutoff], |r| r.get::<_, String>(0))
            .map_err(|e| format!("gc_retired_companions(query): {}", e))?
            .filter_map(|r| r.ok())
            .collect();
        drop(stmt);
        if user_ids.is_empty() {
            return Ok(Vec::new());
        }
        conn.execute(
            "DELETE FROM companions WHERE retired_at IS NOT NULL AND retired_at < ?1",
            params![cutoff],
        )
        .map_err(|e| format!("gc_retired_companions(delete): {}", e))?;
        Ok(user_ids)
    }
}
