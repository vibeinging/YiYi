import { invoke } from '@tauri-apps/api/core'

export interface PluginInfo {
  id: string
  name: string
  version: string
  description: string
  enabled: boolean
  tool_count: number
  has_hooks: boolean
}

export async function listPlugins(): Promise<PluginInfo[]> {
  return await invoke<PluginInfo[]>('list_plugins')
}

export async function enablePlugin(id: string): Promise<void> {
  await invoke('enable_plugin', { id })
}

export async function disablePlugin(id: string): Promise<void> {
  await invoke('disable_plugin', { id })
}

export async function reloadPlugins(): Promise<number> {
  return await invoke<number>('reload_plugins')
}
