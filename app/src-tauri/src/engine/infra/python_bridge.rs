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
/// 子进程执行 + 超时(#4 2026-06-14):前台跑会阻塞的 python(如 `server.py` 起 http.server
/// 永不返回)原本会挂死整步、被 work idle 看门狗(300s)砍掉、连带整个 job 失败。封顶
/// 240s(低于看门狗),到点 kill 子进程并返回引导:服务/长驻进程用 execute_shell 的
/// run_in_background。`.output()` 会消费 child,改 spawn + 在超时分支 kill。
const PY_TIMEOUT_SECS: u64 = 240;

async fn run_with_timeout(
    mut cmd: tokio::process::Command,
    kind: &str,
) -> Result<String, String> {
    use tokio::io::AsyncReadExt;
    // pipe + 单独读 stdout/stderr,这样 child.wait() 只可变借用 child —— 超时分支能 kill
    // 子进程(否则前台跑的服务会变孤儿进程占着端口)。与 execute_shell 同款。
    let mut child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run {kind}: {}", e))?;
    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let out_h = tokio::spawn(async move {
        let mut b = Vec::new();
        if let Some(p) = out_pipe.as_mut() {
            p.read_to_end(&mut b).await.ok();
        }
        String::from_utf8_lossy(&b).to_string()
    });
    let err_h = tokio::spawn(async move {
        let mut b = Vec::new();
        if let Some(p) = err_pipe.as_mut() {
            p.read_to_end(&mut b).await.ok();
        }
        String::from_utf8_lossy(&b).to_string()
    });

    match tokio::time::timeout(
        std::time::Duration::from_secs(PY_TIMEOUT_SECS),
        child.wait(),
    )
    .await
    {
        Ok(Ok(status)) => {
            let stdout = out_h.await.unwrap_or_default();
            let stderr = err_h.await.unwrap_or_default();
            if status.success() {
                if stderr.is_empty() {
                    Ok(stdout)
                } else {
                    Ok(format!("{}\n[stderr]: {}", stdout, stderr))
                }
            } else {
                Err(format!("{kind} error:\n{}{}", stdout, stderr))
            }
        }
        Ok(Err(e)) => Err(format!("Failed to run {kind}: {}", e)),
        Err(_) => {
            child.kill().await.ok();
            Err(format!(
                "{kind} 超时被中断({PY_TIMEOUT_SECS}s)。多半是在前台跑了会阻塞的进程\
                 (服务/长驻)—— 别这样测,要跑服务用 execute_shell 的 run_in_background=true。"
            ))
        }
    }
}

pub async fn run_python(code: &str) -> Result<String, String> {
    let cmd = python_cmd().ok_or("Python not found. Install python3 to use this feature.")?;
    let mut c = tokio::process::Command::new(cmd);
    c.arg("-c").arg(code);
    run_with_timeout(c, "Python").await
}

/// Run a Python script file via subprocess.
pub async fn run_script(script_path: &str, args: &[String]) -> Result<String, String> {
    let cmd = python_cmd().ok_or("Python not found. Install python3 to use this feature.")?;
    let mut c = tokio::process::Command::new(cmd);
    c.arg(script_path).args(args);
    run_with_timeout(c, "Script").await
}

/// Legacy compat — used by bootstrap_python_packages (now no-op).
pub async fn call_python(_func: &str, _args: Vec<String>) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!("Python bridge uses subprocess — no embedded runtime"))
}
