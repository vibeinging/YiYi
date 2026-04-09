use tauri::Emitter;

/// Cron job management tool definitions.
pub(super) fn definitions() -> Vec<super::ToolDefinition> {
    vec![
        super::tool_def(
            "manage_cronjob",
            "Create, list, update, delete scheduled tasks, or query execution history. Supports three schedule types:\n\
            - 'delay': one-time task after N minutes (e.g., remind in 5 minutes). Use delay_minutes.\n\
            - 'once': one-time task at a specific time (ISO 8601). Use schedule_at.\n\
            - 'cron': recurring task with cron expression (6 fields: sec min hour day month weekday).\n\
            When called from a Bot conversation without dispatch_targets, auto-infers current Bot + conversation as dispatch target.\n\
            For reminders like '5 min later remind me', use schedule_type='delay' with delay_minutes=5.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["create", "list", "update", "delete", "history", "get_execution"],
                        "description": "操作类型：create 创建、list 列表、update 更新、delete 删除、history 查看执行历史、get_execution 获取某次执行的完整结果"
                    },
                    "name": { "type": "string", "description": "任务名称（create 时使用）" },
                    "schedule_type": {
                        "type": "string",
                        "enum": ["cron", "delay", "once"],
                        "description": "调度类型：delay 延迟N分钟、once 指定时间、cron 周期执行"
                    },
                    "cron": { "type": "string", "description": "Cron表达式（6字段：秒 分 时 日 月 周），仅 schedule_type='cron' 时使用" },
                    "delay_minutes": { "type": "number", "description": "延迟分钟数，仅 schedule_type='delay' 时使用" },
                    "schedule_at": { "type": "string", "description": "执行时间（ISO 8601），仅 schedule_type='once' 时使用，如 '2026-03-09T21:44:00+08:00'" },
                    "text": { "type": "string", "description": "任务内容：notify 类型为通知文本，agent 类型为 AI 提示词" },
                    "task_type": { "type": "string", "enum": ["notify", "agent"], "description": "任务类型：notify 直接通知、agent 由 AI 执行" },
                    "id": { "type": "string", "description": "任务ID（update/delete 时必填）" },
                    "enabled": { "type": "boolean", "description": "是否启用（update 时使用）" },
                    "enabled_only": { "type": "boolean", "description": "仅列出启用的任务（list 时使用，默认 false）" },
                    "dispatch_targets": {
                        "type": "array",
                        "description": "通知目标列表。不指定时：Bot对话自动推断当前Bot+会话；App对话默认系统通知+应用内通知",
                        "items": {
                            "type": "object",
                            "properties": {
                                "type": { "type": "string", "enum": ["system", "app", "bot"], "description": "目标类型" },
                                "bot_id": { "type": "string", "description": "Bot ID（type='bot' 时必填）" },
                                "target": { "type": "string", "description": "目标ID：频道ID、群ID等（type='bot' 时必填）" }
                            },
                            "required": ["type"]
                        }
                    },
                    "schedule_value": { "type": "string", "description": "更新调度值（update 时使用）：cron表达式、ISO 8601时间、或延迟分钟数" },
                    "limit": { "type": "number", "description": "history 时返回的记录数（默认 20）" },
                    "execution_index": { "type": "number", "description": "get_execution 时使用：第N次执行（1=最早，负数从最新算起，-1=最新）" },
                    "execution_id": { "type": "number", "description": "get_execution 时使用：执行记录的数据库ID（优先于 execution_index）" }
                },
                "required": ["action"]
            }),
        ),
    ]
}

pub(super) async fn manage_cronjob_tool(args: &serde_json::Value) -> String {
    let action = args["action"].as_str().unwrap_or("");
    let db = match super::require_db() {
        Ok(db) => db,
        Err(e) => return e,
    };

    match action {
        "list" => {
            let enabled_only = args["enabled_only"].as_bool().unwrap_or(false);
            match db.list_cronjobs() {
                Ok(jobs) if jobs.is_empty() => "当前没有定时任务。".into(),
                Ok(jobs) => {
                    let filtered: Vec<_> = if enabled_only {
                        jobs.iter().filter(|j| j.enabled).collect()
                    } else {
                        jobs.iter().collect()
                    };
                    if filtered.is_empty() {
                        return "没有符合条件的定时任务。".into();
                    }
                    let items: Vec<String> = filtered
                        .iter()
                        .map(|j| {
                            let schedule: serde_json::Value = serde_json::from_str(&j.schedule_json).unwrap_or_default();
                            let sched_type = schedule["type"].as_str().unwrap_or("cron");
                            let sched_desc = match sched_type {
                                "delay" => format!("延迟 {} 分钟", schedule["delay_minutes"].as_u64().unwrap_or(0)),
                                "once" => format!("定时 {}", schedule["schedule_at"].as_str().unwrap_or("?")),
                                _ => format!("cron: {}", schedule["cron"].as_str().unwrap_or("?")),
                            };
                            let dispatch_info = j.dispatch_json.as_ref().map(|d| {
                                let spec: serde_json::Value = serde_json::from_str(d).unwrap_or_default();
                                if let Some(targets) = spec["targets"].as_array() {
                                    let descs: Vec<String> = targets.iter().map(|t| {
                                        match t["type"].as_str().unwrap_or("") {
                                            "bot" => format!("bot:{}", t["bot_id"].as_str().unwrap_or("?")),
                                            other => other.to_string(),
                                        }
                                    }).collect();
                                    format!(" | 通知: {}", descs.join(", "))
                                } else {
                                    String::new()
                                }
                            }).unwrap_or_default();
                            format!(
                                "- [{}] {} | {} | 类型: {} | 启用: {}{}",
                                j.id, j.name, sched_desc, j.task_type, j.enabled, dispatch_info,
                            )
                        })
                        .collect();
                    format!("定时任务 ({}):\n{}", items.len(), items.join("\n"))
                }
                Err(e) => format!("Error: 查询任务失败: {}", e),
            }
        }
        "create" => {
            let name = args["name"].as_str().unwrap_or("未命名任务");
            let text = args["text"].as_str().unwrap_or("");
            let task_type = args["task_type"].as_str().unwrap_or("notify");
            let schedule_type = args["schedule_type"].as_str().unwrap_or("cron");

            let schedule_json = match schedule_type {
                "delay" => {
                    let minutes = args["delay_minutes"].as_f64().unwrap_or(0.0) as u64;
                    if minutes == 0 {
                        return "Error: delay_minutes 必须大于 0".into();
                    }
                    let created_at = chrono::Utc::now().timestamp() as u64;
                    serde_json::json!({"type": "delay", "delay_minutes": minutes, "created_at": created_at})
                }
                "once" => {
                    let schedule_at = args["schedule_at"].as_str().unwrap_or("");
                    if schedule_at.is_empty() {
                        return "Error: schedule_at (ISO 8601) 是 once 类型的必填参数".into();
                    }
                    // Validate ISO 8601 format
                    if chrono::DateTime::parse_from_rfc3339(schedule_at).is_err() {
                        return format!("Error: schedule_at 格式无效，请使用 ISO 8601 格式，如 '2026-03-09T21:44:00+08:00'");
                    }
                    serde_json::json!({"type": "once", "schedule_at": schedule_at})
                }
                _ => {
                    let cron = args["cron"].as_str().unwrap_or("");
                    if cron.is_empty() {
                        return "Error: cron 表达式是 cron 类型的必填参数".into();
                    }
                    serde_json::json!({"type": "cron", "cron": cron})
                }
            };

            // Build dispatch spec: explicit > bot context inference > default
            let dispatch_json = build_dispatch_json(args);

            let id = uuid::Uuid::new_v4().to_string();
            let row = super::db::CronJobRow {
                id: id.clone(),
                name: name.to_string(),
                enabled: true,
                schedule_json: schedule_json.to_string(),
                task_type: task_type.to_string(),
                text: if text.is_empty() { None } else { Some(text.to_string()) },
                request_json: None,
                dispatch_json,
                runtime_json: None,
                execution_mode: crate::engine::db::ExecutionMode::default(),
            };

            match db.upsert_cronjob(&row) {
                Ok(_) => {
                    // Schedule the job to actually run
                    let spec = crate::commands::cronjobs::CronJobSpec::from_row(&row);
                    schedule_created_job(spec);

                    // Notify frontend to refresh
                    if let Some(handle) = super::APP_HANDLE.get() {
                        let _ = handle.emit("cronjob://refresh", ());
                    }

                    let schedule_desc = match schedule_type {
                        "delay" => format!("{} 分钟后执行", args["delay_minutes"].as_f64().unwrap_or(0.0) as u64),
                        "once" => format!("在 {} 执行", args["schedule_at"].as_str().unwrap_or("?")),
                        _ => format!("cron: {}", args["cron"].as_str().unwrap_or("?")),
                    };
                    let dispatch_desc = if row.dispatch_json.is_some() {
                        "\n通知目标: 已配置"
                    } else {
                        "\n通知目标: 系统通知 + 应用内通知（默认）"
                    };
                    let result_msg = format!("已创建定时任务「{}」\n调度: {}\n类型: {}\n内容: {}{}", name, schedule_desc, task_type, text, dispatch_desc);

                    // Seed the cron session with creation context
                    seed_cron_session_context(db, &id, name);

                    result_msg
                }
                Err(e) => format!("Error: 保存任务失败: {}", e),
            }
        }
        "update" => {
            let id = args["id"].as_str().unwrap_or("");
            if id.is_empty() {
                return "Error: id 是 update 操作的必填参数".into();
            }

            // Fetch existing job
            let existing = match db.get_cronjob(id) {
                Ok(Some(row)) => row,
                Ok(None) => return format!("Error: 未找到任务 '{}'", id),
                Err(e) => return format!("Error: 查询任务失败: {}", e),
            };

            let mut updated = existing.clone();
            let mut changes = Vec::new();
            let mut need_reschedule = false;

            // Update enabled status
            if let Some(enabled) = args["enabled"].as_bool() {
                updated.enabled = enabled;
                changes.push(format!("启用状态: {}", enabled));
                need_reschedule = true;
            }

            // Update text
            if let Some(text) = args["text"].as_str() {
                updated.text = if text.is_empty() { None } else { Some(text.to_string()) };
                changes.push(format!("内容: {}", text));
            }

            // Update schedule_value (cron expression, or schedule_at for once)
            if let Some(schedule_value) = args["schedule_value"].as_str() {
                let mut schedule: serde_json::Value = serde_json::from_str(&updated.schedule_json).unwrap_or_default();
                let sched_type = schedule["type"].as_str().unwrap_or("cron").to_string();
                match sched_type.as_str() {
                    "cron" => {
                        schedule["cron"] = serde_json::Value::String(schedule_value.to_string());
                        changes.push(format!("cron: {}", schedule_value));
                    }
                    "once" => {
                        if chrono::DateTime::parse_from_rfc3339(schedule_value).is_err() {
                            return format!("Error: schedule_value 格式无效（需要 ISO 8601）");
                        }
                        schedule["schedule_at"] = serde_json::Value::String(schedule_value.to_string());
                        changes.push(format!("执行时间: {}", schedule_value));
                    }
                    "delay" => {
                        if let Ok(mins) = schedule_value.parse::<u64>() {
                            schedule["delay_minutes"] = serde_json::json!(mins);
                            schedule["created_at"] = serde_json::json!(chrono::Utc::now().timestamp() as u64);
                            changes.push(format!("延迟: {} 分钟", mins));
                        } else {
                            return "Error: delay 类型的 schedule_value 必须是分钟数".into();
                        }
                    }
                    _ => {}
                }
                updated.schedule_json = schedule.to_string();
                need_reschedule = true;
            }

            // Update dispatch targets
            let new_dispatch = build_dispatch_json(args);
            if new_dispatch.is_some() {
                updated.dispatch_json = new_dispatch;
                changes.push("通知目标: 已更新".to_string());
            }

            if changes.is_empty() {
                return "没有需要更新的内容。请指定要修改的字段（enabled、text、schedule_value、dispatch_targets）".into();
            }

            match db.upsert_cronjob(&updated) {
                Ok(_) => {
                    // Re-schedule if needed
                    if need_reschedule {
                        // Remove old schedule
                        remove_scheduled_job(id);
                        // Add new schedule if enabled
                        if updated.enabled {
                            let spec = crate::commands::cronjobs::CronJobSpec::from_row(&updated);
                            schedule_created_job(spec);
                        }
                    }

                    // Notify frontend to refresh
                    if let Some(handle) = super::APP_HANDLE.get() {
                        let _ = handle.emit("cronjob://refresh", ());
                    }

                    format!("已更新任务「{}」\n变更: {}", updated.name, changes.join("、"))
                }
                Err(e) => format!("Error: 更新任务失败: {}", e),
            }
        }
        "delete" => {
            let id = args["id"].as_str().unwrap_or("");
            if id.is_empty() {
                return "Error: id 是 delete 操作的必填参数".into();
            }

            // Get name before deleting
            let job_name = db.get_cronjob(id).ok().flatten()
                .map(|j| j.name).unwrap_or_else(|| id.to_string());

            // Remove from scheduler first
            remove_scheduled_job(id);

            match db.delete_cronjob(id) {
                Ok(_) => {
                    // Notify frontend to refresh
                    if let Some(handle) = super::APP_HANDLE.get() {
                        let _ = handle.emit("cronjob://refresh", ());
                    }
                    format!("已删除定时任务「{}」", job_name)
                }
                Err(e) => format!("Error: 删除任务失败: {}", e),
            }
        }
        "history" => {
            let id = args["id"].as_str().unwrap_or("");
            // In cron session context, auto-infer job_id from session
            let job_id = if !id.is_empty() {
                id.to_string()
            } else if let Some(sid) = { let s = super::get_current_session_id(); if s.is_empty() { None } else { Some(s) } } {
                if let Some(jid) = sid.strip_prefix("cron:") {
                    jid.to_string()
                } else {
                    return "Error: id 是 history 操作的必填参数（不在 cron session 中时）".into();
                }
            } else {
                return "Error: id 是 history 操作的必填参数".into();
            };
            let limit = args["limit"].as_u64().unwrap_or(20) as usize;
            match db.list_executions(&job_id, limit) {
                Ok(execs) if execs.is_empty() => "该任务暂无执行记录。".into(),
                Ok(execs) => {
                    let total = execs.len();
                    // execs are ordered DESC (newest first), we display with index
                    let all_count = db.list_executions(&job_id, 100).map(|v| v.len()).unwrap_or(total);
                    let items: Vec<String> = execs.iter().enumerate().map(|(i, e)| {
                        let idx = all_count - i; // 1-based, newest = highest
                        let started = chrono::DateTime::from_timestamp(e.started_at, 0)
                            .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
                            .unwrap_or_else(|| e.started_at.to_string());
                        let result_preview = e.result.as_deref().unwrap_or("").chars().take(100).collect::<String>();
                        let result_len = e.result.as_deref().map(|r| r.len()).unwrap_or(0);
                        let truncated = if result_len > 100 { format!("... (共{}字符)", result_len) } else { String::new() };
                        format!(
                            "#{} [ID:{}] {} | 状态: {} | 触发: {} | 结果预览: {}{}",
                            idx, e.id, started, e.status, e.trigger_type, result_preview, truncated,
                        )
                    }).collect();
                    format!("执行历史 (最近{}/{}):\n{}", total, all_count, items.join("\n"))
                }
                Err(e) => format!("Error: 查询执行历史失败: {}", e),
            }
        }
        "get_execution" => {
            let id = args["id"].as_str().unwrap_or("");
            let job_id = if !id.is_empty() {
                id.to_string()
            } else if let Some(sid) = { let s = super::get_current_session_id(); if s.is_empty() { None } else { Some(s) } } {
                if let Some(jid) = sid.strip_prefix("cron:") {
                    jid.to_string()
                } else {
                    return "Error: id (job_id) 是 get_execution 操作的必填参数（不在 cron session 中时）".into();
                }
            } else {
                return "Error: id (job_id) 是 get_execution 操作的必填参数".into();
            };

            // Find the target execution: by execution_id or execution_index
            if let Some(exec_id) = args["execution_id"].as_i64() {
                // Direct lookup by execution record ID
                match db.list_executions(&job_id, 100) {
                    Ok(execs) => {
                        match execs.iter().find(|e| e.id == exec_id) {
                            Some(e) => format_full_execution(e, &execs),
                            None => format!("Error: 未找到执行记录 ID={}", exec_id),
                        }
                    }
                    Err(e) => format!("Error: {}", e),
                }
            } else if let Some(idx) = args["execution_index"].as_i64() {
                match db.list_executions(&job_id, 100) {
                    Ok(execs) if execs.is_empty() => "该任务暂无执行记录。".into(),
                    Ok(execs) => {
                        let total = execs.len() as i64;
                        let actual_idx = if idx > 0 {
                            total - idx
                        } else {
                            (-idx) - 1
                        };
                        if actual_idx < 0 || actual_idx >= total {
                            return format!("Error: 索引 {} 超出范围，共有 {} 条执行记录", idx, total);
                        }
                        let e = &execs[actual_idx as usize];
                        format_full_execution(e, &execs)
                    }
                    Err(e) => format!("Error: {}", e),
                }
            } else {
                "Error: get_execution 需要 execution_id 或 execution_index 参数".into()
            }
        }
        _ => format!("未知操作: '{}'. 支持的操作: create, list, update, delete, history, get_execution", action),
    }
}

fn format_full_execution(e: &crate::engine::db::CronJobExecutionRow, all_execs: &[crate::engine::db::CronJobExecutionRow]) -> String {
    let total = all_execs.len();
    let pos = all_execs.iter().position(|x| x.id == e.id).unwrap_or(0);
    let index = total - pos; // 1-based, oldest=1
    let started = chrono::DateTime::from_timestamp(e.started_at, 0)
        .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_else(|| e.started_at.to_string());
    let finished = e.finished_at
        .and_then(|t| chrono::DateTime::from_timestamp(t, 0))
        .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_else(|| "进行中".into());
    let result = e.result.as_deref().unwrap_or("(无结果)");
    format!(
        "执行记录 #{} (ID: {})\n\
         开始时间: {}\n\
         结束时间: {}\n\
         状态: {}\n\
         触发方式: {}\n\
         ---\n\
         完整结果:\n{}",
        index, e.id, started, finished, e.status, e.trigger_type, result,
    )
}

/// Seed a cron session (`cron:{job_id}`) with the creation context.
fn seed_cron_session_context(db: &super::db::Database, job_id: &str, job_name: &str) {
    let cron_session_id = format!("cron:{}", job_id);

    // Ensure the cron session exists
    let _ = db.ensure_session(&cron_session_id, job_name, "cronjob", Some(job_id));

    // Find the user's last message in the current (source) session
    let source_sid = super::get_current_session_id();
    if source_sid.is_empty() {
        return;
    }
    let messages = match db.get_recent_messages(&source_sid, 10) {
        Ok(msgs) => msgs,
        Err(_) => return,
    };

    // Find the last user message (the one that triggered this creation)
    if let Some(user_msg) = messages.iter().rev().find(|m| m.role == "user") {
        let _ = db.push_message(&cron_session_id, "user", &user_msg.content);
        let summary = format!("好的，我已为你创建了定时任务「{}」。你可以在这里查看执行历史、修改任务设置，或基于执行结果进行进一步操作。", job_name);
        let _ = db.push_message(&cron_session_id, "assistant", &summary);
    }
}

/// Build dispatch JSON from tool arguments, with smart bot context inference.
fn build_dispatch_json(args: &serde_json::Value) -> Option<String> {
    // Check for explicit dispatch_targets
    if let Some(targets) = args["dispatch_targets"].as_array() {
        let dispatch_targets: Vec<serde_json::Value> = targets.iter().map(|t| {
            serde_json::json!({
                "type": t["type"].as_str().unwrap_or("system"),
                "bot_id": t["bot_id"].as_str(),
                "target": t["target"].as_str(),
            })
        }).collect();
        let spec = serde_json::json!({"targets": dispatch_targets});
        return Some(spec.to_string());
    }

    // Smart inference: if we're in a bot conversation, add the current bot as a dispatch target
    if let Some((bot_id, conversation_id)) = super::get_current_bot_context() {
        if !conversation_id.trim().is_empty() {
            let spec = serde_json::json!({
                "targets": [
                    {"type": "system"},
                    {"type": "app"},
                    {"type": "bot", "bot_id": bot_id, "target": conversation_id}
                ]
            });
            return Some(spec.to_string());
        } else {
            let spec = serde_json::json!({
                "targets": [
                    {"type": "system"},
                    {"type": "app"}
                ]
            });
            return Some(spec.to_string());
        }
    }

    // No explicit targets and not in bot context — return None to use defaults
    None
}

/// Remove a scheduled job from the CronScheduler (for update/delete).
fn remove_scheduled_job(job_id: &str) {
    let scheduler_lock = match super::SCHEDULER.get() {
        Some(s) => s.clone(),
        None => return,
    };
    let job_id = job_id.to_string();
    tokio::spawn(async move {
        let guard = scheduler_lock.read().await;
        if let Some(ref scheduler) = *guard {
            if let Err(e) = scheduler.remove_job(&job_id).await {
                log::error!("Failed to remove job '{}' from scheduler: {}", job_id, e);
            }
        }
    });
}

/// Schedule a newly created job by registering it with the CronScheduler.
fn schedule_created_job(spec: crate::commands::cronjobs::CronJobSpec) {
    let scheduler_lock = match super::SCHEDULER.get() {
        Some(s) => s.clone(),
        None => {
            log::warn!("Scheduler not initialized, job '{}' will run after restart", spec.id);
            return;
        }
    };

    tokio::spawn(async move {
        let guard = scheduler_lock.read().await;
        if let Some(ref scheduler) = *guard {
            if let Err(e) = scheduler.add_job_from_globals(&spec).await {
                log::error!("Failed to schedule job '{}': {}", spec.id, e);
            }
        } else {
            log::warn!("Scheduler not started, job '{}' will run after restart", spec.id);
        }
    });
}
