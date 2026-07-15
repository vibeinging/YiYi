import { useMemo, useState } from 'react'
import { Badge, Input, Textarea, TextInput } from '@mantine/core'
import BindingFieldInput from './BindingFieldInput'
import ChartSectionProperty from './properties/ChartSectionProperty'
import DataTableSectionProperty from './properties/DataTableSectionProperty'
import DividerSectionProperty from './properties/DividerSectionProperty'
import HeadingSectionProperty from './properties/HeadingSectionProperty'
import HeroSummarySectionProperty from './properties/HeroSummarySectionProperty'
import HtmlSectionProperty from './properties/HtmlSectionProperty'
import ListSectionProperty from './properties/ListSectionProperty'
import MarkdownSectionProperty from './properties/MarkdownSectionProperty'
import MetricCardsSectionProperty from './properties/MetricCardsSectionProperty'
import styles from './SectionPropertyPanel.module.scss'

interface SectionPropertyPanelProps {
  section?: any
  // defineEmits(['update']) → 回调 prop,携带最新 section 克隆
  onUpdate?: (section: any) => void
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

const BLOCK_TITLE_SECTION_TYPES = new Set([
  'metric_cards',
  'data_table',
  'chart',
  'insight_list',
  'recommendations'
])

export default function SectionPropertyPanel({ section = null, onUpdate }: SectionPropertyPanelProps) {
  const sectionTypeLabel = useMemo(
    () => TYPE_LABELS[section?.type] || section?.type || '',
    [section?.type]
  )
  const showBlockTitleField = useMemo(
    () => BLOCK_TITLE_SECTION_TYPES.has(section?.type),
    [section?.type]
  )

  // watch(() => props.section, ..., { immediate: true, deep: true }) →
  // 监听传入 section 的引用变化,克隆一份本地可变副本供子组件就地修改
  const [localSection, setLocalSection] = useState<any>(null)
  // 用 JSON 串作为依赖,等价于源里的 deep watch:source 内容变化时重建本地克隆
  const sectionSnapshot = section ? JSON.stringify(section) : null
  const [lastSnapshot, setLastSnapshot] = useState<string | null>(null)
  if (sectionSnapshot !== lastSnapshot) {
    setLastSnapshot(sectionSnapshot)
    if (!section) {
      setLocalSection(null)
    } else {
      const clonedSection = JSON.parse(JSON.stringify(section))
      if (!clonedSection.props) clonedSection.props = {}
      if (clonedSection.type === 'chart') {
        if (!clonedSection.props.data) {
          clonedSection.props.data = '{{charts.sales_trend}}'
        }
      }
      if (clonedSection.type === 'markdown') {
        if (!clonedSection.props.content) {
          clonedSection.props.content = '{{appendix.notes}}'
        }
      }
      setLocalSection(clonedSection)
    }
  }

  const emitUpdate = () => {
    if (!localSection) return
    onUpdate?.(JSON.parse(JSON.stringify(localSection)))
  }

  if (!section || !localSection) {
    return <div className={styles['empty-panel']}>选择一个 section 后在这里编辑属性</div>
  }

  return (
    <div className={styles['section-property-panel']}>
      <div className={styles['panel-header']}>
        <span className={styles['panel-title']}>Section 属性</span>
        <Badge size="sm">{sectionTypeLabel}</Badge>
      </div>

      <div>
        <Input.Wrapper label="key" className={styles['form-item']}>
          <TextInput
            value={localSection.key ?? ''}
            onChange={(e) => {
              localSection.key = e.currentTarget.value
              emitUpdate()
            }}
          />
        </Input.Wrapper>

        {showBlockTitleField && (
          <Input.Wrapper label="区块标题" className={styles['form-item']}>
            <BindingFieldInput
              modelValue={localSection.props.title}
              placeholder="例如：渠道销售明细"
              onChange={(value) => {
                localSection.props.title = value
                emitUpdate()
              }}
            />
            <div className={styles['field-hint']}>
              用于画布卡片、Section 预览和最终报告中的区块标题展示。
            </div>
          </Input.Wrapper>
        )}

        <Input.Wrapper label="visible_when" className={styles['form-item']}>
          <BindingFieldInput
            modelValue={localSection.visible_when}
            placeholder="可选，不填写则默认显示。例如：{{metrics}}"
            onChange={(value) => {
              localSection.visible_when = value
              emitUpdate()
            }}
          />
          <div className={styles['field-hint']}>
            这里填写标准 Payload 字段对应的绑定表达式；可直接从下方“标准 Payload 字段”区域点击复制后粘贴。
          </div>
        </Input.Wrapper>

        <Input.Wrapper label="editor_note" className={styles['form-item']}>
          <Textarea
            value={localSection.editor_note ?? ''}
            rows={2}
            placeholder="例如：重点说明销售额、订单数和客单价变化；如退款订单已剔除请注明口径"
            onChange={(e) => {
              localSection.editor_note = e.currentTarget.value
              emitUpdate()
            }}
          />
        </Input.Wrapper>

        {section.type === 'heading' && (
          <HeadingSectionProperty section={localSection} onUpdate={emitUpdate} />
        )}
        {section.type === 'hero_summary' && (
          <HeroSummarySectionProperty section={localSection} onUpdate={emitUpdate} />
        )}
        {section.type === 'markdown' && (
          <MarkdownSectionProperty section={localSection} onUpdate={emitUpdate} />
        )}
        {section.type === 'html' && (
          <HtmlSectionProperty section={localSection} onUpdate={emitUpdate} />
        )}
        {section.type === 'metric_cards' && (
          <MetricCardsSectionProperty section={localSection} onUpdate={emitUpdate} />
        )}
        {section.type === 'data_table' && (
          <DataTableSectionProperty section={localSection} onUpdate={emitUpdate} />
        )}
        {section.type === 'chart' && (
          <ChartSectionProperty section={localSection} onUpdate={emitUpdate} />
        )}
        {(section.type === 'insight_list' || section.type === 'recommendations') && (
          <ListSectionProperty section={localSection} onUpdate={emitUpdate} />
        )}
        {section.type === 'divider' && <DividerSectionProperty />}
      </div>
    </div>
  )
}
