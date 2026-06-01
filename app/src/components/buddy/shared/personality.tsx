/**
 * 共享性格视图组件 —— YiYi(BuddyPanel)和伙伴(CompanionDetail)共用同一套渲染。
 *
 * 纯展示:只收已取好的数据,不自己 fetch。数据源各页面自理(YiYi 走全局命令、
 * 伙伴走 per-companion 命令),视图统一在这里——改一次两边一起变。
 */

import type { PersonalitySignalRow } from '../../../api/buddy'

/** 5 个性格属性的展示元数据(与后端 trait 小写名对齐)。 */
export const TRAIT_META: { key: string; emoji: string; label: string }[] = [
  { key: 'energy', emoji: '⚡', label: '活力' },
  { key: 'warmth', emoji: '🤗', label: '温柔' },
  { key: 'mischief', emoji: '😈', label: '调皮' },
  { key: 'wit', emoji: '🧠', label: '聪慧' },
  { key: 'sass', emoji: '💋', label: '犀利' },
]

const labelFor = (traitName: string) =>
  TRAIT_META.find(t => t.key === traitName.toLowerCase())?.label ?? traitName

/**
 * 5 维属性条(emoji + 数值 + 涨跌箭头 + 进度条)。
 * `stats` 按小写 trait 名取值;缺失按 base 50 / delta 0 处理。
 * `from`/`to` 给进度条上色(to 缺省 = from,纯色)。
 */
export function PersonalityBars({
  stats,
  from,
  to,
}: {
  stats: Record<string, { value: number; delta: number }>
  from: string
  to?: string
}) {
  const grad = `linear-gradient(90deg, ${from}, ${to ?? from})`
  return (
    <div className="grid grid-cols-5 gap-3">
      {TRAIT_META.map(t => {
        const val = stats[t.key]?.value ?? 50
        const delta = stats[t.key]?.delta ?? 0
        const deltaColor =
          delta > 2 ? 'var(--color-success)' : delta < -2 ? 'var(--color-error)' : 'var(--color-text)'
        return (
          <div key={t.key} className="flex flex-col items-center gap-1.5" title={t.label}>
            <div className="text-[18px] leading-none">{t.emoji}</div>
            <div className="text-[13px] font-semibold tabular-nums" style={{ color: deltaColor }}>
              {val}
              {Math.abs(delta) > 2 && <span className="text-[10px] ml-0.5">{delta > 0 ? '↑' : '↓'}</span>}
            </div>
            <div className="w-full h-1 rounded-full overflow-hidden" style={{ background: 'var(--color-bg-subtle)' }}>
              <div className="h-full rounded-full transition-all duration-700" style={{ width: `${val}%`, background: grad }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * 性格信号时间线(竖线 + 圆点,最新在上)。`accent` 给正向信号与竖线着色。
 */
export function PersonalityTimeline({
  signals,
  accent,
  max = 20,
}: {
  signals: PersonalitySignalRow[]
  accent: string
  max?: number
}) {
  if (signals.length === 0) return null
  return (
    <div className="relative pl-5 max-h-[260px] overflow-y-auto" style={{ borderLeft: `2px solid ${accent}25` }}>
      {signals.slice(0, max).map(sig => {
        const isPos = sig.delta > 0
        const color = isPos ? accent : 'var(--color-error)'
        return (
          <div key={sig.id} className="relative pb-3 last:pb-0">
            <div
              className="absolute -left-[calc(1.25rem+4px)] top-1.5 w-2 h-2 rounded-full"
              style={{ background: color }}
            />
            <div className="flex items-baseline gap-2 mb-0.5">
              <span className="text-[12px] font-medium" style={{ color }}>
                {labelFor(sig.trait_name)} {isPos ? '+' : ''}{sig.delta.toFixed(1)}
              </span>
              <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
                {new Date(sig.created_at).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}
              </span>
            </div>
            <div className="text-[11px] leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
              {sig.evidence}
            </div>
          </div>
        )
      })}
    </div>
  )
}
