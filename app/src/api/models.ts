// Models API
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
}

// Frontend-friendly version with computed fields
export interface ProviderDisplay extends ProviderInfo {
  extra_models: ModelInfo[];
  has_api_key: boolean;
  needs_base_url: boolean;
  current_api_key: string;
  current_base_url: string;
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
}

/** Adapt raw backend ProviderInfo to ProviderDisplay for the UI */
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
): Promise<TestConnectionResponse> {
  return await invoke('test_provider', {
    providerId,
    apiKey,
    baseUrl,
  });
}

export async function createCustomProvider(
  id: string,
  name: string,
  defaultBaseUrl: string,
  apiKeyPrefix: string,
  models: ModelInfo[],
): Promise<ProviderDisplay> {
  const raw = await invoke<ProviderInfo>('create_custom_provider', {
    id,
    name,
    defaultBaseUrl,
    apiKeyPrefix,
    models,
  });
  return adaptProvider(raw);
}

export async function deleteCustomProvider(
  providerId: string,
): Promise<ProviderDisplay[]> {
  const raw = await invoke<ProviderInfo[]>('delete_custom_provider', {
    providerId,
  });
  return raw.map(adaptProvider);
}

export async function addModel(
  providerId: string,
  modelId: string,
  modelName: string,
): Promise<ProviderDisplay> {
  const raw = await invoke<ProviderInfo>('add_model', {
    providerId,
    modelId,
    modelName,
  });
  return adaptProvider(raw);
}

export async function removeModel(
  providerId: string,
  modelId: string,
): Promise<ProviderDisplay> {
  const raw = await invoke<ProviderInfo>('remove_model', {
    providerId,
    modelId,
  });
  return adaptProvider(raw);
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

// ── Provider Plugin API ─────────────────────────────────────────────

export interface ProviderPlugin {
  id: string;
  name: string;
  default_base_url: string;
  api_key_env: string;
  api_compat: string;
  is_local: boolean;
  models: ModelInfo[];
  description?: string;
}

export interface ProviderTemplate {
  id: string;
  name: string;
  description: string;
  plugin: ProviderPlugin;
}

export async function listProviderTemplates(): Promise<ProviderTemplate[]> {
  return await invoke('list_provider_templates');
}

export async function importProviderPlugin(
  plugin: ProviderPlugin,
): Promise<ProviderDisplay> {
  const raw = await invoke<ProviderInfo>('import_provider_plugin', { plugin });
  return adaptProvider(raw);
}

export async function exportProviderConfig(
  providerId: string,
): Promise<ProviderPlugin> {
  return await invoke('export_provider_config', { providerId });
}

export async function scanProviderPlugins(): Promise<ProviderDisplay[]> {
  const raw = await invoke<ProviderInfo[]>('scan_provider_plugins');
  return raw.map(adaptProvider);
}

export async function importProviderFromTemplate(
  templateId: string,
): Promise<ProviderDisplay> {
  const raw = await invoke<ProviderInfo>('import_provider_from_template', {
    templateId,
  });
  return adaptProvider(raw);
}
