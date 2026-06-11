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
    /// S2:该群的隔离项目工作区绝对路径。`Some` = 这是个"项目群"(如软件公司团队),
    /// 成员的文件/shell 工具落在这个目录;`None` = 普通群,回落用户默认工作区。
    #[serde(default)]
    pub workspace_path: Option<String>,
}

fn map_group_row(row: &rusqlite::Row) -> rusqlite::Result<CompanionGroup> {
    Ok(CompanionGroup {
        id: row.get(0)?,
        name: row.get(1)?,
        emoji: row.get(2)?,
        color_hex: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        workspace_path: row.get(6)?,
    })
}

const GROUP_COLS: &str = "id, name, emoji, color_hex, created_at, updated_at, workspace_path";

/// JOIN 拉成员时用的 companions 列别名 —— 与 `super::companions::map_row` 的
/// `row.get(0..15)` 顺序一一对应。改 companions 表 schema 时务必同步这里。
const COMPANION_COLS_C: &str =
    "c.id, c.name, c.agent_definition_name, c.avatar_emoji, c.color_hex, \
     c.persona_md_path, c.memory_user_id, c.adopted_at, c.retired_at, \
     c.personality_stats_json, c.invocation_count, c.last_used_at, \
     c.metadata_json, c.role_label, c.meditation_enabled, c.meditation_time, c.kind";

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

    /// 设置/更新群的项目工作区路径(S2 步骤①:成团后建好隔离目录再回填)。
    pub fn set_group_workspace(&self, group_id: i64, workspace_path: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let now = super::now_ts();
        conn.execute(
            "UPDATE companion_groups SET workspace_path = ?1, updated_at = ?2 WHERE id = ?3",
            params![workspace_path, now, group_id],
        )
        .map_err(|e| format!("set_group_workspace: {}", e))?;
        Ok(())
    }

    /// 解析某次协作所属群的项目工作区:collab → chat_session → group → workspace_path。
    /// 链路任一环缺失(普通群 / 单聊 / 无工作区)→ None。run_one_react 据此决定是否
    /// 把成员的文件 / shell 工具 scope 到隔离项目目录。
    pub fn group_workspace_for_collaboration(&self, collab_id: i64) -> Option<String> {
        let session_id: String = {
            let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
            conn.query_row(
                "SELECT chat_session_id FROM collaborations WHERE id = ?1",
                params![collab_id],
                |row| row.get(0),
            )
            .ok()?
        };
        let group_id = self.get_session_group(&session_id)?;
        self.get_companion_group(group_id)?.workspace_path
    }

    /// 按项目工作区绝对路径找团队(项目复用):同一文件夹已绑过团队 → 返回其 group_id。
    /// 「项目优先」的新建工作据此在选了已有文件夹时复用同支团队,不重复组队。命中多个取最早建的。
    pub fn find_group_by_workspace(&self, workspace_path: &str) -> Option<i64> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT id FROM companion_groups WHERE workspace_path = ?1 ORDER BY created_at ASC LIMIT 1",
            params![workspace_path],
            |row| row.get(0),
        )
        .ok()
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
        // 必须 SELECT 全列(含 workspace_path)——map_group_row 读 7 列(idx 6 = workspace_path),
        // 漏列会让每行 row.get(6) 越界报错、被下面的 filter_map(r.ok()) 静默丢弃 → 整表返回空。
        // 用 GROUP_COLS 单一真相防再漂(其列在本 JOIN 里都只属 companion_groups,无歧义)。
        let sql = format!(
            "SELECT {GROUP_COLS} \
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

#[cfg(all(test, feature = "test-support"))]
mod tests {
    use crate::test_support::TempDb;
    use serial_test::serial;

    /// 插一行最小 collaboration 指向某会话,返回 collab_id。
    fn insert_collab(db: &crate::engine::db::Database, session_id: &str) -> i64 {
        let conn = db.get_conn().unwrap();
        conn.execute(
            "INSERT INTO collaborations \
             (chat_session_id, intent, mode_json, status, plan_json, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![session_id, "做个 app", "{}", "running", "{}", 1_700_000_000_000i64],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    #[test]
    #[serial]
    fn workspace_path_round_trips_through_set_and_get() {
        let t = TempDb::new();
        let db = t.db();
        let gid = db.create_companion_group("软件公司", Some("🏢"), Some("#fff")).unwrap();
        // 新建群默认无工作区。
        assert_eq!(db.get_companion_group(gid).unwrap().workspace_path, None);
        // 设置后读得回。
        db.set_group_workspace(gid, "/tmp/yiyi-proj").unwrap();
        assert_eq!(
            db.get_companion_group(gid).unwrap().workspace_path,
            Some("/tmp/yiyi-proj".to_string())
        );
    }

    #[test]
    #[serial]
    fn resolver_walks_collab_to_session_to_group_workspace() {
        let t = TempDb::new();
        let db = t.db();

        // 项目群:有工作区,会话绑它,一行 collab 指向该会话。
        db.push_message("sess-proj", "user", "做个 app").unwrap();
        let gid = db.create_companion_group("软件公司", Some("🏢"), Some("#fff")).unwrap();
        db.set_group_workspace(gid, "/tmp/yiyi-proj-ws").unwrap();
        db.set_session_group("sess-proj", Some(gid)).unwrap();
        let collab = insert_collab(&db, "sess-proj");
        assert_eq!(
            db.group_workspace_for_collaboration(collab),
            Some("/tmp/yiyi-proj-ws".to_string()),
            "项目群的协作应解析到隔离工作区"
        );

        // 普通群:无工作区 → None(闲聊群不被 scope)。
        db.push_message("sess-casual", "user", "聊聊").unwrap();
        let g2 = db.create_companion_group("创作小队", None, None).unwrap();
        db.set_session_group("sess-casual", Some(g2)).unwrap();
        let c2 = insert_collab(&db, "sess-casual");
        assert_eq!(db.group_workspace_for_collaboration(c2), None, "普通群不应有工作区");

        // 单聊(会话没绑群)→ None。
        db.push_message("sess-solo", "user", "你好").unwrap();
        let c3 = insert_collab(&db, "sess-solo");
        assert_eq!(db.group_workspace_for_collaboration(c3), None, "单聊不应有工作区");
    }
}
