use async_py::PyRunner;
use std::sync::OnceLock;
use tauri_plugin_python::PythonExt;

static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Store the app handle for Python bridge access from tools.
pub fn set_app_handle(handle: tauri::AppHandle) {
    APP_HANDLE.set(handle).ok();
}

/// Get the PyRunner from the stored app handle.
fn get_runner() -> Result<&'static PyRunner, String> {
    let handle = APP_HANDLE
        .get()
        .ok_or("Python bridge not initialized")?;
    Ok(handle.runner())
}

/// Call a registered Python function by name with string arguments.
pub async fn call_python(function: &str, args: Vec<String>) -> Result<String, String> {
    let runner = get_runner()?;
    let json_args: Vec<serde_json::Value> = args
        .into_iter()
        .map(serde_json::Value::String)
        .collect();

    let result = runner
        .call_function(function, json_args)
        .await
        .map_err(|e| format!("Python call error: {}", e))?;

    match result.as_str() {
        Some(s) => Ok(s.to_string()),
        None => Ok(result.to_string()),
    }
}

/// Execute arbitrary Python code string (no return value).
#[allow(dead_code)]
pub async fn run_python(code: &str) -> Result<String, String> {
    let runner = get_runner()?;
    runner
        .run(code)
        .await
        .map_err(|e| format!("Python run error: {}", e))?;
    Ok("Ok".into())
}

/// Evaluate a Python expression and return its value.
#[allow(dead_code)]
pub async fn eval_python(expr: &str) -> Result<String, String> {
    let runner = get_runner()?;
    let result = runner
        .eval(expr)
        .await
        .map_err(|e| format!("Python eval error: {}", e))?;

    match result.as_str() {
        Some(s) => Ok(s.to_string()),
        None => Ok(result.to_string()),
    }
}

/// Check if Python bridge is available.
pub fn is_available() -> bool {
    APP_HANDLE.get().is_some()
}
