// Workspace API
import { invoke } from '@tauri-apps/api/core';

export interface WorkspaceFile {
  name: string;   // relative path from workspace root
  path: string;   // absolute path
  size: number;
  is_dir: boolean;
  modified: number;
}

export async function listWorkspaceFiles(): Promise<WorkspaceFile[]> {
  return await invoke('list_workspace_files');
}

export async function loadWorkspaceFile(filename: string): Promise<string> {
  return await invoke('load_workspace_file', { filename });
}

export async function loadWorkspaceFileBinary(filename: string): Promise<number[]> {
  return await invoke('load_workspace_file_binary', { filename });
}

export async function saveWorkspaceFile(filename: string, content: string): Promise<void> {
  return await invoke('save_workspace_file', { filename, content });
}

export async function deleteWorkspaceFile(filename: string): Promise<void> {
  return await invoke('delete_workspace_file', { filename });
}

export async function createWorkspaceFile(filename: string, content: string): Promise<void> {
  return await invoke('create_workspace_file', { filename, content });
}

export async function createWorkspaceDir(dirname: string): Promise<void> {
  return await invoke('create_workspace_dir', { dirname });
}

export async function uploadWorkspace(data: Uint8Array, filename: string): Promise<{ success: boolean; message: string }> {
  return await invoke('upload_workspace', { data: Array.from(data), filename });
}

export async function downloadWorkspace(): Promise<Uint8Array> {
  const data = await invoke<number[]>('download_workspace');
  return new Uint8Array(data);
}

export async function getWorkspacePath(): Promise<string> {
  return await invoke('get_workspace_path');
}
