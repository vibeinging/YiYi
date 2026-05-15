//! Central single-file backup (P2.1).
//!
//! Every file-mutating tool (`write_file` / `edit_file` / `append_file` /
//! `delete_file`) snapshots the current contents into one shared backup
//! store before touching the file. `undo_edit` then has a uniform recovery
//! surface: regardless of which tool clobbered a file, one rollback path
//! covers it.
//!
//! Backup layout: `~/.yiyi/backups/<fnv16hex>__<short_tail>.backup`
//! (single revision per path — a second mutation overwrites the prior
//! backup). The hash is the collision-safe identity; the tail is just
//! human-readable scaffolding.
//!
//! ## Why this lives alongside `engine::checkpoint`
//!
//! The two are NOT redundant — they cover different time granularities:
//!
//!   * `backup_to_central` is **per tool call**: undo the single most
//!     recent write/edit/append/delete to one file. Operates on demand
//!     via `undo_edit` regardless of session/turn state.
//!   * `engine::checkpoint` is **per turn**: snapshot the whole
//!     workspace at turn boundaries (pre + post), restore any file or
//!     all files back to that point. Drives the UI timeline.
//!
//! They DO compose cleanly: when `undo_edit` restores a file to its
//! pre-mutation state, that state is what the next `snapshot_post_turn`
//! will record. A subsequent turn-level restore to that turn's `pre`
//! snapshot also lands on the same content — the two recovery paths
//! are idempotent on the same intermediate result, not in conflict.

/// Stable on-disk slot for a path's backup. Public so undo_edit and
/// tests can locate the same file the writers used.
///
/// File-name layout: `<fnv16hex>__<short_basename>.backup`. The FNV-1a
/// fingerprint is the collision-safe identity (`/tmp/foo__bar` and
/// `/tmp/foo/bar` no longer collapse to the same slot — a real bug under
/// the old `path.replace('/', '__')` scheme). The trailing basename is
/// human-readable scaffolding so listing `~/.yiyi/backups/` still gives a
/// hint about which path each backup came from.
pub(crate) fn backup_slot_for(path: &str) -> Option<std::path::PathBuf> {
    let home = dirs::home_dir()?;
    let mut h: u64 = 0xcbf29ce484222325;
    for b in path.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    // Last ~40 chars of the path, with separator characters flattened so
    // the result is a valid single-segment filename across platforms.
    let tail_chars: Vec<char> = path.chars().rev().take(40).collect();
    let tail: String = tail_chars.into_iter().rev().collect();
    let safe_tail: String = tail
        .chars()
        .map(|c| if c == '/' || c == '\\' || c == ':' { '_' } else { c })
        .collect();
    Some(
        home.join(".yiyi")
            .join("backups")
            .join(format!("{:016x}__{}.backup", h, safe_tail)),
    )
}

/// Take a single-revision snapshot of `path` so undo_edit can roll
/// back the next mutation. Best-effort: returns `Some(backup_path)`
/// on success, `None` when the source doesn't exist or the backup
/// directory can't be created — neither case should block the caller.
pub(crate) async fn backup_to_central(path: &str) -> Option<std::path::PathBuf> {
    // Source must exist to be worth backing up — delete/edit/write on
    // a missing path means "create from scratch", no prior bytes to
    // preserve.
    let content = tokio::fs::read(path).await.ok()?;
    let slot = backup_slot_for(path)?;
    if let Some(parent) = slot.parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            log::warn!(
                "backup_to_central: create_dir_all({}) failed: {}",
                parent.display(),
                e
            );
            return None;
        }
    }
    match tokio::fs::write(&slot, &content).await {
        Ok(_) => Some(slot),
        Err(e) => {
            log::warn!(
                "backup_to_central: write({}) failed: {}",
                slot.display(),
                e
            );
            None
        }
    }
}
