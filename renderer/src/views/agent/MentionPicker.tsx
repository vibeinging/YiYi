// 输入框上方的引用选择面板:@ 工作区文件 / # 会话 / / 命令。
// 纯展示 + 搜索;命中项由调用方决定如何插入。供「+ 菜单」与输入框内联触发(@ # /)共用。
import { useEffect, useMemo, useRef, useState } from 'react'
import { IconFile, IconMessage, IconSearch } from '@tabler/icons-react'
import { listAgentFiles, type FileNode } from '@/api/yiw'
import styles from './yiw.module.scss'

export type PickMode = 'file' | 'conv'

export interface PickItem {
  value: string // 插入的实际文本(文件相对路径 / 会话标题)
  label: string // 列表展示名
  hint?: string // 右侧次要说明
}

// 文件树 → 扁平文件列表(只取文件)
function flattenFiles(tree: FileNode[]): PickItem[] {
  const out: PickItem[] = []
  const walk = (nodes: FileNode[]) => {
    for (const n of nodes) {
      if (n.type === 'dir') walk(n.children || [])
      else out.push({ value: n.path, label: n.name, hint: n.path })
    }
  }
  walk(tree || [])
  return out
}

interface Props {
  mode: PickMode
  projectId: string
  sessionId?: string | null
  conversations?: { id: string; title: string }[]
  /** 内联触发时由外部受控的查询词(@后面的文本);为 undefined 时显示自带搜索框 */
  query?: string
  onPick: (item: PickItem) => void
  onClose: () => void
}

const TITLE: Record<PickMode, string> = { file: '工作区文件', conv: '会话' }
const PLACEHOLDER: Record<PickMode, string> = { file: '搜索工作区文件', conv: '搜索会话' }

export default function MentionPicker({ mode, projectId, sessionId, conversations = [], query, onPick, onClose }: Props) {
  const [files, setFiles] = useState<PickItem[]>([])
  const [loading, setLoading] = useState(mode === 'file')
  const [localQ, setLocalQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const inline = query !== undefined
  const q = (inline ? query : localQ) || ''

  // 加载工作区文件
  useEffect(() => {
    if (mode !== 'file') return
    let alive = true
    setLoading(true)
    listAgentFiles(projectId, sessionId)
      .then((res: any) => {
        if (alive) setFiles(flattenFiles(res?.data?.tree || res?.data || []))
      })
      .catch(() => alive && setFiles([]))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [mode, projectId, sessionId])

  // 外部点击关闭(内联模式由上层管控,这里只在自带搜索框时挂)
  useEffect(() => {
    if (inline) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [inline, onClose])

  const items = useMemo<PickItem[]>(() => {
    const base: PickItem[] =
      mode === 'file'
        ? files
        : conversations.map((c) => ({ value: c.title || '新对话', label: c.title || '新对话', hint: '会话' }))
    const kw = q.trim().toLowerCase()
    if (!kw) return base
    return base.filter((it) => `${it.label} ${it.hint || ''}`.toLowerCase().includes(kw))
  }, [mode, files, conversations, q])

  const Icon = mode === 'file' ? IconFile : IconMessage

  return (
    <div className={styles.mentionPanel} ref={ref}>
      {!inline && (
        <div className={styles.wsPickSearch}>
          <IconSearch size={14} stroke={1.7} />
          <input
            autoFocus
            className={styles.wsPickInput}
            placeholder={PLACEHOLDER[mode]}
            value={localQ}
            onChange={(e) => setLocalQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && onClose()}
          />
        </div>
      )}
      <div className={styles.mentionHd}>{TITLE[mode]}</div>
      <div className={styles.wsPickList}>
        {loading ? (
          <div className={styles.wsPickEmpty}>加载中…</div>
        ) : items.length === 0 ? (
          <div className={styles.wsPickEmpty}>{mode === 'file' ? '工作区没有文件' : '还没有会话'}</div>
        ) : (
          items.slice(0, 60).map((it, i) => (
            <button
              key={`${it.value}-${i}`}
              type="button"
              className={styles.wsPickItem}
              onClick={() => onPick(it)}
              title={it.hint || it.label}
            >
              <Icon size={15} stroke={1.6} className={styles.wsPickItemIcon} />
              <span className={styles.wsPickItemName}>{it.label}</span>
              {it.hint && it.hint !== it.label && <span className={styles.wsPickItemHint}>{it.hint}</span>}
            </button>
          ))
        )}
      </div>
    </div>
  )
}
