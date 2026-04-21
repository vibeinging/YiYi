use app_lib::commands::shell::{execute_shell, execute_shell_stream};

#[tokio::test(flavor = "multi_thread")]
async fn execute_shell_echo_produces_expected_stdout() {
    let result = execute_shell("echo hello".to_string(), None, None).await.unwrap();
    assert_eq!(result.stdout.trim(), "hello");
    assert_eq!(result.exit_code, 0);
    assert_eq!(result.stderr, "");
}

#[tokio::test(flavor = "multi_thread")]
async fn execute_shell_nonzero_exit_reports_exit_code() {
    let result = execute_shell("exit 42".to_string(), None, None).await.unwrap();
    assert_eq!(result.exit_code, 42);
}

#[tokio::test(flavor = "multi_thread")]
async fn execute_shell_invalid_command_reports_stderr_or_error() {
    let result = execute_shell("nonexistent_command_xyz_12345".to_string(), None, None).await.unwrap();
    // sh returns exit code 127 when command not found
    assert_ne!(result.exit_code, 0);
    assert!(!result.stderr.is_empty() || result.exit_code == 127);
}

#[tokio::test(flavor = "multi_thread")]
async fn execute_shell_respects_cwd() {
    let tmp = tempfile::TempDir::new().unwrap();
    let result = execute_shell("pwd".to_string(), None, Some(tmp.path().to_string_lossy().to_string())).await.unwrap();
    // macOS tempdirs may resolve through /private, so match either form.
    let out = result.stdout.trim();
    let want = tmp.path().to_string_lossy().to_string();
    assert!(out.ends_with(&want) || out == format!("/private{}", want), "cwd mismatch: out={} want={}", out, want);
}

#[tokio::test(flavor = "multi_thread")]
async fn execute_shell_stream_returns_stdout() {
    let stdout = execute_shell_stream("printf abc".to_string(), None, None).await.unwrap();
    assert_eq!(stdout, "abc");
}
