import { invoke } from '@tauri-apps/api/core';

export interface PtySessionInfo {
  id: string;
  command: string;
  cwd: string;
  createdAt: number;
  isAlive: boolean;
}

export async function ptySpawn(
  command: string,
  args?: string[],
  cwd?: string,
  cols?: number,
  rows?: number
): Promise<string> {
  return invoke('pty_spawn', { command, args, cwd, cols, rows });
}

export async function ptyWrite(sessionId: string, data: string): Promise<void> {
  return invoke('pty_write', { sessionId, data });
}

export async function ptyResize(sessionId: string, cols: number, rows: number): Promise<void> {
  return invoke('pty_resize', { sessionId, cols, rows });
}

export async function ptyClose(sessionId: string): Promise<void> {
  return invoke('pty_close', { sessionId });
}

export async function ptyList(): Promise<PtySessionInfo[]> {
  return invoke('pty_list');
}
