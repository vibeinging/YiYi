/**
 * CompanionCard — 家族成员的卡片视图。
 *
 * 显示头像 + 名字 + 角色 + 陪伴天数 + 互动次数 + 操作按钮。
 * 用户视角的"伙伴"叙事——不是工具卡，是家族成员。
 */

import { MessageCircle, Settings } from 'lucide-react'
import type { Companion } from '../../api/companions'
import { companionRoleLabel, daysSinceMs } from '../../utils/companion'

interface Props {
  companion: Companion
  onChat: (companion: Companion) => void
  onEdit: (companion: Companion) => void
}

export function CompanionCard({ companion, onChat, onEdit }: Props) {
  const days = daysSinceMs(companion.adopted_at)
  const accent = companion.color_hex || 'var(--color-text-muted)'

  return (
    <div
      className="p-5 rounded-2xl flex flex-col gap-3 transition-shadow hover:shadow-md"
      style={{
        background: 'var(--color-bg-elevated)',
        borderLeft: `3px solid ${accent}`,
      }}
    >
      <div className="flex items-start gap-3">
        <div
          className="shrink-0 w-14 h-14 rounded-2xl flex items-center justify-center text-[28px]"
          style={{ background: `${accent}18` }}
        >
          {companion.avatar_emoji}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-[15px] truncate" style={{ color: 'var(--color-text)' }}>
            {companion.name}
          </div>
          <div className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
            {companionRoleLabel(companion.agent_definition_name)}
          </div>
        </div>
      </div>

      <div className="text-[12px] leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
        陪了你{' '}
        <span className="font-semibold tabular-nums" style={{ color: 'var(--color-text)' }}>
          {days}
        </span>{' '}
        天 · 一起做过{' '}
        <span className="font-semibold tabular-nums" style={{ color: 'var(--color-text)' }}>
          {companion.invocation_count}
        </span>{' '}
        件事
      </div>

      <div className="flex items-center gap-2 mt-auto pt-2">
        <button
          onClick={() => onChat(companion)}
          className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[13px] font-medium transition-colors"
          style={{ background: `${accent}1a`, color: accent }}
        >
          <MessageCircle size={14} />
          找他聊
        </button>
        <button
          onClick={() => onEdit(companion)}
          className="p-1.5 rounded-lg transition-colors hover:bg-[var(--color-bg-subtle)]"
          title="编辑"
        >
          <Settings size={14} style={{ color: 'var(--color-text-muted)' }} />
        </button>
      </div>
    </div>
  )
}
