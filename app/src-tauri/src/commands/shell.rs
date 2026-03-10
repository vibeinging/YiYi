use serde::Serialize;
use std::process::Stdio;

#[derive(Debug, Clone, Serialize)]
pub struct ShellResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[tauri::command]
pub async fn execute_shell(
    command: String,
    _args: Option<Vec<String>>,
    cwd: Option<String>,
) -> Result<ShellResult, String> {
    let mut cmd = tokio::process::Command::new("sh");
    cmd.arg("-c").arg(&command);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to execute command: {}", e))?;

    Ok(ShellResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

#[tauri::command]
pub async fn execute_shell_stream(
    command: String,
    args: Option<Vec<String>>,
    cwd: Option<String>,
) -> Result<String, String> {
    // For now, just use the same as execute_shell
    let result = execute_shell(command, args, cwd).await?;
    Ok(result.stdout)
}
