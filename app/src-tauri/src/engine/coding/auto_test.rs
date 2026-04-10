//! Auto-test loop — run tests after file edits and return results to the Agent.
//!
//! When enabled, after each file write/edit, the system automatically:
//! 1. Detects project type
//! 2. Runs the appropriate test/check command
//! 3. Returns results so the Agent can self-correct
//!
//! This creates the edit→test→fix cycle that makes AI coding effective.

use std::path::Path;
use std::time::Duration;
use tokio::process::Command;

use super::project_detect::{detect_project, ProjectInfo, ProjectType};

const AUTO_TEST_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_OUTPUT_BYTES: usize = 8000;

/// Result of an auto-test run.
#[derive(Debug, Clone)]
pub struct AutoTestResult {
    pub command: String,
    pub passed: bool,
    pub output: String,
    pub duration_ms: u64,
}

/// Run the appropriate test/check command for the project containing the edited file.
pub async fn run_auto_test(edited_file: &str) -> Option<AutoTestResult> {
    let file_path = Path::new(edited_file);

    // Find project root by walking up from the edited file
    let project_root = find_project_root(file_path)?;
    let info = detect_project(&project_root);

    if info.project_type == ProjectType::Unknown {
        return None;
    }

    // Choose the fastest check command:
    // type_check (fastest) > test (thorough) > build (slowest)
    let check_cmd = pick_check_command(&info, edited_file);
    let cmd_str = check_cmd?;

    run_command(&cmd_str, &project_root).await
}

/// Run a specific test command and capture results.
#[allow(dead_code)]
pub async fn run_test_command(command: &str, workspace: &Path) -> Option<AutoTestResult> {
    run_command(command, workspace).await
}

/// Pick the best check command based on the edited file.
fn pick_check_command(info: &ProjectInfo, edited_file: &str) -> Option<String> {
    // For Rust: cargo check is fastest, use that for non-test files
    if info.project_type == ProjectType::Rust {
        if edited_file.contains("test") || edited_file.ends_with("_test.rs") {
            return info.test_command.clone();
        }
        return info.type_check_command.clone().or(info.build_command.clone());
    }

    // For TypeScript: tsc --noEmit is fastest
    if info.project_type == ProjectType::Node && edited_file.ends_with(".ts") || edited_file.ends_with(".tsx") {
        return info.type_check_command.clone().or(info.test_command.clone());
    }

    // For Python: pytest on the specific file if it's a test
    if info.project_type == ProjectType::Python {
        if edited_file.contains("test") {
            return Some(format!("pytest {}", edited_file));
        }
        return info.type_check_command.clone();
    }

    // Default: type check or test
    info.type_check_command.clone().or(info.test_command.clone())
}

/// Find project root by walking up directories looking for marker files.
fn find_project_root(file_path: &Path) -> Option<std::path::PathBuf> {
    let markers = [
        "Cargo.toml", "package.json", "pyproject.toml", "go.mod",
        "pom.xml", "build.gradle", "build.gradle.kts", "setup.py",
    ];

    let mut current = if file_path.is_file() {
        file_path.parent()?.to_path_buf()
    } else {
        file_path.to_path_buf()
    };

    for _ in 0..10 {
        for marker in &markers {
            if current.join(marker).exists() {
                return Some(current);
            }
        }
        current = current.parent()?.to_path_buf();
    }

    None
}

async fn run_command(cmd: &str, cwd: &Path) -> Option<AutoTestResult> {
    let start = std::time::Instant::now();

    let result = tokio::time::timeout(
        AUTO_TEST_TIMEOUT,
        Command::new("sh")
            .args(["-c", cmd])
            .current_dir(cwd)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output(),
    )
    .await;

    let duration_ms = start.elapsed().as_millis() as u64;

    match result {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let combined = if stderr.is_empty() {
                stdout.to_string()
            } else if stdout.is_empty() {
                stderr.to_string()
            } else {
                format!("{}\n{}", stdout, stderr)
            };

            // Truncate output
            let truncated = if combined.len() > MAX_OUTPUT_BYTES {
                format!(
                    "{}...\n[output truncated, {} bytes total]",
                    &combined[..MAX_OUTPUT_BYTES],
                    combined.len()
                )
            } else {
                combined
            };

            Some(AutoTestResult {
                command: cmd.to_string(),
                passed: output.status.success(),
                output: truncated,
                duration_ms,
            })
        }
        Ok(Err(e)) => Some(AutoTestResult {
            command: cmd.to_string(),
            passed: false,
            output: format!("Failed to execute: {}", e),
            duration_ms,
        }),
        Err(_) => Some(AutoTestResult {
            command: cmd.to_string(),
            passed: false,
            output: format!("Command timed out after {}s", AUTO_TEST_TIMEOUT.as_secs()),
            duration_ms,
        }),
    }
}

/// Session-scoped GreenContract tracking.
static GREEN_CONTRACTS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, super::green_contract::GreenContract>>> =
    std::sync::OnceLock::new();

fn contracts_map() -> &'static std::sync::Mutex<std::collections::HashMap<String, super::green_contract::GreenContract>> {
    GREEN_CONTRACTS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Update the session's GreenContract based on auto-test results.
pub fn update_green_contract(result: &AutoTestResult) {
    use super::green_contract::{GreenContract, GreenLevel};

    let session_id = crate::engine::tools::get_current_session_id();
    if session_id.is_empty() { return; }

    let mut contracts = contracts_map().lock().unwrap_or_else(|e| e.into_inner());
    let contract = contracts
        .entry(session_id)
        .or_insert_with(|| GreenContract::new(GreenLevel::TargetedTests));

    if result.passed {
        contract.update_level(GreenLevel::TargetedTests);
    }
}

/// Get the current session's green contract status (for tool output).
#[allow(dead_code)]
pub fn current_green_status() -> Option<String> {
    let session_id = crate::engine::tools::get_current_session_id();
    if session_id.is_empty() { return None; }

    let contracts = contracts_map().lock().unwrap_or_else(|e| e.into_inner());
    contracts.get(&session_id).map(|c| {
        let level = c.current_level.map_or("none", |l| l.as_str());
        let satisfied = c.evaluate().is_satisfied();
        format!("[Green: {} | {}]", level, if satisfied { "✅" } else { "⏳" })
    })
}

/// Format auto-test result as a message to append to tool output.
pub fn format_test_result(result: &AutoTestResult) -> String {
    let status = if result.passed { "✅ PASSED" } else { "❌ FAILED" };
    let mut msg = format!(
        "\n\n--- Auto-test: {} ({}, {}ms) ---\n",
        status, result.command, result.duration_ms
    );
    if !result.passed {
        msg.push_str(&result.output);
    } else {
        // On success, show minimal output
        let lines: Vec<&str> = result.output.lines().collect();
        if lines.len() <= 5 {
            msg.push_str(&result.output);
        } else {
            // Show last 3 lines (usually the summary)
            for line in lines.iter().rev().take(3).rev() {
                msg.push_str(line);
                msg.push('\n');
            }
        }
    }
    msg
}
