/**
 * 群(companion groups)管理区。建群/编辑走微信式 GroupCreateModal(漂亮的选人列表),
 * 这里只负责:发起群聊入口 + 群列表(改名成员走编辑、删除)。
 *
 * 每组的成员是 ChatInput 群路由 roster,且共享一个 `group_shared_<id>` 记忆桶
 * (在「群共享记忆」区按组查看)。
 */

import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, Plus, Pencil, Trash2 } from 'lucide-react'
import { deleteCompanionGroup, type CompanionGroup } from '../../api/groups'
import { toast, confirm } from '../Toast'
import { useGroupsStore } from '../../stores/groupsStore'
import { GroupCreateModal } from './GroupCreateModal'

type ModalState =
  | null
  | { mode: 'create' }
  | { mode: 'edit'; group: { id: number; name: string; emoji: string; memberIds: number[] } }

export function GroupsSection({ embedded = false }: { embedded?: boolean } = {}) {
  // embedded(弹窗里):默认展开、不渲染折叠头、不要顶部分隔边框。
  const [expanded, setExpanded] = useState(embedded)
  const [modal, setModal] = useState<ModalState>(null)

  const groups = useGroupsStore(s => s.groups)
  const membersByGroup = useGroupsStore(s => s.membersByGroup)
  const ensureMembers = useGroupsStore(s => s.ensureMembers)

  const refreshGroups = async () => {
    await useGroupsStore.getState().load()
    for (const g of useGroupsStore.getState().groups) void ensureMembers(g.id)
  }

  useEffect(() => {
    if (!expanded) return
    void refreshGroups()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded])

  const startEdit = async (g: CompanionGroup) => {
    await ensureMembers(g.id)
    const memberIds = (useGroupsStore.getState().membersByGroup.get(g.id) ?? []).map(m => m.id)
    setModal({ mode: 'edit', group: { id: g.id, name: g.name, emoji: g.emoji ?? '', memberIds } })
  }

  const handleDelete = async (g: CompanionGroup) => {
    const ok = await confirm(
      `确定删除群「${g.name}」?成员关系会一起清,这个群累积的共享记忆桶保留(可在"群共享记忆"里手动清)。`,
    )
    if (!ok) return
    try {
      await deleteCompanionGroup(g.id)
      toast.info(`已删除群「${g.name}」`)
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
        <div className="space-y-1.5">
          <button
            onClick={() => setModal({ mode: 'create' })}
            className="flex items-center gap-1.5 text-[13px] px-3 py-2 rounded-lg transition-colors w-full"
            style={{ color: 'var(--color-primary)', background: 'var(--color-bg-subtle)' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-bg-muted)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-bg-subtle)' }}
          >
            <Plus size={14} />
            发起群聊
          </button>

          {groups.length === 0 ? (
            <div className="py-3 text-center text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
              还没建任何群 —— 点上面「发起群聊」开始
            </div>
          ) : (
            groups.map(g => {
              const memberCount = membersByGroup.get(g.id)?.length ?? 0
              return (
                <div
                  key={g.id}
                  className="group flex items-center gap-2.5 px-3 py-2 rounded-lg transition-colors"
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-bg-subtle)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                >
                  <div
                    className="shrink-0 w-9 h-9 rounded-xl flex items-center justify-center text-[18px]"
                    style={{ background: g.color_hex ? `${g.color_hex}26` : 'var(--color-bg-subtle)' }}
                  >
                    {g.emoji || '👪'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium truncate" style={{ color: 'var(--color-text)' }}>{g.name}</div>
                    <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>{memberCount} 位成员</div>
                  </div>
                  <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => startEdit(g)} className="p-1.5 rounded-md transition-colors hover:bg-[var(--color-bg-muted)]" title="编辑">
                      <Pencil size={13} style={{ color: 'var(--color-text-muted)' }} />
                    </button>
                    <button onClick={() => handleDelete(g)} className="p-1.5 rounded-md transition-colors hover:bg-[var(--color-bg-muted)]" title="删除">
                      <Trash2 size={13} style={{ color: 'var(--color-error)' }} />
                    </button>
                  </div>
                </div>
              )
            })
          )}
        </div>
      )}

      {modal && (
        <GroupCreateModal
          group={modal.mode === 'edit' ? modal.group : undefined}
          onClose={() => setModal(null)}
          onChanged={refreshGroups}
        />
      )}
    </div>
  )
}
