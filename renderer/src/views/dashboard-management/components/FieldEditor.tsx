// 字段编辑对话框：编辑指标/维度字段的别名
import { useEffect } from 'react'
import { Button, Group, Modal, TextInput } from '@mantine/core'
import { useForm } from '@mantine/form'
import { useTranslation } from 'react-i18next'
import styles from './FieldEditor.module.scss'

interface FieldEditorProps {
  visible?: boolean
  field?: Record<string, any>
  onUpdateVisible?: (value: boolean) => void
  onSave?: (field: Record<string, any>) => void
  onCancel?: () => void
}

export default function FieldEditor({
  visible = false,
  field = {},
  onUpdateVisible,
  onSave,
  onCancel,
}: FieldEditorProps) {
  const { t } = useTranslation()

  const form = useForm<Record<string, any>>({
    initialValues: {},
    validate: {
      alias: (value) => (value ? null : t('dashboardMgmt.fieldAliasRequired')),
    },
  })

  // 监听字段数据变化（对应 watch immediate）
  useEffect(() => {
    if (field) {
      form.setValues({ ...field })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field])

  // 额外监听 visible 属性，确保对话框打开时数据正确绑定
  useEffect(() => {
    if (visible && field) {
      form.setValues({ ...field })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  // 关闭对话框
  const handleClose = () => {
    onUpdateVisible?.(false)
    onCancel?.()
  }

  // 保存字段
  const handleSave = () => {
    const { hasErrors } = form.validate()
    if (hasErrors) {
      console.error('表单验证失败:', form.errors)
      return
    }
    onSave?.({ ...form.values })
    onUpdateVisible?.(false)
  }

  return (
    <Modal
      opened={visible}
      onClose={handleClose}
      title={t('dashboardMgmt.editField')}
      size="500px"
    >
      <TextInput
        label={t('dashboardMgmt.fieldAlias')}
        placeholder={t('dashboardMgmt.fieldAliasPlaceholder')}
        withAsterisk
        mb="md"
        {...form.getInputProps('alias')}
      />

      <TextInput
        label={t('dashboardMgmt.fieldName')}
        placeholder={t('dashboardMgmt.fieldName')}
        disabled
        {...form.getInputProps('expression')}
      />

      <Group className={styles.dialogFooter} mt="lg">
        <Button variant="default" onClick={handleClose}>
          {t('common.cancel')}
        </Button>
        <Button onClick={handleSave}>{t('common.confirm')}</Button>
      </Group>
    </Modal>
  )
}
