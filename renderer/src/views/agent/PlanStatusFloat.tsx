import { useEffect, useRef, useState } from 'react'
import { IconCircle, IconCircleCheckFilled, IconLoader2, IconMaximize, IconMinus } from '@tabler/icons-react'
import type { PlanStep } from '@/layout/workstation/Workstation'
import styles from './yiw.module.scss'

type PlanFloatSide = 'left' | 'right'
type PlanFloatAnchor = { side: PlanFloatSide; offsetX: number; y: number }
type PlanFloatPosition = PlanFloatAnchor & { x: number }

const PLAN_FLOAT_STORAGE_KEY = 'yiw-plan-float-position'
const PLAN_FLOAT_EDGE_GAP = 16
const PLAN_FLOAT_MIN_GAP = 8

function StepIcon({ state }: { state: PlanStep['state'] }) {
  if (state === 'done') return <IconCircleCheckFilled size={15} className={styles.planFloatDoneIcon} />
  if (state === 'running') return <IconLoader2 size={15} className={styles.planFloatRunningIcon} />
  return <IconCircle size={14} className={styles.planFloatTodoIcon} />
}

function loadAnchor(): PlanFloatAnchor | null {
  try {
    const raw = JSON.parse(localStorage.getItem(PLAN_FLOAT_STORAGE_KEY) || 'null')
    if (
      (raw?.side === 'left' || raw?.side === 'right') &&
      Number.isFinite(raw?.offsetX) &&
      Number.isFinite(raw?.y)
    ) {
      return { side: raw.side, offsetX: Number(raw.offsetX), y: Number(raw.y) }
    }
    // 旧版本保存的是绝对 x/y。布局宽度变化时绝对 x 会漂移,这里迁移为默认右侧吸附。
    if (Number.isFinite(raw?.y)) return { side: 'right', offsetX: PLAN_FLOAT_EDGE_GAP, y: Number(raw.y) }
  } catch {
    /* ignore */
  }
  return null
}

function saveAnchor(anchor: PlanFloatAnchor) {
  localStorage.setItem(
    PLAN_FLOAT_STORAGE_KEY,
    JSON.stringify({ side: anchor.side, offsetX: Math.round(anchor.offsetX), y: Math.round(anchor.y) })
  )
}

function measureFloat(node: HTMLElement, parent: HTMLElement) {
  const parentRect = parent.getBoundingClientRect()
  const width = node.offsetWidth || node.getBoundingClientRect().width
  const height = node.offsetHeight || node.getBoundingClientRect().height
  return { parentRect, width, height }
}

function clampAnchorToParent(node: HTMLElement, parent: HTMLElement, anchor: PlanFloatAnchor): PlanFloatPosition {
  const { parentRect, width, height } = measureFloat(node, parent)
  const maxX = Math.max(PLAN_FLOAT_MIN_GAP, parentRect.width - width - PLAN_FLOAT_MIN_GAP)
  const offsetX = Math.max(PLAN_FLOAT_MIN_GAP, Math.min(maxX, anchor.offsetX))
  const y = Math.max(PLAN_FLOAT_MIN_GAP, Math.min(Math.max(PLAN_FLOAT_MIN_GAP, parentRect.height - height - PLAN_FLOAT_MIN_GAP), anchor.y))
  const x = anchor.side === 'right' ? Math.max(PLAN_FLOAT_MIN_GAP, parentRect.width - width - offsetX) : offsetX
  return {
    side: anchor.side,
    offsetX,
    x,
    y
  }
}

function anchorFromPosition(node: HTMLElement, parent: HTMLElement, pos: { x: number; y: number }): PlanFloatPosition {
  const { parentRect, width } = measureFloat(node, parent)
  const maxX = Math.max(PLAN_FLOAT_MIN_GAP, parentRect.width - width - PLAN_FLOAT_MIN_GAP)
  const x = Math.max(PLAN_FLOAT_MIN_GAP, Math.min(maxX, pos.x))
  const leftOffset = x
  const rightOffset = Math.max(PLAN_FLOAT_MIN_GAP, parentRect.width - width - x)
  const side: PlanFloatSide = leftOffset <= rightOffset ? 'left' : 'right'
  return clampAnchorToParent(node, parent, {
    side,
    offsetX: side === 'left' ? leftOffset : rightOffset,
    y: pos.y
  })
}

function samePosition(a: PlanFloatPosition | null, b: PlanFloatPosition) {
  return (
    a?.side === b.side &&
    Math.abs(a.offsetX - b.offsetX) < 0.5 &&
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5
  )
}

export default function PlanStatusFloat({ plan, running }: { plan: PlanStep[]; running?: boolean }) {
  const ref = useRef<HTMLElement>(null)
  const storedAnchorRef = useRef<PlanFloatAnchor | null>(loadAnchor())
  const [position, setPosition] = useState<PlanFloatPosition | null>(null)
  const [minimized, setMinimized] = useState(false)

  useEffect(() => {
    const node = ref.current
    const parent = node?.parentElement
    if (!node || !parent) return undefined

    const syncAnchoredPosition = () => {
      setPosition((prev) => {
        const currentAnchor = prev || storedAnchorRef.current || { side: 'right', offsetX: PLAN_FLOAT_EDGE_GAP, y: 14 }
        const next = clampAnchorToParent(node, parent, currentAnchor)
        if (samePosition(prev, next)) return prev
        storedAnchorRef.current = { side: next.side, offsetX: next.offsetX, y: next.y }
        saveAnchor(storedAnchorRef.current)
        return next
      })
    }

    const frame = requestAnimationFrame(syncAnchoredPosition)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(syncAnchoredPosition)
    observer?.observe(parent)
    observer?.observe(node)
    window.addEventListener('resize', syncAnchoredPosition)
    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', syncAnchoredPosition)
    }
  }, [minimized, plan.length])

  if (!plan.length) return null

  const done = plan.filter((step) => step.state === 'done').length
  const current = plan.find((step) => step.state === 'running') || plan.find((step) => step.state !== 'done') || plan[plan.length - 1]

  const startDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    const node = ref.current
    const parent = node?.parentElement
    if (!node || !parent) return
    event.preventDefault()

    const nodeRect = node.getBoundingClientRect()
    const parentRect = parent.getBoundingClientRect()
    const offsetX = event.clientX - nodeRect.left
    const offsetY = event.clientY - nodeRect.top
    let latest = anchorFromPosition(node, parent, { x: nodeRect.left - parentRect.left, y: nodeRect.top - parentRect.top })

    document.body.dataset.yiwDraggingPlan = 'true'

    const onMove = (moveEvent: PointerEvent) => {
      const raw = {
        x: moveEvent.clientX - parentRect.left - offsetX,
        y: moveEvent.clientY - parentRect.top - offsetY
      }
      latest = anchorFromPosition(node, parent, raw)
      setPosition(latest)
    }

    const onUp = () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.body.removeAttribute('data-yiw-dragging-plan')
      storedAnchorRef.current = { side: latest.side, offsetX: latest.offsetX, y: latest.y }
      saveAnchor(storedAnchorRef.current)
    }

    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }

  return (
    <aside
      ref={ref}
      className={`${styles.planFloat} ${minimized ? styles.planFloatMinimized : ''}`}
      aria-label="当前计划执行状态"
      data-running={running ? 'true' : undefined}
      data-minimized={minimized ? 'true' : undefined}
      data-anchor={position?.side}
      style={position ? { left: position.x, top: position.y, right: 'auto' } : undefined}
    >
      <div className={styles.planFloatHeader} onPointerDown={startDrag}>
        <div className={styles.planFloatHeaderText}>
          <div className={styles.planFloatTitle}>
            计划 · {done} / {plan.length} 完成
          </div>
          <div className={styles.planFloatCurrent} title={current?.title}>
            {current?.state === 'done' ? '已完成' : current?.title || '等待下一步'}
          </div>
        </div>
        <div className={styles.planFloatActions}>
          <span className={styles.planFloatPulse} aria-hidden />
          <button
            type="button"
            className={styles.planFloatAction}
            aria-label={minimized ? '展开计划浮层' : '最小化计划浮层'}
            title={minimized ? '展开' : '最小化'}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => setMinimized((value) => !value)}
          >
            {minimized ? <IconMaximize size={13} stroke={1.8} /> : <IconMinus size={13} stroke={1.8} />}
          </button>
        </div>
      </div>
      {!minimized && (
        <div className={styles.planFloatSteps}>
          {plan.map((step, index) => (
            <div key={`${step.title}-${index}`} className={styles.planFloatStep} data-state={step.state}>
              <StepIcon state={step.state} />
              <div className={styles.planFloatStepBody}>
                <div className={styles.planFloatStepTitle} title={step.title}>
                  {step.title || `步骤 ${index + 1}`}
                </div>
                {step.detail && (
                  <div className={styles.planFloatStepDetail} title={step.detail}>
                    {step.detail}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </aside>
  )
}
