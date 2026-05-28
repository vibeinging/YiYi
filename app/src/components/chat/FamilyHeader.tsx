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
import { Plus, Users, Settings } from 'lucide-react'
import { listGroupMembers, type CompanionGroup } from '../../api/groups'
import { useGroupsStore } from '../../stores/groupsStore'
import { FamilyMembersModal } from './FamilyMembersModal'

type ModalMode =
  | { kind: 'create'; sessionId: string }
  | { kind: 'edit'; group: CompanionGroup }
  | null

interface Props {
  sessionId: string
  familyGroupId: number | null
  /** Chat.tsx 的 handleSetFamily —— 创建/删家族成功后同步前端状态(双写
   *  family_mode + group_id)。 */
  onSetFamily: (mode: boolean, groupId: number | null) => void
}

export function FamilyHeader({ sessionId, familyGroupId, onSetFamily }: Props) {
  const group = useGroupsStore(s => (familyGroupId != null ? s.byId.get(familyGroupId) : undefined))
  const [memberCount, setMemberCount] = useState(0)
  const [modal, setModal] = useState<ModalMode>(null)

  // 懒查成员数:familyGroupId 变了就重拉。group 自身更新由 store 推动。
  useEffect(() => {
    if (familyGroupId == null) {
      setMemberCount(0)
      return
    }
    void listGroupMembers(familyGroupId)
      .then(ms => setMemberCount(ms.length))
      .catch(() => setMemberCount(0))
  }, [familyGroupId])

  if (!sessionId) return null

  // 已绑具名家族 → 信息条 + 管理按钮
  if (group) {
    return (
      <>
        <div
          className="shrink-0 flex items-center gap-2 px-3 py-1.5 text-[12px]"
          style={{
            background: 'var(--color-bg)',
            borderBottom: '1px solid var(--color-border)',
          }}
        >
          <span style={{ color: group.color_hex || 'var(--color-text)' }}>{group.emoji || '👪'}</span>
          <span className="font-medium" style={{ color: 'var(--color-text)' }}>{group.name}</span>
          <span className="flex items-center gap-1" style={{ color: 'var(--color-text-muted)' }}>
            <Users size={11} />
            {memberCount} 人
          </span>
          <div className="flex-1" />
          <button
            onClick={() => setModal({ kind: 'edit', group })}
            className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded transition-colors hover:bg-[var(--color-bg-subtle)]"
            style={{ color: 'var(--color-text-muted)' }}
            title="管理这个家族(改名/成员/删除)"
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
              // 删了当前绑的家族 → 把 session 退回未绑(回落普通对话)。
              onSetFamily(false, null)
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
          title="拉几位家族成员一起聊(自动建一个家族)"
        >
          <Plus size={11} />
          邀请家族成员
        </button>
      </div>
      {modal && modal.kind === 'create' && (
        <FamilyMembersModal
          mode={modal}
          onClose={() => setModal(null)}
          onCreated={(gid) => {
            // 新建家族后:session 已在 modal 里绑好,这里同步前端状态(双写 family_mode + group_id)。
            onSetFamily(true, gid)
          }}
        />
      )}
    </>
  )
}
