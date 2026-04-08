/**
 * VoiceButton — Mic toggle with animated states and permission check.
 */

import { useState, useCallback } from 'react'
import { Mic, MicOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { startVoiceSession, stopVoiceSession } from '../../api/voice'
import { useVoiceStore } from '../../stores/voiceStore'
import { PermissionGuide, usePermissions } from './PermissionGuide'

interface VoiceButtonProps {
  disabled?: boolean
}

export function VoiceButton({ disabled }: VoiceButtonProps) {
  const { t } = useTranslation()
  const status = useVoiceStore((s) => s.status)
  const setStatus = useVoiceStore((s) => s.setStatus)
  const setSessionId = useVoiceStore((s) => s.setSessionId)
  const setError = useVoiceStore((s) => s.setError)
  const reset = useVoiceStore((s) => s.reset)

  const [showGuide, setShowGuide] = useState(false)
  const { refresh } = usePermissions(['microphone'])

  const isActive = status !== 'idle' && status !== 'error'
  const isListening = status === 'listening'

  const doStart = useCallback(async () => {
    try {
      setStatus('connecting')
      const sid = await startVoiceSession()
      setSessionId(sid)
    } catch (e) {
      setError(String(e))
      setStatus('idle')
    }
  }, [setStatus, setSessionId, setError])

  const handleAllGranted = useCallback(() => {
    setShowGuide(false)
    doStart()
  }, [doStart])

  const toggle = useCallback(async () => {
    if (isActive) {
      try { await stopVoiceSession(); reset() } catch (e) { setError(String(e)) }
      return
    }
    const perms = await refresh()
    if (!perms?.microphone) { setShowGuide(true); return }
    doStart()
  }, [isActive, reset, setError, refresh, doStart])

  return (
    <>
      <button
        type="button"
        aria-label={t('voice.toggle', isActive ? 'Stop voice' : 'Start voice')}
        onClick={toggle}
        disabled={disabled && !isActive}
        className={`w-9 h-9 flex items-center justify-center rounded-xl shrink-0 relative disabled:opacity-30 ${
          isActive ? 'voice-recording' : ''
        } ${isListening ? 'voice-ring-pulse' : ''}`}
        style={{
          color: isActive ? '#FFFFFF' : 'var(--color-text-muted)',
          background: isActive ? 'var(--color-error, #FF453A)' : 'transparent',
          border: 'none',
          cursor: disabled && !isActive ? 'not-allowed' : 'pointer',
          transition: 'background 0.2s cubic-bezier(0.16, 1, 0.3, 1), color 0.15s ease',
        }}
        onMouseEnter={(e) => {
          if (!isActive) e.currentTarget.style.background = 'var(--color-bg-muted)'
        }}
        onMouseLeave={(e) => {
          if (!isActive) e.currentTarget.style.background = 'transparent'
        }}
        title={t('voice.toggle', isActive ? '停止语音' : '语音对话')}
      >
        {isActive ? <MicOff size={18} /> : <Mic size={18} />}
      </button>

      {showGuide && (
        <PermissionGuide
          require={['microphone']}
          onAllGranted={handleAllGranted}
          onDismiss={() => setShowGuide(false)}
        />
      )}
    </>
  )
}
