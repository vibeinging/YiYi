/**
 * CompanionEditDrawer — 编辑 / 归隐一只伙伴。
 *
 * 基础字段在主区，"⚙ 高级"折叠里放 persona 文本编辑、memory_user_id、统计。
 * 归隐按钮做二次确认 — 软归隐 30 天后自动 GC。
 */

import { useEffect, useState } from 'react'
import { X, ChevronDown, ChevronRight, Loader2, AlertTriangle } from 'lucide-react'
import {
  retireCompanion,
  updateCompanion,
  type Companion,
} from '../../api/companions'
import { formatYmd } from '../../utils/companion'
import { toast } from '../Toast'

interface Props {
  companion: Companion
  onClose: () => void
  onChanged: () => void
}

export function CompanionEditDrawer({ companion, onClose, onChanged }: Props) {
  const [name, setName] = useState(companion.name)
  const [emoji, setEmoji] = useState(companion.avatar_emoji)
  const [color, setColor] = useState(companion.color_hex)
  // persona_md_path content isn't read back yet (Phase 2). The textarea
  // is "replace if non-empty, leave alone if empty" — same semantics as
  // the adopt flow.
  const [personaMd, setPersonaMd] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [confirmRetire, setConfirmRetire] = useState(false)
  const [saving, setSaving] = useState(false)
  const [retiring, setRetiring] = useState(false)

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  const dirty =
    name.trim() !== companion.name ||
    emoji !== companion.avatar_emoji ||
    color !== companion.color_hex ||
    personaMd.length > 0

  async function save() {
    if (saving) return
    if (!name.trim()) {
      toast.error('名字不能为空')
      return
    }
    setSaving(true)
    try {
      await updateCompanion(companion.id, {
        name: name.trim() !== companion.name ? name.trim() : undefined,
        avatar_emoji: emoji !== companion.avatar_emoji ? emoji : undefined,
        color_hex: color !== companion.color_hex ? color : undefined,
        persona_md: personaMd.length > 0 ? personaMd : undefined,
      })
      toast.success('保存成功')
      onChanged()
      onClose()
    } catch (e) {
      toast.error(`保存失败：${e}`)
    } finally {
      setSaving(false)
    }
  }

  async function retire() {
    if (retiring) return
    setRetiring(true)
    try {
      await retireCompanion(companion.id)
      toast.success(`${companion.name} 已归隐 · 30 天内可恢复`)
      onChanged()
      onClose()
    } catch (e) {
      toast.error(`归隐失败：${e}`)
      setRetiring(false)
    }
  }

  const accent = color || 'var(--color-text-muted)'

  return (
    <>
      <div className="fixed inset-0 bg-black/30 backdrop-blur-sm z-40" onClick={onClose} />
      <div
        className="fixed right-0 top-0 bottom-0 z-50 overflow-y-auto bg-[var(--color-bg-elevated)] shadow-2xl"
        style={{
          width: 'min(440px, 100vw)',
          animation: 'companion-drawer-slide 220ms cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center text-[20px]" style={{ background: `${accent}22` }}>
              {emoji}
            </div>
            <div>
              <div className="font-semibold text-[15px]" style={{ color: 'var(--color-text)' }}>{name || companion.name}</div>
              <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>编辑伙伴</div>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-[var(--color-bg-subtle)] rounded-xl">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-5">
          <Field label="头像">
            <input
              value={emoji}
              maxLength={4}
              onChange={e => setEmoji(e.target.value)}
              className="w-20 text-center text-[24px] py-2 rounded-xl outline-none"
              style={{ background: 'var(--color-bg-subtle)' }}
            />
          </Field>

          <Field label="名字">
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              maxLength={24}
              className="w-full px-3 py-2 rounded-xl text-[14px] outline-none"
              style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text)' }}
            />
          </Field>

          <Field label="主色">
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={color}
                onChange={e => setColor(e.target.value)}
                className="w-12 h-9 rounded cursor-pointer border border-[var(--color-border)]"
              />
              <input
                value={color}
                onChange={e => setColor(e.target.value)}
                placeholder="#F97316"
                maxLength={7}
                className="flex-1 px-3 py-2 rounded-xl text-[13px] outline-none font-mono"
                style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text)' }}
              />
            </div>
          </Field>

          <Stat label="收养于" value={formatYmd(companion.adopted_at)} />
          <Stat label="一起做过" value={`${companion.invocation_count} 件事`} />
          {companion.last_used_at && (
            <Stat label="最近一次" value={formatYmd(companion.last_used_at)} />
          )}

          {/* ── 高级折叠 ────────────────────────────────────────── */}
          <button
            onClick={() => setAdvancedOpen(o => !o)}
            className="flex items-center gap-2 text-[12px] py-2"
            style={{ color: 'var(--color-text-muted)' }}
          >
            {advancedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            高级（角色模板 · 人格文本 · 隔离 bucket）
          </button>

          {advancedOpen && (
            <div className="space-y-4 pl-1">
              <Stat label="角色模板" value={companion.agent_definition_name} mono />
              <Stat label="记忆桶 (MemMe)" value={companion.memory_user_id} mono />
              {companion.persona_md_path && (
                <Stat label="人格文件" value={companion.persona_md_path} mono />
              )}

              <Field
                label="人格文本（替换现有，留空 = 不动）"
                hint="文件落在 ~/.yiyi/companions/<id>/persona.md。可写性格描述、口头禅、不该做的事。"
              >
                <textarea
                  value={personaMd}
                  onChange={e => setPersonaMd(e.target.value)}
                  rows={8}
                  placeholder="例：你是阿狸，专注代码评审。看见 retry 没上界一定会怼。"
                  className="w-full px-3 py-2 rounded-xl text-[13px] outline-none font-mono leading-relaxed resize-y"
                  style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text)' }}
                />
              </Field>
            </div>
          )}

          {/* ── 归隐区 ──────────────────────────────────────────── */}
          <div className="pt-5 border-t border-[var(--color-border)]">
            {!confirmRetire ? (
              <button
                onClick={() => setConfirmRetire(true)}
                className="flex items-center gap-2 text-[13px] px-3 py-2 rounded-xl transition-colors hover:bg-[var(--color-bg-subtle)]"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                让 {companion.name} 归隐
              </button>
            ) : (
              <div className="p-4 rounded-xl space-y-3" style={{ background: 'var(--color-bg-subtle)' }}>
                <div className="flex items-start gap-2 text-[13px]" style={{ color: 'var(--color-text)' }}>
                  <AlertTriangle size={16} className="shrink-0 mt-0.5" style={{ color: '#F59E0B' }} />
                  <div>
                    归隐后 30 天内可在"已归隐"列表里找回；30 天后会彻底删除，包括 {companion.name} 的所有记忆。
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={retire}
                    disabled={retiring}
                    className="flex-1 px-3 py-2 rounded-lg text-[13px] font-medium transition-colors"
                    style={{ background: '#F59E0B', color: '#fff' }}
                  >
                    {retiring ? '归隐中…' : `确认让 ${companion.name} 归隐`}
                  </button>
                  <button
                    onClick={() => setConfirmRetire(false)}
                    className="px-3 py-2 rounded-lg text-[13px] hover:bg-[var(--color-bg-elevated)]"
                    style={{ color: 'var(--color-text-secondary)' }}
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="sticky bottom-0 px-5 py-3 border-t border-[var(--color-border)] bg-[var(--color-bg-elevated)] flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-[13px]"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            关闭
          </button>
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="flex items-center gap-1.5 px-5 py-2 rounded-xl text-[13px] font-medium disabled:opacity-30 transition-colors"
            style={{ background: accent, color: '#fff' }}
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            保存
          </button>
        </div>

        <style>{`
          @keyframes companion-drawer-slide {
            from { transform: translateX(100%); }
            to { transform: translateX(0); }
          }
        `}</style>
      </div>
    </>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[12px] mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>{label}</div>
      {hint && <div className="text-[11px] mb-1.5" style={{ color: 'var(--color-text-muted)' }}>{hint}</div>}
      {children}
    </div>
  )
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between text-[12px] gap-3">
      <span style={{ color: 'var(--color-text-muted)' }}>{label}</span>
      <span
        className={`truncate ${mono ? 'font-mono text-[11px]' : ''}`}
        style={{ color: 'var(--color-text-secondary)' }}
        title={value}
      >
        {value}
      </span>
    </div>
  )
}

