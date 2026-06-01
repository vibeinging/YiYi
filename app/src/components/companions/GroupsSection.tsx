/**
 * 群(companion groups)管理区,挂在 BuddyPanel。
 *
 * 多对多关系 —— IM 群聊心智:用户能建多个有名字的组,一个 companion 可同时
 * 在多个组里。每组的成员在 ChatInput 的群选择器里成为路由 roster,且共享
 * 一个 `group_shared_<id>` 记忆桶(在 BuddyPanel 的"群共享记忆"区按组切换查看)。
 *
 * 设计:docs/design/2026-05-27_群会话-host调度群聊.md Approach B。
 */

import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, Plus, Pencil, Trash2, Check, X } from 'lucide-react'
import {
  createGroupWithMembers,
  deleteCompanionGroup,
  addCompanionToGroup,
  removeCompanionFromGroup,
  updateCompanionGroup,
  setSessionGroup,
  type CompanionGroup,
} from '../../api/groups'
import { listCompanions, type Companion } from '../../api/companions'
import { toast, confirm } from '../Toast'
import { useGroupsStore } from '../../stores/groupsStore'
import { useSessionStore } from '../../stores/sessionStore'
import { validateGroupForm } from '../../utils/group'

type EditForm = {
  /** undefined = 新建模式;非空 = 编辑既有组。 */
  id?: number
  name: string
  emoji: string
  memberIds: Set<number>
}

function emptyForm(): EditForm {
  return { name: '', emoji: '', memberIds: new Set() }
}

export function GroupsSection({ embedded = false }: { embedded?: boolean } = {}) {
  // embedded(弹窗里):默认展开、不渲染折叠头、不要顶部分隔边框。
  const [expanded, setExpanded] = useState(embedded)
  const [companions, setCompanions] = useState<Companion[]>([])
  /** null = 不在编辑;非空 = 正在新建或编辑某组(顶部固定的表单)。 */
  const [form, setForm] = useState<EditForm | null>(null)

  // 单一数据源:groups 元数据 + 成员都读 groupsStore,不再维护本地副本
  // (避免与 ChatHeader / AvatarGrid 那份缓存不同步 —— 修复 P1)。
  const groups = useGroupsStore(s => s.groups)
  const membersByGroup = useGroupsStore(s => s.membersByGroup)
  const ensureMembers = useGroupsStore(s => s.ensureMembers)

  const refreshGroups = async () => {
    await useGroupsStore.getState().load()
    // 预拉每组成员,展示"X 人"用(命中缓存秒回,共享 inflight Promise)。
    for (const g of useGroupsStore.getState().groups) {
      void ensureMembers(g.id)
    }
  }

  useEffect(() => {
    if (!expanded) return
    void refreshGroups()
    listCompanions(false).then(setCompanions).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded])

  const startCreate = () => setForm(emptyForm())
  const startEdit = (g: CompanionGroup) => {
    const memberIds = new Set((membersByGroup.get(g.id) ?? []).map(m => m.id))
    setForm({ id: g.id, name: g.name, emoji: g.emoji ?? '', memberIds })
  }
  const cancelEdit = () => setForm(null)

  const toggleMember = (cid: number) => {
    if (!form) return
    const next = new Set(form.memberIds)
    if (next.has(cid)) next.delete(cid)
    else next.add(cid)
    setForm({ ...form, memberIds: next })
  }

  const handleSave = async () => {
    if (!form) return
    const err = validateGroupForm(form.name, form.memberIds, form.id == null)
    if (err) {
      toast.error(err)
      return
    }
    const name = form.name.trim()
    try {
      if (form.id == null) {
        // 新建:建组 + 加成员(中途失败自动回滚删组,不留半成品群) +
        // **自动开一个绑定本组的新对话进入**(IM 心智:建群 = 立刻进入这个群聊)。
        const gid = await createGroupWithMembers(name, form.emoji || null, form.memberIds)
        const sid = await useSessionStore.getState().createNewChat()
        try {
          await setSessionGroup(sid, gid)
        } catch (e) {
          // 绑定失败:**不**进半成品会话(那会变成"看着像群、实际单聊")。
          // 群已建好,提示用户去列表手动进入。
          console.error('setSessionGroup after createCompanionGroup failed', e)
          toast.error(`已建群「${name}」,但进入对话失败,可在上方列表点它进入`)
          setForm(null)
          await refreshGroups()
          useGroupsStore.getState().invalidateMembers(gid)
          return
        }
        useSessionStore.getState().switchToSession(sid)
        // 切主区到 chat 页(App.tsx 监听 'navigate' 事件 setCurrentPage)。
        window.dispatchEvent(new CustomEvent('navigate', { detail: 'chat' }))
        toast.info(`已建群「${name}」并开新对话(${form.memberIds.size} 人)`)
        useGroupsStore.getState().invalidateMembers(gid)
      } else {
        // 编辑:diff 成员 → add/remove。before 取自 store 的单一缓存。
        await updateCompanionGroup(form.id, name, form.emoji || null, null)
        const before = new Set((membersByGroup.get(form.id) ?? []).map(m => m.id))
        const after = form.memberIds
        for (const cid of after) {
          if (!before.has(cid)) await addCompanionToGroup(form.id, cid)
        }
        for (const cid of before) {
          if (!after.has(cid)) await removeCompanionFromGroup(form.id, cid)
        }
        toast.info(`已更新群「${name}」`)
        useGroupsStore.getState().invalidateMembers(form.id)
      }
      setForm(null)
      await refreshGroups()
    } catch (e) {
      toast.error(`操作失败: ${e}`)
    }
  }

  const handleDelete = async (g: CompanionGroup) => {
    const ok = await confirm(
      `确定删除群「${g.name}」?成员关系会一起清,这个群累积的共享记忆桶保留(可在"群共享记忆"里手动清)。`,
    )
    if (!ok) return
    try {
      await deleteCompanionGroup(g.id)
      toast.info(`已删除群「${g.name}」`)
      if (form?.id === g.id) setForm(null)
      useGroupsStore.getState().invalidateMembers(g.id)
      await refreshGroups()
    } catch (e) {
      toast.error(`删除失败: ${e}`)
    }
  }

  return (
    <div className={embedded ? '' : 'mt-4 pt-4'} style={embedded ? undefined : { borderTop: '1px solid var(--color-bg-subtle)' }}>
      {!embedded && (
        <button
          onClick={() => setExpanded(v => !v)}
          className="flex items-center gap-1 text-[11px] mb-2 transition-colors hover:opacity-100"
          style={{ color: 'var(--color-text-muted)' }}
        >
          {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          我的群({groups.length})
        </button>
      )}

      {expanded && (
        <div className="space-y-2">
          {/* 新建 / 编辑表单 —— 顶部固定。 */}
          {form == null ? (
            <button
              onClick={startCreate}
              disabled={companions.length === 0}
              className="flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded-lg transition-colors hover:bg-[var(--color-bg-subtle)] disabled:opacity-40"
              style={{ color: 'var(--color-primary)' }}
              title={companions.length === 0 ? '还没养任何伙伴 —— 先去"我的伙伴"里收养' : '新建一个群(像微信群)'}
            >
              <Plus size={13} />
              新建群
            </button>
          ) : (
            <div className="p-3 rounded-lg space-y-2" style={{ background: 'var(--color-bg-subtle)' }}>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={form.emoji}
                  onChange={e => setForm({ ...form, emoji: e.target.value.slice(0, 4) })}
                  placeholder="🎨"
                  className="w-10 text-center text-[14px] px-2 py-1 rounded outline-none"
                  style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)' }}
                />
                <input
                  type="text"
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  placeholder={form.id == null ? '群名(例:创作小队)' : '改名…'}
                  className="flex-1 text-[13px] px-2 py-1 rounded outline-none"
                  style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)' }}
                  autoFocus
                />
              </div>
              <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                成员({form.memberIds.size} 人):
              </div>
              <div className="grid grid-cols-2 gap-1 max-h-[160px] overflow-y-auto">
                {companions.map(c => {
                  const checked = form.memberIds.has(c.id)
                  return (
                    <label
                      key={c.id}
                      className="flex items-center gap-1.5 px-1.5 py-1 rounded cursor-pointer text-[12px] transition-colors hover:bg-[var(--color-bg-elevated)]"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleMember(c.id)}
                        className="cursor-pointer"
                        style={{ accentColor: 'var(--color-primary)' }}
                      />
                      <span>{c.avatar_emoji}</span>
                      <span className="truncate" style={{ color: checked ? 'var(--color-text)' : 'var(--color-text-muted)' }}>
                        {c.name}
                      </span>
                    </label>
                  )
                })}
                {companions.length === 0 && (
                  <div className="col-span-2 text-[12px] text-center py-2" style={{ color: 'var(--color-text-muted)' }}>
                    还没有可加入的伙伴
                  </div>
                )}
              </div>
              <div className="flex items-center justify-end gap-1.5 pt-1">
                <button
                  onClick={cancelEdit}
                  className="flex items-center gap-1 text-[12px] px-2 py-1 rounded transition-colors hover:bg-[var(--color-bg-elevated)]"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  <X size={12} />
                  取消
                </button>
                <button
                  onClick={handleSave}
                  className="flex items-center gap-1 text-[12px] px-2.5 py-1 rounded font-medium"
                  style={{ background: 'var(--color-primary)', color: 'white' }}
                >
                  <Check size={12} />
                  {form.id == null ? '创建' : '保存'}
                </button>
              </div>
            </div>
          )}

          {/* 现有的群列表。 */}
          {groups.length === 0 && form == null && (
            <div className="py-2 text-center text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
              还没建任何群 —— 点上面"新建群"开始
            </div>
          )}
          {groups.map(g => {
            const memberCount = membersByGroup.get(g.id)?.length ?? 0
            const isEditing = form?.id === g.id
            return (
              <div
                key={g.id}
                className="group flex items-center gap-2 px-3 py-2 rounded-lg"
                style={{
                  background: isEditing ? 'var(--color-bg-elevated)' : 'transparent',
                  border: isEditing ? '1px solid var(--color-primary)' : '1px solid transparent',
                }}
              >
                <span className="text-[16px]">{g.emoji || '👪'}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium truncate" style={{ color: 'var(--color-text)' }}>
                    {g.name}
                  </div>
                  <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                    {memberCount} 位成员
                  </div>
                </div>
                <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => startEdit(g)}
                    disabled={form != null && form.id !== g.id}
                    className="p-1 rounded transition-colors hover:bg-[var(--color-bg-subtle)] disabled:opacity-30"
                    title="编辑"
                  >
                    <Pencil size={12} style={{ color: 'var(--color-text-muted)' }} />
                  </button>
                  <button
                    onClick={() => handleDelete(g)}
                    className="p-1 rounded transition-colors hover:bg-[var(--color-bg-subtle)]"
                    title="删除"
                  >
                    <Trash2 size={12} style={{ color: 'var(--color-error)' }} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
