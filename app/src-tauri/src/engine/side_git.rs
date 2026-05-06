//! Side-git workspace snapshots — Phase J.
//!
//! Per-turn snapshot/restore of the user's effective workspace, stored as
//! zstd-compressed tar archives under `~/.yiyi/snapshots/<session_id>/`.
//! These snapshots NEVER touch the user's real `.git` directory; they live
//! entirely beside it under the YiYi data folder.
//!
//! Layout:
//!   ~/.yiyi/snapshots/<session_id>/<turn_index>__<phase>__<timestamp>.tar.zst
//!
//! `phase` is "pre" (before sending the user message) or "post" (after the
//! model finishes). All public APIs are best-effort: snapshot failures must
//! never block the agent loop — callers should `let _ =` them.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::File;
use std::io::{BufReader, BufWriter, Read};
use std::path::{Path, PathBuf};

/// Directory entries to skip when snapshotting. Heavy / regenerable.
const EXCLUDE_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "__pycache__",
    "dist",
    "build",
    ".next",
    ".venv",
    "venv",
    ".tox",
    ".cache",
];

/// Skip files larger than this when snapshotting (5 MiB).
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;

/// Cap of snapshots kept per session (older pre+post pairs rotated out).
const MAX_SNAPSHOTS_PER_SESSION: usize = 100; // ~50 turns × 2 phases

/// Info about a single snapshot on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotInfo {
    pub session_id: String,
    pub turn_index: u32,
    pub phase: String,
    pub path: String,
    pub size_bytes: u64,
    pub created_at_ms: u64,
}

/// Report returned by restore.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RestoreReport {
    pub restored_files: Vec<String>,
    pub removed_files: Vec<String>,
}

/// Resolve `~/.yiyi/snapshots/`.
fn snapshots_root() -> PathBuf {
    let base = std::env::var("YIYI_WORKING_DIR")
        .or_else(|_| std::env::var("YIYICLAW_WORKING_DIR"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".yiyi")
        });
    base.join("snapshots")
}

fn session_dir(session_id: &str) -> PathBuf {
    snapshots_root().join(sanitize_session(session_id))
}

fn sanitize_session(s: &str) -> String {
    // Avoid filesystem traversal — keep alphanumerics, dash, underscore.
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Public: snapshot the workspace before a turn.
pub async fn snapshot_pre_turn(
    session_id: &str,
    turn_index: u32,
    workspace: &Path,
) -> Result<PathBuf, String> {
    snapshot(session_id, turn_index, "pre", workspace).await
}

/// Public: snapshot the workspace after a turn.
pub async fn snapshot_post_turn(
    session_id: &str,
    turn_index: u32,
    workspace: &Path,
) -> Result<PathBuf, String> {
    snapshot(session_id, turn_index, "post", workspace).await
}

async fn snapshot(
    session_id: &str,
    turn_index: u32,
    phase: &str,
    workspace: &Path,
) -> Result<PathBuf, String> {
    let session_id = session_id.to_string();
    let phase = phase.to_string();
    let workspace = workspace.to_path_buf();

    tokio::task::spawn_blocking(move || -> Result<PathBuf, String> {
        if !workspace.exists() {
            return Err(format!("workspace does not exist: {}", workspace.display()));
        }
        let dir = session_dir(&session_id);
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("create snapshot dir: {e}"))?;

        let ts = now_ms();
        let filename = format!("{turn_index:06}__{phase}__{ts}.tar.zst");
        let out_path = dir.join(&filename);

        let f = File::create(&out_path)
            .map_err(|e| format!("create snapshot file: {e}"))?;
        let writer = BufWriter::new(f);
        let zstd_writer = zstd::stream::write::Encoder::new(writer, 3)
            .map_err(|e| format!("zstd encoder: {e}"))?
            .auto_finish();
        let mut tar_builder = tar::Builder::new(zstd_writer);
        tar_builder.follow_symlinks(false);

        walk_and_append(&workspace, &workspace, &mut tar_builder)?;
        tar_builder.finish().map_err(|e| format!("tar finish: {e}"))?;
        drop(tar_builder);

        rotate(&dir);
        Ok(out_path)
    })
    .await
    .map_err(|e| format!("snapshot join error: {e}"))?
}

fn walk_and_append<W: std::io::Write>(
    base: &Path,
    current: &Path,
    tar_builder: &mut tar::Builder<W>,
) -> Result<(), String> {
    let entries = match std::fs::read_dir(current) {
        Ok(e) => e,
        Err(e) => {
            log::warn!("snapshot: skip unreadable dir {}: {}", current.display(), e);
            return Ok(());
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };

        if file_type.is_symlink() {
            continue; // ignore symlinks for safety
        }

        if file_type.is_dir() {
            if EXCLUDE_DIRS.iter().any(|x| *x == name_str.as_ref()) {
                continue;
            }
            walk_and_append(base, &path, tar_builder)?;
            continue;
        }

        if !file_type.is_file() {
            continue;
        }

        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if metadata.len() > MAX_FILE_BYTES {
            continue;
        }

        let rel = match path.strip_prefix(base) {
            Ok(r) => r,
            Err(_) => continue,
        };

        if let Err(e) = tar_builder.append_path_with_name(&path, rel) {
            log::warn!("snapshot: append failed for {}: {}", rel.display(), e);
        }
    }
    Ok(())
}

/// Rotate snapshots in this session to MAX_SNAPSHOTS_PER_SESSION, deleting oldest.
fn rotate(dir: &Path) {
    let mut entries: Vec<(PathBuf, u64)> = match std::fs::read_dir(dir) {
        Ok(rd) => rd
            .flatten()
            .filter_map(|e| {
                let p = e.path();
                let m = e.metadata().ok()?;
                if !m.is_file() {
                    return None;
                }
                let mtime = m
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                Some((p, mtime))
            })
            .collect(),
        Err(_) => return,
    };

    if entries.len() <= MAX_SNAPSHOTS_PER_SESSION {
        return;
    }

    entries.sort_by_key(|(_, t)| *t);
    let to_remove = entries.len() - MAX_SNAPSHOTS_PER_SESSION;
    for (p, _) in entries.into_iter().take(to_remove) {
        let _ = std::fs::remove_file(&p);
    }
}

/// List snapshots for a session.
pub fn list_snapshots(session_id: &str) -> Vec<SnapshotInfo> {
    let dir = session_dir(session_id);
    let rd = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(_) => return Vec::new(),
    };

    let mut out: Vec<SnapshotInfo> = rd
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            let m = e.metadata().ok()?;
            if !m.is_file() {
                return None;
            }
            let fname = path.file_name()?.to_string_lossy().to_string();
            // <turn_index>__<phase>__<ts>.tar.zst
            if !fname.ends_with(".tar.zst") {
                return None;
            }
            let stem = fname.trim_end_matches(".tar.zst");
            let parts: Vec<&str> = stem.splitn(3, "__").collect();
            if parts.len() != 3 {
                return None;
            }
            let turn_index: u32 = parts[0].parse().ok()?;
            let phase = parts[1].to_string();
            let created_at_ms: u64 = parts[2].parse().ok()?;
            Some(SnapshotInfo {
                session_id: session_id.to_string(),
                turn_index,
                phase,
                path: path.to_string_lossy().to_string(),
                size_bytes: m.len(),
                created_at_ms,
            })
        })
        .collect();

    out.sort_by(|a, b| {
        a.turn_index
            .cmp(&b.turn_index)
            .then(a.phase.cmp(&b.phase))
            .then(a.created_at_ms.cmp(&b.created_at_ms))
    });
    out
}

/// Find the most recent snapshot for the given (session, turn_index, phase).
fn find_snapshot(session_id: &str, turn_index: u32, phase: &str) -> Option<SnapshotInfo> {
    list_snapshots(session_id)
        .into_iter()
        .filter(|s| s.turn_index == turn_index && s.phase == phase)
        .max_by_key(|s| s.created_at_ms)
}

/// Restore the workspace from a snapshot. Files in the workspace not in the
/// snapshot but located within paths the snapshot tracked are removed.
/// `.git` and other excluded dirs in the workspace are left untouched.
pub async fn restore(
    session_id: &str,
    turn_index: u32,
    phase: &str,
    workspace: &Path,
) -> Result<RestoreReport, String> {
    let info = find_snapshot(session_id, turn_index, phase)
        .ok_or_else(|| format!("snapshot not found: {session_id}/{turn_index}/{phase}"))?;
    let archive_path = PathBuf::from(&info.path);
    let workspace = workspace.to_path_buf();

    tokio::task::spawn_blocking(move || -> Result<RestoreReport, String> {
        // First pass: collect manifest of files in archive (relative paths).
        let manifest = read_manifest(&archive_path)?;
        let manifest_set: HashSet<PathBuf> = manifest.iter().cloned().collect();

        // Second pass: extract over workspace.
        let mut report = RestoreReport::default();
        extract_over(&archive_path, &workspace, &mut report)?;

        // Third pass: remove files in workspace that are NOT in the manifest
        // BUT live in directories the snapshot would have tracked (i.e.
        // not under EXCLUDE_DIRS, and within MAX_FILE_BYTES).
        let mut existing: Vec<PathBuf> = Vec::new();
        collect_workspace_files(&workspace, &workspace, &mut existing);
        for rel in existing {
            if !manifest_set.contains(&rel) {
                let abs = workspace.join(&rel);
                if std::fs::remove_file(&abs).is_ok() {
                    report.removed_files.push(rel.to_string_lossy().to_string());
                }
            }
        }

        Ok(report)
    })
    .await
    .map_err(|e| format!("restore join error: {e}"))?
}

fn read_manifest(archive_path: &Path) -> Result<Vec<PathBuf>, String> {
    let f = File::open(archive_path).map_err(|e| format!("open archive: {e}"))?;
    let reader = BufReader::new(f);
    let dec = zstd::stream::read::Decoder::new(reader)
        .map_err(|e| format!("zstd decode: {e}"))?;
    let mut archive = tar::Archive::new(dec);
    let mut out = Vec::new();
    for entry in archive.entries().map_err(|e| format!("tar entries: {e}"))? {
        let entry = entry.map_err(|e| format!("tar entry: {e}"))?;
        let path = entry.path().map_err(|e| format!("entry path: {e}"))?.into_owned();
        if entry.header().entry_type().is_file() {
            out.push(path);
        }
    }
    Ok(out)
}

fn extract_over(
    archive_path: &Path,
    workspace: &Path,
    report: &mut RestoreReport,
) -> Result<(), String> {
    let f = File::open(archive_path).map_err(|e| format!("open archive: {e}"))?;
    let reader = BufReader::new(f);
    let dec = zstd::stream::read::Decoder::new(reader)
        .map_err(|e| format!("zstd decode: {e}"))?;
    let mut archive = tar::Archive::new(dec);
    archive.set_overwrite(true);
    archive.set_preserve_permissions(false);

    for entry in archive.entries().map_err(|e| format!("tar entries: {e}"))? {
        let mut entry = entry.map_err(|e| format!("tar entry: {e}"))?;
        let rel = entry.path().map_err(|e| format!("entry path: {e}"))?.into_owned();
        // Refuse anything that escapes
        if rel.is_absolute() || rel.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            continue;
        }
        let dest = workspace.join(&rel);
        if !dest.starts_with(workspace) {
            continue;
        }

        if entry.header().entry_type().is_dir() {
            std::fs::create_dir_all(&dest).ok();
            continue;
        }
        if !entry.header().entry_type().is_file() {
            continue;
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let mut buf = Vec::new();
        if entry.read_to_end(&mut buf).is_err() {
            continue;
        }
        if std::fs::write(&dest, &buf).is_ok() {
            report.restored_files.push(rel.to_string_lossy().to_string());
        }
    }
    Ok(())
}

fn collect_workspace_files(base: &Path, current: &Path, out: &mut Vec<PathBuf>) {
    let rd = match std::fs::read_dir(current) {
        Ok(rd) => rd,
        Err(_) => return,
    };
    for entry in rd.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let path = entry.path();
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            if EXCLUDE_DIRS.iter().any(|x| *x == name_str.as_ref()) {
                continue;
            }
            collect_workspace_files(base, &path, out);
        } else if ft.is_file() {
            let m = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if m.len() > MAX_FILE_BYTES {
                continue;
            }
            if let Ok(rel) = path.strip_prefix(base) {
                out.push(rel.to_path_buf());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("yiyi_side_git_test_{}", uuid::Uuid::new_v4()));
        p
    }

    #[tokio::test]
    async fn snapshot_and_restore_roundtrip() {
        let tmp = temp_root();
        std::env::set_var("YIYI_WORKING_DIR", &tmp);

        let workspace = tmp.join("ws");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(workspace.join("a.txt"), "hello").unwrap();
        std::fs::create_dir_all(workspace.join("sub")).unwrap();
        std::fs::write(workspace.join("sub/b.txt"), "world").unwrap();

        // Snapshot pre.
        let session = "test-session";
        let snap = snapshot_pre_turn(session, 1, &workspace).await.unwrap();
        assert!(snap.exists());

        // Mutate workspace
        std::fs::write(workspace.join("a.txt"), "modified").unwrap();
        std::fs::write(workspace.join("c.txt"), "new file").unwrap();
        std::fs::remove_file(workspace.join("sub/b.txt")).unwrap();

        // Restore
        let report = restore(session, 1, "pre", &workspace).await.unwrap();
        assert!(report.restored_files.iter().any(|f| f == "a.txt"));
        assert!(report.restored_files.iter().any(|f| f.ends_with("b.txt")));
        assert!(report.removed_files.iter().any(|f| f == "c.txt"));

        assert_eq!(std::fs::read_to_string(workspace.join("a.txt")).unwrap(), "hello");
        assert_eq!(std::fs::read_to_string(workspace.join("sub/b.txt")).unwrap(), "world");
        assert!(!workspace.join("c.txt").exists());

        // Cleanup
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn list_snapshots_returns_sorted() {
        let tmp = temp_root();
        std::env::set_var("YIYI_WORKING_DIR", &tmp);
        let workspace = tmp.join("ws2");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(workspace.join("x"), "1").unwrap();

        let session = "list-session";
        snapshot_pre_turn(session, 1, &workspace).await.unwrap();
        snapshot_post_turn(session, 1, &workspace).await.unwrap();
        snapshot_pre_turn(session, 2, &workspace).await.unwrap();

        let snaps = list_snapshots(session);
        assert_eq!(snaps.len(), 3);
        assert_eq!(snaps[0].turn_index, 1);
        assert_eq!(snaps[0].phase, "post"); // alphabetical: post < pre
        assert_eq!(snaps[2].turn_index, 2);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn excluded_dirs_skipped() {
        // Just verify the constant covers the documented set.
        assert!(EXCLUDE_DIRS.contains(&".git"));
        assert!(EXCLUDE_DIRS.contains(&"node_modules"));
        assert!(EXCLUDE_DIRS.contains(&"target"));
    }
}
