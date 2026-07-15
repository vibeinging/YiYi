// 全局搜索面板(⌘K):跨工作区/会话的客户端标题过滤。
// 数据源 = YiWShell 内存中已加载的 allWorkspaces + convByWs,无需后端改动。
// 门户挂到 .yiw-root(主题作用域内、且不被 .yiw-zoom 缩放);Esc/点外部关闭。
// 注:仅匹配标题,不搜对话正文 —— 后端暂无全局全文搜索端点。
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconFolder, IconMessage, IconSearch } from '@tabler/icons-react'
import styles from './yiw.module.scss'

export interface SearchWorkspace {
  id: string
  name: string
}

export interface SearchPaletteProps {
  workspaces?: SearchWorkspace[]
  convByWs?: Record<string, { id: string; title: string }[]>
  onClose?: () => void
  onSelect?: (wsId: string, convId?: string) => void
}

interface FlatItem {
  key: string
  kind: 'workspace' | 'conv'
  title: string
  wsId: string
  convId?: string
  wsName: string
}

const wsKindLabel = (id: string) => (id === '__chat__' ? '聊天' : id.startsWith('folder:') ? '文件夹' : '项目')

export default function SearchPalette({
  workspaces = [],
  convByWs = {},
  onClose,
  onSelect
}: SearchPaletteProps) {
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // 扁平化:工作区 + 其下所有对话,各自带所属工作区名(供副标题展示)
  const flat = useMemo<FlatItem[]>(() => {
    const out: FlatItem[] = []
    for (const ws of workspaces) {
      out.push({ key: `ws:${ws.id}`, kind: 'workspace', title: ws.name, wsId: ws.id, wsName: ws.name })
      for (const c of convByWs[ws.id] || []) {
        out.push({
          key: `conv:${ws.id}:${c.id}`,
          kind: 'conv',
          title: c.title || '新对话',
          wsId: ws.id,
          convId: c.id,
          wsName: ws.name
        })
      }
    }
    return out
  }, [workspaces, convByWs])

  const results = useMemo<FlatItem[]>(() => {
    const kw = q.trim().toLowerCase()
    if (!kw) return flat.slice(0, 50) // 空查询:给前 50 项(避免超大列表卡顿)
    return flat.filter((it) => it.title.toLowerCase().includes(kw) || it.wsName.toLowerCase().includes(kw)).slice(0, 80)
  }, [flat, q])

  useEffect(() => {
    setActive(0)
  }, [q])

  // 自动聚焦输入框
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // 滚动选中项到可视区
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (it?: FlatItem) => {
    if (!it) return
    onSelect?.(it.wsId, it.convId)
    onClose?.()
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose?.()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(results.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(results[active])
    }
  }

  const host = (typeof document !== 'undefined' && document.querySelector('.yiw-root')) || document.body

  return createPortal(
    <div className={styles.searchMask} onMouseDown={onClose}>
      <div
        className={styles.searchPalette}
        role="dialog"
        aria-modal="true"
        aria-label="搜索工作区与会话"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className={styles.searchHeader}>
          <IconSearch size={16} stroke={1.8} className={styles.searchIcon} />
          <input
            ref={inputRef}
            className={styles.searchInput}
            placeholder="搜索工作区或对话…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
          />
          <kbd className={styles.searchEsc}>Esc</kbd>
        </div>
        <div className={styles.searchList} ref={listRef}>
          {results.length === 0 ? (
            <div className={styles.searchEmpty}>没有匹配的工作区或对话</div>
          ) : (
            results.map((it, idx) => (
              <button
                key={it.key}
                type="button"
                data-idx={idx}
                className={`${styles.searchItem} ${idx === active ? styles.searchItemActive : ''}`}
                onMouseEnter={() => setActive(idx)}
                onClick={() => choose(it)}
              >
                {it.kind === 'workspace' ? <IconFolder size={15} stroke={1.7} /> : <IconMessage size={14} stroke={1.7} />}
                <span className={styles.searchItemTitle}>{it.title}</span>
                <span className={styles.searchItemMeta}>
                  {it.kind === 'workspace' ? wsKindLabel(it.wsId) : it.wsName}
                </span>
              </button>
            ))
          )}
        </div>
        <div className={styles.searchFoot}>
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> 选择
          </span>
          <span>
            <kbd>↵</kbd> 打开
          </span>
        </div>
      </div>
    </div>,
    host
  )
}
