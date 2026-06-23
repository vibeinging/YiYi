/**
 * CustomTeamPanel —— G2「agent 自生成团队」的白盒审阅面板。
 *
 * 走 Draft → Review → Apply:
 *   1. describe:用户一句话描述要做什么 → generate_team 让 agent 生成角色草稿
 *   2. review:逐个角色可改名/改职责/改人设/换权限档/删除,可加角色、改团队名
 *   3. apply:开工 → commit_dynamic_team 落地(逐个收养 + 建群 + 工作区)→ 新开会话进群
 *
 * 自包含:落地后总是**新开一段会话**绑该团队并切过去(建团队是明确动作,开新窗口)。
 * 2026-06-15:chat 群聊退役后,仅 Work 页的「先看看团队」白盒审阅视图渲染它。
 */

import { useRef, useState } from 'react'
import { Loader2, Trash2, Plus, Sparkles, AlertTriangle } from 'lucide-react'
import { generateTeam, commitDynamicTeam, type RoleSpec, type PermissionProfile } from '../../api/companions'
import { createSession } from '../../api/agent'
import { setSessionGroup } from '../../api/groups'
import { useSessionStore } from '../../stores/sessionStore'
import { useGroupsStore } from '../../stores/groupsStore'
import { toast } from '../Toast'

/** 四档权限的展示元数据(对齐后端 PermissionProfile)。canExecute = 能跑命令(高权限,给 ⚠️)。 */
const PROFILE_META: Record<PermissionProfile, { label: string; canExecute: boolean; hint: string }> = {
  coordinator: { label: '协调规划', canExecute: false, hint: '能问能读,不写不跑' },
  designer: { label: '设计文档', canExecute: false, hint: '能读写文件,不跑命令' },
  builder: { label: '开发', canExecute: true, hint: '能写文件 + 跑命令/脚本' },
  reviewer: { label: '测试评审', canExecute: true, hint: '能读 + 跑测试 + 写测试' },
}
const PROFILE_ORDER: PermissionProfile[] = ['coordinator', 'designer', 'builder', 'reviewer']

export function CustomTeamPanel({
  onClose,
  goal: initialGoal,
  ephemeral,
  onCommitted,
}: {
  onClose: () => void
  /** 预填的目标描述(如「工作页」把任务带进来,免得用户重打一遍)。 */
  goal?: string
  /** work 入口 = true:落地的成员标 worker(临时工,不进伙伴列表)。chat 启动器缺省 false。 */
  ephemeral?: boolean
  /**
   * 落地(commit_dynamic_team)成功后的动作覆盖。给了就**不**走默认的"新开 chat 会话进群",
   * 改由调用方处理新 gid(如工作页:用这支团队开工 launch_work_job)。不传 = 维持原 Buddy 行为。
   */
  onCommitted?: (gid: number) => void | Promise<void>
}) {
  const [step, setStep] = useState<'describe' | 'review'>('describe')
  const [goal, setGoal] = useState(initialGoal ?? '')
  const [generating, setGenerating] = useState(false)
  const [roles, setRoles] = useState<Array<RoleSpec & { _k: number }>>([])
  const [teamName, setTeamName] = useState('')
  const [teamEmoji, setTeamEmoji] = useState('🛠️')
  const [committing, setCommitting] = useState(false)
  /** 同步防重入 —— committing/generating 是异步 state,双击会在 re-render 前漏过守卫。 */
  const busyRef = useRef(false)
  /** 角色稳定 key —— 删除/重排时 React 才不会错配受控输入(不能用数组下标)。 */
  const keyCounter = useRef(0)
  const tag = (r: RoleSpec): RoleSpec & { _k: number } => ({ ...r, _k: keyCounter.current++ })

  const generate = async () => {
    const g = goal.trim()
    if (!g || busyRef.current) return
    busyRef.current = true
    setGenerating(true)
    try {
      const team = await generateTeam(g)
      setRoles(team.roles.map(tag))
      // 团队名用 LLM 生成的(用户仍可改);兜底取目标前 12 字。
      setTeamName(team.name?.trim() || (g.length > 12 ? g.slice(0, 12) : g))
      setStep('review')
    } catch (e) {
      toast.error(`生成失败：${e}`)
    } finally {
      busyRef.current = false
      setGenerating(false)
    }
  }

  const patchRole = (i: number, patch: Partial<RoleSpec>) => {
    setRoles(prev => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }
  const removeRole = (i: number) => setRoles(prev => prev.filter((_, idx) => idx !== i))
  const addRole = () => {
    setRoles(prev => [
      ...prev,
      tag({
        slug: `role_${prev.length + 1}`,
        name: '新角色',
        description: '',
        emoji: '🙂',
        color: '#6366F1',
        profile: 'coordinator',
        persona: '',
      }),
    ])
  }

  const commit = async () => {
    const nm = teamName.trim()
    if (!nm) { toast.error('先给团队起个名'); return }
    if (roles.length === 0) { toast.error('团队至少要一个角色'); return }
    if (roles.some(r => !r.name.trim())) { toast.error('有角色没填名字'); return }
    if (busyRef.current) return
    busyRef.current = true
    setCommitting(true)
    try {
      const clean = roles.map(({ _k, ...r }) => r) // 剥离客户端 key
      const gid = await commitDynamicTeam(nm, teamEmoji || null, clean, !!ephemeral)
      if (onCommitted) {
        // 调用方接管落地后动作(如工作页:用这支团队开工);不开 chat 会话、不导航、不在此 toast。
        await onCommitted(gid)
      } else {
        // 默认(Buddy):新开一段会话绑该群并切过去(建团队是明确动作,总开新窗口)。
        const sid = (await createSession('New Chat')).id
        await setSessionGroup(sid, gid)
        useGroupsStore.getState().invalidateMembers(gid)
        await useGroupsStore.getState().load()
        await useSessionStore.getState().refreshSessions()
        useSessionStore.getState().switchToSession(sid)
        window.dispatchEvent(new CustomEvent('navigate', { detail: 'chat' }))
        toast.success(`「${nm}」已就位 — ${roles.length} 个角色入群`)
      }
      onClose()
    } catch (e) {
      toast.error(`落地失败：${e}`)
      busyRef.current = false
      setCommitting(false)
    }
  }

  // ── describe 步 ──
  if (step === 'describe') {
    return (
      <div className="px-5 py-4 space-y-3">
        <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-xl" style={{ background: 'var(--color-bg-subtle)', border: '1px solid var(--color-border)' }}>
          <Sparkles size={16} className="shrink-0 mt-0.5" style={{ color: 'var(--color-primary)' }} />
          <div className="text-[12px] leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>
            描述你要做什么,YiYi 会**自动组建**一支匹配的角色团队。生成后你可以逐个审阅、改人设、调权限,满意再开工。
          </div>
        </div>
        <textarea
          value={goal}
          onChange={e => setGoal(e.target.value)}
          placeholder="例:做一个本地播客剪辑工具 / 策划一场产品发布会 / 写一份市场调研报告"
          rows={4}
          autoFocus
          className="w-full text-[13px] px-3 py-2.5 rounded-xl outline-none resize-none"
          style={{ background: 'var(--color-bg-subtle)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
        />
        <button
          onClick={generate}
          disabled={!goal.trim() || generating}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-[13px] font-medium transition-all disabled:opacity-40"
          style={{ background: 'var(--color-primary)', color: '#fff' }}
        >
          {generating ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
          {generating ? '正在组队…' : '生成团队'}
        </button>
      </div>
    )
  }

  // ── review 步 ──
  return (
    <div className="flex flex-col min-h-0">
      <div className="px-5 pt-4 pb-2 flex items-center gap-2 shrink-0">
        <input
          value={teamEmoji}
          onChange={e => setTeamEmoji(e.target.value.slice(0, 4))}
          className="w-11 h-10 text-center text-[18px] rounded-xl outline-none shrink-0"
          style={{ background: 'var(--color-bg-subtle)', border: '1px solid var(--color-border)' }}
        />
        <input
          value={teamName}
          onChange={e => setTeamName(e.target.value)}
          placeholder="团队名"
          className="flex-1 h-10 px-3 text-[14px] rounded-xl outline-none"
          style={{ background: 'var(--color-bg-subtle)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
        />
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2 min-h-[180px] max-h-[44vh]">
        {roles.map((r, i) => {
          const meta = PROFILE_META[r.profile]
          return (
            <div key={r._k} className="rounded-2xl p-3" style={{ background: 'var(--color-bg-subtle)', border: '1px solid var(--color-border)' }}>
              <div className="flex items-center gap-2">
                <input
                  value={r.emoji}
                  onChange={e => patchRole(i, { emoji: e.target.value.slice(0, 4) })}
                  className="w-9 h-9 text-center text-[18px] rounded-lg outline-none shrink-0"
                  style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)' }}
                />
                <input
                  value={r.name}
                  onChange={e => patchRole(i, { name: e.target.value })}
                  placeholder="角色名"
                  className="flex-1 min-w-0 h-9 px-2.5 text-[13px] font-medium rounded-lg outline-none"
                  style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                />
                <button
                  onClick={() => removeRole(i)}
                  className="shrink-0 p-2 rounded-lg transition-colors hover:bg-[var(--color-bg-muted)]"
                  title="删除这个角色"
                >
                  <Trash2 size={14} style={{ color: 'var(--color-error)' }} />
                </button>
              </div>

              <input
                value={r.description}
                onChange={e => patchRole(i, { description: e.target.value })}
                placeholder="一句话职责"
                className="w-full mt-2 h-8 px-2.5 text-[12px] rounded-lg outline-none"
                style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}
              />

              {/* 权限档位选择 */}
              <div className="flex items-center gap-1 mt-2 flex-wrap">
                {PROFILE_ORDER.map(p => {
                  const on = r.profile === p
                  const pm = PROFILE_META[p]
                  return (
                    <button
                      key={p}
                      onClick={() => patchRole(i, { profile: p })}
                      title={pm.hint}
                      className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] transition-all"
                      style={{
                        background: on ? 'var(--color-primary)' : 'var(--color-bg-elevated)',
                        color: on ? '#fff' : 'var(--color-text-muted)',
                        border: `1px solid ${on ? 'var(--color-primary)' : 'var(--color-border)'}`,
                      }}
                    >
                      {pm.canExecute && <AlertTriangle size={10} style={{ color: on ? '#fff' : 'var(--color-warning, #F59E0B)' }} />}
                      {pm.label}
                    </button>
                  )
                })}
              </div>
              {meta.canExecute && (
                <div className="flex items-center gap-1 mt-1.5 text-[10.5px]" style={{ color: 'var(--color-warning, #F59E0B)' }}>
                  <AlertTriangle size={10} />
                  这个档位能跑命令 —— 确认它需要写代码/做实现再给
                </div>
              )}

              <textarea
                value={r.persona}
                onChange={e => patchRole(i, { persona: e.target.value })}
                placeholder="角色人设 / 工作方式(可留空)"
                rows={2}
                className="w-full mt-2 text-[12px] px-2.5 py-1.5 rounded-lg outline-none resize-none"
                style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)', color: 'var(--color-text-muted)' }}
              />
            </div>
          )
        })}

        <button
          onClick={addRole}
          className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl text-[12px] transition-colors hover:bg-[var(--color-bg-subtle)]"
          style={{ color: 'var(--color-text-muted)', border: '1px dashed var(--color-border)' }}
        >
          <Plus size={13} /> 加一个角色
        </button>
      </div>

      <div className="flex items-center justify-between px-5 py-3 border-t shrink-0" style={{ borderColor: 'var(--color-border)' }}>
        <button
          onClick={() => setStep('describe')}
          disabled={committing}
          className="text-[12px] px-2 py-1 rounded-lg transition-colors hover:bg-[var(--color-bg-subtle)] disabled:opacity-40"
          style={{ color: 'var(--color-text-muted)' }}
          title="改描述重新生成(已编辑的角色会被覆盖)"
        >
          ← 重新描述
        </button>
        <div className="flex items-center gap-3">
          <span className="text-[12.5px]" style={{ color: 'var(--color-text-muted)' }}>
            <span className="font-semibold tabular-nums" style={{ color: 'var(--color-text-secondary)' }}>{roles.length}</span> 个角色
          </span>
          <button
            onClick={commit}
            disabled={committing || roles.length === 0 || !teamName.trim()}
            className="flex items-center gap-1.5 px-5 py-2 rounded-xl text-[13px] font-medium transition-all disabled:opacity-40"
            style={{ background: 'var(--color-primary)', color: '#fff' }}
          >
            {committing ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            开工
          </button>
        </div>
      </div>
    </div>
  )
}
