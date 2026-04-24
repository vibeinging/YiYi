/**
 * BuddyPanel — The companion's page.
 * Clean card-based layout. Warm, readable, unobtrusive.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  Brain, Play, Loader2, Eye, EyeOff, Search, Trash2,
  ShieldCheck, ThumbsUp, ThumbsDown, Shield, Sparkles, Star, ChevronRight,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useBuddyStore } from '../stores/buddyStore'
import { useMeditationStore } from '../stores/meditationStore'
import {
  toggleBuddyHosted,
  getMemoryStats, listRecentMemories, searchMemories, deleteMemory,
  listRecentEpisodes,
  listCorrections, listMeditationSessions,
  listBuddyDecisions, setDecisionFeedback, getTrustStats,
  type MemoryEntry, type MemoryStats, type CorrectionEntry, type MeditationSession,
  type BuddyDecision, type TrustStats, type EpisodeEntry,
} from '../api/buddy'
import { getSpeciesLabel, STAT_LABELS, STAT_NAMES, type StatName } from '../utils/buddy'
import { PersonalityOrb } from './buddy/PersonalityOrb'
import { toast } from './Toast'

const ORB_SIZE = 180

const catLabel = (c: string) => ({ fact: '事实', preference: '偏好', experience: '经验', decision: '决策', principle: '原则', note: '备注' }[c] || c)

// Section header — simple, no gimmicks
const SectionTitle: React.FC<{ children: React.ReactNode; count?: number; right?: React.ReactNode }> = ({ children, count, right }) => (
  <div className="flex items-center gap-2 mb-4">
    <h2 className="text-[15px] font-semibold" style={{ color: 'var(--color-text)' }}>{children}</h2>
    {count !== undefined && (
      <span className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>{count}</span>
    )}
    {right && <div className="ml-auto">{right}</div>}
  </div>
)

// Card wrapper — consistent rounded cards
const Card: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <div className={`p-5 rounded-2xl ${className}`} style={{ background: 'var(--color-bg-elevated)' }}>
    {children}
  </div>
)

export function BuddyPanel() {
  const { t } = useTranslation()
  const { companion, bones, config, setMuted, aiName, hostedMode, setHostedMode } = useBuddyStore()

  const [meditationEnabled, setMeditationEnabled] = useState(false)
  const [meditationStart, setMeditationStart] = useState('02:00')
  const [meditationNotify, setMeditationNotify] = useState(true)
  const [meditationLast, setMeditationLast] = useState<{ date: string; duration_minutes: number; summary: string; journal_path?: string } | null>(null)
  const meditationTriggering = useMeditationStore(s => s.isRunning)
  const triggerMeditationAction = useMeditationStore(s => s.triggerMeditation)
  const onMeditationComplete = useMeditationStore(s => s.onComplete)
  const [memoryStats, setMemoryStats] = useState<MemoryStats | null>(null)
  const [recentMemories, setRecentMemories] = useState<MemoryEntry[]>([])
  const [memorySearch, setMemorySearch] = useState('')
  const [searchResults, setSearchResults] = useState<MemoryEntry[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [corrections, setCorrections] = useState<CorrectionEntry[]>([])
  const [meditationSessions, setMeditationSessions] = useState<MeditationSession[]>([])
  const [expandedJournal, setExpandedJournal] = useState<string | null>(null)
  const [decisions, setDecisions] = useState<BuddyDecision[]>([])
  const [trustStats, setTrustStats] = useState<TrustStats | null>(null)
  const [personalityStats, setPersonalityStats] = useState<{ trait: string; value: number; delta: number }[]>([])
  const [personalityTimeline, setPersonalityTimeline] = useState<{ id: number; trait_name: string; delta: number; evidence: string; created_at: string }[]>([])
  const [sparklingMemories, setSparklingMemories] = useState<{ id: string; content: string; category: string; created_at: number }[]>([])
  const [identityTraits, setIdentityTraits] = useState<{ trait_type: string; content: string; confidence: number }[]>([])
  const [memFilter, setMemFilter] = useState<string>('all')
  const [episodes, setEpisodes] = useState<EpisodeEntry[]>([])

  useEffect(() => {
    getMemoryStats().then(setMemoryStats).catch(() => {})
    listRecentMemories(15).then(setRecentMemories).catch(() => {})
    listRecentEpisodes(10).then(setEpisodes).catch(() => {})
    listCorrections().then(setCorrections).catch(() => {})
    listMeditationSessions(10).then(setMeditationSessions).catch(() => {})
    listBuddyDecisions(20).then(setDecisions).catch(() => {})
    getTrustStats().then(setTrustStats).catch(() => {})
    invoke('get_meditation_config').then((cfg: any) => {
      if (cfg) { setMeditationEnabled(cfg.enabled ?? false); setMeditationStart(cfg.start_time ?? '02:00'); setMeditationNotify(cfg.notify_on_complete ?? true) }
    }).catch(() => {})
    invoke('get_latest_meditation').then((s: any) => { if (s) setMeditationLast(s) }).catch(() => {})
    invoke('get_personality_stats').then((s: any) => { if (s) setPersonalityStats(s) }).catch(() => {})
    invoke('get_personality_timeline', { limit: 30 }).then((t: any) => { if (t) setPersonalityTimeline(t) }).catch(() => {})
    invoke('list_sparkling_memories').then((m: any) => { if (m) setSparklingMemories(m) }).catch(() => {})
    invoke('get_identity_traits').then((t: any) => { if (t) setIdentityTraits(t) }).catch(() => {})

    // Auto-refresh episodes when a compact completes
    const unlistenP = listen('buddy://compact-completed', () => {
      listRecentEpisodes(10).then(setEpisodes).catch(() => {})
    })

    // Refresh meditation-produced data whenever a run (manual or scheduled) completes.
    const unsubComplete = onMeditationComplete(() => {
      invoke('get_latest_meditation').then((s: any) => { if (s) setMeditationLast(s) }).catch(() => {})
      invoke('get_personality_stats').then((s: any) => { if (s) setPersonalityStats(s) }).catch(() => {})
      invoke('get_personality_timeline', { limit: 30 }).then((t: any) => { if (t) setPersonalityTimeline(t) }).catch(() => {})
      invoke('get_identity_traits').then((t: any) => { if (t) setIdentityTraits(t) }).catch(() => {})
      listMeditationSessions(10).then(setMeditationSessions).catch(() => {})
      getMemoryStats().then(setMemoryStats).catch(() => {})
      listRecentMemories(15).then(setRecentMemories).catch(() => {})
      listRecentEpisodes(10).then(setEpisodes).catch(() => {})
      toast.success(t('settings.meditationComplete'))
    })

    return () => {
      unlistenP.then((fn: UnlistenFn) => fn()).catch(() => {})
      unsubComplete()
    }
  }, [onMeditationComplete])

  const saveMedConfig = useCallback(async (enabled = meditationEnabled, startTime = meditationStart, notifyOnComplete = meditationNotify) => {
    try { await invoke('save_meditation_config', { enabled, startTime, notifyOnComplete }) } catch {}
  }, [meditationEnabled, meditationStart, meditationNotify])

  const handleTriggerMeditation = async () => {
    try {
      await triggerMeditationAction()
      toast.success(t('settings.meditationComplete'))
      const session: any = await invoke('get_latest_meditation')
      if (session) setMeditationLast(session)
    } catch (e) {
      toast.error(String(e))
    }
  }

  const handleFeedback = async (id: string, fb: 'good' | 'bad') => {
    try { await setDecisionFeedback(id, fb); setDecisions(p => p.map(d => d.id === id ? { ...d, user_feedback: fb } : d)); getTrustStats().then(setTrustStats).catch(() => {}) }
    catch { toast.error('反馈失败') }
  }
  const handleMemorySearch = async () => {
    if (!memorySearch.trim()) { setSearchResults(null); return }
    setSearching(true)
    try { setSearchResults(await searchMemories(memorySearch.trim(), 10)) } catch { setSearchResults([]) } finally { setSearching(false) }
  }
  const handleDeleteMemory = async (id: string) => {
    try { await deleteMemory(id); setRecentMemories(p => p.filter(m => m.id !== id)); if (searchResults) setSearchResults(p => p!.filter(m => m.id !== id)); if (memoryStats) setMemoryStats({ ...memoryStats, total: memoryStats.total - 1 }); toast.success('记忆已删除') }
    catch { toast.error('删除失败') }
  }
  const muted = config?.muted ?? false
  const notHatched = !companion || !bones
  const daysSinceHatch = companion?.hatchedAt ? Math.floor((Date.now() - companion.hatchedAt) / 86400000) : 0
  const from = companion?.palette.from ?? 'var(--color-primary)'

  const pMap = useMemo(() => {
    const m: Record<string, { value: number; delta: number }> = {}
    personalityStats.forEach(p => { m[p.trait] = { value: p.value, delta: p.delta } })
    return m
  }, [personalityStats])

  const radarStats = useMemo(() => {
    if (!companion) return {} as Record<string, number>
    const out: Record<string, number> = {}
    STAT_NAMES.forEach(s => { out[s] = pMap[s.toLowerCase()]?.value ?? companion.stats[s] })
    return out
  }, [companion, pMap])

  if (notHatched) {
    return (
      <div className="flex flex-col items-center justify-center py-24">
        <div className="w-20 h-20 rounded-full mb-6 opacity-20" style={{ background: 'var(--color-bg-subtle)', animation: 'buddy-breathe 4s ease-in-out infinite' }} />
        <div className="text-[15px] font-medium mb-1" style={{ color: 'var(--color-text-secondary)' }}>小精灵尚未孵化</div>
        <div className="text-[13px]" style={{ color: 'var(--color-text-muted)' }}>在聊天页面点击光团赋予 {aiName} 一个形象</div>
      </div>
    )
  }

  return (
    <div className="space-y-5">

      {/* ═══ Hero: companion identity card ═══ */}
      <Card>
        <div className="flex items-center gap-6">
          {/* Personality-driven orb — shape morphs with the 5 personality stats */}
          <div className="shrink-0" style={{ width: ORB_SIZE, height: ORB_SIZE, animation: 'buddy-breathe 3.5s ease-in-out infinite' }}>
            <PersonalityOrb stats={radarStats} from={companion.palette.from} to={companion.palette.to} shiny={companion.shiny} />
          </div>

          {/* Identity */}
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2 mb-1">
              <h1 className="text-[22px] font-bold tracking-tight" style={{ color: 'var(--color-text)' }}>{companion.name}</h1>
              {companion.shiny && <span>✨</span>}
              <span className="text-[12px] ml-1" style={{ color: from }}>
                {companion.palette.name} · {getSpeciesLabel(companion.species)}
              </span>
            </div>
            <p className="text-[13px] mb-4 leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
              {companion.personality}
            </p>
            {identityTraits.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {identityTraits.slice(0, 6).map((trait, i) => (
                  <span key={i} className="text-[11px] px-2 py-0.5 rounded-full" style={{
                    background: `${from}12`,
                    color: 'var(--color-text-secondary)',
                  }}>
                    {trait.content}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Meta */}
          <div className="shrink-0 flex gap-6 pl-6" style={{ borderLeft: '1px solid var(--color-bg-subtle)' }}>
            <div className="text-center">
              <div className="text-[22px] font-semibold tabular-nums" style={{ color: 'var(--color-text)' }}>{daysSinceHatch}</div>
              <div className="text-[11px] mt-1" style={{ color: 'var(--color-text-muted)' }}>天</div>
            </div>
            <div className="text-center">
              <div className="text-[22px] font-semibold tabular-nums" style={{ color: 'var(--color-text)' }}>{config?.interaction_count ?? 0}</div>
              <div className="text-[11px] mt-1" style={{ color: 'var(--color-text-muted)' }}>对话</div>
            </div>
            {trustStats && trustStats.total > 0 && (
              <div className="text-center">
                <div className="text-[22px] font-semibold tabular-nums" style={{ color: 'var(--color-text)' }}>{Math.round(trustStats.accuracy * 100)}<span className="text-[14px]">%</span></div>
                <div className="text-[11px] mt-1" style={{ color: 'var(--color-text-muted)' }}>信任</div>
              </div>
            )}
          </div>

          {/* Controls */}
          <div className="shrink-0 flex gap-1">
            <button onClick={() => useBuddyStore.getState().setMuted(!muted)}
              className="p-2 rounded-lg transition-colors hover:bg-[var(--color-bg-subtle)]" title={muted ? '唤醒' : '休眠'}>
              {muted ? <EyeOff size={15} style={{ color: 'var(--color-text-muted)' }} /> : <Eye size={15} style={{ color: 'var(--color-text-secondary)' }} />}
            </button>
            <button onClick={() => { const v = !hostedMode; setHostedMode(v); toggleBuddyHosted(v) }}
              className="p-2 rounded-lg transition-colors hover:bg-[var(--color-bg-subtle)]" title="托管模式">
              <Shield size={15} style={{ color: hostedMode ? from : 'var(--color-text-muted)' }} />
            </button>
          </div>
        </div>

        {/* Stats bar */}
        <div className="mt-5 pt-5 grid grid-cols-5 gap-4" style={{ borderTop: '1px solid var(--color-bg-subtle)' }}>
          {STAT_NAMES.map(stat => {
            const key = stat.toLowerCase()
            const val = pMap[key]?.value ?? companion.stats[stat]
            const delta = pMap[key]?.delta ?? 0
            return (
              <div key={stat}>
                <div className="flex items-baseline justify-between mb-1.5">
                  <span className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>{STAT_LABELS[stat]}</span>
                  <span className="text-[13px] font-semibold tabular-nums" style={{
                    color: delta > 2 ? 'var(--color-success)' : delta < -2 ? 'var(--color-error)' : 'var(--color-text)',
                  }}>{val}</span>
                </div>
                <div className="h-1 rounded-full overflow-hidden" style={{ background: 'var(--color-bg-subtle)' }}>
                  <div className="h-full rounded-full transition-all duration-700" style={{
                    width: `${val}%`,
                    background: `linear-gradient(90deg, ${from}, ${companion.palette.to})`,
                  }} />
                </div>
              </div>
            )
          })}
        </div>
      </Card>

      {/* ═══ Two columns ═══ */}
      <div className="grid gap-5" style={{ gridTemplateColumns: '1fr 340px' }}>

        {/* ── LEFT: Growth + Memory ── */}
        <div className="space-y-5">

          {/* Growth */}
          <Card>
            <SectionTitle count={personalityTimeline.length || undefined}>成长轨迹</SectionTitle>
            {personalityTimeline.length > 0 ? (
              <div className="relative pl-5 max-h-[400px] overflow-y-auto" style={{ borderLeft: `2px solid ${from}25` }}>
                {personalityTimeline.slice(0, 20).map((sig, i) => {
                  const isPos = sig.delta > 0
                  return (
                    <div key={sig.id} className="relative pb-4 last:pb-0">
                      <div className="absolute -left-[calc(1.25rem+4px)] top-1.5 w-2 h-2 rounded-full" style={{
                        background: isPos ? from : 'var(--color-error)',
                      }} />
                      <div className="flex items-baseline gap-2 mb-0.5">
                        <span className="text-[13px] font-medium" style={{ color: isPos ? from : 'var(--color-error)' }}>
                          {STAT_LABELS[sig.trait_name.toUpperCase() as StatName] || sig.trait_name} {isPos ? '+' : ''}{sig.delta.toFixed(1)}
                        </span>
                        <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                          {new Date(sig.created_at).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}
                        </span>
                      </div>
                      <div className="text-[12px] leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>{sig.evidence}</div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="text-[13px] py-2 leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>
                每一次对话都在塑造 {companion.name} 的性格。冥想时，这些细微的变化会被记录下来。
              </div>
            )}
          </Card>

          {/* Memory */}
          <Card>
            <SectionTitle
              count={memoryStats?.total}
              right={
                <button
                  onClick={() => {
                    sessionStorage.setItem('settings_pending_tab', 'memory')
                    window.dispatchEvent(new CustomEvent('navigate', { detail: 'settings' }))
                  }}
                  className="flex items-center gap-1 text-[11px] transition-colors hover:text-[var(--color-text-secondary)] group"
                  style={{ color: 'var(--color-text-muted)' }}
                  title="记忆引擎设置"
                >
                  <span>引擎设置</span>
                  <ChevronRight size={11} className="transition-transform group-hover:translate-x-0.5" />
                </button>
              }
            >
              记忆
            </SectionTitle>

            {(!memoryStats || memoryStats.total === 0) ? (
              <div className="py-4">
                <div className="text-[13px] mb-4 leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
                  {companion.name} 还没有记忆。和她对话后，她会自动提取重要的事实、偏好、经验、决策。
                </div>
                <div className="grid grid-cols-2 gap-2 text-[12px]">
                  {[
                    { cat: '事实', desc: '你告诉她的信息' },
                    { cat: '偏好', desc: '你喜欢什么' },
                    { cat: '经验', desc: '一起经历的事' },
                    { cat: '决策', desc: '你做过的选择' },
                    { cat: '原则', desc: '她学到的规矩' },
                  ].map(item => (
                    <div key={item.cat} className="flex items-center gap-2">
                      <span className="font-medium" style={{ color: from }}>{item.cat}</span>
                      <span style={{ color: 'var(--color-text-muted)' }}>{item.desc}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <>
                {/* Search */}
                <div className="flex gap-2 mb-3">
                  <div className="flex-1 relative">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--color-text-muted)' }} />
                    <input type="text" value={memorySearch} onChange={e => setMemorySearch(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleMemorySearch() }} placeholder="搜索记忆..."
                      className="w-full pl-9 pr-3 py-2 rounded-lg text-[13px] focus:outline-none"
                      style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text)', border: 'none' }} />
                  </div>
                  {memorySearch && (
                    <button onClick={handleMemorySearch} disabled={searching}
                      className="px-3 py-2 rounded-lg text-[12px] font-medium"
                      style={{ background: from, color: '#fff' }}>
                      {searching ? <Loader2 size={13} className="animate-spin" /> : '搜索'}
                    </button>
                  )}
                </div>

                {/* Category filter */}
                {!searchResults && (
                  <div className="flex flex-wrap gap-1.5 mb-4">
                    <button onClick={() => setMemFilter('all')}
                      className="px-2.5 py-1 rounded-md text-[12px] transition-colors"
                      style={{
                        background: memFilter === 'all' ? from : 'var(--color-bg-subtle)',
                        color: memFilter === 'all' ? '#fff' : 'var(--color-text-secondary)',
                      }}>
                      全部 <span className="tabular-nums ml-0.5 opacity-80">{memoryStats.total}</span>
                    </button>
                    {Object.entries(memoryStats.by_category).map(([cat, count]) => (
                      <button key={cat} onClick={() => setMemFilter(cat)}
                        className="px-2.5 py-1 rounded-md text-[12px] transition-colors"
                        style={{
                          background: memFilter === cat ? from : 'var(--color-bg-subtle)',
                          color: memFilter === cat ? '#fff' : 'var(--color-text-secondary)',
                        }}>
                        {catLabel(cat)} <span className="tabular-nums ml-0.5 opacity-80">{count as number}</span>
                      </button>
                    ))}
                  </div>
                )}

                {/* Sparkling memories */}
                {sparklingMemories.length > 0 && !searchResults && memFilter === 'all' && (
                  <div className="mb-4 p-3 rounded-lg" style={{ background: 'color-mix(in srgb, #FBBF24 6%, transparent)' }}>
                    <div className="flex items-center gap-1.5 mb-2">
                      <Sparkles size={12} style={{ color: '#FBBF24' }} />
                      <span className="text-[12px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>闪光记忆</span>
                    </div>
                    <div className="space-y-1.5">
                      {sparklingMemories.map(m => (
                        <div key={m.id} className="group flex items-start gap-2">
                          <Star size={11} className="mt-0.5 shrink-0" style={{ color: '#FBBF24', fill: '#FBBF24' }} />
                          <span className="text-[12px] flex-1 leading-relaxed" style={{ color: 'var(--color-text)' }}>{m.content}</span>
                          <button className="opacity-0 group-hover:opacity-100 p-0.5 shrink-0 transition-opacity"
                            onClick={async () => {
                              await invoke('toggle_sparkling_memory', { memoryId: m.id, sparkling: false })
                              setSparklingMemories(p => p.filter(s => s.id !== m.id))
                            }}>
                            <Sparkles size={11} style={{ color: 'var(--color-text-muted)' }} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Memory list */}
                <div className="space-y-1 max-h-[400px] overflow-y-auto">
                  {(() => {
                    const source = searchResults ?? recentMemories
                    const filtered = !searchResults && memFilter !== 'all'
                      ? source.filter(m => (m.categories[0] || 'note') === memFilter)
                      : source
                    if (filtered.length === 0) {
                      return (
                        <div className="py-6 text-center text-[13px]" style={{ color: 'var(--color-text-muted)' }}>
                          {searchResults ? '没有匹配的记忆' : `暂无${catLabel(memFilter)}记忆`}
                        </div>
                      )
                    }
                    return filtered.map(m => (
                      <div key={m.id} className="group flex gap-3 py-2.5 px-3 -mx-3 rounded-lg hover:bg-[var(--color-bg-subtle)] transition-colors">
                        <div className="shrink-0 w-[3px] rounded-full self-stretch" style={{
                          background: m.importance >= 0.7 ? from : 'var(--color-bg-muted)',
                          opacity: 0.3 + m.importance * 0.7,
                        }} />
                        <div className="flex-1 min-w-0">
                          <div className="text-[12px] leading-relaxed" style={{ color: 'var(--color-text)' }}>
                            {m.content.length > 200 ? m.content.slice(0, 200) + '...' : m.content}
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-muted)' }}>
                              {catLabel(m.categories[0] || 'note')}
                            </span>
                            <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>{m.created_at.slice(0, 10)}</span>
                          </div>
                        </div>
                        <div className="flex gap-0.5 shrink-0 self-start opacity-0 group-hover:opacity-100 transition-opacity">
                          <button onClick={async () => {
                            await invoke('toggle_sparkling_memory', { memoryId: m.id, sparkling: true })
                            invoke('list_sparkling_memories').then((ms: any) => setSparklingMemories(ms)).catch(() => {}); toast.success('已标记为闪光记忆 ✨')
                          }} className="p-1 rounded"><Sparkles size={12} style={{ color: '#FBBF24' }} /></button>
                          <button onClick={() => handleDeleteMemory(m.id)} className="p-1 rounded"><Trash2 size={12} style={{ color: 'var(--color-error)' }} /></button>
                        </div>
                      </div>
                    ))
                  })()}
                </div>
                {searchResults && (
                  <button onClick={() => { setSearchResults(null); setMemorySearch('') }}
                    className="mt-2 text-[12px]" style={{ color: from }}>清除搜索</button>
                )}
              </>
            )}
          </Card>

          {/* ── Episodes (Compact summaries) ── */}
          {episodes.length > 0 && (
            <Card>
              <SectionTitle count={episodes.length}>最近对话摘要</SectionTitle>
              <div className="space-y-2 max-h-[320px] overflow-y-auto">
                {episodes.map(ep => (
                  <div key={ep.episode_id} className="p-3 rounded-lg" style={{ background: 'var(--color-bg-subtle)' }}>
                    <div className="flex items-center justify-between mb-1">
                      <div className="text-[13px] font-medium truncate" style={{ color: 'var(--color-text)' }}>{ep.title || '(无标题)'}</div>
                      <div className="text-[11px] shrink-0 ml-2" style={{ color: 'var(--color-text-muted)' }}>
                        {ep.started_at ? new Date(ep.started_at).toLocaleDateString('zh-CN') : ''}
                      </div>
                    </div>
                    {ep.summary && (
                      <div className="text-[12px] leading-relaxed line-clamp-3" style={{ color: 'var(--color-text-secondary)' }}>
                        {ep.summary}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>

        {/* ── RIGHT: Meditation + System ── */}
        <div className="space-y-5">

          {/* Meditation */}
          <Card className="relative overflow-hidden">
            {meditationTriggering && (
              <div className="absolute inset-0 pointer-events-none" style={{
                background: `radial-gradient(circle at 50% 30%, ${from}18, transparent 70%)`,
                animation: 'buddy-breathe 2s ease-in-out infinite',
              }} />
            )}
            <div className="relative">
              <SectionTitle right={
                <button onClick={handleTriggerMeditation} disabled={meditationTriggering}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all hover:scale-[1.02] active:scale-[0.98]"
                  style={{ background: meditationTriggering ? `${from}20` : from, color: meditationTriggering ? from : '#fff' }}>
                  {meditationTriggering ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                  {meditationTriggering ? '冥想中...' : '开始冥想'}
                </button>
              }>冥想</SectionTitle>

              {(meditationLast && meditationLast.summary) ? (
                <div className="mb-4 p-3 rounded-lg" style={{ background: 'var(--color-bg-subtle)' }}>
                  {meditationLast.date && (
                    <div className="text-[11px] mb-1" style={{ color: 'var(--color-text-muted)' }}>{meditationLast.date}</div>
                  )}
                  <div className="text-[12px] leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>{meditationLast.summary}</div>
                </div>
              ) : (
                <div className="mb-4 text-[13px] leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>
                  让 {companion.name} 回顾对话，提炼记忆，感受性格的变化。
                </div>
              )}

              <div className="space-y-2 text-[12px]">
                <div className="flex items-center justify-between">
                  <span style={{ color: 'var(--color-text-secondary)' }}>定时冥想</span>
                  <button onClick={() => { const v = !meditationEnabled; setMeditationEnabled(v); saveMedConfig(v) }}
                    className="text-[11px] px-2.5 py-1 rounded-md font-medium" style={{
                      background: meditationEnabled ? `${from}18` : 'var(--color-bg-subtle)',
                      color: meditationEnabled ? from : 'var(--color-text-muted)',
                    }}>{meditationEnabled ? '开启' : '关闭'}</button>
                </div>
                {meditationEnabled && (
                  <div className="flex items-center justify-between">
                    <span style={{ color: 'var(--color-text-secondary)' }}>时间</span>
                    <input type="time" value={meditationStart}
                      onChange={e => { setMeditationStart(e.target.value); saveMedConfig(meditationEnabled, e.target.value) }}
                      className="text-[11px] px-2 py-1 rounded-md" style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text)', border: 'none' }} />
                  </div>
                )}
              </div>

              {/* Diary */}
              {meditationSessions.length > 0 && (
                <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--color-bg-subtle)' }}>
                  <div className="text-[11px] font-medium mb-2" style={{ color: 'var(--color-text-muted)' }}>冥想日记</div>
                  <div className="space-y-1 max-h-[180px] overflow-y-auto">
                    {meditationSessions.slice(0, 5).map(s => (
                      <button key={s.id} onClick={() => setExpandedJournal(expandedJournal === s.id ? null : s.id)}
                        className="w-full text-left p-2 rounded-md transition-colors hover:bg-[var(--color-bg-subtle)]">
                        <div className="flex items-center justify-between text-[11px]">
                          <span style={{ color: 'var(--color-text-secondary)' }}>
                            {new Date(s.started_at > 1e12 ? s.started_at : s.started_at * 1000).toLocaleDateString('zh-CN')}
                          </span>
                          <span style={{ color: 'var(--color-text-muted)' }}>记忆 +{s.memories_updated}</span>
                        </div>
                        {expandedJournal === s.id && s.journal && (
                          <div className="mt-2 text-[11px] leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--color-text-muted)' }}>
                            {s.journal}
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </Card>

          {/* Growth report */}
          {meditationSessions.length > 0 && meditationSessions[0]?.growth_synthesis && (
            <Card className="relative overflow-hidden">
              <div className="absolute top-0 left-0 bottom-0 w-[3px]" style={{ background: from }} />
              <SectionTitle>最新报告</SectionTitle>
              <div className="text-[12px] leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
                {meditationSessions[0].growth_synthesis}
              </div>
            </Card>
          )}

          {/* Corrections */}
          {corrections.length > 0 && (
            <Card>
              <SectionTitle count={corrections.length}>学到的规矩</SectionTitle>
              <div className="space-y-2 max-h-[160px] overflow-y-auto">
                {corrections.map((c, i) => (
                  <div key={i} className="p-2 rounded-md text-[11px]" style={{ background: 'var(--color-bg-subtle)' }}>
                    <div style={{ color: 'var(--color-text-muted)' }}>当 {c.trigger}</div>
                    <div className="mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>→ {c.correct_behavior}</div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Decisions */}
          {decisions.length > 0 && trustStats && trustStats.total > 0 && (
            <Card>
              <SectionTitle right={<span className="text-[12px] font-medium" style={{ color: from }}>{Math.round(trustStats.accuracy * 100)}%</span>}>
                决策
              </SectionTitle>
              <div className="space-y-1 max-h-[140px] overflow-y-auto">
                {decisions.slice(0, 6).map(d => (
                  <div key={d.id} className="group flex items-center gap-2 py-1 text-[11px]">
                    <span className="flex-1 truncate" style={{ color: 'var(--color-text-secondary)' }}>{d.question}</span>
                    <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => handleFeedback(d.id, 'good')} className="p-0.5 rounded">
                        <ThumbsUp size={11} style={{ color: d.user_feedback === 'good' ? 'var(--color-success)' : 'var(--color-text-muted)' }} />
                      </button>
                      <button onClick={() => handleFeedback(d.id, 'bad')} className="p-0.5 rounded">
                        <ThumbsDown size={11} style={{ color: d.user_feedback === 'bad' ? 'var(--color-error)' : 'var(--color-text-muted)' }} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}

        </div>
      </div>
    </div>
  )
}
