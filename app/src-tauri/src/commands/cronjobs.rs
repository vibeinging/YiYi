use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::engine::db::{CronJobRow, CronJobExecutionRow, ExecutionMode};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CronJobSpec {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub enabled: bool,
    pub schedule: ScheduleSpec,
    #[serde(default = "default_task_type")]
    pub task_type: String,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub request: Option<serde_json::Value>,
    #[serde(default)]
    pub dispatch: Option<DispatchSpec>,
    #[serde(default)]
    pub runtime: Option<JobRuntimeSpec>,
    /// Execution mode: Shared (default) runs in global context,
    /// In Isolated mode, agent tasks run in a dedicated session `cron:{id}`
    /// with their own conversation history, avoiding pollution of the main chat.
    #[serde(default)]
    pub execution_mode: ExecutionMode,
}

fn default_task_type() -> String {
    "notify".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduleSpec {
    #[serde(default = "default_schedule_type")]
    pub r#type: String,
    #[serde(default)]
    pub cron: String,
    #[serde(default)]
    pub timezone: Option<String>,
    /// One-time delay in minutes (for type="delay")
    #[serde(default)]
    pub delay_minutes: Option<u64>,
    /// Specific date/time (ISO 8601) for one-time scheduled task (for type="once")
    #[serde(default)]
    pub schedule_at: Option<String>,
    /// Unix timestamp when the job was created (for delay type: calculate remaining time on restart)
    #[serde(default)]
    pub created_at: Option<u64>,
}

fn default_schedule_type() -> String {
    "cron".to_string()
}

impl Default for ScheduleSpec {
    fn default() -> Self {
        Self {
            r#type: default_schedule_type(),
            cron: String::new(),
            timezone: None,
            delay_minutes: None,
            schedule_at: None,
            created_at: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DispatchTarget {
    pub r#type: String,  // "system" | "app" | "bot"
    #[serde(default)]
    pub bot_id: Option<String>,   // bot instance ID
    #[serde(default)]
    pub target: Option<String>,   // target within the bot (channel_id, chat_id, etc.)
    // Legacy field for backward compatibility during migration
    #[serde(default)]
    pub channel: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DispatchSpec {
    #[serde(default = "default_dispatch_targets")]
    pub targets: Vec<DispatchTarget>,
}

pub fn default_dispatch_targets() -> Vec<DispatchTarget> {
    vec![
        DispatchTarget { r#type: "system".into(), bot_id: None, target: None, channel: None },
        DispatchTarget { r#type: "app".into(), bot_id: None, target: None, channel: None },
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobRuntimeSpec {
    #[serde(default)]
    pub max_concurrency: Option<u32>,
    #[serde(default)]
    pub timeout_seconds: Option<u64>,
    #[serde(default)]
    pub misfire_grace_seconds: Option<u64>,
}

// --- Conversion helpers ---

impl CronJobSpec {
    pub fn to_row(&self) -> CronJobRow {
        CronJobRow {
            id: self.id.clone(),
            name: self.name.clone(),
            enabled: self.enabled,
            schedule_json: serde_json::to_string(&self.schedule).unwrap_or_else(|_| "{}".into()),
            task_type: self.task_type.clone(),
            text: self.text.clone(),
            request_json: self.request.as_ref().map(|v| v.to_string()),
            dispatch_json: self.dispatch.as_ref().and_then(|d| serde_json::to_string(d).ok()),
            runtime_json: self.runtime.as_ref().and_then(|r| serde_json::to_string(r).ok()),
            execution_mode: self.execution_mode.clone(),
        }
    }

    pub fn from_row(row: &CronJobRow) -> Self {
        Self {
            id: row.id.clone(),
            name: row.name.clone(),
            enabled: row.enabled,
            schedule: serde_json::from_str(&row.schedule_json).unwrap_or_default(),
            task_type: row.task_type.clone(),
            text: row.text.clone(),
            request: row.request_json.as_ref().and_then(|s| serde_json::from_str(s).ok()),
            dispatch: row.dispatch_json.as_ref().and_then(|s| serde_json::from_str(s).ok()),
            runtime: row.runtime_json.as_ref().and_then(|s| serde_json::from_str(s).ok()),
            execution_mode: row.execution_mode.clone(),
        }
    }
}

#[tauri::command]
pub async fn list_cronjobs(state: State<'_, AppState>) -> Result<Vec<CronJobSpec>, String> {
    let rows = state.db.list_cronjobs()?;
    Ok(rows.iter().map(CronJobSpec::from_row).collect())
}

#[tauri::command]
pub async fn create_cronjob(
    state: State<'_, AppState>,
    spec: CronJobSpec,
) -> Result<CronJobSpec, String> {
    let mut new_spec = spec;
    if new_spec.id.is_empty() {
        new_spec.id = uuid::Uuid::new_v4().to_string();
    }
    state.db.upsert_cronjob(&new_spec.to_row())?;
    Ok(new_spec)
}

#[tauri::command]
pub async fn update_cronjob(
    state: State<'_, AppState>,
    id: String,
    spec: CronJobSpec,
) -> Result<CronJobSpec, String> {
    // Verify exists
    state.db.get_cronjob(&id)?
        .ok_or_else(|| format!("CronJob '{}' not found", id))?;
    let updated = CronJobSpec { id: id.clone(), ..spec };
    state.db.upsert_cronjob(&updated.to_row())?;
    Ok(updated)
}

#[tauri::command]
pub async fn delete_cronjob(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    // Remove from scheduler first (cancel running timer)
    let scheduler_lock = state.scheduler.read().await;
    if let Some(scheduler) = scheduler_lock.as_ref() {
        let _ = scheduler.remove_job(&id).await;
    }
    drop(scheduler_lock);

    // Then delete from DB (cascades to executions)
    state.db.delete_cronjob(&id)
}

#[tauri::command]
pub async fn pause_cronjob(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.db.get_cronjob(&id)?
        .ok_or_else(|| format!("CronJob '{}' not found", id))?;

    // Remove from scheduler (cancel running timer)
    let scheduler_lock = state.scheduler.read().await;
    if let Some(scheduler) = scheduler_lock.as_ref() {
        let _ = scheduler.remove_job(&id).await;
    }
    drop(scheduler_lock);

    state.db.set_cronjob_enabled(&id, false)
}

#[tauri::command]
pub async fn resume_cronjob(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<serde_json::Value, String> {
    let row = state.db.get_cronjob(&id)?
        .ok_or_else(|| format!("CronJob '{}' not found", id))?;
    state.db.set_cronjob_enabled(&id, true)?;

    let spec = CronJobSpec::from_row(&row);
    let schedule_type = spec.schedule.r#type.as_str();

    // For delay/once jobs, re-register with scheduler to restart the timer
    if schedule_type == "delay" || schedule_type == "once" {
        let scheduler_lock = state.scheduler.read().await;
        if let Some(scheduler) = scheduler_lock.as_ref() {
            // For "once" type whose schedule_at is in the past, convert to delay-style
            let mut resume_spec = spec.clone();
            if schedule_type == "once" {
                if let Some(ref at) = resume_spec.schedule.schedule_at {
                    let is_past = chrono::DateTime::parse_from_rfc3339(at)
                        .map(|t| t.to_utc() <= chrono::Utc::now())
                        .unwrap_or(true);
                    if is_past {
                        // Convert to delay using the original delay_minutes, or default 5 min
                        let mins = resume_spec.schedule.delay_minutes.unwrap_or(5);
                        resume_spec.schedule.r#type = "delay".to_string();
                        resume_spec.schedule.delay_minutes = Some(mins);
                        resume_spec.schedule.schedule_at = None;
                        // Also update DB
                        state.db.upsert_cronjob(&resume_spec.to_row())?;
                    }
                }
            }
            scheduler.add_job(&resume_spec, &state).await?;
        }

        let mins = spec.schedule.delay_minutes.unwrap_or(5);

        let _ = app.emit("cronjob://result", serde_json::json!({
            "job_id": id,
            "job_name": spec.name,
            "result": format!("任务已重新开始计时: {} 分钟后执行", mins),
        }));

        return Ok(serde_json::json!({ "restarted": true, "schedule_type": schedule_type }));
    }

    Ok(serde_json::json!({ "restarted": false }))
}

#[tauri::command]
pub async fn run_cronjob(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let row = state.db.get_cronjob(&id)?
        .ok_or_else(|| format!("CronJob '{}' not found", id))?;
    let job = CronJobSpec::from_row(&row);

    // Resolve LLM config and execute via unified entry point
    let llm_config = crate::engine::scheduler::resolve_llm_config(&job, &state).await;
    let (result, exec_db, exec_id) = crate::engine::scheduler::execute_job_task(
        &job,
        &state.working_dir,
        llm_config,
        Some(&state.db),
        "manual",
    ).await;

    // Dispatch result to all configured targets
    let (output, is_err) = match &result {
        Ok(s) => (s.as_str(), false),
        Err(s) => (s.as_str(), true),
    };
    let dispatch_errors = crate::engine::scheduler::dispatch_job_result(
        &id, &job.name, output, is_err, &job.dispatch, &state.db,
    ).await;

    // Finalize execution record with dispatch errors
    crate::engine::scheduler::finalize_execution(&exec_db, exec_id, &result, &dispatch_errors);

    result.map(|_| ())
}

#[tauri::command]
pub async fn get_cronjob_state(
    state: State<'_, AppState>,
    id: String,
) -> Result<serde_json::Value, String> {
    let row = state.db.get_cronjob(&id)?
        .ok_or_else(|| format!("CronJob '{}' not found", id))?;
    let last_exec = state.db.get_last_execution(&id)?;
    Ok(serde_json::json!({
        "id": row.id,
        "enabled": row.enabled,
        "next_run_at": null,
        "last_run_at": last_exec.as_ref().map(|e| e.started_at),
        "last_status": last_exec.as_ref().map(|e| &e.status),
    }))
}

#[tauri::command]
pub async fn list_cronjob_executions(
    state: State<'_, AppState>,
    job_id: String,
    limit: Option<usize>,
) -> Result<Vec<CronJobExecutionRow>, String> {
    state.db.list_executions(&job_id, limit.unwrap_or(20))
}
