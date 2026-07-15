import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal, Button, Switch, TextInput, Group, Box, LoadingOverlay } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { getAlertSettingsReq, updateAlertSettingsReq } from '@/api/alertSettings'
import styles from './AlertSettingsDialog.module.scss'

interface AlertSettingsDialogProps {
  // defineModel({ type: Boolean }) → opened/onClose 受控
  opened: boolean
  onClose: () => void
}

interface AlertForm {
  enabled: boolean
  webhook: string
  keyword: string
}

export default function AlertSettingsDialog({ opened, onClose }: AlertSettingsDialogProps) {
  const { t } = useTranslation()

  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  // webhookTouched/webhookConfigured 不参与渲染，用 ref 保存避免闭包陷阱
  const webhookTouched = useRef(false)
  const webhookConfigured = useRef(false)

  const [form, setForm] = useState<AlertForm>({
    enabled: false,
    webhook: '',
    keyword: ''
  })

  const loadSettings = async () => {
    setLoading(true)
    webhookTouched.current = false
    try {
      const res: any = await getAlertSettingsReq()
      if (!res.success) return
      const data = res.data || {}
      webhookConfigured.current = !!data.webhook_configured
      setForm({
        enabled: !!data.enabled,
        keyword: data.keyword || '',
        webhook: data.webhook || ''
      })
    } catch (e) {
      notifications.show({ color: 'red', message: t('admin.logs.alertSettings.loadFailed') })
    } finally {
      setLoading(false)
    }
  }

  // @open="loadSettings" → Modal 打开时加载
  useEffect(() => {
    if (opened) {
      loadSettings()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened])

  const handleSave = async () => {
    if (form.enabled && !webhookConfigured.current && !form.webhook.trim()) {
      notifications.show({ color: 'yellow', message: t('admin.logs.alertSettings.webhookRequired') })
      return
    }

    setSaving(true)
    try {
      const payload: any = {
        enabled: form.enabled,
        keyword: form.keyword,
        keep_existing_webhook: webhookConfigured.current && !webhookTouched.current
      }
      if (webhookTouched.current) {
        payload.webhook = form.webhook
      }
      const res: any = await updateAlertSettingsReq(payload)
      if (res.success) {
        notifications.show({ color: 'green', message: t('admin.logs.alertSettings.saveSuccess') })
        onClose()
      }
    } catch (e) {
      notifications.show({ color: 'red', message: t('admin.logs.alertSettings.saveFailed') })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={t('admin.logs.alertSettings.title')}
      size="560px"
    >
      <Box pos="relative" className={styles.alertSettingsForm}>
        <LoadingOverlay visible={loading} />

        <Switch
          label={t('admin.logs.alertSettings.enabled')}
          checked={form.enabled}
          onChange={(e) => setForm((s) => ({ ...s, enabled: e.currentTarget.checked }))}
          mb="md"
        />

        {form.enabled && (
          <Box mb="md">
            <TextInput
              label={t('admin.logs.alertSettings.webhook')}
              placeholder={t('admin.logs.alertSettings.webhookPlaceholder')}
              value={form.webhook}
              onChange={(e) => {
                webhookTouched.current = true
                setForm((s) => ({ ...s, webhook: e.currentTarget.value }))
              }}
            />
            <div className={styles.fieldHint}>{t('admin.logs.alertSettings.webhookHint')}</div>
          </Box>
        )}

        {form.enabled && (
          <Box mb="md">
            <TextInput
              label={t('admin.logs.alertSettings.keyword')}
              placeholder={t('admin.logs.alertSettings.keywordPlaceholder')}
              value={form.keyword}
              onChange={(e) => setForm((s) => ({ ...s, keyword: e.currentTarget.value }))}
            />
            <div className={styles.fieldHint}>{t('admin.logs.alertSettings.keywordHint')}</div>
          </Box>
        )}
      </Box>

      <Group justify="flex-end" mt="lg">
        <Button variant="default" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button color="blue" loading={saving} onClick={handleSave}>
          {t('common.save')}
        </Button>
      </Group>
    </Modal>
  )
}
