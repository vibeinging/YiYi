// CLI Provider API
import { invoke } from '@tauri-apps/api/core';

export interface CliProviderInfo {
  key: string;
  enabled: boolean;
  binary: string;
  install_command: string;
  auth_command: string;
  check_command: string;
  credentials: Record<string, string>;
  auth_status: string;
  installed: boolean;
}

export interface CliProviderConfig {
  enabled: boolean;
  binary: string;
  install_command: string;
  auth_command: string;
  check_command: string;
  credentials: Record<string, string>;
  auth_status: string;
}

export async function listCliProviders(): Promise<CliProviderInfo[]> {
  return await invoke('list_cli_providers');
}

export async function saveCliProviderConfig(
  key: string,
  config: CliProviderConfig,
): Promise<CliProviderInfo> {
  return await invoke('save_cli_provider_config', { key, config });
}

export async function checkCliProvider(key: string): Promise<CliProviderInfo> {
  return await invoke('check_cli_provider', { key });
}

export async function installCliProvider(key: string): Promise<string> {
  return await invoke('install_cli_provider', { key });
}

export async function deleteCliProvider(key: string): Promise<void> {
  return await invoke('delete_cli_provider', { key });
}
