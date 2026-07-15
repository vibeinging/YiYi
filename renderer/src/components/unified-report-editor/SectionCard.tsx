import { useMemo } from 'react'
import { Tooltip } from '@mantine/core'
import ElSvgIcon from '@/components/ElSvgIcon'
import styles from './SectionCard.module.scss'

export interface SectionCardProps {
  section: any
  selected?: boolean
  onSelect?: () => void
  onDuplicate?: () => void
  onRemove?: () => void
}

const TYPE_LABELS: Record<string, string> = {
  heading: '标题',
  hero_summary: '摘要',
  markdown: 'Markdown',
  metric_cards: '核心指标',
  data_table: '数据表格',
  chart: '图表',
  insight_list: '洞察列表',
  recommendations: '建议列表',
  divider: '分隔线',
  html: '自定义 HTML'
}

export default function SectionCard({
  section,
  selected = false,
  onSelect,
  onDuplicate,
  onRemove
}: SectionCardProps) {
  const typeLabel = useMemo(
    () => TYPE_LABELS[section.type] || section.type,
    [section.type]
  )

  const title = useMemo(() => {
    const propsValue = section.props || {}
    return propsValue.title || typeLabel
  }, [section.props, typeLabel])

  return (
    <div
      className={`${styles['section-card']} ${selected ? styles.selected : ''}`}
      onClick={() => onSelect?.()}
    >
      <div className={styles['card-main']}>
        <div className={styles['card-title']}>{title}</div>
        <div className={styles['card-meta']}>{typeLabel} · {section.key}</div>
      </div>
      <div className={styles['card-actions']}>
        <Tooltip label="复制 section" position="top">
          <button
            className={styles['action-btn']}
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onDuplicate?.()
            }}
          >
            <ElSvgIcon name="CopyDocument" />
          </button>
        </Tooltip>
        <Tooltip label="删除 section" position="top">
          <button
            className={`${styles['action-btn']} ${styles.danger}`}
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onRemove?.()
            }}
          >
            <ElSvgIcon name="Close" />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
