import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Group,
  LoadingOverlay,
  Modal,
  NumberInput,
  Stack,
  Switch,
  Textarea,
  TextInput
} from '@mantine/core'
import { DateTimePicker } from '@mantine/dates'
import { useForm } from '@mantine/form'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import { IconCopy, IconPlus, IconTrash } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import dayjs from 'dayjs'
import ApiKeyEmptyState from './ApiKeyEmptyState'
import { copyToClipboard } from '@/utils/clipboard'
import {
  listApiKeys,
  createApiKey,
  updateApiKey,
  deleteApiKey,
  toggleApiKey,
  batchEnableKeys,
  batchDisableKeys
} from '@/api/business_api_key'
import styles from './ApiKeyManagement.module.scss'

// 对应 Vue defineProps
interface ApiKeyManagementProps {
  projectId: string
  businessId: string
}

export default function ApiKeyManagement({ projectId, businessId }: ApiKeyManagementProps) {
  const { t } = useTranslation()

  // 状态（ref → useState）
  const [loading, setLoading] = useState(false)
  const [saveLoading, setSaveLoading] = useState(false)
  const [keys, setKeys] = useState<any[]>([])
  const [dialogVisible, setDialogVisible] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [currentKey, setCurrentKey] = useState<any>(null)
  const [lastCreatedKeyId, setLastCreatedKeyId] = useState<any>(null)
  const [showCreatedKey, setShowCreatedKey] = useState(false)
  const [createdApiKey, setCreatedApiKey] = useState('')

  // reactive(formData) + rules → @mantine/form
  const form = useForm<{
    name: string
    description: string
    rate_limit: number
    valid_from: Date | null
    valid_until: Date | null
    is_active: boolean
  }>({
    initialValues: {
      name: '',
      description: '',
      rate_limit: 100,
      valid_from: null,
      valid_until: null,
      is_active: true
    },
    validate: {
      name: (value: string) => {
        if (!value) return t('project.apiKey.rules.nameRequired')
        if (value.length < 1 || value.length > 100) return t('project.apiKey.rules.nameLength')
        return null
      },
      rate_limit: (value) =>
        value === null || value === undefined
          ? t('project.apiKey.rules.rateLimitRequired')
          : null
    }
  })

  // 计算属性（computed → 派生常量）
  const hasKeys = useMemo(() => keys.length > 0, [keys])

  // 方法
  const formatTime = (time: any) => {
    return dayjs(time).format('YYYY-MM-DD HH:mm')
  }

  const loadKeys = async () => {
    if (!projectId || !businessId) {
      setKeys([])
      return
    }
    setLoading(true)
    try {
      const res: any = await listApiKeys(businessId, projectId)
      setKeys(res.data || [])
    } catch (error: any) {
      notifications.show({
        color: 'red',
        message: t('project.apiKey.loadKeysFailed') + ': ' + (error.message || '')
      })
    } finally {
      setLoading(false)
    }
  }

  const handleCreate = () => {
    setIsEditing(false)
    setCurrentKey(null)
    form.setValues({
      name: '',
      description: '',
      rate_limit: 100,
      valid_from: null,
      valid_until: null,
      is_active: true
    })
    form.clearErrors()
    setDialogVisible(true)
  }

  const handleEdit = (key: any) => {
    setIsEditing(true)
    setCurrentKey(key)
    form.setValues({
      name: key.name,
      description: key.description || '',
      rate_limit: key.rate_limit,
      valid_from: key.valid_from ? new Date(key.valid_from) : null,
      valid_until: key.valid_until ? new Date(key.valid_until) : null,
      is_active: true
    })
    form.clearErrors()
    setDialogVisible(true)
  }

  const handleSave = async () => {
    if (!projectId || !businessId) return
    const validation = form.validate()
    if (validation.hasErrors) return

    const formData = form.values
    setSaveLoading(true)
    try {
      if (isEditing) {
        await updateApiKey(businessId, currentKey.id, projectId, {
          name: formData.name,
          description: formData.description,
          rate_limit: formData.rate_limit,
          valid_from: formData.valid_from,
          valid_until: formData.valid_until
        })
        notifications.show({ color: 'green', message: t('project.apiKey.updateSuccess') })
        setDialogVisible(false)
        await loadKeys()
      } else {
        const res: any = await createApiKey(businessId, projectId, formData)
        setLastCreatedKeyId(res.data.id)
        setCreatedApiKey(res.data.api_key || '')
        setShowCreatedKey(true)
        notifications.show({ color: 'green', message: t('project.apiKey.createSuccessSaveKey') })
      }
    } catch (error: any) {
      notifications.show({
        color: 'red',
        message: t('project.apiKey.operationFailed') + ': ' + (error.message || '')
      })
    } finally {
      setSaveLoading(false)
    }
  }

  const handleCopyCreatedKey = async () => {
    const success = await copyToClipboard(createdApiKey)
    if (success) {
      notifications.show({ color: 'green', message: t('common.linkCopied') })
    } else {
      notifications.show({ color: 'red', message: t('common.copyFailed') })
    }
  }

  const handleConfirmCreatedKey = async () => {
    setShowCreatedKey(false)
    setCreatedApiKey('')
    setDialogVisible(false)
    await loadKeys()
  }

  const handleToggle = async (key: any) => {
    if (!projectId || !businessId) return
    try {
      await toggleApiKey(businessId, key.id, projectId, !key.is_active)
      notifications.show({
        color: 'green',
        message: key.is_active ? t('project.apiKey.disabled') : t('project.apiKey.enabled')
      })
      await loadKeys()
    } catch (error: any) {
      notifications.show({
        color: 'red',
        message: t('project.apiKey.operationFailed') + ': ' + (error.message || '')
      })
    }
  }

  const handleDelete = (key: any) => {
    if (!projectId || !businessId) return
    // ElMessageBox.confirm → modals.openConfirmModal
    modals.openConfirmModal({
      title: t('project.apiKey.deleteConfirm'),
      children: t('project.apiKey.deleteConfirmMsg', { name: key.name }),
      labels: { confirm: t('common.confirm'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await deleteApiKey(businessId, key.id, projectId)
          notifications.show({ color: 'green', message: t('project.apiKey.deleteSuccess') })
          await loadKeys()
        } catch (error: any) {
          notifications.show({
            color: 'red',
            message: t('project.apiKey.deleteFailed') + ': ' + (error.message || '')
          })
        }
      }
    })
  }

  const handleBatchEnable = async () => {
    if (!projectId || !businessId) return
    try {
      const res: any = await batchEnableKeys(businessId, projectId)
      notifications.show({
        color: 'green',
        message: res.data.message || t('project.apiKey.batchEnableSuccess')
      })
      await loadKeys()
    } catch (error: any) {
      notifications.show({
        color: 'red',
        message: t('project.apiKey.batchEnableFailed') + ': ' + (error.message || '')
      })
    }
  }

  const handleBatchDisable = () => {
    if (!projectId || !businessId) return
    // ElMessageBox.confirm → modals.openConfirmModal
    modals.openConfirmModal({
      title: t('common.warning'),
      children: t('project.apiKey.batchDisableConfirmMsg'),
      labels: { confirm: t('common.confirm'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          const res: any = await batchDisableKeys(businessId, projectId)
          notifications.show({
            color: 'green',
            message: res.data.message || t('project.apiKey.batchDisableSuccess')
          })
          await loadKeys()
        } catch (error: any) {
          notifications.show({
            color: 'red',
            message: t('project.apiKey.batchDisableFailed') + ': ' + (error.message || '')
          })
        }
      }
    })
  }

  // @close → 关闭对话框时重置创建密钥显示状态 + 表单
  const handleDialogClose = () => {
    setDialogVisible(false)
    form.reset()
    setShowCreatedKey(false)
    setCreatedApiKey('')
  }

  // 生命周期：onMounted
  useEffect(() => {
    loadKeys()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className={styles.apiKeyManagement}>
      {/* 操作栏 */}
      {hasKeys && (
        <div className={styles.actionBar}>
          <Button leftSection={<IconPlus size={16} />} onClick={handleCreate}>
            {t('project.apiKey.createKey')}
          </Button>
          <div className={styles.batchActions}>
            <Button variant="default" disabled={!hasKeys} onClick={handleBatchEnable}>
              {t('project.apiKey.batchEnable')}
            </Button>
            <Button variant="default" disabled={!hasKeys} onClick={handleBatchDisable}>
              {t('project.apiKey.batchDisable')}
            </Button>
          </div>
        </div>
      )}

      {/* 密钥列表 */}
      <Box className={styles.keysContainer}>
        <LoadingOverlay visible={loading} />

        {/* 空状态 */}
        {!loading && keys.length === 0 ? (
          <ApiKeyEmptyState onCreateKey={handleCreate} />
        ) : (
          /* 密钥卡片列表 */
          <div className={styles.keysList}>
            {keys.map((key) => (
              <Card key={key.id} className={styles.keyCard} shadow="sm" withBorder padding="lg">
                <div className={styles.keyHeader}>
                  <div className={styles.keyTitle}>
                    <h3>{key.name}</h3>
                    <Badge color={key.is_active ? 'green' : 'gray'} size="sm">
                      {key.is_active
                        ? t('project.apiKey.enabled')
                        : t('project.apiKey.disabled')}
                    </Badge>
                  </div>
                  <div className={styles.keyActions}>
                    <Button variant="subtle" size="compact-sm" onClick={() => handleEdit(key)}>
                      {t('common.edit')}
                    </Button>
                    <Button
                      variant="subtle"
                      size="compact-sm"
                      color={key.is_active ? 'yellow' : 'green'}
                      onClick={() => handleToggle(key)}
                    >
                      {key.is_active
                        ? t('project.apiKey.disable')
                        : t('project.apiKey.enable')}
                    </Button>
                    <Button
                      variant="subtle"
                      size="compact-sm"
                      color="red"
                      disabled={key.is_active}
                      onClick={() => handleDelete(key)}
                      className={styles.deleteBtn}
                    >
                      <IconTrash size={16} />
                    </Button>
                  </div>
                </div>

                <div className={styles.keyBody}>
                  {key.description && <p className={styles.keyDesc}>{key.description}</p>}

                  {/* API Key 显示 */}
                  <div className={styles.keyDisplay}>
                    <label>API Key:</label>
                    <div className={styles.keyValue}>
                      <span className={styles.keyText}>
                        {key.api_key || `${key.api_key_prefix}***`}
                      </span>
                    </div>
                    {key.api_key && key.id === lastCreatedKeyId && (
                      <Alert color="yellow" withCloseButton={false} className={styles.keyWarning}>
                        {t('project.apiKey.saveKeyWarning')}
                      </Alert>
                    )}
                  </div>

                  {/* 配置信息 */}
                  <div className={styles.keyInfo}>
                    <div className={styles.infoItem}>
                      <span className={styles.label}>{t('project.apiKey.rateLimit')}:</span>
                      <span className={styles.value}>
                        {t('project.apiKey.rateLimitValue', { count: key.rate_limit })}
                      </span>
                    </div>
                    <div className={styles.infoItem}>
                      <span className={styles.label}>{t('project.apiKey.totalRequests')}:</span>
                      <span className={styles.value}>
                        {key.total_requests || 0} {t('project.apiKey.times')}
                      </span>
                    </div>
                    <div className={styles.infoItem}>
                      <span className={styles.label}>{t('project.apiKey.lastRequest')}:</span>
                      <span className={styles.value}>
                        {key.last_request_at
                          ? formatTime(key.last_request_at)
                          : t('project.apiKey.none')}
                      </span>
                    </div>
                  </div>

                  {/* 生效时间 */}
                  {(key.valid_from || key.valid_until) && (
                    <div className={styles.keyValidity}>
                      <span className={styles.label}>
                        {t('project.apiKey.validityPeriod')}:
                      </span>
                      <span className={styles.value}>
                        {key.valid_from
                          ? formatTime(key.valid_from)
                          : t('project.apiKey.immediately')}
                        {' ~ '}
                        {key.valid_until
                          ? formatTime(key.valid_until)
                          : t('project.apiKey.permanent')}
                      </span>
                    </div>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </Box>

      {/* 创建/编辑对话框 */}
      <Modal
        opened={dialogVisible}
        onClose={handleDialogClose}
        title={isEditing ? t('project.apiKey.editKey') : t('project.apiKey.createKey')}
        size={showCreatedKey ? 700 : 600}
      >
        {showCreatedKey ? (
          /* 创建成功后的密钥显示 */
          <div className={styles.createdKeySection}>
            <Alert color="green" withCloseButton={false} className={styles.mb4}>
              <strong>{t('project.apiKey.keyCreatedSuccess')}</strong>
            </Alert>

            <Alert color="yellow" withCloseButton={false} className={styles.mb4}>
              <strong>{t('project.apiKey.importantNote')}</strong>
              {t('project.apiKey.saveKeyWarningFull')}
            </Alert>

            <Box mb="md">
              <Box component="label" mb={8} style={{ display: 'block', fontWeight: 500 }}>
                API Key
              </Box>
              <div className={styles.keyDisplayBox}>
                <div className={styles.keyInputWrapper}>
                  <Textarea
                    value={createdApiKey}
                    readOnly
                    rows={4}
                    className={styles.keyInput}
                  />
                  <Button
                    className={styles.copyBtn}
                    variant="default"
                    leftSection={<IconCopy size={16} />}
                    onClick={handleCopyCreatedKey}
                  >
                    {t('common.copy')}
                  </Button>
                </div>
              </div>
            </Box>
          </div>
        ) : (
          /* 创建/编辑表单 */
          <Stack gap="md">
            <TextInput
              label={t('project.apiKey.name')}
              placeholder={t('project.apiKey.namePlaceholder')}
              maxLength={100}
              withAsterisk
              {...form.getInputProps('name')}
            />

            <Textarea
              label={t('project.apiKey.description')}
              placeholder={t('project.apiKey.descriptionPlaceholder')}
              rows={3}
              maxLength={500}
              {...form.getInputProps('description')}
            />

            <div>
              <NumberInput
                label={t('project.apiKey.rateLimit')}
                min={1}
                max={10000}
                step={10}
                withAsterisk
                {...form.getInputProps('rate_limit')}
              />
              <span className={`${styles.formTip} ${styles.ml2}`}>
                {t('project.apiKey.requestsPerHour')}
              </span>
            </div>

            <DateTimePicker
              label={t('project.apiKey.validityTime')}
              placeholder={t('project.apiKey.startTimePlaceholder')}
              clearable
              style={{ width: '100%' }}
              {...form.getInputProps('valid_from')}
            />

            <DateTimePicker
              placeholder={t('project.apiKey.endTimePlaceholder')}
              clearable
              style={{ width: '100%' }}
              {...form.getInputProps('valid_until')}
            />

            {!isEditing && (
              <Switch
                label={t('project.apiKey.status')}
                onLabel={t('project.apiKey.enableNow')}
                offLabel={t('project.apiKey.disableForNow')}
                {...form.getInputProps('is_active', { type: 'checkbox' })}
              />
            )}
          </Stack>
        )}

        {/* footer */}
        <Group justify="flex-end" mt="lg">
          {showCreatedKey ? (
            <Button onClick={handleConfirmCreatedKey}>
              {t('project.apiKey.savedAndClose')}
            </Button>
          ) : (
            <>
              <Button variant="default" onClick={() => setDialogVisible(false)}>
                {t('common.cancel')}
              </Button>
              <Button loading={saveLoading} onClick={handleSave}>
                {isEditing ? t('common.save') : t('common.create')}
              </Button>
            </>
          )}
        </Group>
      </Modal>
    </div>
  )
}
