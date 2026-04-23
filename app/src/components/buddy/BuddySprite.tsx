import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  PARTICLE_EMOJI,
  getSpeciesConfig,
  getSpeciesLabel,
} from '../../utils/buddy'
import { listen } from '@tauri-apps/api/event'
import { useBuddyStore } from '../../stores/buddyStore'
import { useChatStreamStore } from '../../stores/chatStreamStore'
import { getBuddyHosted } from '../../api/buddy'
import { getMorningGreeting } from '../../api/system'
import { BuddyBubble } from './BuddyBubble'
import { BuddyStatsCard } from './BuddyStatsCard'
import { BuddyHatchAnimation } from './BuddyHatchAnimation'
import { GrowthSuggestionsBubble } from './GrowthSuggestionsBubble'
import { OrbCore } from './OrbCore'
import { useGrowthSuggestionsStore } from '../../stores/growthSuggestionsStore'

const IDLE_ANIMATIONS: Record<string, string> = {
  breathe: 'buddy-breathe 3s ease-in-out infinite',
  bounce: 'buddy-bounce 2.5s ease-in-out infinite',
  float: 'buddy-breathe 4s ease-in-out infinite',
  sway: 'buddy-fidget 4s ease-in-out infinite',
  pulse: 'buddy-breathe 2s ease-in-out infinite',
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
    bubbleText, bubbleVisible, petting, pet, showBubble,
    showStats, setShowStats, showHatchAnimation,
    hostedMode, setHostedMode,
  } = useBuddyStore()

  const isWorking = useChatStreamStore(s => s.loading)
  const hasError = useChatStreamStore(s => !!s.errorMessage)

  const [fidget, setFidget] = useState(false)
  const [particles, setParticles] = useState<{ id: number; x: number; y: number; emoji: string }[]>([])
  const particleIdRef = useRef(0)

  // Growth suggestions: badge count + pop-out bubble
  const growthCount = useGrowthSuggestionsStore((s) => s.visiblePending().length)
  const [showGrowth, setShowGrowth] = useState(false)

  // Drag state
  const [position, setPosition] = useState<{ x: number; y: number }>(() => {
    const saved = loadSavedPosition()
    if (saved) return clampPosition(saved.x, saved.y)
    // Default: bottom-right corner
    return { x: window.innerWidth - 80, y: window.innerHeight - 140 }
  })
  const positionRef = useRef(position)
  positionRef.current = position
  const draggingRef = useRef(false)
  const dragStartRef = useRef({ mouseX: 0, mouseY: 0, posX: 0, posY: 0 })
  const hasDraggedRef = useRef(false)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return // left button only
    e.preventDefault() // prevent text selection during drag
    draggingRef.current = true
    hasDraggedRef.current = false
    dragStartRef.current = { mouseX: e.clientX, mouseY: e.clientY, posX: positionRef.current.x, posY: positionRef.current.y }
  }, [])

  // Window-level drag tracking (avoids setPointerCapture which eats child clicks)
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!draggingRef.current) return
      const dx = e.clientX - dragStartRef.current.mouseX
      const dy = e.clientY - dragStartRef.current.mouseY
      if (!hasDraggedRef.current && Math.abs(dx) + Math.abs(dy) < 5) return
      hasDraggedRef.current = true
      const newPos = clampPosition(dragStartRef.current.posX + dx, dragStartRef.current.posY + dy)
      setPosition(newPos)
    }
    const onUp = (e: PointerEvent) => {
      if (!draggingRef.current) return
      draggingRef.current = false
      if (hasDraggedRef.current) {
        const newPos = clampPosition(
          dragStartRef.current.posX + e.clientX - dragStartRef.current.mouseX,
          dragStartRef.current.posY + e.clientY - dragStartRef.current.mouseY
        )
        setPosition(newPos)
        localStorage.setItem(BUDDY_POS_KEY, JSON.stringify(newPos))
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
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
  useEffect(() => { getBuddyHosted().then(h => setHostedMode(h)).catch(() => {}) }, [setHostedMode])

  // Proactive greeting on launch
  const greetedRef = useRef(false)
  useEffect(() => {
    if (!companion || config?.muted || greetedRef.current) return
    greetedRef.current = true
    const timer = setTimeout(() => {
      getMorningGreeting().then(greeting => {
        if (greeting) {
          showBubble(greeting)
        } else {
          const h = new Date().getHours()
          const timeGreet = h < 6 ? '夜深了，注意休息~' : h < 12 ? '早上好！今天也一起加油吧' : h < 18 ? '下午好~' : '晚上好！'
          showBubble(timeGreet)
        }
      }).catch(() => {
        const h = new Date().getHours()
        const timeGreet = h < 6 ? '夜深了~' : h < 12 ? '早上好！' : h < 18 ? '下午好~' : '晚上好！'
        showBubble(timeGreet)
      })
    }, 2000) // 2s delay for smooth entrance
    return () => clearTimeout(timer)
  }, [companion, config?.muted])

  // Event-driven notifications
  useEffect(() => {
    if (!companion || config?.muted) return
    const bubble = useBuddyStore.getState().showBubble

    const promises = [
      listen<{ platform?: string; sender?: string }>('bot://message', (e) => {
        const who = e.payload.sender || e.payload.platform || '某人'
        bubble(`${who} 发来了消息`)
      }),
      listen<{ name?: string }>('cronjob://result', (e) => {
        bubble(`${e.payload?.name || '定时任务'} 执行完成！`)
      }),
      listen('growth://persist_suggestion', () => {
        bubble('发现了可以改进的技能！')
      }),
    ]

    return () => { promises.forEach(p => p.then(u => u())) }
  }, [companion, config?.muted])

  // Random fidget — MISCHIEF stat increases frequency
  useEffect(() => {
    if (!companion || config?.muted) return
    const mischief = companion.stats.MISCHIEF ?? 50
    const fidgetChance = 0.08 + (mischief / 100) * 0.2 // 8%~28% based on mischief
    const interval = setInterval(() => {
      if (Math.random() < fidgetChance) {
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

  // Determine visual mood
  type BuddyMood = 'muted' | 'petting' | 'talking' | 'working' | 'error' | 'fidget' | 'idle'
  let mood: BuddyMood = 'idle'
  if (muted) mood = 'muted'
  else if (petting) mood = 'petting'
  else if (bubbleVisible) mood = 'talking'
  else if (hasError) mood = 'error'
  else if (isWorking) mood = 'working'
  else if (fidget) mood = 'fidget'

  let animStyle: React.CSSProperties
  let glowOverride: number | undefined
  let opacityOverride: number | undefined
  let filterOverride: string | undefined

  switch (mood) {
    case 'muted':
      animStyle = {}; opacityOverride = 0.3; filterOverride = 'grayscale(0.6) brightness(0.5)'; break
    case 'petting':
      animStyle = { animation: 'buddy-fidget 0.3s ease-in-out 3' }; break
    case 'talking':
      animStyle = { animation: 'buddy-bounce 1.2s ease-in-out infinite' }; break
    case 'working':
      animStyle = { animation: 'buddy-breathe 1.2s ease-in-out infinite' }; glowOverride = speciesConfig.glowSpread * 1.5; break
    case 'error':
      animStyle = { animation: 'buddy-breathe 4s ease-in-out infinite' }; opacityOverride = 0.5; filterOverride = 'saturate(0.4)'; break
    case 'fidget':
      animStyle = { animation: 'buddy-fidget 0.6s ease-in-out 1' }; break
    default:
      animStyle = { animation: IDLE_ANIMATIONS[bones.idleStyle] || IDLE_ANIMATIONS.breathe }
  }

  // Bubble/card should flip to right side when sprite is on the left half
  const flipRight = position.x < window.innerWidth / 2

  const handleClick = (e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (hasDraggedRef.current) return // ignore click after drag
    pet()
  }

  const handleContext = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    setShowStats(!showStats)
  }

  return (
    <div
      className="fixed z-[9990]"
      style={{ left: position.x, top: position.y, pointerEvents: 'none' }}
    >
      <div
        className="relative"
        style={{ pointerEvents: 'auto', cursor: draggingRef.current ? 'grabbing' : 'grab' }}
        onPointerDown={onPointerDown}
      >
        {showStats && (
          <div onPointerDown={e => e.stopPropagation()}>
            <BuddyStatsCard companion={companion} onClose={() => setShowStats(false)} flipRight={flipRight} />
          </div>
        )}
        {showGrowth && (
          <GrowthSuggestionsBubble onClose={() => setShowGrowth(false)} flipRight={flipRight} />
        )}
        {bubbleText && !showGrowth && <BuddyBubble text={bubbleText} visible={bubbleVisible} color={accentColor} flipRight={flipRight} />}

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
            opacity: opacityOverride ?? 1,
            filter: filterOverride ?? 'none',
          }}
          onClick={handleClick}
          onContextMenu={handleContext}
          title={`${companion.name} · 右键查看属性`}
        >
          {/* Hosted mode green ambient glow */}
          {hostedMode && !muted && (
            <div
              className="absolute inset-0 rounded-full"
              style={{
                background: 'radial-gradient(circle, rgba(52,211,153,0.35) 0%, rgba(52,211,153,0.08) 60%, transparent 80%)',
                transform: 'scale(2.2)',
                animation: 'buddy-breathe 2.5s ease-in-out infinite',
                pointerEvents: 'none',
              }}
            />
          )}
          <OrbCore
            from={companion.palette.from}
            to={companion.palette.to}
            css={speciesConfig.css}
            glow={glowOverride ?? (muted ? 4 : speciesConfig.glowSpread)}
            size={36}
            shiny={!muted && companion.shiny}
          />

          {/* Growth suggestions badge ✨ */}
          {growthCount > 0 && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setShowGrowth((v) => !v)
              }}
              className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full flex items-center justify-center text-[10px] font-bold"
              style={{
                background: 'linear-gradient(135deg, #A78BFA, #6366F1)',
                color: '#fff',
                boxShadow: '0 0 10px rgba(167,139,250,0.7)',
                animation: 'buddy-breathe 2s ease-in-out infinite',
                pointerEvents: 'auto',
                cursor: 'pointer',
              }}
              title={`${growthCount} 个成长建议`}
            >
              {growthCount > 9 ? '9+' : growthCount}
            </button>
          )}
        </div>

        {/* Name label */}
        <div
          className="text-center mt-0.5 text-xs font-medium truncate max-w-[80px] transition-opacity duration-300"
          style={{ color: accentColor, cursor: 'pointer', pointerEvents: 'auto', opacity: opacityOverride ?? 1 }}
          onClick={() => setShowStats(!showStats)}
        >
          {companion.name}
        </div>

      </div>
    </div>
  )
}
