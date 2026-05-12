/**
 * BuddySettingsDrawer — Right-side drawer for buddy preferences & actions.
 * Houses the obscure toggles (mute/hosted) that used to clutter the Hero,
 * plus meditation schedule and "let her organize" data actions.
 */

import { useEffect } from 'react'
import { Eye, EyeOff, Shield, X } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { useBuddyStore } from '../../stores/buddyStore'
import { toggleBuddyHosted } from '../../api/buddy'
import { proposeSkillsNow } from '../../api/inbox'
import { toast } from '../Toast'

interface BuddySettingsDrawerProps {
  open: boolean
  onClose: () => void
  accent: string
  meditationEnabled: boolean
  meditationStart: string
  onMeditationConfigChange: (enabled: boolean, startTime: string) => void
}

export function BuddySettingsDrawer({
  open,
  onClose,
  accent,
  meditationEnabled,
  meditationStart,
  onMeditationConfigChange,
}: BuddySettingsDrawerProps) {
  const { config, setMuted, hostedMode, setHostedMode } = useBuddyStore()
  const muted = config?.muted ?? false

  // Lock body scroll while open (best-effort; revert on close).
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  if (!open) return null

  const handleProposeNow = async () => {
    try {
      const r = await proposeSkillsNow()
      if (r.created_count === 0) {
        toast.info('她翻完最近的对话，暂时没什么想商量的')
      } else {
        toast.success(`她想跟你商量 ${r.created_count} 件事`)
      }
    } catch (e) {
      toast.error(`让她整理失败：${String(e)}`)
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        className="fixed inset-0 z-40"
        style={{ background: 'rgba(0,0,0,0.32)', backdropFilter: 'blur(2px)' }}
      />
      {/* Drawer panel */}
      <div
        className="fixed right-0 top-0 bottom-0 z-50 overflow-y-auto"
        style={{
          width: 360,
          background: 'var(--color-bg)',
          borderLeft: '1px solid var(--color-bg-subtle)',
          animation: 'buddy-drawer-slide 220ms cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        <div className="px-5 py-5">
          {/* Header */}
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-[15px] font-semibold" style={{ color: 'var(--color-text)' }}>
              她的设置
            </h2>
            <button onClick={onClose} className="p-1.5 rounded-md hover:bg-[var(--color-bg-subtle)] transition-colors">
              <X size={15} style={{ color: 'var(--color-text-muted)' }} />
            </button>
          </div>

          {/* Section: 状态 */}
          <SectionHeader>她现在</SectionHeader>
          <ToggleRow
            icon={muted ? <EyeOff size={14} /> : <Eye size={14} />}
            label="让她参与对话"
            hint="关闭后她会保持安静，不会主动出现"
            on={!muted}
            onChange={v => setMuted(!v)}
            accent={accent}
          />
          <ToggleRow
            icon={<Shield size={14} />}
            label="让她接管简单决策"
            hint="开启后她会用过去的反馈，自己做小决定"
            on={hostedMode}
            onChange={v => { setHostedMode(v); toggleBuddyHosted(v) }}
            accent={accent}
          />

          {/* Section: 冥想 */}
          <SectionHeader className="mt-6">冥想</SectionHeader>
          <ToggleRow
            label="每天定时冥想"
            hint={meditationEnabled ? `每天 ${meditationStart}，她会整理这一天` : '开启后她每天会自己整理一遍'}
            on={meditationEnabled}
            onChange={v => onMeditationConfigChange(v, meditationStart)}
            accent={accent}
          />
          {meditationEnabled && (
            <div className="flex items-center justify-between py-2 px-1 mb-1">
              <span className="text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>时间</span>
              <input
                type="time"
                value={meditationStart}
                onChange={e => onMeditationConfigChange(meditationEnabled, e.target.value)}
                className="text-[12px] px-2 py-1 rounded-md"
                style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text)', border: 'none' }}
              />
            </div>
          )}

          {/* Section: 让她想想 */}
          <SectionHeader className="mt-6">让她想想</SectionHeader>
          <button
            onClick={handleProposeNow}
            className="w-full text-left p-3 rounded-lg transition-colors hover:bg-[var(--color-bg-subtle)]"
            style={{ background: 'var(--color-bg-subtle)' }}
          >
            <div className="text-[13px] font-medium mb-0.5" style={{ color: 'var(--color-text)' }}>
              让她翻翻最近的对话
            </div>
            <div className="text-[11px] leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>
              看看有没有可以固化为技能的工作流程。
              她想到的会进 Inbox 等你审。
            </div>
          </button>

          {/* Footer hint */}
          <div className="mt-8 p-3 rounded-lg text-[11px] leading-relaxed" style={{
            background: `${accent}10`,
            color: 'var(--color-text-secondary)',
          }}>
            想学什么，她都会先问你。
          </div>
        </div>
      </div>

      <style>{`
        @keyframes buddy-drawer-slide {
          from { transform: translateX(100%); opacity: 0.4; }
          to { transform: translateX(0); opacity: 1; }
        }
      `}</style>
    </>
  )
}

function SectionHeader({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`text-[11px] font-medium uppercase tracking-wider mb-2 ${className}`}
      style={{ color: 'var(--color-text-muted)' }}>
      {children}
    </div>
  )
}

interface ToggleRowProps {
  icon?: React.ReactNode
  label: string
  hint?: string
  on: boolean
  onChange: (v: boolean) => void
  accent: string
}

function ToggleRow({ icon, label, hint, on, onChange, accent }: ToggleRowProps) {
  return (
    <button
      onClick={() => onChange(!on)}
      className="w-full flex items-start gap-3 py-2.5 px-1 mb-1 rounded-lg transition-colors hover:bg-[var(--color-bg-subtle)] text-left"
    >
      {icon && (
        <div className="shrink-0 mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
          {icon}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium" style={{ color: 'var(--color-text)' }}>
          {label}
        </div>
        {hint && (
          <div className="text-[11px] mt-0.5 leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>
            {hint}
          </div>
        )}
      </div>
      {/* iOS-style switch */}
      <div
        className="shrink-0 mt-0.5 relative rounded-full transition-colors"
        style={{
          width: 32,
          height: 18,
          background: on ? accent : 'var(--color-bg-muted)',
        }}
      >
        <div
          className="absolute top-0.5 rounded-full transition-all"
          style={{
            width: 14,
            height: 14,
            background: '#fff',
            left: on ? 16 : 2,
            boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
          }}
        />
      </div>
    </button>
  )
}
