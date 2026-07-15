// 输入框左下角「+」操作:添加文件/文件夹(从电脑选)/ 插入 @ 提及 / 插入 # 会话。
// 添加 → 单一原生对话框(文件+文件夹随便选);@ # → 引用面板(MentionPicker)。
import { useEffect, useRef, useState } from 'react'
import { IconAt, IconHash, IconPaperclip, IconPlus } from '@tabler/icons-react'
import { basename, folderPathOf, isDesktop, pickFilesOrFolders, workspacePath } from './folders'
import MentionPicker, { type PickItem, type PickMode } from './MentionPicker'
import styles from './yiw.module.scss'

export interface Attachment {
  path: string
  name: string
  isDir?: boolean
}

interface Props {
  projectId: string
  sessionId?: string | null
  conversations?: { id: string; title: string }[]
  disabled?: boolean
  onAddAttachments: (files: Attachment[]) => void
  /** 在光标处插入文本(@ 提及 / # 会话 命中时调用) */
  onInsert: (text: string) => void
}

type Action = 'attach' | PickMode
const MENU: { action: Action; icon: typeof IconPlus; label: string }[] = [
  { action: 'attach', icon: IconPaperclip, label: '添加文件 / 文件夹' },
  { action: 'file', icon: IconAt, label: '插入 @ 提及' },
  { action: 'conv', icon: IconHash, label: '插入 # 会话' }
]

export default function ComposerActions({
  projectId,
  sessionId,
  conversations = [],
  disabled,
  onAddAttachments,
  onInsert
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [picker, setPicker] = useState<PickMode | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const closeAll = () => {
    setMenuOpen(false)
    setPicker(null)
  }

  useEffect(() => {
    if (!menuOpen && !picker) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeAll()
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [menuOpen, picker])

  // 添加文件 / 文件夹:单一原生对话框,文件与文件夹都能选;默认展开当前工作区,可选电脑内任意位置
  const addAttachment = async () => {
    closeAll()
    if (!isDesktop()) {
      // 浏览器内无原生对话框:回退到 @ 工作区文件选择
      setPicker('file')
      return
    }
    const dir = folderPathOf(projectId) || (await workspacePath(projectId))
    const picked = await pickFilesOrFolders(dir)
    if (picked.length)
      onAddAttachments(picked.map((p) => ({ path: p.path, name: basename(p.path), isDir: p.isDir })))
  }

  const onMenu = (action: Action) => {
    setMenuOpen(false)
    if (action === 'attach') addAttachment()
    else setPicker(action)
  }

  const handlePick = (it: PickItem) => {
    // 文件 → @路径;会话 → #标题
    onInsert(picker === 'file' ? `@${it.value} ` : `#${it.value} `)
    setPicker(null)
  }

  return (
    <div className={styles.caWrap} ref={ref}>
      <button
        type="button"
        className={styles.caPlus}
        disabled={disabled}
        onClick={() => {
          setPicker(null)
          setMenuOpen((o) => !o)
        }}
        title="添加文件 / 引用"
      >
        <IconPlus size={18} stroke={2} className={menuOpen ? styles.caPlusOpen : undefined} />
      </button>

      {menuOpen && (
        <div className={styles.caMenu}>
          {MENU.map((m) => {
            const Icon = m.icon
            return (
              <button key={m.action} type="button" className={styles.caMenuItem} onClick={() => onMenu(m.action)}>
                <Icon size={16} stroke={1.7} className={styles.caMenuIcon} />
                <span>{m.label}</span>
              </button>
            )
          })}
        </div>
      )}

      {picker && (
        <MentionPicker
          mode={picker}
          projectId={projectId}
          sessionId={sessionId}
          conversations={conversations}
          onPick={handlePick}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  )
}
