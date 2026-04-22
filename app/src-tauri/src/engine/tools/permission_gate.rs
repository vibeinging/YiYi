//! Universal permission gate — pauses tool execution and asks the user
//! via a frontend dialog before proceeding with a denied operation.
//!
//! Flow: tool hits permission check → `request_permission()` emits event →
//! frontend shows dialog → user responds → `respond()` unblocks the caller.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use tauri::Emitter;
use tokio::sync::{oneshot, Mutex};

/// Payload sent to the frontend via `permission://request` event.
#[derive(Clone, serde::Serialize)]
pub struct PermissionRequest {
    pub request_id: String,
    /// "folder_access" | "folder_write" | "shell_block" | "shell_warn" | "sensitive_path"
    pub permission_type: String,
    /// The path or command that was denied.
    pub path: String,
    /// For folder types: the parent directory to authorize. Empty for shell types.
    pub parent_folder: String,
    /// Human-readable denial reason.
    pub reason: String,
    /// "low" | "medium" | "high"
    pub risk_level: String,
}

// ---------------------------------------------------------------------------
// Pending request registry
// ---------------------------------------------------------------------------

static PENDING: OnceLock<Mutex<HashMap<String, oneshot::Sender<bool>>>> = OnceLock::new();

fn pending() -> &'static Mutex<HashMap<String, oneshot::Sender<bool>>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Maximum time to wait for the user to respond before auto-denying.
const TIMEOUT_SECS: u64 = 30;

// ---------------------------------------------------------------------------
// Session-level memory — approved items are remembered until app restart.
// Keys: "shell_block::<command_prefix>" or "sensitive_path::<path>"
// ---------------------------------------------------------------------------

static SESSION_ALLOWED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn session_allowed() -> &'static Mutex<HashSet<String>> {
    SESSION_ALLOWED.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Maximum entries in session memory to prevent unbounded growth.
const MAX_SESSION_ENTRIES: usize = 5000;

/// Build the session memory key for a given permission type and path.
fn session_key(permission_type: &str, path: &str) -> String {
    format!("{}::{}", permission_type, path)
}

/// Check if this exact request was previously approved in this session.
async fn is_session_approved(permission_type: &str, path: &str) -> bool {
    let key = session_key(permission_type, path);
    session_allowed().lock().await.contains(&key)
}

/// Remember an approval for the rest of the session.
/// Evicts oldest entries if the cap is reached.
async fn remember_approval(permission_type: &str, path: &str) {
    let key = session_key(permission_type, path);
    let mut set = session_allowed().lock().await;
    if set.len() >= MAX_SESSION_ENTRIES {
        // Clear all when full — user will be re-prompted for previously approved items
        // This is simpler and more predictable than partial random eviction
        set.clear();
    }
    set.insert(key);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Emit a permission request to the frontend and block until the user responds.
///
/// Returns `true` if the user approved, `false` if denied or timed out.
/// If there is no AppHandle (headless / CLI mode), returns `false` immediately.
///
/// For non-persistent types (shell_block, shell_warn, sensitive_path), approvals
/// are remembered for the session so the user is not asked again for the same item.
pub async fn request_permission(req: PermissionRequest) -> bool {
    // Check session memory — skip dialog if user already approved this
    let rememberable = matches!(
        req.permission_type.as_str(),
        "shell_block" | "shell_warn" | "sensitive_path" | "computer_control"
    );
    if rememberable && is_session_approved(&req.permission_type, &req.path).await {
        log::info!(
            "Permission gate: session-approved '{}' for '{}'",
            req.permission_type,
            req.path
        );
        return true;
    }

    let handle = match super::APP_HANDLE.get() {
        Some(h) => h,
        None => return false,
    };

    let (tx, rx) = oneshot::channel::<bool>();
    {
        let mut map = pending().lock().await;
        map.insert(req.request_id.clone(), tx);
    }

    log::info!(
        "Permission gate: requesting '{}' for path '{}'",
        req.permission_type,
        req.path
    );

    if handle.emit("permission://request", &req).is_err() {
        pending().lock().await.remove(&req.request_id);
        return false;
    }

    match tokio::time::timeout(std::time::Duration::from_secs(TIMEOUT_SECS), rx).await {
        Ok(Ok(approved)) => {
            log::info!(
                "Permission gate: user {} request {}",
                if approved { "approved" } else { "denied" },
                req.request_id
            );
            // Remember approval in session memory
            if approved && rememberable {
                remember_approval(&req.permission_type, &req.path).await;
            }
            approved
        }
        _ => {
            pending().lock().await.remove(&req.request_id);
            log::info!("Permission gate: timed out for request {}", req.request_id);
            false
        }
    }
}

/// Called by the frontend (via Tauri command) to deliver the user's response.
pub async fn respond(request_id: &str, approved: bool) {
    if let Some(tx) = pending().lock().await.remove(request_id) {
        let _ = tx.send(approved);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_key_joins_type_and_path() {
        assert_eq!(session_key("shell_block", "rm -rf /"), "shell_block::rm -rf /");
        assert_eq!(session_key("sensitive_path", "/etc/passwd"), "sensitive_path::/etc/passwd");
    }

    #[tokio::test]
    async fn remember_then_check_returns_true() {
        // Use a unique path so other tests' shared state doesn't interfere.
        let path = "/tmp/permission_gate_test_UNIQUE_abcd";
        assert!(!is_session_approved("shell_block", path).await);
        remember_approval("shell_block", path).await;
        assert!(is_session_approved("shell_block", path).await);
    }

    #[test]
    fn extract_parent_folder_for_nonexistent_path_returns_parent() {
        let p = std::path::Path::new("/definitely/not/existing/foo.txt");
        let parent = extract_parent_folder(p);
        assert_eq!(parent.to_string_lossy(), "/definitely/not/existing");
    }

    #[test]
    fn extract_parent_folder_for_directory_returns_self() {
        let tmp = std::env::temp_dir();
        let parent = extract_parent_folder(&tmp);
        assert_eq!(parent, tmp);
    }

    #[tokio::test]
    async fn respond_without_pending_is_noop() {
        // Should not panic when the request_id is not in the pending map.
        respond("nonexistent-id", true).await;
    }
}

/// Helper: extract the best parent folder from a canonical path.
/// For files or non-existent paths, returns the parent directory.
/// For directories, returns the path itself.
pub fn extract_parent_folder(canonical: &std::path::Path) -> std::path::PathBuf {
    if canonical.is_file() || !canonical.exists() {
        canonical
            .parent()
            .unwrap_or(canonical)
            .to_path_buf()
    } else {
        canonical.to_path_buf()
    }
}
