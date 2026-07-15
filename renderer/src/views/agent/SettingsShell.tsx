// 设置页通用布局壳:App 设置 与 项目设置(桌面整窗)共用同一套两栏布局。
// 壳只负责「外观骨架」(返回键 + 左导航槽 + 右主面板卡);具体导航项与内容由各页传入。
// 这样返回键位置 / 侧栏宽度 / 内容卡完全一致 —— 复用,而非各自 CSS 模仿。
import { type ReactNode } from 'react'
import { IconArrowLeft, IconChevronDown } from '@tabler/icons-react'
import styles from './settingsShell.module.scss'

export function SettingsShell({
  onBack,
  backLabel = '返回工作区',
  nav,
  mainFixed = false,
  children
}: {
  onBack?: () => void
  backLabel?: string
  nav: ReactNode
  mainFixed?: boolean
  children: ReactNode
}) {
  // 主题由祖先 .yiw-root[data-theme] 决定(--yiw-* token),壳本身不需要再读 scheme。
  return (
    <div className={styles.wrap}>
      <aside className={styles.side}>
        {onBack && (
          <button type="button" className={styles.back} onClick={onBack}>
            <IconArrowLeft size={16} stroke={1.8} />
            {backLabel}
          </button>
        )}
        <nav className={styles.nav}>{nav}</nav>
      </aside>
      <main className={`${styles.main} ${mainFixed ? styles.mainFixed : ''}`}>{children}</main>
    </div>
  )
}

// 单个导航项(按钮)。icon 可选(App 设置带图标,项目设置不带)。
export function SettingsNavItem({
  active = false,
  onClick,
  icon,
  id,
  children
}: {
  active?: boolean
  onClick?: () => void
  icon?: ReactNode
  id?: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      id={id}
      className={`${styles.navItem} ${active ? styles.navItemActive : ''}`}
      onClick={onClick}
    >
      {icon && <span className={styles.navIcon}>{icon}</span>}
      <span>{children}</span>
    </button>
  )
}

// 可折叠分组:标题(可点击折叠)+ 其下导航项。label 省略时只渲染 children(无标题分组)。
export function SettingsNavGroup({
  label,
  collapsed = false,
  onToggle,
  id,
  children
}: {
  label?: string
  collapsed?: boolean
  onToggle?: () => void
  id?: string
  children: ReactNode
}) {
  return (
    <>
      {label && (
        <button type="button" className={styles.groupHeader} onClick={onToggle} {...(id ? { id } : {})}>
          <IconChevronDown
            size={13}
            stroke={2.2}
            className={`${styles.groupChev} ${collapsed ? styles.groupChevCollapsed : ''}`}
          />
          <span className={styles.groupLabel}>{label}</span>
        </button>
      )}
      {!collapsed && children}
    </>
  )
}

export function SettingsNavSep() {
  return <div className={styles.navSep} />
}
