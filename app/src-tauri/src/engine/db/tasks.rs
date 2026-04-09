use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInfo {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub status: String,
    pub session_id: String,
    pub parent_session_id: Option<String>,
    pub plan: Option<String>, // JSON string
    pub current_stage: i32,
    pub total_stages: i32,
    pub progress: f64,
    pub error_message: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub completed_at: Option<i64>,
    #[serde(default = "default_task_type")]
    pub task_type: String,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub last_activity_at: i64,
    pub workspace_path: Option<String>,
}

fn default_task_type() -> String {
    "oneoff".to_string()
}

impl super::Database {
    // --- Tasks CRUD ---

    pub fn create_task(
        &self,
        id: &str,
        title: &str,
        description: Option<&str>,
        status: &str,
        session_id: &str,
        parent_session_id: Option<&str>,
        plan: Option<&str>,
        total_stages: i32,
        created_at: i64,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "INSERT INTO tasks (id, title, description, status, session_id, parent_session_id, plan, total_stages, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
            params![id, title, description, status, session_id, parent_session_id, plan, total_stages, created_at],
        )
        .map_err(|e| format!("Failed to create task: {}", e))?;
        Ok(())
    }

    pub fn update_task_workspace_path(&self, task_id: &str, path: &str) -> Result<(), String> {
        let now = super::now_ts();
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "UPDATE tasks SET workspace_path = ?1, updated_at = ?2 WHERE id = ?3",
            params![path, now, task_id],
        )
        .map_err(|e| format!("Failed to update workspace path: {}", e))?;
        Ok(())
    }

    pub fn search_tasks_by_name(&self, query: &str) -> Result<Option<TaskInfo>, String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let pattern = format!("%{}%", query);
        conn.query_row(
            "SELECT id, title, description, status, session_id, parent_session_id, plan,
                    current_stage, total_stages, progress, error_message,
                    created_at, updated_at, completed_at, task_type, pinned, last_activity_at, workspace_path
             FROM tasks WHERE title LIKE ?1 ORDER BY last_activity_at DESC LIMIT 1",
            params![pattern],
            |row| {
                let pinned_int: i32 = row.get(15)?;
                Ok(TaskInfo {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    description: row.get(2)?,
                    status: row.get(3)?,
                    session_id: row.get(4)?,
                    parent_session_id: row.get(5)?,
                    plan: row.get(6)?,
                    current_stage: row.get(7)?,
                    total_stages: row.get(8)?,
                    progress: row.get(9)?,
                    error_message: row.get(10)?,
                    created_at: row.get(11)?,
                    updated_at: row.get(12)?,
                    completed_at: row.get(13)?,
                    task_type: row.get::<_, Option<String>>(14)?.unwrap_or_else(|| "oneoff".to_string()),
                    pinned: pinned_int != 0,
                    last_activity_at: row.get::<_, Option<i64>>(16)?.unwrap_or(0),
                    workspace_path: row.get(17)?,
                })
            },
        )
        .optional()
        .map_err(|e| format!("Failed to search tasks: {}", e))
    }

    pub fn get_task(&self, task_id: &str) -> Result<Option<TaskInfo>, String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT id, title, description, status, session_id, parent_session_id, plan,
                    current_stage, total_stages, progress, error_message,
                    created_at, updated_at, completed_at, task_type, pinned, last_activity_at, workspace_path
             FROM tasks WHERE id = ?1",
            params![task_id],
            |row| {
                let pinned_int: i32 = row.get(15)?;
                Ok(TaskInfo {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    description: row.get(2)?,
                    status: row.get(3)?,
                    session_id: row.get(4)?,
                    parent_session_id: row.get(5)?,
                    plan: row.get(6)?,
                    current_stage: row.get(7)?,
                    total_stages: row.get(8)?,
                    progress: row.get(9)?,
                    error_message: row.get(10)?,
                    created_at: row.get(11)?,
                    updated_at: row.get(12)?,
                    completed_at: row.get(13)?,
                    task_type: row.get::<_, Option<String>>(14)?.unwrap_or_else(|| "oneoff".to_string()),
                    pinned: pinned_int != 0,
                    last_activity_at: row.get::<_, Option<i64>>(16)?.unwrap_or(0),
                    workspace_path: row.get(17)?,
                })
            },
        )
        .optional()
        .map_err(|e| format!("Failed to get task: {}", e))
    }

    pub fn list_tasks(
        &self,
        parent_session_id: Option<&str>,
        status: Option<&str>,
    ) -> Result<Vec<TaskInfo>, String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());

        let mut sql = String::from(
            "SELECT id, title, description, status, session_id, parent_session_id, plan,
                    current_stage, total_stages, progress, error_message,
                    created_at, updated_at, completed_at, task_type, pinned, last_activity_at, workspace_path
             FROM tasks WHERE 1=1"
        );
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(pid) = parent_session_id {
            sql.push_str(&format!(" AND parent_session_id = ?{}", param_values.len() + 1));
            param_values.push(Box::new(pid.to_string()));
        }
        if let Some(st) = status {
            sql.push_str(&format!(" AND status = ?{}", param_values.len() + 1));
            param_values.push(Box::new(st.to_string()));
        }
        sql.push_str(" ORDER BY created_at DESC");

        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            param_values.iter().map(|p| p.as_ref()).collect();

        let mut stmt = conn.prepare(&sql).map_err(|e| format!("Query error: {}", e))?;
        let tasks = stmt
            .query_map(param_refs.as_slice(), |row| {
                let pinned_int: i32 = row.get(15)?;
                Ok(TaskInfo {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    description: row.get(2)?,
                    status: row.get(3)?,
                    session_id: row.get(4)?,
                    parent_session_id: row.get(5)?,
                    plan: row.get(6)?,
                    current_stage: row.get(7)?,
                    total_stages: row.get(8)?,
                    progress: row.get(9)?,
                    error_message: row.get(10)?,
                    created_at: row.get(11)?,
                    updated_at: row.get(12)?,
                    completed_at: row.get(13)?,
                    task_type: row.get::<_, Option<String>>(14)?.unwrap_or_else(|| "oneoff".to_string()),
                    pinned: pinned_int != 0,
                    last_activity_at: row.get::<_, Option<i64>>(16)?.unwrap_or(0),
                    workspace_path: row.get(17)?,
                })
            })
            .map_err(|e| format!("Query error: {}", e))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(tasks)
    }

    pub fn update_task_status(&self, task_id: &str, status: &str) -> Result<(), String> {
        let now = super::now_ts();
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let completed_at: Option<i64> = if status == "completed" || status == "cancelled" {
            Some(now)
        } else {
            None
        };
        conn.execute(
            "UPDATE tasks SET status = ?1, updated_at = ?2, last_activity_at = ?2, completed_at = COALESCE(?3, completed_at) WHERE id = ?4",
            params![status, now, completed_at, task_id],
        )
        .map_err(|e| format!("Failed to update task status: {}", e))?;
        Ok(())
    }

    pub fn update_task_progress(
        &self,
        task_id: &str,
        current_stage: i32,
        total_stages: i32,
        progress: f64,
    ) -> Result<(), String> {
        let now = super::now_ts();
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "UPDATE tasks SET current_stage = ?1, total_stages = ?2, progress = ?3, updated_at = ?4, last_activity_at = ?4 WHERE id = ?5",
            params![current_stage, total_stages, progress, now, task_id],
        )
        .map_err(|e| format!("Failed to update task progress: {}", e))?;
        Ok(())
    }

    pub fn update_task_error(
        &self,
        task_id: &str,
        status: &str,
        error_message: &str,
    ) -> Result<(), String> {
        let now = super::now_ts();
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "UPDATE tasks SET status = ?1, error_message = ?2, updated_at = ?3 WHERE id = ?4",
            params![status, error_message, now, task_id],
        )
        .map_err(|e| format!("Failed to update task error: {}", e))?;
        Ok(())
    }

    pub fn pin_task(&self, task_id: &str, pinned: bool) -> Result<(), String> {
        let now = super::now_ts();
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "UPDATE tasks SET pinned = ?1, last_activity_at = ?2, updated_at = ?2 WHERE id = ?3",
            params![pinned as i32, now, task_id],
        )
        .map_err(|e| format!("Failed to pin task: {}", e))?;
        Ok(())
    }

    pub fn delete_task(&self, task_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        // Get the session_id for this task so we can cascade-delete the session
        let session_id: Option<String> = conn
            .query_row(
                "SELECT session_id FROM tasks WHERE id = ?1",
                params![task_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("Failed to find task: {}", e))?;

        conn.execute("DELETE FROM tasks WHERE id = ?1", params![task_id])
            .map_err(|e| format!("Failed to delete task: {}", e))?;

        // Delete associated session (messages will cascade)
        if let Some(sid) = session_id {
            conn.execute("DELETE FROM messages WHERE session_id = ?1", params![sid])
                .map_err(|e| format!("Failed to delete task messages: {}", e))?;
            conn.execute("DELETE FROM sessions WHERE id = ?1", params![sid])
                .map_err(|e| format!("Failed to delete task session: {}", e))?;
        }

        Ok(())
    }
}
