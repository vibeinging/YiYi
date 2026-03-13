use serde::Serialize;
use std::io::{Read as IoRead, Write as IoWrite};
use tauri::State;

use crate::engine::db::{AuthorizedFolderRow, SensitivePathRow};
use crate::state::AppState;

#[derive(Serialize)]
pub struct WorkspaceFile {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub modified: Option<u64>,
}

/// Validate a user-supplied filename/path component to prevent path traversal.
/// Rejects names containing `..`, absolute paths, or null bytes.
fn validate_filename(name: &str) -> Result<(), String> {
    if name.contains("..") || name.starts_with('/') || name.starts_with('\\') || name.contains('\0')
    {
        return Err("Path traversal not allowed".into());
    }
    Ok(())
}

/// Resolve and validate a path within a base directory.
/// Returns the joined path only if it stays within base.
fn safe_path(base: &std::path::Path, name: &str) -> Result<std::path::PathBuf, String> {
    validate_filename(name)?;
    let path = base.join(name);
    // Double-check: the joined path must start with base
    if !path.starts_with(base) {
        return Err("Path traversal not allowed".into());
    }
    Ok(path)
}

#[tauri::command]
pub async fn list_workspace_files(
    state: State<'_, AppState>,
) -> Result<Vec<WorkspaceFile>, String> {
    let dir = state.user_workspace();
    let mut files = Vec::new();
    walk_dir(&dir, &dir, &mut files).await?;
    files.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(files)
}

/// Recursively walk a directory, collecting files with relative paths.
async fn walk_dir(
    base: &std::path::Path,
    current: &std::path::Path,
    out: &mut Vec<WorkspaceFile>,
) -> Result<(), String> {
    let mut entries = tokio::fs::read_dir(current)
        .await
        .map_err(|e| format!("Failed to read dir: {}", e))?;

    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }

        let metadata = entry.metadata().await.map_err(|e| e.to_string())?;
        let rel_path = entry
            .path()
            .strip_prefix(base)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .to_string();

        let modified = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs());

        let is_dir = metadata.is_dir();
        out.push(WorkspaceFile {
            name: rel_path.clone(),
            path: entry.path().to_string_lossy().to_string(),
            size: metadata.len(),
            is_dir,
            modified,
        });

        if is_dir {
            Box::pin(walk_dir(base, &entry.path(), out)).await?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn load_workspace_file(
    state: State<'_, AppState>,
    filename: String,
) -> Result<String, String> {
    let path = safe_path(&state.user_workspace(), &filename)?;
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Failed to read file '{}': {}", filename, e))
}

#[tauri::command]
pub async fn save_workspace_file(
    state: State<'_, AppState>,
    filename: String,
    content: String,
) -> Result<(), String> {
    let path = safe_path(&state.user_workspace(), &filename)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }
    tokio::fs::write(&path, content)
        .await
        .map_err(|e| format!("Failed to write file '{}': {}", filename, e))
}

#[tauri::command]
pub async fn delete_workspace_file(
    state: State<'_, AppState>,
    filename: String,
) -> Result<(), String> {
    let path = safe_path(&state.user_workspace(), &filename)?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("Failed to stat '{}': {}", filename, e))?;
    if metadata.is_dir() {
        tokio::fs::remove_dir_all(&path).await
    } else {
        tokio::fs::remove_file(&path).await
    }
    .map_err(|e| format!("Failed to delete '{}': {}", filename, e))
}

#[tauri::command]
pub async fn create_workspace_file(
    state: State<'_, AppState>,
    filename: String,
    content: String,
) -> Result<(), String> {
    let path = safe_path(&state.user_workspace(), &filename)?;
    if tokio::fs::try_exists(&path).await.unwrap_or(false) {
        return Err(format!("File '{}' already exists", filename));
    }
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }
    tokio::fs::write(&path, content)
        .await
        .map_err(|e| format!("Failed to create file '{}': {}", filename, e))
}

#[tauri::command]
pub async fn create_workspace_dir(
    state: State<'_, AppState>,
    dirname: String,
) -> Result<(), String> {
    let path = safe_path(&state.user_workspace(), &dirname)?;
    if tokio::fs::try_exists(&path).await.unwrap_or(false) {
        return Err(format!("Directory '{}' already exists", dirname));
    }
    tokio::fs::create_dir_all(&path)
        .await
        .map_err(|e| format!("Failed to create directory '{}': {}", dirname, e))
}

#[tauri::command]
pub async fn load_workspace_file_binary(
    state: State<'_, AppState>,
    filename: String,
) -> Result<Vec<u8>, String> {
    let path = safe_path(&state.user_workspace(), &filename)?;
    tokio::fs::read(&path)
        .await
        .map_err(|e| format!("Failed to read file '{}': {}", filename, e))
}

#[tauri::command]
pub async fn upload_workspace(
    state: State<'_, AppState>,
    data: Vec<u8>,
    filename: String,
) -> Result<serde_json::Value, String> {
    let working_dir = state.user_workspace();
    // Zip operations require sync I/O
    tokio::task::spawn_blocking(move || {
        let cursor = std::io::Cursor::new(&data);
        let mut archive =
            zip::ZipArchive::new(cursor).map_err(|e| format!("Invalid zip file: {}", e))?;

        for i in 0..archive.len() {
            let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
            let name = file.name().to_string();

            if name.contains("..") || name.starts_with('/') || name.contains('\0') {
                continue;
            }

            let out_path = working_dir.join(&name);
            if !out_path.starts_with(&working_dir) {
                continue;
            }

            if file.is_dir() {
                std::fs::create_dir_all(&out_path).ok();
            } else {
                if let Some(parent) = out_path.parent() {
                    std::fs::create_dir_all(parent).ok();
                }
                let mut out_file = std::fs::File::create(&out_path)
                    .map_err(|e| format!("Failed to create {}: {}", name, e))?;
                let mut buf = Vec::new();
                file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
                out_file.write_all(&buf).map_err(|e| e.to_string())?;
            }
        }

        Ok(serde_json::json!({
            "success": true,
            "message": format!("Uploaded and extracted {}", filename)
        }))
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
pub async fn download_workspace(state: State<'_, AppState>) -> Result<Vec<u8>, String> {
    let working_dir = state.user_workspace();
    tokio::task::spawn_blocking(move || {
        let mut buf = Vec::new();
        {
            let cursor = std::io::Cursor::new(&mut buf);
            let mut zip = zip::ZipWriter::new(cursor);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);

            fn add_dir(
                zip: &mut zip::ZipWriter<std::io::Cursor<&mut Vec<u8>>>,
                base: &std::path::Path,
                current: &std::path::Path,
                options: zip::write::SimpleFileOptions,
            ) -> Result<(), String> {
                for entry in std::fs::read_dir(current)
                    .map_err(|e| e.to_string())?
                    .flatten()
                {
                    let path = entry.path();
                    let name = path
                        .strip_prefix(base)
                        .map_err(|e| e.to_string())?
                        .to_string_lossy()
                        .to_string();

                    if name.starts_with('.') {
                        continue;
                    }

                    if path.is_dir() {
                        zip.add_directory(format!("{}/", name), options)
                            .map_err(|e| e.to_string())?;
                        add_dir(zip, base, &path, options)?;
                    } else {
                        zip.start_file(&name, options).map_err(|e| e.to_string())?;
                        let data = std::fs::read(&path).map_err(|e| e.to_string())?;
                        zip.write_all(&data).map_err(|e| e.to_string())?;
                    }
                }
                Ok(())
            }

            add_dir(&mut zip, &working_dir, &working_dir, options)?;
            zip.finish().map_err(|e| e.to_string())?;
        }
        Ok(buf)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
pub async fn get_workspace_path(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state.user_workspace().to_string_lossy().to_string())
}

// --- Workspace authorization ---

#[tauri::command]
pub async fn list_authorized_folders(
    state: State<'_, AppState>,
) -> Result<Vec<AuthorizedFolderRow>, String> {
    Ok(state.db.list_authorized_folders())
}

#[tauri::command]
pub async fn add_authorized_folder(
    state: State<'_, AppState>,
    path: String,
    label: Option<String>,
    permission: Option<String>,
) -> Result<AuthorizedFolderRow, String> {
    let p = std::path::Path::new(&path);
    if !p.is_absolute() {
        return Err("Path must be absolute".into());
    }
    std::fs::create_dir_all(p).map_err(|e| format!("Failed to create directory: {}", e))?;
    let now = chrono::Utc::now().timestamp();
    let folder = AuthorizedFolderRow {
        id: uuid::Uuid::new_v4().to_string(),
        path: p.canonicalize().unwrap_or(p.to_path_buf()).to_string_lossy().to_string(),
        label,
        permission: permission.unwrap_or_else(|| "read_write".into()),
        is_default: false,
        created_at: now,
        updated_at: now,
    };
    state.db.upsert_authorized_folder(&folder)?;
    let all = state.db.list_authorized_folders();
    crate::engine::tools::refresh_authorized_folders(all).await;
    Ok(folder)
}

#[tauri::command]
pub async fn update_authorized_folder(
    state: State<'_, AppState>,
    id: String,
    label: Option<String>,
    permission: Option<String>,
) -> Result<(), String> {
    let mut target = state.db.get_authorized_folder(&id)?
        .ok_or("Folder not found")?;
    if let Some(l) = label { target.label = Some(l); }
    if let Some(p) = permission { target.permission = p; }
    target.updated_at = chrono::Utc::now().timestamp();
    state.db.upsert_authorized_folder(&target)?;
    let all = state.db.list_authorized_folders();
    crate::engine::tools::refresh_authorized_folders(all).await;
    Ok(())
}

#[tauri::command]
pub async fn remove_authorized_folder(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let folders = state.db.list_authorized_folders();
    if let Some(f) = folders.iter().find(|f| f.id == id) {
        if f.is_default {
            return Err("Cannot remove the default workspace folder".into());
        }
    }
    state.db.remove_authorized_folder(&id)?;
    let all = state.db.list_authorized_folders();
    crate::engine::tools::refresh_authorized_folders(all).await;
    Ok(())
}

#[tauri::command]
pub async fn list_sensitive_patterns(
    state: State<'_, AppState>,
) -> Result<Vec<SensitivePathRow>, String> {
    Ok(state.db.list_sensitive_paths())
}

#[tauri::command]
pub async fn add_sensitive_pattern(
    state: State<'_, AppState>,
    pattern: String,
) -> Result<SensitivePathRow, String> {
    let now = chrono::Utc::now().timestamp();
    let row = SensitivePathRow {
        id: uuid::Uuid::new_v4().to_string(),
        pattern,
        is_builtin: false,
        enabled: true,
        created_at: now,
    };
    state.db.upsert_sensitive_path(&row)?;
    let all = state.db.list_sensitive_paths();
    crate::engine::tools::refresh_sensitive_patterns(all).await;
    Ok(row)
}

#[tauri::command]
pub async fn toggle_sensitive_pattern(
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    state.db.toggle_sensitive_path(&id, enabled)?;
    let all = state.db.list_sensitive_paths();
    crate::engine::tools::refresh_sensitive_patterns(all).await;
    Ok(())
}

#[tauri::command]
pub async fn remove_sensitive_pattern(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.db.remove_sensitive_path(&id)?;
    let all = state.db.list_sensitive_paths();
    crate::engine::tools::refresh_sensitive_patterns(all).await;
    Ok(())
}

#[tauri::command]
pub async fn pick_folder() -> Result<Option<String>, String> {
    let handle = rfd::AsyncFileDialog::new()
        .set_title("Select folder to authorize")
        .pick_folder()
        .await;
    Ok(handle.map(|h| h.path().to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn list_folder_files(
    state: State<'_, AppState>,
    folder_path: String,
) -> Result<Vec<WorkspaceFile>, String> {
    let folders = state.db.list_authorized_folders();
    let canonical = std::path::Path::new(&folder_path)
        .canonicalize()
        .map_err(|e| format!("Invalid path: {}", e))?;
    let authorized = folders.iter().any(|f| {
        let fp = std::path::Path::new(&f.path)
            .canonicalize()
            .unwrap_or_else(|_| std::path::PathBuf::from(&f.path));
        canonical.starts_with(&fp)
    });
    if !authorized {
        return Err("Path is not in any authorized folder".into());
    }
    walk_workspace_files(&canonical).await
}

/// Walk a directory and return a flat list of files, reusing the same logic as list_workspace_files.
async fn walk_workspace_files(dir: &std::path::Path) -> Result<Vec<WorkspaceFile>, String> {
    let mut files = Vec::new();
    walk_dir(dir, dir, &mut files).await?;
    files.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(files)
}

// --- Agent/Memory file management ---

async fn list_subdir_md_files(
    base: &std::path::Path,
    subdir: &str,
) -> Vec<WorkspaceFile> {
    let dir = base.join(subdir);
    let mut files = Vec::new();

    let mut entries = match tokio::fs::read_dir(&dir).await {
        Ok(e) => e,
        Err(_) => return files,
    };

    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".md") {
            continue;
        }
        let metadata = entry.metadata().await.ok();
        let modified = metadata
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs());
        files.push(WorkspaceFile {
            name: name.clone(),
            path: entry.path().to_string_lossy().to_string(),
            size: metadata.as_ref().map_or(0, |m| m.len()),
            is_dir: false,
            modified,
        });
    }
    files
}

#[tauri::command]
pub async fn list_agent_files(state: State<'_, AppState>) -> Result<Vec<WorkspaceFile>, String> {
    Ok(list_subdir_md_files(&state.working_dir, ".").await)
}

#[tauri::command]
pub async fn read_agent_file(
    state: State<'_, AppState>,
    md_name: String,
) -> Result<String, String> {
    let path = safe_path(&state.working_dir, &md_name)?;
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Failed to read: {}", e))
}

#[tauri::command]
pub async fn write_agent_file(
    state: State<'_, AppState>,
    md_name: String,
    content: String,
) -> Result<(), String> {
    let path = safe_path(&state.working_dir, &md_name)?;
    tokio::fs::write(&path, content)
        .await
        .map_err(|e| format!("Failed to write: {}", e))
}

#[tauri::command]
pub async fn list_memory_files(state: State<'_, AppState>) -> Result<Vec<WorkspaceFile>, String> {
    Ok(list_subdir_md_files(&state.working_dir, "memory").await)
}

#[tauri::command]
pub async fn read_memory_file(
    state: State<'_, AppState>,
    md_name: String,
) -> Result<String, String> {
    validate_filename(&md_name)?;
    let memory_dir = state.working_dir.join("memory");
    let path = memory_dir.join(&md_name);
    if !path.starts_with(&memory_dir) {
        return Err("Path traversal not allowed".into());
    }
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Failed to read: {}", e))
}

#[tauri::command]
pub async fn write_memory_file(
    state: State<'_, AppState>,
    md_name: String,
    content: String,
) -> Result<(), String> {
    validate_filename(&md_name)?;
    let memory_dir = state.working_dir.join("memory");
    tokio::fs::create_dir_all(&memory_dir).await.ok();
    let path = memory_dir.join(&md_name);
    if !path.starts_with(&memory_dir) {
        return Err("Path traversal not allowed".into());
    }
    tokio::fs::write(&path, content)
        .await
        .map_err(|e| format!("Failed to write: {}", e))
}
