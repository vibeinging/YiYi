/**
 * 家族(companion groups)管理区,挂在 BuddyPanel。
 *
 * 多对多关系 —— IM 群聊心智:用户能建多个有名字的组,一个 companion 可同时
 * 在多个组里。每组的成员在 ChatInput 的家族选择器里成为路由 roster,且共享
 * 一个 `family_shared_<id>` 记忆桶(在 BuddyPanel 的"家族共享记忆"区按组切换查看)。
 *
 * 设计:docs/design/2026-05-27_家族会话-host调度群聊.md Approach B。
 */

import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, Plus, Pencil, Trash2, Check, X } from 'lucide-react'
import {
  createCompanionGroup,
  listCompanionGroups,
  deleteCompanionGroup,
  listGroupMembers,
  addCompanionToGroup,
  removeCompanionFromGroup,
  updateCompanionGroup,
  type CompanionGroup,
} from '../../api/groups'
import { listCompanions, type Companion } from '../../api/companions'
import { toast } from '../Toast'

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

export function FamilyGroupsSection() {
  const [expanded, setExpanded] = useState(false)
  const [groups, setGroups] = useState<CompanionGroup[]>([])
  const [companions, setCompanions] = useState<Companion[]>([])
  /** null = 不在编辑;非空 = 正在新建或编辑某组(顶部固定的表单)。 */
  const [form, setForm] = useState<EditForm | null>(null)
  /** 缓存:gid → 已加入的 companion ids,展示"X 人"用,展开编辑时也用作初值。 */
  const [memberCache, setMemberCache] = useState<Map<number, number[]>>(new Map())

  const refreshGroups = async () => {
    try {
      const gs = await listCompanionGroups()
      setGroups(gs)
      // 拉每组的成员 id(轻量,N+1 在 N<=20 的家族数量下可接受)。
      const cache = new Map<number, number[]>()
      for (const g of gs) {
        try {
          const members = await listGroupMembers(g.id)
          cache.set(g.id, members.map(m => m.id))
        } catch { /* 跳过,UI 会显示 0 人 */ }
      }
      setMemberCache(cache)
    } catch (e) {
      console.error('listCompanionGroups failed', e)
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
    const memberIds = new Set(memberCache.get(g.id) ?? [])
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
    const name = form.name.trim()
    if (!name) {
      toast.error('家族名不能为空')
      return
    }
    try {
      if (form.id == null) {
        // 新建
        const gid = await createCompanionGroup(name, form.emoji || null, null)
        for (const cid of form.memberIds) {
          await addCompanionToGroup(gid, cid)
        }
        toast.info(`已创建家族「${name}」(${form.memberIds.size} 人)`)
      } else {
        // 编辑:diff 成员 → add/remove。
        await updateCompanionGroup(form.id, name, form.emoji || null, null)
        const before = new Set(memberCache.get(form.id) ?? [])
        const after = form.memberIds
        for (const cid of after) {
          if (!before.has(cid)) await addCompanionToGroup(form.id, cid)
        }
        for (const cid of before) {
          if (!after.has(cid)) await removeCompanionFromGroup(form.id, cid)
        }
        toast.info(`已更新家族「${name}」`)
      }
      setForm(null)
      await refreshGroups()
    } catch (e) {
      toast.error(`操作失败: ${e}`)
    }
  }

  const handleDelete = async (g: CompanionGroup) => {
    if (!window.confirm(`确定删除家族「${g.name}」?成员关系会一起清,这个家族累积的共享记忆桶保留(可在"家族共享记忆"里手动清)。`)) return
    try {
      await deleteCompanionGroup(g.id)
      toast.info(`已删除家族「${g.name}」`)
      if (form?.id === g.id) setForm(null)
      await refreshGroups()
    } catch (e) {
      toast.error(`删除失败: ${e}`)
    }
  }

  return (
    <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--color-bg-subtle)' }}>
      <button
        onClick={() => setExpanded(v => !v)}
        className="flex items-center gap-1 text-[11px] mb-2 transition-colors hover:opacity-100"
        style={{ color: 'var(--color-text-muted)' }}
      >
        {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
        我的家族({groups.length})
      </button>

      {expanded && (
        <div className="space-y-2">
          {/* 新建 / 编辑表单 —— 顶部固定。 */}
          {form == null ? (
            <button
              onClick={startCreate}
              disabled={companions.length === 0}
              className="flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded-lg transition-colors hover:bg-[var(--color-bg-subtle)] disabled:opacity-40"
              style={{ color: 'var(--color-primary)' }}
              title={companions.length === 0 ? '还没收养任何分身 —— 先去家族里收养一个' : '新建一个家族(像微信群)'}
            >
              <Plus size={13} />
              新建家族
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
                  placeholder={form.id == null ? '家族名(例:创作小队)' : '改名…'}
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
                    还没有可加入的分身
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

          {/* 现有家族列表。 */}
          {groups.length === 0 && form == null && (
            <div className="py-2 text-center text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
              还没建任何家族 —— 点上面"新建家族"开始
            </div>
          )}
          {groups.map(g => {
            const memberCount = memberCache.get(g.id)?.length ?? 0
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
