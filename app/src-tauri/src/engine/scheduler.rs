use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use tokio_cron_scheduler::{Job, JobScheduler};

use chrono::Utc;

use crate::commands::cronjobs::{CronJobSpec, DispatchSpec, default_dispatch_targets};
use crate::engine::db::Database;
use crate::state::AppState;

use super::llm_client::LLMConfig;
use super::react_agent;

/// Format a Duration into a human-readable string
fn format_duration(duration: &chrono::Duration) -> String {
    let total_secs = duration.num_seconds();
    if total_secs < 60 {
        format!("{} seconds", total_secs)
    } else if total_secs < 3600 {
        let mins = total_secs / 60;
        let secs = total_secs % 60;
        format!("{} minute{}{}", mins, if secs > 0 { " " } else { "" }, if secs > 0 { secs.to_string() } else { "".to_string() })
    } else {
        let hours = total_secs / 3600;
        let mins = (total_secs % 3600) / 60;
        format!("{} hour{}{}", hours, if mins > 0 { " " } else { "" }, if mins > 0 { mins.to_string() } else { "".to_string() })
    }
}

/// Resolve LLM config for agent tasks
pub async fn resolve_llm_config(
    spec: &CronJobSpec,
    state: &AppState,
) -> Option<LLMConfig> {
    if spec.task_type == "notify" {
        return None;
    }

    let providers = state.providers.read().await;
    let active = providers.active_llm.as_ref()?;
    let all = providers.get_all_providers();
    let p = all.iter().find(|p| p.id == active.provider_id)?;
    let base_url = p
        .base_url
        .as_deref()
        .unwrap_or(&p.default_base_url)
        .to_string();
    let api_key = if let Some(custom) = providers.custom_providers.get(&active.provider_id) {
        custom.settings.api_key.clone()
    } else {
        providers
            .providers
            .get(&active.provider_id)
            .and_then(|s| s.api_key.clone())
    };
    let api_key = api_key.or_else(|| std::env::var(&p.api_key_prefix).ok())?;

    Some(LLMConfig {
        base_url,
        api_key,
        model: active.model.clone(),
    })
}

/// Execute a cron/delay job task (unified entry point).
/// Returns (result, db_clone, exec_id) for the caller to finalize after dispatch.
pub async fn execute_job_task(
    spec: &CronJobSpec,
    working_dir: &std::path::Path,
    llm_config: Option<LLMConfig>,
    db: Option<&Arc<Database>>,
    trigger_type: &str,
) -> (Result<String, String>, Option<Arc<Database>>, Option<i64>) {
    let task_type = spec.task_type.as_str();
    let text = spec.text.as_deref().unwrap_or("");

    // Record execution start
    let exec_id = db.and_then(|d| d.insert_execution(&spec.id, trigger_type).ok());

    let result = match task_type {
        "notify" => {
            // Notify: send text directly as notification, no AI needed
            Ok(text.to_string())
        }
        "agent" => {
            // Agent: let AI process and execute the task
            match llm_config.as_ref() {
                None => Err(format!("CronJob '{}': no LLM configured", spec.id)),
                Some(config) => {
                    let prompt = react_agent::build_system_prompt(working_dir, &[], None).await;
                    let input = if text.is_empty() { "Execute the scheduled task." } else { text };
                    react_agent::run_react(config, &prompt, input, &[]).await
                }
            }
        }
        _ => Err(format!("Unknown task type: {}", task_type)),
    };

    match &result {
        Ok(output) => {
            let preview: String = output.chars().take(200).collect();
            log::info!("CronJob '{}' completed: {}", spec.id, &preview);
        }
        Err(e) => {
            log::error!("CronJob '{}' failed: {}", spec.id, e);
        }
    }

    (result, db.cloned(), exec_id)
}

/// Finalize execution record: update with result + dispatch errors.
pub fn finalize_execution(
    db: &Option<Arc<Database>>,
    exec_id: Option<i64>,
    result: &Result<String, String>,
    dispatch_errors: &[String],
) {
    if let (Some(db), Some(eid)) = (db, exec_id) {
        let (status, mut output) = match result {
            Ok(s) => ("success", s.clone()),
            Err(s) => ("failed", s.clone()),
        };
        // Append dispatch errors to the output
        if !dispatch_errors.is_empty() {
            output.push_str("\n\n--- Dispatch Errors ---\n");
            for err in dispatch_errors {
                output.push_str(err);
                output.push('\n');
            }
        }
        let final_status = if !dispatch_errors.is_empty() && status == "success" {
            "partial"
        } else {
            status
        };
        let _ = db.update_execution(eid, final_status, Some(&output));
    }
}

/// Dispatch job result to all configured targets (system notification, app event, channel).
/// Returns a list of dispatch errors (if any) for recording in execution history.
pub async fn dispatch_job_result(
    job_id: &str,
    job_name: &str,
    result: &str,
    is_error: bool,
    dispatch: &Option<DispatchSpec>,
    db: &Arc<crate::engine::db::Database>,
) -> Vec<String> {
    let targets = dispatch
        .as_ref()
        .map(|d| d.targets.clone())
        .unwrap_or_else(default_dispatch_targets);

    let title = if is_error {
        format!("{} - failed", job_name)
    } else {
        job_name.to_string()
    };
    let preview: String = result.chars().take(200).collect();
    let mut errors = Vec::new();

    for target in &targets {
        match target.r#type.as_str() {
            "system" => {
                send_notification_with_context(&title, &preview, serde_json::json!({
                    "page": "cronjobs",
                    "job_id": job_id,
                    "job_name": job_name,
                }));
            }
            "app" => {
                if let Some(handle) = crate::engine::tools::get_app_handle() {
                    use tauri::Emitter;
                    let _ = handle.emit("cronjob://result", serde_json::json!({
                        "job_id": job_id,
                        "job_name": job_name,
                        "result": preview,
                    }));
                }
            }
            "bot" => {
                if let (Some(bid), Some(bt)) = (&target.bot_id, &target.target) {
                    // Check if the bot is enabled
                    let bot_enabled = db.get_bot(bid)
                        .ok()
                        .flatten()
                        .map(|b| b.enabled)
                        .unwrap_or(false);
                    if !bot_enabled {
                        let err = format!("[dispatch] Bot '{}' is disabled", bid);
                        log::warn!("{}", err);
                        errors.push(err);
                        continue;
                    }
                    let msg = format!("[{}] {}", job_name, &preview);
                    if let Err(e) = crate::commands::bots::send_to_bot(db, bid, bt, &msg).await {
                        let err = format!("[dispatch] Bot '{}' send failed: {}", bid, e);
                        log::warn!("{}", err);
                        errors.push(err);
                    }
                }
            }
            _ => {}
        }
    }

    errors
}

/// Send a plain system notification (fire-and-forget, no click handling).
pub fn send_system_notification(title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    if let Some(handle) = crate::engine::tools::get_app_handle() {
        if let Err(e) = handle.notification().builder().title(title).body(body).show() {
            log::warn!("Failed to send system notification: {}", e);
        }
    }
}

/// Send a system notification with navigation context.
/// When the user clicks the notification, the frontend navigates to the specified page.
///
/// On macOS, uses `mac-notification-sys` directly with `wait_for_click(true)` to
/// block until user interaction, then emits a navigation event on click.
pub fn send_notification_with_context(
    title: &str,
    body: &str,
    context: serde_json::Value,
) {
    let title = title.to_string();
    let body = body.to_string();

    // Spawn a blocking OS thread — mac-notification-sys blocks until user interacts.
    std::thread::spawn(move || {
        #[cfg(target_os = "macos")]
        {
            use mac_notification_sys::{MainButton, Notification, NotificationResponse};

            let mut notif = Notification::new();
            notif
                .title(&title)
                .message(&body)
                .main_button(MainButton::SingleAction("查看"))
                .wait_for_click(true);

            match notif.send() {
                Ok(
                    NotificationResponse::Click | NotificationResponse::ActionButton(_),
                ) => {
                    if let Some(handle) = crate::engine::tools::get_app_handle() {
                        use tauri::{Emitter, Manager};
                        if let Some(window) = handle.get_webview_window("main") {
                            let _: Result<(), _> = window.set_focus();
                            let _: Result<(), _> = window.unminimize();
                        }
                        handle.emit("notification://navigate", &context).ok();
                    }
                }
                Ok(_) => {} // Dismissed — do nothing
                Err(e) => log::warn!("Failed to send system notification: {}", e),
            }
        }

        #[cfg(not(target_os = "macos"))]
        {
            // Non-macOS: send notification + emit pending context.
            // Clicking a notification brings the app to foreground (focus).
            // The frontend detects the focus event and navigates if a pending
            // context exists within a short time window.
            use tauri_plugin_notification::NotificationExt;
            if let Some(handle) = crate::engine::tools::get_app_handle() {
                let _ = handle.notification().builder().title(&title).body(&body).show();
                use tauri::Emitter;
                handle.emit("notification://pending", &context).ok();
            }
        }
    });
}

pub struct CronScheduler {
    scheduler: JobScheduler,
    job_ids: Arc<RwLock<HashMap<String, uuid::Uuid>>>,
    /// Store join handles for one-time jobs (delay/once) so we can cancel them
    one_time_handles: Arc<RwLock<HashMap<String, tokio::task::JoinHandle<()>>>>,
}

impl CronScheduler {
    pub async fn new() -> Result<Self, String> {
        let scheduler = JobScheduler::new()
            .await
            .map_err(|e| format!("Failed to create scheduler: {}", e))?;

        Ok(Self {
            scheduler,
            job_ids: Arc::new(RwLock::new(HashMap::new())),
            one_time_handles: Arc::new(RwLock::new(HashMap::new())),
        })
    }

    pub async fn start(&self) -> Result<(), String> {
        self.scheduler
            .start()
            .await
            .map_err(|e| format!("Failed to start scheduler: {}", e))
    }

    pub async fn load_jobs(&self, state: &AppState) -> Result<(), String> {
        let rows = state.db.list_cronjobs()?;
        for row in &rows {
            let spec = CronJobSpec::from_row(row);
            if spec.enabled {
                self.add_job(&spec, state).await.ok();
            }
        }
        Ok(())
    }

    pub async fn add_job(&self, spec: &CronJobSpec, state: &AppState) -> Result<(), String> {
        // Handle one-time jobs (both delay and once types)
        if spec.schedule.r#type == "delay" || spec.schedule.r#type == "once" {
            let duration = if spec.schedule.r#type == "delay" {
                let total_secs = spec.schedule.delay_minutes
                    .map(|m| m * 60)
                    .ok_or("Delay job requires delay_minutes")?;
                // Use created_at to calculate remaining time (handles app restart)
                let remaining = if let Some(created_at) = spec.schedule.created_at {
                    let elapsed = (Utc::now().timestamp() as u64).saturating_sub(created_at);
                    (total_secs as i64 - elapsed as i64).max(0)
                } else {
                    total_secs as i64
                };
                if remaining <= 0 {
                    return Err("Delay has already expired".to_string());
                }
                Some(chrono::Duration::seconds(remaining))
                    .ok_or("Delay job requires delay_minutes")?
            } else {
                let schedule_at = spec.schedule.schedule_at
                    .as_ref()
                    .ok_or("Once job requires schedule_at")?;
                let scheduled_time = chrono::DateTime::parse_from_rfc3339(schedule_at)
                    .map_err(|e| format!("Invalid schedule_at format: {}. Expected ISO 8601 (e.g., 2026-03-08T21:24:04+08:00)", e))?;
                let scheduled_time_utc = scheduled_time.to_utc();
                let now = Utc::now();
                if scheduled_time_utc <= now {
                    return Err("Scheduled time must be in the future".to_string());
                }
                scheduled_time_utc - now
            };
            return self.add_one_time_job(spec, duration, state).await;
        }

        // Original cron job logic
        let cron_expr = &spec.schedule.cron;
        let spec_clone = spec.clone();
        let llm_config = resolve_llm_config(spec, state).await;
        let working_dir = state.working_dir.clone();
        let db = state.db.clone();

        let job = Job::new_async(cron_expr.as_str(), move |_uuid, _lock| {
            let spec = spec_clone.clone();
            let llm_config = llm_config.clone();
            let working_dir = working_dir.clone();
            let db = db.clone();

            Box::pin(async move {
                log::info!("CronJob '{}' triggered", spec.id);
                let (result, exec_db, exec_id) = execute_job_task(&spec, &working_dir, llm_config, Some(&db), "scheduled").await;
                let (output, is_err) = match &result {
                    Ok(s) => (s.as_str(), false),
                    Err(s) => (s.as_str(), true),
                };
                let dispatch_errors = dispatch_job_result(&spec.id, &spec.name, output, is_err, &spec.dispatch, &db).await;
                finalize_execution(&exec_db, exec_id, &result, &dispatch_errors);
            })
        })
        .map_err(|e| format!("Invalid cron expression '{}': {}", cron_expr, e))?;

        let job_id = self
            .scheduler
            .add(job)
            .await
            .map_err(|e| format!("Failed to add job: {}", e))?;

        let mut ids = self.job_ids.write().await;
        ids.insert(spec.id.clone(), job_id);

        log::info!("Scheduled cron job '{}' with cron '{}'", spec.id, cron_expr);
        Ok(())
    }

    /// Add a one-time job that runs after a specified duration
    /// Used for both "delay" (N minutes later) and "once" (specific time) types
    async fn add_one_time_job(
        &self,
        spec: &CronJobSpec,
        duration: chrono::Duration,
        state: &AppState,
    ) -> Result<(), String> {
        let spec_id = spec.id.clone();
        let spec_clone = spec.clone();
        let db = state.db.clone();
        let working_dir = state.working_dir.clone();
        let one_time_handles = self.one_time_handles.clone();

        // Resolve LLM config if needed
        let llm_config = resolve_llm_config(spec, state).await;

        let job_type = spec.schedule.r#type.clone();
        let duration_display = format_duration(&duration);

        // Clone for use inside async block (log only)
        let job_type_log = job_type.clone();
        let duration_display_log = duration_display.clone();

        // Spawn the scheduled task
        let handle = tokio::spawn(async move {
            let sleep_duration = Duration::from_secs(duration.num_seconds() as u64);
            log::info!(
                "One-time job '{}' ({}) scheduled, waiting {}",
                spec_id,
                job_type_log,
                duration_display_log
            );
            tokio::time::sleep(sleep_duration).await;

            log::info!("One-time job '{}' triggered", spec_id);
            let (result, exec_db, exec_id) = execute_job_task(&spec_clone, &working_dir, llm_config, Some(&db), "scheduled").await;
            let (output, is_err) = match &result {
                Ok(s) => (s.as_str(), false),
                Err(s) => (s.as_str(), true),
            };
            let dispatch_errors = dispatch_job_result(&spec_clone.id, &spec_clone.name, output, is_err, &spec_clone.dispatch, &db).await;
            finalize_execution(&exec_db, exec_id, &result, &dispatch_errors);

            // Disable the one-time job after execution (keep it for history)
            log::info!("Disabling completed one-time job '{}'", spec_id);
            let _ = db.set_cronjob_enabled(&spec_id, false);

            // Notify frontend to refresh
            if let Some(handle) = crate::engine::tools::get_app_handle() {
                use tauri::Emitter;
                let _ = handle.emit("cronjob://refresh", ());
            }

            // Clean up tracking
            let mut handles = one_time_handles.write().await;
            handles.remove(&spec_id);
        });

        let mut handles = self.one_time_handles.write().await;
        handles.insert(spec.id.clone(), handle);

        log::info!(
            "Scheduled one-time job '{}' ({}) to run in {}",
            spec.id,
            job_type,
            duration_display
        );
        Ok(())
    }

    /// Add a job using globally-available context (for tools that don't have AppState).
    /// Falls back to global DATABASE, WORKING_DIR, PROVIDERS.
    pub async fn add_job_from_globals(&self, spec: &CronJobSpec) -> Result<(), String> {
        let db = crate::engine::tools::get_database()
            .ok_or("Database not initialized")?;
        let working_dir = crate::engine::tools::get_working_dir()
            .ok_or("Working dir not initialized")?;

        if spec.schedule.r#type == "delay" || spec.schedule.r#type == "once" {
            let duration = if spec.schedule.r#type == "delay" {
                // Calculate remaining time using created_at if available
                let delay_secs = spec.schedule.delay_minutes
                    .map(|m| m * 60)
                    .ok_or("Delay job requires delay_minutes")?;
                let created_at = spec.schedule.created_at.unwrap_or_else(|| {
                    chrono::Utc::now().timestamp() as u64
                });
                let elapsed = chrono::Utc::now().timestamp() as u64 - created_at;
                let remaining = (delay_secs as i64 - elapsed as i64).max(0);
                chrono::Duration::seconds(remaining)
            } else {
                let schedule_at = spec.schedule.schedule_at
                    .as_ref()
                    .ok_or("Once job requires schedule_at")?;
                let scheduled_time = chrono::DateTime::parse_from_rfc3339(schedule_at)
                    .map_err(|e| format!("Invalid schedule_at: {}", e))?;
                let diff = scheduled_time.to_utc() - Utc::now();
                if diff.num_seconds() <= 0 {
                    return Err("Scheduled time is in the past".to_string());
                }
                diff
            };

            let spec_id = spec.id.clone();
            let spec_clone = spec.clone();
            let db_clone = db.clone();
            let wd = working_dir.clone();
            let one_time_handles = self.one_time_handles.clone();

            let llm_config = crate::engine::tools::resolve_llm_config_from_globals_pub().await;

            let duration_display = format_duration(&duration);
            let job_type = spec.schedule.r#type.clone();

            let handle = tokio::spawn(async move {
                let sleep_duration = Duration::from_secs(duration.num_seconds() as u64);
                log::info!(
                    "One-time job '{}' ({}) scheduled, waiting {}",
                    spec_id, job_type, duration_display
                );
                tokio::time::sleep(sleep_duration).await;

                log::info!("One-time job '{}' triggered", spec_id);
                let (result, exec_db, exec_id) = execute_job_task(
                    &spec_clone, &wd, llm_config, Some(&db_clone), "scheduled",
                ).await;
                let (output, is_err) = match &result {
                    Ok(s) => (s.as_str(), false),
                    Err(s) => (s.as_str(), true),
                };
                let dispatch_errors = dispatch_job_result(
                    &spec_clone.id, &spec_clone.name, output, is_err, &spec_clone.dispatch, &db_clone,
                ).await;
                finalize_execution(&exec_db, exec_id, &result, &dispatch_errors);

                log::info!("Disabling completed one-time job '{}'", spec_id);
                let _ = db_clone.set_cronjob_enabled(&spec_id, false);

                if let Some(handle) = crate::engine::tools::get_app_handle() {
                    use tauri::Emitter;
                    let _ = handle.emit("cronjob://refresh", ());
                }

                let mut handles = one_time_handles.write().await;
                handles.remove(&spec_id);
            });

            let mut handles = self.one_time_handles.write().await;
            handles.insert(spec.id.clone(), handle);

            log::info!("Scheduled one-time job '{}' via globals", spec.id);
            return Ok(());
        }

        // Cron type
        let cron_expr = &spec.schedule.cron;
        let spec_clone = spec.clone();
        let llm_config = crate::engine::tools::resolve_llm_config_from_globals_pub().await;
        let wd = working_dir.clone();
        let db_clone = db.clone();

        let job = Job::new_async(cron_expr.as_str(), move |_uuid, _lock| {
            let spec = spec_clone.clone();
            let llm_config = llm_config.clone();
            let wd = wd.clone();
            let db = db_clone.clone();

            Box::pin(async move {
                log::info!("CronJob '{}' triggered", spec.id);
                let (result, exec_db, exec_id) = execute_job_task(&spec, &wd, llm_config, Some(&db), "scheduled").await;
                let (output, is_err) = match &result {
                    Ok(s) => (s.as_str(), false),
                    Err(s) => (s.as_str(), true),
                };
                let dispatch_errors = dispatch_job_result(&spec.id, &spec.name, output, is_err, &spec.dispatch, &db).await;
                finalize_execution(&exec_db, exec_id, &result, &dispatch_errors);
            })
        })
        .map_err(|e| format!("Invalid cron expression '{}': {}", cron_expr, e))?;

        let job_id = self.scheduler.add(job).await
            .map_err(|e| format!("Failed to add job: {}", e))?;

        let mut ids = self.job_ids.write().await;
        ids.insert(spec.id.clone(), job_id);

        log::info!("Scheduled cron job '{}' with cron '{}' via globals", spec.id, cron_expr);
        Ok(())
    }

    /// Remove a job (works for cron, delay, and once jobs)
    pub async fn remove_job(&self, spec_id: &str) -> Result<(), String> {
        // Try to remove as a cron job first
        {
            let mut ids = self.job_ids.write().await;
            if let Some(job_id) = ids.remove(spec_id) {
                return self
                    .scheduler
                    .remove(&job_id)
                    .await
                    .map_err(|e| format!("Failed to remove job: {}", e));
            }
        }

        // Try to remove as a delay job
        {
            let mut handles = self.one_time_handles.write().await;
            if let Some(handle) = handles.remove(spec_id) {
                handle.abort();
                return Ok(());
            }
        }

        Ok(())
    }
}
