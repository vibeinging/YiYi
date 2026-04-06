// ─── Buddy Companion: Deterministic Generation ───
// Same userId always generates the same companion. Bones are never persisted.
// Visual: glowing light orbs (精灵光团) with different shapes and colors.

// ─── Types ───

// ─── Species = Light Orb Shape ───

export const ORB_SHAPES = [
  'circle', 'star', 'diamond', 'teardrop', 'crescent',
  'hexagon', 'petal', 'flame', 'cloud', 'heart',
] as const
export type OrbShape = (typeof ORB_SHAPES)[number]

export interface SpeciesConfig {
  shape: OrbShape
  label: string
  css: string          // CSS clip-path or border-radius for the shape
  glowSpread: number   // px, how far the glow extends
}

export const SPECIES_MAP: Record<OrbShape, SpeciesConfig> = {
  circle:   { shape: 'circle',   label: '圆灵',   css: 'border-radius: 50%',                                          glowSpread: 18 },
  star:     { shape: 'star',     label: '星灵',   css: 'clip-path: polygon(50% 0%,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%)', glowSpread: 22 },
  diamond:  { shape: 'diamond',  label: '菱灵',   css: 'clip-path: polygon(50% 0%,100% 50%,50% 100%,0% 50%)',          glowSpread: 16 },
  teardrop: { shape: 'teardrop', label: '泪灵',   css: 'border-radius: 50% 50% 50% 0%',                               glowSpread: 16 },
  crescent: { shape: 'crescent', label: '月灵',   css: 'border-radius: 50%; clip-path: polygon(40% 0%,100% 0%,100% 100%,40% 100%,20% 80%,10% 50%,20% 20%)', glowSpread: 14 },
  hexagon:  { shape: 'hexagon',  label: '晶灵',   css: 'clip-path: polygon(25% 0%,75% 0%,100% 50%,75% 100%,25% 100%,0% 50%)', glowSpread: 18 },
  petal:    { shape: 'petal',    label: '瓣灵',   css: 'border-radius: 50% 0% 50% 0%',                                glowSpread: 16 },
  flame:    { shape: 'flame',    label: '焰灵',   css: 'border-radius: 50% 50% 20% 20%',                              glowSpread: 20 },
  cloud:    { shape: 'cloud',    label: '雾灵',   css: 'border-radius: 40% 60% 50% 50%',                              glowSpread: 22 },
  heart:    { shape: 'heart',    label: '心灵',   css: 'clip-path: polygon(50% 18%,61% 0%,95% 0%,100% 35%,50% 100%,0% 35%,5% 0%,39% 0%)', glowSpread: 18 },
}

export type Species = OrbShape
export const SPECIES_KEYS = ORB_SHAPES as unknown as Species[]

// ─── Orb Color Palettes ───
// Each palette is a gradient pair [from, to] that defines the orb's glow

export const ORB_PALETTES = [
  { name: '极光',   from: '#6EE7B7', to: '#3B82F6' },
  { name: '晚霞',   from: '#F472B6', to: '#FBBF24' },
  { name: '深海',   from: '#06B6D4', to: '#6366F1' },
  { name: '樱粉',   from: '#FDA4AF', to: '#E879F9' },
  { name: '星尘',   from: '#A78BFA', to: '#38BDF8' },
  { name: '暖阳',   from: '#FCD34D', to: '#F97316' },
  { name: '薄荷',   from: '#34D399', to: '#2DD4BF' },
  { name: '烈焰',   from: '#EF4444', to: '#F59E0B' },
  { name: '幽蓝',   from: '#818CF8', to: '#0EA5E9' },
  { name: '森林',   from: '#4ADE80', to: '#059669' },
  { name: '紫晶',   from: '#C084FC', to: '#7C3AED' },
  { name: '珊瑚',   from: '#FB923C', to: '#F43F5E' },
] as const
export type OrbPalette = (typeof ORB_PALETTES)[number]

export const PARTICLES = [
  'none', 'stars', 'hearts', 'notes', 'leaves', 'bubbles', 'sparkles', 'snow',
] as const
export type Particle = (typeof PARTICLES)[number]

export const IDLE_STYLES = ['breathe', 'bounce', 'float', 'sway', 'pulse'] as const
export type IdleStyle = (typeof IDLE_STYLES)[number]

export const STAT_NAMES = ['ENERGY', 'WARMTH', 'MISCHIEF', 'WIT', 'SASS'] as const
export type StatName = (typeof STAT_NAMES)[number]

export type CompanionBones = {
  species: Species
  palette: OrbPalette
  particle: Particle
  idleStyle: IdleStyle
  sizeScale: number // 0.85 ~ 1.15
  shiny: boolean
  stats: Record<StatName, number>
}

export type CompanionSoul = {
  name: string
  personality: string
}

export type Companion = CompanionBones & CompanionSoul & { hatchedAt: number }

// ─── Display Constants ───

export const COMPANION_COLOR = 'var(--color-primary)'

export const PARTICLE_EMOJI: Record<Particle, string[]> = {
  none: [],
  stars: ['✦', '⋆', '·'],
  hearts: ['♡', '❤️', '💕'],
  notes: ['♪', '♫', '🎵'],
  leaves: ['🍃', '🌿', '☘️'],
  bubbles: ['◦', '○', '◯'],
  sparkles: ['✨', '✧', '⋆'],
  snow: ['❄️', '❅', '·'],
}

export const STAT_LABELS: Record<StatName, string> = {
  ENERGY: '活力', WARMTH: '温柔', MISCHIEF: '调皮', WIT: '聪慧', SASS: '犀利',
}

// Personality presets bias stats
export const PERSONALITY_STAT_BIAS: Record<string, { peak: StatName; dump: StatName }> = {
  '活泼开朗，总是充满正能量，喜欢用感叹号和颜文字为主人加油打气': { peak: 'ENERGY', dump: 'SASS' },
  '嘴上不饶人但其实很关心主人，会用吐槽和傲娇的方式表达关爱': { peak: 'SASS', dump: 'WARMTH' },
  '话不多但很温暖，只在关键时刻冒泡，给出走心的一句话': { peak: 'WARMTH', dump: 'MISCHIEF' },
  '对一切都充满好奇，喜欢问为什么，看到新东西就兴奋': { peak: 'WIT', dump: 'SASS' },
  '冷静理性，偶尔掉书袋引经据典，用知识分子的方式卖萌': { peak: 'WIT', dump: 'ENERGY' },
  '喜欢搞怪和冷笑话，说话不着调，但总能让人笑出来': { peak: 'MISCHIEF', dump: 'WARMTH' },
}

// Generate stats biased by personality choice
export function rollStatsBiased(
  userId: string,
  personalityValue: string,
): Record<StatName, number> {
  const key = userId + 'yiyi-buddy-2026'
  const rng = mulberry32(hashString(key + '-stats'))
  const floor = 20
  const bias = PERSONALITY_STAT_BIAS[personalityValue]

  const peak = bias?.peak ?? pick(rng, STAT_NAMES)
  let dump = bias?.dump ?? pick(rng, STAT_NAMES)
  if (dump === peak) {
    const others = STAT_NAMES.filter(s => s !== peak)
    dump = pick(rng, others)
  }

  const stats = {} as Record<StatName, number>
  for (const name of STAT_NAMES) {
    if (name === peak) {
      stats[name] = Math.min(100, floor + 50 + Math.floor(rng() * 30))
    } else if (name === dump) {
      stats[name] = Math.max(1, floor - 10 + Math.floor(rng() * 15))
    } else {
      stats[name] = floor + Math.floor(rng() * 40)
    }
  }
  return stats
}

// ─── PRNG ───

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// ─── Rolling ───

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!
}

function rollStats(rng: () => number): Record<StatName, number> {
  const floor = 20
  const peak = pick(rng, STAT_NAMES)
  let dump = pick(rng, STAT_NAMES)
  while (dump === peak) dump = pick(rng, STAT_NAMES)

  const stats = {} as Record<StatName, number>
  for (const name of STAT_NAMES) {
    if (name === peak) {
      stats[name] = Math.min(100, floor + 50 + Math.floor(rng() * 30))
    } else if (name === dump) {
      stats[name] = Math.max(1, floor - 10 + Math.floor(rng() * 15))
    } else {
      stats[name] = floor + Math.floor(rng() * 40)
    }
  }
  return stats
}

const SALT = 'yiyi-buddy-2026'

export type Roll = {
  bones: CompanionBones
  inspirationSeed: number
}

function rollFrom(rng: () => number): Roll {
  const species = pick(rng, ORB_SHAPES)
  const palette = pick(rng, ORB_PALETTES)
  const bones: CompanionBones = {
    species,
    palette,
    particle: rng() < 0.3 ? pick(rng, PARTICLES.filter(p => p !== 'none')) : 'none',
    idleStyle: pick(rng, IDLE_STYLES),
    sizeScale: 0.85 + rng() * 0.3,
    shiny: rng() < 0.08,
    stats: rollStats(rng),
  }
  return { bones, inspirationSeed: Math.floor(rng() * 1e9) }
}

let rollCache: { key: string; value: Roll } | undefined

export function roll(userId: string): Roll {
  const key = userId + SALT
  if (rollCache?.key === key) return rollCache.value
  const value = rollFrom(mulberry32(hashString(key)))
  rollCache = { key, value }
  return value
}

export function getCompanion(
  userId: string,
  soul: CompanionSoul & { hatchedAt: number },
): Companion {
  const { bones } = roll(userId)
  return { ...soul, ...bones }
}

// ─── Helpers ───

export function getSpeciesConfig(species: Species): SpeciesConfig {
  return SPECIES_MAP[species]
}

export function getSpeciesLabel(species: Species): string {
  return SPECIES_MAP[species]?.label ?? species
}

// ─── Stats Growth Engine ───
import { GROWTH_SIGNALS } from './buddyGrowthKeywords'

const GROWTH_PER_HIT = 1
const MAX_GROWTH_PER_CALL = 3
const DIMINISH_THRESHOLD = 500

export function analyzeGrowth(
  recentMessages: string[],
  interactionCount: number,
): Partial<Record<StatName, number>> {
  const text = recentMessages.join(' ')
  const deltas: Partial<Record<StatName, number>> = {}
  const multiplier = interactionCount > DIMINISH_THRESHOLD ? 0.5 : 1

  for (const signal of GROWTH_SIGNALS) {
    signal.regex.lastIndex = 0
    const matches = text.match(signal.regex)
    if (matches) {
      const raw = Math.min(matches.length * GROWTH_PER_HIT, MAX_GROWTH_PER_CALL)
      const growth = Math.max(1, Math.round(raw * multiplier))
      deltas[signal.stat] = growth
    }
  }
  return deltas
}

export function applyGrowth(
  currentDelta: Record<string, number>,
  newGrowth: Partial<Record<StatName, number>>,
): Record<string, number> {
  const MAX_TOTAL_GROWTH = 50
  const result = { ...currentDelta }
  for (const [stat, growth] of Object.entries(newGrowth)) {
    const current = result[stat] ?? 0
    result[stat] = Math.min(MAX_TOTAL_GROWTH, current + (growth ?? 0))
  }
  return result
}

export function mergeStats(
  baseStats: Record<StatName, number>,
  statsDelta: Record<string, number>,
): Record<StatName, number> {
  const result = { ...baseStats }
  for (const stat of STAT_NAMES) {
    const delta = statsDelta[stat] ?? 0
    result[stat] = Math.max(1, Math.min(100, result[stat] + delta))
  }
  return result
}
