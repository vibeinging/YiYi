// 聊天框斜杠命令面板:输入以 / 开头时弹出。命令是「操作」(执行),不是插入文本。
import { IconArchive, type Icon as TablerIcon } from '@tabler/icons-react'
import styles from './yiw.module.scss'

export interface SlashCommand {
  name: string
  label: string
  desc: string
  icon: TablerIcon
  requiresSession?: boolean // 需已有对话内容才有意义(空态/新对话不展示)
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'compact', label: '/compact', desc: '压缩当前对话上下文(模型记忆,界面不变)', icon: IconArchive, requiresSession: true }
]

export interface SlashCtx {
  hasSession?: boolean
}

export function filterSlash(query: string, ctx: SlashCtx = {}): SlashCommand[] {
  const kw = query.trim().toLowerCase()
  return SLASH_COMMANDS.filter((c) => {
    if (c.requiresSession && !ctx.hasSession) return false
    if (!kw) return true
    return c.name.toLowerCase().includes(kw) || c.label.toLowerCase().includes(kw)
  })
}

interface Props {
  query: string
  hasSession?: boolean
  onRun: (name: string) => void
}

export default function SlashMenu({ query, hasSession, onRun }: Props) {
  const items = filterSlash(query, { hasSession })
  if (!items.length) return null
  return (
    <div className={styles.mentionPanel}>
      <div className={styles.mentionHd}>命令</div>
      <div className={styles.wsPickList}>
        {items.map((c) => {
          const Icon = c.icon
          return (
            <button key={c.name} type="button" className={styles.slashItem} onClick={() => onRun(c.name)}>
              <Icon size={15} stroke={1.6} className={styles.wsPickItemIcon} />
              <span className={styles.slashName}>{c.label}</span>
              <span className={styles.slashDesc}>{c.desc}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
