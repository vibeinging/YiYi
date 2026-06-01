/**
 * GroupSharedMemory — 每个群独占的共享记忆桶(`group_shared_<id>`)浏览器。
 *
 * chips 按群切换,看这个群里 dispatched 成员共用的记忆,可删——白盒原则的
 * "被动信息可见可删"。自洽取数。原先内嵌在 BuddyPanel 的"她记得"卡,
 * 现随群管理一起挪到会话侧的群管理弹窗。
 */

import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { listCompanionGroups, groupBucket, type CompanionGroup } from '../../api/groups'
import { listRecentMemories, deleteMemory, type MemoryEntry } from '../../api/buddy'
import { toast } from '../Toast'

const catLabel = (c: string) =>
  ({ fact: '事实', preference: '偏好', experience: '经验', decision: '决策', principle: '原则', note: '备注' }[c] || c)

export function GroupSharedMemory() {
  const [groups, setGroups] = useState<CompanionGroup[]>([])
  const [activeGroupId, setActiveGroupId] = useState<number | null>(null)
  const [memories, setMemories] = useState<MemoryEntry[]>([])

  const loadBucket = (gid: number) => {
    setActiveGroupId(gid)
    listRecentMemories(15, groupBucket(gid)).then(setMemories).catch(() => setMemories([]))
  }

  useEffect(() => {
    listCompanionGroups()
      .then(gs => {
        setGroups(gs)
        if (gs.length > 0) loadBucket(gs[0].id)
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (groups.length === 0) {
    return (
      <div className="py-4 text-center text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
        还没建任何群 —— 建一个,群里聊几轮就有共享记忆了
      </div>
    )
  }

  return (
    <div>
      {/* 桶切换 chips:每个群一颗 */}
      <div className="flex items-center gap-1.5 flex-wrap mb-2">
        {groups.map(g => {
          const selected = activeGroupId === g.id
          return (
            <button
              key={g.id}
              onClick={() => loadBucket(g.id)}
              className="text-[11px] px-2 py-0.5 rounded-full transition-colors"
              style={{
                background: selected ? (g.color_hex || 'var(--color-primary)') : 'var(--color-bg-subtle)',
                color: selected ? 'white' : 'var(--color-text-muted)',
              }}
            >
              {g.emoji || '👪'} {g.name}
            </button>
          )
        })}
      </div>

      {memories.length === 0 ? (
        <div className="py-3 text-center text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
          这个群还没共享记忆 —— 在群里聊几轮就有了
        </div>
      ) : (
        <div className="space-y-1 max-h-[300px] overflow-y-auto">
          {memories.map(m => (
            <div key={m.id} className="group flex gap-3 py-2.5 px-3 -mx-3 rounded-lg hover:bg-[var(--color-bg-subtle)] transition-colors">
              <div className="flex-1 min-w-0">
                <div className="text-[12px] leading-relaxed" style={{ color: 'var(--color-text)' }}>
                  {m.content.length > 200 ? m.content.slice(0, 200) + '...' : m.content}
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-muted)' }}>
                    {catLabel(m.categories[0] || 'note')}
                  </span>
                  <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>{m.created_at.slice(0, 10)}</span>
                </div>
              </div>
              <button
                onClick={async () => {
                  try {
                    await deleteMemory(m.id)
                    setMemories(p => p.filter(x => x.id !== m.id))
                    toast.success('记忆已删除')
                  } catch {
                    toast.error('删除失败')
                  }
                }}
                className="p-1 rounded shrink-0 self-start opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <Trash2 size={12} style={{ color: 'var(--color-error)' }} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
