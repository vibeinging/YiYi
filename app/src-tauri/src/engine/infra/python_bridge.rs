//! Python bridge — runs Python code via system `python3` subprocess.
//! No embedded runtime, no dylib linking. Same approach as Claw Code.

use std::process::Command;

static PYTHON_CMD: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();

/// Detect system python3/python.
fn detect_python() -> Option<String> {
    for cmd in &["python3", "python"] {
        if Command::new(cmd)
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_or(false, |s| s.success())
        {
            return Some(cmd.to_string());
        }
    }
    None
}

fn python_cmd() -> Option<&'static String> {
    PYTHON_CMD.get_or_init(detect_python).as_ref()
}

/// Check if a system Python is available.
pub fn is_available() -> bool {
    python_cmd().is_some()
}

/// No-op — subprocess doesn't need app handle.
pub fn set_app_handle(_handle: tauri::AppHandle) {}

/// Run Python code string via subprocess, capturing stdout.
pub async fn run_python(code: &str) -> Result<String, String> {
    let cmd = python_cmd().ok_or("Python not found. Install python3 to use this feature.")?;
    let output = tokio::process::Command::new(cmd)
        .arg("-c")
        .arg(code)
        .output()
        .await
        .map_err(|e| format!("Failed to run python: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        if stderr.is_empty() {
            Ok(stdout)
        } else {
            Ok(format!("{}\n[stderr]: {}", stdout, stderr))
        }
    } else {
        Err(format!("Python error:\n{}{}", stdout, stderr))
    }
}

/// Run a Python script file via subprocess.
pub async fn run_script(script_path: &str, args: &[String]) -> Result<String, String> {
    let cmd = python_cmd().ok_or("Python not found. Install python3 to use this feature.")?;
    let output = tokio::process::Command::new(cmd)
        .arg(script_path)
        .args(args)
        .output()
        .await
        .map_err(|e| format!("Failed to run script: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        if stderr.is_empty() {
            Ok(stdout)
        } else {
            Ok(format!("{}\n[stderr]: {}", stdout, stderr))
        }
    } else {
        Err(format!("Script error:\n{}{}", stdout, stderr))
    }
}

/// Legacy compat — used by bootstrap_python_packages (now no-op).
pub async fn call_python(_func: &str, _args: Vec<String>) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!("Python bridge uses subprocess — no embedded runtime"))
}
