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
  pet_count: number
  delegation_count: number
  trust_scores: Record<string, number>
  trust_overall: number
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

export interface EpisodeEntry {
  episode_id: string
  title: string
  summary: string
  started_at: string
  ended_at: string | null
  significance: number
  outcome: string | null
}

export async function listRecentEpisodes(limit?: number): Promise<EpisodeEntry[]> {
  return await invoke<EpisodeEntry[]>('list_recent_episodes', { limit })
}

// ── Corrections ──

export interface CorrectionEntry {
  trigger: string
  correct_behavior: string
  source: string
  confidence: number
}

export async function listCorrections(): Promise<CorrectionEntry[]> {
  return await invoke<CorrectionEntry[]>('list_corrections')
}

// ── Decision log & trust ──

export interface BuddyDecision {
  id: string
  question: string
  context: string
  buddy_answer: string
  buddy_confidence: number
  user_feedback: string | null
  created_at: number
}

export interface ContextTrust {
  total: number
  good: number
  bad: number
  accuracy: number
}

export interface TrustStats {
  total: number
  good: number
  bad: number
  pending: number
  accuracy: number
  by_context: Record<string, ContextTrust>
}

export async function listBuddyDecisions(limit?: number): Promise<BuddyDecision[]> {
  return await invoke<BuddyDecision[]>('list_buddy_decisions', { limit })
}

export async function setDecisionFeedback(decisionId: string, feedback: 'good' | 'bad'): Promise<void> {
  return await invoke<void>('set_decision_feedback', { decisionId, feedback })
}

export async function getTrustStats(): Promise<TrustStats> {
  return await invoke<TrustStats>('get_trust_stats')
}

// ── Meditation sessions ──

export interface MeditationSession {
  id: string
  started_at: number
  finished_at: number | null
  status: string
  sessions_reviewed: number
  memories_updated: number
  principles_changed: number
  memories_archived: number
  journal: string | null
  error: string | null
  tomorrow_intentions: string | null
  growth_synthesis: string | null
}

export async function listMeditationSessions(limit?: number): Promise<MeditationSession[]> {
  return await invoke<MeditationSession[]>('list_meditation_sessions', { limit })
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
