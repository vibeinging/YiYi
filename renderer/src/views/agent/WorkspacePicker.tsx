// 新建对话:输入框顶部的工作区选择器。
// 点开 = 搜索 + 工作区列表(纯聊天 / 项目 / 已打开文件夹,当前打勾)+ 打开文件夹。
// 工作区 = pid;切换 = 在该工作区开新对话(由上层 onSelect 处理)。
import { useEffect, useRef, useState } from 'react'
import {
  IconCheck,
  IconChevronDown,
  IconDatabasePlus,
  IconFolder,
  IconFolderPlus,
  IconMessage,
  IconSearch
} from '@tabler/icons-react'
import type { Workspace } from './YiWNav'
import styles from './yiw.module.scss'

interface Props {
  workspaces: Workspace[] // 含 CHAT_WS(纯聊天)+ 项目 + 已打开文件夹
  activeWs: string
  onSelect: (id: string) => void
  onOpenFolder: () => void
  /** 创建一个问数项目(= 带本地工作区文件夹的项目);返回后切到新项目 */
  onCreateProject?: (name: string) => Promise<void> | void
}

export default function WorkspacePicker({ workspaces, activeWs, onSelect, onOpenFolder, onCreateProject }: Props) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  // 「创建问数项目」内联输入态:点开 = 把底部按钮换成命名输入框,回车创建
  const [creating, setCreating] = useState(false)
  const [pname, setPname] = useState('')
  const [saving, setSaving] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const active = workspaces.find((w) => w.id === activeWs)
  const filtered = workspaces.filter((w) => w.name.toLowerCase().includes(q.trim().toLowerCase()))

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  // 关闭面板时复位「创建项目」输入态
  useEffect(() => {
    if (!open) {
      setCreating(false)
      setPname('')
    }
  }, [open])

  const submitCreate = async () => {
    const name = pname.trim()
    if (!name || saving) return
    setSaving(true)
    try {
      await onCreateProject?.(name)
      setPname('')
      setCreating(false)
      setOpen(false)
    } finally {
      setSaving(false)
    }
  }

  const activeIsChat = active?.id === '__chat__'

  return (
    <div className={styles.wsPick} ref={ref}>
      <button type="button" className={styles.wsPickBtn} onClick={() => setOpen((o) => !o)}>
        {activeIsChat ? <IconMessage size={14} stroke={1.7} /> : <IconFolder size={14} stroke={1.7} />}
        <span className={styles.wsPickName}>{active?.name || '选择工作区'}</span>
        <IconChevronDown size={13} className={open ? styles.wsPickCaretOpen : styles.wsPickCaret} />
      </button>

      {open && (
        <div className={styles.wsPickPanel}>
          <div className={styles.wsPickSearch}>
            <IconSearch size={14} stroke={1.7} />
            <input
              autoFocus
              className={styles.wsPickInput}
              placeholder="搜索工作区"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>

          <div className={styles.wsPickList}>
            {filtered.length === 0 ? (
              <div className={styles.wsPickEmpty}>没有匹配的工作区</div>
            ) : (
              filtered.map((w) => {
                const isChat = w.id === '__chat__'
                return (
                  <button
                    key={w.id}
                    type="button"
                    className={`${styles.wsPickItem} ${w.id === activeWs ? styles.wsPickItemActive : ''}`}
                    onClick={() => {
                      onSelect(w.id)
                      setOpen(false)
                    }}
                    title={isChat ? '不使用工作区,纯聊天' : w.name}
                  >
                    {isChat ? (
                      <IconMessage size={15} stroke={1.6} className={styles.wsPickItemIcon} />
                    ) : (
                      <IconFolder size={15} stroke={1.6} className={styles.wsPickItemIcon} />
                    )}
                    <span className={styles.wsPickItemName}>{w.name}</span>
                    {isChat && <span className={styles.wsPickItemHint}>不使用工作区</span>}
                    {w.id === activeWs && <IconCheck size={14} stroke={2} className={styles.wsPickCheck} />}
                  </button>
                )
              })
            )}
          </div>

          <div className={styles.wsPickDivider} />
          <div className={styles.wsPickCreateGroup} role="group" aria-label="创建工作区">
            <div className={styles.wsPickGroupTitle}>创建工作区</div>
            <button
              type="button"
              className={styles.wsPickFoot}
              onClick={() => {
                onOpenFolder()
                setOpen(false)
              }}
            >
              <IconFolderPlus size={15} stroke={1.6} />
              <span>选择文件夹…</span>
            </button>
            {creating ? (
              <div className={styles.wsPickCreate}>
                <IconDatabasePlus size={15} stroke={1.6} />
                <input
                  autoFocus
                  className={styles.wsPickInput}
                  placeholder="问数项目名称,回车创建"
                  value={pname}
                  disabled={saving}
                  onChange={(e) => setPname(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      submitCreate()
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      setCreating(false)
                      setPname('')
                    }
                  }}
                />
              </div>
            ) : (
              <button type="button" className={styles.wsPickFoot} onClick={() => setCreating(true)}>
                <IconDatabasePlus size={15} stroke={1.6} />
                <span>创建问数项目…</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
