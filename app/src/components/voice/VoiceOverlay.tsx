/**
 * VoiceOverlay — Floating panel during an active voice session.
 * Animated entrance/exit, live waveform, transcripts, and tool feedback.
 */

import { useEffect, useState, useCallback } from 'react'
import { Loader2, X, Wrench } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { stopVoiceSession, onVoiceStatus, onVoiceTranscript, onVoiceToolCall } from '../../api/voice'
import type { VoiceStatus } from '../../api/voice'
import { useVoiceStore } from '../../stores/voiceStore'

function StatusIndicator({ status }: { status: VoiceStatus }) {
  switch (status) {
    case 'listening':
      return (
        <div className="voice-waveform">
          <span /><span /><span /><span /><span />
        </div>
      )
    case 'thinking':
      return <Loader2 size={22} className="animate-spin" style={{ color: 'var(--color-primary)' }} />
    case 'speaking':
      return (
        <div className="voice-waveform speaking">
          <span /><span /><span /><span /><span />
        </div>
      )
    case 'connecting':
      return (
        <div className="voice-connecting-dots" style={{ display: 'flex', gap: 4 }}>
          <span /><span /><span />
        </div>
      )
    default:
      return <Loader2 size={22} className="animate-spin" style={{ color: 'var(--color-text-muted)' }} />
  }
}

export function VoiceOverlay() {
  const { t } = useTranslation()
  const status = useVoiceStore((s) => s.status)
  const userTranscript = useVoiceStore((s) => s.userTranscript)
  const assistantTranscript = useVoiceStore((s) => s.assistantTranscript)
  const activeTools = useVoiceStore((s) => s.activeTools)
  const error = useVoiceStore((s) => s.error)

  const setStatus = useVoiceStore((s) => s.setStatus)
  const setUserTranscript = useVoiceStore((s) => s.setUserTranscript)
  const appendAssistantTranscript = useVoiceStore((s) => s.appendAssistantTranscript)
  const setAssistantTranscript = useVoiceStore((s) => s.setAssistantTranscript)
  const addTool = useVoiceStore((s) => s.addTool)
  const setError = useVoiceStore((s) => s.setError)
  const reset = useVoiceStore((s) => s.reset)

  const [visible, setVisible] = useState(false)
  const [exiting, setExiting] = useState(false)

  // Show/hide with animation
  useEffect(() => {
    if (status !== 'idle') {
      setVisible(true)
      setExiting(false)
    } else if (visible) {
      setExiting(true)
      const timer = setTimeout(() => {
        setVisible(false)
        setExiting(false)
      }, 250)
      return () => clearTimeout(timer)
    }
  }, [status, visible])

  useEffect(() => {
    const promises = [
      onVoiceStatus((e) => {
        setStatus(e.status)
        if (e.error) setError(e.error)
        if (e.status === 'idle') reset()
      }),
      onVoiceTranscript((e) => {
        if (e.type === 'user' && e.final) {
          setUserTranscript(e.text)
        } else if (e.type === 'assistant') {
          if (e.final) setAssistantTranscript(e.text)
          else appendAssistantTranscript(e.text)
        }
      }),
      onVoiceToolCall((e) => {
        addTool(e.name, e.status, e.preview)
      }),
    ]
    return () => { promises.forEach((p) => p.then((u) => u())) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleClose = useCallback(async () => {
    try { await stopVoiceSession() } catch {}
    reset()
  }, [reset])

  if (!visible) return null

  const statusLabel: Record<string, string> = {
    connecting: t('voice.connecting', '连接中'),
    listening: t('voice.listening', '聆听中'),
    thinking: t('voice.thinking', '思考中'),
    speaking: t('voice.speaking', '说话中'),
    error: t('voice.error', '出错了'),
  }

  return (
    <div
      className={exiting ? 'voice-overlay-exit' : 'voice-overlay-enter'}
      style={{
        position: 'fixed',
        bottom: 96,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 50,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 12,
        padding: '16px 24px',
        borderRadius: 'var(--radius-xl)',
        background: 'var(--color-bg-elevated)',
        border: '1px solid var(--color-border)',
        boxShadow: 'var(--shadow-lg, 0 8px 32px rgba(0,0,0,0.16))',
        backdropFilter: 'blur(24px) saturate(1.2)',
        minWidth: 320,
        maxWidth: 480,
      }}
    >
      {/* Close button */}
      <button
        onClick={handleClose}
        className="absolute top-2 right-2 w-6 h-6 flex items-center justify-center rounded-full"
        style={{
          color: 'var(--color-text-muted)',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          transition: 'background var(--transition-fast)',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)' }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
      >
        <X size={14} />
      </button>

      {/* Status indicator + label */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <StatusIndicator status={status} />
        <span
          className="text-sm font-medium"
          style={{
            color: 'var(--color-text)',
            transition: 'color var(--transition-fast)',
          }}
        >
          {statusLabel[status] || status}
        </span>
      </div>

      {/* User transcript */}
      {userTranscript && (
        <div className="w-full text-right voice-bubble-in">
          <span
            style={{
              display: 'inline-block',
              padding: '6px 12px',
              borderRadius: 'var(--radius-lg)',
              background: 'var(--color-primary)',
              color: '#FFFFFF',
              fontSize: 13,
              maxWidth: '90%',
            }}
          >
            {userTranscript}
          </span>
        </div>
      )}

      {/* Assistant transcript */}
      {assistantTranscript && (
        <div className="w-full text-left voice-bubble-in">
          <span
            style={{
              display: 'inline-block',
              padding: '6px 12px',
              borderRadius: 'var(--radius-lg)',
              background: 'var(--color-bg-muted, rgba(255,255,255,0.06))',
              color: 'var(--color-text)',
              fontSize: 13,
              maxWidth: '90%',
            }}
          >
            {assistantTranscript}
          </span>
        </div>
      )}

      {/* Active tools */}
      {activeTools.length > 0 && (
        <div style={{ width: '100%', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {activeTools.map((tool, i) => (
            <span
              key={`${tool.name}-${i}`}
              className="voice-tool-chip-in"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 8px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--color-bg-muted, rgba(255,255,255,0.06))',
                color: 'var(--color-text-secondary)',
                fontSize: 11,
              }}
            >
              <Wrench size={10} />
              {tool.name}
              {tool.status === 'start' && <Loader2 size={10} className="animate-spin" />}
            </span>
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <div
          className="voice-bubble-in"
          style={{
            width: '100%',
            fontSize: 12,
            padding: '4px 8px',
            borderRadius: 'var(--radius-sm)',
            background: 'rgba(255, 69, 58, 0.1)',
            color: 'var(--color-error)',
          }}
        >
          {error}
        </div>
      )}
    </div>
  )
}
