use serde::Serialize;
use tauri::State;

use crate::state::AppState;
use crate::state::providers::ModelInfo;

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
    pub methods: Vec<String>,
}

#[tauri::command]
pub async fn health_check() -> Result<HealthResponse, String> {
    Ok(HealthResponse {
        status: "ok".to_string(),
        version: "0.1.0".to_string(),
        methods: vec![
            "chat".into(),
            "skills".into(),
            "models".into(),
            "channels".into(),
            "cronjobs".into(),
            "heartbeat".into(),
            "mcp".into(),
            "workspace".into(),
            "shell".into(),
            "browser".into(),
            "env".into(),
        ],
    })
}

#[tauri::command]
pub async fn list_models(state: State<'_, AppState>) -> Result<Vec<ModelInfo>, String> {
    let providers = state.providers.read().await;
    let all = providers.get_all_providers();
    let models: Vec<ModelInfo> = all
        .into_iter()
        .flat_map(|p| p.models)
        .collect();
    Ok(models)
}

#[tauri::command]
pub async fn set_model(
    state: State<'_, AppState>,
    model_name: String,
) -> Result<serde_json::Value, String> {
    // Find the provider that has this model
    let mut providers = state.providers.write().await;
    let all = providers.get_all_providers();

    for p in &all {
        if p.models.iter().any(|m| m.id == model_name) {
            providers.active_llm = Some(crate::state::providers::ModelSlotConfig {
                provider_id: p.id.clone(),
                model: model_name.clone(),
            });
            providers.save()?;
            return Ok(serde_json::json!({
                "status": "ok",
                "model": model_name
            }));
        }
    }

    Err(format!("Model '{}' not found", model_name))
}

#[tauri::command]
pub async fn get_current_model(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let providers = state.providers.read().await;
    match &providers.active_llm {
        Some(slot) => Ok(serde_json::json!({
            "status": "ok",
            "model": slot.model,
            "provider_id": slot.provider_id,
        })),
        None => Ok(serde_json::json!({
            "status": "ok",
            "model": null
        })),
    }
}

/// Save agents config (language, max_iterations, etc.)
#[tauri::command]
pub async fn save_agents_config(
    state: State<'_, AppState>,
    language: Option<String>,
    max_iterations: Option<usize>,
) -> Result<(), String> {
    let mut config = state.config.write().await;
    if let Some(lang) = language {
        config.agents.language = Some(lang);
    }
    if let Some(max) = max_iterations {
        config.agents.max_iterations = Some(max);
    }
    config.save(&state.working_dir)
}

/// Get user workspace path
#[tauri::command]
pub async fn get_user_workspace(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state.user_workspace().to_string_lossy().to_string())
}

/// Set user workspace path (persisted in config)
#[tauri::command]
pub async fn set_user_workspace(
    state: State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if !p.is_absolute() {
        return Err("Workspace path must be absolute".into());
    }
    std::fs::create_dir_all(&p)
        .map_err(|e| format!("Failed to create workspace directory: {}", e))?;

    // Update runtime state immediately
    state.set_user_workspace_path(p);

    let mut config = state.config.write().await;
    config.agents.workspace_dir = Some(path);
    config.save(&state.working_dir)
}

/// Check if the initial setup wizard has been completed
#[tauri::command]
pub async fn is_setup_complete(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.db.get_config("setup_complete").is_some())
}

/// Mark the initial setup as complete
#[tauri::command]
pub async fn complete_setup(state: State<'_, AppState>) -> Result<(), String> {
    state.db.set_config("setup_complete", "true")?;
    // Also create .bootstrap_completed flag to prevent BOOTSTRAP.md from being
    // injected into system prompt — SetupWizard already collected persona info.
    let flag = state.working_dir.join(".bootstrap_completed");
    std::fs::write(&flag, "done").map_err(|e| format!("Failed to write bootstrap flag: {}", e))?;
    Ok(())
}

/// Check if `claude` CLI is reachable. Falls back to common install paths
/// since GUI apps (launched via Finder/dock) may have a restricted PATH.
fn is_claude_cli_available() -> bool {
    let (cmd, args): (&str, &[&str]) = if cfg!(windows) {
        ("where", &["claude"])
    } else {
        ("which", &["claude"])
    };
    if std::process::Command::new(cmd)
        .args(args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        return true;
    }

    // Fallback: check common install locations (GUI apps may not inherit shell PATH)
    #[cfg(not(windows))]
    {
        let home = dirs::home_dir().unwrap_or_default();
        let candidates = [
            home.join(".npm-global/bin/claude"),
            home.join(".local/bin/claude"),
            std::path::PathBuf::from("/usr/local/bin/claude"),
            home.join(".nvm/current/bin/claude"),
        ];
        for path in &candidates {
            if path.exists() {
                return true;
            }
        }
    }

    false
}

/// Check Claude Code CLI status: installed + API key + available providers
#[tauri::command]
pub async fn check_claude_code_status(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    // 1. Check if CLI is installed (which/where + common install paths for GUI apps)
    let installed = is_claude_cli_available();

    // 2. Check ANTHROPIC_API_KEY in current process env or Claude Code config
    let has_api_key = std::env::var("ANTHROPIC_API_KEY")
        .map(|v| !v.is_empty())
        .unwrap_or(false)
        || check_claude_has_auth();

    // 3. Check if user has a configured provider that Claude Code can use
    let available_provider = if !has_api_key {
        find_usable_provider_for_claude(&state).await
    } else {
        None
    };

    Ok(serde_json::json!({
        "installed": installed,
        "has_api_key": has_api_key,
        "available_provider": available_provider,
    }))
}

/// Find a configured provider whose API key Claude Code can reuse.
/// Priority: anthropic > coding-plan > any custom provider with anthropic-compatible base URL.
async fn find_usable_provider_for_claude(
    state: &AppState,
) -> Option<serde_json::Value> {
    let providers = state.providers.read().await;
    let all = providers.get_all_providers();

    // Only Anthropic-compatible providers can work with Claude Code.
    // coding-plan (DashScope) uses OpenAI-compatible format, not Anthropic format.
    let candidates = ["anthropic"];

    for pid in candidates {
        let p = match all.iter().find(|p| p.id == pid) {
            Some(p) => p,
            None => continue,
        };

        // Try to get API key: saved settings > env var
        let api_key = providers
            .providers
            .get(pid)
            .and_then(|s| s.api_key.clone())
            .or_else(|| std::env::var(&p.api_key_prefix).ok())
            .filter(|k| !k.is_empty());

        if let Some(_key) = api_key {
            let base_url = p
                .base_url
                .as_deref()
                .unwrap_or(&p.default_base_url)
                .to_string();
            return Some(serde_json::json!({
                "id": pid,
                "name": p.name,
                "base_url": base_url,
            }));
        }
    }
    None
}

/// Check if Claude Code has valid authentication (API key or OAuth login).
fn check_claude_has_auth() -> bool {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return false,
    };

    // 1. Check ~/.claude.json for OAuth login (oauthAccount field)
    //    or API key stored in config
    if let Ok(content) = std::fs::read_to_string(home.join(".claude.json")) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
            // OAuth login: oauthAccount with accountUuid
            if json["oauthAccount"]["accountUuid"].as_str().is_some_and(|v| !v.is_empty()) {
                return true;
            }
            // API key in config
            let key = json["apiKey"].as_str()
                .or_else(|| json["api_key"].as_str());
            if key.is_some_and(|k| !k.is_empty()) {
                return true;
            }
        }
    }

    // 2. Check settings.json / config.json for API key
    let extras = [
        home.join(".claude").join("config.json"),
        home.join(".claude").join("settings.json"),
    ];
    for path in &extras {
        if let Ok(content) = std::fs::read_to_string(path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                let key = json["apiKey"].as_str()
                    .or_else(|| json["api_key"].as_str());
                if key.is_some_and(|k| !k.is_empty()) {
                    return true;
                }
            }
        }
    }

    false
}

/// Check if npm/node is available
fn is_npm_available() -> bool {
    let cmd = if cfg!(windows) { "where" } else { "which" };
    std::process::Command::new(cmd)
        .args(["npm"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Install Claude Code CLI via npm
#[tauri::command]
pub async fn install_claude_code() -> Result<serde_json::Value, String> {
    // Check if already installed
    if is_claude_cli_available() {
        return Ok(serde_json::json!({
            "success": true,
            "message": "Claude Code is already installed",
            "already_installed": true,
        }));
    }

    // Check if npm is available
    if !is_npm_available() {
        return Ok(serde_json::json!({
            "success": false,
            "message": "npm is not installed. Please install Node.js first from https://nodejs.org/",
            "needs_node": true,
        }));
    }

    // Run npm install
    log::info!("Installing Claude Code CLI via npm...");
    let output = tokio::process::Command::new("npm")
        .args(["install", "-g", "@anthropic-ai/claude-code"])
        .output()
        .await
        .map_err(|e| format!("Failed to run npm: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        // Verify installation
        let installed = is_claude_cli_available();
        if installed {
            log::info!("Claude Code CLI installed successfully");
            Ok(serde_json::json!({
                "success": true,
                "message": "Claude Code installed successfully!",
                "output": stdout.chars().take(500).collect::<String>(),
            }))
        } else {
            Ok(serde_json::json!({
                "success": false,
                "message": "npm install succeeded but 'claude' command not found in PATH. Try restarting your terminal.",
                "output": stdout.chars().take(500).collect::<String>(),
            }))
        }
    } else {
        let error_msg = if !stderr.is_empty() { &stderr } else { &stdout };
        log::error!("Claude Code installation failed: {}", error_msg);
        Ok(serde_json::json!({
            "success": false,
            "message": format!("Installation failed: {}", error_msg.chars().take(300).collect::<String>()),
        }))
    }
}

// ---------------------------------------------------------------------------
// Generic tool detection + installation framework
// ---------------------------------------------------------------------------

/// Check if a command is available by running it with the given arguments.
fn check_command(cmd: &str, args: &[&str]) -> bool {
    std::process::Command::new(cmd)
        .args(args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Check if a tool is available on the system.
#[tauri::command]
pub async fn check_tool_available(tool: String) -> Result<bool, String> {
    let result = match tool.as_str() {
        "git" => check_command("git", &["--version"]),
        "python" | "python3" => {
            check_command("python3", &["--version"]) || check_command("python", &["--version"])
        }
        "node" | "nodejs" => check_command("node", &["--version"]),
        "npm" => check_command("npm", &["--version"]),
        "pip" | "pip3" => {
            check_command("pip3", &["--version"]) || check_command("pip", &["--version"])
        }
        "ffmpeg" => check_command("ffmpeg", &["-version"]),
        "brew" => check_command("brew", &["--version"]),
        "cargo" => check_command("cargo", &["--version"]),
        "docker" => check_command("docker", &["--version"]),
        // Default: try running `tool --version`
        _ => check_command(&tool, &["--version"]),
    };
    Ok(result)
}

/// Try to install a package via Homebrew. Returns Some(message) on success.
fn try_brew_install(pkg: &str) -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    // If brew is not installed, try to install it first
    if !check_command("brew", &["--version"]) {
        log::info!("brew not found, attempting to install Homebrew first...");
        let install = std::process::Command::new("bash")
            .args(["-c", "curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh | bash"])
            .output();
        match install {
            Ok(out) if out.status.success() => {
                log::info!("Homebrew installed successfully");
            }
            _ => {
                log::warn!("Failed to install Homebrew, skipping brew strategy");
                return None;
            }
        }
    }
    let output = std::process::Command::new("brew")
        .args(["install", pkg])
        .output()
        .ok()?;
    if output.status.success() {
        Some(format!("installed via brew"))
    } else {
        None
    }
}

/// Try to install a package via Linux package managers.
/// Attempts apt-get, dnf, yum, pacman, zypper in order,
/// first without sudo, then with sudo.
fn try_linux_package_install(pkg: &str) -> Option<String> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    let managers: &[(&str, &[&str])] = &[
        ("apt-get", &["install", "-y"]),
        ("dnf", &["install", "-y"]),
        ("yum", &["install", "-y"]),
        ("pacman", &["-S", "--noconfirm"]),
        ("zypper", &["install", "-y"]),
    ];
    for (mgr, args) in managers {
        if !check_command("which", &[mgr]) {
            continue;
        }
        // Try without sudo first
        let mut cmd_args: Vec<&str> = args.to_vec();
        cmd_args.push(pkg);
        if let Ok(out) = std::process::Command::new(mgr).args(&cmd_args).output() {
            if out.status.success() {
                return Some(format!("installed via {}", mgr));
            }
        }
        // Try with sudo
        let mut sudo_args: Vec<&str> = vec![mgr];
        sudo_args.extend_from_slice(&cmd_args);
        if let Ok(out) = std::process::Command::new("sudo").args(&sudo_args).output() {
            if out.status.success() {
                return Some(format!("installed via sudo {}", mgr));
            }
        }
    }
    None
}

/// Try to run an arbitrary install command. Returns Some(message) on success.
fn try_command_install(cmd: &str, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new(cmd).args(args).output().ok()?;
    if output.status.success() {
        Some(format!("installation triggered via {}", cmd))
    } else {
        None
    }
}

/// Install a tool on the system. Returns a message describing the result.
/// The frontend should only call this after user explicitly authorizes the installation.
#[tauri::command]
pub async fn install_tool(tool: String) -> Result<String, String> {
    // Check if already installed
    let available = check_tool_available(tool.clone()).await?;
    if available {
        return Ok(format!("{} is already installed", tool));
    }

    // Try all applicable strategies in order — never give up after just one failure.
    // Each tool defines a cascade of installation methods sorted by preference.
    let result = match tool.as_str() {
        "git" => {
            None
                .or_else(|| if cfg!(target_os = "macos") { try_command_install("xcode-select", &["--install"]) } else { None })
                .or_else(|| try_brew_install("git"))
                .or_else(|| try_linux_package_install("git"))
        }
        "python" | "python3" => {
            None
                .or_else(|| try_brew_install("python"))
                .or_else(|| try_linux_package_install("python3"))
                .or_else(|| try_linux_package_install("python"))
        }
        "node" | "nodejs" => {
            None
                .or_else(|| try_brew_install("node"))
                .or_else(|| try_linux_package_install("nodejs"))
                .or_else(|| try_linux_package_install("node"))
                // Fallback: install via nvm
                .or_else(|| try_command_install("sh", &[
                    "-c", "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && . ~/.nvm/nvm.sh && nvm install --lts"
                ]))
        }
        "npm" => {
            // npm ships with node
            None
                .or_else(|| try_brew_install("node"))
                .or_else(|| try_linux_package_install("nodejs"))
                .or_else(|| try_linux_package_install("npm"))
        }
        "pip" | "pip3" => {
            None
                .or_else(|| try_brew_install("python"))
                .or_else(|| try_linux_package_install("python3-pip"))
                .or_else(|| try_linux_package_install("python-pip"))
                // Fallback: get-pip.py
                .or_else(|| try_command_install("sh", &[
                    "-c", "curl -sSL https://bootstrap.pypa.io/get-pip.py | python3"
                ]))
        }
        "ffmpeg" => {
            None
                .or_else(|| try_brew_install("ffmpeg"))
                .or_else(|| try_linux_package_install("ffmpeg"))
        }
        "cargo" | "rustc" => {
            // Install via rustup — works on all platforms
            None.or_else(|| try_command_install("sh", &[
                "-c", "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y"
            ]))
        }
        "docker" => {
            None
                .or_else(|| if cfg!(target_os = "macos") { try_brew_install("--cask docker") } else { None })
                .or_else(|| try_command_install("sh", &["-c", "curl -fsSL https://get.docker.com | sh"]))
                .or_else(|| try_linux_package_install("docker.io"))
        }
        "brew" => {
            if cfg!(target_os = "macos") || cfg!(target_os = "linux") {
                let result = try_command_install("bash", &[
                    "-c", "curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh | bash"
                ]);
                if result.is_some() {
                    return Ok("Homebrew installed successfully".to_string());
                }
                return Err("Homebrew installation failed. Please install manually: https://brew.sh".to_string());
            } else {
                return Err("Homebrew is available on macOS and Linux: https://brew.sh".to_string());
            }
        }
        _ => {
            // For unknown tools, try common installation paths anyway
            None
                .or_else(|| try_brew_install(&tool))
                .or_else(|| try_linux_package_install(&tool))
        }
    };

    match result {
        Some(msg) => Ok(format!("{} {}", tool, msg)),
        None => {
            // Provide specific install guidance per tool
            let hint = match tool.as_str() {
                "git" => "https://git-scm.com/downloads",
                "python" | "python3" => "https://www.python.org/downloads/",
                "node" | "nodejs" => "https://nodejs.org/",
                "ffmpeg" => "https://ffmpeg.org/download.html",
                "docker" => "https://docs.docker.com/get-docker/",
                "cargo" | "rustc" => "https://rustup.rs/",
                _ => "https://repology.org/",
            };
            Err(format!(
                "All automatic installation methods for '{}' failed. Please install manually: {}",
                tool, hint
            ))
        }
    }
}

/// Check if git is available on this system (backward-compatible wrapper)
#[tauri::command]
pub async fn check_git_available() -> Result<bool, String> {
    check_tool_available("git".to_string()).await
}

/// Install git based on the current operating system (backward-compatible wrapper)
#[tauri::command]
pub async fn install_git() -> Result<String, String> {
    install_tool("git".to_string()).await
}

/// Get a persistent app flag from the database
#[tauri::command]
pub async fn get_app_flag(
    state: State<'_, AppState>,
    key: String,
) -> Result<Option<String>, String> {
    Ok(state.db.get_config(&key))
}

/// Set a persistent app flag in the database
#[tauri::command]
pub async fn set_app_flag(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), String> {
    state.db.set_config(&key, &value)
}

// ---------------------------------------------------------------------------
// Growth System API
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_growth_report(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    use crate::engine::react_agent::{
        generate_growth_report, detect_skill_opportunity,
        build_capability_profile, build_growth_timeline,
    };

    let report = generate_growth_report(&state.db);
    let skill_suggestion = detect_skill_opportunity(&state.db);
    let capabilities = build_capability_profile(&state.db);
    let timeline = build_growth_timeline(&state.db, 30);

    Ok(serde_json::json!({
        "report": report,
        "skill_suggestion": skill_suggestion,
        "capabilities": capabilities,
        "timeline": timeline,
    }))
}

/// Get a morning greeting with proactive suggestions (called once per day).
#[tauri::command]
pub async fn get_morning_greeting(
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    use crate::engine::react_agent::generate_morning_reflection;
    use crate::commands::agent::resolve_llm_config;

    let config = match resolve_llm_config(&state).await {
        Ok(c) => c,
        Err(_) => return Ok(None), // No model configured, skip
    };

    Ok(generate_morning_reflection(&config, &state.db).await)
}

/// Disable a correction rule by id.
#[tauri::command]
pub async fn disable_correction(
    state: State<'_, AppState>,
    correction_id: String,
) -> Result<(), String> {
    state.db.disable_correction(&correction_id)
}

// ---------------------------------------------------------------------------
// Meditation API
// ---------------------------------------------------------------------------

/// Save meditation configuration.
#[tauri::command]
pub async fn save_meditation_config(
    state: State<'_, AppState>,
    enabled: bool,
    start_time: String,
    notify_on_complete: bool,
) -> Result<(), String> {
    let mut config = state.config.write().await;
    config.meditation.enabled = enabled;
    config.meditation.start_time = start_time;
    config.meditation.notify_on_complete = notify_on_complete;
    config.save(&state.working_dir)
}

/// Get current meditation configuration.
#[tauri::command]
pub async fn get_meditation_config(
    state: State<'_, AppState>,
) -> Result<crate::state::config::MeditationConfig, String> {
    let config = state.config.read().await;
    Ok(config.meditation.clone())
}

/// Get the latest meditation session from the database.
#[tauri::command]
pub async fn get_latest_meditation(
    state: State<'_, AppState>,
) -> Result<Option<crate::engine::db::MeditationSession>, String> {
    Ok(state.db.get_latest_meditation_session())
}

/// Manually trigger a meditation session (runs in background).
#[tauri::command]
pub async fn trigger_meditation(
    state: State<'_, AppState>,
) -> Result<(), String> {
    use crate::engine::meditation::run_meditation_session;
    use crate::commands::agent::resolve_llm_config;
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;

    // Prevent concurrent meditation sessions
    if state.meditation_running.compare_exchange(
        false, true,
        std::sync::atomic::Ordering::SeqCst,
        std::sync::atomic::Ordering::Relaxed,
    ).is_err() {
        return Err("A meditation session is already running".into());
    }

    let config = resolve_llm_config(&state).await.map_err(|e| {
        state.meditation_running.store(false, std::sync::atomic::Ordering::Relaxed);
        e
    })?;
    let db = state.db.clone();
    let working_dir = state.working_dir.clone();
    let cancel = Arc::new(AtomicBool::new(false));
    let meditation_guard = state.meditation_running.clone();

    tauri::async_runtime::spawn(async move {
        match run_meditation_session(&config, &db, &working_dir, cancel).await {
            Ok(r) => log::info!(
                "Manual meditation completed: {} sessions reviewed, journal len={}",
                r.sessions_reviewed,
                r.journal.len()
            ),
            Err(e) => log::error!("Manual meditation failed: {}", e),
        }
        meditation_guard.store(false, std::sync::atomic::Ordering::Relaxed);
    });

    Ok(())
}

/// Get the current meditation status (for Chat page polling).
/// Returns "running", "completed", or "idle".
#[tauri::command]
pub async fn get_meditation_status(
    state: State<'_, AppState>,
) -> Result<String, String> {
    match state.db.get_latest_meditation_session() {
        Some(session) => {
            if session.status == "running" {
                Ok("running".to_string())
            } else if session.status == "completed" {
                // Show "completed" only if finished within the last 5 minutes
                if let Some(finished_at) = session.finished_at {
                    let now = chrono::Utc::now().timestamp_millis();
                    if now - finished_at < 300 * 1000 {
                        return Ok("completed".to_string());
                    }
                }
                Ok("idle".to_string())
            } else {
                Ok("idle".to_string())
            }
        }
        None => Ok("idle".to_string()),
    }
}

/// Manually trigger principles consolidation.
#[tauri::command]
pub async fn consolidate_principles(
    state: State<'_, AppState>,
) -> Result<String, String> {
    use crate::engine::react_agent::consolidate_corrections_to_principles;
    use crate::commands::agent::resolve_llm_config;

    let config = resolve_llm_config(&state).await?;
    let working_dir = state.db.get_config("working_dir")
        .map(std::path::PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".yiyiclaw")))
        .ok_or("Cannot determine working directory")?;

    consolidate_corrections_to_principles(&config, &state.db, &working_dir).await
}
