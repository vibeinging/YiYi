use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionMode {
    Shared,
    Isolated,
}

impl Default for ExecutionMode {
    fn default() -> Self {
        Self::Shared
    }
}

impl std::fmt::Display for ExecutionMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Shared => write!(f, "shared"),
            Self::Isolated => write!(f, "isolated"),
        }
    }
}

impl ExecutionMode {
    pub fn from_str_lossy(s: &str) -> Self {
        match s {
            "isolated" => Self::Isolated,
            _ => Self::Shared,
        }
    }
}

#[derive(Debug, Clone)]
pub struct CronJobRow {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub schedule_json: String,
    pub task_type: String,
    pub text: Option<String>,
    pub request_json: Option<String>,
    pub dispatch_json: Option<String>,
    pub runtime_json: Option<String>,
    /// Execution mode: Shared (default) runs in global context,
    /// Isolated runs in a dedicated cron session with its own history.
    pub execution_mode: ExecutionMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CronJobExecutionRow {
    pub id: i64,
    pub job_id: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub status: String,
    pub result: Option<String>,
    pub trigger_type: String,
}

#[derive(Debug, Clone)]
pub struct HeartbeatRow {
    pub timestamp: i64,
    pub success: bool,
    pub message: Option<String>,
    pub target: String,
}

impl super::Database {
    // === Cron Jobs ===

    pub fn list_cronjobs(&self) -> Result<Vec<CronJobRow>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, name, enabled, schedule_json, task_type, text, request_json, dispatch_json, runtime_json, execution_mode FROM cronjobs")
            .map_err(|e| format!("Query error: {}", e))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(CronJobRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    enabled: row.get(2)?,
                    schedule_json: row.get(3)?,
                    task_type: row.get(4)?,
                    text: row.get(5)?,
                    request_json: row.get(6)?,
                    dispatch_json: row.get(7)?,
                    runtime_json: row.get(8)?,
                    execution_mode: ExecutionMode::from_str_lossy(&row.get::<_, String>(9)?),
                })
            })
            .map_err(|e| format!("Query error: {}", e))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn get_cronjob(&self, id: &str) -> Result<Option<CronJobRow>, String> {
        let conn = self.conn.lock().unwrap();
        let result = conn.query_row(
            "SELECT id, name, enabled, schedule_json, task_type, text, request_json, dispatch_json, runtime_json, execution_mode FROM cronjobs WHERE id = ?1",
            params![id],
            |row| {
                Ok(CronJobRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    enabled: row.get(2)?,
                    schedule_json: row.get(3)?,
                    task_type: row.get(4)?,
                    text: row.get(5)?,
                    request_json: row.get(6)?,
                    dispatch_json: row.get(7)?,
                    runtime_json: row.get(8)?,
                    execution_mode: ExecutionMode::from_str_lossy(&row.get::<_, String>(9)?),
                })
            },
        );
        match result {
            Ok(row) => Ok(Some(row)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("Query error: {}", e)),
        }
    }

    pub fn upsert_cronjob(&self, row: &CronJobRow) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO cronjobs (id, name, enabled, schedule_json, task_type, text, request_json, dispatch_json, runtime_json, execution_mode)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![row.id, row.name, row.enabled, row.schedule_json, row.task_type, row.text, row.request_json, row.dispatch_json, row.runtime_json, row.execution_mode.to_string()],
        )
        .map_err(|e| format!("Failed to save cronjob: {}", e))?;
        Ok(())
    }

    pub fn delete_cronjob(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()
            .map_err(|e| format!("Failed to begin transaction: {}", e))?;
        let session_id = format!("cron:{}", id);
        tx.execute("DELETE FROM messages WHERE session_id = ?1", params![session_id])
            .map_err(|e| format!("Failed to delete cron messages: {}", e))?;
        tx.execute("DELETE FROM sessions WHERE id = ?1", params![session_id])
            .map_err(|e| format!("Failed to delete cron session: {}", e))?;
        tx.execute("DELETE FROM cronjob_executions WHERE job_id = ?1", params![id])
            .map_err(|e| format!("Failed to delete executions: {}", e))?;
        tx.execute("DELETE FROM cronjobs WHERE id = ?1", params![id])
            .map_err(|e| format!("Failed to delete cronjob: {}", e))?;
        tx.commit()
            .map_err(|e| format!("Failed to commit transaction: {}", e))?;
        Ok(())
    }

    // === Cron Job Executions ===

    pub fn insert_execution(&self, job_id: &str, trigger_type: &str) -> Result<i64, String> {
        let now = super::now_ts();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO cronjob_executions (job_id, started_at, status, trigger_type) VALUES (?1, ?2, 'running', ?3)",
            params![job_id, now, trigger_type],
        )
        .map_err(|e| format!("Failed to insert execution: {}", e))?;
        Ok(conn.last_insert_rowid())
    }

    pub fn update_execution(&self, exec_id: i64, status: &str, result: Option<&str>) -> Result<(), String> {
        let now = super::now_ts();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE cronjob_executions SET finished_at = ?1, status = ?2, result = ?3 WHERE id = ?4",
            params![now, status, result, exec_id],
        )
        .map_err(|e| format!("Failed to update execution: {}", e))?;

        // Prune old executions: keep only the latest 100 for the affected job
        // First, look up the job_id from the execution record
        let job_id: Option<String> = conn.query_row(
            "SELECT job_id FROM cronjob_executions WHERE id = ?1",
            params![exec_id],
            |row| row.get(0),
        ).ok();

        if let Some(job_id) = job_id {
            conn.execute(
                "DELETE FROM cronjob_executions WHERE job_id = ?1 AND id NOT IN (
                    SELECT id FROM cronjob_executions WHERE job_id = ?1 ORDER BY started_at DESC LIMIT 100
                )",
                params![job_id],
            )
            .map_err(|e| format!("Failed to prune old executions: {}", e))?;
        }

        Ok(())
    }

    pub fn list_executions(&self, job_id: &str, limit: usize) -> Result<Vec<CronJobExecutionRow>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, job_id, started_at, finished_at, status, result, trigger_type
                 FROM cronjob_executions WHERE job_id = ?1 ORDER BY started_at DESC LIMIT ?2",
            )
            .map_err(|e| format!("Query error: {}", e))?;
        let rows = stmt
            .query_map(params![job_id, limit as i64], |row| {
                Ok(CronJobExecutionRow {
                    id: row.get(0)?,
                    job_id: row.get(1)?,
                    started_at: row.get(2)?,
                    finished_at: row.get(3)?,
                    status: row.get(4)?,
                    result: row.get(5)?,
                    trigger_type: row.get(6)?,
                })
            })
            .map_err(|e| format!("Query error: {}", e))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn get_last_execution(&self, job_id: &str) -> Result<Option<CronJobExecutionRow>, String> {
        let conn = self.conn.lock().unwrap();
        let result = conn.query_row(
            "SELECT id, job_id, started_at, finished_at, status, result, trigger_type
             FROM cronjob_executions WHERE job_id = ?1 ORDER BY started_at DESC LIMIT 1",
            params![job_id],
            |row| {
                Ok(CronJobExecutionRow {
                    id: row.get(0)?,
                    job_id: row.get(1)?,
                    started_at: row.get(2)?,
                    finished_at: row.get(3)?,
                    status: row.get(4)?,
                    result: row.get(5)?,
                    trigger_type: row.get(6)?,
                })
            },
        );
        match result {
            Ok(row) => Ok(Some(row)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("Query error: {}", e)),
        }
    }

    pub fn set_cronjob_enabled(&self, id: &str, enabled: bool) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE cronjobs SET enabled = ?1 WHERE id = ?2",
            params![enabled, id],
        )
        .map_err(|e| format!("Failed to update cronjob: {}", e))?;
        Ok(())
    }

    // === Heartbeat History ===

    pub fn push_heartbeat(&self, item: &HeartbeatRow) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO heartbeat_history (timestamp, success, message, target) VALUES (?1, ?2, ?3, ?4)",
            params![item.timestamp, item.success, item.message, item.target],
        )
        .map_err(|e| format!("Failed to insert heartbeat: {}", e))?;

        // Keep last 100 entries
        conn.execute(
            "DELETE FROM heartbeat_history WHERE id NOT IN (SELECT id FROM heartbeat_history ORDER BY timestamp DESC LIMIT 100)",
            [],
        )
        .map_err(|e| format!("Failed to trim heartbeat history: {}", e))?;

        Ok(())
    }

    pub fn get_heartbeat_history(&self, limit: usize) -> Result<Vec<HeartbeatRow>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT timestamp, success, message, target FROM heartbeat_history ORDER BY timestamp DESC LIMIT ?1",
            )
            .map_err(|e| format!("Query error: {}", e))?;

        let rows = stmt
            .query_map(params![limit as i64], |row| {
                Ok(HeartbeatRow {
                    timestamp: row.get(0)?,
                    success: row.get(1)?,
                    message: row.get(2)?,
                    target: row.get(3)?,
                })
            })
            .map_err(|e| format!("Query error: {}", e))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(rows)
    }

    // === Migration: jobs.json ===

    pub fn migrate_jobs_from_json(&self, working_dir: &Path) -> Result<(), String> {
        let json_path = working_dir.join("jobs.json");
        if !json_path.exists() {
            return Ok(());
        }

        // Check if we already have data
        {
            let conn = self.conn.lock().unwrap();
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM cronjobs", [], |row| row.get(0))
                .unwrap_or(0);
            if count > 0 {
                let backup = working_dir.join("jobs.json.bak");
                std::fs::rename(&json_path, &backup).ok();
                return Ok(());
            }
        }

        let content = std::fs::read_to_string(&json_path)
            .map_err(|e| format!("Failed to read jobs.json: {}", e))?;

        let jobs_file: serde_json::Value =
            serde_json::from_str(&content).unwrap_or(serde_json::json!({"jobs": []}));

        if let Some(jobs) = jobs_file["jobs"].as_array() {
            for job in jobs {
                let id = job["id"].as_str().unwrap_or("").to_string();
                if id.is_empty() {
                    continue;
                }
                let row = CronJobRow {
                    id,
                    name: job["name"].as_str().unwrap_or("").to_string(),
                    enabled: job["enabled"].as_bool().unwrap_or(false),
                    schedule_json: serde_json::to_string(&job["schedule"]).unwrap_or_else(|_| "{}".into()),
                    task_type: job["task_type"].as_str().unwrap_or("notify").to_string(),
                    text: job["text"].as_str().map(|s| s.to_string()),
                    request_json: job.get("request").map(|v| v.to_string()),
                    dispatch_json: job.get("dispatch").map(|v| v.to_string()),
                    runtime_json: job.get("runtime").map(|v| v.to_string()),
                    execution_mode: ExecutionMode::from_str_lossy(job["execution_mode"].as_str().unwrap_or("shared")),
                };
                self.upsert_cronjob(&row)?;
            }
            log::info!("Migrated {} cron jobs from jobs.json to SQLite", jobs.len());
        }

        let backup = working_dir.join("jobs.json.bak");
        std::fs::rename(&json_path, &backup).ok();
        Ok(())
    }

    // === Migration: heartbeat_history.json ===

    pub fn migrate_heartbeat_from_json(&self, working_dir: &Path) -> Result<(), String> {
        let json_path = working_dir.join("heartbeat_history.json");
        if !json_path.exists() {
            return Ok(());
        }

        // Check if we already have data
        {
            let conn = self.conn.lock().unwrap();
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM heartbeat_history", [], |row| row.get(0))
                .unwrap_or(0);
            if count > 0 {
                let backup = working_dir.join("heartbeat_history.json.bak");
                std::fs::rename(&json_path, &backup).ok();
                return Ok(());
            }
        }

        let content = std::fs::read_to_string(&json_path)
            .map_err(|e| format!("Failed to read heartbeat_history.json: {}", e))?;

        #[derive(Deserialize)]
        struct OldItem {
            timestamp: u64,
            success: bool,
            message: Option<String>,
            #[serde(default)]
            target: String,
        }

        let items: Vec<OldItem> = serde_json::from_str(&content).unwrap_or_default();

        if !items.is_empty() {
            let conn = self.conn.lock().unwrap();
            for item in &items {
                conn.execute(
                    "INSERT INTO heartbeat_history (timestamp, success, message, target) VALUES (?1, ?2, ?3, ?4)",
                    params![item.timestamp as i64, item.success, item.message, item.target],
                )
                .map_err(|e| format!("Failed to migrate heartbeat: {}", e))?;
            }
            log::info!("Migrated {} heartbeat history entries to SQLite", items.len());
        }

        let backup = working_dir.join("heartbeat_history.json.bak");
        std::fs::rename(&json_path, &backup).ok();
        Ok(())
    }
}
