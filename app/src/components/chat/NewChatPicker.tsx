/**
 * 新对话 picker(L3,WeChat 模式)—— 点 "+ 新对话" 时不直接进空白对话,先出
 * 这个 picker 让用户挑「单聊主精灵 / 现有家族 / 新建家族」。
 *
 * 流程:
 * - 单聊主精灵 → createNewChat → 直接进新对话(就是老路径)。
 * - 已建家族 → createNewChat → setSessionGroup + setFamilyMode → 进对话(已绑组)。
 * - 新建家族 → createNewChat → 切到 FamilyMembersModal(create 模式),建完自动
 *   绑当前会话(modal 内部已包含 setSessionGroup)。
 *
 * 设计:docs/design/2026-05-27_家族会话-host调度群聊.md Approach B(IM 心智)。
 */

import { useEffect, useState } from 'react'
import { X, Plus, MessageCircle } from 'lucide-react'
import { setSessionGroup } from '../../api/groups'
import { setFamilyMode } from '../../api/agent'
import { useGroupsStore } from '../../stores/groupsStore'
import { useSessionStore } from '../../stores/sessionStore'
import { toast } from '../Toast'
import { FamilyMembersModal } from './FamilyMembersModal'

interface Props {
  onClose: () => void
  /** picker 决议出新 session 后,通知父组件切到 chat 页(原 onPageChange 行为)。 */
  onNavigate: () => void
}

export function NewChatPicker({ onClose, onNavigate }: Props) {
  const groups = useGroupsStore(s => s.groups)
  const loaded = useGroupsStore(s => s.loaded)
  const load = useGroupsStore(s => s.load)
  const createNewChat = useSessionStore(s => s.createNewChat)
  const [busy, setBusy] = useState(false)
  /** 切到 FamilyMembersModal(create 模式)时的 sessionId;null = 主 list 视图。 */
  const [creatingForSession, setCreatingForSession] = useState<string | null>(null)

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  // 切到了"建家族"流程 —— 卸掉本 picker,让 FamilyMembersModal 接管。
  if (creatingForSession) {
    return (
      <FamilyMembersModal
        mode={{ kind: 'create', sessionId: creatingForSession }}
        onClose={() => {
          // 不管成功/取消都关掉整组:已 createNewChat,session 会留下,用户在新对话里继续。
          onClose()
        }}
        onCreated={() => {
          // modal 已绑 group + 创建,用户现在在新对话里且已是家族会话。
          onClose()
        }}
      />
    )
  }

  const handleSolo = async () => {
    setBusy(true)
    try {
      await createNewChat()
      onNavigate()
      onClose()
    } catch (e) {
      toast.error(`新建对话失败: ${e}`)
    } finally {
      setBusy(false)
    }
  }

  const handleExistingGroup = async (gid: number) => {
    setBusy(true)
    try {
      const sid = await createNewChat()
      if (!sid) {
        toast.error('新建对话失败')
        return
      }
      await setSessionGroup(sid, gid)
      await setFamilyMode(sid, true)
      onNavigate()
      onClose()
    } catch (e) {
      toast.error(`新建家族对话失败: ${e}`)
    } finally {
      setBusy(false)
    }
  }

  const handleCreateNew = async () => {
    setBusy(true)
    try {
      const sid = await createNewChat()
      if (!sid) {
        toast.error('新建对话失败')
        return
      }
      onNavigate()
      // 切到 FamilyMembersModal 让用户填家族信息;modal 关闭即整组关闭。
      setCreatingForSession(sid)
    } catch (e) {
      toast.error(`新建对话失败: ${e}`)
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
        className="w-[380px] max-h-[80vh] flex flex-col rounded-2xl shadow-2xl"
        style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)' }}
      >
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--color-bg-subtle)' }}>
          <div className="text-[14px] font-semibold" style={{ color: 'var(--color-text)' }}>
            和谁聊?
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded transition-colors hover:bg-[var(--color-bg-subtle)]"
          >
            <X size={14} style={{ color: 'var(--color-text-muted)' }} />
          </button>
        </div>

        <div className="px-2 py-2 overflow-y-auto">
          {/* 单聊主精灵 */}
          <button
            onClick={handleSolo}
            disabled={busy}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors hover:bg-[var(--color-bg-subtle)] disabled:opacity-40"
          >
            <MessageCircle size={16} style={{ color: 'var(--color-primary)' }} />
            <div className="flex-1">
              <div className="text-[13px] font-medium" style={{ color: 'var(--color-text)' }}>
                和主精灵单聊
              </div>
              <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                老路径,主精灵亲自回
              </div>
            </div>
          </button>

          {groups.length > 0 && (
            <>
              <div className="mt-2 mb-1 px-3 text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
                —— 已建家族 ——
              </div>
              {groups.map(g => (
                <button
                  key={g.id}
                  onClick={() => handleExistingGroup(g.id)}
                  disabled={busy}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors hover:bg-[var(--color-bg-subtle)] disabled:opacity-40"
                >
                  <span className="text-[18px]" style={{ color: g.color_hex || undefined }}>
                    {g.emoji || '👪'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium truncate" style={{ color: 'var(--color-text)' }}>
                      {g.name}
                    </div>
                    <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                      进这个家族的新对话
                    </div>
                  </div>
                </button>
              ))}
            </>
          )}

          <div className="mt-2 mb-1 px-3 text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
            —— 建一个新的 ——
          </div>
          <button
            onClick={handleCreateNew}
            disabled={busy}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors hover:bg-[var(--color-bg-subtle)] disabled:opacity-40"
          >
            <Plus size={16} style={{ color: 'var(--color-text-muted)' }} />
            <div className="flex-1">
              <div className="text-[13px] font-medium" style={{ color: 'var(--color-text)' }}>
                新建家族
              </div>
              <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                给小队起个名,挑成员,在这个家族里聊
              </div>
            </div>
          </button>
        </div>
      </div>
    </div>
  )
}
