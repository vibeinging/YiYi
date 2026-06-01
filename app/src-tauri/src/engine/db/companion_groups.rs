//! Companion groups (群) —— 持久化的"群聊式"分身分组。
//!
//! 多对多关系:一个 companion 可同时在多个组（类比微信群）。每组对应一个
//! `group_shared_<id>` 记忆桶,通过 `MemoryScope::Group(id)` 路由,与
//! 别的组互不可见。Phase A 的"全 active 隐式群 + 单一 family_shared 桶"作为
//! 回落保留（session.group_id IS NULL 时生效）。
//!
//! 详见 docs/design/2026-05-27_群会话-host调度群聊.md Approach B。

use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::Companion;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompanionGroup {
    pub id: i64,
    pub name: String,
    pub emoji: Option<String>,
    pub color_hex: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

fn map_group_row(row: &rusqlite::Row) -> rusqlite::Result<CompanionGroup> {
    Ok(CompanionGroup {
        id: row.get(0)?,
        name: row.get(1)?,
        emoji: row.get(2)?,
        color_hex: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

const GROUP_COLS: &str = "id, name, emoji, color_hex, created_at, updated_at";

/// JOIN 拉成员时用的 companions 列别名 —— 与 `super::companions::map_row` 的
/// `row.get(0..15)` 顺序一一对应。改 companions 表 schema 时务必同步这里。
const COMPANION_COLS_C: &str =
    "c.id, c.name, c.agent_definition_name, c.avatar_emoji, c.color_hex, \
     c.persona_md_path, c.memory_user_id, c.adopted_at, c.retired_at, \
     c.personality_stats_json, c.invocation_count, c.last_used_at, \
     c.metadata_json, c.role_label, c.meditation_enabled, c.meditation_time";

impl super::Database {
    // ── group CRUD ────────────────────────────────────────────────────

    /// 建组,返回新行 id。`name` 不强制 UNIQUE —— 用户可能想要两个叫"创作"的
    /// 组但 emoji/色不同;若需唯一性以后再加。
    pub fn create_companion_group(
        &self,
        name: &str,
        emoji: Option<&str>,
        color_hex: Option<&str>,
    ) -> Result<i64, String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = super::now_ts();
        conn.execute(
            "INSERT INTO companion_groups (name, emoji, color_hex, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![name, emoji, color_hex, now],
        )
        .map_err(|e| format!("create_companion_group: {}", e))?;
        Ok(conn.last_insert_rowid())
    }

    pub fn list_companion_groups(&self) -> Vec<CompanionGroup> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let sql = format!(
            "SELECT {GROUP_COLS} FROM companion_groups ORDER BY created_at DESC"
        );
        let mut stmt = match conn.prepare(&sql) {
            Ok(s) => s,
            Err(e) => {
                log::warn!("list_companion_groups prepare: {}", e);
                return Vec::new();
            }
        };
        stmt.query_map([], map_group_row)
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
    }

    pub fn get_companion_group(&self, id: i64) -> Option<CompanionGroup> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let sql = format!("SELECT {GROUP_COLS} FROM companion_groups WHERE id = ?1");
        conn.query_row(&sql, params![id], map_group_row).ok()
    }

    pub fn update_companion_group(
        &self,
        id: i64,
        name: &str,
        emoji: Option<&str>,
        color_hex: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = super::now_ts();
        conn.execute(
            "UPDATE companion_groups SET name = ?1, emoji = ?2, color_hex = ?3, updated_at = ?4 \
             WHERE id = ?5",
            params![name, emoji, color_hex, now, id],
        )
        .map_err(|e| format!("update_companion_group: {}", e))?;
        Ok(())
    }

    /// 删组 —— 成员关系通过 FK ON DELETE CASCADE 自动清。引用此组的 session
    /// 同步把 group_id 置 NULL（回落 Phase A 隐式群;sessions 表没建 FK 防
    /// 用户改库,这里手工 UPDATE）。**不删** group_shared_<id> 记忆桶,留作
    /// 孤儿桶等用户在 BuddyPanel 手动清——避免误删带来惊讶。
    pub fn delete_companion_group(&self, id: i64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute("DELETE FROM companion_groups WHERE id = ?1", params![id])
            .map_err(|e| format!("delete_companion_group: {}", e))?;
        conn.execute(
            "UPDATE sessions SET group_id = NULL WHERE group_id = ?1",
            params![id],
        )
        .map_err(|e| format!("delete_companion_group (session cleanup): {}", e))?;
        Ok(())
    }

    // ── membership ────────────────────────────────────────────────────

    /// 加成员 —— `INSERT OR IGNORE`,重复加同一对 (group, companion) 不报错。
    pub fn add_group_member(&self, group_id: i64, companion_id: i64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = super::now_ts();
        conn.execute(
            "INSERT OR IGNORE INTO companion_group_members (group_id, companion_id, added_at) \
             VALUES (?1, ?2, ?3)",
            params![group_id, companion_id, now],
        )
        .map_err(|e| format!("add_group_member: {}", e))?;
        Ok(())
    }

    pub fn remove_group_member(&self, group_id: i64, companion_id: i64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "DELETE FROM companion_group_members WHERE group_id = ?1 AND companion_id = ?2",
            params![group_id, companion_id],
        )
        .map_err(|e| format!("remove_group_member: {}", e))?;
        Ok(())
    }

    /// 列出某组的 active 成员(retired 的自动过滤),按加入时间升序。
    pub fn list_group_members(&self, group_id: i64) -> Vec<Companion> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let sql = format!(
            "SELECT {COMPANION_COLS_C} FROM companions c \
             INNER JOIN companion_group_members m ON c.id = m.companion_id \
             WHERE m.group_id = ?1 AND c.retired_at IS NULL \
             ORDER BY m.added_at ASC"
        );
        let mut stmt = match conn.prepare(&sql) {
            Ok(s) => s,
            Err(e) => {
                log::warn!("list_group_members prepare: {}", e);
                return Vec::new();
            }
        };
        stmt.query_map(params![group_id], super::companions::map_row)
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
    }

    /// 反查:某 companion 在哪些组里(UI 的"我所属群"展示用)。
    pub fn list_groups_for_companion(&self, companion_id: i64) -> Vec<CompanionGroup> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let sql = format!(
            "SELECT g.id, g.name, g.emoji, g.color_hex, g.created_at, g.updated_at \
             FROM companion_groups g \
             INNER JOIN companion_group_members m ON g.id = m.group_id \
             WHERE m.companion_id = ?1 \
             ORDER BY g.created_at DESC"
        );
        let mut stmt = match conn.prepare(&sql) {
            Ok(s) => s,
            Err(e) => {
                log::warn!("list_groups_for_companion prepare: {}", e);
                return Vec::new();
            }
        };
        stmt.query_map(params![companion_id], map_group_row)
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
    }

    // ── session ↔ group binding ───────────────────────────────────────

    /// 绑定一次群会话到具体 group(None = 解绑 → 走 Phase A 全 active 回落)。
    pub fn set_session_group(
        &self,
        session_id: &str,
        group_id: Option<i64>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "UPDATE sessions SET group_id = ?1 WHERE id = ?2",
            params![group_id, session_id],
        )
        .map_err(|e| format!("set_session_group: {}", e))?;
        Ok(())
    }

    /// 读 session 当前绑的 group_id。None = 未绑 / session 不存在。
    pub fn get_session_group(&self, session_id: &str) -> Option<i64> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT group_id FROM sessions WHERE id = ?1",
            params![session_id],
            |row| row.get::<_, Option<i64>>(0),
        )
        .ok()
        .flatten()
    }
}
