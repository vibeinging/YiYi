// Side-git workspace snapshot API (Phase J).
//
// Per-turn snapshots of the user's workspace stored beside YiYi's data dir,
// allowing rollback of any agent turn without touching the user's real .git.

import { invoke } from "@tauri-apps/api/core";

export interface SnapshotInfo {
  session_id: string;
  turn_index: number;
  phase: "pre" | "post" | string;
  path: string;
  size_bytes: number;
  created_at_ms: number;
}

export interface RestoreReport {
  restored_files: string[];
  removed_files: string[];
}

/** List all snapshots for a session, sorted by (turn_index, phase, created_at). */
export async function listSnapshots(sessionId: string): Promise<SnapshotInfo[]> {
  return invoke<SnapshotInfo[]>("list_snapshots", { sessionId });
}

/** Restore the workspace to the given (turn_index, phase) snapshot. */
export async function restoreSnapshot(
  sessionId: string,
  turnIndex: number,
  phase: "pre" | "post" = "pre",
): Promise<RestoreReport> {
  return invoke<RestoreReport>("restore_snapshot", {
    sessionId,
    turnIndex,
    phase,
  });
}
