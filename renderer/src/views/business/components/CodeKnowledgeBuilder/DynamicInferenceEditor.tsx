import { useMemo } from 'react'
import { TextInput, Textarea, Text } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import ElSvgIcon from '@/components/ElSvgIcon'
import styles from './DynamicInferenceEditor.module.scss'

interface DynamicInferenceEditorProps {
  values?: any[]
  operator?: string | null
  description?: string
  fieldInfo?: Record<string, any>
  onUpdateValues?: (values: any[]) => void
  onUpdateDescription?: (description: string) => void
}

/**
 * 动态推断规则编辑器
 * 对应 Vue: DynamicInferenceEditor.vue
 */
export default function DynamicInferenceEditor({
  values = [],
  description = '',
  onUpdateValues,
  onUpdateDescription
}: DynamicInferenceEditorProps) {
  const { t } = useTranslation()

  // 规则名称（取 values[0]）
  const ruleName = useMemo(
    () => (values && values.length > 0 ? values[0] : ''),
    [values]
  )

  // 处理规则名称变化
  const handleRuleNameChange = (value: string) => {
    onUpdateValues?.(value ? [value] : [])
  }

  // 处理描述变化
  const handleDescriptionChange = (value: string) => {
    onUpdateDescription?.(value)
  }

  return (
    <div className={styles.dynamicInferenceEditor}>
      {/* 规则名称输入 */}
      <div className={styles.fieldSection}>
        <div className={styles.sectionLabel}>{t('business.codeKnowledge.ruleName')}</div>
        <TextInput
          value={ruleName}
          onChange={(e) => handleRuleNameChange(e.currentTarget.value)}
          placeholder={t('business.codeKnowledge.ruleNamePlaceholder')}
        />
      </div>

      {/* 说明信息 */}
      <div>
        <Text c="dimmed" size="sm" component="span" className={styles.hintSection}>
          <span className={styles.hintIcon}>
            <ElSvgIcon name="InfoFilled" size={14} />
          </span>
          {t('business.codeKnowledge.dynamicInferenceHint')}
        </Text>
      </div>

      {/* 条件说明 */}
      <div className={styles.descriptionSection}>
        <div className={styles.sectionLabel}>
          {t('business.codeKnowledge.conditionDescOptional')}
        </div>
        <Textarea
          value={description}
          onChange={(e) => handleDescriptionChange(e.currentTarget.value)}
          placeholder={t('business.codeKnowledge.dynamicInferenceDescPlaceholder')}
          rows={2}
        />
      </div>
    </div>
  )
}
