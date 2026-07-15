import { useMemo, useRef, useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, Badge, Button, Center, Modal, Text, Textarea } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import ElSvgIcon from '@/components/ElSvgIcon'
import styles from './CodeKnowledgeConditionBuilder.module.scss'

// 子组件
import TypeSelector from './CodeKnowledgeBuilder/TypeSelector'
import FieldConditionEditor from './CodeKnowledgeBuilder/FieldConditionEditor'
import SqlFragmentEditor from './CodeKnowledgeBuilder/SqlFragmentEditor'
import EntityMappingEditor from './CodeKnowledgeBuilder/EntityMappingEditor'
import DynamicInferenceEditor from './CodeKnowledgeBuilder/DynamicInferenceEditor'

export interface CodeKnowledgeConditionBuilderProps {
  relatedColumns?: Record<string, any>
  columnEnumMappings?: Record<string, any>
  codeKnowledge?: any
  businessId?: string
  projectId?: string
  // defineEmits(['update:codeKnowledge']) → 回调 prop
  'onUpdate:codeKnowledge'?: (value: any) => void
}

interface EditingCondition {
  type: string
  operator: any
  values: string[]
  description: string
}

export default function CodeKnowledgeConditionBuilder({
  relatedColumns = {},
  columnEnumMappings = {},
  codeKnowledge = null,
  businessId = '',
  projectId = '',
  'onUpdate:codeKnowledge': onUpdateCodeKnowledge
}: CodeKnowledgeConditionBuilderProps) {
  const { t } = useTranslation()

  // 状态
  const [activeFieldKey, setActiveFieldKey] = useState<string | null>(null)
  const [editingCondition, setEditingCondition] = useState<EditingCondition>({
    type: 'field_condition',
    operator: null,
    values: [],
    description: ''
  })
  const [savedConditions, setSavedConditions] = useState<any[]>([])
  const [showJsonEditDialog, setShowJsonEditDialog] = useState(false)
  const [jsonEditText, setJsonEditText] = useState('')
  const [jsonEditError, setJsonEditError] = useState('')

  // 计算属性：所有可用字段
  const availableFields = useMemo(() => {
    const fields: any[] = []
    const tables = relatedColumns || {}

    for (const [tableName, columns] of Object.entries(tables)) {
      const tableMappings = (columnEnumMappings as any)[tableName] || {}

      for (const columnName of columns as string[]) {
        const columnInfo = tableMappings[columnName]

        fields.push({
          key: `${tableName}.${columnName}`,
          table_name: tableName,
          column_name: columnName,
          full_name: `${tableName}.${columnName}`,
          description: columnInfo?.description,
          enum_mappings: columnInfo?.enum_mappings?.mappings || []
        })
      }
    }

    return fields
  }, [relatedColumns, columnEnumMappings])

  // 当前激活的字段
  const activeField = useMemo(() => {
    return availableFields.find((f) => f.key === activeFieldKey)
  }, [availableFields, activeFieldKey])

  // 判断条件是否完成
  const isConditionComplete = (cond: any) => {
    if (!cond.values || cond.values.length === 0) {
      return false
    }

    const hasValidValues = cond.values.some((v: any) => v && v.trim())
    if (!hasValidValues) {
      return false
    }

    switch (cond.type) {
      case 'field_condition':
        return true
      case 'sql_fragment':
        return cond.values.some((v: string) => v.trim())
      case 'entity_mapping':
        return cond.values.some((v: string) => v.trim())
      case 'dynamic_inference':
        return cond.values.some((v: string) => v.trim()) && cond.operator
      default:
        return false
    }
  }

  // 已完成的条件
  const completedConditions = useMemo(() => {
    return savedConditions.filter((cond) => isConditionComplete(cond))
  }, [savedConditions])

  // 获取类型标签类型(EP tag type → Mantine Badge color)
  const getTypeTagType = (type: string) => {
    const typeMap: Record<string, string> = {
      field_condition: 'blue',
      sql_fragment: 'orange',
      entity_mapping: 'green',
      dynamic_inference: 'gray'
    }
    return typeMap[type] || 'gray'
  }

  // 获取类型标签
  const getTypeLabel = (type: string) => {
    const labelMap: Record<string, string> = {
      field_condition: t('business.conditionBuilder.typeStaticCondition'),
      sql_fragment: t('business.conditionBuilder.typeSqlFragment'),
      entity_mapping: t('business.conditionBuilder.typeEntityMapping'),
      dynamic_inference: t('business.conditionBuilder.typeDynamicInference')
    }
    return labelMap[type] || type
  }

  // 获取条件摘要
  const getConditionSummary = (cond: any) => {
    switch (cond.type) {
      case 'field_condition':
        return `${t('business.conditionBuilder.summaryValues')} ${cond.values.join(', ')}`
      case 'sql_fragment':
        return cond.values[0] || ''
      case 'entity_mapping':
        return `${t('business.conditionBuilder.summaryMappingField')} ${cond.values[0] || ''}`
      case 'dynamic_inference':
        return `${t('business.conditionBuilder.summaryRule')} ${cond.values[0] || ''}`
      default:
        return ''
    }
  }

  // 处理字段点击
  const handleFieldClick = (field: any) => {
    setActiveFieldKey(field.key)

    // 如果已有配置，加载配置
    const existing = savedConditions.find((c) => c.key === field.key)
    if (existing) {
      setEditingCondition({
        type: existing.type,
        operator: existing.operator,
        values: [...existing.values],
        description: existing.description
      })
    } else {
      // 重置为默认值
      setEditingCondition({
        type: 'field_condition',
        operator: null,
        values: [],
        description: ''
      })
    }
  }

  // 处理类型变化
  const handleTypeChange = () => {
    setEditingCondition((prev) => {
      const next: EditingCondition = { ...prev, values: [] }

      switch (next.type) {
        case 'field_condition':
          next.operator = null
          break
        case 'sql_fragment':
          next.operator = ''
          break
        case 'entity_mapping':
          next.operator = '='
          break
        case 'dynamic_inference':
          next.operator = null
          break
      }
      return next
    })
  }

  // 同步到 codeKnowledge
  // 使用一个标志来避免同步自己触发的更新
  const isSyncingFromLocal = useRef(false)

  const syncToCodeKnowledge = (conditionsSource: any[]) => {
    const conditions = conditionsSource
      .filter((cond) => isConditionComplete(cond))
      .map(({ key, full_name, ...rest }) => rest)

    // 设置标志，避免 watch 回滚
    isSyncingFromLocal.current = true

    if (conditions.length === 0) {
      onUpdateCodeKnowledge?.(null)
    } else {
      onUpdateCodeKnowledge?.({ conditions })
    }

    // 下一个 tick 后重置标志
    setTimeout(() => {
      isSyncingFromLocal.current = false
    }, 0)
  }

  // 保存条件
  const handleSaveCondition = () => {
    if (!activeField) return

    const condition = {
      key: activeField.key,
      type: editingCondition.type,
      table_name: activeField.table_name,
      field: activeField.column_name,
      full_name: activeField.full_name,
      operator: editingCondition.operator,
      values: editingCondition.values,
      description: editingCondition.description
    }

    // 查找是否已存在
    const index = savedConditions.findIndex((c) => c.key === condition.key)
    let nextConditions: any[]
    if (index > -1) {
      nextConditions = savedConditions.slice()
      nextConditions[index] = condition
      notifications.show({ color: 'green', message: t('business.conditionBuilder.configUpdated') })
    } else {
      nextConditions = [...savedConditions, condition]
      notifications.show({ color: 'green', message: t('business.conditionBuilder.configAdded') })
    }

    setSavedConditions(nextConditions)
    syncToCodeKnowledge(nextConditions)
  }

  // 删除条件
  const handleDeleteCondition = () => {
    if (!activeField) return

    // 在清空之前保存 full_name，用于消息提示
    const fullName = activeField.full_name

    const nextConditions = savedConditions.filter((c) => c.key !== activeField.key)
    setSavedConditions(nextConditions)
    setActiveFieldKey(null)
    syncToCodeKnowledge(nextConditions)
    notifications.show({
      color: 'blue',
      message: t('business.conditionBuilder.configDeleted', { name: fullName })
    })
  }

  // 移除条件
  const handleRemoveCondition = (index: number) => {
    const cond = completedConditions[index]
    const nextConditions = savedConditions.filter((c) => c.key !== cond.key)
    setSavedConditions(nextConditions)

    if (activeFieldKey === cond.key) {
      setActiveFieldKey(null)
    }

    syncToCodeKnowledge(nextConditions)
    notifications.show({
      color: 'blue',
      message: t('business.conditionBuilder.configRemoved', { name: cond.full_name })
    })
  }

  // 打开JSON编辑弹窗
  const openJsonEditDialog = () => {
    const ck = codeKnowledge || { conditions: [] }
    setJsonEditText(JSON.stringify(ck, null, 2))
    setJsonEditError('')
  }

  // 保存JSON编辑
  const handleSaveJsonEdit = () => {
    setJsonEditError('')

    if (!jsonEditText.trim()) {
      // 设置标志，避免 watch 回滚
      isSyncingFromLocal.current = true
      onUpdateCodeKnowledge?.(null)
      setSavedConditions([])
      setShowJsonEditDialog(false)
      notifications.show({ color: 'blue', message: t('business.conditionBuilder.configCleared') })
      return
    }

    try {
      const parsed = JSON.parse(jsonEditText)

      if (!parsed.conditions || !Array.isArray(parsed.conditions)) {
        setJsonEditError(t('business.conditionBuilder.jsonErrorMissingConditions'))
        return
      }

      // 设置标志，避免 watch 回滚
      isSyncingFromLocal.current = true
      onUpdateCodeKnowledge?.(parsed)

      // 同步到 savedConditions
      setSavedConditions(
        parsed.conditions.map((cond: any) => ({
          ...cond,
          key: `${cond.table_name}.${cond.field}`,
          full_name: `${cond.table_name}.${cond.field}`
        }))
      )

      setShowJsonEditDialog(false)
      notifications.show({ color: 'green', message: t('business.conditionBuilder.jsonConfigSaved') })
    } catch (e: any) {
      setJsonEditError(t('business.conditionBuilder.jsonParseError', { message: e.message }))
    }
  }

  // 监听 codeKnowledge 变化，同步到 savedConditions
  useEffect(() => {
    if (isSyncingFromLocal.current) {
      isSyncingFromLocal.current = false
      return
    }

    if (codeKnowledge?.conditions) {
      setSavedConditions(
        codeKnowledge.conditions.map((cond: any) => ({
          ...cond,
          key: `${cond.table_name}.${cond.field}`,
          full_name: `${cond.table_name}.${cond.field}`
        }))
      )
    } else {
      setSavedConditions([])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codeKnowledge])

  // 监听弹窗打开，初始化JSON内容
  useEffect(() => {
    if (showJsonEditDialog) {
      openJsonEditDialog()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showJsonEditDialog])

  // editingCondition 各字段的受控更新(对应子组件的 v-model:xxx)
  const updateEditing = (patch: Partial<EditingCondition>) =>
    setEditingCondition((prev) => ({ ...prev, ...patch }))

  return (
    <div className={styles.codeKnowledgeConditionBuilder}>
      {/* 三栏布局 */}
      <div className={styles.threeColumnLayout}>
        {/* 左侧：可配置字段列表 */}
        <div className={styles.fieldListPanel}>
          <div className={styles.areaHeader}>
            <h4>
              {t('business.conditionBuilder.configurableFields')} ({availableFields.length})
            </h4>
          </div>
          {availableFields.length > 0 ? (
            <div className={styles.fieldsListContainer}>
              {availableFields.map((field) => (
                <div
                  key={field.key}
                  className={`${styles.fieldListItem} ${activeFieldKey === field.key ? styles.active : ''}`}
                  onClick={() => handleFieldClick(field)}
                >
                  <div className={styles.fieldInfo}>
                    <span className={styles.fieldName}>{field.column_name}</span>
                    {field.description && (
                      <span className={styles.fieldDesc} title={field.description}>
                        {field.description}
                      </span>
                    )}
                    <span className={styles.fieldDesc}>{field.table_name}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className={styles.noFieldsHint}>
              <Center style={{ flexDirection: 'column' }}>
                <Text c="dimmed" size="sm">
                  {t('business.conditionBuilder.noAvailableFields')}
                </Text>
                <p className={styles.hintText}>{t('business.conditionBuilder.noAvailableFieldsHint')}</p>
              </Center>
            </div>
          )}
        </div>

        {/* 中间：条件编辑区 */}
        <div className={styles.conditionEditPanel}>
          {activeField ? (
            <div className={styles.editContainer}>
              <div className={styles.areaHeader}>
                <h4>{t('business.conditionBuilder.editFieldConfig')}</h4>
              </div>

              <div className={styles.editorContent}>
                <TypeSelector
                  type={editingCondition.type}
                  operator={editingCondition.operator}
                  onUpdateType={(v: string) => updateEditing({ type: v })}
                  onUpdateOperator={(v: any) => updateEditing({ operator: v })}
                  onChange={handleTypeChange}
                />

                {/* field_condition 编辑器 */}
                {editingCondition.type === 'field_condition' && (
                  <FieldConditionEditor
                    values={editingCondition.values}
                    description={editingCondition.description}
                    onUpdateValues={(v: string[]) => updateEditing({ values: v })}
                    onUpdateDescription={(v: string) => updateEditing({ description: v })}
                    fieldInfo={activeField}
                    enumMappings={activeField.enum_mappings || []}
                  />
                )}

                {/* sql_fragment 编辑器 */}
                {editingCondition.type === 'sql_fragment' && (
                  <SqlFragmentEditor
                    values={editingCondition.values}
                    description={editingCondition.description}
                    onUpdateValues={(v: string[]) => updateEditing({ values: v })}
                    onUpdateDescription={(v: string) => updateEditing({ description: v })}
                    fieldInfo={activeField}
                  />
                )}

                {/* entity_mapping 编辑器 */}
                {editingCondition.type === 'entity_mapping' && (
                  <EntityMappingEditor
                    values={editingCondition.values}
                    description={editingCondition.description}
                    onUpdateValues={(v: string[]) => updateEditing({ values: v })}
                    onUpdateDescription={(v: string) => updateEditing({ description: v })}
                    fieldInfo={activeField}
                    allFields={availableFields}
                    businessId={businessId}
                    projectId={projectId}
                  />
                )}

                {/* dynamic_inference 编辑器 */}
                {editingCondition.type === 'dynamic_inference' && (
                  <DynamicInferenceEditor
                    values={editingCondition.values}
                    operator={editingCondition.operator}
                    description={editingCondition.description}
                    onUpdateValues={(v: string[]) => updateEditing({ values: v })}
                    onUpdateDescription={(v: string) => updateEditing({ description: v })}
                    fieldInfo={activeField}
                  />
                )}
              </div>

              <div className={styles.editorActions}>
                <Button color="red" onClick={handleDeleteCondition}>
                  {t('business.conditionBuilder.delete')}
                </Button>
                <Button onClick={handleSaveCondition}>
                  {t('business.conditionBuilder.update')}
                </Button>
              </div>
            </div>
          ) : (
            <div className={styles.noSelectionHint}>
              <Center>
                <Text c="dimmed" size="sm">
                  {t('business.conditionBuilder.selectFieldHint')}
                </Text>
              </Center>
            </div>
          )}
        </div>

        {/* 右侧：JSON展示区 */}
        <div className={styles.jsonDisplayPanel}>
          <div className={styles.areaHeader}>
            <h4>
              {t('business.conditionBuilder.configuredConditions')} ({completedConditions.length})
            </h4>
            <Button
              size="xs"
              variant="default"
              leftSection={<ElSvgIcon name="Edit" />}
              onClick={() => setShowJsonEditDialog(true)}
            >
              {t('business.conditionBuilder.editJson')}
            </Button>
          </div>

          {completedConditions.length > 0 ? (
            <div className={styles.conditionsList}>
              {completedConditions.map((cond, index) => (
                <div key={cond.key} className={styles.conditionSummaryItem}>
                  <div className={styles.conditionSummaryHeader}>
                    <div className={styles.conditionSummaryLeft}>
                      <div className={styles.fieldNameRow}>{cond.field}</div>
                      <div className={styles.fieldTableRow}>{cond.table_name}</div>
                    </div>
                    <div className={styles.conditionSummaryRight}>
                      <Badge size="sm" color={getTypeTagType(cond.type)}>
                        {getTypeLabel(cond.type)}
                      </Badge>
                      <Button
                        size="xs"
                        color="red"
                        variant="subtle"
                        onClick={() => handleRemoveCondition(index)}
                      >
                        {t('business.conditionBuilder.remove')}
                      </Button>
                    </div>
                  </div>
                  <div className={styles.conditionSummaryDetail}>{getConditionSummary(cond)}</div>
                  {cond.description && (
                    <div className={styles.conditionSummaryDescription}>{cond.description}</div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className={styles.noConditionsHint}>
              <Center>
                <Text c="dimmed" size="sm">
                  {t('business.conditionBuilder.noConditions')}
                </Text>
              </Center>
            </div>
          )}
        </div>
      </div>

      {/* JSON编辑弹窗 */}
      <Modal
        opened={showJsonEditDialog}
        onClose={() => setShowJsonEditDialog(false)}
        title={t('business.conditionBuilder.editJsonConfig')}
        size="600px"
        closeOnClickOutside={false}
        className={styles.jsonEditDialog}
      >
        <Textarea
          value={jsonEditText}
          onChange={(e) => setJsonEditText(e.currentTarget.value)}
          minRows={15}
          autosize
          placeholder={t('business.conditionBuilder.jsonPlaceholder')}
        />
        {jsonEditError && (
          <div className={styles.jsonEditError}>
            <Alert color="red" withCloseButton={false}>
              {jsonEditError}
            </Alert>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Button variant="default" onClick={() => setShowJsonEditDialog(false)}>
            {t('business.conditionBuilder.cancel')}
          </Button>
          <Button onClick={handleSaveJsonEdit}>
            {t('business.conditionBuilder.save')}
          </Button>
        </div>
      </Modal>
    </div>
  )
}
