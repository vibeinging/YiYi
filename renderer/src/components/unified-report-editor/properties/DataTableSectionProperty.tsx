// TODO(migration): ../payloadBindings 尚未迁移(纯数据模块,后续 wave 转为 payloadBindings.ts)
import { useState } from 'react'
import { Button, Input, NumberInput, Textarea, TextInput } from '@mantine/core'
import BindingFieldInput from '../BindingFieldInput'
import { COMMON_BINDING_OPTIONS } from '../payloadBindings'
import styles from './DataTableSectionProperty.module.scss'

interface DataTableSectionPropertyProps {
  section: any
  // defineEmits(['update']) → 回调 prop
  onUpdate?: () => void
}

export default function DataTableSectionProperty({ section, onUpdate }: DataTableSectionPropertyProps) {
  // 与 Vue 版一致：直接读写共享的 section.props 对象(模型由父级持有),变更后 emit update 触发重渲染
  if (!section.props) section.props = {}

  const emitUpdate = () => onUpdate?.()

  const [previewColumns, setPreviewColumns] = useState<any[]>(section.props.preview_columns || [])
  const [previewRowsText, setPreviewRowsText] = useState<string>(
    JSON.stringify(section.props.preview_rows || [], null, 2)
  )
  const [requiredColumnsText, setRequiredColumnsText] = useState<string>(
    Array.isArray(section.props.required_columns) ? section.props.required_columns.join(', ') : ''
  )

  // watch(previewColumns, deep) → 每次更新本地状态时同步回 section.props
  const updatePreviewColumns = (value: any[]) => {
    section.props.preview_columns = value
    setPreviewColumns(value)
  }

  const syncRequiredColumns = (text: string) => {
    setRequiredColumnsText(text)
    section.props.required_columns = text
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    emitUpdate()
  }

  const addColumn = () => {
    updatePreviewColumns([...previewColumns, { key: '', title: '' }])
    emitUpdate()
  }
  const removeColumn = (idx: number) => {
    const next = previewColumns.slice()
    next.splice(idx, 1)
    updatePreviewColumns(next)
    emitUpdate()
  }

  const updateColumnField = (idx: number, field: 'key' | 'title', value: string) => {
    const next = previewColumns.map((col, i) => (i === idx ? { ...col, [field]: value } : col))
    updatePreviewColumns(next)
    emitUpdate()
  }

  const syncRows = (text: string) => {
    setPreviewRowsText(text)
    try {
      section.props.preview_rows = JSON.parse(text || '[]')
      emitUpdate()
    } catch {
      // 输入过程中允许临时无效 JSON
    }
  }

  return (
    <>
      <Input.Wrapper label="列绑定">
        <BindingFieldInput
          modelValue={section.props.columns}
          placeholder="例如: {{tables.sales_detail.columns}}"
          suggestions={COMMON_BINDING_OPTIONS.tableColumns}
          onChange={(value) => {
            section.props.columns = value
            emitUpdate()
          }}
        />
      </Input.Wrapper>

      <Input.Wrapper label="行绑定">
        <BindingFieldInput
          modelValue={section.props.rows}
          placeholder="例如: {{tables.sales_detail.rows}}"
          suggestions={COMMON_BINDING_OPTIONS.tableRows}
          onChange={(value) => {
            section.props.rows = value
            emitUpdate()
          }}
        />
      </Input.Wrapper>

      <Input.Wrapper label="table_key">
        <TextInput
          value={section.props.table_key ?? ''}
          placeholder="例如：sales_detail"
          onChange={(e) => {
            section.props.table_key = e.currentTarget.value
            emitUpdate()
          }}
        />
        <div className={styles['field-hint']}>指定正式生成时优先产出的 payload.tables key。</div>
      </Input.Wrapper>

      <Input.Wrapper label="required_columns">
        <TextInput
          value={requiredColumnsText}
          placeholder="例如：channel, order_count, gmv"
          onChange={(e) => syncRequiredColumns(e.currentTarget.value)}
        />
        <div className={styles['field-hint']}>用于约束表格优先覆盖的列 key。</div>
      </Input.Wrapper>

      <Input.Wrapper label="max_rows">
        <NumberInput
          value={section.props.max_rows}
          min={1}
          step={1}
          onChange={(value) => {
            section.props.max_rows = value
            emitUpdate()
          }}
        />
      </Input.Wrapper>

      <Input.Wrapper label="示例列">
        {previewColumns.map((col, idx) => (
          <div key={idx} className={styles['list-item']}>
            <div className={`${styles['list-row']} ${styles['table-row']}`}>
              <TextInput
                value={col.key}
                placeholder="key"
                size="xs"
                onChange={(e) => updateColumnField(idx, 'key', e.currentTarget.value)}
              />
              <TextInput
                value={col.title}
                placeholder="标题"
                size="xs"
                onChange={(e) => updateColumnField(idx, 'title', e.currentTarget.value)}
              />
              <Button variant="subtle" size="xs" onClick={() => removeColumn(idx)}>
                删除
              </Button>
            </div>
          </div>
        ))}
        <Button variant="default" size="xs" onClick={addColumn}>
          添加示例列
        </Button>
      </Input.Wrapper>

      <Input.Wrapper label="示例数据行(JSON)">
        <Textarea
          value={previewRowsText}
          rows={5}
          onChange={(e) => syncRows(e.currentTarget.value)}
        />
        <div className={styles['field-hint']}>
          示例数据用于编辑说明和后续增强预览，不替代正式 payload 数据。
        </div>
      </Input.Wrapper>
    </>
  )
}
