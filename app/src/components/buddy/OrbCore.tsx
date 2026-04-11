import React from 'react'

function parseCssString(css: string): React.CSSProperties {
  const style: React.CSSProperties = {}
  for (const rule of css.split(';')) {
    const [prop, val] = rule.split(':').map(s => s.trim())
    if (prop && val) {
      const camel = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      ;(style as any)[camel] = val
    }
  }
  return style
}

interface OrbCoreProps {
  from: string
  to: string
  css: string
  size: number
  glow?: number
  shiny?: boolean
  animate?: boolean
}

/** Shared orb rendering used by BuddySprite and BuddyHatchAnimation */
export const OrbCore: React.FC<OrbCoreProps> = ({
  from, to, css, size, glow, shiny, animate,
}) => {
  const shapeStyle = parseCssString(css)
  const glowPx = glow ?? 16

  return (
    <div className="relative" style={{ width: size, height: size }}>
      {/* Outer glow */}
      <div
        className="absolute inset-0"
        style={{
          ...shapeStyle,
          background: `radial-gradient(circle, ${from}40 0%, transparent 70%)`,
          transform: `scale(${1 + glowPx / size})`,
          filter: `blur(${glowPx * 0.4}px)`,
        }}
      />
      {/* Core orb */}
      <div
        className="absolute inset-0"
        style={{
          ...shapeStyle,
          background: `radial-gradient(circle at 35% 35%, ${from}, ${to})`,
          boxShadow: `0 0 ${glowPx}px ${from}80, inset 0 0 ${glowPx * 0.5}px ${from}60`,
          animation: animate ? 'buddy-breathe 2s ease-in-out infinite' : undefined,
        }}
      />
      {/* Inner highlight */}
      <div
        className="absolute"
        style={{
          ...shapeStyle,
          width: size * 0.35,
          height: size * 0.25,
          top: size * 0.18,
          left: size * 0.22,
          background: `radial-gradient(ellipse, rgba(255,255,255,0.6) 0%, transparent 80%)`,
          filter: 'blur(2px)',
        }}
      />
      {/* Shiny sparkle */}
      {shiny && (
        <div
          className="absolute text-xs"
          style={{
            top: -2, right: -2,
            animation: 'buddy-sparkle 2s ease-in-out infinite',
            textShadow: `0 0 6px ${from}`,
          }}
        >✨</div>
      )}
    </div>
  )
}
