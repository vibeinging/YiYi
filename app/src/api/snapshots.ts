// Workspace checkpoint API.
//
// Per-turn shadow-git snapshots of the user's workspace, stored under
// `~/.yiyi/checkpoints/<workspace_hash>/git/` so the user's real `.git`
// is never touched. Agent edits can be rolled back without disturbing
// the user's own version control.

import { invoke } from "@tauri-apps/api/core";

export interface CheckpointInfo {
  session_id: string;
  turn_index: number;
  phase: "pre" | "post" | string;
  commit: string;
  parent_commit: string | null;
  created_at_ms: number;
  files_changed: number;
  insertions: number;
  deletions: number;
  changed_files: string[];
}

export interface CheckpointRestoreReport {
  restored_files: string[];
  removed_files: string[];
  /** Auto-stash commit oid if hand-edits were captured before restore. */
  stash_commit: string | null;
}

export interface FileDiff {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied";
  additions: number;
  deletions: number;
  patch: string;
  truncated: boolean;
}

export async function listCheckpoints(sessionId: string): Promise<CheckpointInfo[]> {
  return invoke<CheckpointInfo[]>("list_checkpoints", { sessionId });
}

export async function previewCheckpoint(
  sessionId: string,
  turnIndex: number,
  phase: "pre" | "post",
): Promise<FileDiff[]> {
  return invoke<FileDiff[]>("preview_checkpoint", { sessionId, turnIndex, phase });
}

export async function restoreCheckpoint(
  sessionId: string,
  turnIndex: number,
  phase: "pre" | "post",
  paths?: string[],
): Promise<CheckpointRestoreReport> {
  return invoke<CheckpointRestoreReport>("restore_checkpoint", {
    sessionId,
    turnIndex,
    phase,
    paths: paths ?? null,
  });
}

export async function discardCheckpointBranch(
  sessionId: string,
  keepThroughTurn: number,
): Promise<number> {
  return invoke<number>("discard_checkpoint_branch", {
    sessionId,
    keepThroughTurn,
  });
}
