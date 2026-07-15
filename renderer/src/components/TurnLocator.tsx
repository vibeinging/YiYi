import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import styles from './TurnLocator.module.scss'

export type TurnLocatorVariant = 'overlay' | 'inline'

export interface TurnLocatorMarker {
  id: string
  title: string
  excerpt: string
  meta?: string
}

export function turnLocatorTop(index: number, total: number) {
  if (total <= 1) return 50
  const halfSpan = Math.min(38, Math.max(20, (total - 1) * 3.2))
  const start = 50 - halfSpan
  const end = 50 + halfSpan
  return start + ((end - start) * index) / (total - 1)
}

export function sameTurnLocatorMarkers(a: TurnLocatorMarker[], b: TurnLocatorMarker[]) {
  if (a.length !== b.length) return false
  return a.every((marker, index) => {
    const next = b[index]
    return marker.id === next.id && marker.title === next.title && marker.excerpt === next.excerpt && marker.meta === next.meta
  })
}

function cx(...items: Array<string | false | null | undefined>) {
  return items.filter(Boolean).join(' ')
}

export default function TurnLocator({
  markers,
  activeId,
  ariaLabel,
  variant = 'overlay',
  showPreview = false,
  onSelect
}: {
  markers: TurnLocatorMarker[]
  activeId?: string
  ariaLabel: string
  variant?: TurnLocatorVariant
  showPreview?: boolean
  onSelect: (id: string) => void
}) {
  const hoverClearTimerRef = useRef<number | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const hoverIndex = hoverId ? markers.findIndex((marker) => marker.id === hoverId) : -1
  const hoverMarker = hoverIndex >= 0 ? markers[hoverIndex] : null
  const hoverTop = hoverIndex >= 0 ? turnLocatorTop(hoverIndex, markers.length) : 50
  const rootClassName = cx(styles.locator, variant === 'inline' ? styles.inline : styles.overlay)
  const railHeight = Math.max(72, Math.min(280, markers.length * 10 + 40))
  const rootStyle = { '--turn-locator-height': `${railHeight}px` } as CSSProperties

  const markerPositions = useMemo(
    () => markers.map((marker, index) => ({ marker, top: turnLocatorTop(index, markers.length) })),
    [markers]
  )

  const showHover = useCallback((id: string) => {
    if (hoverClearTimerRef.current) window.clearTimeout(hoverClearTimerRef.current)
    hoverClearTimerRef.current = null
    setHoverId(id)
  }, [])

  const hideHover = useCallback(() => {
    if (hoverClearTimerRef.current) window.clearTimeout(hoverClearTimerRef.current)
    hoverClearTimerRef.current = window.setTimeout(() => setHoverId(null), 180)
  }, [])

  const updateHoverFromPointer = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect()
      if (!markers.length || rect.height <= 0) return
      const y = event.clientY - rect.top
      let closest = markers[0]
      let closestDistance = Number.POSITIVE_INFINITY
      for (let index = 0; index < markers.length; index += 1) {
        const markerY = (turnLocatorTop(index, markers.length) / 100) * rect.height
        const distance = Math.abs(markerY - y)
        if (distance < closestDistance) {
          closest = markers[index]
          closestDistance = distance
        }
      }
      showHover(closest.id)
    },
    [markers, showHover]
  )

  useEffect(
    () => () => {
      if (hoverClearTimerRef.current) window.clearTimeout(hoverClearTimerRef.current)
    },
    []
  )

  if (!markers.length) return null

  return (
    <nav className={rootClassName} style={rootStyle} aria-label={ariaLabel}>
      <div
        className={styles.rail}
        data-hovering={hoverMarker ? 'true' : undefined}
        onMouseEnter={updateHoverFromPointer}
        onMouseMove={updateHoverFromPointer}
        onMouseLeave={hideHover}
      >
        {markerPositions.map(({ marker, top }, index) => {
          const hoverDistance = hoverIndex >= 0 ? Math.abs(index - hoverIndex) : -1
          return (
            <button
              key={marker.id}
              type="button"
              className={styles.tick}
              data-active={marker.id === activeId ? 'true' : undefined}
              data-hover-distance={hoverDistance >= 0 && hoverDistance <= 3 ? String(hoverDistance) : undefined}
              style={{ top: `${top}%` }}
              onFocus={() => showHover(marker.id)}
              onBlur={hideHover}
              onClick={() => onSelect(marker.id)}
              aria-current={marker.id === activeId ? 'location' : undefined}
              aria-label={`${marker.title}: ${marker.excerpt}`}
            />
          )
        })}
        {showPreview && hoverMarker && (
          <button
            type="button"
            className={styles.preview}
            style={{ top: `${hoverTop}%` }}
            onMouseEnter={() => showHover(hoverMarker.id)}
            onMouseLeave={hideHover}
            onFocus={() => showHover(hoverMarker.id)}
            onBlur={hideHover}
            onClick={() => onSelect(hoverMarker.id)}
          >
            <span className={styles.previewTitle}>{hoverMarker.title}</span>
            <span className={styles.previewText}>{hoverMarker.excerpt}</span>
            {hoverMarker.meta && <span className={styles.previewMeta}>{hoverMarker.meta}</span>}
          </button>
        )}
      </div>
    </nav>
  )
}
