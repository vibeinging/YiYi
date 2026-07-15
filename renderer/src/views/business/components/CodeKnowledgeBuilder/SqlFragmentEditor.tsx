import { useMemo } from 'react'
import { Text, Textarea, TextInput } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import styles from './SqlFragmentEditor.module.scss'

interface SqlFragmentEditorProps {
  values?: string[]
  description?: string
  fieldInfo?: Record<string, any>
  onUpdateValues?: (values: string[]) => void
  onUpdateDescription?: (description: string) => void
}

export default function SqlFragmentEditor({
  values = [],
  description = '',
  // fieldInfo 暂未在模板中使用,保留以对齐原组件 props 契约
  fieldInfo = {},
  onUpdateValues,
  onUpdateDescription,
}: SqlFragmentEditorProps) {
  const { t } = useTranslation()

  // SQL 值 (取第一个)
  const sqlValue = useMemo(
    () => (values && values.length > 0 ? values[0] : ''),
    [values],
  )

  // 处理SQL变化
  const handleSqlChange = (value: string) => {
    onUpdateValues?.(value ? [value] : [])
  }

  // 处理描述变化
  const handleDescriptionChange = (value: string) => {
    onUpdateDescription?.(value)
  }

  return (
    <div className={styles.sqlFragmentEditor}>
      <div className={styles.sqlInputSection}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionLabel}>
            {t('business.codeKnowledge.sqlExpression')}
          </span>
          <Text c="dimmed" size="sm">
            {t('business.codeKnowledge.sqlExpressionHint')}
          </Text>
        </div>
        <Textarea
          value={sqlValue}
          onChange={(e) => handleSqlChange(e.currentTarget.value)}
          rows={3}
          placeholder={t('business.codeKnowledge.sqlExpressionPlaceholder')}
        />
        <Text c="orange" size="sm" style={{ marginTop: 4, display: 'block' }}>
          {t('business.codeKnowledge.sqlWarning')}
        </Text>
      </div>

      {/* 描述输入 */}
      <div className={styles.descriptionSection}>
        <span className={styles.sectionLabel}>
          {t('business.codeKnowledge.conditionDescOptional')}
        </span>
        <TextInput
          value={description}
          onChange={(e) => handleDescriptionChange(e.currentTarget.value)}
          placeholder={t('business.codeKnowledge.sqlConditionDescPlaceholder')}
        />
      </div>
    </div>
  )
}
