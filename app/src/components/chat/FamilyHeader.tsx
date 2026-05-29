/**
 * 家族头条 —— 聊天区顶部一条家族关系指示器 + 入口。两种视觉态:
 *
 * 1) 当前 session 绑了家族 → 显示 `📝 创作小队 · 3 人` 加 [管理] 按钮。
 *    点 管理 → 开 FamilyMembersModal(edit 模式)。删家族 → 自动解绑当前会话。
 * 2) 未绑家族 → 显示 `+ 邀请家族成员` 低调按钮(总是出现,引导新手发现路径)。
 *    点击 → 开 FamilyMembersModal(create 模式),完成后自动绑当前会话 + 切到
 *    家族会话模式。
 *
 * 这是把 IM 群聊心智下沉到聊天区里的入口(L2)—— 让"@着 @着就形成群"的直觉
 * 在 UI 上有立足点。
 */

import { useEffect, useState } from 'react'
import { Plus, Settings } from 'lucide-react'
import { type CompanionGroup } from '../../api/groups'
import { useGroupsStore } from '../../stores/groupsStore'
import { FamilyMembersModal } from './FamilyMembersModal'

type ModalMode =
  | { kind: 'create'; sessionId: string }
  | { kind: 'edit'; group: CompanionGroup }
  | null

interface Props {
  sessionId: string
  familyGroupId: number | null
  /** Chat.tsx 的 handleSetFamily —— 创建/删群成功后同步前端 group_id 状态
   *  (family_mode 字段已退役,只写 group_id)。 */
  onSetFamily: (groupId: number | null) => void
}

export function FamilyHeader({ sessionId, familyGroupId, onSetFamily }: Props) {
  const group = useGroupsStore(s => (familyGroupId != null ? s.byId.get(familyGroupId) : undefined))
  const ensureMembers = useGroupsStore(s => s.ensureMembers)
  // 单一数据源:直接订阅 store,不再 copy 进本地 state。invalidateMembers 后
  // store 变化会触发 re-render,头像横排即时刷新(与 AvatarGrid / FamilyGroupsSection 一致)。
  const members = useGroupsStore(s => (familyGroupId != null ? s.membersByGroup.get(familyGroupId) : undefined)) ?? []
  const [modal, setModal] = useState<ModalMode>(null)

  // 懒查成员:familyGroupId 变了且没拉过就触发拉取(fire-and-forget,结果落 store)。
  useEffect(() => {
    if (familyGroupId != null) void ensureMembers(familyGroupId)
  }, [familyGroupId, ensureMembers])

  if (!sessionId) return null

  // 已绑具名家族 → 群聊 header:emoji + 名 + 成员头像横排 + 管理菜单
  if (group) {
    return (
      <>
        <div
          className="shrink-0 flex items-center gap-2 px-3 py-2 text-[12px]"
          style={{
            background: 'var(--color-bg)',
            borderBottom: '1px solid var(--color-border)',
          }}
        >
          <span className="text-[15px]" style={{ color: group.color_hex || 'var(--color-text)' }}>
            {group.emoji || '👪'}
          </span>
          <span className="font-medium" style={{ color: 'var(--color-text)' }}>{group.name}</span>
          {/* 成员头像横排 —— 直观感受群里有谁,点击进管理。 */}
          <button
            type="button"
            onClick={() => setModal({ kind: 'edit', group })}
            className="flex items-center -space-x-1.5 ml-1 transition-opacity hover:opacity-80"
            title="点击管理群(改名 / 加人 / 踢人)"
          >
            {members.slice(0, 5).map(m => (
              <div
                key={m.id}
                className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] shrink-0"
                style={{
                  background: m.color_hex ? `${m.color_hex}33` : 'var(--color-bg-subtle)',
                  border: '1.5px solid var(--color-bg)',
                  color: 'var(--color-text)',
                }}
                title={m.name}
              >
                {m.avatar_emoji || '🤖'}
              </div>
            ))}
            {members.length > 5 && (
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] shrink-0 font-medium"
                style={{
                  background: 'var(--color-bg-subtle)',
                  border: '1.5px solid var(--color-bg)',
                  color: 'var(--color-text-muted)',
                }}
              >
                +{members.length - 5}
              </div>
            )}
            <span className="ml-2 text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
              {members.length} 人
            </span>
          </button>
          <div className="flex-1" />
          <button
            onClick={() => setModal({ kind: 'edit', group })}
            className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded transition-colors hover:bg-[var(--color-bg-subtle)]"
            style={{ color: 'var(--color-text-muted)' }}
            title="管理这个群(改名/成员/删除)"
          >
            <Settings size={11} />
            管理
          </button>
        </div>
        {modal && modal.kind === 'edit' && (
          <FamilyMembersModal
            mode={modal}
            onClose={() => setModal(null)}
            onDeleted={() => {
              // 删了当前绑的群 → 把 session 退回未绑(回落普通对话)。
              onSetFamily(null)
            }}
          />
        )}
      </>
    )
  }

  // 未绑 → 低调的"+邀请"按钮(IM 心智入口:在对话里直接拉人组群)
  return (
    <>
      <div
        className="shrink-0 flex items-center px-3 py-1"
        style={{ background: 'var(--color-bg)', borderBottom: '1px solid var(--color-border)' }}
      >
        <button
          onClick={() => setModal({ kind: 'create', sessionId })}
          className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded transition-colors hover:bg-[var(--color-bg-subtle)]"
          style={{ color: 'var(--color-text-muted)' }}
          title="拉几位伙伴一起聊(自动建一个群)"
        >
          <Plus size={11} />
          邀请伙伴进群
        </button>
      </div>
      {modal && modal.kind === 'create' && (
        <FamilyMembersModal
          mode={modal}
          onClose={() => setModal(null)}
          onCreated={(gid) => {
            // 新建群后:session 已在 modal 里绑好,这里同步前端 group_id 状态。
            onSetFamily(gid)
          }}
        />
      )}
    </>
  )
}
