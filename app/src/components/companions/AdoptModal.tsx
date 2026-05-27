/**
 * AdoptModal — 4-step "收养一只伙伴" wizard.
 *
 * Steps: 头像 → 名字 → 擅长 → 脾气（带实时口吻预览）。
 * 文案故意走"养电子精灵"叙事 — 不能露出 "Agent" / "Persona" / "Bot"。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Loader2, Shuffle, ArrowRight, ArrowLeft } from 'lucide-react'
import { adoptCompanion, previewPersonaTone } from '../../api/companions'
import { toast } from '../Toast'

interface Props {
  onClose: () => void
  onAdopted: () => void
  /** Pre-fills name / emoji / role from a propose_companion draft. */
  initialDraft?: {
    name?: string
    avatar_emoji?: string
    agent_definition_name?: string
    /** Free-text "擅长" label from the draft — pre-fills the customRole input. */
    role_label?: string
  }
  /** When opening to edit a draft, jump straight to the vibe step. */
  initialStep?: 1 | 2 | 3 | 4
}

const PRESET_SLUGS = ['code_reviewer', 'product_strategist', 'life_coach']

const EMOJI_POOL = [
  '🦉', '🦊', '🐧', '🐱', '🐰', '🐻', '🐢', '🦦',
  '🐶', '🐯', '🦁', '🐹', '🦔', '🐨', '🐼', '🐭',
  '🦄', '🐲', '🦝', '🦘', '🐿️', '🦥', '🦩', '🐦',
] as const

const ROLE_PRESETS = [
  {
    slug: 'code_reviewer',
    label: '代码评审员',
    hint: '帮你看代码硬伤、找漏洞',
    defaults: { harshness: 2, formality: 3, verbosity: 4 },
  },
  {
    slug: 'product_strategist',
    label: '产品军师',
    hint: '从用户角度评估方案',
    defaults: { harshness: 6, formality: 5, verbosity: 5 },
  },
  {
    slug: 'life_coach',
    label: '人生教练',
    hint: '关心你的状态、不只看任务',
    defaults: { harshness: 9, formality: 7, verbosity: 6 },
  },
] as const

// 根据脾气滑块自动派色（毒舌偏冷红橙 / 温和偏蓝 / 共情偏粉紫）。
function colorFromVibe(harshness: number, formality: number): string {
  if (harshness <= 3) return '#F97316' // 冷橙
  if (harshness <= 6) return '#3B82F6' // 蓝
  if (formality >= 7) return '#A855F7' // 紫
  return '#EC4899' // 粉
}

// Fisher-Yates shuffle with mulberry32 PRNG seeded from the click counter —
// stable for a given seed so the same "换一批" press yields the same set,
// and gives much better distribution than the previous Math.sin variant
// (which had a short period and visible duplicates across nearby seeds).
function pickEmojis(seed: number): string[] {
  let s = (seed + 0x9e3779b9) | 0
  const rand = () => {
    s = (s + 0x6d2b79f5) | 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const arr = [...EMOJI_POOL]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr.slice(0, 8)
}

export function AdoptModal({ onClose, onAdopted, initialDraft, initialStep }: Props) {
  const draftRoleIsPreset = initialDraft?.agent_definition_name
    ? PRESET_SLUGS.includes(initialDraft.agent_definition_name)
    : false
  const [step, setStep] = useState<1 | 2 | 3 | 4>(initialStep ?? 1)
  const [seed, setSeed] = useState(1)
  const [emoji, setEmoji] = useState<string>(initialDraft?.avatar_emoji || '🦉')
  const [name, setName] = useState(initialDraft?.name ?? '')
  const [roleSlug, setRoleSlug] = useState<string>(
    draftRoleIsPreset ? initialDraft!.agent_definition_name! : ROLE_PRESETS[0].slug,
  )
  // If the draft brought a free-text role_label, seed customRole with
  // it so the user sees the LLM's "擅长" pre-filled and editable.
  const [customRole, setCustomRole] = useState(
    initialDraft?.role_label && !draftRoleIsPreset ? initialDraft.role_label : '',
  )
  const [harshness, setHarshness] = useState(5)
  const [formality, setFormality] = useState(5)
  const [verbosity, setVerbosity] = useState(5)
  const [preview, setPreview] = useState<string>('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const emojis = useMemo(() => pickEmojis(seed), [seed])
  const accent = useMemo(() => colorFromVibe(harshness, formality), [harshness, formality])
  const trimmedName = name.trim()
  const trimmedRole = customRole.trim()
  const effectiveRoleSlug = trimmedRole ? slugify(trimmedRole) : roleSlug
  const effectiveRoleLabel = trimmedRole || (ROLE_PRESETS.find(r => r.slug === roleSlug)?.label ?? roleSlug)

  // Preset defaults are applied on explicit click (see StepRole onSelect).
  // Doing it in a useEffect would silently overwrite user's manual slider
  // edits when the deps re-fire (e.g. clearing customRole).
  function applyPreset(slug: string) {
    setRoleSlug(slug)
    const preset = ROLE_PRESETS.find(r => r.slug === slug)
    if (preset) {
      setHarshness(preset.defaults.harshness)
      setFormality(preset.defaults.formality)
      setVerbosity(preset.defaults.verbosity)
    }
  }

  // (role, h, f, v) → preview cache. Avoids re-burning Flash tokens when
  // the user drags a slider back to a value already sampled. AbortController
  // can't cancel the in-flight Rust request — caching is the only true
  // savings here.
  const previewCacheRef = useRef<Map<string, string>>(new Map())

  // Step 4 实时口吻预览 — slider 停 500ms 后调一次 Flash（命中缓存则跳过）
  useEffect(() => {
    if (step !== 4) return
    const key = `${effectiveRoleLabel}|${harshness}-${formality}-${verbosity}`
    const cached = previewCacheRef.current.get(key)
    if (cached !== undefined) {
      setPreview(cached)
      setPreviewLoading(false)
      return
    }
    const ctl = new AbortController()
    setPreviewLoading(true)
    const timer = setTimeout(() => {
      previewPersonaTone({ role: effectiveRoleLabel, harshness, formality, verbosity })
        .then(text => {
          if (ctl.signal.aborted) return
          previewCacheRef.current.set(key, text)
          setPreview(text)
        })
        .catch(e => { if (!ctl.signal.aborted) setPreview(`预览失败：${e}`) })
        .finally(() => { if (!ctl.signal.aborted) setPreviewLoading(false) })
    }, 500)
    return () => { ctl.abort(); clearTimeout(timer) }
  }, [step, effectiveRoleLabel, harshness, formality, verbosity])

  const canNext = (() => {
    if (step === 1) return !!emoji
    if (step === 2) return trimmedName.length > 0 && trimmedName.length <= 24
    if (step === 3) return effectiveRoleSlug.length > 0
    return true
  })()

  async function submit() {
    if (submitting) return
    setSubmitting(true)
    try {
      const personaParts = [
        `# ${trimmedName}`,
        `角色: ${effectiveRoleLabel}`,
        `脾气: harshness=${harshness}/10, formality=${formality}/10, verbosity=${verbosity}/10`,
        preview && !preview.startsWith('预览失败') ? `\n开场示例：${preview}` : '',
      ].filter(Boolean).join('\n')
      await adoptCompanion({
        name: trimmedName,
        agent_definition_name: effectiveRoleSlug,
        avatar_emoji: emoji,
        color_hex: accent,
        persona_md: personaParts,
        role_label: effectiveRoleLabel,
      })
      toast.success(`${trimmedName} 已收养 ✨`)
      onAdopted()
      onClose()
    } catch (e) {
      toast.error(`收养失败：${e}`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-fade-in">
      <div className="bg-[var(--color-bg-elevated)] rounded-3xl w-full max-w-xl shadow-2xl border border-[var(--color-border)] flex flex-col animate-slide-up">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-[18px]" style={{ background: `${accent}22` }}>
              {emoji}
            </div>
            <div>
              <h2 className="font-semibold text-[15px]" style={{ color: 'var(--color-text)' }}>收养一只新伙伴</h2>
              <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>第 {step} / 4 步</div>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-[var(--color-bg-muted)] rounded-xl transition-all" title="取消">
            <X size={18} />
          </button>
        </div>

        <Progress step={step} accent={accent} />

        <div className="px-6 py-5 min-h-[280px]">
          {step === 1 && (
            <StepEmoji
              emojis={emojis}
              selected={emoji}
              onSelect={setEmoji}
              onShuffle={() => setSeed(s => s + 1)}
              accent={accent}
            />
          )}
          {step === 2 && <StepName name={name} onChange={setName} accent={accent} />}
          {step === 3 && (
            <StepRole
              selected={roleSlug}
              onSelect={applyPreset}
              customRole={customRole}
              onCustomChange={setCustomRole}
              accent={accent}
            />
          )}
          {step === 4 && (
            <StepVibe
              harshness={harshness}
              formality={formality}
              verbosity={verbosity}
              onH={setHarshness}
              onF={setFormality}
              onV={setVerbosity}
              preview={preview}
              previewLoading={previewLoading}
              accent={accent}
              emoji={emoji}
              name={trimmedName}
            />
          )}
        </div>

        <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-[var(--color-border)]">
          <button
            onClick={() => setStep(s => Math.max(1, s - 1) as 1 | 2 | 3 | 4)}
            disabled={step === 1}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-[13px] disabled:opacity-30 transition-all"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            <ArrowLeft size={14} />
            上一步
          </button>
          {step < 4 ? (
            <button
              onClick={() => setStep(s => Math.min(4, s + 1) as 1 | 2 | 3 | 4)}
              disabled={!canNext}
              className="flex items-center gap-1.5 px-5 py-2 rounded-xl text-[13px] font-medium disabled:opacity-30 transition-all"
              style={{ background: accent, color: '#fff' }}
            >
              下一步
              <ArrowRight size={14} />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={submitting}
              className="flex items-center gap-1.5 px-5 py-2 rounded-xl text-[13px] font-medium disabled:opacity-50 transition-all"
              style={{ background: accent, color: '#fff' }}
            >
              {submitting && <Loader2 size={14} className="animate-spin" />}
              {submitting ? '收养中…' : `收养 ${trimmedName || '伙伴'}`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function Progress({ step, accent }: { step: number; accent: string }) {
  return (
    <div className="flex gap-1 px-6 py-2">
      {[1, 2, 3, 4].map(n => (
        <div
          key={n}
          className="flex-1 h-1 rounded-full transition-colors"
          style={{ background: n <= step ? accent : 'var(--color-bg-subtle)' }}
        />
      ))}
    </div>
  )
}

function StepEmoji({
  emojis, selected, onSelect, onShuffle, accent,
}: {
  emojis: string[]
  selected: string
  onSelect: (e: string) => void
  onShuffle: () => void
  accent: string
}) {
  return (
    <div>
      <div className="text-[13px] mb-4" style={{ color: 'var(--color-text-secondary)' }}>选个外貌</div>
      <div className="grid grid-cols-4 gap-3">
        {emojis.map(e => (
          <button
            key={e}
            onClick={() => onSelect(e)}
            className="aspect-square rounded-2xl flex items-center justify-center text-[32px] transition-all"
            style={{
              background: selected === e ? `${accent}22` : 'var(--color-bg-subtle)',
              outline: selected === e ? `2px solid ${accent}` : 'none',
            }}
          >
            {e}
          </button>
        ))}
      </div>
      <button
        onClick={onShuffle}
        className="mt-4 flex items-center gap-1.5 text-[12px] mx-auto px-3 py-1.5 rounded-lg transition-colors hover:bg-[var(--color-bg-subtle)]"
        style={{ color: 'var(--color-text-muted)' }}
      >
        <Shuffle size={13} />
        换一批
      </button>
    </div>
  )
}

function StepName({ name, onChange, accent }: { name: string; onChange: (s: string) => void; accent: string }) {
  return (
    <div>
      <div className="text-[13px] mb-2" style={{ color: 'var(--color-text-secondary)' }}>它叫什么？</div>
      <div className="text-[11px] mb-3" style={{ color: 'var(--color-text-muted)' }}>起个能叫得顺嘴的名字，最长 24 字。</div>
      <input
        autoFocus
        value={name}
        onChange={e => onChange(e.target.value)}
        placeholder="例：阿狸"
        maxLength={24}
        className="w-full px-4 py-3 rounded-xl text-[15px] outline-none transition-all"
        style={{
          background: 'var(--color-bg-subtle)',
          color: 'var(--color-text)',
          border: `2px solid ${name.trim() ? accent : 'transparent'}`,
        }}
      />
      <div className="mt-2 text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
        {name.length}/24
      </div>
    </div>
  )
}

function StepRole({
  selected, onSelect, customRole, onCustomChange, accent,
}: {
  selected: string
  onSelect: (slug: string) => void
  customRole: string
  onCustomChange: (s: string) => void
  accent: string
}) {
  return (
    <div>
      <div className="text-[13px] mb-2" style={{ color: 'var(--color-text-secondary)' }}>它擅长什么？</div>
      <div className="text-[11px] mb-3" style={{ color: 'var(--color-text-muted)' }}>挑一个最贴近的，下面也可以自己写。</div>
      <div className="space-y-2 mb-4">
        {ROLE_PRESETS.map(r => {
          const active = !customRole.trim() && selected === r.slug
          return (
            <button
              key={r.slug}
              onClick={() => { onCustomChange(''); onSelect(r.slug) }}
              className="w-full text-left px-4 py-3 rounded-xl transition-all"
              style={{
                background: active ? `${accent}1a` : 'var(--color-bg-subtle)',
                outline: active ? `2px solid ${accent}` : 'none',
              }}
            >
              <div className="font-medium text-[14px]" style={{ color: 'var(--color-text)' }}>{r.label}</div>
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--color-text-muted)' }}>{r.hint}</div>
            </button>
          )
        })}
      </div>
      <input
        value={customRole}
        onChange={e => onCustomChange(e.target.value)}
        placeholder="自定义角色（例：学术写作搭子）"
        maxLength={40}
        className="w-full px-4 py-2.5 rounded-xl text-[13px] outline-none"
        style={{
          background: 'var(--color-bg-subtle)',
          color: 'var(--color-text)',
          border: `2px solid ${customRole.trim() ? accent : 'transparent'}`,
        }}
      />
    </div>
  )
}

const VIBE_AXES = [
  { key: 'h', label: '措辞', left: '毒舌', right: '温和' },
  { key: 'f', label: '正式', left: '严谨', right: '随性' },
  { key: 'v', label: '详略', left: '话痨', right: '惜字' },
] as const

function StepVibe(props: {
  harshness: number; formality: number; verbosity: number
  onH: (n: number) => void; onF: (n: number) => void; onV: (n: number) => void
  preview: string; previewLoading: boolean
  accent: string; emoji: string; name: string
}) {
  const values = { h: props.harshness, f: props.formality, v: props.verbosity }
  const setters = { h: props.onH, f: props.onF, v: props.onV }
  return (
    <div>
      <div className="text-[13px] mb-3" style={{ color: 'var(--color-text-secondary)' }}>它是什么脾气？</div>
      <div className="space-y-3 mb-4">
        {VIBE_AXES.map(axis => (
          <div key={axis.key}>
            <div className="flex justify-between items-center text-[11px] mb-1" style={{ color: 'var(--color-text-muted)' }}>
              <span>{axis.left}</span>
              <span style={{ color: 'var(--color-text-secondary)' }}>{axis.label}</span>
              <span>{axis.right}</span>
            </div>
            <input
              type="range"
              min={0}
              max={10}
              value={values[axis.key]}
              onChange={e => setters[axis.key](Number(e.target.value))}
              className="w-full"
              style={{ accentColor: props.accent }}
            />
          </div>
        ))}
      </div>
      <div
        className="p-4 rounded-xl text-[13px] leading-relaxed min-h-[64px] flex items-start gap-2"
        style={{ background: `${props.accent}10` }}
      >
        <div className="text-[18px] shrink-0">{props.emoji}</div>
        <div className="flex-1">
          {props.previewLoading ? (
            <span style={{ color: 'var(--color-text-muted)' }}>
              <Loader2 size={12} className="inline animate-spin mr-1" />
              {props.name || '它'} 在想要说什么…
            </span>
          ) : props.preview ? (
            <span style={{ color: 'var(--color-text)' }}>{props.preview}</span>
          ) : (
            <span style={{ color: 'var(--color-text-muted)' }}>拖动滑块感受口吻</span>
          )}
        </div>
      </div>
    </div>
  )
}

/** Derive an `agent_definition_name` slug from a free-form role name. ASCII
 *  text is normalized; CJK / emoji-only input falls back to a content hash
 *  prefixed with `c` so two users typing different Chinese role names land
 *  on *different* slugs (the previous version collapsed everything to
 *  `'companion'`, causing all custom-role companions to share one bucket). */
function slugify(s: string): string {
  const cleaned = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)
  if (cleaned) return cleaned
  let h = 0xcbf29ce484222325n
  for (const ch of s) {
    h ^= BigInt(ch.codePointAt(0) ?? 0)
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return `c${(h & 0xffffffffn).toString(16).padStart(8, '0')}`
}
