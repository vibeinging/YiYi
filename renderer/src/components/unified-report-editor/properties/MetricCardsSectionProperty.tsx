// TODO(migration): ../payloadBindings 尚未迁移(纯数据模块,后续 wave 转为 payloadBindings.ts)
import { useState } from 'react'
import { Button, Input, NumberInput, TextInput } from '@mantine/core'
import BindingFieldInput from '../BindingFieldInput'
import { COMMON_BINDING_OPTIONS } from '../payloadBindings'
import styles from './MetricCardsSectionProperty.module.scss'

interface MetricCardsSectionPropertyProps {
  section: any
  // defineEmits(['update']) → 回调 prop
  onUpdate?: () => void
}

export default function MetricCardsSectionProperty({
  section,
  onUpdate
}: MetricCardsSectionPropertyProps) {
  // 与 Vue 版一致：直接读写共享的 section.props 对象(模型由父级持有),变更后 emit update 触发重渲染
  if (!section.props) section.props = {}

  const emitUpdate = () => onUpdate?.()

  // previewItems = ref(section.props.preview_items || [])
  const [previewItems, setPreviewItems] = useState<any[]>(section.props.preview_items || [])
  // metricKeysText = ref(Array.isArray(...) ? join(', ') : '')
  const [metricKeysText, setMetricKeysText] = useState<string>(
    Array.isArray(section.props.metric_keys) ? section.props.metric_keys.join(', ') : ''
  )
  const [metricGroupsText, setMetricGroupsText] = useState<string>(
    Array.isArray(section.props.metric_groups) ? section.props.metric_groups.join(', ') : ''
  )

  const toStringList = (value: string) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)

  // watch(previewItems, deep) → 每次更新本地状态时同步回 section.props
  const updatePreviewItems = (value: any[]) => {
    section.props.preview_items = value
    setPreviewItems(value)
  }

  const syncMetricKeys = (text: string) => {
    setMetricKeysText(text)
    section.props.metric_keys = toStringList(text)
    emitUpdate()
  }

  const syncMetricGroups = (text: string) => {
    setMetricGroupsText(text)
    section.props.metric_groups = toStringList(text)
    emitUpdate()
  }

  const syncPreview = () => emitUpdate()

  const updateItemField = (idx: number, field: 'label' | 'value' | 'trend', value: string) => {
    const next = previewItems.map((item, i) => (i === idx ? { ...item, [field]: value } : item))
    updatePreviewItems(next)
    syncPreview()
  }

  const addItem = () => {
    updatePreviewItems([...previewItems, { label: '', value: '', trend: '' }])
    emitUpdate()
  }

  const removeItem = (idx: number) => {
    const next = previewItems.slice()
    next.splice(idx, 1)
    updatePreviewItems(next)
    emitUpdate()
  }

  return (
    <>
      <Input.Wrapper label="绑定字段">
        <BindingFieldInput
          modelValue={section.props.items}
          placeholder="例如: {{metrics}}"
          suggestions={COMMON_BINDING_OPTIONS.metrics}
          onChange={(value) => {
            section.props.items = value
            emitUpdate()
          }}
        />
      </Input.Wrapper>

      <Input.Wrapper label="metric_keys">
        <TextInput
          value={metricKeysText}
          placeholder="例如：order_count, gmv, avg_order_value"
          onChange={(e) => syncMetricKeys(e.currentTarget.value)}
        />
        <div className={styles['field-hint']}>
          按顺序填写需要优先生成的指标 key，Agent 会优先围绕这些指标组织 payload.metrics。
        </div>
      </Input.Wrapper>

      <Input.Wrapper label="max_items">
        <NumberInput
          value={section.props.max_items}
          min={1}
          step={1}
          onChange={(value) => {
            section.props.max_items = value
            emitUpdate()
          }}
        />
      </Input.Wrapper>

      <Input.Wrapper label="metric_groups">
        <TextInput
          value={metricGroupsText}
          placeholder="例如：orders, members"
          onChange={(e) => syncMetricGroups(e.currentTarget.value)}
        />
        <div className={styles['field-hint']}>
          用于描述指标分组语义，供 Agent 在生成时理解指标组织方式。
        </div>
      </Input.Wrapper>

      <Input.Wrapper label="示例指标">
        {previewItems.map((item, idx) => (
          <div key={idx} className={styles['list-item']}>
            <div className={styles['list-row']}>
              <TextInput
                value={item.label}
                placeholder="标签"
                size="xs"
                onChange={(e) => updateItemField(idx, 'label', e.currentTarget.value)}
              />
              <TextInput
                value={item.value}
                placeholder="值"
                size="xs"
                onChange={(e) => updateItemField(idx, 'value', e.currentTarget.value)}
              />
              <TextInput
                value={item.trend}
                placeholder="趋势"
                size="xs"
                onChange={(e) => updateItemField(idx, 'trend', e.currentTarget.value)}
              />
              <Button variant="subtle" size="xs" onClick={() => removeItem(idx)}>
                删除
              </Button>
            </div>
          </div>
        ))}
        <Button variant="default" size="xs" onClick={addItem}>
          添加示例指标
        </Button>
        <div className={styles['field-hint']}>
          仅用于编辑器调试和模板说明，真实数据仍以 payload 绑定字段为准。
        </div>
      </Input.Wrapper>
    </>
  )
}
