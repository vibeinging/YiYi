import { create } from 'zustand'
import {
  getBuddyConfig,
  saveBuddyConfig,
  hatchBuddy,
  buddyObserve,
  type BuddyConfig,
} from '../api/buddy'
import {
  roll,
  getCompanion,
  getSpeciesLabel,
  mergeStats,
  analyzeGrowth,
  applyGrowth,
  type Companion,
  type CompanionBones,
} from '../utils/buddy'

interface BuddyState {
  // Persisted config (from backend)
  config: BuddyConfig | null
  loaded: boolean

  // Deterministic bones (regenerated from userId)
  bones: CompanionBones | null
  inspirationSeed: number

  // Full companion (bones + soul merged)
  companion: Companion | null

  // YiYi's display name (from SOUL.md, set externally)
  aiName: string

  // Runtime UI state
  hatching: boolean
  bubbleText: string | null
  bubbleVisible: boolean
  petting: boolean
  showStats: boolean
  showHatchAnimation: boolean

  // Observer throttle
  lastObserveAt: number

  // Actions
  loadBuddy: () => Promise<void>
  setAiName: (name: string) => void
  hatch: (personalityHint?: string) => Promise<void>
  triggerObserve: (recentMessages: string[]) => Promise<void>
  showBubble: (text: string) => void
  hideBubble: () => void
  pet: () => void
  setMuted: (muted: boolean) => Promise<void>
  setShowStats: (show: boolean) => void
  dismissHatch: () => void
}

const BASE_OBSERVE_COOLDOWN_MS = 30_000
const BUBBLE_DURATION_MS = 10_000

let bubbleTimer: ReturnType<typeof setTimeout> | null = null
let petTimer: ReturnType<typeof setTimeout> | null = null

export const useBuddyStore = create<BuddyState>((set, get) => ({
  config: null,
  loaded: false,
  bones: null,
  inspirationSeed: 0,
  companion: null,
  aiName: 'YiYi',
  hatching: false,
  bubbleText: null,
  bubbleVisible: false,
  petting: false,
  showStats: false,
  showHatchAnimation: false,
  lastObserveAt: 0,

  loadBuddy: async () => {
    try {
      let config = await getBuddyConfig()

      // Auto-generate userId if empty
      if (!config.buddy_user_id) {
        config.buddy_user_id = crypto.randomUUID()
        config = await saveBuddyConfig(config)
      }

      const { bones, inspirationSeed } = roll(config.buddy_user_id)

      let companion: Companion | null = null
      if (config.hatched_at > 0) {
        companion = getCompanion(config.buddy_user_id, {
          name: config.name,
          personality: config.personality,
          hatchedAt: config.hatched_at,
        })
        // Apply accumulated growth
        if (config.stats_delta && Object.keys(config.stats_delta).length > 0) {
          companion = { ...companion, stats: mergeStats(companion.stats, config.stats_delta) }
        }
      }

      set({
        config,
        loaded: true,
        bones,
        inspirationSeed,
        companion,
        showHatchAnimation: config.hatched_at === 0,
      })
    } catch (err) {
      console.error('Failed to load buddy:', err)
      set({ loaded: true })
    }
  },

  setAiName: (name: string) => set({ aiName: name }),

  hatch: async (personalityHint?: string) => {
    const { config, bones, aiName } = get()
    if (!config || !bones || config.hatched_at > 0) return

    const personality = personalityHint || '活泼开朗，总是充满正能量'

    set({ hatching: true })
    try {
      const updatedConfig = await hatchBuddy(aiName, personality)

      const companion = getCompanion(config.buddy_user_id, {
        name: updatedConfig.name,
        personality: updatedConfig.personality,
        hatchedAt: updatedConfig.hatched_at,
      })

      set({
        config: updatedConfig,
        companion,
        hatching: false,
      })
    } catch (err) {
      console.error('Failed to hatch buddy:', err)
      set({ hatching: false })
    }
  },

  triggerObserve: async (recentMessages: string[]) => {
    const { companion, config, bones, aiName, lastObserveAt, bubbleVisible } = get()
    if (!companion || !config || !bones) return
    if (config.muted) return
    if (bubbleVisible) return

    const now = Date.now()
    // ENERGY stat reduces cooldown: 100 energy → 15s, 0 energy → 40s
    const energy = companion.stats.ENERGY ?? 50
    const cooldown = BASE_OBSERVE_COOLDOWN_MS * (1.3 - energy / 100 * 0.8)
    if (now - lastObserveAt < cooldown) return

    set({ lastObserveAt: now })

    // 1. Analyze growth from conversation content (local, no LLM)
    const growth = analyzeGrowth(recentMessages, config.interaction_count)
    if (Object.keys(growth).length > 0) {
      const newDelta = applyGrowth(config.stats_delta || {}, growth)
      const updatedConfig = {
        ...config,
        stats_delta: newDelta,
        interaction_count: config.interaction_count + 1,
      }
      // Update companion with merged stats
      const updatedCompanion = {
        ...companion,
        stats: mergeStats(bones.stats, newDelta),
      }
      set({ config: updatedConfig, companion: updatedCompanion })
      // Persist in background (fire-and-forget)
      saveBuddyConfig(updatedConfig).catch(() => {})
    }

    // 2. Ask LLM for bubble reaction (async, non-blocking)
    try {
      const speciesLabel = getSpeciesLabel(bones.species)
      const currentCompanion = get().companion ?? companion
      const reaction = await buddyObserve(
        recentMessages,
        aiName,
        speciesLabel,
        currentCompanion.personality,
        currentCompanion.stats,
      )
      if (reaction) {
        get().showBubble(reaction)
      }
    } catch {
      // Observe is non-critical, silently ignore
    }
  },

  showBubble: (text: string) => {
    if (bubbleTimer) clearTimeout(bubbleTimer)
    set({ bubbleText: text, bubbleVisible: true })
    bubbleTimer = setTimeout(() => {
      set({ bubbleVisible: false })
      bubbleTimer = setTimeout(() => {
        set({ bubbleText: null })
      }, 500)
    }, BUBBLE_DURATION_MS)
  },

  hideBubble: () => {
    if (bubbleTimer) clearTimeout(bubbleTimer)
    set({ bubbleText: null, bubbleVisible: false })
  },

  pet: () => {
    if (petTimer) clearTimeout(petTimer)
    set({ petting: true })
    petTimer = setTimeout(() => {
      set({ petting: false })
    }, 2500)

    const { companion } = get()
    if (companion) {
      // Pick reaction pool based on dominant stat
      const s = companion.stats
      const warmReactions = ['好舒服~', '❤️', '嗯…谢谢你', '(´▽`ʃ♡ƪ)', '有你真好']
      const sassReactions = ['够了够了！', '手拿开！', '哼，别以为这样我就开心了', '...还行吧', '你手好重']
      const mischiefReactions = ['嘿嘿~', '再来再来！', '挠挠这里~', '嘻嘻(ᐛ)', '接下来换我摸你？']
      const energyReactions = ['再摸摸！', '好耶！！', '摸摸=充电⚡', '元气满满！', '(ノ>ω<)ノ']
      const witReactions = ['你知道吗，摸头能促进多巴胺分泌', '喵~', '据统计这是今天第…算了', '嗯哼~']

      let pool: string[]
      const max = Math.max(s.WARMTH, s.SASS, s.MISCHIEF, s.ENERGY, s.WIT)
      if (max === s.SASS && s.SASS > 40) pool = sassReactions
      else if (max === s.MISCHIEF && s.MISCHIEF > 40) pool = mischiefReactions
      else if (max === s.ENERGY && s.ENERGY > 40) pool = energyReactions
      else if (max === s.WIT && s.WIT > 40) pool = witReactions
      else pool = warmReactions

      const text = pool[Math.floor(Math.random() * pool.length)]
      get().showBubble(text)
    }
  },

  setMuted: async (muted: boolean) => {
    const { config } = get()
    if (!config) return
    const updated = { ...config, muted }
    try {
      await saveBuddyConfig(updated)
      set({ config: updated })
      if (muted) get().hideBubble()
    } catch (err) {
      console.error('Failed to save buddy config:', err)
    }
  },

  setShowStats: (show: boolean) => set({ showStats: show }),

  dismissHatch: () => set({ showHatchAnimation: false }),
}))
