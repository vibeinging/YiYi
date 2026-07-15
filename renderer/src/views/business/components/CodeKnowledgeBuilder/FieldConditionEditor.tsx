import { useMemo } from 'react'
import { Button, Checkbox, Text, Textarea, TextInput } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import styles from './FieldConditionEditor.module.scss'

interface EnumMapping {
  code: string
  label: string
  [key: string]: any
}

interface FieldConditionEditorProps {
  values?: string[]
  description?: string
  fieldInfo?: Record<string, any>
  enumMappings?: EnumMapping[]
  // defineEmits(['update:values', 'update:description']) → 回调 props
  onUpdateValues?: (values: string[]) => void
  onUpdateDescription?: (description: string) => void
}

export default function FieldConditionEditor(props: FieldConditionEditorProps) {
  const {
    values = [],
    description = '',
    enumMappings = [],
    onUpdateValues,
    onUpdateDescription,
  } = props
  const { t } = useTranslation()

  // 是否有枚举映射
  const hasEnumMappings = useMemo(() => {
    return !!(enumMappings && enumMappings.length > 0)
  }, [enumMappings])

  // values 数组
  const valuesArray = values || []

  // 手动输入文本
  const manualInputText = useMemo(() => {
    return valuesArray.join('\n')
  }, [valuesArray])

  // 判断枚举值是否已选
  const isValueSelected = (code: string) => {
    return valuesArray.includes(code)
  }

  // 处理枚举值复选框变化
  const handleValueCheckChange = (mapping: EnumMapping, checked: boolean) => {
    const newValues = [...valuesArray]
    const code = mapping.code

    if (checked) {
      // 添加
      if (!newValues.includes(code)) {
        newValues.push(code)
      }
    } else {
      // 移除
      const index = newValues.indexOf(code)
      if (index > -1) {
        newValues.splice(index, 1)
      }
    }

    onUpdateValues?.(newValues)
  }

  // 处理手动输入变化
  const handleManualInputChange = (value: string) => {
    // 按行分割，过滤空行
    const lines = value
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)

    onUpdateValues?.(lines)
  }

  // 全选枚举值
  const handleSelectAll = () => {
    const allCodes = enumMappings.map((m) => m.code)
    onUpdateValues?.(allCodes)
  }

  // 清空枚举值
  const handleClearAll = () => {
    onUpdateValues?.([])
  }

  // 处理描述变化
  const handleDescriptionChange = (value: string) => {
    onUpdateDescription?.(value)
  }

  return (
    <div className={styles.fieldConditionEditor}>
      {/* 如果有枚举值，显示枚举值选择器 */}
      {hasEnumMappings && (
        <div className={styles.enumSection}>
          <div className={styles.sectionHeader}>
            <span className={styles.sectionLabel}>
              {t('business.codeKnowledge.enumValueSelect')}
            </span>
            <Button size="xs" variant="default" onClick={handleSelectAll}>
              {t('business.codeKnowledge.selectAll')}
            </Button>
            <Button size="xs" variant="default" onClick={handleClearAll}>
              {t('business.codeKnowledge.clear')}
            </Button>
          </div>
          <div className={styles.enumValuesList}>
            {enumMappings.map((mapping) => (
              <div key={mapping.code} className={styles.enumValueItem}>
                <Checkbox
                  checked={isValueSelected(mapping.code)}
                  onChange={(event) =>
                    handleValueCheckChange(mapping, event.currentTarget.checked)
                  }
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
        </div>
      )}

      {/* 手动输入区域 */}
      <div className={styles.manualInputSection}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionLabel}>
            {hasEnumMappings
              ? t('business.codeKnowledge.orManualInput')
              : t('business.codeKnowledge.inputValues')}
          </span>
          <Text c="dimmed" size="sm">
            {t('business.codeKnowledge.valuesEntered', { count: valuesArray.length })}
          </Text>
        </div>
        <Textarea
          value={manualInputText}
          onChange={(event) => handleManualInputChange(event.currentTarget.value)}
          rows={4}
          placeholder={t('business.codeKnowledge.inputValuesPlaceholder')}
        />
      </div>

      {/* 描述输入 */}
      <div className={styles.descriptionSection}>
        <span className={styles.sectionLabel}>
          {t('business.codeKnowledge.conditionDescOptional')}
        </span>
        <TextInput
          value={description}
          onChange={(event) => handleDescriptionChange(event.currentTarget.value)}
          placeholder={t('business.codeKnowledge.conditionDescPlaceholder')}
        />
      </div>
    </div>
  )
}
