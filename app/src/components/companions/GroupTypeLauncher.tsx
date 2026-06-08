/**
 * GroupTypeLauncher —— 建群启动器(G0)。
 *
 * 「发起群聊」的第 0 步:先选**建什么群**,而不是直接进选人列表。
 * 软件公司只是众多预设之一(角色不固定,未来 agent 可自生成团队)。
 *
 * 共享给两条建群路径(各自绑定语义不同,故只共享"类型选择"这层):
 *   - GroupCreateModal(Buddy 页 / TaskSidebar)—— 新开会话进群
 *   - FamilyMembersModal(聊天 header)—— 当前会话原地升级
 *
 * 三类入口:
 *   👥 纯聊天群   → onPickSocial:进现有选人表单(无角色 / 无工作区)
 *   🏢 软件公司群 → onPickSoftwareCompany:一键成团(adopt_software_company_team)
 *   🛠️ 自定义团队 → G2「agent 自生成」入口,当前占位禁用
 */

import { Loader2 } from 'lucide-react'

interface Props {
  /** 纯聊天群 —— 进选人表单。 */
  onPickSocial: () => void
  /** 软件公司群 —— 一键成团。 */
  onPickSoftwareCompany: () => void
  /** 自定义团队 —— 进 agent 自生成流程(G2)。 */
  onPickCustom: () => void
  /** 软件公司成团进行中(卡片转圈)。 */
  softwareTeamBusy: boolean
  /** 其它操作进行时整体禁用。 */
  busy?: boolean
  /** 外层容器 className —— 让宿主 modal 对齐自己的水平内边距(默认 px-5,FamilyMembersModal 用 px-4)。 */
  className?: string
}

export function GroupTypeLauncher({
  onPickSocial,
  onPickSoftwareCompany,
  onPickCustom,
  softwareTeamBusy,
  busy,
  className = 'px-5 py-4 space-y-2.5',
}: Props) {
  const disabled = !!busy || softwareTeamBusy

  return (
    <div className={className}>
      {/* 纯聊天群 */}
      <LauncherCard
        emoji="👥"
        title="纯聊天群"
        desc="拉几个伙伴随便聊 —— 无角色、无工作区"
        onClick={onPickSocial}
        disabled={disabled}
      />

      {/* 软件公司群(内置角色预设) */}
      <LauncherCard
        emoji="🏢"
        title="软件公司群"
        desc="PM · UI · 前端 · 后端 · 测试 —— 5 人成团即开工"
        onClick={onPickSoftwareCompany}
        disabled={disabled}
        accent
        spinner={softwareTeamBusy}
      />

      {/* 自定义团队(G2:agent 自生成) */}
      <LauncherCard
        emoji="🛠️"
        title="自定义团队"
        desc="描述要做什么,YiYi 自动组队"
        onClick={onPickCustom}
        disabled={disabled}
      />
    </div>
  )
}

function LauncherCard({
  emoji,
  title,
  desc,
  onClick,
  disabled,
  accent,
  spinner,
  badge,
}: {
  emoji: string
  title: string
  desc: string
  onClick?: () => void
  disabled?: boolean
  accent?: boolean
  spinner?: boolean
  badge?: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full flex items-center gap-3 px-4 py-3 rounded-2xl transition-all disabled:opacity-50 disabled:cursor-not-allowed text-left"
      style={{
        background: accent
          ? 'color-mix(in srgb, var(--color-primary) 10%, var(--color-bg-elevated))'
          : 'var(--color-bg-subtle)',
        border: accent
          ? '1px solid color-mix(in srgb, var(--color-primary) 35%, var(--color-border))'
          : '1px solid var(--color-border)',
      }}
      onMouseEnter={e => {
        if (disabled) return
        e.currentTarget.style.background = accent
          ? 'color-mix(in srgb, var(--color-primary) 16%, var(--color-bg-elevated))'
          : 'var(--color-bg-muted)'
      }}
      onMouseLeave={e => {
        if (disabled) return
        e.currentTarget.style.background = accent
          ? 'color-mix(in srgb, var(--color-primary) 10%, var(--color-bg-elevated))'
          : 'var(--color-bg-subtle)'
      }}
    >
      <span
        className="shrink-0 w-10 h-10 rounded-xl flex items-center justify-center text-[20px]"
        style={{ background: accent ? 'var(--color-primary)22' : 'var(--color-bg-elevated)' }}
      >
        {emoji}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[14px] font-semibold" style={{ color: 'var(--color-text)' }}>{title}</span>
          {badge && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded-full"
              style={{ background: 'var(--color-bg-muted)', color: 'var(--color-text-muted)' }}
            >
              {badge}
            </span>
          )}
        </div>
        <div className="text-[12px] truncate" style={{ color: 'var(--color-text-muted)' }}>{desc}</div>
      </div>
      {spinner ? (
        <Loader2 size={16} className="animate-spin shrink-0" style={{ color: 'var(--color-primary)' }} />
      ) : onClick ? (
        <span className="shrink-0 text-[16px]" style={{ color: accent ? 'var(--color-primary)' : 'var(--color-text-muted)' }}>→</span>
      ) : null}
    </button>
  )
}
