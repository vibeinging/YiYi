import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import styles from './Tour.module.scss'

export type TourPlacement =
  | 'top' | 'right' | 'bottom' | 'left'
  | 'right-start' | 'right-end' | 'left-start' | 'left-end'
  | 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'

export interface TourStep {
  key: string
  /** 解析目标元素;返回 null 时按居中处理 */
  target?: () => Element | null
  /** 居中模式:整屏暗一层 + 气泡居中(欢迎步) */
  centered?: boolean
  title: string
  description?: string
  placement?: TourPlacement
  /** 自定义气泡正文(如 TourStepGuide);给了就不渲染 description */
  content?: ReactNode
}

interface TourProps {
  opened: boolean
  current: number
  steps: TourStep[]
  onChange: (current: number) => void
  onClose: () => void
  onFinish: () => void
}

interface Hole {
  x: number
  y: number
  w: number
  h: number
}

const PAD = 6
const GAP = 14

function computeBubblePos(hole: Hole | null, placement: TourPlacement | undefined, bw: number, bh: number) {
  const vw = window.innerWidth
  const vh = window.innerHeight
  if (!hole) return { x: Math.round((vw - bw) / 2), y: Math.round((vh - bh) / 2) }
  const p = placement || 'right'
  let x: number
  let y: number
  if (p.startsWith('right')) {
    x = hole.x + hole.w + GAP
    y = p.endsWith('start') ? hole.y : p.endsWith('end') ? hole.y + hole.h - bh : hole.y + hole.h / 2 - bh / 2
  } else if (p.startsWith('left')) {
    x = hole.x - bw - GAP
    y = p.endsWith('start') ? hole.y : p.endsWith('end') ? hole.y + hole.h - bh : hole.y + hole.h / 2 - bh / 2
  } else if (p.startsWith('bottom')) {
    x = p.endsWith('end') ? hole.x + hole.w - bw : hole.x
    y = hole.y + hole.h + GAP
  } else {
    // top
    x = p.endsWith('end') ? hole.x + hole.w - bw : hole.x
    y = hole.y - bh - GAP
  }
  // 视口内夹取
  x = Math.max(12, Math.min(x, vw - bw - 12))
  y = Math.max(12, Math.min(y, vh - bh - 12))
  return { x: Math.round(x), y: Math.round(y) }
}

/**
 * 轻量引导(替代 element-plus el-tour)。
 * - 遮罩:目标四周 4 块半透明 + 高亮环(挖洞);居中步整屏暗一层。
 * - 气泡:依 placement 贴目标,自带步数/跳过/上一步/下一步/完成。
 * 步间路由跳转 + 等目标元素由调用方(layout)负责;本组件只渲染当前步。
 */
export default function Tour({ opened, current, steps, onChange, onClose, onFinish }: TourProps) {
  const { t } = useTranslation()
  const step = steps[current]
  const [hole, setHole] = useState<Hole | null>(null)
  const bubbleRef = useRef<HTMLDivElement | null>(null)
  const [bubbleSize, setBubbleSize] = useState({ w: 320, h: 180 })

  // 计算目标矩形(opened/current 变化时;目标可能在路由切换后才出现 → 轮询几次 + 随窗口/滚动更新)
  useEffect(() => {
    if (!opened || !step || step.centered) {
      setHole(null)
      return
    }
    const update = () => {
      const el = step.target?.()
      if (el) {
        const r = el.getBoundingClientRect()
        if (r.width || r.height) {
          setHole({ x: r.x - PAD, y: r.y - PAD, w: r.width + PAD * 2, h: r.height + PAD * 2 })
          return
        }
      }
      setHole(null)
    }
    update()
    let tries = 0
    const id = window.setInterval(() => {
      update()
      if (++tries > 20) window.clearInterval(id)
    }, 150)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.clearInterval(id)
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [opened, current, step])

  // 量气泡真实尺寸以更准地定位
  useLayoutEffect(() => {
    if (bubbleRef.current) {
      const r = bubbleRef.current.getBoundingClientRect()
      if (Math.abs(r.width - bubbleSize.w) > 2 || Math.abs(r.height - bubbleSize.h) > 2) {
        setBubbleSize({ w: r.width, h: r.height })
      }
    }
  })

  if (!opened || !step) return null

  const pos = computeBubblePos(hole, step.placement, bubbleSize.w, bubbleSize.h)
  const isFirst = current === 0
  const isLast = current === steps.length - 1

  return createPortal(
    <div className={styles.tourRoot} role="dialog" aria-modal="true">
      {hole ? (
        <>
          <div className={styles.mask} style={{ left: 0, top: 0, width: '100vw', height: Math.max(0, hole.y) }} />
          <div className={styles.mask} style={{ left: 0, top: hole.y, width: Math.max(0, hole.x), height: hole.h }} />
          <div className={styles.mask} style={{ left: hole.x + hole.w, top: hole.y, right: 0, height: hole.h }} />
          <div className={styles.mask} style={{ left: 0, top: hole.y + hole.h, width: '100vw', bottom: 0 }} />
          <div className={styles.ring} style={{ left: hole.x, top: hole.y, width: hole.w, height: hole.h }} />
        </>
      ) : (
        <div className={styles.maskFull} />
      )}

      <div ref={bubbleRef} className={styles.bubble} style={{ left: pos.x, top: pos.y }}>
        <div className={styles.title}>{step.title}</div>
        <div className={styles.body}>
          {step.content ?? (step.description ? <p className={styles.desc}>{step.description}</p> : null)}
        </div>
        <div className={styles.footer}>
          <div className={styles.indicators}>
            <span className={styles.count}>
              {current + 1} / {steps.length}
            </span>
            <button type="button" className={styles.skip} onClick={onClose}>
              {t('layout.projectAdminOnboarding.skip')}
            </button>
          </div>
          <div className={styles.actions}>
            {!isFirst && (
              <Button variant="default" size="xs" className={styles.prevBtn} onClick={() => onChange(current - 1)}>
                {t('layout.projectAdminOnboarding.prev')}
              </Button>
            )}
            <Button size="xs" className={styles.nextBtn} onClick={() => (isLast ? onFinish() : onChange(current + 1))}>
              {isLast ? t('layout.projectAdminOnboarding.finish') : t('layout.projectAdminOnboarding.next')}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
