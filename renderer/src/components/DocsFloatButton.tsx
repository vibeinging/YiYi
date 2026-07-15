import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router-dom'
import ElSvgIcon from '@/components/ElSvgIcon'
import { settings } from '@/settings'
import styles from './DocsFloatButton.module.scss'

const STORAGE_KEY = 'docs_button_position'

interface Position {
  x: number
  y: number
}

export default function DocsFloatButton() {
  const { t } = useTranslation()
  const location = useLocation()

  const visible = useMemo(() => settings.enableDocs, [])
  const isDocsPage = useMemo(() => location.pathname.startsWith('/docs'), [location.pathname])

  // 按钮位置
  const [position, setPosition] = useState<Position>({ x: 0, y: 0 })

  // 拖动状态(用 ref 保存，避免事件回调闭包拿到旧值)
  const isDraggingRef = useRef(false)
  const dragOffsetRef = useRef<Position>({ x: 0, y: 0 })
  const hasMovedRef = useRef(false)
  const positionRef = useRef<Position>({ x: 0, y: 0 })
  positionRef.current = position

  // 从 localStorage 读取位置
  const loadPosition = () => {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      try {
        const savedPos = JSON.parse(saved)
        // 验证位置是否在当前屏幕范围内
        if (
          savedPos.x >= 0 &&
          savedPos.x <= window.innerWidth - 60 &&
          savedPos.y >= 0 &&
          savedPos.y <= window.innerHeight - 60
        ) {
          setPosition(savedPos)
          return
        }
      } catch {
        // 解析失败，使用默认位置
      }
    }
    // 默认位置：右下角
    setPosition({
      x: window.innerWidth - 90,
      y: window.innerHeight - 90
    })
  }

  // 保存位置到 localStorage
  const savePosition = () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(positionRef.current))
  }

  // 初始化位置（窗口大小改变时重新计算，确保不超出屏幕）
  const initPosition = () => {
    const current = positionRef.current
    // 确保位置在屏幕内
    const maxX = window.innerWidth - 60
    const maxY = window.innerHeight - 60
    setPosition({
      x: Math.min(current.x, maxX),
      y: Math.min(current.y, maxY)
    })
  }

  // 拖动中
  const onDrag = (e: MouseEvent | TouchEvent) => {
    if (!isDraggingRef.current) return

    hasMovedRef.current = true

    const clientX = e.type === 'touchmove' ? (e as TouchEvent).touches[0].clientX : (e as MouseEvent).clientX
    const clientY = e.type === 'touchmove' ? (e as TouchEvent).touches[0].clientY : (e as MouseEvent).clientY

    let newX = clientX - dragOffsetRef.current.x
    let newY = clientY - dragOffsetRef.current.y

    // 限制在屏幕范围内
    const buttonSize = 50
    const padding = 10

    newX = Math.max(padding, Math.min(newX, window.innerWidth - buttonSize - padding))
    newY = Math.max(padding, Math.min(newY, window.innerHeight - buttonSize - padding))

    setPosition({ x: newX, y: newY })
  }

  // 停止拖动
  const stopDrag = () => {
    isDraggingRef.current = false
    document.removeEventListener('mousemove', onDrag)
    document.removeEventListener('mouseup', stopDrag)
    document.removeEventListener('touchmove', onDrag)
    document.removeEventListener('touchend', stopDrag)

    // 保存位置
    if (hasMovedRef.current) {
      savePosition()
    }
  }

  // 开始拖动
  const startDrag = (e: React.MouseEvent | React.TouchEvent) => {
    // 如果是鼠标右键，不处理
    if ((e as React.MouseEvent).button === 2) return

    e.preventDefault()
    isDraggingRef.current = true
    hasMovedRef.current = false

    const clientX =
      e.type === 'touchstart' ? (e as React.TouchEvent).touches[0].clientX : (e as React.MouseEvent).clientX
    const clientY =
      e.type === 'touchstart' ? (e as React.TouchEvent).touches[0].clientY : (e as React.MouseEvent).clientY

    dragOffsetRef.current = {
      x: clientX - positionRef.current.x,
      y: clientY - positionRef.current.y
    }

    document.addEventListener('mousemove', onDrag)
    document.addEventListener('mouseup', stopDrag)
    document.addEventListener('touchmove', onDrag, { passive: false })
    document.addEventListener('touchend', stopDrag)
  }

  // 点击跳转
  const goToDocs = () => {
    // 如果拖动过，不触发点击
    if (hasMovedRef.current) return

    const docsUrl = window.location.origin + '/docs'
    window.open(docsUrl, '_blank')
  }

  useEffect(() => {
    loadPosition()
    window.addEventListener('resize', initPosition)
    return () => {
      window.removeEventListener('resize', initPosition)
      // 卸载时清理可能残留的拖动监听
      document.removeEventListener('mousemove', onDrag)
      document.removeEventListener('mouseup', stopDrag)
      document.removeEventListener('touchmove', onDrag)
      document.removeEventListener('touchend', stopDrag)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!visible || isDocsPage) return null

  return (
    <div
      className={styles.docsFloatButton}
      style={{ left: position.x + 'px', top: position.y + 'px' }}
      onClick={goToDocs}
      onMouseDown={startDrag}
      onTouchStart={startDrag}
    >
      <span className={styles.buttonIcon}>
        <ElSvgIcon name="Reading" size={15} />
      </span>
      <span className={styles.buttonLabel}>{t('common.docs')}</span>
    </div>
  )
}
