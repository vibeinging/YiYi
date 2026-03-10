/**
 * Settings API
 */

import { invoke } from '@tauri-apps/api/core';

export interface ModelInfo {
  id: string;
  name: string;
  provider?: string;
  type?: 'chat' | 'completion' | 'embedding';
}

export interface EnvVar {
  key: string;
  value: string;
  description?: string;
  masked?: boolean;
}

/**
 * 列出可用模型
 */
export async function listModels(): Promise<ModelInfo[]> {
  return await invoke<ModelInfo[]>('list_models');
}

/**
 * 设置当前模型
 */
export async function setModel(modelName: string): Promise<{ status: string; model: string }> {
  return await invoke('set_model', { modelName });
}

/**
 * 获取当前模型
 */
export async function getCurrentModel(): Promise<string> {
  const result = await invoke<{ status: string; model?: string }>('get_current_model');
  return result.model || '';
}
