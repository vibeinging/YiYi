// 源：views/project/settings/components/McpProviderDetail.vue
// MCP Provider 详情 / 设置页：基本信息 tab(只读展示启动命令、环境变量、错误、元信息) +
// 设置 tab(编辑命令/参数/环境变量、保存、删除) + 头部启用开关 + 测试连接对话框。
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ActionIcon,
  Badge,
  Button,
  Modal,
  PasswordInput,
  Skeleton,
  Switch,
  Tabs,
  TextInput
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import ElSvgIcon from '@/components/ElSvgIcon'
import {
  bindProjectMcpProviderReq,
  deleteAppMcpProviderReq,
  deleteProjectMcpBindingReq,
  listAppMcpProvidersReq,
  listMcpProvidersReq,
  testAppMcpProviderReq,
  toggleAppMcpProviderReq,
  updateAppMcpProviderReq
} from '@/api/mcp'
import styles from './McpProviderDetail.module.scss'

const SECRET_PATTERN = /TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL/i
const SECRET_FLAG_PATTERN = /^-{1,2}(token|api[-_]?key|key|secret|password|passwd|pat|pwd|auth)$/i
const SECRET_VALUE_PATTERN = /^(sk-|ak_|ghp_|gho_|ghu_|ghs_|ghr_|pat_|github_pat_|xoxb-|xoxp-|Bearer\s)/i
const HEX_TOKEN_PATTERN = /^[a-f0-9]{32,}$/i

// defineProps + defineEmits(['back', 'updated'])
export interface McpProviderDetailProps {
  projectId: string
  scope?: 'app' | 'project'
  itemId: string
  onBack?: () => void
  onUpdated?: (data: any) => void
}

interface ArgPair {
  flag: string
  value: string
}

interface EnvRow {
  key: string
  value: string
}

const isSecretKey = (key: string) => SECRET_PATTERN.test(key || '')

const isSecretPair = (pair: ArgPair) => {
  if (!pair?.value) return false
  if (pair.flag && SECRET_FLAG_PATTERN.test(pair.flag)) return true
  if (SECRET_VALUE_PATTERN.test(pair.value)) return true
  if (HEX_TOKEN_PATTERN.test(pair.value)) return true
  return false
}

// Heuristic: pair consecutive `-flag value` sequences from a flat args array
const pairArgs = (flat: any): ArgPair[] => {
  if (!Array.isArray(flat)) return [{ flag: '', value: '' }]
  const pairs: ArgPair[] = []
  let i = 0
  while (i < flat.length) {
    const cur = flat[i]
    const next = flat[i + 1]
    if (typeof cur === 'string' && cur.startsWith('-')) {
      if (next !== undefined && typeof next === 'string' && !next.startsWith('-')) {
        pairs.push({ flag: cur, value: next })
        i += 2
      } else {
        pairs.push({ flag: cur, value: '' })
        i += 1
      }
    } else {
      pairs.push({ flag: '', value: cur })
      i += 1
    }
  }
  return pairs.length > 0 ? pairs : [{ flag: '', value: '' }]
}

const flattenArgPairs = (pairs: ArgPair[]) => {
  const out: string[] = []
  for (const p of pairs || []) {
    if (p.flag) out.push(p.flag)
    if (p.value) out.push(p.value)
  }
  return out
}

const maskValue = (val: string) => {
  if (!val) return '-'
  if (val.length <= 4) return '*'.repeat(val.length)
  return val.substring(0, 2) + '*'.repeat(val.length - 4) + val.substring(val.length - 2)
}

const envEntries = (env: any): [string, any][] => {
  if (!env || typeof env !== 'object') return []
  return Object.entries(env)
}

const buildEnvObject = (rows: EnvRow[]) => {
  const env: Record<string, any> = {}
  rows.forEach(({ key, value }) => {
    if (key && key.trim()) {
      env[key.trim()] = value
    }
  })
  return env
}

export default function McpProviderDetail({
  projectId,
  scope = 'project',
  itemId,
  onBack,
  onUpdated
}: McpProviderDetailProps) {
  const { t, i18n } = useTranslation()
  const isAppScope = scope === 'app'

  const [activeTab, setActiveTab] = useState<string | null>('info')
  const [testing, setTesting] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [provider, setProvider] = useState<any>(null)
  const [testResultVisible, setTestResultVisible] = useState(false)
  const [testResult, setTestResult] = useState<any>(null)

  // Info tab: per-key secret visibility
  const [secretShown, setSecretShown] = useState<Record<string, boolean>>({})

  // Settings form（对应 reactive form）
  const [command, setCommand] = useState('')
  const [argPairs, setArgPairs] = useState<ArgPair[]>([{ flag: '', value: '' }])
  const [envRows, setEnvRows] = useState<EnvRow[]>([])
  const [isEnabled, setIsEnabled] = useState(true)
  const [transport, setTransport] = useState('stdio')
  const [commandError, setCommandError] = useState<string | null>(null)

  // Per-row secret visibility trackers
  const [formSecretVisible, setFormSecretVisible] = useState<Record<number, boolean>>({})
  const [argSecretVisible, setArgSecretVisible] = useState<Record<number, boolean>>({})

  const providerArgPairs = useMemo(() => pairArgs(provider?.args || []), [provider])

  const formatDateTime = (dateStr: any) => {
    if (!dateStr) return '-'
    const date = new Date(dateStr)
    return date.toLocaleString(i18n.language === 'zh' ? 'zh-CN' : 'en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  // ---- args / env 编辑器操作 ----
  const addArgPair = () => setArgPairs((prev) => [...prev, { flag: '', value: '' }])
  const removeArgPair = (i: number) => {
    setArgPairs((prev) => prev.filter((_, idx) => idx !== i))
    setArgSecretVisible((prev) => {
      const next = { ...prev }
      delete next[i]
      return next
    })
  }
  const updateArgPair = (i: number, field: keyof ArgPair, val: string) => {
    setArgPairs((prev) => prev.map((p, idx) => (idx === i ? { ...p, [field]: val } : p)))
  }

  const addEnvRow = () => setEnvRows((prev) => [...prev, { key: '', value: '' }])
  const removeEnvRow = (index: number) => {
    setEnvRows((prev) => prev.filter((_, idx) => idx !== index))
    setFormSecretVisible((prev) => {
      const next = { ...prev }
      delete next[index]
      return next
    })
  }
  const updateEnvRow = (i: number, field: keyof EnvRow, val: string) => {
    setEnvRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, [field]: val } : r)))
  }

  const populateForm = (p: any) => {
    setTransport(p.transport || 'stdio')
    setCommand(p.command || '')
    setArgPairs(pairArgs(p.args || []))
    setIsEnabled(!!(p.effective_enabled ?? p.is_enabled))
    setEnvRows(envEntries(p.env).map(([key, value]) => ({ key, value })))
    setFormSecretVisible({})
    setArgSecretVisible({})
    setCommandError(null)
  }

  const loadProvider = async () => {
    if ((!isAppScope && !projectId) || !itemId) return
    try {
      const res: any = isAppScope ? await listAppMcpProvidersReq() : await listMcpProvidersReq(projectId)
      if (res.success) {
        const found = (res.data || []).find((p: any) => String(p.id) === String(itemId) || String(p.provider_name) === String(itemId))
        setProvider(found || null)
        if (found) {
          populateForm(found)
        }
      }
    } catch (err) {
      console.error('loadProvider error:', err)
    }
  }

  // onMounted + watch(() => props.itemId)
  useEffect(() => {
    if (itemId) loadProvider()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId])

  const handleSubmit = async () => {
    if (!isAppScope || !provider) return
    // el-form rules: command required
    if (!command || !command.trim()) {
      setCommandError(t('mcpProvider.form.commandPlaceholder'))
      return
    }
    setCommandError(null)
    setSubmitting(true)
    try {
      const payload = {
        command,
        args: flattenArgPairs(argPairs),
        env: buildEnvObject(envRows),
        transport,
        is_enabled: isEnabled
      }
      const res: any = await updateAppMcpProviderReq(provider.provider_name, payload)
      if (res.success) {
        notifications.show({ color: 'green', message: t('mcpProvider.messages.updateSuccess') })
        setProvider((prev: any) => res.data || prev)
        onUpdated?.(res.data)
      } else {
        notifications.show({ color: 'red', message: res.msg || '保存失败' })
      }
    } catch (err) {
      console.error('update error:', err)
      notifications.show({ color: 'red', message: '保存失败' })
    } finally {
      setSubmitting(false)
    }
  }

  const handleTestConnection = async () => {
    setTesting(true)
    try {
      const payload = {
        provider_name: provider?.provider_name,
        command,
        args: flattenArgPairs(argPairs),
        env: buildEnvObject(envRows),
        transport
      }
      const res: any = await testAppMcpProviderReq(payload)
      setTestResult(res.data || res)
      setTestResultVisible(true)
      if (!res.data?.ok && !res.ok) {
        notifications.show({ color: 'yellow', message: t('mcpProvider.messages.testFail') })
      }
    } catch (err: any) {
      console.error('test error:', err)
      const resp = err?.response?.data
      let msg
      if (resp?.errors && Array.isArray(resp.errors) && resp.errors.length) {
        msg = `${resp.message || 'Validation failed'}\n\n` + resp.errors.join('\n')
      } else if (resp?.message) {
        msg = resp.message
      } else {
        msg = String(err)
      }
      setTestResult({ ok: false, error: msg })
      setTestResultVisible(true)
    } finally {
      setTesting(false)
    }
  }

  const handleToggleEnabled = async (val: boolean) => {
    // 乐观更新 switch（对应 v-model）
    setIsEnabled(val)
    try {
      const res: any = isAppScope
        ? await toggleAppMcpProviderReq(provider.provider_name, { default_enabled: val })
        : await bindProjectMcpProviderReq(projectId, provider.provider_name, { enabled_override: val })
      if (res.success) {
        setProvider((prev: any) =>
          prev
            ? {
                ...prev,
                is_enabled: val,
                effective_enabled: val,
                default_enabled: isAppScope ? val : prev.default_enabled,
                enabled_override: isAppScope ? prev.enabled_override : val
              }
            : prev
        )
        onUpdated?.(res.data)
        notifications.show({
          color: 'green',
          message: val ? t('mcpProvider.detail.enabled') : t('mcpProvider.detail.disabled')
        })
      } else {
        setIsEnabled(!val)
        notifications.show({ color: 'red', message: res.msg || t('mcpProvider.messages.testFail') })
      }
    } catch (err) {
      setIsEnabled(!val)
      notifications.show({ color: 'red', message: String(err) })
    }
  }

  const handleDelete = () => {
    // ElMessageBox.confirm → modals.openConfirmModal
    const isProjectReset = !isAppScope
    modals.openConfirmModal({
      title: isProjectReset ? '恢复 App 默认' : t('mcpProvider.list.deleteConfirm.title'),
      children: isProjectReset ? `清除「${provider?.provider_name || ''}」在当前项目的启用覆盖。` : t('mcpProvider.list.deleteConfirm.message'),
      labels: {
        confirm: isProjectReset ? '恢复继承' : t('mcpProvider.list.deleteConfirm.ok'),
        cancel: t('mcpProvider.list.deleteConfirm.cancel')
      },
      confirmProps: { color: isProjectReset ? 'blue' : 'red' },
      onConfirm: async () => {
        try {
          const res: any = isAppScope
            ? await deleteAppMcpProviderReq(provider.provider_name)
            : await deleteProjectMcpBindingReq(projectId, provider.provider_name)
          if (res.success || res.data?.deleted || res.data) {
            notifications.show({ color: 'green', message: isProjectReset ? '已恢复 App 默认' : t('mcpProvider.messages.deleteSuccess') })
            onUpdated?.(null)
            if (isAppScope) onBack?.()
            else {
              await loadProvider()
              onUpdated?.(res.data)
            }
          } else {
            notifications.show({ color: 'red', message: res.msg || '删除失败' })
          }
        } catch (err) {
          console.error('delete error:', err)
        }
      }
    })
  }

  return (
    <div className={styles['ad-detail-page']}>
      {/* 返回按钮 */}
      <div className={styles['ad-detail-page-header']}>
        <ActionIcon variant="subtle" color="gray" onClick={() => onBack?.()}>
          <ElSvgIcon name="ArrowLeft" size={16} />
        </ActionIcon>
        <span className={styles['header-title']}>{provider?.provider_name || '-'}</span>
        <Badge size="sm" color="gray" variant="light">
          {provider?.transport || 'stdio'}
        </Badge>
        {provider && (
          <span className={styles['header-status']}>
            <Switch
              checked={isEnabled}
              onChange={(e) => handleToggleEnabled(e.currentTarget.checked)}
              size="md"
              onLabel={t('mcpProvider.detail.enabled')}
              offLabel={t('mcpProvider.detail.disabled')}
            />
          </span>
        )}
        <div className={styles['header-actions']}>
          {!isAppScope && provider?.binding && (
            <Button
              variant="default"
              onClick={handleDelete}
            >
              恢复继承
            </Button>
          )}
          <Button
            variant="default"
            onClick={handleTestConnection}
            loading={testing}
            leftSection={<ElSvgIcon name="Connection" size={14} />}
          >
            {testing ? t('mcpProvider.detail.testing') : t('mcpProvider.detail.testConnection')}
          </Button>
        </div>
      </div>

      <div className={styles['ad-detail-page-content']}>
        <Tabs value={activeTab} onChange={setActiveTab} className={styles['ad-detail-tabs']}>
          <Tabs.List>
            {/* 基本信息 */}
            <Tabs.Tab
              value="info"
              leftSection={<ElSvgIcon name="InfoFilled" size={14} />}
            >
              {t('mcpProvider.detail.tabs.info')}
            </Tabs.Tab>
            {/* 设置 */}
            {isAppScope && (
              <Tabs.Tab
                value="settings"
                leftSection={<ElSvgIcon name="Setting" size={14} />}
              >
                {t('mcpProvider.detail.tabs.settings')}
              </Tabs.Tab>
            )}
          </Tabs.List>

          {/* 基本信息 panel */}
          <Tabs.Panel value="info">
            <div className={styles['info-section']}>
              {provider ? (
                <>
                  {/* 主角：启动命令 + 参数 */}
                  <div className={styles['info-hero']}>
                    <div className={styles['info-hero__label']}>
                      {t('mcpProvider.detail.sections.launch')}
                    </div>
                    <pre className={styles['info-hero__command']}>
                      <span className={styles.cmd}>{provider.command}</span>
                      {providerArgPairs.map((pair, i) => (
                        <span key={i} className={styles.arg}>
                          {pair.flag ? (
                            <>
                              {' '}
                              <span className={styles['arg-flag']}>{pair.flag}</span>
                            </>
                          ) : null}
                          {pair.value ? (
                            <>
                              {' '}
                              <span
                                className={`${styles['arg-val']} ${
                                  isSecretPair(pair) ? styles['is-masked'] : ''
                                }`}
                              >
                                {isSecretPair(pair) ? maskValue(pair.value) : pair.value}
                              </span>
                            </>
                          ) : null}
                        </span>
                      ))}
                    </pre>
                  </div>

                  {/* 次级：环境变量 */}
                  <div className={styles['info-block']}>
                    <div className={styles['info-block__label']}>
                      {t('mcpProvider.form.env')}
                      {envEntries(provider.env).length > 0 && (
                        <span className={styles['info-block__count']}>
                          {' '}
                          · {envEntries(provider.env).length}
                        </span>
                      )}
                    </div>
                    {envEntries(provider.env).length > 0 ? (
                      <div className={styles['env-desc-list']}>
                        {envEntries(provider.env).map(([k, v]) => (
                          <div key={k} className={styles['env-desc-row']}>
                            <span className={styles['env-desc-key']}>{k}</span>
                            <span className={styles['env-desc-sep']}>=</span>
                            {isSecretKey(k) ? (
                              <span
                                className={`${styles['env-desc-value']} ${styles['mono-text']}`}
                              >
                                {secretShown[k] ? v : maskValue(v)}
                                <Button
                                  variant="subtle"
                                  size="compact-xs"
                                  onClick={() =>
                                    setSecretShown((prev) => ({ ...prev, [k]: !prev[k] }))
                                  }
                                  style={{ marginLeft: 6 }}
                                >
                                  {secretShown[k]
                                    ? t('mcpProvider.form.hide')
                                    : t('mcpProvider.form.show')}
                                </Button>
                              </span>
                            ) : (
                              <span
                                className={`${styles['env-desc-value']} ${styles['mono-text']}`}
                              >
                                {v}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className={styles['info-block__empty']}>
                        {t('mcpProvider.detail.noEnv')}
                      </div>
                    )}
                  </div>

                  {/* 错误（只在有问题时醒目） */}
                  {provider.last_error && (
                    <div className={styles['info-alert']}>
                      <span className={styles['info-alert__icon']}>
                        <ElSvgIcon name="WarningFilled" size={18} color="#f56c6c" />
                      </span>
                      <div className={styles['info-alert__body']}>
                        <div className={styles['info-alert__title']}>
                          {t('mcpProvider.detail.lastErrorTitle')}
                        </div>
                        <pre className={styles['info-alert__detail']}>{provider.last_error}</pre>
                      </div>
                    </div>
                  )}

                  {/* 元信息：最小权重，muted */}
                  <div className={styles['info-meta']}>
                    <span className={styles['info-meta__item']}>
                      <span className={styles['info-meta__label']}>
                        {t('mcpProvider.list.columns.lastDiscovered')}
                      </span>
                      <span className={styles['info-meta__value']}>
                        {formatDateTime(provider.last_discovered_at)}
                      </span>
                    </span>
                    <span className={styles['info-meta__item']}>
                      <span className={styles['info-meta__label']}>
                        {t('mcpProvider.detail.createdAt')}
                      </span>
                      <span className={styles['info-meta__value']}>
                        {formatDateTime(provider.created_at)}
                      </span>
                    </span>
                    <span className={styles['info-meta__item']}>
                      <span className={styles['info-meta__label']}>
                        {t('mcpProvider.detail.updatedAt')}
                      </span>
                      <span className={styles['info-meta__value']}>
                        {formatDateTime(provider.updated_at)}
                      </span>
                    </span>
                  </div>
                </>
              ) : (
                <div>
                  {[...Array(6)].map((_, i) => (
                    <Skeleton key={i} height={16} mb={10} radius="sm" animate />
                  ))}
                </div>
              )}
            </div>
          </Tabs.Panel>

          {/* 设置 panel */}
          {isAppScope && (
          <Tabs.Panel value="settings">
            <div className={styles['settings-section']}>
              <form
                className={`${styles['settings-form']} ${styles['mcp-settings-form']}`}
                onSubmit={(e) => {
                  e.preventDefault()
                  handleSubmit()
                }}
              >
                {/* Section: 启动 */}
                <div className={styles['form-section']}>
                  <h4 className={styles['form-section-title']}>
                    {t('mcpProvider.detail.sections.launch')}
                  </h4>

                  <TextInput
                    label={t('mcpProvider.form.command')}
                    placeholder={t('mcpProvider.form.commandPlaceholder')}
                    value={command}
                    error={commandError}
                    onChange={(e) => {
                      setCommand(e.currentTarget.value)
                      if (commandError) setCommandError(null)
                    }}
                  />
                  <div className={styles['field-hint']}>
                    {t('mcpProvider.wizard.step1.commandHint')}
                  </div>

                  <div style={{ marginTop: 20 }}>
                    <div className={styles['form-section-title']} style={{ textTransform: 'none' }}>
                      {t('mcpProvider.form.args')}
                    </div>
                    <div className={styles['args-editor']}>
                      {argPairs.length > 0 && (
                        <div className={styles['args-editor-head']}>
                          <span>{t('mcpProvider.wizard.step1.argFlagLabel')}</span>
                          <span>{t('mcpProvider.wizard.step1.argValueLabel')}</span>
                          <span></span>
                        </div>
                      )}
                      {argPairs.map((pair, index) => {
                        const secret = isSecretPair(pair)
                        return (
                          <div key={index} className={styles['args-editor-row']}>
                            <TextInput
                              placeholder={t('mcpProvider.wizard.step1.argFlagPlaceholder')}
                              value={pair.flag}
                              onChange={(e) =>
                                updateArgPair(index, 'flag', e.currentTarget.value)
                              }
                            />
                            {secret ? (
                              <PasswordInput
                                placeholder={t('mcpProvider.wizard.step1.argValuePlaceholder')}
                                value={pair.value}
                                visible={!!argSecretVisible[index]}
                                onVisibilityChange={(v) =>
                                  setArgSecretVisible((prev) => ({ ...prev, [index]: v }))
                                }
                                onChange={(e) =>
                                  updateArgPair(index, 'value', e.currentTarget.value)
                                }
                              />
                            ) : (
                              <TextInput
                                placeholder={t('mcpProvider.wizard.step1.argValuePlaceholder')}
                                value={pair.value}
                                onChange={(e) =>
                                  updateArgPair(index, 'value', e.currentTarget.value)
                                }
                              />
                            )}
                            <ActionIcon
                              variant="subtle"
                              color="red"
                              onClick={() => removeArgPair(index)}
                            >
                              <ElSvgIcon name="Delete" size={16} />
                            </ActionIcon>
                          </div>
                        )
                      })}
                      <Button
                        variant="subtle"
                        className={styles['btn-add-row']}
                        leftSection={<ElSvgIcon name="Plus" size={14} />}
                        onClick={addArgPair}
                      >
                        {t('mcpProvider.wizard.step1.argsAddRow')}
                      </Button>
                    </div>
                    <div className={styles['field-hint']}>
                      {t('mcpProvider.wizard.step1.argsHint')}
                    </div>
                  </div>
                </div>

                {/* Section: 环境变量 */}
                <div className={styles['form-section']}>
                  <h4 className={styles['form-section-title']}>
                    {t('mcpProvider.detail.sections.env')}
                  </h4>

                  <div className={styles['env-editor']}>
                    {envRows.length > 0 && (
                      <div className={styles['env-editor-head']}>
                        <span>{t('mcpProvider.wizard.step2.key')}</span>
                        <span>{t('mcpProvider.wizard.step2.value')}</span>
                        <span></span>
                      </div>
                    )}
                    {envRows.map((row, index) => {
                      const secret = isSecretKey(row.key)
                      return (
                        <div key={index} className={styles['env-editor-row']}>
                          <TextInput
                            placeholder={t('mcpProvider.form.envKeyPlaceholder')}
                            value={row.key}
                            onChange={(e) => updateEnvRow(index, 'key', e.currentTarget.value)}
                          />
                          {secret ? (
                            <PasswordInput
                              placeholder={t('mcpProvider.form.envValuePlaceholder')}
                              value={row.value}
                              visible={!!formSecretVisible[index]}
                              onVisibilityChange={(v) =>
                                setFormSecretVisible((prev) => ({ ...prev, [index]: v }))
                              }
                              onChange={(e) => updateEnvRow(index, 'value', e.currentTarget.value)}
                            />
                          ) : (
                            <TextInput
                              placeholder={t('mcpProvider.form.envValuePlaceholder')}
                              value={row.value}
                              onChange={(e) => updateEnvRow(index, 'value', e.currentTarget.value)}
                            />
                          )}
                          <ActionIcon
                            variant="subtle"
                            color="red"
                            onClick={() => removeEnvRow(index)}
                          >
                            <ElSvgIcon name="Delete" size={16} />
                          </ActionIcon>
                        </div>
                      )
                    })}
                    <Button
                      variant="subtle"
                      className={styles['btn-add-row']}
                      leftSection={<ElSvgIcon name="Plus" size={14} />}
                      onClick={addEnvRow}
                    >
                      {t('mcpProvider.wizard.step2.addRow')}
                    </Button>
                  </div>
                  <div className={styles['field-hint']}>{t('mcpProvider.wizard.step2.desc')}</div>
                </div>

                {/* Footer actions */}
                <div className={styles['form-footer']}>
                  <Button type="submit" loading={submitting}>
                    {t('mcpProvider.detail.save')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    color="red"
                    onClick={handleDelete}
                    leftSection={<ElSvgIcon name="Delete" size={14} />}
                  >
                    {t('mcpProvider.list.actions.delete')}
                  </Button>
                </div>
              </form>
            </div>
          </Tabs.Panel>
          )}
        </Tabs>
      </div>

      {/* 测试结果对话框 */}
      <Modal
        opened={testResultVisible}
        onClose={() => setTestResultVisible(false)}
        title={
          testResult?.ok
            ? t('mcpProvider.detail.testResult.successTitle')
            : t('mcpProvider.detail.testResult.failTitle')
        }
        size={480}
      >
        {testResult?.ok ? (
          <div className={styles['test-success']}>
            <div className={styles['test-success-header']}>
              <ElSvgIcon name="CircleCheck" size={24} color="#67c23a" />
              <span>
                {t('mcpProvider.detail.testResult.successSummary', {
                  count: testResult.tools?.length || 0
                })}
              </span>
            </div>
            {testResult.tools && testResult.tools.length > 0 && (
              <div className={styles['tools-list']}>
                {testResult.tools.map((tool: any) => (
                  <div key={tool.name} className={styles['tool-item']}>
                    <span className={styles['tool-name']}>{tool.name}</span>
                    {tool.description && (
                      <span className={styles['tool-desc']}>{tool.description}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className={styles['test-fail']}>
            <div className={styles['test-fail-header']}>
              <ElSvgIcon name="CircleClose" size={24} color="#f56c6c" />
              <span>{t('mcpProvider.detail.testResult.failTitle')}</span>
            </div>
            {testResult?.error && (
              <pre className={styles['error-mono']}>{testResult.error}</pre>
            )}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <Button variant="default" onClick={() => setTestResultVisible(false)}>
            {t('mcpProvider.detail.testResult.close')}
          </Button>
        </div>
      </Modal>
    </div>
  )
}
