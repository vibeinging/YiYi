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
import { X, Trash2, Loader2, UsersRound, ChevronLeft } from 'lucide-react'
import { GroupTypeLauncher } from '../companions/GroupTypeLauncher'
import { CustomTeamPanel } from '../companions/CustomTeamPanel'
import {
  addCompanionToGroup,
  createGroupWithMembers,
  deleteCompanionGroup,
  listGroupMembers,
  removeCompanionFromGroup,
  setSessionGroup,
  updateCompanionGroup,
  type CompanionGroup,
} from '../../api/groups'
import { adoptSoftwareCompanyTeam, listCompanions, type Companion } from '../../api/companions'
import { useGroupsStore } from '../../stores/groupsStore'
import { useSessionStore } from '../../stores/sessionStore'
import { toast, confirm } from '../Toast'
import { validateGroupForm } from '../../utils/group'

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
  /** 一键组团的独立 busy —— 与手动建群 busy 分开,两个按钮各自转圈。 */
  const [teamBusy, setTeamBusy] = useState(false)
  /** create 模式:launcher 选群类型 → form 选人 / custom 自生成团队;edit 直接 form。 */
  const [view, setView] = useState<'launcher' | 'form' | 'custom'>(isCreate ? 'launcher' : 'form')

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
    const err = validateGroupForm(trimmed, memberIds, isCreate)
    if (err) {
      toast.error(err)
      return
    }
    setBusy(true)
    try {
      if (isCreate) {
        // 建群 + 加成员(中途失败自动回滚删组),再把当前 session 绑到新群 ——
        // 单聊原地升级成群聊(IM 心智:对话不动,但从此 YiYi 让位给群成员)。
        // 绑定失败也回滚删组:这是"原地升级"语义,绑不上等于升级没成功。
        const gid = await createGroupWithMembers(trimmed, emoji.trim() || null, memberIds)
        try {
          await setSessionGroup(mode.sessionId, gid)
        } catch (e) {
          await deleteCompanionGroup(gid).catch(() => {})
          throw e
        }
        // 清成员缓存(新组没拉过) → await load 让 byId 有这个群(FamilyHeader/侧栏要读)
        // → await refreshSessions 把 chatSessions[].group_id 更新掉(否则侧栏会话卡还显示
        // 旧名 + YiYi 头像,因为 setSessionGroup 只 invoke 不动 store)。
        useGroupsStore.getState().invalidateMembers(gid)
        await useGroupsStore.getState().load()
        await useSessionStore.getState().refreshSessions()
        toast.info(`已建群「${trimmed}」(${memberIds.size} 人),对话已变成群聊`)
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

  // 一键组建软件公司团队:后端批量收养 5 角色 + 建群,再把当前对话原地升级绑到该群
  // (与 handleSave 的 create 分支同语义,只是省去手动起名/勾人)。仅 create 模式可用。
  const createSoftwareTeam = async () => {
    if (mode.kind !== 'create' || busy || teamBusy) return
    setTeamBusy(true)
    try {
      const gid = await adoptSoftwareCompanyTeam()
      // 不回滚删组:adopt 已建群 + 收养 5 个新伙伴,删组只删群会留下孤儿伙伴(比
      // createGroupWithMembers 的纯空组更糟)。绑定失败就抛错,团队留着可重试绑定 ——
      // 与 GroupCreateModal.createSoftwareTeam 行为一致(都不回滚)。
      await setSessionGroup(mode.sessionId, gid)
      // 顺序同 handleSave create 分支:清成员缓存 → await load(byId 有群)→
      // await refreshSessions(chatSessions[].group_id 更新,侧栏卡才显示群名 + 头像拼图)。
      useGroupsStore.getState().invalidateMembers(gid)
      await useGroupsStore.getState().load()
      await useSessionStore.getState().refreshSessions()
      toast.success('软件公司团队已就位 — PM·UI·前端·后端·测试 5 人,对话已变群聊')
      onCreated?.(gid)
      onClose()
    } catch (e) {
      toast.error(`组建团队失败：${e}`)
      setTeamBusy(false)
    }
  }

  const handleDelete = async () => {
    if (isCreate) return
    const ok = await confirm(
      `确定删除群「${mode.group.name}」?成员关系会一起清,共享记忆桶保留(可在伙伴面板手动清)。`,
    )
    if (!ok) return
    setBusy(true)
    try {
      await deleteCompanionGroup(mode.group.id)
      toast.info(`已删除群「${mode.group.name}」`)
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
      style={{ background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="w-[420px] max-h-[80vh] flex flex-col rounded-2xl shadow-2xl"
        style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)' }}
      >
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--color-bg-subtle)' }}>
          <div className="flex items-center gap-1.5">
            {isCreate && view !== 'launcher' && (
              <button
                onClick={() => setView('launcher')}
                disabled={busy || teamBusy}
                className="p-1 -ml-1 rounded transition-colors hover:bg-[var(--color-bg-subtle)] disabled:opacity-40"
                title="返回选群类型"
              >
                <ChevronLeft size={16} style={{ color: 'var(--color-text-muted)' }} />
              </button>
            )}
            <div className="text-[14px] font-semibold" style={{ color: 'var(--color-text)' }}>
              {!isCreate
                ? `管理群「${initialGroup?.name}」`
                : view === 'launcher'
                  ? '发起群聊'
                  : view === 'custom'
                    ? '自定义团队 · YiYi 组队'
                    : '纯聊天群 · 选伙伴'}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded transition-colors hover:bg-[var(--color-bg-subtle)]"
          >
            <X size={14} style={{ color: 'var(--color-text-muted)' }} />
          </button>
        </div>

        {isCreate && view === 'launcher' ? (
          <GroupTypeLauncher
            onPickSocial={() => setView('form')}
            onPickSoftwareCompany={createSoftwareTeam}
            onPickCustom={() => setView('custom')}
            softwareTeamBusy={teamBusy}
            busy={busy}
            className="px-4 py-3 space-y-2.5"
          />
        ) : isCreate && view === 'custom' ? (
          <CustomTeamPanel onClose={onClose} />
        ) : (
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
              👪 这个对话将变成群聊 —— 拉伙伴进群后,以后 YiYi 不再单独回复你,
              而是大家一起在群里说。<b>升级后不能退回单聊</b>,想保留纯单聊请改为新建一个对话。
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
              placeholder="群名(例:创作小队)"
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
                    style={{ accentColor: 'var(--color-primary)' }}
                  />
                  <span className="text-[14px]">{c.avatar_emoji}</span>
                  <span className="flex-1 text-[12px] truncate" style={{ color: checked ? 'var(--color-text)' : 'var(--color-text-muted)' }}>
                    {c.name}
                  </span>
                </label>
              )
            })}
            {companions.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-6 text-center" style={{ color: 'var(--color-text-muted)' }}>
                <UsersRound size={26} style={{ opacity: 0.5 }} />
                <div className="text-[12px]">还没养任何伙伴</div>
                <div className="text-[11px]" style={{ opacity: 0.8 }}>先去"我的伙伴"里收养一个,再来建群</div>
              </div>
            )}
          </div>
        </div>
        )}

        {(!isCreate || view === 'form') && (
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
                删除群
              </button>
            )}
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={onClose}
              disabled={busy || teamBusy}
              className="text-[12px] px-3 py-1.5 rounded transition-colors hover:bg-[var(--color-bg-subtle)]"
              style={{ color: 'var(--color-text-muted)' }}
            >
              取消
            </button>
            <button
              onClick={handleSave}
              disabled={busy || teamBusy}
              className="flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded font-medium transition-[filter] hover:brightness-110 active:brightness-95 disabled:opacity-50"
              style={{ background: 'var(--color-primary)', color: 'white' }}
            >
              {busy && <Loader2 size={12} className="animate-spin" />}
              {isCreate ? '建群' : '保存'}
            </button>
          </div>
        </div>
        )}
      </div>
    </div>
  )
}
