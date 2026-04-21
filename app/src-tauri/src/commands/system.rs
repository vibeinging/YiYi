use serde::Serialize;
use tauri::State;

use crate::engine::db::QuickActionRow;
use crate::state::AppState;
use crate::state::providers::ModelInfo;

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
    pub methods: Vec<String>,
}

pub async fn health_check_impl() -> Result<HealthResponse, String> {
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
pub async fn health_check() -> Result<HealthResponse, String> {
    health_check_impl().await
}

pub async fn list_models_impl(state: &AppState) -> Result<Vec<ModelInfo>, String> {
    let providers = state.providers.read().await;
    let all = providers.get_all_providers();
    let models: Vec<ModelInfo> = all
        .into_iter()
        .flat_map(|p| p.models)
        .collect();
    Ok(models)
}

#[tauri::command]
pub async fn list_models(state: State<'_, AppState>) -> Result<Vec<ModelInfo>, String> {
    list_models_impl(&*state).await
}

pub async fn set_model_impl(
    state: &AppState,
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
pub async fn set_model(
    state: State<'_, AppState>,
    model_name: String,
) -> Result<serde_json::Value, String> {
    set_model_impl(&*state, model_name).await
}

pub async fn get_current_model_impl(
    state: &AppState,
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

#[tauri::command]
pub async fn get_current_model(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    get_current_model_impl(&*state).await
}

/// Save agents config (language, max_iterations, etc.)
pub async fn save_agents_config_impl(
    state: &AppState,
    language: Option<String>,
    max_iterations: Option<usize>,
) -> Result<(), String> {
    let mut config = state.config.write().await;
    if let Some(lang) = language {
        config.agents.language = Some(lang);
    }
    if let Some(max) = max_iterations {
        config.agents.max_iterations = Some(max.min(500)); // Cap to prevent infinite loops
    }
    config.save(&state.working_dir)
}

#[tauri::command]
pub async fn save_agents_config(
    state: State<'_, AppState>,
    language: Option<String>,
    max_iterations: Option<usize>,
) -> Result<(), String> {
    save_agents_config_impl(&*state, language, max_iterations).await
}

/// Get user workspace path
pub async fn get_user_workspace_impl(state: &AppState) -> Result<String, String> {
    Ok(state.user_workspace().to_string_lossy().to_string())
}

#[tauri::command]
pub async fn get_user_workspace(state: State<'_, AppState>) -> Result<String, String> {
    get_user_workspace_impl(&*state).await
}

/// Set user workspace path (persisted in config)
pub async fn set_user_workspace_impl(
    state: &AppState,
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

#[tauri::command]
pub async fn set_user_workspace(
    state: State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    set_user_workspace_impl(&*state, path).await
}

/// Check if the initial setup wizard has been completed
pub async fn is_setup_complete_impl(state: &AppState) -> Result<bool, String> {
    Ok(state.db.get_config("setup_complete").is_some())
}

#[tauri::command]
pub async fn is_setup_complete(state: State<'_, AppState>) -> Result<bool, String> {
    is_setup_complete_impl(&*state).await
}

/// Mark the initial setup as complete
pub async fn complete_setup_impl(state: &AppState) -> Result<(), String> {
    state.db.set_config("setup_complete", "true")?;
    // Also create .bootstrap_completed flag to prevent BOOTSTRAP.md from being
    // injected into system prompt — SetupWizard already collected persona info.
    let flag = state.working_dir.join(".bootstrap_completed");
    std::fs::write(&flag, "done").map_err(|e| format!("Failed to write bootstrap flag: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn complete_setup(state: State<'_, AppState>) -> Result<(), String> {
    complete_setup_impl(&*state).await
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
pub async fn check_tool_available_impl(tool: String) -> Result<bool, String> {
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
        // Reject unknown tools to prevent command injection
        _ => {
            log::warn!("check_tool_available: rejected unknown tool '{}'", tool);
            false
        }
    };
    Ok(result)
}

#[tauri::command]
pub async fn check_tool_available(tool: String) -> Result<bool, String> {
    check_tool_available_impl(tool).await
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
#[allow(dead_code)] // Kept for known-tool install paths but blocked from wildcard
fn try_linux_package_install(pkg: &str) -> Option<String> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    log::warn!("try_linux_package_install: attempting to install '{}' — may use sudo", pkg);
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
    let available = check_tool_available_impl(tool.clone()).await?;
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
            // Reject unknown tools to prevent arbitrary package installation
            log::warn!("install_tool: rejected unknown tool '{}'", tool);
            return Err(format!("Installation of '{}' is not supported. Only known tools can be installed.", tool));
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
#[allow(dead_code)]
pub async fn check_git_available_impl() -> Result<bool, String> {
    check_tool_available_impl("git".to_string()).await
}

#[tauri::command]
#[allow(dead_code)]
pub async fn check_git_available() -> Result<bool, String> {
    check_git_available_impl().await
}

/// Install git based on the current operating system (backward-compatible wrapper)
#[tauri::command]
#[allow(dead_code)]
pub async fn install_git() -> Result<String, String> {
    install_tool("git".to_string()).await
}

/// Get a persistent app flag from the database
pub async fn get_app_flag_impl(
    state: &AppState,
    key: String,
) -> Result<Option<String>, String> {
    validate_flag_key(&key)?;
    Ok(state.db.get_config(&key))
}

#[tauri::command]
pub async fn get_app_flag(
    state: State<'_, AppState>,
    key: String,
) -> Result<Option<String>, String> {
    get_app_flag_impl(&*state, key).await
}

/// Set a persistent app flag in the database
pub async fn set_app_flag_impl(
    state: &AppState,
    key: String,
    value: String,
) -> Result<(), String> {
    validate_flag_key(&key)?;
    state.db.set_config(&key, &value)
}

#[tauri::command]
pub async fn set_app_flag(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), String> {
    set_app_flag_impl(&*state, key, value).await
}

fn validate_flag_key(key: &str) -> Result<(), String> {
    const ALLOWED_KEYS: &[&str] = &[
        "setup_complete", "channels_migrated", "memme_seeded",
        "onboarding_step", "last_meditation", "theme",
    ];
    if ALLOWED_KEYS.contains(&key) || key.starts_with("user_") {
        Ok(())
    } else {
        Err(format!("Unknown flag key: '{}'. Only known flags are allowed.", key))
    }
}

// ---------------------------------------------------------------------------
// Growth System API
// ---------------------------------------------------------------------------

pub async fn get_growth_report_impl(
    state: &AppState,
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

#[tauri::command]
pub async fn get_growth_report(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    get_growth_report_impl(&*state).await
}

/// Get a morning greeting with proactive suggestions (called once per day).
pub async fn get_morning_greeting_impl(
    state: &AppState,
) -> Result<Option<String>, String> {
    use crate::engine::react_agent::generate_morning_reflection;
    use crate::commands::agent::resolve_llm_config;

    let config = match resolve_llm_config(state).await {
        Ok(c) => c,
        Err(_) => return Ok(None), // No model configured, skip
    };

    Ok(generate_morning_reflection(&config, &state.db).await)
}

#[tauri::command]
pub async fn get_morning_greeting(
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    get_morning_greeting_impl(&*state).await
}

/// Disable a correction rule by id.
pub async fn disable_correction_impl(
    state: &AppState,
    correction_id: String,
) -> Result<(), String> {
    state.db.disable_correction(&correction_id)
}

#[tauri::command]
pub async fn disable_correction(
    state: State<'_, AppState>,
    correction_id: String,
) -> Result<(), String> {
    disable_correction_impl(&*state, correction_id).await
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
    use crate::engine::mem::meditation::run_meditation_session;
    use crate::commands::agent::resolve_llm_config;
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;

    // Prevent concurrent meditation sessions
    if state.meditation_running.compare_exchange(
        false, true,
        std::sync::atomic::Ordering::SeqCst,
        std::sync::atomic::Ordering::Relaxed,
    ).is_err() {
        return Err("冥想正在进行中 / A meditation session is already running".into());
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
        // Drop guard: reset meditation_running on *any* exit path, including panic.
        struct ResetOnDrop(std::sync::Arc<AtomicBool>);
        impl Drop for ResetOnDrop {
            fn drop(&mut self) {
                self.0.store(false, std::sync::atomic::Ordering::Relaxed);
            }
        }
        let _reset = ResetOnDrop(meditation_guard);

        match run_meditation_session(&config, &db, &working_dir, cancel).await {
            Ok(r) => log::info!(
                "Manual meditation completed: {} sessions reviewed, journal len={}",
                r.sessions_reviewed,
                r.journal.len()
            ),
            Err(e) => log::error!("Manual meditation failed: {}", e),
        }
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
                // Stale-detection: if the process has been "running" for > 10 minutes
                // AND the in-process flag says nothing is running, treat as crashed → idle.
                let now = chrono::Utc::now().timestamp_millis();
                let age_ms = now - session.started_at;
                let flag_running = state.meditation_running.load(std::sync::atomic::Ordering::Relaxed);
                if age_ms > 10 * 60 * 1000 && !flag_running {
                    return Ok("idle".to_string());
                }
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

/// Get a summary of the latest completed meditation session.
#[tauri::command]
pub async fn get_meditation_summary(
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    match state.db.get_latest_completed_meditation_session() {
        Some(session) => {
            let mut parts = vec![];
            if session.memories_updated > 0 {
                parts.push(format!("整理了 {} 条记忆", session.memories_updated));
            }
            if session.memories_archived > 0 {
                parts.push(format!("归档了 {} 条旧记忆", session.memories_archived));
            }
            if session.principles_changed > 0 {
                parts.push(format!("更新了 {} 条行为准则", session.principles_changed));
            }
            if session.sessions_reviewed > 0 {
                parts.push(format!("回顾了 {} 段对话", session.sessions_reviewed));
            }
            if parts.is_empty() {
                Ok(Some("没有新的变化~".to_string()))
            } else {
                Ok(Some(parts.join("，")))
            }
        }
        None => Ok(None),
    }
}

// ---------------------------------------------------------------------------
// MemMe Memory Engine Configuration
// ---------------------------------------------------------------------------

/// Get current MemMe memory engine configuration.
#[tauri::command]
pub async fn get_memme_config(
    state: State<'_, AppState>,
) -> Result<crate::state::config::MemmeConfig, String> {
    let config = state.config.read().await;
    Ok(config.memme.clone())
}

/// Result of saving the MemMe config — carries non-fatal warnings the UI should surface.
#[derive(Serialize, Default)]
pub struct SaveMemmeConfigResult {
    /// True iff the LLM provider on the live store was rebuilt with the new config.
    pub llm_hot_swapped: bool,
    /// Optional warning message for the user (e.g. "no API key, LLM not active").
    pub warning: Option<String>,
}

/// Save MemMe memory engine configuration.
#[tauri::command]
pub async fn save_memme_config(
    state: State<'_, AppState>,
    config: crate::state::config::MemmeConfig,
) -> Result<SaveMemmeConfigResult, String> {
    {
        let mut cfg = state.config.write().await;
        cfg.memme = config.clone();
        cfg.save(&state.working_dir)?;
    }

    let mut result = SaveMemmeConfigResult::default();

    // Rebuild MemMe LLM provider so new URL/model/key take effect without app restart.
    let new_llm: Option<std::sync::Arc<dyn memme_llm::LlmProvider>> = {
        let providers = state.providers.read().await;
        crate::state::app_state::build_memme_llm(&providers, &config)
    };
    let store = crate::engine::tools::get_memme_store();

    match (store, new_llm) {
        (Some(store), Some(llm)) => {
            let store_clone = store.clone();
            // `set_llm_provider` drops the old provider, which owns a `reqwest::blocking::Client`
            // that internally carries a tokio runtime. Dropping that runtime from ANY tokio-managed
            // thread (including `spawn_blocking`) panics with "Cannot drop a runtime in a context
            // where blocking is not allowed". We need a plain OS thread that tokio knows nothing about.
            let (tx, rx) = tokio::sync::oneshot::channel();
            std::thread::spawn(move || {
                store_clone.set_llm_provider(llm);
                let _ = tx.send(());
            });
            let _ = rx.await;
            log::info!("MemMe LLM provider reloaded after config save");
            result.llm_hot_swapped = true;
        }
        (Some(_), None) => {
            // Either user cleared dedicated config but main provider has no API key,
            // or dedicated config itself is missing an API key. Either way the live
            // store still holds the previous LLM — make this visible to the user.
            log::warn!(
                "MemMe LLM not rebuilt (no usable provider). Old LLM remains active until restart or main provider gains an API key."
            );
            result.warning = Some(
                "记忆 LLM 未能切换：未找到可用的 API Key。请在「模型」标签页配置主模型 API Key，或在记忆模型卡片填写 API Key。".to_string(),
            );
        }
        (None, _) => {
            // Store not initialized yet (first-run before MemMe boot). Config is persisted,
            // store will pick it up on next init — no warning needed.
            log::info!("MemMe store not initialized; config persisted, will apply on next init");
        }
    }

    Ok(result)
}

/// Get MemMe identity traits (inferred user personality profile).
#[tauri::command]
pub async fn get_identity_traits(
    _state: State<'_, AppState>,
) -> Result<Vec<memme_core::types::identity::IdentityTrait>, String> {
    let store = crate::engine::tools::get_memme_store()
        .ok_or("MemMe store not initialized")?;
    store.list_identity_traits(crate::engine::tools::MEMME_USER_ID)
        .map_err(|e| format!("Failed to list identity traits: {}", e))
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
        .or_else(|| dirs::home_dir().map(|h| h.join(".yiyi")))
        .ok_or("Cannot determine working directory")?;

    consolidate_corrections_to_principles(&config, &state.db, &working_dir).await
}

// ---------------------------------------------------------------------------
// Quick Actions API
// ---------------------------------------------------------------------------

/// List all custom quick actions.
#[tauri::command]
pub async fn list_quick_actions(
    state: State<'_, AppState>,
) -> Result<Vec<QuickActionRow>, String> {
    Ok(state.db.list_quick_actions())
}

/// Add a new custom quick action.
#[tauri::command]
pub async fn add_quick_action(
    state: State<'_, AppState>,
    label: String,
    description: String,
    prompt: String,
    icon: String,
    color: String,
) -> Result<String, String> {
    state.db.add_quick_action(&label, &description, &prompt, &icon, &color)
}

/// Update an existing custom quick action.
#[tauri::command]
pub async fn update_quick_action(
    state: State<'_, AppState>,
    id: String,
    label: String,
    description: String,
    prompt: String,
    icon: String,
    color: String,
) -> Result<(), String> {
    state.db.update_quick_action(&id, &label, &description, &prompt, &icon, &color)
}

/// Delete a custom quick action.
#[tauri::command]
pub async fn delete_quick_action(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.db.delete_quick_action(&id)
}

// -----------------------------------------------------------------------
// Personality & Growth (Buddy personality evolution)
// -----------------------------------------------------------------------

/// Get aggregated personality stats (time-decayed weighted sum + base 50).
#[tauri::command]
pub async fn get_personality_stats(
    state: State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    let aggregates = state.db.get_personality_aggregates();
    let result: Vec<serde_json::Value> = aggregates.iter().map(|(trait_name, delta)| {
        let value = (crate::engine::db::PERSONALITY_BASE_STAT + delta).clamp(0.0, 100.0);
        serde_json::json!({
            "trait": trait_name,
            "value": value as i32,
            "delta": *delta,
        })
    }).collect();
    Ok(result)
}

/// Get personality signal timeline for growth visualization.
#[tauri::command]
pub async fn get_personality_timeline(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> Result<Vec<crate::engine::db::PersonalitySignalRow>, String> {
    Ok(state.db.list_personality_signals(limit.unwrap_or(50)))
}

/// Toggle sparkling (闪光记忆 / pinned) status on a memory via MemMe.
#[tauri::command]
pub async fn toggle_sparkling_memory(
    memory_id: String,
    sparkling: bool,
) -> Result<(), String> {
    let store = crate::engine::tools::get_memme_store()
        .ok_or_else(|| "MemMe store not initialized".to_string())?;
    store.pin_trace(&memory_id, sparkling)
        .map_err(|e| format!("Failed to toggle sparkling: {}", e))
}

/// List all sparkling (pinned) memories via MemMe.
#[tauri::command]
pub async fn list_sparkling_memories() -> Result<Vec<serde_json::Value>, String> {
    let store = crate::engine::tools::get_memme_store()
        .ok_or_else(|| "MemMe store not initialized".to_string())?;
    let results = store.list_pinned_traces(crate::engine::tools::MEMME_USER_ID)
        .map_err(|e| format!("Failed to list sparkling: {}", e))?;
    Ok(results.iter().map(|r| serde_json::json!({
        "id": r.id,
        "content": r.content,
        "category": r.categories.as_ref().and_then(|c| c.first()).cloned().unwrap_or_default(),
        "created_at": r.created_at,
    })).collect())
}

/// Get recall candidates for "还记得那天..." bubble via MemMe's nostalgia recall.
#[tauri::command]
pub async fn get_recall_candidates(
    limit: Option<i64>,
) -> Result<Vec<serde_json::Value>, String> {
    let store = crate::engine::tools::get_memme_store()
        .ok_or_else(|| "MemMe store not initialized".to_string())?;
    let results = store.recall_nostalgia(
        crate::engine::tools::MEMME_USER_ID,
        7,    // min 7 days old
        0.6,  // min importance
        limit.unwrap_or(3) as usize,
    ).map_err(|e| format!("Recall nostalgia failed: {}", e))?;
    Ok(results.iter().map(|r| serde_json::json!({
        "id": r.id,
        "content": r.content,
        "category": r.categories.as_ref().and_then(|c| c.first()).cloned().unwrap_or_default(),
        "confidence": r.importance.unwrap_or(0.5),
        "created_at": r.created_at,
    })).collect())
}
