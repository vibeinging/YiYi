//! Authorized-folder + sensitive-path access control.
//!
//! Every file-touching tool funnels through `access_check`, which enforces
//! three layers (highest priority first):
//!   1. Always-allow list (`/dev/null`, `/tmp`, …) — common shell I/O sinks.
//!   2. Internal working dir (`~/.yiyi`) — agent must always be able to read
//!      its own state without prompting.
//!   3. Sensitive-path blocklist — `~/.ssh/`, `**/.env`, etc. trigger a
//!      permission dialog even if inside an authorized folder.
//!   4. Authorized-folder allowlist — user-approved paths with `ReadOnly` or
//!      `ReadWrite` capability. A write into a ReadOnly folder prompts for
//!      an upgrade.
//!   5. Otherwise — prompt for folder authorization.
//!
//! The lists are loaded once from SQLite at startup and refreshed when the
//! user adds/removes entries from Settings.

use std::path::{Path, PathBuf};
use tokio::sync::Mutex;

use super::super::db;
use super::permission_gate;
use super::state::WORKING_DIR;

#[derive(Debug, Clone)]
pub struct AuthorizedFolder {
    pub path: PathBuf,
    pub permission: FolderPermission,
}

#[derive(Debug, Clone, PartialEq)]
pub enum FolderPermission {
    ReadOnly,
    ReadWrite,
}

#[derive(Debug, Clone)]
pub struct SensitivePattern {
    pub compiled: glob::Pattern,
    /// Pre-compiled pattern for filename-only matching (from `**/` prefix patterns).
    pub recursive_pattern: Option<glob::Pattern>,
    pub enabled: bool,
}

impl From<db::AuthorizedFolderRow> for AuthorizedFolder {
    fn from(r: db::AuthorizedFolderRow) -> Self {
        AuthorizedFolder {
            path: PathBuf::from(&r.path),
            permission: if r.permission == "read_only" {
                FolderPermission::ReadOnly
            } else {
                FolderPermission::ReadWrite
            },
        }
    }
}

impl From<db::SensitivePathRow> for SensitivePattern {
    fn from(r: db::SensitivePathRow) -> Self {
        let home = dirs::home_dir().unwrap_or_default();
        let home_str = home.to_string_lossy();
        let expanded = r.pattern.replace('~', &home_str);
        let compiled = glob::Pattern::new(&expanded)
            .unwrap_or_else(|_| glob::Pattern::new("__invalid__").unwrap());
        let recursive_pattern = r
            .pattern
            .strip_prefix("**/")
            .and_then(|stripped| glob::Pattern::new(stripped).ok());
        SensitivePattern {
            compiled,
            recursive_pattern,
            enabled: r.enabled,
        }
    }
}

/// Authorized folders loaded at startup, updated at runtime.
static AUTHORIZED_FOLDERS: std::sync::OnceLock<Mutex<Vec<AuthorizedFolder>>> =
    std::sync::OnceLock::new();

/// Sensitive path patterns.
static SENSITIVE_PATTERNS: std::sync::OnceLock<Mutex<Vec<SensitivePattern>>> =
    std::sync::OnceLock::new();

pub fn init_authorized_folders(rows: Vec<db::AuthorizedFolderRow>) {
    let folders: Vec<AuthorizedFolder> = rows.into_iter().map(AuthorizedFolder::from).collect();
    AUTHORIZED_FOLDERS.get_or_init(|| Mutex::new(folders));
}

pub fn init_sensitive_patterns(rows: Vec<db::SensitivePathRow>) {
    let patterns: Vec<SensitivePattern> = rows.into_iter().map(SensitivePattern::from).collect();
    SENSITIVE_PATTERNS.get_or_init(|| Mutex::new(patterns));
}

/// Refresh authorized folders from database (call after add/remove/update).
pub async fn refresh_authorized_folders(rows: Vec<db::AuthorizedFolderRow>) {
    if let Some(lock) = AUTHORIZED_FOLDERS.get() {
        let mut folders = lock.lock().await;
        *folders = rows.into_iter().map(AuthorizedFolder::from).collect();
    }
}

pub async fn refresh_sensitive_patterns(rows: Vec<db::SensitivePathRow>) {
    if let Some(lock) = SENSITIVE_PATTERNS.get() {
        let mut patterns = lock.lock().await;
        *patterns = rows.into_iter().map(SensitivePattern::from).collect();
    }
}

/// Expand and canonicalize a raw path string.
pub(crate) fn resolve_path(raw_path: &str) -> PathBuf {
    let expanded = if raw_path == "~" {
        dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
    } else if let Some(rest) = raw_path.strip_prefix("~/") {
        dirs::home_dir().unwrap_or_default().join(rest)
    } else if raw_path == "." {
        // Resolve "." to the workspace directory, not the process cwd
        WORKING_DIR.get().cloned().unwrap_or_else(|| PathBuf::from("."))
    } else {
        PathBuf::from(raw_path)
    };
    expanded.canonicalize().unwrap_or_else(|_| {
        // For non-existent paths, manually normalize to prevent traversal
        let mut normalized = PathBuf::new();
        for component in expanded.components() {
            match component {
                std::path::Component::ParentDir => {
                    normalized.pop();
                }
                other => normalized.push(other),
            }
        }
        normalized
    })
}

/// Check if a path is authorized for the requested operation.
/// Returns Ok(()) if allowed, Err with clear message if denied.
pub async fn access_check(raw_path: &str, needs_write: bool) -> Result<(), String> {
    if raw_path.is_empty() {
        return Ok(());
    }

    let canonical = resolve_path(raw_path);

    // 0. Always allow standard system paths that tools commonly use
    static ALWAYS_ALLOW: &[&str] = &[
        "/dev/null",
        "/dev/zero",
        "/dev/urandom",
        "/dev/random",
        "/dev/stdin",
        "/dev/stdout",
        "/dev/stderr",
        "/tmp",
        "/private/tmp",
    ];
    let canonical_str = canonical.to_string_lossy();
    if ALWAYS_ALLOW
        .iter()
        .any(|p| canonical_str.as_ref() == *p || canonical.starts_with(p))
    {
        return Ok(());
    }

    // 1. Always allow internal working directory (~/.yiyi)
    if let Some(wd) = WORKING_DIR.get() {
        let wd_canonical = wd.canonicalize().unwrap_or_else(|_| wd.clone());
        if canonical.starts_with(&wd_canonical) {
            return Ok(());
        }
    }

    // 2. Check sensitive path blocklist — ask user via permission gate
    if is_sensitive_path(&canonical).await {
        let reason = format!(
            "「{}」是敏感文件，即使在授权文件夹内也受保护。确定要访问吗？",
            raw_path
        );
        let req = permission_gate::PermissionRequest {
            request_id: uuid::Uuid::new_v4().to_string(),
            permission_type: "sensitive_path".into(),
            path: raw_path.to_string(),
            parent_folder: String::new(),
            reason: reason.clone(),
            risk_level: "high".into(),
        };
        if permission_gate::request_permission(req).await {
            return Ok(()); // One-time pass, not persisted
        }
        return Err(reason);
    }

    // 3. Check authorized folders
    if let Some(lock) = AUTHORIZED_FOLDERS.get() {
        let folders = lock.lock().await;
        for folder in folders.iter() {
            let fc = folder
                .path
                .canonicalize()
                .unwrap_or_else(|_| folder.path.clone());
            if canonical.starts_with(&fc) {
                if needs_write && folder.permission == FolderPermission::ReadOnly {
                    let reason = format!(
                        "「{}」在只读文件夹「{}」中，需要写入权限",
                        raw_path,
                        folder.path.display()
                    );
                    let req = permission_gate::PermissionRequest {
                        request_id: uuid::Uuid::new_v4().to_string(),
                        permission_type: "folder_write".into(),
                        path: raw_path.to_string(),
                        parent_folder: folder.path.display().to_string(),
                        reason: reason.clone(),
                        risk_level: "low".into(),
                    };
                    if permission_gate::request_permission(req).await {
                        return Ok(()); // Upgrade handled by frontend via respond command
                    }
                    return Err(reason);
                }
                return Ok(());
            }
        }
    }

    // 4. Not in any authorized folder — ask user to authorize
    let parent_folder = permission_gate::extract_parent_folder(&canonical);
    let parent_str = parent_folder.display().to_string();
    let reason = format!("「{}」不在任何授权文件夹中，是否允许访问？", raw_path);
    let req = permission_gate::PermissionRequest {
        request_id: uuid::Uuid::new_v4().to_string(),
        permission_type: "folder_access".into(),
        path: raw_path.to_string(),
        parent_folder: parent_str,
        reason: reason.clone(),
        risk_level: "low".into(),
    };
    if permission_gate::request_permission(req).await {
        return Ok(()); // Folder addition handled by frontend via respond command
    }
    Err(reason)
}

/// Check if a path matches any enabled sensitive pattern.
async fn is_sensitive_path(canonical: &Path) -> bool {
    let path_str = canonical.to_string_lossy();

    if let Some(lock) = SENSITIVE_PATTERNS.get() {
        let patterns = lock.lock().await;
        for sp in patterns.iter() {
            if !sp.enabled {
                continue;
            }
            if sp.compiled.matches(&path_str) {
                return true;
            }
            // Also check the filename alone for patterns like **/.env
            if let Some(ref recursive_glob) = sp.recursive_pattern {
                if let Some(filename) = canonical.file_name() {
                    let fname = filename.to_string_lossy();
                    if recursive_glob.matches(&fname) {
                        return true;
                    }
                }
            }
        }
    }
    false
}

/// Get all authorized folder paths as display strings (for system prompt).
pub async fn get_all_authorized_paths() -> Vec<String> {
    if let Some(lock) = AUTHORIZED_FOLDERS.get() {
        let folders = lock.lock().await;
        folders
            .iter()
            .map(|f| {
                let perm = if f.permission == FolderPermission::ReadOnly {
                    "read-only"
                } else {
                    "read-write"
                };
                format!("{} ({})", f.path.display(), perm)
            })
            .collect()
    } else {
        Vec::new()
    }
}
