/**
 * BuddyPanel — Settings tab for the companion sprite (小精灵).
 * Consolidates: profile display, behavior toggles, meditation, and memory engine config.
 */

import { useState, useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  Brain,
  Play,
  FileText,
  Loader2,
  Eye,
  EyeOff,
  Search,
  Trash2,
  BookOpen,
  ShieldCheck,
  Notebook,
  ChevronDown,
  ThumbsUp,
  ThumbsDown,
  Shield,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useBuddyStore } from '../stores/buddyStore'
import {
  toggleBuddyHosted,
  getMemoryStats, listRecentMemories, searchMemories, deleteMemory,
  listCorrections, listMeditationSessions,
  listBuddyDecisions, setDecisionFeedback, getTrustStats,
  type MemoryEntry, type MemoryStats, type CorrectionEntry, type MeditationSession,
  type BuddyDecision, type TrustStats,
} from '../api/buddy'
import { getMemmeConfig, saveMemmeConfig, type MemmeConfig } from '../api/system'
import { useMeditationStore } from '../stores/meditationStore'
import { OrbCore } from './buddy/OrbCore'
import { getSpeciesLabel, getSpeciesConfig, STAT_LABELS, STAT_NAMES } from '../utils/buddy'
import { toast } from './Toast'

// ── Toggle helper ──
const Toggle: React.FC<{ value: boolean; onChange: (v: boolean) => void }> = ({ value, onChange }) => (
  <button
    onClick={() => onChange(!value)}
    className="relative w-9 h-5 rounded-full transition-colors shrink-0"
    style={{ background: value ? 'var(--color-success)' : 'var(--color-bg-muted)' }}
  >
    <div
      className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform"
      style={{ transform: value ? 'translateX(18px)' : 'translateX(2px)' }}
    />
  </button>
)

export function BuddyPanel() {
  const { t } = useTranslation()
  const { companion, bones, config, setMuted, aiName, hostedMode, setHostedMode } = useBuddyStore()
  const triggerMeditationAction = useMeditationStore((s) => s.triggerMeditation)

  // Meditation state
  const [meditationEnabled, setMeditationEnabled] = useState(false)
  const [meditationStart, setMeditationStart] = useState('02:00')
  const [meditationNotify, setMeditationNotify] = useState(true)
  const [meditationLast, setMeditationLast] = useState<{
    date: string; duration_minutes: number; summary: string; journal_path?: string
  } | null>(null)
  const [meditationTriggering, setMeditationTriggering] = useState(false)

  // MemMe config
  const [memmeConfig, setMemmeConfigState] = useState<MemmeConfig | null>(null)

  // Memory browsing
  const [memoryStats, setMemoryStats] = useState<MemoryStats | null>(null)
  const [recentMemories, setRecentMemories] = useState<MemoryEntry[]>([])
  const [memorySearch, setMemorySearch] = useState('')
  const [searchResults, setSearchResults] = useState<MemoryEntry[] | null>(null)
  const [searching, setSearching] = useState(false)

  // Corrections
  const [corrections, setCorrections] = useState<CorrectionEntry[]>([])

  // Meditation diary
  const [meditationSessions, setMeditationSessions] = useState<MeditationSession[]>([])
  const [expandedJournal, setExpandedJournal] = useState<string | null>(null)

  // Decision log & trust
  const [decisions, setDecisions] = useState<BuddyDecision[]>([])
  const [trustStats, setTrustStats] = useState<TrustStats | null>(null)

  // ── Load on mount ──
  useEffect(() => {
    getMemoryStats().then(setMemoryStats).catch(() => {})
    listRecentMemories(15).then(setRecentMemories).catch(() => {})
    listCorrections().then(setCorrections).catch(() => {})
    listMeditationSessions(10).then(setMeditationSessions).catch(() => {})
    listBuddyDecisions(20).then(setDecisions).catch(() => {})
    getTrustStats().then(setTrustStats).catch(() => {})

    invoke('get_meditation_config').then((cfg: any) => {
      if (cfg) {
        setMeditationEnabled(cfg.enabled ?? false)
        setMeditationStart(cfg.start_time ?? '02:00')
        setMeditationNotify(cfg.notify_on_complete ?? true)
      }
    }).catch(() => {})

    invoke('get_latest_meditation').then((s: any) => {
      if (s) setMeditationLast(s)
    }).catch(() => {})

    getMemmeConfig().then(c => { if (c) setMemmeConfigState(c) }).catch(() => {})
  }, [])

  // ── Meditation helpers ──
  const saveMedConfig = useCallback(async (
    enabled = meditationEnabled, startTime = meditationStart, notifyOnComplete = meditationNotify,
  ) => {
    try { await invoke('save_meditation_config', { enabled, startTime, notifyOnComplete }) }
    catch (e) { console.error('Failed to save meditation config:', e) }
  }, [meditationEnabled, meditationStart, meditationNotify])

  const handleTriggerMeditation = async () => {
    setMeditationTriggering(true)
    try {
      await triggerMeditationAction()
      toast.success(t('settings.meditationComplete'))
      const session: any = await invoke('get_latest_meditation')
      if (session) setMeditationLast(session)
    } catch (e) {
      toast.error(String(e))
    } finally {
      setMeditationTriggering(false)
    }
  }

  // ── Decision feedback ──
  const handleFeedback = async (id: string, feedback: 'good' | 'bad') => {
    try {
      await setDecisionFeedback(id, feedback)
      setDecisions(prev => prev.map(d => d.id === id ? { ...d, user_feedback: feedback } : d))
      getTrustStats().then(setTrustStats).catch(() => {})
    } catch { toast.error('反馈失败') }
  }

  // ── Memory search ──
  const handleMemorySearch = async () => {
    if (!memorySearch.trim()) { setSearchResults(null); return }
    setSearching(true)
    try {
      const results = await searchMemories(memorySearch.trim(), 10)
      setSearchResults(results)
    } catch { setSearchResults([]) }
    finally { setSearching(false) }
  }

  const handleDeleteMemory = async (id: string) => {
    try {
      await deleteMemory(id)
      setRecentMemories(prev => prev.filter(m => m.id !== id))
      if (searchResults) setSearchResults(prev => prev!.filter(m => m.id !== id))
      if (memoryStats) setMemoryStats({ ...memoryStats, total: memoryStats.total - 1 })
      toast.success('记忆已删除')
    } catch { toast.error('删除失败') }
  }

  // ── MemMe helpers ──
  const saveMemmeConfigFull = async (cfg: MemmeConfig | null) => {
    if (!cfg) return
    try { await saveMemmeConfig(cfg) }
    catch (e) { console.error('Failed to save MemMe config:', e) }
  }

  const muted = config?.muted ?? false
  const notHatched = !companion || !bones

  return (
    <div className="space-y-4">
      {/* ── Section 1: Profile ── */}
      <div className="p-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
        {notHatched ? (
          <div className="text-center py-6">
            <div className="text-[13px] text-[var(--color-text-muted)] mb-1">小精灵尚未孵化</div>
            <div className="text-[12px] text-[var(--color-text-muted)]">在聊天页面点击光团即可赋予 {aiName} 一个形象</div>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-4 mb-4">
              {/* Orb */}
              <div className="shrink-0" style={{ animation: 'buddy-breathe 3s ease-in-out infinite' }}>
                <OrbCore
                  from={companion.palette.from}
                  to={companion.palette.to}
                  css={getSpeciesConfig(companion.species).css}
                  glow={getSpeciesConfig(companion.species).glowSpread}
                  size={48}
                  shiny={companion.shiny}
                />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-[15px]" style={{ color: 'var(--color-text)' }}>
                    {companion.name}
                  </span>
                  {companion.shiny && <span className="text-xs">✨</span>}
                </div>
                <div className="text-[12px]" style={{ color: companion.palette.from }}>
                  {companion.palette.name} · {getSpeciesLabel(companion.species)}
                </div>
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                  {companion.personality}
                </div>
              </div>
            </div>

            {/* Stats */}
            <div className="space-y-1.5">
              {STAT_NAMES.map(stat => (
                <div key={stat} className="flex items-center gap-2">
                  <span className="text-[12px] w-10 shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                    {STAT_LABELS[stat]}
                  </span>
                  <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--color-border)' }}>
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${companion.stats[stat]}%`,
                        background: `linear-gradient(90deg, ${companion.palette.from}, ${companion.palette.to})`,
                      }}
                    />
                  </div>
                  <span className="text-[11px] w-6 text-right tabular-nums" style={{ color: 'var(--color-text-muted)' }}>
                    {companion.stats[stat]}
                  </span>
                </div>
              ))}
            </div>

            {/* Interaction stats + hatch date */}
            <div className="flex items-center gap-3 mt-3 text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
              {companion.hatchedAt > 0 && (
                <span>孵化于 {new Date(companion.hatchedAt).toLocaleDateString('zh-CN')}</span>
              )}
              {config && (
                <>
                  <span>·</span>
                  <span>摸头 {config.pet_count ?? 0} 次</span>
                  <span>·</span>
                  <span>对话 {config.interaction_count} 次</span>
                  {(config.delegation_count ?? 0) > 0 && (
                    <>
                      <span>·</span>
                      <span>决策 {config.delegation_count} 次</span>
                    </>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>

      {/* ── Section 1.5: Trust & Decision Log ── */}
      {(trustStats && trustStats.total > 0) && (
        <div className="p-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
          <div className="flex items-center gap-2 mb-3">
            <Shield size={18} className="text-[var(--color-primary)]" />
            <h2 className="font-semibold text-[14px]">信任与决策</h2>
          </div>

          {/* Trust gauge */}
          <div className="flex items-center gap-4 mb-4 p-3 rounded-xl" style={{ background: 'var(--color-bg-subtle)' }}>
            <div className="flex-1">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[12px] font-medium" style={{ color: 'var(--color-text)' }}>
                  信任度 {Math.round(trustStats.accuracy * 100)}%
                </span>
                <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                  Ring {trustStats.accuracy >= 0.7 ? '0' : trustStats.accuracy >= 0.5 ? '1' : trustStats.accuracy >= 0.3 ? '2' : '3'}
                </span>
              </div>
              <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--color-border)' }}>
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${trustStats.accuracy * 100}%`,
                    background: trustStats.accuracy >= 0.7 ? '#34D399'
                      : trustStats.accuracy >= 0.5 ? '#60A5FA'
                      : trustStats.accuracy >= 0.3 ? '#FBBF24'
                      : 'var(--color-text-muted)',
                  }}
                />
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-[18px] font-bold tabular-nums" style={{ color: 'var(--color-text)' }}>
                {trustStats.good}/{trustStats.total}
              </div>
              <div className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
                准确 / 总计
              </div>
            </div>
          </div>

          {/* Per-domain trust */}
          {Object.keys(trustStats.by_context).length > 0 && (
            <div className="flex flex-wrap gap-2 mb-3">
              {Object.entries(trustStats.by_context).map(([ctx, ct]) => (
                <div key={ctx} className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px]" style={{ background: 'var(--color-bg-subtle)' }}>
                  <span style={{ color: 'var(--color-text-muted)' }}>
                    {ctx === 'task_decision' ? '任务决策' : ctx === 'skill_review' ? '技能审核' : ctx === 'permission' ? '权限审批' : ctx}
                  </span>
                  <span className="font-medium" style={{ color: ct.accuracy >= 0.7 ? '#34D399' : ct.accuracy >= 0.5 ? '#60A5FA' : '#FBBF24' }}>
                    {Math.round(ct.accuracy * 100)}%
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Recent decisions */}
          {decisions.length > 0 && (
            <div className="space-y-2 max-h-[300px] overflow-y-auto">
              <div className="text-[12px] font-medium mb-1" style={{ color: 'var(--color-text-muted)' }}>最近决策</div>
              {decisions.slice(0, 10).map(d => {
                const fb = d.user_feedback
                const isGood = fb === 'good'
                const isBad = fb === 'bad'
                const conf = Math.round(d.buddy_confidence * 100)
                const ctx = d.context === 'task_decision' ? '任务' : d.context === 'skill_review' ? '技能' : d.context === 'permission' ? '权限' : d.context

                return (
                  <div
                    key={d.id}
                    className="group rounded-xl overflow-hidden transition-all"
                    style={{
                      background: 'var(--color-bg-subtle)',
                      border: fb ? `1px solid ${isGood ? 'rgba(52,211,153,0.2)' : 'rgba(239,68,68,0.2)'}` : '1px solid transparent',
                    }}
                  >
                    {/* Question + context badge */}
                    <div className="px-3 pt-2.5 pb-1">
                      <div className="flex items-start gap-2">
                        <span className="shrink-0 mt-0.5 text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                          style={{ background: 'var(--color-bg-muted)', color: 'var(--color-text-muted)' }}>
                          {ctx}
                        </span>
                        <div className="text-[12px] leading-relaxed min-w-0" style={{ color: 'var(--color-text)' }}>
                          {d.question.length > 100 ? d.question.slice(0, 100) + '...' : d.question}
                        </div>
                      </div>
                    </div>

                    {/* Answer + confidence */}
                    <div className="px-3 pb-1.5">
                      <div className="text-[11px] pl-[calc(theme(spacing.2)+2.5rem)]" style={{ color: 'var(--color-text-muted)' }}>
                        {d.buddy_answer.length > 80 ? d.buddy_answer.slice(0, 80) + '...' : d.buddy_answer}
                      </div>
                    </div>

                    {/* Footer: confidence bar + feedback */}
                    <div className="flex items-center justify-between px-3 pb-2.5">
                      {/* Confidence indicator */}
                      <div className="flex items-center gap-1.5">
                        <div className="w-16 h-1 rounded-full overflow-hidden" style={{ background: 'var(--color-border)' }}>
                          <div className="h-full rounded-full" style={{
                            width: `${conf}%`,
                            background: conf >= 70 ? '#34D399' : conf >= 50 ? '#60A5FA' : '#FBBF24',
                          }} />
                        </div>
                        <span className="text-[10px] tabular-nums" style={{ color: 'var(--color-text-muted)' }}>
                          {conf}%
                        </span>
                      </div>

                      {/* Feedback buttons / result */}
                      {fb ? (
                        <div
                          className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium"
                          style={{
                            background: isGood ? 'rgba(52,211,153,0.08)' : 'rgba(239,68,68,0.08)',
                            color: isGood ? '#34D399' : '#EF4444',
                          }}
                        >
                          {isGood ? <ThumbsUp size={11} /> : <ThumbsDown size={11} />}
                          {isGood ? '准确' : '偏差'}
                        </div>
                      ) : (
                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => handleFeedback(d.id, 'good')}
                            className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium transition-all hover:scale-105 active:scale-95"
                            style={{ background: 'rgba(52,211,153,0.08)', color: '#34D399' }}
                          >
                            <ThumbsUp size={11} />
                            准确
                          </button>
                          <button
                            onClick={() => handleFeedback(d.id, 'bad')}
                            className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium transition-all hover:scale-105 active:scale-95"
                            style={{ background: 'rgba(239,68,68,0.08)', color: '#EF4444' }}
                          >
                            <ThumbsDown size={11} />
                            偏差
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Section 2: Behavior ── */}
      <div className="p-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
        <h2 className="font-semibold text-[14px] mb-3">行为设置</h2>
        <div className="space-y-1">
          {/* Hosted mode */}
          <div className="flex items-center justify-between p-3 rounded-xl hover:bg-[var(--color-bg-subtle)] transition-colors">
            <div>
              <div className="text-[13px] font-medium">托管模式</div>
              <div className="text-[12px] text-[var(--color-text-muted)]">让小精灵代替你做非关键决策</div>
            </div>
            <Toggle
              value={hostedMode}
              onChange={async (next) => {
                try { await toggleBuddyHosted(next); setHostedMode(next) }
                catch { toast.error('切换失败') }
              }}
            />
          </div>
          {/* Muted */}
          <div className="flex items-center justify-between p-3 rounded-xl hover:bg-[var(--color-bg-subtle)] transition-colors">
            <div>
              <div className="text-[13px] font-medium">休眠模式</div>
              <div className="text-[12px] text-[var(--color-text-muted)]">关闭动画和气泡反应，降低干扰</div>
            </div>
            <button
              onClick={() => setMuted(!muted)}
              className="p-1.5 rounded-lg transition-colors hover:bg-[var(--color-bg-subtle)]"
            >
              {muted
                ? <EyeOff size={16} style={{ color: 'var(--color-text-muted)' }} />
                : <Eye size={16} style={{ color: 'var(--color-primary)' }} />
              }
            </button>
          </div>
        </div>
      </div>

      {/* ── Section 3: Meditation ── */}
      <div className="p-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
        <div className="flex items-center gap-2 mb-1">
          <Brain size={18} className="text-[var(--color-primary)]" />
          <h2 className="font-semibold text-[14px]">{t('settings.meditation')}</h2>
        </div>
        <p className="text-[12px] text-[var(--color-text-muted)] mb-4 ml-[26px]">
          {t('settings.meditationDesc')}
        </p>

        <div className="space-y-3">
          {/* Enable */}
          <div className="flex items-center justify-between p-3 rounded-xl hover:bg-[var(--color-bg-subtle)] transition-colors">
            <div className="text-[13px] font-medium">{t('settings.meditationEnabled')}</div>
            <Toggle
              value={meditationEnabled}
              onChange={(next) => {
                setMeditationEnabled(next)
                saveMedConfig(next, meditationStart, meditationNotify)
              }}
            />
          </div>

          {meditationEnabled && (
            <>
              {/* Start time */}
              <div className="flex items-center justify-between p-3 rounded-xl hover:bg-[var(--color-bg-subtle)] transition-colors">
                <div className="text-[13px] font-medium">{t('settings.meditationStartTime')}</div>
                <input
                  type="time"
                  value={meditationStart}
                  onChange={(e) => setMeditationStart(e.target.value)}
                  onBlur={() => saveMedConfig()}
                  className="px-3 py-1.5 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50"
                  style={{ background: 'var(--color-bg)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
                />
              </div>
              {/* Notify */}
              <div className="flex items-center justify-between p-3 rounded-xl hover:bg-[var(--color-bg-subtle)] transition-colors">
                <div className="text-[13px] font-medium">{t('settings.meditationNotify')}</div>
                <Toggle
                  value={meditationNotify}
                  onChange={(next) => {
                    setMeditationNotify(next)
                    saveMedConfig(meditationEnabled, meditationStart, next)
                  }}
                />
              </div>
            </>
          )}

          {/* Last session */}
          <div className="p-3 rounded-xl" style={{ background: 'var(--color-bg-subtle)' }}>
            <div className="text-[12px] font-medium mb-2" style={{ color: 'var(--color-text-muted)' }}>
              {t('settings.meditationLastSession')}
            </div>
            {meditationLast ? (
              <div className="space-y-1">
                <div className="text-[13px]" style={{ color: 'var(--color-text)' }}>
                  {meditationLast.date} &middot; {meditationLast.duration_minutes} min
                </div>
                <div className="text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>
                  {meditationLast.summary}
                </div>
                {meditationLast.journal_path && (
                  <button
                    className="flex items-center gap-1 mt-1 text-[12px] font-medium transition-colors"
                    style={{ color: 'var(--color-primary)' }}
                    onClick={() => invoke('open_path', { path: meditationLast.journal_path }).catch(() => {})}
                  >
                    <FileText size={12} />
                    {t('settings.meditationJournal')}
                  </button>
                )}
              </div>
            ) : (
              <div className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
                {t('settings.meditationNoSession')}
              </div>
            )}
          </div>

          {/* Trigger */}
          <button
            onClick={handleTriggerMeditation}
            disabled={meditationTriggering}
            className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-xl text-[13px] font-medium transition-colors disabled:opacity-50"
            style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-primary)' }}
            onMouseEnter={(e) => { if (!meditationTriggering) e.currentTarget.style.background = 'var(--color-bg-muted)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)' }}
          >
            {meditationTriggering
              ? <Loader2 size={14} className="animate-spin" />
              : <Play size={14} />
            }
            {meditationTriggering ? t('settings.meditationRunning') : t('settings.meditationTrigger')}
          </button>
        </div>
      </div>

      {/* ── Section 3.5: Meditation Diary ── */}
      {meditationSessions.length > 0 && (
        <div className="p-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
          <div className="flex items-center gap-2 mb-1">
            <Notebook size={18} className="text-[var(--color-primary)]" />
            <h2 className="font-semibold text-[14px]">冥想日记</h2>
            <span className="text-[11px] px-1.5 py-0.5 rounded-full" style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-muted)' }}>
              {meditationSessions.length} 次
            </span>
          </div>
          <p className="text-[12px] text-[var(--color-text-muted)] mb-3 ml-[26px]">
            小精灵每次冥想后的反思日记
          </p>

          <div className="space-y-2 max-h-[400px] overflow-y-auto">
            {meditationSessions.map(s => {
              const date = new Date(s.started_at).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
              const time = new Date(s.started_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
              const duration = s.finished_at
                ? Math.round((s.finished_at - s.started_at) / 60000)
                : 0
              const isExpanded = expandedJournal === s.id
              const ok = s.status === 'completed'

              return (
                <div key={s.id} className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--color-border)' }}>
                  {/* Header row */}
                  <button
                    className="w-full flex items-center gap-3 p-3 text-left transition-colors hover:bg-[var(--color-bg-subtle)]"
                    onClick={() => setExpandedJournal(isExpanded ? null : s.id)}
                  >
                    <div className="shrink-0 w-2 h-2 rounded-full" style={{ background: ok ? 'var(--color-success)' : 'var(--color-error)' }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-medium" style={{ color: 'var(--color-text)' }}>{date} {time}</span>
                        {duration > 0 && (
                          <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>{duration}min</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-muted)' }}>
                          记忆 +{s.memories_updated}
                        </span>
                        {s.principles_changed > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-muted)' }}>
                            原则 +{s.principles_changed}
                          </span>
                        )}
                        {s.memories_archived > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-muted)' }}>
                            归档 {s.memories_archived}
                          </span>
                        )}
                      </div>
                    </div>
                    <ChevronDown
                      size={14}
                      className="shrink-0 transition-transform"
                      style={{
                        color: 'var(--color-text-muted)',
                        transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                      }}
                    />
                  </button>

                  {/* Expandable journal */}
                  {isExpanded && (
                    <div className="px-3 pb-3 space-y-2">
                      {s.journal && (
                        <div
                          className="text-[12px] leading-relaxed whitespace-pre-wrap p-3 rounded-lg"
                          style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-secondary)' }}
                        >
                          {s.journal}
                        </div>
                      )}
                      {s.tomorrow_intentions && (
                        <div className="text-[12px] p-2.5 rounded-lg" style={{ background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.12)' }}>
                          <div className="text-[11px] font-medium mb-1" style={{ color: 'var(--color-primary)' }}>明日意图</div>
                          <div style={{ color: 'var(--color-text-secondary)' }}>{s.tomorrow_intentions}</div>
                        </div>
                      )}
                      {s.growth_synthesis && (
                        <div className="text-[12px] p-2.5 rounded-lg" style={{ background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.12)' }}>
                          <div className="text-[11px] font-medium mb-1" style={{ color: '#34D399' }}>成长洞察</div>
                          <div style={{ color: 'var(--color-text-secondary)' }}>{s.growth_synthesis}</div>
                        </div>
                      )}
                      {!ok && s.error && (
                        <div className="text-[12px] p-2.5 rounded-lg" style={{ background: 'rgba(239,68,68,0.06)', color: 'var(--color-error)' }}>
                          {s.error}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Section 4: Memory Engine ── */}
      <div className="p-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
        <div className="mb-4">
          <h2 className="font-semibold text-[14px] mb-1">{t('settings.memoryTitle', '记忆引擎')}</h2>
          <p className="text-[12px] text-[var(--color-text-muted)]">
            {t('settings.memoryDesc', '配置 MemMe 记忆引擎的 Embedding、知识图谱和遗忘曲线参数')}
          </p>
        </div>
        <div className="space-y-3">
          {/* Embedding Provider */}
          <div className="flex items-center justify-between">
            <div className="text-[13px] font-medium">Embedding 提供商</div>
            <select
              value={memmeConfig?.embedding_provider ?? 'mock'}
              onChange={async (e) => {
                const next = { ...memmeConfig!, embedding_provider: e.target.value }
                setMemmeConfigState(next)
                await saveMemmeConfigFull(next)
              }}
              className="text-[13px] px-2.5 py-1.5 rounded-lg"
              style={{ background: 'var(--color-bg-muted)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
            >
              <option value="mock">Mock（默认，无语义搜索）</option>
              <option value="openai">OpenAI 兼容（支持 OpenAI / Ollama / 智谱 / 硅基流动等）</option>
            </select>
          </div>

          {memmeConfig?.embedding_provider === 'openai' && (
            <>
              <div className="flex items-center justify-between">
                <div className="text-[13px] font-medium">Embedding API 地址</div>
                <input
                  type="text"
                  placeholder="留空默认 https://api.openai.com/v1"
                  value={memmeConfig?.embedding_base_url ?? ''}
                  onChange={(e) => setMemmeConfigState({ ...memmeConfig!, embedding_base_url: e.target.value })}
                  onBlur={() => saveMemmeConfigFull(memmeConfig)}
                  className="text-[13px] px-2.5 py-1.5 rounded-lg w-[240px]"
                  style={{ background: 'var(--color-bg-muted)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
                />
              </div>
              <div className="flex items-center justify-between">
                <div className="text-[13px] font-medium">Embedding API Key</div>
                <input
                  type="password"
                  placeholder="留空则使用当前 LLM Provider 的 Key"
                  value={memmeConfig?.embedding_api_key ?? ''}
                  onChange={(e) => setMemmeConfigState({ ...memmeConfig!, embedding_api_key: e.target.value })}
                  onBlur={() => saveMemmeConfigFull(memmeConfig)}
                  className="text-[13px] px-2.5 py-1.5 rounded-lg w-[240px]"
                  style={{ background: 'var(--color-bg-muted)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
                />
              </div>
              <div className="flex items-center justify-between">
                <div className="text-[13px] font-medium">Embedding 模型</div>
                <input
                  type="text"
                  placeholder="text-embedding-3-small"
                  value={memmeConfig?.embedding_model ?? 'text-embedding-3-small'}
                  onChange={(e) => setMemmeConfigState({ ...memmeConfig!, embedding_model: e.target.value })}
                  onBlur={() => saveMemmeConfigFull(memmeConfig)}
                  className="text-[13px] px-2.5 py-1.5 rounded-lg w-[240px]"
                  style={{ background: 'var(--color-bg-muted)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
                />
              </div>
              <div className="flex items-center justify-between">
                <div className="text-[13px] font-medium">向量维度</div>
                <input
                  type="number"
                  value={memmeConfig?.embedding_dims ?? 1536}
                  onChange={(e) => setMemmeConfigState({ ...memmeConfig!, embedding_dims: parseInt(e.target.value) || 1536 })}
                  onBlur={() => saveMemmeConfigFull(memmeConfig)}
                  className="text-[13px] px-2.5 py-1.5 rounded-lg w-[100px]"
                  style={{ background: 'var(--color-bg-muted)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
                />
              </div>
            </>
          )}

          {/* Knowledge Graph */}
          <div className="flex items-center justify-between">
            <div className="text-[13px] font-medium">知识图谱</div>
            <Toggle
              value={memmeConfig?.enable_graph ?? false}
              onChange={async (next) => {
                const cfg = { ...memmeConfig!, enable_graph: next }
                setMemmeConfigState(cfg)
                await saveMemmeConfigFull(cfg)
              }}
            />
          </div>
          {/* Forgetting Curve */}
          <div className="flex items-center justify-between">
            <div className="text-[13px] font-medium">遗忘曲线衰减</div>
            <Toggle
              value={memmeConfig?.enable_forgetting_curve ?? false}
              onChange={async (next) => {
                const cfg = { ...memmeConfig!, enable_forgetting_curve: next }
                setMemmeConfigState(cfg)
                await saveMemmeConfigFull(cfg)
              }}
            />
          </div>
          {/* Extraction Depth */}
          <div className="flex items-center justify-between">
            <div className="text-[13px] font-medium">提取深度</div>
            <select
              value={memmeConfig?.extraction_depth ?? 'standard'}
              onChange={async (e) => {
                const cfg = { ...memmeConfig!, extraction_depth: e.target.value }
                setMemmeConfigState(cfg)
                await saveMemmeConfigFull(cfg)
              }}
              className="text-[13px] px-2.5 py-1.5 rounded-lg"
              style={{ background: 'var(--color-bg-muted)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
            >
              <option value="standard">标准</option>
              <option value="thorough">深入</option>
            </select>
          </div>
        </div>
      </div>

      {/* ── Section 5: Memory Browser ── */}
      <div className="p-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
        <div className="flex items-center gap-2 mb-1">
          <BookOpen size={18} className="text-[var(--color-primary)]" />
          <h2 className="font-semibold text-[14px]">记忆</h2>
          {memoryStats && (
            <span className="text-[11px] px-1.5 py-0.5 rounded-full" style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-muted)' }}>
              {memoryStats.total} 条
            </span>
          )}
        </div>
        <p className="text-[12px] text-[var(--color-text-muted)] mb-3 ml-[26px]">
          小精灵从对话中积累的知识和记忆
        </p>

        {/* Category stats */}
        {memoryStats && memoryStats.total > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-3">
            {Object.entries(memoryStats.by_category).map(([cat, count]) => (
              <span key={cat} className="text-[11px] px-2 py-0.5 rounded-full" style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-muted)' }}>
                {cat === 'fact' ? '事实' : cat === 'preference' ? '偏好' : cat === 'experience' ? '经验' : cat === 'decision' ? '决策' : cat === 'principle' ? '原则' : cat} {count}
              </span>
            ))}
          </div>
        )}

        {/* Search */}
        <div className="flex gap-2 mb-3">
          <div className="flex-1 relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--color-text-muted)' }} />
            <input
              type="text"
              value={memorySearch}
              onChange={e => setMemorySearch(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleMemorySearch() }}
              placeholder="搜索记忆..."
              className="w-full pl-8 pr-3 py-1.5 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50"
              style={{ background: 'var(--color-bg)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
            />
          </div>
          <button
            onClick={handleMemorySearch}
            disabled={searching}
            className="px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors"
            style={{ background: 'var(--color-primary)', color: '#fff' }}
          >
            {searching ? <Loader2 size={12} className="animate-spin" /> : '搜索'}
          </button>
        </div>

        {/* Memory list */}
        <div className="space-y-1 max-h-[300px] overflow-y-auto">
          {(searchResults ?? recentMemories).length === 0 ? (
            <div className="text-center py-4 text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
              {searchResults ? '没有找到匹配的记忆' : '暂无记忆'}
            </div>
          ) : (
            (searchResults ?? recentMemories).map(m => (
              <div key={m.id} className="group flex gap-2 p-2.5 rounded-lg hover:bg-[var(--color-bg-subtle)] transition-colors">
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] leading-relaxed" style={{ color: 'var(--color-text)' }}>
                    {m.content.length > 120 ? m.content.slice(0, 120) + '...' : m.content}
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-muted)' }}>
                      {m.categories[0] || 'note'}
                    </span>
                    <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
                      {m.importance >= 0.7 ? '⭐' : ''} {m.created_at.slice(0, 10)}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => handleDeleteMemory(m.id)}
                  className="opacity-0 group-hover:opacity-100 p-1 rounded transition-opacity shrink-0 self-start"
                  style={{ color: 'var(--color-error)' }}
                  title="删除记忆"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))
          )}
        </div>
        {searchResults && (
          <button
            onClick={() => { setSearchResults(null); setMemorySearch('') }}
            className="mt-2 text-[12px] font-medium"
            style={{ color: 'var(--color-primary)' }}
          >
            清除搜索，显示最近记忆
          </button>
        )}
      </div>

      {/* ── Section 6: Corrections ── */}
      {corrections.length > 0 && (
        <div className="p-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
          <div className="flex items-center gap-2 mb-1">
            <ShieldCheck size={18} className="text-[var(--color-primary)]" />
            <h2 className="font-semibold text-[14px]">学到的规矩</h2>
            <span className="text-[11px] px-1.5 py-0.5 rounded-full" style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-muted)' }}>
              {corrections.length} 条
            </span>
          </div>
          <p className="text-[12px] text-[var(--color-text-muted)] mb-3 ml-[26px]">
            从你的反馈中学到的行为准则
          </p>
          <div className="space-y-2">
            {corrections.map((c, i) => (
              <div key={i} className="p-2.5 rounded-lg" style={{ background: 'var(--color-bg-subtle)' }}>
                <div className="text-[12px] font-medium mb-1" style={{ color: 'var(--color-text)' }}>
                  当 {c.trigger}
                </div>
                <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                  ✅ {c.correct_behavior}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
