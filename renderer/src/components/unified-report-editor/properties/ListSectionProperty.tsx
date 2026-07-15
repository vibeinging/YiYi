import { useMemo, useState } from 'react'
import { Button, Input, NumberInput, TextInput } from '@mantine/core'
import BindingFieldInput from '../BindingFieldInput'
// TODO(migration): payloadBindings.js 数据模块尚未迁移,暂从源 .js 引入(tsconfig allowJs 已开),迁移后改为 .ts
import { COMMON_BINDING_OPTIONS } from '../payloadBindings'
import styles from './ListSectionProperty.module.scss'

interface ListSectionPropertyProps {
  section: any
  // defineEmits(['update']) → 回调 prop
  onUpdate?: () => void
}

export default function ListSectionProperty({ section, onUpdate }: ListSectionPropertyProps) {
  // 源里直接拿 props.section 并补齐 props 字段;React 中同样原地补齐(parent 持有 section 对象)
  if (!section.props) section.props = {}

  const emit = () => onUpdate?.()

  // ref(section.props.preview_items || []) + watch(deep) 回写 section.props.preview_items
  const [previewItems, setPreviewItems] = useState<string[]>(section.props.preview_items || [])
  const [topicsText, setTopicsText] = useState<string>(
    Array.isArray(section.props.topics) ? section.props.topics.join(', ') : ''
  )

  // watch(previewItems, deep) → 写回 section.props 后再 emit
  const syncPreviewItems = (value: string[]) => {
    section.props.preview_items = value
    setPreviewItems(value)
  }

  const placeholder = useMemo(
    () => (section.type === 'recommendations' ? '{{recommendations}}' : '{{insights}}'),
    [section.type]
  )
  const bindingSuggestions = useMemo(
    () =>
      section.type === 'recommendations'
        ? COMMON_BINDING_OPTIONS.recommendations
        : COMMON_BINDING_OPTIONS.insights,
    [section.type]
  )

  const syncTopics = (value: string) => {
    setTopicsText(value)
    section.props.topics = value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    emit()
  }

  const addItem = () => {
    syncPreviewItems([...previewItems, ''])
    emit()
  }

  const removeItem = (idx: number) => {
    const next = previewItems.slice()
    next.splice(idx, 1)
    syncPreviewItems(next)
    emit()
  }

  const updateItem = (idx: number, value: string) => {
    const next = previewItems.slice()
    next[idx] = value
    syncPreviewItems(next)
    emit()
  }

  return (
    <>
      <Input.Wrapper label="绑定字段">
        <BindingFieldInput
          modelValue={section.props.items}
          placeholder={placeholder}
          suggestions={bindingSuggestions}
          onChange={(v) => {
            section.props.items = v
            emit()
          }}
        />
      </Input.Wrapper>

      <Input.Wrapper label="topics">
        <TextInput
          value={topicsText}
          placeholder="例如：sales_change, region_diff, channel_performance"
          onChange={(e) => syncTopics(e.currentTarget.value)}
        />
        <div className={styles.fieldHint}>
          配置当前区块优先覆盖的主题，Agent 会优先围绕这些主题输出内容。
        </div>
      </Input.Wrapper>

      <Input.Wrapper label="max_items">
        <NumberInput
          value={section.props.max_items}
          min={1}
          step={1}
          onChange={(v) => {
            section.props.max_items = v
            emit()
          }}
        />
      </Input.Wrapper>

      <Input.Wrapper label="示例条目">
        {previewItems.map((item, idx) => (
          <div key={idx} className={styles.listItem}>
            <div className={styles.listRow}>
              <TextInput
                value={item}
                size="sm"
                onChange={(e) => updateItem(idx, e.currentTarget.value)}
              />
              <Button variant="subtle" size="compact-sm" onClick={() => removeItem(idx)}>
                删除
              </Button>
            </div>
          </div>
        ))}
        <Button size="xs" onClick={addItem}>
          添加示例条目
        </Button>
        <div className={styles.fieldHint}>
          示例条目仅用于模板设计说明，最终内容仍来自 payload 绑定。
        </div>
      </Input.Wrapper>
    </>
  )
}
