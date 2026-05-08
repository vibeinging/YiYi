//! Workspace checkpoint — shadow-git over user worktree.
//!
//! A content-addressed git repository at
//! `~/.yiyi/checkpoints/<workspace_hash>/git/` whose worktree is pointed
//! at the user's workspace. Each turn writes one ref:
//!
//!   refs/yiyi/<session>/<turn_index>__<phase>
//!
//! pointing at a commit whose tree is the snapshotted workspace. The
//! user's own `.git` is never touched.

use git2::{IndexAddOption, Oid, Repository, RepositoryInitOptions, Signature};
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Heavy / regenerable directories the checkpoint never indexes.
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

/// Skip files larger than this (50 MiB — bigger than the old tar's 5 MiB
/// so PowerPoint / Excel attachments survive a checkpoint).
const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Pre,
    Post,
}

impl Phase {
    pub fn as_str(&self) -> &'static str {
        match self {
            Phase::Pre => "pre",
            Phase::Post => "post",
        }
    }
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "pre" => Ok(Phase::Pre),
            "post" => Ok(Phase::Post),
            other => Err(format!("phase must be 'pre' or 'post', got '{other}'")),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckpointInfo {
    pub session_id: String,
    pub turn_index: u32,
    pub phase: Phase,
    pub commit: String,
    pub parent_commit: Option<String>,
    pub created_at_ms: u64,
    pub files_changed: u32,
    pub insertions: u32,
    pub deletions: u32,
    pub changed_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RestoreReport {
    pub restored_files: Vec<String>,
    pub removed_files: Vec<String>,
    pub stash_commit: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileDiff {
    pub path: String,
    pub status: FileStatus,
    pub additions: u32,
    pub deletions: u32,
    pub patch: String,
    /// True if `patch` was truncated to bound IPC payload size.
    pub truncated: bool,
}

fn yiyi_data_root() -> PathBuf {
    std::env::var("YIYI_WORKING_DIR")
        .or_else(|_| std::env::var("YIYICLAW_WORKING_DIR"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".yiyi")
        })
}

fn workspace_id(workspace: &Path) -> String {
    let canon = workspace.canonicalize().unwrap_or_else(|_| workspace.to_path_buf());
    let mut h = DefaultHasher::new();
    canon.to_string_lossy().hash(&mut h);
    format!("{:016x}", h.finish())
}

fn repo_dir(workspace: &Path) -> PathBuf {
    yiyi_data_root().join("checkpoints").join(workspace_id(workspace))
}

fn sanitize_segment(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

fn ref_name(session_id: &str, turn_index: u32, phase: Phase) -> String {
    format!(
        "refs/yiyi/{}/{:06}__{}",
        sanitize_segment(session_id),
        turn_index,
        phase.as_str()
    )
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Open or initialize the shadow repo for `workspace`. The repo lives
/// under `~/.yiyi/checkpoints/<id>/` with `core.worktree` pointed at
/// `workspace` so commits index the user's files in place.
fn open_or_init(workspace: &Path) -> Result<Repository, String> {
    let dir = repo_dir(workspace);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create repo dir: {e}"))?;

    let gitdir = dir.join("git");
    let already = gitdir.join("HEAD").exists();
    if already {
        let repo = Repository::open(&gitdir).map_err(|e| format!("open shadow repo: {e}"))?;
        repo.set_workdir(workspace, false)
            .map_err(|e| format!("set workdir: {e}"))?;
        return Ok(repo);
    }

    let mut opts = RepositoryInitOptions::new();
    opts.bare(false).no_reinit(false).workdir_path(workspace);
    let repo = Repository::init_opts(&gitdir, &opts)
        .map_err(|e| format!("init shadow repo: {e}"))?;
    repo.set_workdir(workspace, false)
        .map_err(|e| format!("set workdir: {e}"))?;
    Ok(repo)
}

fn should_skip_path(rel: &Path, workspace: &Path) -> bool {
    for comp in rel.components() {
        if let std::path::Component::Normal(name) = comp {
            let s = name.to_string_lossy();
            if EXCLUDE_DIRS.iter().any(|x| *x == s.as_ref()) {
                return true;
            }
        }
    }
    let abs = workspace.join(rel);
    if let Ok(meta) = std::fs::symlink_metadata(&abs) {
        if meta.file_type().is_symlink() {
            return true;
        }
        if meta.is_file() && meta.len() > MAX_FILE_BYTES {
            return true;
        }
    }
    false
}

fn build_commit(
    repo: &Repository,
    workspace: &Path,
    parent: Option<Oid>,
    message: &str,
) -> Result<Oid, String> {
    let mut index = repo.index().map_err(|e| format!("repo index: {e}"))?;
    index.clear().map_err(|e| format!("index clear: {e}"))?;

    let workspace_owned = workspace.to_path_buf();
    let mut cb = |path: &Path, _matched: &[u8]| -> i32 {
        if should_skip_path(path, &workspace_owned) {
            1 // skip
        } else {
            0 // include
        }
    };

    index
        .add_all(["*"].iter(), IndexAddOption::DEFAULT, Some(&mut cb))
        .map_err(|e| format!("index add_all: {e}"))?;
    index.write().map_err(|e| format!("index write: {e}"))?;

    let tree_oid = index.write_tree().map_err(|e| format!("write tree: {e}"))?;
    let tree = repo.find_tree(tree_oid).map_err(|e| format!("find tree: {e}"))?;

    let sig = Signature::now("yiyi-checkpoint", "checkpoint@yiyi.local")
        .map_err(|e| format!("signature: {e}"))?;

    let parents: Vec<git2::Commit> = match parent {
        Some(oid) => match repo.find_commit(oid) {
            Ok(c) => vec![c],
            Err(_) => Vec::new(),
        },
        None => Vec::new(),
    };
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();

    let oid = repo
        .commit(None, &sig, &sig, message, &tree, &parent_refs)
        .map_err(|e| format!("commit: {e}"))?;
    Ok(oid)
}

fn last_commit_oid(repo: &Repository, session_id: &str) -> Option<Oid> {
    let session_seg = sanitize_segment(session_id);
    let prefix = format!("refs/yiyi/{}/", session_seg);
    let mut latest: Option<(u64, Oid)> = None;
    if let Ok(refs) = repo.references_glob(&format!("{}*", prefix)) {
        for r in refs.flatten() {
            if let Some(target) = r.target() {
                if let Ok(commit) = repo.find_commit(target) {
                    let when = commit.time().seconds() as u64;
                    if latest.map_or(true, |(t, _)| when >= t) {
                        latest = Some((when, target));
                    }
                }
            }
        }
    }
    latest.map(|(_, oid)| oid)
}

async fn snapshot(
    session_id: &str,
    turn_index: u32,
    phase: Phase,
    workspace: &Path,
) -> Result<CheckpointInfo, String> {
    let session_id = session_id.to_string();
    let workspace = workspace.to_path_buf();

    tokio::task::spawn_blocking(move || -> Result<CheckpointInfo, String> {
        if !workspace.exists() {
            return Err(format!("workspace does not exist: {}", workspace.display()));
        }
        let repo = open_or_init(&workspace)?;
        let parent = last_commit_oid(&repo, &session_id);
        let msg = format!("checkpoint {turn_index} {}", phase.as_str());
        let oid = build_commit(&repo, &workspace, parent, &msg)?;

        let refname = ref_name(&session_id, turn_index, phase);
        repo.reference(&refname, oid, true, &msg)
            .map_err(|e| format!("write ref {refname}: {e}"))?;

        let stats = compute_stats(&repo, parent, oid);
        Ok(CheckpointInfo {
            session_id,
            turn_index,
            phase,
            commit: oid.to_string(),
            parent_commit: parent.map(|p| p.to_string()),
            created_at_ms: now_ms(),
            files_changed: stats.files_changed,
            insertions: stats.insertions,
            deletions: stats.deletions,
            changed_files: stats.changed_files,
        })
    })
    .await
    .map_err(|e| format!("checkpoint join error: {e}"))?
}

#[derive(Default)]
struct CommitStats {
    files_changed: u32,
    insertions: u32,
    deletions: u32,
    changed_files: Vec<String>,
}

fn diff_between(repo: &Repository, parent: Option<Oid>, child: Oid) -> Option<git2::Diff<'_>> {
    let child_tree = repo.find_commit(child).ok()?.tree().ok()?;
    let parent_tree = match parent {
        Some(p) => repo.find_commit(p).ok()?.tree().ok(),
        None => None,
    };
    repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&child_tree), None).ok()
}

fn compute_stats(repo: &Repository, parent: Option<Oid>, child: Oid) -> CommitStats {
    let mut out = CommitStats::default();
    let Some(diff) = diff_between(repo, parent, child) else {
        return out;
    };
    if let Ok(stats) = diff.stats() {
        out.files_changed = stats.files_changed() as u32;
        out.insertions = stats.insertions() as u32;
        out.deletions = stats.deletions() as u32;
    }
    let _ = diff.foreach(
        &mut |delta, _| {
            if out.changed_files.len() >= 8 {
                return true;
            }
            let p = delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .map(|p| p.to_string_lossy().to_string());
            if let Some(p) = p {
                out.changed_files.push(p);
            }
            true
        },
        None,
        None,
        None,
    );
    out
}

pub async fn snapshot_pre_turn(
    session_id: &str,
    turn_index: u32,
    workspace: &Path,
) -> Result<CheckpointInfo, String> {
    snapshot(session_id, turn_index, Phase::Pre, workspace).await
}

pub async fn snapshot_post_turn(
    session_id: &str,
    turn_index: u32,
    workspace: &Path,
) -> Result<CheckpointInfo, String> {
    snapshot(session_id, turn_index, Phase::Post, workspace).await
}

/// Restore the workspace to the given checkpoint. If `paths` is `Some`,
/// only those paths (relative to workspace) are restored — files outside
/// the dirty set are left alone. If `None`, every file the checkpoint
/// tracks is restored, and any tracked-but-not-in-checkpoint file is
/// removed (within the non-excluded subtree).
pub async fn restore(
    session_id: &str,
    turn_index: u32,
    phase: Phase,
    workspace: &Path,
    paths: Option<Vec<PathBuf>>,
) -> Result<RestoreReport, String> {
    let session_id = session_id.to_string();
    let workspace = workspace.to_path_buf();

    tokio::task::spawn_blocking(move || -> Result<RestoreReport, String> {
        let repo = open_or_init(&workspace)?;
        let refname = ref_name(&session_id, turn_index, phase);
        let reference = repo
            .find_reference(&refname)
            .map_err(|_| format!("checkpoint not found: {refname}"))?;
        let commit_oid = reference
            .target()
            .ok_or_else(|| "ref has no target".to_string())?;
        let commit = repo
            .find_commit(commit_oid)
            .map_err(|e| format!("find commit: {e}"))?;
        let tree = commit.tree().map_err(|e| format!("commit tree: {e}"))?;

        let mut report = RestoreReport::default();
        report.stash_commit = stash_uncommitted(&repo, &workspace, &session_id);
        let mut opts = git2::build::CheckoutBuilder::new();
        opts.force();
        // Never let libgit2 remove untracked: EXCLUDE_DIRS (node_modules,
        // target, ...) are untracked-by-design and must survive restore.
        // We do our own targeted removal sweep below.
        opts.remove_untracked(false);

        if let Some(ps) = &paths {
            for p in ps {
                opts.path(p);
            }
        }

        repo.checkout_tree(tree.as_object(), Some(&mut opts))
            .map_err(|e| format!("checkout_tree: {e}"))?;

        // Build the set of paths the checkpoint tracks.
        let mut tracked: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
        tree.walk(git2::TreeWalkMode::PreOrder, |dir, entry| {
            if entry.kind() != Some(git2::ObjectType::Blob) {
                return git2::TreeWalkResult::Ok;
            }
            let name = match entry.name() {
                Some(n) => n,
                None => return git2::TreeWalkResult::Ok,
            };
            let rel = if dir.is_empty() {
                PathBuf::from(name)
            } else {
                PathBuf::from(dir).join(name)
            };
            tracked.insert(rel);
            git2::TreeWalkResult::Ok
        })
        .map_err(|e| format!("tree walk: {e}"))?;

        let restrict: Option<std::collections::HashSet<PathBuf>> =
            paths.map(|v| v.into_iter().collect());

        for rel in &tracked {
            let include = match &restrict {
                Some(set) => set.contains(rel),
                None => true,
            };
            if include {
                report.restored_files.push(rel.to_string_lossy().to_string());
            }
        }

        // Full restore: remove files that exist in workspace but were not
        // in the checkpoint, scoped to non-excluded paths only.
        if restrict.is_none() {
            let mut existing: Vec<PathBuf> = Vec::new();
            collect_workspace_files(&workspace, &workspace, &mut existing);
            for rel in existing {
                if !tracked.contains(&rel) {
                    let abs = workspace.join(&rel);
                    if std::fs::remove_file(&abs).is_ok() {
                        report.removed_files.push(rel.to_string_lossy().to_string());
                    }
                }
            }
        }

        Ok(report)
    })
    .await
    .map_err(|e| format!("restore join error: {e}"))?
}

/// Before restoring, capture any worktree changes the user made beyond
/// the latest session checkpoint into a `stash__<ts>` ref. Returns the
/// stash commit oid (as hex) when a stash was actually created.
fn stash_uncommitted(repo: &Repository, workspace: &Path, session_id: &str) -> Option<String> {
    let parent = last_commit_oid(repo, session_id)?;

    // Cheap pre-check: if the worktree has no diffs vs. the index/HEAD, skip
    // the full add_all + write_tree round-trip entirely.
    let mut status_opts = git2::StatusOptions::new();
    status_opts.include_untracked(true).recurse_untracked_dirs(true);
    if repo
        .statuses(Some(&mut status_opts))
        .map(|s| s.is_empty())
        .unwrap_or(false)
    {
        return None;
    }

    let msg = format!("stash before restore @ {}", now_ms());
    let oid = build_commit(repo, workspace, Some(parent), &msg).ok()?;
    if oid == parent {
        return None;
    }
    let refname = format!(
        "refs/yiyi/{}/stash__{}",
        sanitize_segment(session_id),
        now_ms()
    );
    repo.reference(&refname, oid, true, &msg).ok()?;
    Some(oid.to_string())
}

/// Cap on the unified-patch text per file in `preview_diff`. Beyond this,
/// the patch is truncated and `truncated: true` is set so the frontend
/// can show "diff too large" without blowing up IPC.
const MAX_PATCH_BYTES: usize = 64 * 1024;

pub async fn preview_diff(
    session_id: &str,
    turn_index: u32,
    phase: Phase,
    workspace: &Path,
) -> Result<Vec<FileDiff>, String> {
    let session_id = session_id.to_string();
    let workspace = workspace.to_path_buf();

    tokio::task::spawn_blocking(move || -> Result<Vec<FileDiff>, String> {
        let repo = open_or_init(&workspace)?;
        let refname = ref_name(&session_id, turn_index, phase);
        let reference = repo
            .find_reference(&refname)
            .map_err(|_| format!("checkpoint not found: {refname}"))?;
        let child = reference
            .target()
            .ok_or_else(|| "ref has no target".to_string())?;
        let parent = repo
            .find_commit(child)
            .ok()
            .and_then(|c| c.parent_id(0).ok());

        let diff = match diff_between(&repo, parent, child) {
            Some(d) => d,
            None => return Ok(Vec::new()),
        };

        let mut entries: HashMap<String, FileDiff> = HashMap::new();
        let nd = diff.deltas().count();
        for i in 0..nd {
            let Ok(patch_opt) = git2::Patch::from_diff(&diff, i) else { continue };
            let Some(mut patch) = patch_opt else { continue };
            let Some(delta) = diff.get_delta(i) else { continue };
            let path = delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            if path.is_empty() {
                continue;
            }
            let status = match delta.status() {
                git2::Delta::Added => FileStatus::Added,
                git2::Delta::Deleted => FileStatus::Deleted,
                git2::Delta::Renamed => FileStatus::Renamed,
                git2::Delta::Copied => FileStatus::Copied,
                _ => FileStatus::Modified,
            };
            let (_, additions, deletions) = patch.line_stats().unwrap_or((0, 0, 0));
            let buf = patch.to_buf().ok();
            let raw = buf
                .as_ref()
                .and_then(|b| std::str::from_utf8(b).ok())
                .unwrap_or("");
            let (patch_str, truncated) = if raw.len() > MAX_PATCH_BYTES {
                let cut = raw
                    .char_indices()
                    .take_while(|(i, _)| *i < MAX_PATCH_BYTES)
                    .last()
                    .map(|(i, c)| i + c.len_utf8())
                    .unwrap_or(0);
                (raw[..cut].to_string(), true)
            } else {
                (raw.to_string(), false)
            };
            entries.insert(
                path.clone(),
                FileDiff {
                    path,
                    status,
                    additions: additions as u32,
                    deletions: deletions as u32,
                    patch: patch_str,
                    truncated,
                },
            );
        }

        let mut out: Vec<FileDiff> = entries.into_values().collect();
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    })
    .await
    .map_err(|e| format!("preview_diff join error: {e}"))?
}

/// Discard the abandoned-branch refs created when the user restored to
/// an earlier turn. Removes every checkpoint ref with turn_index strictly
/// greater than `keep_through_turn` for the given session.
pub async fn discard_branch_after(
    session_id: &str,
    keep_through_turn: u32,
    workspace: &Path,
) -> Result<u32, String> {
    let session_id = session_id.to_string();
    let workspace = workspace.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<u32, String> {
        let repo = open_or_init(&workspace)?;
        let prefix = format!("refs/yiyi/{}/", sanitize_segment(&session_id));
        let mut deleted = 0u32;
        let to_remove: Vec<String> = {
            let refs = repo
                .references_glob(&format!("{}*", prefix))
                .map_err(|e| format!("references_glob: {e}"))?;
            refs.flatten()
                .filter_map(|r| {
                    let name = r.name()?.to_string();
                    let suffix = name.strip_prefix(&prefix)?;
                    let turn_str = suffix.split("__").next()?;
                    let turn: u32 = turn_str.parse().ok()?;
                    if turn > keep_through_turn {
                        Some(name)
                    } else {
                        None
                    }
                })
                .collect()
        };
        for name in to_remove {
            if let Ok(mut r) = repo.find_reference(&name) {
                if r.delete().is_ok() {
                    deleted += 1;
                }
            }
        }
        Ok(deleted)
    })
    .await
    .map_err(|e| format!("discard join error: {e}"))?
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

pub fn list_snapshots(session_id: &str, workspace: &Path) -> Vec<CheckpointInfo> {
    let repo = match open_or_init(workspace) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let session_seg = sanitize_segment(session_id);
    let prefix = format!("refs/yiyi/{}/", session_seg);

    let refs = match repo.references_glob(&format!("{}*", prefix)) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };

    let mut out: Vec<CheckpointInfo> = Vec::new();
    for r in refs.flatten() {
        let Some(name) = r.name() else { continue };
        let suffix = match name.strip_prefix(&prefix) {
            Some(s) => s,
            None => continue,
        };
        // <turn_index>__<phase>; reserved markers (stash__, restored_at__)
        // don't have a numeric turn prefix and naturally fail the parse below.
        let mut parts = suffix.splitn(2, "__");
        let turn_str = parts.next().unwrap_or("");
        let phase_str = parts.next().unwrap_or("");
        let Ok(turn_index) = turn_str.parse::<u32>() else { continue };
        let Ok(phase) = Phase::parse(phase_str) else { continue };
        let Some(target) = r.target() else { continue };
        let Ok(commit) = repo.find_commit(target) else { continue };
        let parent_oid = commit.parent_id(0).ok();
        let stats = compute_stats(&repo, parent_oid, target);
        out.push(CheckpointInfo {
            session_id: session_id.to_string(),
            turn_index,
            phase,
            commit: target.to_string(),
            parent_commit: parent_oid.map(|o| o.to_string()),
            created_at_ms: (commit.time().seconds() as u64) * 1000,
            files_changed: stats.files_changed,
            insertions: stats.insertions,
            deletions: stats.deletions,
            changed_files: stats.changed_files,
        });
    }

    out.sort_by(|a, b| {
        a.turn_index
            .cmp(&b.turn_index)
            .then(a.phase.as_str().cmp(b.phase.as_str()))
            .then(a.created_at_ms.cmp(&b.created_at_ms))
    });
    out
}

// ── Dirty set ──────────────────────────────────────────────────────────
//
// Tools that mutate the workspace report touched paths into a per-session
// bucket here. The agent loop drains this bucket at post-turn to decide
// whether to take a checkpoint at all (empty bucket → no-op turn → no
// commit, no timeline entry).
//
// `report_unknown` is for tools where we can't know the touched paths
// (execute_shell, scripts). It inserts a sentinel that just signals
// "something changed" without naming a path.

const DIRTY_UNKNOWN: &str = "<unknown>";

fn dirty_sets() -> &'static Mutex<HashMap<String, HashSet<PathBuf>>> {
    static SETS: OnceLock<Mutex<HashMap<String, HashSet<PathBuf>>>> = OnceLock::new();
    SETS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn report_dirty(session_id: &str, path: impl AsRef<Path>) {
    if session_id.is_empty() {
        return;
    }
    if let Ok(mut map) = dirty_sets().lock() {
        map.entry(session_id.to_string())
            .or_default()
            .insert(path.as_ref().to_path_buf());
    }
}

pub fn report_unknown(session_id: &str) {
    if session_id.is_empty() {
        return;
    }
    if let Ok(mut map) = dirty_sets().lock() {
        map.entry(session_id.to_string())
            .or_default()
            .insert(PathBuf::from(DIRTY_UNKNOWN));
    }
}

/// Drain and return the dirty set for this session. Empty set means the
/// turn produced no filesystem changes — caller should skip snapshotting.
pub fn take_dirty(session_id: &str) -> HashSet<PathBuf> {
    if session_id.is_empty() {
        return HashSet::new();
    }
    if let Ok(mut map) = dirty_sets().lock() {
        map.remove(session_id).unwrap_or_default()
    } else {
        HashSet::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    fn temp_root() -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("yiyi_checkpoint_test_{}", uuid::Uuid::new_v4()));
        p
    }

    #[tokio::test]
    #[serial]
    async fn snapshot_then_restore_roundtrips_file_contents() {
        let tmp = temp_root();
        std::env::set_var("YIYI_WORKING_DIR", &tmp);
        let workspace = tmp.join("ws");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(workspace.join("a.txt"), "hello").unwrap();
        std::fs::create_dir_all(workspace.join("sub")).unwrap();
        std::fs::write(workspace.join("sub/b.txt"), "world").unwrap();

        let session = "sess1";
        snapshot_pre_turn(session, 1, &workspace).await.unwrap();

        std::fs::write(workspace.join("a.txt"), "MUTATED").unwrap();
        std::fs::write(workspace.join("c.txt"), "added").unwrap();
        std::fs::remove_file(workspace.join("sub/b.txt")).unwrap();

        let report = restore(session, 1, Phase::Pre, &workspace, None).await.unwrap();
        assert!(report.restored_files.iter().any(|f| f == "a.txt"));
        assert!(report.restored_files.iter().any(|f| f.ends_with("b.txt")));

        assert_eq!(std::fs::read_to_string(workspace.join("a.txt")).unwrap(), "hello");
        assert_eq!(std::fs::read_to_string(workspace.join("sub/b.txt")).unwrap(), "world");
        assert!(!workspace.join("c.txt").exists(), "c.txt should be removed by full restore");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    #[serial]
    async fn restore_with_path_filter_only_touches_selected_files() {
        let tmp = temp_root();
        std::env::set_var("YIYI_WORKING_DIR", &tmp);
        let workspace = tmp.join("ws2");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(workspace.join("a.txt"), "A1").unwrap();
        std::fs::write(workspace.join("b.txt"), "B1").unwrap();

        snapshot_pre_turn("s2", 1, &workspace).await.unwrap();
        std::fs::write(workspace.join("a.txt"), "A2").unwrap();
        std::fs::write(workspace.join("b.txt"), "B2").unwrap();

        restore("s2", 1, Phase::Pre, &workspace, Some(vec![PathBuf::from("a.txt")]))
            .await
            .unwrap();

        assert_eq!(std::fs::read_to_string(workspace.join("a.txt")).unwrap(), "A1");
        assert_eq!(std::fs::read_to_string(workspace.join("b.txt")).unwrap(), "B2");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    #[serial]
    async fn list_snapshots_returns_pre_and_post_for_each_turn() {
        let tmp = temp_root();
        std::env::set_var("YIYI_WORKING_DIR", &tmp);
        let workspace = tmp.join("ws3");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(workspace.join("x"), "1").unwrap();

        snapshot_pre_turn("s3", 1, &workspace).await.unwrap();
        snapshot_post_turn("s3", 1, &workspace).await.unwrap();
        snapshot_pre_turn("s3", 2, &workspace).await.unwrap();

        let snaps = list_snapshots("s3", &workspace);
        assert_eq!(snaps.len(), 3);
        assert_eq!(snaps[0].turn_index, 1);
        assert_eq!(snaps[2].turn_index, 2);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    #[serial]
    async fn excluded_dirs_are_not_indexed() {
        let tmp = temp_root();
        std::env::set_var("YIYI_WORKING_DIR", &tmp);
        let workspace = tmp.join("ws4");
        std::fs::create_dir_all(workspace.join("node_modules/junk")).unwrap();
        std::fs::write(workspace.join("node_modules/junk/big.bin"), vec![0u8; 1024]).unwrap();
        std::fs::write(workspace.join("keep.txt"), "yes").unwrap();

        snapshot_pre_turn("s4", 1, &workspace).await.unwrap();

        // Mutate keep.txt then restore — node_modules should be untouched.
        std::fs::write(workspace.join("keep.txt"), "no").unwrap();
        std::fs::write(workspace.join("node_modules/junk/sentinel"), "alive").unwrap();

        restore("s4", 1, Phase::Pre, &workspace, None).await.unwrap();

        assert_eq!(std::fs::read_to_string(workspace.join("keep.txt")).unwrap(), "yes");
        // Excluded dir survives because checkpoint never tracked it
        assert!(workspace.join("node_modules/junk/sentinel").exists());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    #[serial]
    async fn list_snapshots_carries_diff_stats() {
        let tmp = temp_root();
        std::env::set_var("YIYI_WORKING_DIR", &tmp);
        let workspace = tmp.join("ws_stats");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(workspace.join("a.txt"), "line1\n").unwrap();
        snapshot_pre_turn("ss", 1, &workspace).await.unwrap();

        std::fs::write(workspace.join("a.txt"), "line1\nline2\nline3\n").unwrap();
        std::fs::write(workspace.join("b.txt"), "newfile\n").unwrap();
        snapshot_post_turn("ss", 1, &workspace).await.unwrap();

        let snaps = list_snapshots("ss", &workspace);
        let post = snaps.iter().find(|s| s.phase == Phase::Post).unwrap();
        assert_eq!(post.files_changed, 2, "expected a.txt + b.txt");
        assert!(post.insertions >= 3, "expected at least 3 insertions, got {}", post.insertions);
        assert!(post.changed_files.iter().any(|f| f == "a.txt"));
        assert!(post.changed_files.iter().any(|f| f == "b.txt"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    #[serial]
    async fn preview_diff_returns_unified_patch_per_file() {
        let tmp = temp_root();
        std::env::set_var("YIYI_WORKING_DIR", &tmp);
        let workspace = tmp.join("ws_preview");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(workspace.join("a.txt"), "alpha\n").unwrap();
        snapshot_pre_turn("sp", 1, &workspace).await.unwrap();

        std::fs::write(workspace.join("a.txt"), "alpha\nbeta\n").unwrap();
        snapshot_post_turn("sp", 1, &workspace).await.unwrap();

        let diffs = preview_diff("sp", 1, Phase::Post, &workspace).await.unwrap();
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].path, "a.txt");
        assert_eq!(diffs[0].status, FileStatus::Modified);
        assert!(diffs[0].patch.contains("+beta"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    #[serial]
    async fn restore_stashes_uncommitted_handedits() {
        let tmp = temp_root();
        std::env::set_var("YIYI_WORKING_DIR", &tmp);
        let workspace = tmp.join("ws_stash");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(workspace.join("a.txt"), "v1").unwrap();
        snapshot_pre_turn("st", 1, &workspace).await.unwrap();

        std::fs::write(workspace.join("a.txt"), "v2").unwrap();
        snapshot_post_turn("st", 1, &workspace).await.unwrap();

        // User hand-edits AFTER the agent's last commit — must survive
        // as a stash ref when we restore.
        std::fs::write(workspace.join("a.txt"), "user_edit").unwrap();
        std::fs::write(workspace.join("manual.txt"), "by_hand").unwrap();

        let report = restore("st", 1, Phase::Pre, &workspace, None).await.unwrap();
        assert!(report.stash_commit.is_some(), "hand-edits should be stashed");
        // After restore: file is back to v1
        assert_eq!(std::fs::read_to_string(workspace.join("a.txt")).unwrap(), "v1");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    #[serial]
    async fn discard_branch_removes_only_later_turns() {
        let tmp = temp_root();
        std::env::set_var("YIYI_WORKING_DIR", &tmp);
        let workspace = tmp.join("ws_discard");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(workspace.join("a"), "1").unwrap();
        for t in 1..=4 {
            std::fs::write(workspace.join("a"), format!("{t}")).unwrap();
            snapshot_pre_turn("sd", t, &workspace).await.unwrap();
            snapshot_post_turn("sd", t, &workspace).await.unwrap();
        }
        let before = list_snapshots("sd", &workspace).len();
        let removed = discard_branch_after("sd", 2, &workspace).await.unwrap();
        let after = list_snapshots("sd", &workspace).len();
        assert!(removed >= 4, "expected >=4 refs deleted (turns 3+4 pre+post), got {removed}");
        assert_eq!(after, before - removed as usize);
        // Turns 1,2 still listed
        assert!(list_snapshots("sd", &workspace).iter().all(|s| s.turn_index <= 2));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn dirty_set_take_drains_per_session() {
        report_dirty("sx", "a.txt");
        report_dirty("sx", "b.txt");
        report_dirty("sy", "c.txt");
        let sx = take_dirty("sx");
        assert_eq!(sx.len(), 2);
        // second drain returns empty
        assert!(take_dirty("sx").is_empty());
        // sy untouched
        assert_eq!(take_dirty("sy").len(), 1);
    }
}
