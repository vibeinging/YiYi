/**
 * CompanionDetail — 单个伙伴的详情页(微信式两栏的右栏,伙伴版)。
 *
 * 和 YiYi 的详情对齐:hero + 人设 + 独立记忆 + 一起做过 X 件事 + 归隐。
 * (性格 / 冥想 的 per-companion 后端在 B/C 期接入,这里先留位提示。)
 */

import { useState, useEffect, useCallback } from 'react'
import { Brain, Sprout, Save, Loader2, UserMinus, Sparkles } from 'lucide-react'
import { updateCompanion, retireCompanion, type Companion } from '../../api/companions'
import { listRecentMemories, type MemoryEntry } from '../../api/buddy'
import { toast, confirm } from '../Toast'

export function CompanionDetail({ companion, onChanged }: { companion: Companion; onChanged: () => void }) {
  const accent = companion.color_hex || 'var(--color-primary)'

  // 编辑态
  const [name, setName] = useState(companion.name)
  const [emoji, setEmoji] = useState(companion.avatar_emoji)
  const [color, setColor] = useState(companion.color_hex)
  const [role, setRole] = useState(companion.role_label ?? '')
  const [persona, setPersona] = useState('')
  const [saving, setSaving] = useState(false)

  // 切换伙伴时重置编辑态
  useEffect(() => {
    setName(companion.name)
    setEmoji(companion.avatar_emoji)
    setColor(companion.color_hex)
    setRole(companion.role_label ?? '')
    setPersona('')
  }, [companion.id])

  const dirty =
    name.trim() !== companion.name ||
    emoji !== companion.avatar_emoji ||
    color !== companion.color_hex ||
    role !== (companion.role_label ?? '') ||
    persona.trim().length > 0

  const save = async () => {
    if (!name.trim()) { toast.error('名字不能为空'); return }
    setSaving(true)
    try {
      await updateCompanion(companion.id, {
        name: name.trim() !== companion.name ? name.trim() : undefined,
        avatar_emoji: emoji !== companion.avatar_emoji ? emoji : undefined,
        color_hex: color !== companion.color_hex ? color : undefined,
        role_label: role !== (companion.role_label ?? '') ? role : undefined,
        persona_md: persona.trim().length > 0 ? persona : undefined,
      })
      toast.success('已保存')
      onChanged()
    } catch (e) {
      toast.error(`保存失败：${e}`)
    } finally {
      setSaving(false)
    }
  }

  const retire = async () => {
    const ok = await confirm(`让 ${companion.name} 归隐吗？30 天内可恢复，之后自动清理。`)
    if (!ok) return
    try {
      await retireCompanion(companion.id)
      toast.success(`${companion.name} 已归隐 · 30 天内可恢复`)
      onChanged()
    } catch (e) {
      toast.error(`归隐失败：${e}`)
    }
  }

  // 该伙伴的独立记忆(companion_{id} 桶)
  const [memories, setMemories] = useState<MemoryEntry[]>([])
  const loadMemories = useCallback(() => {
    listRecentMemories(12, companion.memory_user_id).then(setMemories).catch(() => setMemories([]))
  }, [companion.memory_user_id])
  useEffect(() => { loadMemories() }, [loadMemories])

  const adopted = new Date(companion.adopted_at).toLocaleDateString('zh-CN')

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[680px] mx-auto px-6 py-6 space-y-5">
        {/* ── Hero ── */}
        <div
          className="rounded-2xl px-5 py-5 flex items-center gap-4"
          style={{ background: `linear-gradient(135deg, ${color}1f, var(--color-bg-elevated))`, border: '1px solid var(--color-border)' }}
        >
          <div
            className="shrink-0 w-16 h-16 rounded-2xl flex items-center justify-center text-[34px]"
            style={{ background: `${color}26` }}
          >
            {emoji || '🤖'}
          </div>
          <div className="min-w-0">
            <div className="text-[18px] font-semibold" style={{ color: 'var(--color-text)' }}>{name || '伙伴'}</div>
            <div className="text-[12px] mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
              {role || '你的 AI 伙伴'}
            </div>
            <div className="text-[11px] mt-1.5" style={{ color: 'var(--color-text-muted)' }}>
              一起做过 {companion.invocation_count} 件事 · {adopted} 加入
            </div>
          </div>
        </div>

        {/* ── 人设编辑 ── */}
        <section
          className="rounded-2xl p-5"
          style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)' }}
        >
          <div className="flex items-center gap-2 mb-3">
            <Sparkles size={16} style={{ color: accent }} />
            <h3 className="font-semibold text-[14px]" style={{ color: 'var(--color-text)' }}>人设</h3>
          </div>
          <div className="flex items-center gap-2 mb-3">
            <input
              value={emoji}
              onChange={(e) => setEmoji(e.target.value)}
              className="w-12 h-10 text-center text-[20px] rounded-lg outline-none"
              style={{ background: 'var(--color-bg-subtle)', border: '1px solid var(--color-border)' }}
              maxLength={2}
            />
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="名字"
              className="flex-1 h-10 px-3 text-[14px] rounded-lg outline-none"
              style={{ background: 'var(--color-bg-subtle)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
            />
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="w-10 h-10 rounded-lg cursor-pointer bg-transparent border-0 p-0"
              title="主色"
            />
          </div>
          <input
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="擅长什么(一句话,如「找代码硬伤」)"
            className="w-full h-10 px-3 mb-3 text-[13px] rounded-lg outline-none"
            style={{ background: 'var(--color-bg-subtle)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
          />
          <textarea
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            placeholder="补充人设 / 说话风格 / 偏好…(留空则不改)"
            rows={4}
            className="w-full px-3 py-2 text-[13px] leading-relaxed rounded-lg outline-none resize-none"
            style={{ background: 'var(--color-bg-subtle)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
          />
          <div className="flex justify-end mt-3">
            <button
              onClick={save}
              disabled={!dirty || saving}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-medium transition-all disabled:opacity-40"
              style={{ background: accent, color: '#fff' }}
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              保存
            </button>
          </div>
        </section>

        {/* ── 独立记忆 ── */}
        <section
          className="rounded-2xl p-5"
          style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)' }}
        >
          <div className="flex items-center gap-2 mb-3">
            <Brain size={16} style={{ color: accent }} />
            <h3 className="font-semibold text-[14px]" style={{ color: 'var(--color-text)' }}>它的记忆</h3>
            <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>· 独立于 YiYi 和其它伙伴</span>
          </div>
          {memories.length === 0 ? (
            <p className="text-[12px] py-4 text-center" style={{ color: 'var(--color-text-muted)' }}>
              还没有记忆 —— 和它多聊聊,它会记住你们之间的事。
            </p>
          ) : (
            <ul className="space-y-2">
              {memories.map((m) => (
                <li
                  key={m.id}
                  className="text-[13px] px-3 py-2 rounded-lg leading-relaxed"
                  style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-secondary)' }}
                >
                  {m.content}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── 性格 / 冥想:per-companion 后端建设中(B/C 期)── */}
        <section
          className="rounded-2xl p-5 flex items-center gap-3"
          style={{ background: 'var(--color-bg-elevated)', border: '1px dashed var(--color-border)' }}
        >
          <Sprout size={16} style={{ color: 'var(--color-text-muted)' }} />
          <p className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
            它的<b>性格演化</b>和<b>冥想</b>正在为每位伙伴单独打造 —— 即将上线。
          </p>
        </section>

        {/* ── 归隐 ── */}
        <div className="flex justify-center pt-1 pb-4">
          <button
            onClick={retire}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-medium transition-colors"
            style={{ color: 'var(--color-error)', background: 'var(--color-error-subtle)' }}
          >
            <UserMinus size={14} />
            让 {companion.name} 归隐
          </button>
        </div>
      </div>
    </div>
  )
}
