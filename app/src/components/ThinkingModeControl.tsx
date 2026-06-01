/**
 * ThinkingModeControl — DeepSeek 思考模式的统一三档控件(关 / 高 / 最高)。
 *
 * 一条无冗余的轴,把官方的两个参数压在一起:
 *   关   → thinking:{type:disabled}
 *   高   → thinking:{type:enabled} + reasoning_effort:"high"
 *   最高 → thinking:{type:enabled} + reasoning_effort:"max"
 * (reasoning_effort 从属于 enable_thinking:关了程度就无意义,故三档而非两控件。)
 *
 * - `ThinkingModeSegments`:纯展示的分段选择器(受控,props value/onChange)。
 * - `GlobalThinkingControl`:自管「全局默认」—— get/set_thinking_effort 命令。
 *   两个模型设置页(Models / SetupWizard StepModel)用它。
 *   每窗口覆盖(聊天 header)将用受控的 `ThinkingModeSegments` + per-session 命令。
 */

import { useEffect, useState } from 'react'
import { Brain } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'

export type ThinkingMode = 'off' | 'high' | 'max'

const OPTS: { value: ThinkingMode; zh: string; en: string }[] = [
  { value: 'off', zh: '不思考', en: 'Off' },
  { value: 'high', zh: '思考', en: 'Think' },
  { value: 'max', zh: '深思', en: 'Deep' },
]

export function ThinkingModeSegments({
  value,
  onChange,
  lang = 'zh',
}: {
  value: ThinkingMode
  onChange: (v: ThinkingMode) => void
  lang?: string
}) {
  return (
    <div
      className="inline-flex rounded-xl p-0.5 gap-0.5"
      style={{ background: 'var(--color-bg-subtle)', border: '1px solid var(--color-border)' }}
    >
      {OPTS.map(o => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className="px-3 py-1 rounded-lg text-[12px] font-medium transition-colors"
            style={{
              background: active ? 'var(--color-primary)' : 'transparent',
              color: active ? '#fff' : 'var(--color-text-muted)',
            }}
          >
            {lang === 'zh' ? o.zh : o.en}
          </button>
        )
      })}
    </div>
  )
}

/** 会话级思考覆盖(per-window):紧凑循环按钮,放聊天 header。
 *  4 态:跟随全局 → 不思考 → 思考 → 深思 → 跟随。`global` 写回 null(清除覆盖)。 */
type SessionMode = 'global' | 'off' | 'high' | 'max'
const SESSION_ORDER: SessionMode[] = ['global', 'off', 'high', 'max']
const SESSION_LABEL: Record<SessionMode, { zh: string; en: string }> = {
  global: { zh: '思考·跟随', en: 'Think: auto' },
  off: { zh: '不思考', en: 'No think' },
  high: { zh: '思考', en: 'Think' },
  max: { zh: '深思', en: 'Deep' },
}

export function SessionThinkingControl({ sessionId, lang = 'zh' }: { sessionId: string; lang?: string }) {
  const [mode, setMode] = useState<SessionMode>('global')
  useEffect(() => {
    let alive = true
    invoke<string | null>('get_session_thinking', { sessionId })
      .then(v => {
        if (!alive) return
        setMode(v === 'off' || v === 'high' || v === 'max' ? v : 'global')
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [sessionId])
  const cycle = () => {
    const next = SESSION_ORDER[(SESSION_ORDER.indexOf(mode) + 1) % SESSION_ORDER.length]
    setMode(next)
    invoke('set_session_thinking', { sessionId, mode: next === 'global' ? null : next }).catch(() => {})
  }
  const isGlobal = mode === 'global'
  return (
    <button
      type="button"
      onClick={cycle}
      className="h-7 px-2 flex items-center gap-1 rounded-lg text-[11px] font-medium transition-colors shrink-0"
      style={{
        color: isGlobal ? 'var(--color-text-muted)' : 'var(--color-primary)',
        background: isGlobal ? 'transparent' : 'var(--color-bg-muted)',
      }}
      title={lang === 'zh'
        ? '本窗口的思考模式(点击切换)。「跟随」= 用全局默认;关/思考/深思 = 只覆盖这个对话窗口。'
        : "This window's thinking mode (click to cycle). Auto = global default; others override only this chat."}
    >
      <Brain size={13} />
      <span>{lang === 'zh' ? SESSION_LABEL[mode].zh : SESSION_LABEL[mode].en}</span>
    </button>
  )
}

/** 全局默认思考模式控件 —— 自己读写 get/set_thinking_effort。 */
export function GlobalThinkingControl({ lang = 'zh' }: { lang?: string }) {
  const [mode, setMode] = useState<ThinkingMode>('high')
  useEffect(() => {
    invoke<string>('get_thinking_effort')
      .then(v => {
        if (v === 'off' || v === 'high' || v === 'max') setMode(v)
      })
      .catch(() => {})
  }, [])
  const change = (v: ThinkingMode) => {
    setMode(v)
    invoke('set_thinking_effort', { effort: v }).catch(() => {})
  }
  return (
    <div
      className="rounded-2xl px-5 py-4"
      style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)' }}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Brain size={16} style={{ color: 'var(--color-primary)' }} />
            <span className="font-semibold text-[14px]" style={{ color: 'var(--color-text)' }}>
              {lang === 'zh' ? '深度思考(全局默认)' : 'Deep Thinking (global default)'}
            </span>
          </div>
          <p className="text-[12px] mt-1 ml-[24px]" style={{ color: 'var(--color-text-muted)' }}>
            {lang === 'zh'
              ? '开启后回答更稳但更慢、更费 token;关掉则快速回复。「深思」用最高思考强度。每个对话窗口可在顶栏单独覆盖。'
              : 'On = steadier but slower & more tokens; off = fast replies. "Deep" uses max effort. Each chat can override in its header.'}
          </p>
        </div>
        <div className="shrink-0">
          <ThinkingModeSegments value={mode} onChange={change} lang={lang} />
        </div>
      </div>
    </div>
  )
}
