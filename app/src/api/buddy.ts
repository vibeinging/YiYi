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

/**
 * 列出最近记忆。`userId` 缺省 = 主用户桶；传 `"family_shared"` 即可浏览家族
 * 共享桶（家族会话 dispatched 成员的记忆桶，白盒原则要求可见可删）。
 */
export async function listRecentMemories(limit?: number, userId?: string): Promise<MemoryEntry[]> {
  return await invoke<MemoryEntry[]>('list_recent_memories', { limit, userId })
}

export async function searchMemories(
  query: string,
  limit?: number,
  userId?: string,
): Promise<MemoryEntry[]> {
  return await invoke<MemoryEntry[]>('search_memories', { query, limit, userId })
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

/** 单个伙伴的反思历史(C 期)。 */
export async function listCompanionMeditationSessions(
  companionId: number,
  limit?: number,
): Promise<MeditationSession[]> {
  return await invoke<MeditationSession[]>('list_companion_meditation_sessions', { companionId, limit })
}

// ── Personality (per-companion 性格演化) ──

export interface PersonalityStat {
  /** 小写 trait 名:energy / warmth / mischief / wit / sass */
  trait: string
  /** 0–100,base 50 + 时间衰减加权和。 */
  value: number
  /** 相对 base 的偏移(可正可负)。 */
  delta: number
}

export interface PersonalitySignalRow {
  id: number
  trait_name: string
  delta: number
  evidence: string
  memory_id: string | null
  created_at: string
}

export interface CompanionReflectionResult {
  companion_id: number
  messages_reviewed: number
  signals_added: number
  journal: string
}

/** `companionId` 缺省 = YiYi/全局;传 id = 该伙伴自己的性格。 */
export async function getPersonalityStats(companionId?: number): Promise<PersonalityStat[]> {
  return await invoke<PersonalityStat[]>('get_personality_stats', { companionId })
}

export async function getPersonalityTimeline(
  companionId?: number,
  limit?: number,
): Promise<PersonalitySignalRow[]> {
  return await invoke<PersonalitySignalRow[]>('get_personality_timeline', { companionId, limit })
}

/** 对单个伙伴跑一次轻量反思:读它的发言 → 产它自己的性格信号。 */
export async function triggerCompanionReflection(
  companionId: number,
): Promise<CompanionReflectionResult> {
  return await invoke<CompanionReflectionResult>('trigger_companion_reflection', { companionId })
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
