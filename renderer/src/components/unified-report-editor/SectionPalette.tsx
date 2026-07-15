import type { DragEvent } from 'react'
import ElSvgIcon from '@/components/ElSvgIcon'
import styles from './SectionPalette.module.scss'

export interface SectionPaletteProps {
  // defineEmits(['add']) → 回调 prop
  onAdd?: (type: string) => void
}

// 用 EP 图标名(经 ElSvgIcon 映射到 Tabler);未映射的名走 resolveEpIcon 兜底
const sectionTypes = [
  { type: 'heading', label: '标题', desc: '报告主标题或章节标题', icon: 'Flag' },
  { type: 'hero_summary', label: '摘要', desc: '突出展示报告摘要', icon: 'Memo' },
  { type: 'markdown', label: 'Markdown', desc: '段落说明或附注', icon: 'Reading' },
  { type: 'metric_cards', label: '核心指标', desc: '展示核心指标集合', icon: 'Opportunity' },
  { type: 'data_table', label: '数据表格', desc: '展示列和行数据', icon: 'Grid' },
  { type: 'chart', label: '图表', desc: '支持 bar / line / pie', icon: 'Histogram' },
  { type: 'insight_list', label: '洞察列表', desc: '展示核心洞察条目', icon: 'List' },
  { type: 'recommendations', label: '建议列表', desc: '展示建议条目', icon: 'MagicStick' },
  { type: 'divider', label: '分隔线', desc: '用于分段', icon: 'Minus' },
  { type: 'html', label: '自定义 HTML', desc: '兜底自定义内容', icon: 'Document' }
]

export default function SectionPalette({ onAdd }: SectionPaletteProps) {
  const onDragStart = (type: string, event: DragEvent<HTMLDivElement>) => {
    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData('application/x-report-section-type', type)
  }

  return (
    <div className={styles.sectionPalette}>
      <div className={styles.paletteTitle}>Section 类型</div>
      {sectionTypes.map((item) => (
        <div
          key={item.type}
          className={styles.paletteItem}
          draggable
          onClick={() => onAdd?.(item.type)}
          onDragStart={(event) => onDragStart(item.type, event)}
        >
          <ElSvgIcon name={item.icon} />
          <div className={styles.paletteCopy}>
            <div className={styles.label}>{item.label}</div>
            <div className={styles.desc}>{item.desc}</div>
          </div>
        </div>
      ))}
    </div>
  )
}
