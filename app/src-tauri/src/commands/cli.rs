use serde::{Deserialize, Serialize};
use tauri::State;

use crate::state::AppState;
use crate::state::config::CliProviderConfig;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliProviderInfo {
    pub key: String,
    pub enabled: bool,
    pub binary: String,
    pub install_command: String,
    pub auth_command: String,
    pub check_command: String,
    pub credentials: std::collections::HashMap<String, String>,
    pub auth_status: String,
    /// Whether the CLI binary is found on the system.
    pub installed: bool,
}

fn config_to_info(key: &str, cfg: &CliProviderConfig) -> CliProviderInfo {
    let installed = which_binary(&cfg.binary);
    CliProviderInfo {
        key: key.to_string(),
        enabled: cfg.enabled,
        binary: cfg.binary.clone(),
        install_command: cfg.install_command.clone(),
        auth_command: cfg.auth_command.clone(),
        check_command: cfg.check_command.clone(),
        credentials: cfg.credentials.clone(),
        auth_status: cfg.auth_status.clone(),
        installed,
    }
}

/// Check if a binary exists on the system PATH.
fn which_binary(binary: &str) -> bool {
    #[cfg(unix)]
    {
        std::process::Command::new("which")
            .arg(binary)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(windows)]
    {
        std::process::Command::new("where")
            .arg(binary)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

#[tauri::command]
pub async fn list_cli_providers(
    state: State<'_, AppState>,
) -> Result<Vec<CliProviderInfo>, String> {
    let config = state.config.read().await;
    let providers: Vec<CliProviderInfo> = config
        .cli_providers
        .iter()
        .map(|(key, cfg)| config_to_info(key, cfg))
        .collect();
    Ok(providers)
}

#[tauri::command]
pub async fn save_cli_provider_config(
    state: State<'_, AppState>,
    key: String,
    config: CliProviderConfig,
) -> Result<CliProviderInfo, String> {
    {
        let mut app_config = state.config.write().await;
        app_config
            .cli_providers
            .insert(key.clone(), config.clone());
        app_config.save(&state.working_dir)?;
    }
    let info = config_to_info(&key, &config);
    Ok(info)
}

#[tauri::command]
pub async fn check_cli_provider(
    state: State<'_, AppState>,
    key: String,
) -> Result<CliProviderInfo, String> {
    let config = state.config.read().await;
    let cfg = config
        .cli_providers
        .get(&key)
        .ok_or_else(|| format!("CLI provider '{}' not found", key))?;
    Ok(config_to_info(&key, cfg))
}

#[tauri::command]
pub async fn install_cli_provider(
    state: State<'_, AppState>,
    key: String,
) -> Result<String, String> {
    let (install_cmd, binary) = {
        let config = state.config.read().await;
        let cfg = config
            .cli_providers
            .get(&key)
            .ok_or_else(|| format!("CLI provider '{}' not found", key))?;
        (cfg.install_command.clone(), cfg.binary.clone())
    };

    let output = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(&install_cmd)
        .output()
        .await
        .map_err(|e| format!("Failed to run install command: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        // Update auth_status to not_authenticated after install
        {
            let mut config = state.config.write().await;
            if let Some(cfg) = config.cli_providers.get_mut(&key) {
                cfg.auth_status = if which_binary(&binary) {
                    "not_authenticated".to_string()
                } else {
                    "unknown".to_string()
                };
            }
            config.save(&state.working_dir)?;
        }
        Ok(format!("Installed successfully.\n{}\n{}", stdout, stderr))
    } else {
        Err(format!(
            "Install failed (exit {}):\n{}\n{}",
            output.status.code().unwrap_or(-1),
            stdout,
            stderr
        ))
    }
}

#[tauri::command]
pub async fn delete_cli_provider(
    state: State<'_, AppState>,
    key: String,
) -> Result<(), String> {
    let mut config = state.config.write().await;
    config
        .cli_providers
        .remove(&key)
        .ok_or_else(|| format!("CLI provider '{}' not found", key))?;
    config.save(&state.working_dir)?;
    Ok(())
}
