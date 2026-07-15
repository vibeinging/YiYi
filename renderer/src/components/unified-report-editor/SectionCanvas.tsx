import { useState } from 'react'
import SectionCard from './SectionCard'
import styles from './SectionCanvas.module.scss'

interface SectionCanvasProps {
  sections: any[]
  selectedKey?: string
  // defineEmits(['select', 'duplicate', 'remove', 'reorder', 'append'])
  onSelect?: (key: string) => void
  onDuplicate?: (key: string) => void
  onRemove?: (key: string) => void
  onReorder?: (payload: { oldIndex: number; newIndex: number }) => void
  onAppend?: (payload: { type: string; index: number }) => void
}

export default function SectionCanvas({
  sections,
  selectedKey = '',
  onSelect,
  onDuplicate,
  onRemove,
  onReorder,
  onAppend
}: SectionCanvasProps) {
  const [dragOverIndex, setDragOverIndex] = useState(-1)

  const onDragStart = (index: number, event: React.DragEvent) => {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('application/x-report-section-index', String(index))
  }

  const onDrop = (toIndex: number, event: React.DragEvent) => {
    setDragOverIndex(-1)
    const newType = event.dataTransfer.getData('application/x-report-section-type')
    if (newType) {
      onAppend?.({ type: newType, index: toIndex })
      return
    }

    const fromIndex = event.dataTransfer.getData('application/x-report-section-index')
    if (fromIndex === '') return
    onReorder?.({ oldIndex: Number(fromIndex), newIndex: toIndex })
  }

  const onCanvasDrop = (event: React.DragEvent) => {
    const newType = event.dataTransfer.getData('application/x-report-section-type')
    if (newType) {
      onAppend?.({ type: newType, index: sections.length })
    }
    setDragOverIndex(-1)
  }

  return (
    <div
      className={styles['section-canvas']}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.stopPropagation()
        onCanvasDrop(e)
      }}
    >
      {sections.length === 0 && (
        <div className={styles['canvas-empty']}>
          从左侧拖入 section，或点击左侧 section 类型添加
        </div>
      )}

      <div className={styles['canvas-list']}>
        {sections.map((section, index) => (
          <div
            key={section.key}
            className={styles['canvas-row']}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.stopPropagation()
              onDrop(index, e)
            }}
          >
            <div
              className={`${styles['drop-indicator']} ${
                dragOverIndex === index ? styles.active : ''
              }`}
            ></div>
            <div
              draggable
              onDragStart={(e) => onDragStart(index, e)}
              onDragEnd={() => setDragOverIndex(-1)}
              onDragEnter={(e) => {
                e.preventDefault()
                setDragOverIndex(index)
              }}
            >
              <SectionCard
                section={section}
                selected={section.key === selectedKey}
                onSelect={() => onSelect?.(section.key)}
                onDuplicate={() => onDuplicate?.(section.key)}
                onRemove={() => onRemove?.(section.key)}
              />
            </div>
          </div>
        ))}
        <div
          className={`${styles['canvas-tail-drop']} ${
            dragOverIndex === sections.length ? styles.active : ''
          }`}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOverIndex(sections.length)
          }}
          onDrop={(e) => {
            e.stopPropagation()
            onDrop(sections.length, e)
          }}
        >
          拖到这里追加到末尾
        </div>
      </div>
    </div>
  )
}
