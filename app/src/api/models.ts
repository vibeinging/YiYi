// Models API — V4-only build: only built-in DeepSeek provider, no custom/template/plugin support.
import { invoke } from '@tauri-apps/api/core';

export interface ModelInfo {
  id: string;
  name: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  default_base_url: string;
  api_key_prefix: string;
  models: ModelInfo[];
  extra_models: ModelInfo[];
  is_custom: boolean;
  is_local: boolean;
  configured: boolean;
  base_url: string | null;
  api_key_saved: string | null;
}

// Frontend-friendly version with computed fields
export interface ProviderDisplay extends ProviderInfo {
  extra_models: ModelInfo[];
  has_api_key: boolean;
  needs_base_url: boolean;
  current_api_key: string;
  current_base_url: string;
  api_key_saved: string | null;
}

export interface ModelSlotConfig {
  provider_id: string;
  model: string;
}

export interface ActiveModelsInfo {
  provider_id: string | null;
  model: string | null;
}

export interface TestConnectionResponse {
  success: boolean;
  message: string;
  latency_ms?: number;
  reply?: string;
}

/** Kept for setup wizard compatibility but unused in V4-only build. */
export const ZHIPU_SITES = {
  cn: {
    label: '国内站',
    baseUrl: 'https://api.deepseek.com/v1',
    codingBaseUrl: 'https://api.deepseek.com/v1',
    signupUrl: 'https://platform.deepseek.com/api_keys',
  },
  intl: {
    label: '国际',
    baseUrl: 'https://api.deepseek.com/v1',
    codingBaseUrl: 'https://api.deepseek.com/v1',
    signupUrl: 'https://platform.deepseek.com/api_keys',
  },
} as const;

export type ZhipuSiteKey = keyof typeof ZHIPU_SITES;

function adaptProvider(p: ProviderInfo): ProviderDisplay {
  return {
    ...p,
    has_api_key: p.configured,
    needs_base_url: p.is_custom,
    current_api_key: '',
    current_base_url: p.base_url || p.default_base_url || '',
  };
}

export async function listProviders(): Promise<ProviderDisplay[]> {
  const raw = await invoke<ProviderInfo[]>('list_providers');
  return raw.map(adaptProvider);
}

export async function configureProvider(
  providerId: string,
  apiKey?: string,
  baseUrl?: string,
): Promise<ProviderDisplay> {
  const raw = await invoke<ProviderInfo>('configure_provider', {
    providerId,
    apiKey,
    baseUrl,
  });
  return adaptProvider(raw);
}

export async function testProvider(
  providerId: string,
  apiKey?: string,
  baseUrl?: string,
  modelId?: string,
): Promise<TestConnectionResponse> {
  return await invoke('test_provider', {
    providerId,
    apiKey,
    baseUrl,
    modelId,
  });
}

export async function getActiveLlm(): Promise<ActiveModelsInfo> {
  return await invoke('get_active_llm');
}

export async function setActiveLlm(
  providerId: string,
  model: string,
): Promise<ActiveModelsInfo> {
  return await invoke('set_active_llm', {
    providerId,
    model,
  });
}

