import { invoke } from '@tauri-apps/api/core'

export interface BuddyConfig {
  name: string
  personality: string
  hatched_at: number
  muted: boolean
  buddy_user_id: string
  stats_delta: Record<string, number>
  interaction_count: number
  hosted_mode: boolean
}

export async function getBuddyConfig(): Promise<BuddyConfig> {
  return await invoke<BuddyConfig>('get_buddy_config')
}

export async function saveBuddyConfig(config: BuddyConfig): Promise<BuddyConfig> {
  return await invoke<BuddyConfig>('save_buddy_config', { config })
}

export async function hatchBuddy(
  name: string,
  personality: string,
): Promise<BuddyConfig> {
  return await invoke<BuddyConfig>('hatch_buddy', { name, personality })
}

export async function toggleBuddyHosted(enabled: boolean): Promise<boolean> {
  return await invoke<boolean>('toggle_buddy_hosted', { enabled })
}

export async function getBuddyHosted(): Promise<boolean> {
  return await invoke<boolean>('get_buddy_hosted')
}

export async function buddyObserve(
  recentMessages: string[],
  aiName: string,
  speciesLabel: string,
  reactionStyle: string,
): Promise<string | null> {
  return await invoke<string | null>('buddy_observe', {
    recentMessages,
    aiName,
    speciesLabel,
    reactionStyle,
  })
}
