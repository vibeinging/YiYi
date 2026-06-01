/**
 * CompanionDetail — 单个伙伴的详情页(微信式两栏的右栏,伙伴版)。
 *
 * 与 YiYi 的详情页(BuddyPanel)**同构**:同样的 hero(性格光团 + 身份 + ⚙)
 * + 属性条 + 冥想卡 + 记忆卡。差异仅在数据源(per-companion)与
 * "⚙ 抽屉里多了个归隐"(YiYi 不能归隐)。性格/时间线渲染走共享组件。
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Play, Loader2, Settings, Brain, ChevronDown, ChevronUp } from 'lucide-react'
import { type Companion } from '../../api/companions'
import {
  listRecentMemories, type MemoryEntry,
  getPersonalityStats, getPersonalityTimeline, triggerCompanionReflection,
  listCompanionMeditationSessions,
  type PersonalityStat, type PersonalitySignalRow, type MeditationSession,
} from '../../api/buddy'
import { STAT_NAMES } from '../../utils/buddy'
import { PersonalityOrb } from './PersonalityOrb'
import { PersonalityBars, PersonalityTimeline } from './shared/personality'
import { CompanionEditDrawer } from '../companions/CompanionEditDrawer'
import { toast } from '../Toast'

const ORB_SIZE = 180

/** 把 hex 颜色朝白色提亮 `amount`(0~1),给光团渐变推一个浅色端。非法 hex 原样返回。 */
function lightenHex(hex: string, amount = 0.4): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  const n = parseInt(m[1], 16)
  const mix = (c: number) => Math.round(c + (255 - c) * amount)
  const r = mix((n >> 16) & 0xff)
  const g = mix((n >> 8) & 0xff)
  const b = mix(n & 0xff)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}

// Card wrapper — 与 BuddyPanel 一致的圆角卡片。
const Card: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <div className={`p-5 rounded-2xl ${className}`} style={{ background: 'var(--color-bg-elevated)' }}>
    {children}
  </div>
)

export function CompanionDetail({ companion, onChanged }: { companion: Companion; onChanged: () => void }) {
  const from = companion.color_hex || 'var(--color-primary)'
  // 从主色推一个浅色端,让光团/属性条有渐变层次(对齐 YiYi 的 palette 双色)。
  const to = companion.color_hex ? lightenHex(companion.color_hex, 0.42) : 'var(--color-primary)'

  const [editOpen, setEditOpen] = useState(false)
  const [personalityExpanded, setPersonalityExpanded] = useState(false)

  // 该伙伴的独立记忆(companion_{id} 桶)
  const [memories, setMemories] = useState<MemoryEntry[]>([])
  const loadMemories = useCallback(() => {
    listRecentMemories(12, companion.memory_user_id).then(setMemories).catch(() => setMemories([]))
  }, [companion.memory_user_id])
  useEffect(() => { loadMemories() }, [loadMemories])

  // 该伙伴自己的性格(per-companion)+ 信号时间线 + 反思历史。
  const [pStats, setPStats] = useState<PersonalityStat[]>([])
  const [pTimeline, setPTimeline] = useState<PersonalitySignalRow[]>([])
  const [sessions, setSessions] = useState<MeditationSession[]>([])
  const [reflecting, setReflecting] = useState(false)
  const loadPersonality = useCallback(() => {
    getPersonalityStats(companion.id).then(setPStats).catch(() => setPStats([]))
    getPersonalityTimeline(companion.id, 30).then(setPTimeline).catch(() => setPTimeline([]))
    listCompanionMeditationSessions(companion.id, 8).then(setSessions).catch(() => setSessions([]))
  }, [companion.id])
  useEffect(() => { loadPersonality() }, [loadPersonality])

  // 小写 trait → {value, delta},喂共享属性条。
  const pMap = useMemo(
    () => Object.fromEntries(pStats.map(s => [s.trait, { value: s.value, delta: s.delta }])) as Record<string, { value: number; delta: number }>,
    [pStats],
  )
  // 光团需要 STAT_NAMES(大写)→ 数值,缺失按 base 50。
  const radarStats = useMemo(() => {
    const out: Record<string, number> = {}
    STAT_NAMES.forEach(s => { out[s] = pMap[s.toLowerCase()]?.value ?? 50 })
    return out
  }, [pMap])

  // hero 的"心情"——取最近一次反思的 journal(对齐 YiYi 取最近冥想 summary)。
  const moodQuote = useMemo(() => sessions.find(s => s.journal)?.journal?.trim() || null, [sessions])
  const lastReflectDate = sessions[0]
    ? new Date(sessions[0].started_at).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
    : null

  const reflect = async () => {
    setReflecting(true)
    try {
      const r = await triggerCompanionReflection(companion.id)
      if (r.journal) toast.success(`${companion.name}:「${r.journal}」`)
      else if (r.signals_added > 0) toast.success(`冥想完成 · 性格 +${r.signals_added}`)
      else toast.success('聊得还不多,暂时没有明显变化')
      loadPersonality()
    } catch (e) {
      toast.error(`反思失败：${e}`)
    } finally {
      setReflecting(false)
    }
  }

  const daysSince = Math.max(0, Math.floor((Date.now() - companion.adopted_at) / 86_400_000))

  return (
    <div className="h-full overflow-y-auto buddy-page">
      <div className="w-full px-6 py-6">
        <div className="space-y-5">

          {/* ═══ Hero ═══ */}
          <Card>
            <div className="flex items-start gap-6">
              {/* 性格光团 — 形态随该伙伴的 5 维性格变化 */}
              <div className="shrink-0" style={{ width: ORB_SIZE, height: ORB_SIZE, animation: 'buddy-breathe 3.5s ease-in-out infinite' }}>
                <PersonalityOrb stats={radarStats} from={from} to={to} />
              </div>

              {/* 身份 */}
              <div className="flex-1 min-w-0 pt-1">
                <div className="flex items-baseline gap-2 mb-1">
                  <h1 className="text-[22px] font-bold tracking-tight" style={{ color: 'var(--color-text)' }}>{companion.name}</h1>
                  <span className="text-[12px] ml-1" style={{ color: from }}>
                    {companion.role_label || '你的 AI 伙伴'}
                  </span>
                </div>

                {moodQuote ? (
                  <p className="text-[13px] mb-2 leading-relaxed italic" style={{ color: 'var(--color-text-secondary)' }}>
                    <span className="opacity-50 mr-1">「</span>{moodQuote}<span className="opacity-50 ml-1">」</span>
                  </p>
                ) : (
                  <p className="text-[13px] mb-2 leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
                    和它多聊聊,它会慢慢长出自己的性格。
                  </p>
                )}
              </div>

              {/* ⚙ 设置(编辑人设 / 归隐 都在抽屉里) */}
              <button
                onClick={() => setEditOpen(true)}
                className="shrink-0 p-2 rounded-lg transition-colors hover:bg-[var(--color-bg-subtle)]"
                title="它的设置"
              >
                <Settings size={16} style={{ color: 'var(--color-text-muted)' }} />
              </button>
            </div>

            {/* Meta + 属性条 */}
            <div className="mt-5 pt-4" style={{ borderTop: '1px solid var(--color-bg-subtle)' }}>
              <div className="flex items-center gap-4 text-[12px] mb-3" style={{ color: 'var(--color-text-muted)' }}>
                <span>
                  <span className="font-semibold tabular-nums" style={{ color: 'var(--color-text-secondary)' }}>{daysSince}</span> 天
                </span>
                <span>·</span>
                <span>
                  <span className="font-semibold tabular-nums" style={{ color: 'var(--color-text-secondary)' }}>{companion.invocation_count}</span> 次协作
                </span>
              </div>
              <PersonalityBars stats={pMap} from={from} to={to} />
            </div>
          </Card>

          {/* ═══ 冥想(与 YiYi 同款)═══ */}
          <Card className="relative overflow-hidden">
            {reflecting && (
              <div className="absolute inset-0 pointer-events-none" style={{
                background: `radial-gradient(circle at 50% 30%, ${from}18, transparent 70%)`,
                animation: 'buddy-breathe 2s ease-in-out infinite',
              }} />
            )}
            <div className="relative flex items-start gap-4">
              <div className="shrink-0 text-[24px] leading-none mt-0.5">🌙</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2 mb-1">
                  <h2 className="text-[14px] font-semibold" style={{ color: 'var(--color-text)' }}>
                    {reflecting ? `${companion.name}正在冥想中...` : "冥想"}
                  </h2>
                  {!reflecting && lastReflectDate && (
                    <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>上次 · {lastReflectDate}</span>
                  )}
                </div>
                <p className="text-[12px] leading-relaxed mb-2" style={{ color: moodQuote ? 'var(--color-text-secondary)' : 'var(--color-text-muted)' }}>
                  {moodQuote ? <><span className="opacity-60">它想到：</span>{moodQuote}</> : '让它回看自己的发言、提炼记忆、感受性格的变化。'}
                </p>
                {companion.meditation_enabled && !reflecting && (
                  <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                    每天 {companion.meditation_time} 自动冥想 ·
                    <button onClick={() => setEditOpen(true)} className="ml-1 underline-offset-2 hover:underline" style={{ color: 'var(--color-text-muted)' }}>
                      改设置
                    </button>
                  </div>
                )}
              </div>
              <button
                onClick={reflect}
                disabled={reflecting}
                className="shrink-0 flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[12px] font-semibold transition-all hover:scale-[1.02] active:scale-[0.98] disabled:cursor-not-allowed"
                style={{
                  background: reflecting ? `${from}20` : from,
                  color: reflecting ? from : '#fff',
                  boxShadow: reflecting ? 'none' : `0 1px 4px ${from}40`,
                }}
              >
                {reflecting ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                {reflecting ? "冥想中" : "叫它冥想"}
              </button>
            </div>

            {/* 性格变化 — 可折叠时间线(共享组件) */}
            {pTimeline.length > 0 && (
              <div className="relative mt-4 pt-4" style={{ borderTop: '1px solid var(--color-bg-subtle)' }}>
                <button
                  onClick={() => setPersonalityExpanded(v => !v)}
                  className="flex items-center gap-1 text-[11px] mb-2 transition-colors hover:opacity-100"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  {personalityExpanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                  它最近变了什么（{pTimeline.length} 处）
                </button>
                {personalityExpanded && <PersonalityTimeline signals={pTimeline} accent={from} />}
              </div>
            )}
          </Card>

          {/* ═══ 它冥想过的时刻 ═══ */}
          {sessions.length > 0 && (
            <Card>
              <div className="flex items-center gap-2 mb-3">
                <Brain size={16} style={{ color: from }} />
                <h2 className="text-[15px] font-semibold" style={{ color: 'var(--color-text)' }}>它冥想过的时刻</h2>
              </div>
              <ul className="space-y-2.5">
                {sessions.map(s => {
                  const when = new Date(s.started_at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
                  return (
                    <li key={s.id} className="px-3 py-2.5 rounded-lg" style={{ background: 'var(--color-bg-subtle)' }}>
                      <div className="flex items-center gap-2 mb-1 text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                        <span>{when}</span>
                        <span>· 回看 {s.sessions_reviewed} 句</span>
                        {s.memories_updated > 0 && <span>· 巩固 {s.memories_updated} 条记忆</span>}
                        {s.principles_changed > 0 && <span>· 性格 +{s.principles_changed}</span>}
                      </div>
                      {s.journal ? (
                        <p className="text-[13px] leading-relaxed italic" style={{ color: 'var(--color-text-secondary)' }}>
                          <span className="opacity-50">「</span>{s.journal}<span className="opacity-50">」</span>
                        </p>
                      ) : (
                        <p className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>这次没什么特别的想法。</p>
                      )}
                    </li>
                  )
                })}
              </ul>
            </Card>
          )}

          {/* ═══ 它的记忆 ═══ */}
          <Card>
            <div className="flex items-center gap-2 mb-3">
              <Brain size={16} style={{ color: from }} />
              <h2 className="text-[15px] font-semibold" style={{ color: 'var(--color-text)' }}>它记得</h2>
              <span className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>{memories.length} · 独立于 YiYi 和其它伙伴</span>
            </div>
            {memories.length === 0 ? (
              <p className="text-[12px] py-4 text-center" style={{ color: 'var(--color-text-muted)' }}>
                还没有记忆 —— 和它多聊聊,它会记住你们之间的事。
              </p>
            ) : (
              <ul className="space-y-2">
                {memories.map((m) => (
                  <li
                    key={m.id}
                    className="text-[13px] px-3 py-2 rounded-lg leading-relaxed"
                    style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-secondary)' }}
                  >
                    {m.content}
                  </li>
                ))}
              </ul>
            )}
          </Card>

        </div>
      </div>

      {editOpen && (
        <CompanionEditDrawer
          companion={companion}
          onClose={() => setEditOpen(false)}
          onChanged={() => { onChanged(); loadPersonality() }}
        />
      )}
    </div>
  )
}
