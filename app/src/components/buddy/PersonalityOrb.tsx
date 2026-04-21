/**
 * PersonalityOrb — The companion's visual form, driven by personality stats.
 *
 * The orb is a smooth closed curve through 5 points, one per personality trait.
 * Each point's distance from center = f(stat value).
 * As the companion's personality evolves, the orb morphs smoothly.
 */

import React from 'react'
import { STAT_NAMES, STAT_LABELS } from '../../utils/buddy'

export interface PersonalityOrbProps {
  stats: Record<string, number>
  from: string
  to: string
  size?: number
  shiny?: boolean
  /** Show personality axis labels around the orb (only when size >= 120) */
  showLabels?: boolean
  /** Show faint reference rings (only when size >= 120) */
  showRings?: boolean
  /** Dim/greyscale when muted */
  muted?: boolean
}

/** Compute 5 points around center based on personality stats. */
function orbPoints(values: number[], cx: number, cy: number, minR: number, maxR: number): [number, number][] {
  return values.map((v, i) => {
    const angle = (i * 72 - 90) * (Math.PI / 180)
    const clamped = Math.max(0, Math.min(100, v))
    const r = minR + ((maxR - minR) * clamped) / 100
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)]
  })
}

/** Build a smooth closed path using Catmull-Rom → cubic Bezier. */
function smoothClosedPath(points: [number, number][]): string {
  const n = points.length
  if (n < 3) return ''
  let d = `M ${points[0][0].toFixed(2)} ${points[0][1].toFixed(2)} `
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n]
    const p1 = points[i]
    const p2 = points[(i + 1) % n]
    const p3 = points[(i + 2) % n]
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6
    d += `C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2[0].toFixed(2)} ${p2[1].toFixed(2)} `
  }
  return d + 'Z'
}

export const PersonalityOrb: React.FC<PersonalityOrbProps> = ({
  stats, from, to, size = 180, shiny, showLabels, showRings, muted,
}) => {
  // Proportional dimensions
  const cx = size / 2
  const cy = size / 2
  const canShowLabels = showLabels ?? size >= 120
  const canShowRings = showRings ?? size >= 120
  // When labels are hidden, let the orb fill more of the canvas
  const maxR = canShowLabels ? size * 0.32 : size * 0.46
  const minR = canShowLabels ? size * 0.18 : size * 0.28

  const values = STAT_NAMES.map(s => stats[s] ?? 50)
  const points = orbPoints(values, cx, cy, minR, maxR)
  const pathD = smoothClosedPath(points)

  // Unique filter IDs so multiple orbs on one page don't collide
  const uid = React.useId().replace(/:/g, '-')
  const bodyGradId = `orb-body-${uid}`
  const glowGradId = `orb-glow-${uid}`
  const blurFilterId = `orb-blur-${uid}`

  const effectiveFrom = muted ? 'var(--color-text-muted)' : from
  const effectiveTo = muted ? 'var(--color-bg-muted)' : to
  const glowStrength = muted ? 4 : Math.max(6, size * 0.07)

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ overflow: 'visible' }}>
      <defs>
        <radialGradient id={bodyGradId} cx="35%" cy="30%" r="75%">
          <stop offset="0%" stopColor={effectiveFrom} stopOpacity="1" />
          <stop offset="70%" stopColor={effectiveTo} stopOpacity="0.95" />
          <stop offset="100%" stopColor={effectiveTo} stopOpacity="0.8" />
        </radialGradient>
        <radialGradient id={glowGradId} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={effectiveFrom} stopOpacity={muted ? 0.15 : 0.5} />
          <stop offset="100%" stopColor={effectiveFrom} stopOpacity="0" />
        </radialGradient>
        <filter id={blurFilterId} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation={size * 0.04} />
        </filter>
      </defs>

      {/* Reference rings — only when large enough */}
      {canShowRings && (
        <g opacity={muted ? 0.08 : 0.22}>
          {[0.5, 0.75, 1.0].map(s => (
            <circle key={s} cx={cx} cy={cy} r={maxR * s}
              fill="none" stroke="var(--color-bg-subtle)" strokeWidth="0.5"
              strokeDasharray={s === 1 ? '' : '2 3'} />
          ))}
        </g>
      )}

      {/* Ambient blob glow (blurred, larger than body) */}
      <path d={pathD} fill={`url(#${glowGradId})`} filter={`url(#${blurFilterId})`}
        transform={`translate(${cx} ${cy}) scale(1.5) translate(${-cx} ${-cy})`} />

      {/* Main body — personality shape */}
      <path d={pathD} fill={`url(#${bodyGradId})`}
        style={{
          filter: `drop-shadow(0 0 ${glowStrength}px ${effectiveFrom}${muted ? '40' : '80'})`,
          transition: 'd 0.8s cubic-bezier(0.16, 1, 0.3, 1)',
        }} />

      {/* Inner highlight — 3D feel */}
      <ellipse cx={cx - size * 0.07} cy={cy - size * 0.08}
        rx={size * 0.08} ry={size * 0.05}
        fill="white" opacity={muted ? 0.15 : 0.35}
        style={{ filter: `blur(${size * 0.017}px)` }} />

      {/* Labels (large orbs only) */}
      {canShowLabels && STAT_NAMES.map((stat, i) => {
        const angle = (i * 72 - 90) * (Math.PI / 180)
        const labelR = maxR + size * 0.1
        const x = cx + labelR * Math.cos(angle)
        const y = cy + labelR * Math.sin(angle)
        const val = stats[stat] ?? 50
        return (
          <text key={stat} x={x} y={y} textAnchor="middle" dominantBaseline="central"
            fontSize={size * 0.055} fontWeight="500" fill="var(--color-text-muted)"
            style={{ opacity: 0.5 + (val / 200) }}>
            {STAT_LABELS[stat]}
          </text>
        )
      })}

      {/* Shiny sparkle */}
      {shiny && !muted && (
        <text x={cx + maxR * 0.75} y={cy - maxR * 0.75}
          fontSize={size * 0.075} fill="white"
          style={{ animation: 'buddy-sparkle 2s ease-in-out infinite',
            filter: `drop-shadow(0 0 4px ${from})` }}>
          ✨
        </text>
      )}
    </svg>
  )
}
