// Environment Variables API
import { invoke } from '@tauri-apps/api/core';

export interface EnvVar {
  key: string;
  value: string;
  description?: string;
}

export async function listEnvs(): Promise<EnvVar[]> {
  return await invoke('list_envs');
}

export async function saveEnvs(envs: EnvVar[]): Promise<void> {
  return await invoke('save_envs', { envs });
}

export async function deleteEnv(key: string): Promise<void> {
  return await invoke('delete_env', { key });
}
