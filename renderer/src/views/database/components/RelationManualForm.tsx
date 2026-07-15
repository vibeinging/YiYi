import { useState } from 'react'
import { Grid, Input, Select, TextInput } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import styles from './RelationManualForm.module.scss'

// 对应原 defineProps：relationForm 为父级持有的双向绑定对象
interface RelationFormModel {
  source_table_id?: any
  source_column?: any
  target_table_id?: any
  target_column?: any
  relationship_type?: any
  description?: any
  [key: string]: any
}

interface TableItem {
  id: any
  table_name: string
  [key: string]: any
}

interface ColumnItem {
  column_name: string
  data_type: string
  [key: string]: any
}

interface RelationManualFormProps {
  relationForm: RelationFormModel
  tables?: TableItem[]
  sourceColumns?: ColumnItem[]
  targetColumns?: ColumnItem[]
  // defineEmits(['source-table-change', 'target-table-change'])
  onSourceTableChange?: (value: any) => void
  onTargetTableChange?: (value: any) => void
}

export default function RelationManualForm({
  relationForm,
  tables = [],
  sourceColumns = [],
  targetColumns = [],
  onSourceTableChange,
  onTargetTableChange
}: RelationManualFormProps) {
  const { t } = useTranslation()

  // relationForm 由父级持有(原 v-model 直接改父对象)，这里就地改写并触发本组件重渲染
  const [, forceUpdate] = useState(0)
  const setField = (key: string, value: any) => {
    relationForm[key] = value
    forceUpdate((n) => n + 1)
  }

  // el-select 的 value 需为字符串，原 id 可能是数字，做归一化
  const toStr = (v: any) => (v === undefined || v === null ? null : String(v))

  // 表下拉选项：value 用 id，label 用 table_name
  const tableOptions = tables.map((tb) => ({ value: String(tb.id), label: tb.table_name }))

  // 列下拉选项：label = `${column_name} (${data_type})`，value = column_name
  const sourceColumnOptions = sourceColumns.map((c) => ({
    value: c.column_name,
    label: `${c.column_name} (${c.data_type})`
  }))
  const targetColumnOptions = targetColumns.map((c) => ({
    value: c.column_name,
    label: `${c.column_name} (${c.data_type})`
  }))

  // 通过 id 字符串找回原始 id 类型(数字/字符串)
  const findTableId = (value: string | null) => {
    if (value === null) return null
    const match = tables.find((tb) => String(tb.id) === value)
    return match ? match.id : value
  }

  return (
    <div className={styles.relationManualForm}>
      <Grid gutter={16}>
        <Grid.Col span={6}>
          {/* el-form-item label-position=top + required */}
          <Input.Wrapper
            label={t('database.relation.sourceTable')}
            required
            className={styles.formItem}
          >
            <Select
              value={toStr(relationForm.source_table_id)}
              placeholder={t('database.relation.selectSourceTable') as string}
              searchable
              data={tableOptions}
              onChange={(val) => {
                const realId = findTableId(val)
                setField('source_table_id', realId)
                onSourceTableChange?.(realId)
              }}
            />
          </Input.Wrapper>
        </Grid.Col>
        <Grid.Col span={6}>
          <Input.Wrapper
            label={t('database.relation.sourceColumn')}
            required
            className={styles.formItem}
          >
            <Select
              value={toStr(relationForm.source_column)}
              placeholder={t('database.relation.selectColumn') as string}
              searchable
              data={sourceColumnOptions}
              onChange={(val) => setField('source_column', val)}
            />
          </Input.Wrapper>
        </Grid.Col>
      </Grid>
      <Grid gutter={16}>
        <Grid.Col span={6}>
          <Input.Wrapper
            label={t('database.relation.targetTable')}
            required
            className={styles.formItem}
          >
            <Select
              value={toStr(relationForm.target_table_id)}
              placeholder={t('database.relation.selectTargetTable') as string}
              searchable
              data={tableOptions}
              onChange={(val) => {
                const realId = findTableId(val)
                setField('target_table_id', realId)
                onTargetTableChange?.(realId)
              }}
            />
          </Input.Wrapper>
        </Grid.Col>
        <Grid.Col span={6}>
          <Input.Wrapper
            label={t('database.relation.targetColumn')}
            required
            className={styles.formItem}
          >
            <Select
              value={toStr(relationForm.target_column)}
              placeholder={t('database.relation.selectColumn') as string}
              searchable
              data={targetColumnOptions}
              onChange={(val) => setField('target_column', val)}
            />
          </Input.Wrapper>
        </Grid.Col>
      </Grid>
      <Input.Wrapper label={t('database.relation.type')} className={styles.formItem}>
        <Select
          value={toStr(relationForm.relationship_type)}
          data={[
            { value: 'many_to_one', label: t('database.relation.manyToOne') },
            { value: 'one_to_one', label: t('database.relation.oneToOne') },
            { value: 'many_to_many', label: t('database.relation.manyToMany') }
          ]}
          onChange={(val) => setField('relationship_type', val)}
        />
      </Input.Wrapper>
      <Input.Wrapper label={t('database.relation.description')} className={styles.formItem}>
        <TextInput
          value={relationForm.description ?? ''}
          placeholder={t('database.relation.descriptionPlaceholder') as string}
          onChange={(e) => setField('description', e.currentTarget.value)}
        />
      </Input.Wrapper>
    </div>
  )
}
