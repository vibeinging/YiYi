/**
 * 家族成员管理 Modal —— 两种模式合一:
 *
 * 1) `create` —— 在当前对话里直接拉成员 → 自动建家族 + 绑给本 session。
 *    用户感受 = 微信群"邀请新成员",但更轻:输入名 + 勾人 + 创建。
 * 2) `edit` —— 修改既有家族(改名/换 emoji / 加移成员 / 删家族)。
 *    入口:chat header 的「管理」按钮。
 *
 * 单成员限制:`create` 模式至少选 2 位(1 位 = 直接在输入框 @ 那位,不需要建组);
 * `edit` 模式不强制(允许临时空组留待添加)。
 */

import { useEffect, useState } from 'react'
import { X, Trash2 } from 'lucide-react'
import {
  addCompanionToGroup,
  createCompanionGroup,
  deleteCompanionGroup,
  listGroupMembers,
  removeCompanionFromGroup,
  setSessionGroup,
  updateCompanionGroup,
  type CompanionGroup,
} from '../../api/groups'
import { listCompanions, type Companion } from '../../api/companions'
import { useGroupsStore } from '../../stores/groupsStore'
import { toast, confirm } from '../Toast'

type Mode =
  | { kind: 'create'; sessionId: string }
  | { kind: 'edit'; group: CompanionGroup }

interface Props {
  mode: Mode
  onClose: () => void
  /** create 成功后回调,父组件可借此感知 session 已绑到新 group。 */
  onCreated?: (groupId: number) => void
  /** delete 成功后回调,父组件解绑 session 等。 */
  onDeleted?: (groupId: number) => void
}

export function FamilyMembersModal({ mode, onClose, onCreated, onDeleted }: Props) {
  const isCreate = mode.kind === 'create'
  const initialGroup = isCreate ? null : mode.group
  const [name, setName] = useState(initialGroup?.name ?? '')
  const [emoji, setEmoji] = useState(initialGroup?.emoji ?? '')
  const [companions, setCompanions] = useState<Companion[]>([])
  const [memberIds, setMemberIds] = useState<Set<number>>(new Set())
  /** edit 模式初始成员集 —— 保存时与当前 memberIds diff,决定 add/remove。 */
  const [initialMemberIds, setInitialMemberIds] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void listCompanions(false).then(setCompanions).catch(() => {})
    if (!isCreate) {
      void listGroupMembers(mode.group.id)
        .then(ms => {
          const ids = new Set(ms.map(m => m.id))
          setMemberIds(ids)
          setInitialMemberIds(new Set(ids))
        })
        .catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggleMember = (cid: number) => {
    const next = new Set(memberIds)
    if (next.has(cid)) next.delete(cid)
    else next.add(cid)
    setMemberIds(next)
  }

  const handleSave = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      toast.error('家族名不能为空')
      return
    }
    if (isCreate && memberIds.size < 2) {
      toast.error('家族需要至少 2 位成员(单聊一位直接在输入框 @)')
      return
    }
    setBusy(true)
    try {
      if (isCreate) {
        const gid = await createCompanionGroup(trimmed, emoji.trim() || null, null)
        for (const cid of memberIds) {
          await addCompanionToGroup(gid, cid)
        }
        // 把当前 session 绑到新建的家族 —— 单聊原地升级成群聊(IM 心智:对话
        // 不动,但从此 YiYi 让位给群成员)。
        await setSessionGroup(mode.sessionId, gid)
        toast.info(`已创建「${trimmed}」(${memberIds.size} 人),对话已变成群聊`)
        void useGroupsStore.getState().load()
        // 清成员缓存:这是新组,membersByGroup 还没拉过,下次自动拉。
        useGroupsStore.getState().invalidateMembers(gid)
        onCreated?.(gid)
        onClose()
      } else {
        await updateCompanionGroup(mode.group.id, trimmed, emoji.trim() || null, mode.group.color_hex)
        for (const cid of memberIds) {
          if (!initialMemberIds.has(cid)) await addCompanionToGroup(mode.group.id, cid)
        }
        for (const cid of initialMemberIds) {
          if (!memberIds.has(cid)) await removeCompanionFromGroup(mode.group.id, cid)
        }
        toast.info(`已更新「${trimmed}」`)
        void useGroupsStore.getState().load()
        // 改了成员 → 清缓存,FamilyHeader 头像横排和 SidebarSessionCard 头像
        // 拼图下次自动拉新成员。
        useGroupsStore.getState().invalidateMembers(mode.group.id)
        onClose()
      }
    } catch (e) {
      toast.error(`操作失败: ${e}`)
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    if (isCreate) return
    const ok = await confirm(
      `确定删除家族「${mode.group.name}」?成员关系会一起清,共享记忆桶保留(可在 BuddyPanel 手动清)。`,
    )
    if (!ok) return
    setBusy(true)
    try {
      await deleteCompanionGroup(mode.group.id)
      toast.info(`已删除「${mode.group.name}」`)
      void useGroupsStore.getState().load()
      onDeleted?.(mode.group.id)
      onClose()
    } catch (e) {
      toast.error(`删除失败: ${e}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.4)' }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="w-[420px] max-h-[80vh] flex flex-col rounded-2xl shadow-2xl"
        style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)' }}
      >
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--color-bg-subtle)' }}>
          <div className="text-[14px] font-semibold" style={{ color: 'var(--color-text)' }}>
            {isCreate ? '邀请家族成员（建一个家族）' : `管理「${initialGroup?.name}」`}
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded transition-colors hover:bg-[var(--color-bg-subtle)]"
          >
            <X size={14} style={{ color: 'var(--color-text-muted)' }} />
          </button>
        </div>

        <div className="px-4 py-3 space-y-3 overflow-y-auto">
          {isCreate && (
            <div
              className="text-[11px] px-3 py-2 rounded-lg"
              style={{
                background: 'var(--color-bg-subtle)',
                color: 'var(--color-text-muted)',
                border: '1px solid var(--color-border)',
              }}
            >
              👪 这个对话将变成群聊 —— 拉的家人进群后,以后 YiYi 不再单独回复你,
              而是大家一起在群里说。想保留纯单聊请新建一个对话。
            </div>
          )}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={emoji}
              onChange={e => setEmoji(e.target.value.slice(0, 4))}
              placeholder="🎨"
              className="w-12 text-center text-[16px] px-2 py-1.5 rounded outline-none"
              style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
            />
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="家族名(例:创作小队)"
              autoFocus={isCreate}
              className="flex-1 text-[13px] px-3 py-1.5 rounded outline-none"
              style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
            />
          </div>

          <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
            成员({memberIds.size} 人{isCreate ? ',至少 2 位' : ''})
          </div>
          <div className="max-h-[280px] overflow-y-auto space-y-1">
            {companions.map(c => {
              const checked = memberIds.has(c.id)
              return (
                <label
                  key={c.id}
                  className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors hover:bg-[var(--color-bg-subtle)]"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleMember(c.id)}
                    className="cursor-pointer"
                  />
                  <span className="text-[14px]">{c.avatar_emoji}</span>
                  <span className="flex-1 text-[12px] truncate" style={{ color: checked ? 'var(--color-text)' : 'var(--color-text-muted)' }}>
                    {c.name}
                  </span>
                </label>
              )
            })}
            {companions.length === 0 && (
              <div className="py-3 text-center text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
                还没收养任何分身 —— 先去家族页收养
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between px-4 py-3" style={{ borderTop: '1px solid var(--color-bg-subtle)' }}>
          <div>
            {!isCreate && (
              <button
                onClick={handleDelete}
                disabled={busy}
                className="flex items-center gap-1 text-[12px] px-2 py-1 rounded transition-colors hover:bg-[var(--color-bg-subtle)] disabled:opacity-40"
                style={{ color: 'var(--color-error)' }}
              >
                <Trash2 size={12} />
                删除家族
              </button>
            )}
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={onClose}
              disabled={busy}
              className="text-[12px] px-3 py-1.5 rounded transition-colors hover:bg-[var(--color-bg-subtle)]"
              style={{ color: 'var(--color-text-muted)' }}
            >
              取消
            </button>
            <button
              onClick={handleSave}
              disabled={busy}
              className="text-[12px] px-3 py-1.5 rounded font-medium disabled:opacity-50"
              style={{ background: 'var(--color-primary)', color: 'white' }}
            >
              {isCreate ? '建家族' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
