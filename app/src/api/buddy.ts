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

// ── Memory browsing ──

export interface MemoryEntry {
  id: string
  content: string
  categories: string[]
  importance: number
  created_at: string
}

export interface MemoryStats {
  total: number
  by_category: Record<string, number>
}

export async function getMemoryStats(): Promise<MemoryStats> {
  return await invoke<MemoryStats>('get_memory_stats')
}

export async function listRecentMemories(limit?: number): Promise<MemoryEntry[]> {
  return await invoke<MemoryEntry[]>('list_recent_memories', { limit })
}

export async function searchMemories(query: string, limit?: number): Promise<MemoryEntry[]> {
  return await invoke<MemoryEntry[]>('search_memories', { query, limit })
}

export async function deleteMemory(id: string): Promise<void> {
  return await invoke<void>('delete_memory', { id })
}

// ── Corrections ──

export interface CorrectionEntry {
  trigger: string
  wrong_behavior: string
  correct_behavior: string
  confidence: number
}

export async function listCorrections(): Promise<CorrectionEntry[]> {
  return await invoke<CorrectionEntry[]>('list_corrections')
}

// ── Observe ──

export async function buddyObserve(
  recentMessages: string[],
  aiName: string,
  speciesLabel: string,
  reactionStyle: string,
  stats: Record<string, number>,
): Promise<string | null> {
  return await invoke<string | null>('buddy_observe', {
    recentMessages,
    aiName,
    speciesLabel,
    reactionStyle,
    stats,
  })
}
