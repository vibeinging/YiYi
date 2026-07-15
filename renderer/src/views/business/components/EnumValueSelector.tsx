import { useMemo, useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, Button, Checkbox, CloseButton, SegmentedControl, Textarea } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import ElSvgIcon from '@/components/ElSvgIcon'
import styles from './EnumValueSelector.module.scss'

export interface EnumValueSelectorProps {
  // related_columns: { table_name: [column_name1, column_name2] }
  relatedColumns?: Record<string, any>
  // 列的枚举映射数据: { table_name: { column_name: { enum_mappings: {...} } } }
  columnEnumMappings?: Record<string, any>
  // code_knowledge 对象或 null
  codeKnowledge?: any
  // defineEmits(['update:codeKnowledge']) → 回调 prop
  'onUpdate:codeKnowledge'?: (value: any) => void
}

export default function EnumValueSelector({
  relatedColumns = {},
  columnEnumMappings = {},
  codeKnowledge = null,
  'onUpdate:codeKnowledge': onUpdateCodeKnowledge
}: EnumValueSelectorProps) {
  const { t } = useTranslation()

  // 编辑模式: selector | json
  const [editMode, setEditMode] = useState<'selector' | 'json'>('selector')

  // JSON 文本和错误
  const [jsonText, setJsonText] = useState('')
  const [jsonError, setJsonError] = useState('')

  // 字段相关状态
  const [activeFieldKey, setActiveFieldKey] = useState<string | null>(null)
  const [selectedValues, setSelectedValues] = useState<any[]>([]) // 临时选中的枚举值

  // 计算属性：所有有枚举值的字段列表
  const enumFields = useMemo(() => {
    const fields: any[] = []
    const tables = relatedColumns || {}

    for (const [tableName, columns] of Object.entries(tables)) {
      const tableMappings = (columnEnumMappings as any)[tableName] || {}

      for (const columnName of columns as string[]) {
        const columnInfo = tableMappings[columnName]

        if (columnInfo?.enum_mappings?.mappings?.length > 0) {
          fields.push({
            key: `${tableName}.${columnName}`, // 唯一标识
            table_name: tableName,
            column_name: columnName,
            description: columnInfo.description,
            enum_mappings: columnInfo.enum_mappings.mappings
          })
        }
      }
    }

    return fields
  }, [relatedColumns, columnEnumMappings])

  // 当前激活的字段
  const activeField = useMemo(() => {
    return enumFields.find((f) => f.key === activeFieldKey) || null
  }, [enumFields, activeFieldKey])

  // 计算属性：已选配置分组 (从 codeKnowledge 转换)
  const groupedConfigs = useMemo(() => {
    if (!codeKnowledge?.fields || codeKnowledge.fields.length === 0) {
      return []
    }
    return codeKnowledge.fields.map((field: any) => ({
      field_name: field.field_name,
      field_display_name: field.field_display_name || field.field_name,
      description: field.description,
      code_values: field.code_values || []
    }))
  }, [codeKnowledge])

  // 计算属性：配置统计
  const configStats = useMemo(() => {
    const fieldCount = groupedConfigs.length
    const valueCount = groupedConfigs.reduce(
      (sum: number, group: any) => sum + group.code_values.length,
      0
    )
    return { fieldCount, valueCount }
  }, [groupedConfigs])

  // 判断枚举值是否已选（临时选择）
  const isValueSelected = (mapping: any) => {
    return selectedValues.some((v) => v.code === mapping.code)
  }

  // 判断枚举值是否已添加到配置
  const isValueDisabled = (mapping: any) => {
    if (!activeField) return false
    const fieldConfig = groupedConfigs.find((f: any) => f.field_name === activeField.column_name)
    if (!fieldConfig) return false
    return fieldConfig.code_values.some((cv: any) => cv.code === mapping.code)
  }

  // 计算属性：是否全选
  const isAllValuesSelected = useMemo(() => {
    if (!activeField) return false
    const selectableValues = activeField.enum_mappings.filter((v: any) => !isValueDisabled(v))
    if (selectableValues.length === 0) return false
    return selectableValues.every((v: any) => isValueSelected(v))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeField, groupedConfigs, selectedValues])

  // 计算属性：是否部分选中
  const isSomeValuesSelected = useMemo(() => {
    if (!activeField) return false
    const selectableValues = activeField.enum_mappings.filter((v: any) => !isValueDisabled(v))
    return selectableValues.some((v: any) => isValueSelected(v))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeField, groupedConfigs, selectedValues])

  // 处理字段选择
  const handleFieldSelect = (field: any) => {
    setActiveFieldKey(field.key)
    setSelectedValues([])
  }

  // 处理枚举值 checkbox 变化
  const handleValueCheckChange = (mapping: any, checked: boolean) => {
    if (checked) {
      if (!isValueSelected(mapping)) {
        setSelectedValues((prev) => [...prev, mapping])
      }
    } else {
      setSelectedValues((prev) => prev.filter((v) => v.code !== mapping.code))
    }
  }

  // 处理全选/取消全选
  const handleToggleSelectAll = (checked: boolean) => {
    if (checked) {
      // 全选：添加所有未禁用的枚举值
      const selectableValues = activeField.enum_mappings.filter((v: any) => !isValueDisabled(v))
      setSelectedValues([...selectableValues])
    } else {
      // 取消全选
      setSelectedValues([])
    }
  }

  // 处理添加已选枚举值
  const handleAddSelectedValues = () => {
    if (selectedValues.length === 0 || !activeField) return

    const ck = codeKnowledge || { fields: [] }
    let fieldConfig = ck.fields.find((f: any) => f.field_name === activeField.column_name)

    if (!fieldConfig) {
      // 新建字段配置
      fieldConfig = {
        field_name: activeField.column_name,
        field_display_name: activeField.column_name,
        description: activeField.description,
        code_values: []
      }
      ck.fields.push(fieldConfig)
    }

    // 添加选中的枚举值
    selectedValues.forEach((mapping) => {
      if (!fieldConfig.code_values.some((cv: any) => cv.code === mapping.code)) {
        fieldConfig.code_values.push({
          code: mapping.code,
          label: mapping.label
        })
      }
    })

    const addedCount = selectedValues.length
    onUpdateCodeKnowledge?.(ck)
    setSelectedValues([])
    notifications.show({
      color: 'green',
      message: t('business.enumSelector.addedValues', { count: addedCount })
    })
  }

  // 处理移除枚举值
  const handleRemoveValue = (fieldName: string, code: string) => {
    const ck = codeKnowledge
    if (!ck?.fields) return

    const fieldConfig = ck.fields.find((f: any) => f.field_name === fieldName)
    if (fieldConfig) {
      fieldConfig.code_values = fieldConfig.code_values.filter((cv: any) => cv.code !== code)

      // 如果该字段没有枚举值了，移除整个字段
      if (fieldConfig.code_values.length === 0) {
        ck.fields = ck.fields.filter((f: any) => f.field_name !== fieldName)
      }

      // 如果 fields 为空，设置为 null
      if (ck.fields.length === 0) {
        onUpdateCodeKnowledge?.(null)
      } else {
        onUpdateCodeKnowledge?.(ck)
      }
    }
  }

  // 处理移除字段的所有枚举值
  const handleRemoveField = (fieldName: string) => {
    const ck = codeKnowledge
    if (!ck?.fields) return

    ck.fields = ck.fields.filter((f: any) => f.field_name !== fieldName)

    // 如果 fields 为空，设置为 null
    if (ck.fields.length === 0) {
      onUpdateCodeKnowledge?.(null)
    } else {
      onUpdateCodeKnowledge?.(ck)
    }
  }

  // 处理清空全部
  const handleClearAll = () => {
    onUpdateCodeKnowledge?.(null)
  }

  // 从 codeKnowledge 同步 JSON 文本
  const syncJsonText = () => {
    setJsonText(codeKnowledge ? JSON.stringify(codeKnowledge, null, 2) : '')
  }

  // JSON 模式文本变化
  const onJsonChange = (value: string) => {
    setJsonText(value)
    setJsonError('')
    if (!value || value.trim() === '') {
      onUpdateCodeKnowledge?.(null)
      return
    }

    try {
      const parsed = JSON.parse(value)
      // 验证格式
      if (!parsed.fields || !Array.isArray(parsed.fields)) {
        setJsonError(t('business.enumSelector.jsonMustHaveFields'))
        return
      }
      onUpdateCodeKnowledge?.(parsed)
    } catch (e: any) {
      setJsonError(t('business.enumSelector.jsonFormatError') + ': ' + e.message)
    }
  }

  // 监听 codeKnowledge 变化，同步 JSON 文本
  useEffect(() => {
    if (editMode === 'json') {
      syncJsonText()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codeKnowledge])

  // 监听编辑模式切换
  useEffect(() => {
    if (editMode === 'json') {
      syncJsonText()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editMode])

  // 监听 enumFields 变化，自动选中第一个字段
  useEffect(() => {
    if (enumFields.length > 0 && !activeFieldKey) {
      setActiveFieldKey(enumFields[0].key)
    } else if (enumFields.length === 0) {
      setActiveFieldKey(null)
      setSelectedValues([])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enumFields])

  return (
    <div className={styles.enumValueSelector}>
      {/* 模式切换 */}
      <div className={styles.modeSwitchBar}>
        <SegmentedControl
          size="xs"
          value={editMode}
          onChange={(v) => setEditMode(v as 'selector' | 'json')}
          data={[
            { value: 'selector', label: t('business.enumSelector.selectorMode') },
            { value: 'json', label: t('business.enumSelector.jsonMode') }
          ]}
        />
      </div>

      {/* 选择器模式：三栏布局 */}
      {editMode === 'selector' ? (
        <div className={styles.selectorMode}>
          {/* 左侧和中间：字段和枚举值的联动选择区域 */}
          <div className={styles.enumSelectionPanel}>
            {/* 字段选择区 */}
            <div className={styles.fieldSelectArea}>
              <div className={styles.areaHeader}>
                <h4>
                  {t('business.enumSelector.configurableFields')} ({enumFields.length})
                </h4>
              </div>
              {enumFields.length > 0 ? (
                <div className={styles.fieldsListContainer}>
                  {enumFields.map((field) => (
                    <div
                      key={field.key}
                      className={`${styles.fieldListItem} ${
                        activeFieldKey === field.key ? styles.active : ''
                      }`}
                      onClick={() => handleFieldSelect(field)}
                    >
                      <span className={styles.fieldName}>{field.column_name}</span>
                      {field.description && (
                        <span className={styles.fieldDesc} title={field.description}>
                          {field.description}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className={styles.noFieldsHint}>
                  <div className={styles.emptyWrapper}>
                    <ElSvgIcon name="Box" />
                    <p className={styles.emptyDesc}>{t('business.enumSelector.noEnumFields')}</p>
                    <p className={styles.hintText}>{t('business.enumSelector.noEnumFieldsHint')}</p>
                  </div>
                </div>
              )}
            </div>

            {/* 枚举值选择区 */}
            <div className={styles.enumValueSelectArea}>
              {activeField ? (
                <>
                  <div className={styles.areaHeader}>
                    <h4>
                      {activeField.column_name} (
                      {t('business.enumSelector.valueCount', {
                        count: activeField.enum_mappings.length
                      })}
                      )
                    </h4>
                    <div className={styles.enumActions}>
                      <Checkbox
                        size="sm"
                        checked={isAllValuesSelected}
                        indeterminate={isSomeValuesSelected && !isAllValuesSelected}
                        onChange={(e) => handleToggleSelectAll(e.currentTarget.checked)}
                        label={t('business.enumSelector.selectAll')}
                      />
                      <Button
                        size="xs"
                        disabled={selectedValues.length === 0}
                        leftSection={<ElSvgIcon name="Plus" />}
                        onClick={handleAddSelectedValues}
                      >
                        {t('business.enumSelector.add')} ({selectedValues.length})
                      </Button>
                    </div>
                  </div>
                  <div className={styles.valuesCheckboxList}>
                    {activeField.enum_mappings.map((mapping: any) => (
                      <div
                        key={mapping.code}
                        className={`${styles.valueCheckboxItem} ${
                          isValueDisabled(mapping) ? styles.disabled : ''
                        }`}
                      >
                        <Checkbox
                          checked={isValueSelected(mapping)}
                          disabled={isValueDisabled(mapping)}
                          onChange={(e) => handleValueCheckChange(mapping, e.currentTarget.checked)}
                          label={
                            <div className={styles.valueInfo}>
                              <span className={styles.codeText}>{mapping.code}</span>
                              <span className={styles.labelText}>{mapping.label}</span>
                            </div>
                          }
                        />
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className={styles.noFieldSelectedHint}>
                  <div className={styles.emptyWrapper}>
                    <ElSvgIcon name="Box" />
                    <p className={styles.emptyDesc}>{t('business.enumSelector.selectFieldHint')}</p>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* 右侧：已选配置区域 */}
          <div className={styles.selectedConfigsPanel}>
            <div className={styles.areaHeader}>
              <h4>
                {t('business.enumSelector.selectedConfig')} ({configStats.fieldCount}{' '}
                {t('business.enumSelector.fields')} {configStats.valueCount}{' '}
                {t('business.enumSelector.values')})
              </h4>
              {configStats.fieldCount > 0 && (
                <Button variant="subtle" color="red" size="xs" onClick={handleClearAll}>
                  {t('business.enumSelector.clearAll')}
                </Button>
              )}
            </div>
            {groupedConfigs.length > 0 ? (
              <div className={styles.configsListContainer}>
                {groupedConfigs.map((fieldGroup: any) => (
                  <div key={fieldGroup.field_name} className={styles.configFieldGroup}>
                    <div className={styles.configGroupHeader}>
                      <div className={styles.groupTitle}>
                        <span className={styles.fieldTag}>{fieldGroup.field_name}</span>
                        {fieldGroup.description && (
                          <span className={styles.groupDesc}>{fieldGroup.description}</span>
                        )}
                        <span className={styles.groupCount}>
                          {t('business.enumSelector.valueCount', {
                            count: fieldGroup.code_values.length
                          })}
                        </span>
                      </div>
                      <Button
                        size="xs"
                        color="red"
                        variant="subtle"
                        onClick={() => handleRemoveField(fieldGroup.field_name)}
                      >
                        {t('business.enumSelector.removeAll')}
                      </Button>
                    </div>
                    <div className={styles.configValuesTags}>
                      {fieldGroup.code_values.map((cv: any) => (
                        <span key={cv.code} className={styles.valueTag}>
                          <span className={styles.tagCode}>{cv.code}</span>
                          <span className={styles.tagLabel}>{cv.label}</span>
                          <CloseButton
                            size="xs"
                            onClick={() => handleRemoveValue(fieldGroup.field_name, cv.code)}
                          />
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className={styles.noConfigsHint}>
                <div className={styles.emptyWrapper}>
                  <ElSvgIcon name="Box" />
                  <p className={styles.emptyDesc}>{t('business.enumSelector.noSelectedConfig')}</p>
                  <p className={styles.hintText}>
                    {t('business.enumSelector.noSelectedConfigHint')}
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* JSON模式 */
        <div className={styles.jsonMode}>
          <Textarea
            value={jsonText}
            minRows={15}
            autosize
            placeholder={t('business.enumSelector.jsonPlaceholder')}
            onChange={(e) => onJsonChange(e.currentTarget.value)}
          />
          {jsonError && (
            <div className={styles.jsonError}>
              <Alert color="red" withCloseButton={false}>
                {jsonError}
              </Alert>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
