import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Group, Textarea, TextInput } from '@mantine/core'
import { useForm } from '@mantine/form'
import { notifications } from '@mantine/notifications'
import { useProjectStore, projectGetters } from '@/store/project'
import { useResponsive } from '@/hooks/use-responsive'
import { createBusinessReq, updateBusinessReq } from '@/api/business'
import styles from './BusinessForm.module.scss'

interface BusinessFormProps {
  initialData?: Record<string, any>
  /** 保存成功，传递业务ID */
  onSaved?: (businessId: any) => void
  /** 取消操作 */
  onCancel?: () => void
}

export interface BusinessFormRef {
  resetForm: () => void
}

const BusinessForm = forwardRef<BusinessFormRef, BusinessFormProps>(function BusinessForm(props, ref) {
  const { initialData = {}, onSaved, onCancel } = props

  const { t } = useTranslation()
  const currentProjectId = useProjectStore((s) => projectGetters.currentProjectId(s))
  const { isMobile } = useResponsive()

  const [loading, setLoading] = useState(false)

  // 表单数据 + 验证规则（name 必填，长度 1-100）
  const form = useForm({
    initialValues: {
      name: '',
      description: ''
    },
    validate: {
      name: (value: string) => {
        if (!value) return t('business.rules.nameRequired')
        if (value.length < 1 || value.length > 100) return t('business.rules.nameLength')
        return null
      }
    }
  })

  // 是否为编辑模式
  const isEditMode = useMemo(() => {
    return !!(initialData && initialData.id)
  }, [initialData])

  // 监听初始数据变化，更新表单（对应 watch immediate + deep）
  useEffect(() => {
    if (initialData) {
      form.setValues({
        name: initialData.name || '',
        description: initialData.description || ''
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialData])

  // 提交表单
  const handleSubmit = async () => {
    const validation = form.validate()
    if (validation.hasErrors) return

    try {
      setLoading(true)

      const data = {
        name: form.values.name.trim(),
        description: form.values.description?.trim() || ''
      }

      let result: any
      if (isEditMode) {
        // 编辑模式
        result = await updateBusinessReq(currentProjectId, initialData.id, data)
        notifications.show({ color: 'green', message: t('business.message.saveSuccess') })
      } else {
        // 创建模式
        result = await createBusinessReq(currentProjectId, data)
        notifications.show({ color: 'green', message: t('business.message.createSuccess') })
      }

      // 触发保存事件，传递业务ID
      onSaved?.(result.data?.id || initialData.id)
    } catch (error: any) {
      console.error('保存业务失败:', error)
      notifications.show({
        color: 'red',
        message: error.response?.data?.message || t('business.message.saveFailed')
      })
    } finally {
      setLoading(false)
    }
  }

  // 取消操作
  const handleCancel = () => {
    onCancel?.()
  }

  // 重置表单
  const resetForm = () => {
    form.reset()
    form.setValues({ name: '', description: '' })
  }

  // 暴露给父组件（对应 defineExpose）
  useImperativeHandle(ref, () => ({
    resetForm
  }))

  return (
    <div className={styles.businessFormContainer}>
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault()
          handleSubmit()
        }}
      >
        <TextInput
          label={t('business.form.name')}
          placeholder={t('business.form.namePlaceholder')}
          maxLength={100}
          labelProps={{ style: { width: isMobile ? 'auto' : 100 } }}
          {...form.getInputProps('name')}
        />

        <Textarea
          mt="md"
          label={t('business.form.description')}
          placeholder={t('business.form.descriptionPlaceholder')}
          rows={4}
          maxLength={500}
          {...form.getInputProps('description')}
        />

        <Group className={styles.actions} mt="lg">
          <Button type="submit" color="primary" loading={loading}>
            {isEditMode ? t('business.save') : t('business.create')}
          </Button>
          <Button variant="default" onClick={handleCancel}>
            {t('common.cancel')}
          </Button>
        </Group>
      </form>
    </div>
  )
})

export default BusinessForm
