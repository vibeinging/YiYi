import React from 'react'
import { X, EyeOff, Eye } from 'lucide-react'
import {
  STAT_LABELS,
  STAT_NAMES,
  getSpeciesLabel,
  type Companion,
} from '../../utils/buddy'
import { useBuddyStore } from '../../stores/buddyStore'

interface BuddyStatsCardProps {
  companion: Companion
  onClose: () => void
  /** true = sprite is on the left side, card opens rightward */
  flipRight?: boolean
}

export const BuddyStatsCard: React.FC<BuddyStatsCardProps> = ({ companion, onClose, flipRight }) => {
  const { config, setMuted, aiName } = useBuddyStore()
  const muted = config?.muted ?? false
  const { from, to } = companion.palette

  return (
    <div
      className="absolute w-64 rounded-xl overflow-hidden"
      style={{
        bottom: '100%',
        ...(flipRight
          ? { left: '100%', marginLeft: '5px' }
          : { right: '100%', marginRight: '5px' }),
        marginBottom: '5px',
        background: 'var(--color-bg-elevated)',
        border: '1px solid var(--color-border)',
        boxShadow: 'var(--shadow-xl)',
        backdropFilter: 'blur(20px)',
        zIndex: 100,
      }}
    >
      {/* Header */}
      <div className="px-4 pt-3 pb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* Mini orb icon */}
          <div className="relative" style={{ width: 28, height: 28 }}>
            <div
              className="absolute inset-0"
              style={{
                borderRadius: '50%',
                background: `radial-gradient(circle at 35% 35%, ${from}, ${to})`,
                boxShadow: `0 0 8px ${from}60`,
              }}
            />
          </div>
          <div>
            <div className="font-semibold text-sm" style={{ color: 'var(--color-text)' }}>
              {companion.name}
              {companion.shiny && <span className="ml-1">✨</span>}
            </div>
            <div className="text-xs" style={{ color: from }}>
              {companion.palette.name} · {getSpeciesLabel(companion.species)}
            </div>
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded-lg transition-colors hover:bg-black/10 dark:hover:bg-white/10"
        >
          <X size={14} style={{ color: 'var(--color-text-muted)' }} />
        </button>
      </div>

      {/* Personality */}
      <div className="px-4 pb-2">
        <div className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
          {aiName} 的化身 · {getSpeciesLabel(companion.species)}
        </div>
        <div
          className="text-sm mt-1"
          style={{ color: 'var(--color-text-secondary, var(--color-text-muted))' }}
        >
          情绪风格: {companion.personality}
        </div>
      </div>

      {/* Stats */}
      <div className="px-4 pb-3 space-y-1.5">
        {STAT_NAMES.map((stat) => (
          <div key={stat} className="flex items-center gap-2">
            <span className="text-sm w-12 shrink-0" style={{ color: 'var(--color-text-muted)' }}>
              {STAT_LABELS[stat]}
            </span>
            <div
              className="flex-1 h-1.5 rounded-full overflow-hidden"
              style={{ background: 'var(--color-border)' }}
            >
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${companion.stats[stat]}%`,
                  background: `linear-gradient(90deg, ${from}, ${to})`,
                }}
              />
            </div>
            <span className="text-sm w-6 text-right" style={{ color: 'var(--color-text-muted)' }}>
              {companion.stats[stat]}
            </span>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div
        className="px-4 py-2 flex items-center justify-between border-t"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
          {companion.hatchedAt > 0
            ? `孵化于 ${new Date(companion.hatchedAt).toLocaleDateString('zh-CN')}`
            : '未孵化'}
        </span>
        <button
          onClick={() => setMuted(!muted)}
          className="p-1.5 rounded-lg transition-colors hover:bg-black/10 dark:hover:bg-white/10"
          title={muted ? '唤醒精灵' : '让精灵休息'}
        >
          {muted ? (
            <EyeOff size={14} style={{ color: 'var(--color-text-muted)' }} />
          ) : (
            <Eye size={14} style={{ color: 'var(--color-text-muted)' }} />
          )}
        </button>
      </div>
    </div>
  )
}
