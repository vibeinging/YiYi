//! Run a user-approved install step (brew / winget / apt / open-url).
//!
//! Streams stdout+stderr lines to the caller's progress callback so the
//! frontend can show a live install log. Returns Ok on exit-0, Err with
//! stderr tail on non-zero. Sudo prompts on macOS will silently hang the
//! subprocess — caller should detect this and fall back to opening
//! Terminal.app for the user to enter their password (out of scope here).

use crate::state::config::InstallStep;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};

#[derive(Debug, Clone)]
pub struct InstallProgress {
    pub line: String,
    pub stream: ProgressStream,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProgressStream {
    Stdout,
    Stderr,
}

/// Run an install step, streaming output via `on_progress`. The step's
/// `kind` determines which shell to invoke; `command` is run via
/// `/bin/sh -c` on Unix and `cmd /C` on Windows so users can write
/// pipe / redirection / multi-statement scripts in the install field.
///
/// Returns `Ok(())` on exit code 0, otherwise `Err(message)`.
pub async fn run_install_step<F>(
    step: &InstallStep,
    mut on_progress: F,
) -> Result<(), String>
where
    F: FnMut(InstallProgress) + Send + 'static,
{
    let cmd_str = step
        .command
        .as_ref()
        .ok_or_else(|| format!("install step '{}' has no command to run", step.kind))?;

    #[cfg(unix)]
    let mut cmd = {
        let mut c = tokio::process::Command::new("/bin/sh");
        c.arg("-c").arg(cmd_str);
        c
    };
    #[cfg(windows)]
    let mut cmd = {
        let mut c = tokio::process::Command::new("cmd");
        c.arg("/C").arg(cmd_str);
        c
    };

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn install: {e}"))?;

    let stdout = child.stdout.take().ok_or("missing stdout pipe")?;
    let stderr = child.stderr.take().ok_or("missing stderr pipe")?;

    let mut out_reader = BufReader::new(stdout).lines();
    let mut err_reader = BufReader::new(stderr).lines();
    let mut last_stderr_lines: Vec<String> = Vec::new();

    loop {
        tokio::select! {
            line = out_reader.next_line() => {
                match line {
                    Ok(Some(s)) => on_progress(InstallProgress { line: s, stream: ProgressStream::Stdout }),
                    Ok(None) | Err(_) => break,
                }
            }
            line = err_reader.next_line() => {
                match line {
                    Ok(Some(s)) => {
                        last_stderr_lines.push(s.clone());
                        if last_stderr_lines.len() > 20 {
                            last_stderr_lines.remove(0);
                        }
                        on_progress(InstallProgress { line: s, stream: ProgressStream::Stderr });
                    }
                    Ok(None) | Err(_) => break,
                }
            }
        }
    }

    // Drain any remaining stdout/stderr after one side finished.
    while let Ok(Some(s)) = out_reader.next_line().await {
        on_progress(InstallProgress { line: s, stream: ProgressStream::Stdout });
    }
    while let Ok(Some(s)) = err_reader.next_line().await {
        last_stderr_lines.push(s.clone());
        if last_stderr_lines.len() > 20 {
            last_stderr_lines.remove(0);
        }
        on_progress(InstallProgress { line: s, stream: ProgressStream::Stderr });
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("install wait error: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        let tail = last_stderr_lines.join("\n");
        Err(format!(
            "install exited with code {:?}; tail:\n{}",
            status.code(),
            tail
        ))
    }
}
