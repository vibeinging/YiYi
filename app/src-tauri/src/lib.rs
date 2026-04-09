mod commands;
mod engine;
mod state;
mod tray;

use engine::infra::config_watcher::ConfigWatcher;
use engine::infra::python_bridge;
use engine::scheduler::CronScheduler;
use state::AppState;
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // macOS GUI apps don't inherit the user's shell PATH — fix it before anything else.
    fix_path_env();

    // Set PYTHONHOME so the embedded Python finds its stdlib.
    // In dev mode: use the system Python's stdlib.
    // In production: use the bundled python-stdlib/ in the app resources.
    setup_python_home();

    // Prevent Python from writing .pyc cache files into bundled stdlib,
    // which would trigger Tauri dev hot-reload.
    std::env::set_var("PYTHONDONTWRITEBYTECODE", "1");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_python::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::new())
        .manage(engine::worker::WorkerRegistry::new())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // macOS: apply vibrancy + set notification identity
            #[cfg(target_os = "macos")]
            {
                // Set mac-notification-sys application identity BEFORE tauri-plugin-notification
                // initializes it (both share the same Once-guarded static). In dev mode the Tauri
                // plugin would default to "com.apple.Terminal"; we override to our own identifier
                // so notifications show the correct app icon.
                let ident = if tauri::is_dev() {
                    "com.apple.Terminal" // dev: Terminal icon (matches Tauri plugin behavior)
                } else {
                    "com.yiyi.desktop"
                };
                let _ = mac_notification_sys::set_application(ident);

                let window = app.get_webview_window("main").unwrap();

                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
                apply_vibrancy(
                    &window,
                    NSVisualEffectMaterial::UnderWindowBackground,
                    None,
                    None,
                )
                .expect("Unsupported platform! 'apply_vibrancy' is only supported on macOS");

                window
                    .eval("document.body.classList.add('tauri-vibrancy')")
                    .ok();
            }

            // Setup system tray
            if let Err(e) = tray::setup_tray(app.handle()) {
                log::error!("Failed to setup system tray: {}", e);
            }

            // Store app handle for Python bridge
            python_bridge::set_app_handle(app.handle().clone());

            // Bootstrap Python packages on first launch
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    bootstrap_python_packages(&handle).await;
                });
            }

            // Seed builtin skills and default persona templates
            let state = app.state::<AppState>();
            commands::skills::seed_builtin_skills(&state.working_dir);
            let lang = {
                let cfg = tauri::async_runtime::block_on(state.config.read());
                cfg.agents.language.clone().unwrap_or_else(|| "zh-CN".into())
            };
            engine::react_agent::seed_default_templates(&state.working_dir, &lang);

            // Set MCP runtime, working dir, and app handle for tool execution
            engine::tools::set_mcp_runtime(state.mcp_runtime.clone());
            engine::tools::set_working_dir(state.working_dir.clone());
            engine::tools::set_app_handle(app.handle().clone());
            engine::tools::set_database(state.db.clone());
            engine::tools::set_providers(state.providers.clone());
            engine::tools::set_scheduler(state.scheduler.clone());
            engine::tools::set_streaming_state(state.streaming_state.clone());
            engine::tools::set_user_workspace(state.user_workspace());
            engine::tools::set_pty_manager(state.pty_manager.clone());
            engine::tools::set_memme_store(state.memme_store.clone());

            // Initialize the unified task registry
            engine::task_registry::init_global_registry();

            // Initialize authorized folders from database
            {
                let db_arc = &state.db;
                let folders = db_arc.list_authorized_folders();
                let sensitive = db_arc.list_sensitive_paths();

                // Ensure default workspace is always in authorized folders
                let user_ws = state.user_workspace();
                let has_default = folders.iter().any(|f| f.is_default);
                if !has_default {
                    let now = chrono::Utc::now().timestamp();
                    let default_folder = crate::engine::db::AuthorizedFolderRow {
                        id: uuid::Uuid::new_v4().to_string(),
                        path: user_ws.to_string_lossy().to_string(),
                        label: Some("Default Workspace".into()),
                        permission: "read_write".into(),
                        is_default: true,
                        created_at: now,
                        updated_at: now,
                    };
                    db_arc.upsert_authorized_folder(&default_folder).ok();
                }

                // Seed builtin sensitive patterns on first run
                if sensitive.is_empty() {
                    db_arc.seed_builtin_sensitive_patterns();
                }

                let folders = db_arc.list_authorized_folders();
                let sensitive = db_arc.list_sensitive_paths();
                crate::engine::tools::init_authorized_folders(folders);
                crate::engine::tools::init_sensitive_patterns(sensitive);
            }

            // Note: sandbox_paths are migrated to authorized_folders in db.open()

            // Recover interrupted tasks from previous session
            {
                let recovery_db = state.db.clone();
                let recovery_working_dir = state.working_dir.clone();
                tauri::async_runtime::spawn(async move {
                    recover_interrupted_tasks(&recovery_db, &recovery_working_dir).await;
                });
            }

            // Connect MCP clients in background
            {
                let mcp = state.mcp_runtime.clone();
                let mcp_config = {
                    let cfg = tauri::async_runtime::block_on(state.config.read());
                    cfg.mcp.clone()
                };
                tauri::async_runtime::spawn(async move {
                    for (key, cfg) in &mcp_config {
                        if !cfg.enabled {
                            continue;
                        }
                        let result = match cfg.transport.as_str() {
                            "stdio" => mcp.connect_stdio(key, cfg).await,
                            "http" | "streamable_http" => mcp.connect_http(key, cfg).await,
                            _ => {
                                log::warn!("Unknown MCP transport: {}", cfg.transport);
                                continue;
                            }
                        };
                        match result {
                            Ok(tools) => log::info!("MCP '{}': {} tools loaded", key, tools.len()),
                            Err(e) => log::warn!("MCP '{}' connection failed: {}", key, e),
                        }
                    }
                });
            }

            // Start MCP skill server if configured
            {
                let skill_server_config = {
                    let cfg = tauri::async_runtime::block_on(state.config.read());
                    cfg.skill_server.clone()
                };
                let wd = state.working_dir.clone();
                tauri::async_runtime::spawn(async move {
                    engine::infra::mcp_server::start_skill_server(wd, &skill_server_config).await;
                });
            }

            // Auto-start enabled bots in background
            {
                let bot_state = state.clone_shared();
                let bot_app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    match commands::bots::start_all_bots(&bot_state, bot_app_handle).await {
                        Ok(result) => log::info!("Auto-started bots: {}", result),
                        Err(e) => log::error!("Failed to auto-start bots: {}", e),
                    }
                });
            }

            // Load provider plugins from plugins/providers/ directory
            {
                let mut providers = tauri::async_runtime::block_on(state.providers.write());
                providers.load_plugins(&state.working_dir);
            }

            // Start config file watcher
            {
                let watcher = ConfigWatcher::new(
                    state.working_dir.clone(),
                    state.config.clone(),
                );
                tauri::async_runtime::spawn(async move {
                    watcher.watch().await;
                });
            }

            // Start provider plugin directory watcher
            {
                let plugin_watcher = crate::state::providers::PluginWatcher::new(
                    state.working_dir.clone(),
                    state.providers.clone(),
                );
                tauri::async_runtime::spawn(async move {
                    plugin_watcher.watch().await;
                });
            }

            // Start cron scheduler in background
            let scheduler_holder = state.scheduler.clone();

            let app_state_ref = state.clone_shared();

            tauri::async_runtime::spawn(async move {
                match CronScheduler::new().await {
                    Ok(scheduler) => {
                        if let Err(e) = scheduler.load_jobs(&app_state_ref).await {
                            log::error!("Failed to load cron jobs: {}", e);
                        }
                        if let Err(e) = scheduler.start().await {
                            log::error!("Failed to start cron scheduler: {}", e);
                        }
                        // Store scheduler in state for later use (e.g. resume one-time jobs)
                        *scheduler_holder.write().await = Some(scheduler);
                        log::info!("Cron scheduler started");
                    }
                    Err(e) => {
                        log::error!("Failed to create cron scheduler: {}", e);
                    }
                }
            });

            // Start meditation timer in background
            {
                let app_handle = app.handle().clone();
                start_meditation_timer(app_handle);
            }

            // One-time migration: seed MemMe from legacy MEMORY.md/PRINCIPLES.md
            {
                let migration_flag = state.working_dir.join(".memme_seeded");
                if !migration_flag.exists() {
                    crate::engine::mem::tiered_memory::seed_from_files(&state.working_dir);
                    std::fs::write(&migration_flag, "done").ok();
                    log::info!("MemMe seeded from legacy files");
                }
            }

            // Initialize plugins (run lifecycle Init commands)
            {
                let plugin_registry = state.plugin_registry.read().unwrap();
                plugin_registry.initialize_all();
                let plugin_count = plugin_registry.list().len();
                if plugin_count > 0 {
                    log::info!("Initialized {} plugins", plugin_count);
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Intercept the close request: hide window instead of quitting
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Prevent the window from actually closing
                api.prevent_close();
                // Hide the window so background services keep running
                window.hide().ok();
                log::info!("Window hidden to tray (background services continue)");
            }
        })
        .invoke_handler(tauri::generate_handler![
            // System
            commands::system::health_check,
            commands::system::list_models,
            commands::system::set_model,
            commands::system::get_current_model,
            commands::system::is_setup_complete,
            commands::system::complete_setup,
            commands::system::save_agents_config,
            commands::system::get_user_workspace,
            commands::system::set_user_workspace,
            commands::system::check_claude_code_status,
            commands::system::install_claude_code,
            commands::system::check_tool_available,
            commands::system::install_tool,
            commands::system::check_git_available,
            commands::system::install_git,
            commands::system::get_app_flag,
            commands::system::set_app_flag,
            commands::system::get_growth_report,
            commands::system::get_morning_greeting,
            commands::system::disable_correction,
            commands::system::consolidate_principles,
            commands::system::save_meditation_config,
            commands::system::get_meditation_config,
            commands::system::get_latest_meditation,
            commands::system::trigger_meditation,
            commands::system::get_meditation_status,
            commands::system::get_meditation_summary,
            commands::system::get_memme_config,
            commands::system::save_memme_config,
            commands::system::get_identity_traits,
            commands::system::list_quick_actions,
            commands::system::add_quick_action,
            commands::system::update_quick_action,
            commands::system::delete_quick_action,
            // Models & Providers
            commands::models::list_providers,
            commands::models::configure_provider,
            commands::models::test_provider,
            commands::models::test_model,
            commands::models::create_custom_provider,
            commands::models::delete_custom_provider,
            commands::models::add_model,
            commands::models::remove_model,
            commands::models::get_active_llm,
            commands::models::set_active_llm,
            commands::models::list_provider_templates,
            commands::models::import_provider_plugin,
            commands::models::export_provider_config,
            commands::models::scan_provider_plugins,
            commands::models::import_provider_from_template,
            // Workspace
            commands::workspace::list_workspace_files,
            commands::workspace::load_workspace_file,
            commands::workspace::load_workspace_file_binary,
            commands::workspace::save_workspace_file,
            commands::workspace::delete_workspace_file,
            commands::workspace::create_workspace_file,
            commands::workspace::create_workspace_dir,
            commands::workspace::upload_workspace,
            commands::workspace::download_workspace,
            commands::workspace::get_workspace_path,
            commands::workspace::list_authorized_folders,
            commands::workspace::add_authorized_folder,
            commands::workspace::respond_permission_request,
            commands::workspace::update_authorized_folder,
            commands::workspace::remove_authorized_folder,
            commands::workspace::list_sensitive_patterns,
            commands::workspace::add_sensitive_pattern,
            commands::workspace::toggle_sensitive_pattern,
            commands::workspace::remove_sensitive_pattern,
            commands::workspace::pick_folder,
            commands::workspace::list_folder_files,
            commands::workspace::list_agent_files,
            commands::workspace::read_agent_file,
            commands::workspace::write_agent_file,
            commands::workspace::list_memory_files,
            commands::workspace::read_memory_file,
            commands::workspace::write_memory_file,
            // Bots
            commands::bots::bots_list,
            commands::bots::bots_list_platforms,
            commands::bots::bots_get,
            commands::bots::bots_create,
            commands::bots::bots_update,
            commands::bots::bots_delete,
            commands::bots::bots_send,
            commands::bots::bots_start,
            commands::bots::bots_stop,
            commands::bots::bots_start_one,
            commands::bots::bots_stop_one,
            commands::bots::bots_running_list,
            commands::bots::bots_list_sessions,
            commands::bots::bot_conversations_list,
            commands::bots::bot_conversation_update_trigger,
            commands::bots::bot_conversation_link,
            commands::bots::bot_conversation_delete,
            commands::bots::bots_test_connection,
            commands::bots::bots_get_status,
            commands::bots::bot_conversation_set_agent,
            // Agent & Chat
            commands::agent::chat::chat,
            commands::agent::chat::chat_stream_start,
            commands::agent::chat::chat_stream_stop,
            commands::agent::chat::chat_stream_state,
            commands::agent::chat::get_history,
            commands::agent::chat::clear_history,
            commands::agent::chat::delete_message,
            // Sessions
            commands::agent::session::list_sessions,
            commands::agent::session::list_chat_sessions,
            commands::agent::session::search_chat_sessions,
            commands::agent::session::create_session,
            commands::agent::session::ensure_session,
            commands::agent::session::rename_session,
            commands::agent::session::delete_session,
            // Skills
            commands::skills::list_skills,
            commands::skills::get_skill,
            commands::skills::get_skill_content,
            commands::skills::enable_skill,
            commands::skills::disable_skill,
            commands::skills::update_skill,
            commands::skills::create_skill,
            commands::skills::delete_skill,
            commands::skills::import_skill,
            commands::skills::reload_skills,
            commands::skills::generate_skill_ai,
            // Skills Hub
            commands::skills::hub_search_skills,
            commands::skills::hub_list_skills,
            commands::skills::hub_install_skill,
            commands::skills::batch_enable_skills,
            commands::skills::batch_disable_skills,
            commands::skills::get_hub_config,
            // Cron Jobs
            commands::cronjobs::list_cronjobs,
            commands::cronjobs::create_cronjob,
            commands::cronjobs::update_cronjob,
            commands::cronjobs::delete_cronjob,
            commands::cronjobs::pause_cronjob,
            commands::cronjobs::resume_cronjob,
            commands::cronjobs::run_cronjob,
            commands::cronjobs::get_cronjob_state,
            commands::cronjobs::list_cronjob_executions,
            // Shell
            commands::shell::execute_shell,
            commands::shell::execute_shell_stream,
            // Browser
            commands::browser::launch_browser,
            commands::browser::browser_navigate,
            commands::browser::browser_screenshot,
            commands::browser::close_browser,
            // Heartbeat
            commands::heartbeat::get_heartbeat_config,
            commands::heartbeat::save_heartbeat_config,
            commands::heartbeat::send_heartbeat,
            commands::heartbeat::get_heartbeat_history,
            // Environment
            commands::env::list_envs,
            commands::env::save_envs,
            commands::env::delete_env,
            // MCP
            commands::mcp::list_mcp_clients,
            commands::mcp::get_mcp_client,
            commands::mcp::create_mcp_client,
            commands::mcp::update_mcp_client,
            commands::mcp::toggle_mcp_client,
            commands::mcp::delete_mcp_client,
            // Unified Users (cross-platform identity)
            commands::unified_users::unified_users_list,
            commands::unified_users::unified_users_create,
            commands::unified_users::unified_users_link,
            commands::unified_users::unified_users_unlink,
            // Tasks
            commands::tasks::create_task,
            commands::tasks::list_tasks,
            commands::tasks::get_task_status,
            commands::tasks::cancel_task,
            commands::tasks::pause_task,
            commands::tasks::send_task_message,
            commands::tasks::delete_task,
            commands::tasks::pin_task,
            commands::tasks::confirm_background_task,
            commands::tasks::convert_to_long_task,
            commands::tasks::get_task_by_name,
            commands::tasks::list_all_tasks_brief,
            commands::tasks::open_task_folder,
            // PTY
            commands::pty::pty_spawn,
            commands::pty::pty_write,
            commands::pty::pty_resize,
            commands::pty::pty_close,
            commands::pty::pty_list,
            // CLI Providers
            commands::cli::list_cli_providers,
            commands::cli::save_cli_provider_config,
            commands::cli::check_cli_provider,
            commands::cli::install_cli_provider,
            commands::cli::delete_cli_provider,
            // Buddy Companion
            commands::buddy::get_buddy_config,
            commands::buddy::save_buddy_config,
            commands::buddy::hatch_buddy,
            commands::buddy::buddy_observe,
            // Voice Control
            commands::voice::start_voice_session,
            commands::voice::stop_voice_session,
            commands::voice::get_voice_status,
            // Permissions
            commands::permissions::check_permissions,
            commands::permissions::request_accessibility,
            commands::permissions::request_screen_recording,
            commands::permissions::request_microphone,
            // Agents
            commands::agents::list_agents,
            commands::agents::get_agent,
            commands::agents::save_agent,
            commands::agents::delete_agent,
            // Plugins
            commands::plugins::list_plugins,
            commands::plugins::enable_plugin,
            commands::plugins::disable_plugin,
            commands::plugins::reload_plugins,
            // Workers
            commands::workers::list_workers,
            commands::workers::resolve_worker_trust,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Reopen { .. } = event {
                // macOS: clicking Dock icon should show the main window
                if let Some(window) = app_handle.get_webview_window("main") {
                    window.show().ok();
                    window.unminimize().ok();
                    window.set_focus().ok();
                }
            }
        });
}

/// Spawn a background loop that checks every 60 seconds if it's time to run meditation.
/// Includes catch-up logic: if the app was off during the scheduled time, meditation
/// runs on the next check after >24 h since the last session.
fn start_meditation_timer(app_handle: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Wait 30 seconds after app launch before starting checks
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;

        loop {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;

            let state = app_handle.state::<AppState>();

            // 1. Check if meditation is enabled
            let config = state.config.read().await;
            if !config.meditation.enabled {
                continue;
            }
            let start_time = config.meditation.start_time.clone();
            let notify = config.meditation.notify_on_complete;
            drop(config); // Release lock

            // 2. Check if another meditation is already running
            if state.meditation_running.load(std::sync::atomic::Ordering::Relaxed) {
                continue;
            }

            // 3. Check if meditation already ran today
            if has_meditation_today(&state.db) {
                continue;
            }

            // 4. Check if it's meditation time OR catch-up needed
            let should_run = is_meditation_time(&start_time) || should_catch_up(&state.db);
            if !should_run {
                continue;
            }

            // 5. Acquire meditation guard (compare-and-swap to prevent races)
            if state.meditation_running.compare_exchange(
                false, true,
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::Relaxed,
            ).is_err() {
                continue; // Another thread won the race
            }

            // 6. Run meditation
            log::info!("Starting scheduled meditation session");

            // Get LLM config
            let llm_config = match crate::commands::agent::resolve_llm_config(&state).await {
                Ok(c) => c,
                Err(e) => {
                    log::error!("Cannot start meditation: no LLM config: {}", e);
                    state.meditation_running.store(false, std::sync::atomic::Ordering::Relaxed);
                    continue;
                }
            };

            let db = state.db.clone();
            let working_dir = state.working_dir.clone();
            let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

            match crate::engine::mem::meditation::run_meditation_session(
                &llm_config, &db, &working_dir, cancel,
            )
            .await
            {
                Ok(result) => {
                    log::info!(
                        "Meditation completed: {} sessions reviewed, {} memories updated",
                        result.sessions_reviewed,
                        result.memories_updated,
                    );

                    // Send notification if enabled
                    if notify {
                        let _ = app_handle.emit(
                            "meditation-complete",
                            serde_json::json!({
                                "sessions_reviewed": result.sessions_reviewed,
                                "memories_updated": result.memories_updated,
                                "principles_changed": result.principles_changed,
                            }),
                        );
                    }
                }
                Err(e) => {
                    log::error!("Meditation failed: {}", e);
                }
            }

            // Release the meditation guard
            state.meditation_running.store(false, std::sync::atomic::Ordering::Relaxed);
        }
    });
}

/// Check if current time matches the meditation start_time (HH:MM format).
/// Matches within a 2-minute window since we check every 60 s.
fn is_meditation_time(start_time: &str) -> bool {
    use chrono::Timelike;
    let now = chrono::Local::now();
    let parts: Vec<&str> = start_time.split(':').collect();
    if parts.len() != 2 {
        return false;
    }

    let hour: u32 = parts[0].parse().unwrap_or(99);
    let minute: u32 = parts[1].parse().unwrap_or(99);

    now.hour() == hour && (now.minute() == minute || now.minute() == minute.wrapping_add(1))
}

/// Check if meditation already ran today (completed or running).
fn has_meditation_today(db: &std::sync::Arc<crate::engine::db::Database>) -> bool {
    if let Some(session) = db.get_latest_meditation_session() {
        let today_start = chrono::Local::now()
            .date_naive()
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc()
            .timestamp_millis();

        session.started_at >= today_start
            && (session.status == "completed" || session.status == "running")
    } else {
        false
    }
}

/// Check if catch-up meditation is needed (last meditation was >24 h ago).
/// If never meditated before, do NOT catch up — wait for the scheduled time.
fn should_catch_up(db: &std::sync::Arc<crate::engine::db::Database>) -> bool {
    match db.get_latest_meditation_session() {
        Some(session) => {
            if let Some(finished_at) = session.finished_at {
                let now = chrono::Utc::now().timestamp_millis();
                now - finished_at > 24 * 3600 * 1000 // More than 24 h since last meditation
            } else {
                false // Still running or never finished
            }
        }
        None => false, // Never meditated — wait for scheduled time, don't auto-trigger
    }
}

/// Bootstrap core Python packages on first launch.
/// Checks if packages are already installed, if not installs from bundled wheels.
async fn bootstrap_python_packages(handle: &tauri::AppHandle) {
    use tauri_plugin_python::PythonExt;

    let runner = handle.runner();
    let core_packages = r#"["pypdf","pptx","openpyxl","docx","PIL"]"#;

    // Check which core packages are missing
    match runner
        .call_function(
            "check_packages",
            vec![serde_json::Value::String(core_packages.into())],
        )
        .await
    {
        Ok(result) => {
            let result_str = result.as_str().map(|s| s.to_string()).unwrap_or_else(|| result.to_string());
            let missing: Vec<String> =
                serde_json::from_str(&result_str).unwrap_or_default();
            if missing.is_empty() {
                log::info!("All core Python packages are available");
                return;
            }
            log::info!("Missing Python packages: {:?}", missing);

            // Try offline install from bundled wheels
            // In dev mode, resource_dir may not contain wheels, so fallback to source dir
            let wheels_dir = handle
                .path()
                .resource_dir()
                .ok()
                .map(|d| d.join("wheels"))
                .filter(|d| d.join("requirements.txt").exists() && std::fs::read_dir(d).map(|mut r| r.any(|e| e.ok().map_or(false, |e| e.path().extension().map_or(false, |ext| ext == "whl")))).unwrap_or(false))
                .or_else(|| {
                    // Fallback: look next to the Cargo.toml (dev mode)
                    let dev_wheels = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("wheels");
                    if dev_wheels.exists() { Some(dev_wheels) } else { None }
                });

            if let Some(wheels_dir) = wheels_dir {
                let req_file = wheels_dir.join("requirements.txt");
                log::info!("Installing from wheels: {}", wheels_dir.display());
                match runner
                    .call_function(
                        "pip_install_offline",
                        vec![
                            serde_json::Value::String(
                                wheels_dir.to_string_lossy().into(),
                            ),
                            serde_json::Value::String(
                                req_file.to_string_lossy().into(),
                            ),
                        ],
                    )
                    .await
                {
                    Ok(msg) => {
                        let msg_str = msg.as_str().unwrap_or("done");
                        log::info!("Offline install: {}", msg_str);
                    }
                    Err(e) => log::warn!("Offline install failed: {}", e),
                }
            } else {
                log::info!("No bundled wheels found, packages must be installed manually");
            }
        }
        Err(e) => {
            log::warn!("Failed to check Python packages: {}", e);
        }
    }
}

/// Recover tasks that were "running" when the app was interrupted/crashed.
async fn recover_interrupted_tasks(
    db: &std::sync::Arc<crate::engine::db::Database>,
    working_dir: &std::path::Path,
) {
    // Find all tasks still marked as "running"
    let running_tasks = match db.list_tasks(None, Some("running")) {
        Ok(tasks) => tasks,
        Err(e) => {
            log::warn!("Failed to query running tasks for recovery: {}", e);
            return;
        }
    };

    if running_tasks.is_empty() {
        return;
    }

    log::info!("Found {} interrupted task(s) to recover", running_tasks.len());

    for task in running_tasks {
        // Read progress.json if available
        let progress_path = working_dir.join("tasks").join(&task.id).join("progress.json");
        let progress_info = std::fs::read_to_string(&progress_path)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());

        let round_info = progress_info
            .as_ref()
            .and_then(|p| p["current_round"].as_u64())
            .unwrap_or(0);

        log::info!(
            "Recovering task '{}' (id={}, round={})",
            task.title, task.id, round_info
        );

        // Build recovery context
        let recovery_context = format!(
            "你正在继续执行一个被中断的任务。\n\
            任务标题：{}\n\
            任务描述：{}\n\
            之前已执行到第 {} 轮。\n\
            请继续执行未完成的部分。",
            task.title,
            task.description.as_deref().unwrap_or(""),
            round_info,
        );

        // Push recovery context as system message
        db.push_message(&task.session_id, "system", &recovery_context).ok();

        // Re-spawn the task execution
        let plan: Vec<String> = task.plan
            .as_ref()
            .and_then(|p| serde_json::from_str(p).ok())
            .unwrap_or_default();

        crate::engine::tools::spawn_task_execution(
            task.id.clone(),
            task.session_id.clone(),
            task.title.clone(),
            task.description.unwrap_or_default(),
            plan,
            task.total_stages,
        );
    }
}

/// Set PYTHONHOME before Python interpreter initializes.
///
/// Directory layout:
///   Unix:    python-stdlib/lib/python3.X/...
///   Windows: python-stdlib/Lib/...  (no version subdirectory)
///
/// PYTHONHOME should point to python-stdlib/ (the prefix).
fn setup_python_home() {
    // If PYTHONHOME is already set externally, respect it
    if std::env::var("PYTHONHOME").is_ok() {
        return;
    }

    // Dev mode: check for bundled stdlib next to Cargo.toml
    let dev_stdlib = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("python-stdlib");
    if has_stdlib(&dev_stdlib) {
        std::env::set_var("PYTHONHOME", &dev_stdlib);
        eprintln!("[python] Using bundled stdlib: {}", dev_stdlib.display());
        return;
    }

    // Production mode: look for python-stdlib in the executable's directory.
    // On macOS .app bundles: Contents/MacOS/python-stdlib/
    // On Windows/Linux: next to the executable.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            // macOS: Contents/MacOS/ -> check Contents/Resources/python-stdlib/ first
            #[cfg(target_os = "macos")]
            {
                let resources = exe_dir.join("../Resources/python-stdlib");
                if has_stdlib(&resources) {
                    let canonical = resources.canonicalize().unwrap_or(resources.clone());
                    std::env::set_var("PYTHONHOME", &canonical);
                    eprintln!("[python] Using bundled stdlib: {}", canonical.display());
                    return;
                }
            }

            let prod_stdlib = exe_dir.join("python-stdlib");
            if has_stdlib(&prod_stdlib) {
                std::env::set_var("PYTHONHOME", &prod_stdlib);
                eprintln!("[python] Using bundled stdlib: {}", prod_stdlib.display());
                return;
            }
        }
    }
}

/// Fix PATH for macOS/Linux GUI apps.
///
/// When launched from Finder/Dock, the process inherits a minimal PATH
/// (e.g. `/usr/bin:/bin:/usr/sbin:/sbin`) that misses Homebrew, nvm, cargo, etc.
/// We run the user's login shell to get the real PATH and inject it.
fn fix_path_env() {
    #[cfg(not(unix))]
    return;

    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());

        // Use `printenv PATH` — an external command that reads the env var directly.
        // This is shell-agnostic: works with bash, zsh, fish, nushell, etc.
        // (`echo $PATH` would break on fish which outputs space-separated lists.)
        //
        // Spawn the child process and wait with a timeout: login shell may hang if
        // the user's profile does interactive work (ssh-agent prompt, conda init, etc.).
        let child = std::process::Command::new(&shell)
            .args(["-l", "-c", "/usr/bin/printenv PATH"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn();

        let mut child = match child {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[fix-path] Failed to spawn login shell: {}", e);
                return;
            }
        };

        // Poll with timeout — 3 seconds is generous for sourcing a shell profile
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) => {
                    if std::time::Instant::now() >= deadline {
                        let _ = child.kill();
                        eprintln!("[fix-path] Login shell timed out, using system default PATH");
                        break None;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                Err(_) => break None,
            }
        };

        if let Some(status) = status {
            if status.success() {
                if let Some(stdout) = child.stdout.take() {
                    use std::io::Read;
                    let mut buf = String::new();
                    let mut stdout = stdout;
                    stdout.read_to_string(&mut buf).ok();
                    let new_path = buf.trim().to_string();
                    let current = std::env::var("PATH").unwrap_or_default();
                    if !new_path.is_empty() && new_path != current {
                        std::env::set_var("PATH", &new_path);
                        eprintln!("[fix-path] Updated PATH from login shell");
                    }
                }
            }
        }
    }
}

/// Check if a directory looks like a valid Python stdlib prefix.
fn has_stdlib(base: &std::path::Path) -> bool {
    // Unix: {base}/lib/python3.X/
    if base.join("lib").exists() {
        return true;
    }
    // Windows: {base}/Lib/
    if base.join("Lib").exists() {
        return true;
    }
    false
}
