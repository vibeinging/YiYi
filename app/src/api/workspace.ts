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

// --- Authorized Folders ---
export interface AuthorizedFolder {
  id: string;
  path: string;
  label: string | null;
  permission: 'read_only' | 'read_write';
  is_default: boolean;
  created_at: number;
  updated_at: number;
}

export async function listAuthorizedFolders(): Promise<AuthorizedFolder[]> {
  return await invoke('list_authorized_folders');
}

export async function addAuthorizedFolder(
  path: string, label?: string, permission?: string
): Promise<AuthorizedFolder> {
  return await invoke('add_authorized_folder', { path, label, permission });
}

export async function updateAuthorizedFolder(
  id: string, label?: string, permission?: string
): Promise<void> {
  await invoke('update_authorized_folder', { id, label, permission });
}

export async function removeAuthorizedFolder(id: string): Promise<void> {
  await invoke('remove_authorized_folder', { id });
}

export async function pickFolder(): Promise<string | null> {
  return await invoke('pick_folder');
}

// --- Sensitive Patterns ---
export interface SensitivePattern {
  id: string;
  pattern: string;
  is_builtin: boolean;
  enabled: boolean;
  created_at: number;
}

export async function listSensitivePatterns(): Promise<SensitivePattern[]> {
  return await invoke('list_sensitive_patterns');
}

export async function addSensitivePattern(pattern: string): Promise<SensitivePattern> {
  return await invoke('add_sensitive_pattern', { pattern });
}

export async function toggleSensitivePattern(id: string, enabled: boolean): Promise<void> {
  await invoke('toggle_sensitive_pattern', { id, enabled });
}

export async function removeSensitivePattern(id: string): Promise<void> {
  await invoke('remove_sensitive_pattern', { id });
}

// --- Folder file listing ---
export async function listFolderFiles(folderPath: string): Promise<WorkspaceFile[]> {
  return await invoke('list_folder_files', { folderPath });
}
