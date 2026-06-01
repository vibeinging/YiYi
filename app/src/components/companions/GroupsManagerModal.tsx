/**
 * GroupsManagerModal — 会话侧的「群管理」弹窗。
 *
 * 从侧边栏 👥 菜单的「管理群」触发。承载:发起群聊 / 改名 / 加成员 / 删群
 * (GroupsSection)。原先埋在 YiYi 的"她记得"记忆卡里——概念错位(群属于会话层,
 * 不是 YiYi 的记忆),现挪到会话侧。
 *
 * 建群即开聊:GroupsSection 建群后会 dispatch 'navigate' 进 chat,本弹窗监听该
 * 事件自动关闭。
 */

import { useEffect } from 'react'
import { X, Users } from 'lucide-react'
import { GroupsSection } from './GroupsSection'

export function GroupsManagerModal({ onClose }: { onClose: () => void }) {
  // 锁背景滚动 + 建群跳转 chat 时自动关闭。
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onNavigate = () => onClose()
    window.addEventListener('navigate', onNavigate as EventListener)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('navigate', onNavigate as EventListener)
    }
  }, [onClose])

  return (
    <div
      className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-fade-in"
      onClick={onClose}
    >
      <div
        className="bg-[var(--color-bg-elevated)] rounded-3xl w-full max-w-lg max-h-[85vh] shadow-2xl border border-[var(--color-border)] flex flex-col animate-slide-up"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--color-border)' }}>
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: 'var(--color-primary)22' }}>
              <Users size={18} style={{ color: 'var(--color-primary)' }} />
            </div>
            <div>
              <h2 className="text-[15px] font-semibold" style={{ color: 'var(--color-text)' }}>管理群</h2>
              <p className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>发起群聊、改名、管理成员</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-[var(--color-bg-muted)] rounded-xl transition-all" title="关闭">
            <X size={16} style={{ color: 'var(--color-text-muted)' }} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <GroupsSection embedded />
        </div>
      </div>
    </div>
  )
}
