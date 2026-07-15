// 通用右键菜单。门户挂到 .yiw-root(主题作用域内、且不被 .yiw-zoom 缩放),
// position:fixed 按光标 viewport 坐标定位;点外部 / Esc 关闭;近屏幕边自动翻转。
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import styles from './yiw.module.scss'

export interface MenuItem {
  key: string
  icon?: ReactNode
  label: string
  onClick?: () => void
  disabled?: boolean
  danger?: boolean
  dividerBefore?: boolean
}

export default function ContextMenu({
  x,
  y,
  items,
  onClose
}: {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    let left = x
    let top = y
    if (x + r.width > window.innerWidth - 8) left = window.innerWidth - r.width - 8
    if (y + r.height > window.innerHeight - 8) top = Math.max(8, y - r.height)
    setPos({ left: Math.max(8, left), top: Math.max(8, top) })
  }, [x, y])

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDoc, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const host = (typeof document !== 'undefined' && document.querySelector('.yiw-root')) || document.body

  return createPortal(
    <div
      ref={ref}
      className={styles.ctxMenu}
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it) => (
        <div key={it.key}>
          {it.dividerBefore && <div className={styles.ctxDivider} />}
          <button
            type="button"
            className={`${styles.ctxItem} ${it.danger ? styles.ctxItemDanger : ''}`}
            disabled={it.disabled}
            onClick={() => {
              if (it.disabled) return
              it.onClick?.()
              onClose()
            }}
          >
            <span className={styles.ctxIcon}>{it.icon}</span>
            <span className={styles.ctxLabel}>{it.label}</span>
          </button>
        </div>
      ))}
    </div>,
    host
  )
}
