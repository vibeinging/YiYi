/**
 * CompanionsSection — Buddy 页中的"群"section。
 *
 * 列出在职伙伴 + 收养入口；空态引导用户养第一个。AdoptModal /
 * CompanionEditDrawer / "找他聊"路由是 Phase 1 后续任务挂在这里的钩子。
 */

import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { listCompanions, type Companion } from '../../api/companions'
import { CompanionCard } from './CompanionCard'

interface Props {
  /** 用户点"收养新伙伴"。Phase 1 后续接 AdoptModal。 */
  onAdopt: () => void
  /** 用户点单卡片的"找他聊"。Phase 1 后续接 ChatInput @ companion 流程。 */
  onChatWith: (companion: Companion) => void
  /** 用户点单卡片的 ⚙。Phase 1 后续接 CompanionEditDrawer。 */
  onEdit: (companion: Companion) => void
  /** Section 主色，用于跟 Buddy 页其它 section 的色调一致。 */
  accent?: string
  /** 父组件 increment 此值时强制重新 fetch（收养 / 编辑 / 归隐后用）。 */
  reloadToken?: number
}

export function CompanionsSection({ onAdopt, onChatWith, onEdit, accent, reloadToken = 0 }: Props) {
  const [companions, setCompanions] = useState<Companion[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    listCompanions(false)
      .then(list => {
        if (cancelled) return
        setCompanions(list)
        setError(null)
      })
      .catch(e => { if (!cancelled) setError(String(e)) })
    return () => { cancelled = true }
  }, [reloadToken])

  const loading = companions === null
  const list = companions ?? []
  const accentColor = accent ?? 'var(--color-text-muted)'

  return (
    <div
      className="p-5 rounded-2xl"
      style={{ background: 'var(--color-bg-elevated)' }}
    >
      <div className="flex items-center gap-2 mb-4">
        <h2 className="text-[15px] font-semibold" style={{ color: 'var(--color-text)' }}>
          我的伙伴
        </h2>
        {list.length > 0 && (
          <span className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
            {list.length} 位
          </span>
        )}
        <button
          onClick={onAdopt}
          className="ml-auto flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors"
          style={{ background: `${accentColor}1a`, color: accentColor }}
        >
          <Plus size={13} />
          收养新伙伴
        </button>
      </div>

      <div className="text-[11px] mb-4 -mt-2" style={{ color: 'var(--color-text-muted)' }}>
        在桌面上养的小精灵 · 每位有自己的脾气、记忆、陪伴时长
      </div>

      {error && (
        <div
          className="p-3 rounded-lg text-[12px] mb-3"
          style={{ background: 'var(--color-error-bg, #fee)', color: 'var(--color-error, #c00)' }}
        >
          加载失败:{error}
        </div>
      )}

      {!loading && list.length === 0 && !error && (
        <EmptyState onAdopt={onAdopt} accent={accentColor} />
      )}

      {list.length > 0 && (
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
          {list.map(c => (
            <CompanionCard
              key={c.id}
              companion={c}
              onChat={onChatWith}
              onEdit={onEdit}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function EmptyState({ onAdopt, accent }: { onAdopt: () => void; accent: string }) {
  return (
    <div className="py-6 text-center">
      <div className="text-[40px] mb-2">🫧</div>
      <div className="text-[13px] mb-1" style={{ color: 'var(--color-text-secondary)' }}>
        还没养任何伙伴
      </div>
      <div className="text-[12px] mb-4" style={{ color: 'var(--color-text-muted)' }}>
        养一只小精灵在桌面，他会有自己的脾气，记得你们做过的事
      </div>
      <button
        onClick={onAdopt}
        className="px-4 py-2 rounded-xl text-[13px] font-medium transition-colors"
        style={{ background: accent, color: '#fff' }}
      >
        收养第一位伙伴
      </button>
    </div>
  )
}
