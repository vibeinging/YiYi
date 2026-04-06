import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  PARTICLE_EMOJI,
  COMPANION_COLOR,
  getSpeciesConfig,
  getSpeciesLabel,
} from '../../utils/buddy'
import { useBuddyStore } from '../../stores/buddyStore'
import { BuddyBubble } from './BuddyBubble'
import { BuddyStatsCard } from './BuddyStatsCard'
import { BuddyHatchAnimation } from './BuddyHatchAnimation'

const IDLE_ANIMATIONS: Record<string, string> = {
  breathe: 'buddy-breathe 3s ease-in-out infinite',
  bounce: 'buddy-bounce 2.5s ease-in-out infinite',
  float: 'buddy-breathe 4s ease-in-out infinite',
  sway: 'buddy-fidget 4s ease-in-out infinite',
  pulse: 'buddy-breathe 2s ease-in-out infinite',
}

/** Renders the CSS light-orb sprite for a companion */
const OrbVisual: React.FC<{ from: string; to: string; css: string; glow: number; size: number; shiny?: boolean }> = ({
  from, to, css, glow, size, shiny,
}) => {
  // Parse shape style from css string
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
      {/* Outer glow */}
      <div
        className="absolute inset-0"
        style={{
          ...shapeStyle,
          background: `radial-gradient(circle, ${from}40 0%, transparent 70%)`,
          transform: `scale(${1 + glow / size})`,
          filter: `blur(${glow * 0.4}px)`,
        }}
      />
      {/* Core orb */}
      <div
        className="absolute inset-0"
        style={{
          ...shapeStyle,
          background: `radial-gradient(circle at 35% 35%, ${from}, ${to})`,
          boxShadow: `0 0 ${glow}px ${from}80, inset 0 0 ${glow * 0.5}px ${from}60`,
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

const BUDDY_POS_KEY = 'buddy-sprite-position'

function loadSavedPosition(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(BUDDY_POS_KEY)
    if (raw) {
      const pos = JSON.parse(raw)
      if (typeof pos.x === 'number' && typeof pos.y === 'number') return pos
    }
  } catch { /* ignore */ }
  return null
}

function clampPosition(x: number, y: number): { x: number; y: number } {
  const maxX = window.innerWidth - 60
  const maxY = window.innerHeight - 60
  return { x: Math.max(0, Math.min(x, maxX)), y: Math.max(0, Math.min(y, maxY)) }
}

export const BuddySprite: React.FC = () => {
  const {
    companion, bones, config, loaded, loadBuddy,
    bubbleText, bubbleVisible, petting, pet,
    showStats, setShowStats, showHatchAnimation,
  } = useBuddyStore()

  const [fidget, setFidget] = useState(false)
  const [particles, setParticles] = useState<{ id: number; x: number; y: number; emoji: string }[]>([])
  const particleIdRef = useRef(0)

  // Drag state
  const [position, setPosition] = useState<{ x: number; y: number }>(() => {
    const saved = loadSavedPosition()
    if (saved) return clampPosition(saved.x, saved.y)
    // Default: bottom-right corner
    return { x: window.innerWidth - 80, y: window.innerHeight - 140 }
  })
  const draggingRef = useRef(false)
  const dragStartRef = useRef({ mouseX: 0, mouseY: 0, posX: 0, posY: 0 })
  const hasDraggedRef = useRef(false)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return // left button only
    e.currentTarget.setPointerCapture(e.pointerId)
    draggingRef.current = true
    hasDraggedRef.current = false
    dragStartRef.current = { mouseX: e.clientX, mouseY: e.clientY, posX: position.x, posY: position.y }
  }, [position])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggingRef.current) return
    const dx = e.clientX - dragStartRef.current.mouseX
    const dy = e.clientY - dragStartRef.current.mouseY
    if (!hasDraggedRef.current && Math.abs(dx) + Math.abs(dy) < 5) return
    hasDraggedRef.current = true
    const newPos = clampPosition(dragStartRef.current.posX + dx, dragStartRef.current.posY + dy)
    setPosition(newPos)
  }, [])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!draggingRef.current) return
    draggingRef.current = false
    if (hasDraggedRef.current) {
      // Save position
      const newPos = clampPosition(
        dragStartRef.current.posX + e.clientX - dragStartRef.current.mouseX,
        dragStartRef.current.posY + e.clientY - dragStartRef.current.mouseY
      )
      setPosition(newPos)
      localStorage.setItem(BUDDY_POS_KEY, JSON.stringify(newPos))
    }
  }, [])

  // Re-clamp on window resize
  useEffect(() => {
    const onResize = () => setPosition(prev => {
      const clamped = clampPosition(prev.x, prev.y)
      localStorage.setItem(BUDDY_POS_KEY, JSON.stringify(clamped))
      return clamped
    })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => { if (!loaded) loadBuddy() }, [loaded, loadBuddy])

  // Random fidget
  useEffect(() => {
    if (!companion || config?.muted) return
    const interval = setInterval(() => {
      if (Math.random() < 0.15) {
        setFidget(true)
        setTimeout(() => setFidget(false), 600)
      }
    }, 3000)
    return () => clearInterval(interval)
  }, [companion, config?.muted])

  // Ambient particles
  useEffect(() => {
    if (!bones || config?.muted) return
    const particleSet = PARTICLE_EMOJI[bones.particle]
    if (particleSet.length === 0) return
    const interval = setInterval(() => {
      const id = particleIdRef.current++
      const emoji = particleSet[Math.floor(Math.random() * particleSet.length)]
      const x = -20 + Math.random() * 40
      const y = Math.random() * -10
      setParticles((prev) => [...prev.slice(-4), { id, x, y, emoji }])
      setTimeout(() => setParticles((prev) => prev.filter((p) => p.id !== id)), 3000)
    }, 2500 + Math.random() * 2000)
    return () => clearInterval(interval)
  }, [bones, config?.muted])

  if (!loaded) return null
  if (showHatchAnimation && bones && !companion) return <BuddyHatchAnimation />
  if (!companion || !bones) return null

  const muted = config?.muted ?? false
  const accentColor = companion.palette.from
  const speciesConfig = getSpeciesConfig(companion.species)
  const scale = companion.sizeScale

  let animStyle: React.CSSProperties
  if (muted) {
    animStyle = {}
  } else if (petting) {
    animStyle = { animation: 'buddy-fidget 0.3s ease-in-out 3' }
  } else if (bubbleVisible) {
    animStyle = { animation: 'buddy-bounce 1.2s ease-in-out infinite' }
  } else if (fidget) {
    animStyle = { animation: 'buddy-fidget 0.6s ease-in-out 1' }
  } else {
    animStyle = { animation: IDLE_ANIMATIONS[bones.idleStyle] || IDLE_ANIMATIONS.breathe }
  }

  // Bubble/card should flip to right side when sprite is on the left half
  const flipRight = position.x < window.innerWidth / 2

  const handleClick = (e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (hasDraggedRef.current) return // ignore click after drag
    pet()
  }
  const handleContext = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); setShowStats(!showStats) }

  return (
    <div
      className="fixed z-20"
      style={{ left: position.x, top: position.y, pointerEvents: 'none' }}
    >
      <div
        className="relative"
        style={{ pointerEvents: 'auto', cursor: draggingRef.current ? 'grabbing' : 'grab' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {showStats && <BuddyStatsCard companion={companion} onClose={() => setShowStats(false)} flipRight={flipRight} />}
        {bubbleText && <BuddyBubble text={bubbleText} visible={bubbleVisible} color={accentColor} flipRight={flipRight} />}

        {/* Floating Hearts */}
        {petting && (
          <div className="absolute -top-4 left-1/2 -translate-x-1/2 pointer-events-none">
            {[0, 1, 2].map((i) => (
              <span key={i} className="absolute text-sm" style={{
                animation: `buddy-heart-float 1.5s ease-out ${i * 0.3}s forwards`,
                left: `${(i - 1) * 14}px`,
              }}>❤️</span>
            ))}
          </div>
        )}

        {/* Ambient particles */}
        {particles.map((p) => (
          <span key={p.id} className="absolute text-xs pointer-events-none" style={{
            left: `calc(50% + ${p.x}px)`, top: `${p.y}px`,
            animation: 'buddy-heart-float 3s ease-out forwards', opacity: 0.7,
          }}>{p.emoji}</span>
        ))}

        {/* Orb Sprite */}
        <div
          className="relative cursor-pointer select-none transition-all duration-300"
          style={{
            ...animStyle,
            transform: `scale(${scale})`,
            transformOrigin: 'center bottom',
            opacity: muted ? 0.3 : 1,
            filter: muted ? 'grayscale(0.6) brightness(0.5)' : 'none',
          }}
          onClick={handleClick}
          onContextMenu={handleContext}
          title={`${companion.name} · 右键查看属性`}
        >
          <OrbVisual
            from={companion.palette.from}
            to={companion.palette.to}
            css={speciesConfig.css}
            glow={muted ? 4 : speciesConfig.glowSpread}
            size={36}
            shiny={!muted && companion.shiny}
          />
        </div>

        {/* Name label */}
        <div
          className="text-center mt-0.5 text-xs font-medium truncate max-w-[80px] transition-opacity duration-300"
          style={{ color: accentColor, cursor: 'pointer', pointerEvents: 'auto', opacity: muted ? 0.3 : 1 }}
          onClick={() => setShowStats(!showStats)}
        >
          {companion.name}
        </div>
      </div>
    </div>
  )
}
