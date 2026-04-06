import React from 'react'

interface BuddyBubbleProps {
  text: string
  visible: boolean
  color?: string
  /** true = sprite is on the left side of the screen, bubble opens rightward */
  flipRight?: boolean
}

export const BuddyBubble: React.FC<BuddyBubbleProps> = ({ text, visible, color, flipRight }) => {
  if (!text) return null

  return (
    <div
      className="absolute bottom-full mb-4 pointer-events-none"
      style={{
        ...(flipRight ? { left: 0 } : { right: 0 }),
        animation: visible ? 'buddy-bubble-in 0.3s ease-out forwards' : 'buddy-bubble-out 0.3s ease-in forwards',
      }}
    >
      <div
        className="relative px-3 py-1.5 rounded-xl text-xs leading-relaxed whitespace-pre-wrap max-w-[200px] text-center"
        style={{
          background: 'var(--color-bg-elevated)',
          border: `1px solid ${color || 'var(--color-border)'}`,
          boxShadow: 'var(--shadow-md)',
          color: 'var(--color-text)',
          fontFamily: 'var(--font-text)',
          backdropFilter: 'blur(12px)',
        }}
      >
        {text}
        {/* Tail */}
        <div
          className="absolute top-full w-0 h-0"
          style={{
            ...(flipRight ? { left: 12 } : { right: 12 }),
            borderLeft: '6px solid transparent',
            borderRight: '6px solid transparent',
            borderTop: `6px solid ${color || 'var(--color-border)'}`,
          }}
        />
      </div>
    </div>
  )
}
