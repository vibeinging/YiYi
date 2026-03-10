// System API
import { invoke } from '@tauri-apps/api/core';
import type { ModelInfo, ShellResult } from './types';

export async function healthCheck(): Promise<{
  status: string;
  version: string;
  methods: string[];
}> {
  return await invoke('health_check');
}

export async function listModels(): Promise<ModelInfo[]> {
  return await invoke('list_models');
}

export async function setModel(modelName: string): Promise<void> {
  await invoke('set_model', { modelName });
}

export async function executeShell(
  command: string,
  args?: string[],
  cwd?: string,
): Promise<ShellResult> {
  return await invoke('execute_shell', { command, args, cwd });
}

export async function isSetupComplete(): Promise<boolean> {
  return await invoke<boolean>('is_setup_complete');
}

export async function completeSetup(): Promise<void> {
  await invoke('complete_setup');
}

export async function getUserWorkspace(): Promise<string> {
  return await invoke('get_user_workspace');
}

export async function setUserWorkspace(path: string): Promise<void> {
  await invoke('set_user_workspace', { path });
}
