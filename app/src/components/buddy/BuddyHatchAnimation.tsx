import React, { useState, useEffect, useCallback } from 'react'
import {
  COMPANION_COLOR,
  STAT_LABELS,
  STAT_NAMES,
  getSpeciesLabel,
  getSpeciesConfig,
  rollStatsBiased,
  type StatName,
} from '../../utils/buddy'
import { useBuddyStore } from '../../stores/buddyStore'

type HatchPhase = 'idle' | 'crack' | 'personality-setup' | 'hatching' | 'reveal' | 'done'

const PERSONALITY_PRESETS = [
  { label: '元气满满', value: '活泼开朗，总是充满正能量，喜欢用感叹号和颜文字为主人加油打气' },
  { label: '毒舌傲娇', value: '嘴上不饶人但其实很关心主人，会用吐槽和傲娇的方式表达关爱' },
  { label: '安静陪伴', value: '话不多但很温暖，只在关键时刻冒泡，给出走心的一句话' },
  { label: '好奇宝宝', value: '对一切都充满好奇，喜欢问为什么，看到新东西就兴奋' },
  { label: '学术派', value: '冷静理性，偶尔掉书袋引经据典，用知识分子的方式卖萌' },
  { label: '混沌邪恶', value: '喜欢搞怪和冷笑话，说话不着调，但总能让人笑出来' },
]

/** Mini orb preview used during hatch animation */
const OrbPreview: React.FC<{ from: string; to: string; css: string; size: number; animate?: boolean }> = ({
  from, to, css, size, animate,
}) => {
  const shapeStyle: React.CSSProperties = {}
  for (const rule of css.split(';')) {
    const [prop, val] = rule.split(':').map(s => s.trim())
    if (prop && val) {
      const camel = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      ;(shapeStyle as any)[camel] = val
    }
  }
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <div
        className="absolute inset-0"
        style={{
          ...shapeStyle,
          background: `radial-gradient(circle, ${from}40 0%, transparent 70%)`,
          transform: 'scale(1.6)',
          filter: 'blur(6px)',
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          ...shapeStyle,
          background: `radial-gradient(circle at 35% 35%, ${from}, ${to})`,
          boxShadow: `0 0 16px ${from}80`,
          animation: animate ? 'buddy-breathe 2s ease-in-out infinite' : undefined,
        }}
      />
      <div
        className="absolute"
        style={{
          ...shapeStyle,
          width: size * 0.35,
          height: size * 0.25,
          top: size * 0.18,
          left: size * 0.22,
          background: 'radial-gradient(ellipse, rgba(255,255,255,0.5) 0%, transparent 80%)',
          filter: 'blur(1.5px)',
        }}
      />
    </div>
  )
}

export const BuddyHatchAnimation: React.FC = () => {
  const { bones, companion, config, hatching, hatch, dismissHatch, showHatchAnimation, aiName } =
    useBuddyStore()
  const [phase, setPhase] = useState<HatchPhase>('idle')
  const [selectedPreset, setSelectedPreset] = useState<number | null>(null)

  const startCrack = useCallback(() => {
    if (phase !== 'idle') return
    setPhase('crack')
    setTimeout(() => setPhase('personality-setup'), 1500)
  }, [phase])

  const startHatch = useCallback(() => {
    const personality =
      selectedPreset !== null
        ? PERSONALITY_PRESETS[selectedPreset].value
        : undefined
    setPhase('hatching')
    hatch(personality)
  }, [selectedPreset, hatch])

  useEffect(() => {
    if (phase === 'hatching' && !hatching && companion) {
      setPhase('reveal')
      setTimeout(() => setPhase('done'), 1500)
    }
  }, [phase, hatching, companion])

  if (!showHatchAnimation || !bones) return null
  if (companion && phase !== 'reveal' && phase !== 'done') return null

  const label = getSpeciesLabel(bones.species)
  const speciesConfig = getSpeciesConfig(bones.species)
  const { from, to } = bones.palette

  return (
    <div
      className="fixed inset-0 z-[9998] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(8px)' }}
    >
      <div
        className="flex flex-col items-center gap-5 p-8 rounded-2xl"
        style={{
          background: 'var(--color-bg-elevated)',
          border: '1px solid var(--color-border)',
          boxShadow: 'var(--shadow-xl)',
          maxWidth: phase === 'personality-setup' ? '420px' : '340px',
          width: '90vw',
          transition: 'max-width 0.3s ease',
        }}
      >
        {/* ─── Phase: Idle (egg) ─── */}
        {phase === 'idle' && (
          <>
            <div
              className="cursor-pointer select-none hover:scale-110 transition-transform"
              onClick={startCrack}
            >
              <div
                className="w-16 h-16 rounded-full"
                style={{
                  background: `radial-gradient(circle at 35% 35%, rgba(255,255,255,0.3), rgba(200,200,220,0.15))`,
                  boxShadow: '0 0 20px rgba(255,255,255,0.15), inset 0 0 12px rgba(255,255,255,0.1)',
                  border: '1px solid rgba(255,255,255,0.1)',
                }}
              />
            </div>
            <div className="text-center">
              <div className="text-sm font-medium mb-1" style={{ color: 'var(--color-text)' }}>
                {aiName} 正在等待一个形象...
              </div>
              <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                点击光团，赋予 {aiName} 一个身体
              </div>
            </div>
          </>
        )}

        {/* ─── Phase: Crack ─── */}
        {phase === 'crack' && (
          <div className="flex flex-col items-center gap-2">
            <div style={{ animation: 'buddy-hatch-wobble 0.4s ease-in-out infinite' }}>
              <OrbPreview from={from} to={to} css={speciesConfig.css} size={64} />
            </div>
            <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              光团在凝聚...!
            </div>
          </div>
        )}

        {/* ─── Phase: Personality Setup ─── */}
        {phase === 'personality-setup' && (
          <>
            {/* Species reveal */}
            <div className="flex flex-col items-center gap-2">
              <div style={{ animation: 'buddy-reveal 0.6s ease-out forwards' }}>
                <OrbPreview from={from} to={to} css={speciesConfig.css} size={56} animate />
              </div>
              <div className="text-center">
                <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
                  {aiName} 的形象是{label}！
                </div>
                <div className="text-xs mt-0.5" style={{ color: from }}>
                  {bones.palette.name}
                </div>
              </div>
            </div>

            {/* Personality selection */}
            <div className="w-full">
              <div
                className="text-xs font-medium mb-2"
                style={{ color: 'var(--color-text-muted)' }}
              >
                选择 {aiName} 的情绪表达风格：
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {PERSONALITY_PRESETS.map((preset, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      setSelectedPreset(selectedPreset === i ? null : i)
                    }}
                    className="px-3 py-2 rounded-lg text-xs text-left transition-all"
                    style={{
                      background:
                        selectedPreset === i
                          ? 'var(--color-primary-subtle, rgba(99,102,241,0.15))'
                          : 'var(--color-bg-muted, var(--color-bg))',
                      border:
                        selectedPreset === i
                          ? '1px solid var(--color-primary)'
                          : '1px solid var(--color-border)',
                      color: selectedPreset === i ? 'var(--color-primary)' : 'var(--color-text)',
                    }}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Mini stat preview */}
            <div className="w-full">
              {(() => {
                const personalityValue = selectedPreset !== null
                  ? PERSONALITY_PRESETS[selectedPreset].value
                  : ''
                const previewStats = personalityValue && config
                  ? rollStatsBiased(config.buddy_user_id, personalityValue)
                  : bones.stats
                return (
                  <div className="flex flex-wrap gap-x-3 gap-y-1.5">
                    {STAT_NAMES.map((stat) => (
                      <div key={stat} className="flex items-center gap-1.5">
                        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                          {STAT_LABELS[stat]}
                        </span>
                        <div className="w-12 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--color-border)' }}>
                          <div
                            className="h-full rounded-full transition-all duration-300"
                            style={{ width: `${previewStats[stat]}%`, background: from }}
                          />
                        </div>
                        <span className="text-xs font-mono w-5 text-right" style={{ color: from }}>
                          {previewStats[stat]}
                        </span>
                      </div>
                    ))}
                  </div>
                )
              })()}
            </div>

            {/* Warning + Hatch button */}
            <div
              className="w-full text-center text-xs py-1.5 px-3 rounded-lg"
              style={{
                background: 'var(--color-warning-subtle, rgba(245,158,11,0.1))',
                color: 'var(--color-warning, #f59e0b)',
              }}
            >
              形象和情绪风格一旦确定便无法更改，请慎重选择
            </div>
            <button
              onClick={startHatch}
              className="w-full py-2.5 rounded-xl text-sm font-medium text-white transition-all hover:scale-[1.02] active:scale-[0.98]"
              style={{
                background: `linear-gradient(135deg, ${from}, ${to})`,
                boxShadow: `0 4px 14px ${from}40`,
              }}
            >
              赋予形象！
            </button>
          </>
        )}

        {/* ─── Phase: Hatching ─── */}
        {phase === 'hatching' && (
          <div className="flex flex-col items-center gap-3">
            <div style={{ animation: 'buddy-bounce 1s ease-in-out infinite' }}>
              <OrbPreview from={from} to={to} css={speciesConfig.css} size={56} animate />
            </div>
            <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {aiName} 正在苏醒...
            </div>
          </div>
        )}

        {/* ─── Phase: Reveal & Done ─── */}
        {(phase === 'reveal' || phase === 'done') && companion && (
          <>
            <div className="flex flex-col items-center gap-3">
              <div style={{ animation: 'buddy-reveal 0.8s ease-out forwards' }}>
                <OrbPreview from={from} to={to} css={speciesConfig.css} size={56} animate />
              </div>
              <div className="text-center">
                <div className="font-bold text-lg" style={{ color: 'var(--color-text)' }}>
                  {companion.name}
                </div>
                <div className="text-sm" style={{ color: from }}>
                  {bones.palette.name} · {label}
                </div>
                <div
                  className="text-xs mt-2 italic max-w-[260px]"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  "{companion.personality}"
                </div>
              </div>
            </div>

            {phase === 'done' && (
              <button
                onClick={dismissHatch}
                className="px-6 py-2.5 rounded-xl text-sm font-medium text-white transition-all hover:scale-105"
                style={{
                  background: `linear-gradient(135deg, ${from}, ${to})`,
                  boxShadow: `0 4px 14px ${from}40`,
                }}
              >
                你好呀！👋
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
