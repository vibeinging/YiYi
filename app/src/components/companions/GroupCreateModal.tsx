/**
 * GroupCreateModal — 微信式「发起群聊」。
 *
 * 群名 + emoji → 搜索 → 成员列表(头像+名字+角色,右侧圆勾,点行选中)→ 创建即进群。
 * 建群即开聊:建好后新开一个绑定该群的会话并切到 chat 页。
 */

import { useEffect, useMemo, useState } from 'react'
import { X, Search, Check, Loader2, Users } from 'lucide-react'
import {
  createGroupWithMembers, setSessionGroup,
  updateCompanionGroup, addCompanionToGroup, removeCompanionFromGroup,
} from '../../api/groups'
import { listCompanions, type Companion } from '../../api/companions'
import { createSession } from '../../api/agent'
import { useSessionStore } from '../../stores/sessionStore'
import { useGroupsStore } from '../../stores/groupsStore'
import { validateGroupForm } from '../../utils/group'
import { toast } from '../Toast'

/** `group` 传入 = 编辑既有群;否则 = 发起新群。`onChanged` 编辑后用于刷新列表。 */
export function GroupCreateModal({
  onClose,
  group,
  onChanged,
}: {
  onClose: () => void
  group?: { id: number; name: string; emoji: string; memberIds: number[] }
  onChanged?: () => void
}) {
  const editing = !!group
  const [companions, setCompanions] = useState<Companion[]>([])
  const [name, setName] = useState(group?.name ?? '')
  const [emoji, setEmoji] = useState(group?.emoji ?? '')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<number>>(new Set(group?.memberIds ?? []))
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    listCompanions(false).then(setCompanions).catch(() => {})
    return () => { document.body.style.overflow = prev }
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return companions
    return companions.filter(c =>
      c.name.toLowerCase().includes(q) || (c.role_label ?? '').toLowerCase().includes(q),
    )
  }, [companions, query])

  const toggle = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const submit = async () => {
    const err = validateGroupForm(name, selected, !editing)
    if (err) { toast.error(err); return }
    const nm = name.trim()
    setCreating(true)
    try {
      if (editing && group) {
        // 编辑:改名/emoji + diff 成员增删。
        await updateCompanionGroup(group.id, nm, emoji || null, null)
        const before = new Set(group.memberIds)
        for (const cid of selected) if (!before.has(cid)) await addCompanionToGroup(group.id, cid)
        for (const cid of before) if (!selected.has(cid)) await removeCompanionFromGroup(group.id, cid)
        useGroupsStore.getState().invalidateMembers(group.id)
        await useGroupsStore.getState().load()
        toast.success(`已更新群「${nm}」`)
        onChanged?.()
        onClose()
        return
      }
      // 新建 + 建群即开聊。
      const gid = await createGroupWithMembers(nm, emoji || null, selected)
      // 直接建一段全新会话绑群 —— 不用 createNewChat:它会复用"当前那条 name=New Chat 的会话"
      // (空会话,或正在看的群会话——群会话 session.name 也是 'New Chat'),把它覆盖成新群、
      // switchToSession 切的还是当前会话 → 视觉上像"没跳转"。建群是明确动作,总是开新窗口。
      const sid = (await createSession('New Chat')).id
      await setSessionGroup(sid, gid)
      // 先让 groups.byId 有这个新群(左侧标题/头像要用),再重拉会话列表 —— 这样列表里的新会话
      // 带上后端刚绑的 group_id,立刻显示群名 + 群头像拼图(否则回落 "New Chat" + 空群,正是
      // "列表没刷新 / 没群名"的现象)。最后切到它 = 右侧直接进群窗口。
      useGroupsStore.getState().invalidateMembers(gid)
      await useGroupsStore.getState().load()
      await useSessionStore.getState().refreshSessions()
      useSessionStore.getState().switchToSession(sid)
      window.dispatchEvent(new CustomEvent('navigate', { detail: 'chat' }))
      toast.success(`已建群「${nm}」(${selected.size} 人)`)
      onChanged?.()
      onClose()
    } catch (e) {
      toast.error(`${editing ? '更新' : '建群'}失败：${e}`)
      setCreating(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-fade-in" onClick={onClose}>
      <div
        className="bg-[var(--color-bg-elevated)] rounded-3xl w-full max-w-md max-h-[85vh] shadow-2xl border border-[var(--color-border)] flex flex-col animate-slide-up"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--color-border)' }}>
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: 'var(--color-primary)22' }}>
              <Users size={18} style={{ color: 'var(--color-primary)' }} />
            </div>
            <h2 className="text-[15px] font-semibold" style={{ color: 'var(--color-text)' }}>{editing ? '编辑群' : '发起群聊'}</h2>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-[var(--color-bg-muted)] rounded-xl transition-all" title="取消">
            <X size={16} style={{ color: 'var(--color-text-muted)' }} />
          </button>
        </div>

        {/* 群名 + emoji */}
        <div className="px-5 pt-4 flex items-center gap-2">
          <input
            value={emoji}
            onChange={e => setEmoji(e.target.value.slice(0, 4))}
            placeholder="🎨"
            className="w-11 h-10 text-center text-[18px] rounded-xl outline-none shrink-0"
            style={{ background: 'var(--color-bg-subtle)', border: '1px solid var(--color-border)' }}
          />
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="群名(例:创作小队)"
            autoFocus
            className="flex-1 h-10 px-3 text-[14px] rounded-xl outline-none"
            style={{ background: 'var(--color-bg-subtle)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
          />
        </div>

        {/* 搜索 */}
        <div className="px-5 pt-3 pb-2">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--color-text-muted)' }} />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="搜索伙伴"
              className="w-full h-9 pl-9 pr-3 text-[13px] rounded-lg outline-none"
              style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text)' }}
            />
          </div>
        </div>

        {/* 成员列表 */}
        <div className="flex-1 overflow-y-auto px-2.5 pb-2 min-h-[160px]">
          {companions.length === 0 ? (
            <p className="text-[13px] text-center py-10" style={{ color: 'var(--color-text-muted)' }}>
              还没养任何伙伴 —— 先去「小精灵」收养
            </p>
          ) : filtered.length === 0 ? (
            <p className="text-[13px] text-center py-10" style={{ color: 'var(--color-text-muted)' }}>没有匹配的伙伴</p>
          ) : (
            filtered.map(c => {
              const on = selected.has(c.id)
              const accent = c.color_hex || 'var(--color-primary)'
              return (
                <button
                  key={c.id}
                  onClick={() => toggle(c.id)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors text-left"
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-bg-subtle)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                >
                  <div className="shrink-0 w-10 h-10 rounded-xl flex items-center justify-center text-[20px]" style={{ background: `${accent}26` }}>
                    {c.avatar_emoji || '🤖'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[14px] font-medium truncate" style={{ color: 'var(--color-text)' }}>{c.name}</div>
                    {c.role_label && (
                      <div className="text-[12px] truncate" style={{ color: 'var(--color-text-muted)' }}>{c.role_label}</div>
                    )}
                  </div>
                  <div
                    className="shrink-0 w-5 h-5 rounded-full flex items-center justify-center transition-all"
                    style={{
                      background: on ? accent : 'transparent',
                      border: on ? `1px solid ${accent}` : '1.5px solid var(--color-border-strong)',
                    }}
                  >
                    {on && <Check size={13} style={{ color: '#fff' }} strokeWidth={3} />}
                  </div>
                </button>
              )
            })
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t" style={{ borderColor: 'var(--color-border)' }}>
          <span className="text-[12.5px]" style={{ color: 'var(--color-text-muted)' }}>
            已选 <span className="font-semibold tabular-nums" style={{ color: 'var(--color-text-secondary)' }}>{selected.size}</span> 位
          </span>
          <button
            onClick={submit}
            disabled={creating || selected.size === 0 || !name.trim()}
            className="flex items-center gap-1.5 px-5 py-2 rounded-xl text-[13px] font-medium transition-all disabled:opacity-40"
            style={{ background: 'var(--color-primary)', color: '#fff' }}
          >
            {creating ? <Loader2 size={14} className="animate-spin" /> : <Users size={14} />}
            {editing ? '保存' : `创建${selected.size > 0 ? ` (${selected.size})` : ''}`}
          </button>
        </div>
      </div>
    </div>
  )
}
