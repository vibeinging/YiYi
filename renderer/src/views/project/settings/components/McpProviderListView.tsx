import { useState, useEffect, useMemo, useRef } from 'react'
import { Button, Badge, Modal, LoadingOverlay, TextInput, PasswordInput, Select, Alert } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import { useTranslation } from 'react-i18next'
import ElSvgIcon from '@/components/ElSvgIcon'
import {
  bindProjectMcpProviderReq,
  createAppMcpProviderReq,
  deleteAppMcpProviderReq,
  deleteProjectMcpBindingReq,
  listAppMcpProvidersReq,
  listMcpProvidersReq,
  testAppMcpProviderReq
} from '@/api/mcp'
// TODO(migration): McpProviderDetail 尚为 stub(无 props 类型),先以 any 桥接以传递 props
import McpProviderDetailRaw from './McpProviderDetail'
import styles from './McpProviderListView.module.scss'

const McpProviderDetail = McpProviderDetailRaw as any

interface McpProviderListViewProps {
  projectId?: string
  scope?: 'app' | 'project'
  initialItemId?: string
  // defineEmits(['selection-change'])
  onSelectionChange?: (id: string | null) => void
}

const SECRET_PATTERN = /TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL/i

// Args 中按"上一 arg 是敏感旗标"或"值本身形似 token"来识别，仅用于显示脱敏
const SECRET_FLAG_PATTERN = /^-{1,2}(token|api[-_]?key|key|secret|password|passwd|pat|pwd|auth)$/i
const SECRET_VALUE_PATTERN = /^(sk-|ak_|ghp_|gho_|ghu_|ghs_|ghr_|pat_|github_pat_|xoxb-|xoxp-|Bearer\s)/i
const HEX_TOKEN_PATTERN = /^[a-f0-9]{32,}$/i

const maskArg = (v: string) => '•'.repeat(Math.max(8, Math.min(12, (v || '').length)))

interface ArgPair {
  flag: string
  value: string
}
interface EnvRow {
  key: string
  value: string
}
interface WizardForm {
  provider_name: string
  transport: string
  command: string
  argPairs: ArgPair[]
  envRows: EnvRow[]
}
type TestResult = { ok: boolean; tools?: any[]; error?: string } | null

const stepDefs = [
  { key: 'identity', labelKey: 'mcpProvider.wizard.step1.railLabel' },
  { key: 'env', labelKey: 'mcpProvider.wizard.step2.railLabel' },
  { key: 'verify', labelKey: 'mcpProvider.wizard.step3.railLabel' }
]

const isSecretKey = (key: string) => SECRET_PATTERN.test(key || '')

const isSecretPair = (pair: ArgPair) => {
  if (!pair?.value) return false
  if (pair.flag && SECRET_FLAG_PATTERN.test(pair.flag)) return true
  if (SECRET_VALUE_PATTERN.test(pair.value)) return true
  if (HEX_TOKEN_PATTERN.test(pair.value)) return true
  return false
}

// Args 内部按 {flag, value} 对维护；提交时按出现顺序扁平化为 [flag, value, flag, value, ...]
const flattenArgPairs = (pairs: ArgPair[]) => {
  const out: string[] = []
  for (const p of pairs) {
    if (p.flag) out.push(p.flag)
    if (p.value) out.push(p.value)
  }
  return out
}

const buildEnvObject = (rows: EnvRow[]) => {
  const env: Record<string, string> = {}
  rows.forEach(({ key, value }) => {
    if (key && key.trim()) {
      env[key.trim()] = value
    }
  })
  return env
}

const formatRelativeTime = (dateStr: any) => {
  if (!dateStr) return '-'
  const diff = Date.now() - new Date(dateStr).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  return `${days} 天前`
}

export default function McpProviderListView({
  projectId = '',
  scope = 'project',
  initialItemId = '',
  onSelectionChange
}: McpProviderListViewProps) {
  const { t } = useTranslation()
  const isAppScope = scope === 'app'

  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [dataList, setDataList] = useState<any[]>([])
  const [selectedItemId, setSelectedItemId] = useState<string | null>(initialItemId || null)

  // ----- Wizard state -----
  const [dialogVisible, setDialogVisible] = useState(false)
  const [currentStep, setCurrentStep] = useState(0)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult>(null)

  const [form, setForm] = useState<WizardForm>({
    provider_name: '',
    transport: 'stdio',
    command: '',
    argPairs: [],
    envRows: []
  })

  // env / arg 敏感值可见性(对象映射 index -> bool)
  const [secretVisible, setSecretVisible] = useState<Record<number, boolean>>({})
  const [argSecretVisible, setArgSecretVisible] = useState<Record<number, boolean>>({})

  // step1 校验错误(provider_name / command)
  const [errors, setErrors] = useState<Record<string, string>>({})

  // ----- 派生值 -----
  // 参数脱敏展示（输入值仍是明文；仅用于 preview / recap）
  const displayArgs = useMemo(() => {
    const out: string[] = []
    for (const p of form.argPairs) {
      if (p.flag) out.push(p.flag)
      if (p.value) out.push(isSecretPair(p) ? maskArg(p.value) : p.value)
    }
    return out
  }, [form.argPairs])

  const hasSecretArg = useMemo(() => form.argPairs.some(isSecretPair), [form.argPairs])

  // ----- form 字段操作辅助 -----
  const updateForm = (patch: Partial<WizardForm>) => setForm((f) => ({ ...f, ...patch }))

  const addArgPair = () => updateForm({ argPairs: [...form.argPairs, { flag: '', value: '' }] })
  const removeArgPair = (i: number) => {
    updateForm({ argPairs: form.argPairs.filter((_, idx) => idx !== i) })
    setArgSecretVisible((m) => {
      const next = { ...m }
      delete next[i]
      return next
    })
  }
  const setArgPairField = (i: number, field: keyof ArgPair, val: string) => {
    updateForm({
      argPairs: form.argPairs.map((p, idx) => (idx === i ? { ...p, [field]: val } : p))
    })
  }
  const toggleArgSecretVisibility = (i: number) => {
    setArgSecretVisible((m) => ({ ...m, [i]: !m[i] }))
  }

  const addEnvRow = () => updateForm({ envRows: [...form.envRows, { key: '', value: '' }] })
  const removeEnvRow = (index: number) => {
    updateForm({ envRows: form.envRows.filter((_, idx) => idx !== index) })
    setSecretVisible((m) => {
      const next = { ...m }
      delete next[index]
      return next
    })
  }
  const setEnvRowField = (i: number, field: keyof EnvRow, val: string) => {
    updateForm({
      envRows: form.envRows.map((r, idx) => (idx === i ? { ...r, [field]: val } : r))
    })
  }
  const toggleSecretVisibility = (index: number) => {
    setSecretVisible((m) => ({ ...m, [index]: !m[index] }))
  }

  const resetWizard = () => {
    setForm({
      provider_name: '',
      transport: 'stdio',
      command: '',
      argPairs: [{ flag: '', value: '' }], // 预置一行，用户不用再点"+"才能开始输入
      envRows: []
    })
    setSecretVisible({})
    setArgSecretVisible({})
    setCurrentStep(0)
    setTesting(false)
    setTestResult(null)
    setErrors({})
  }

  const openWizard = () => {
    resetWizard()
    setDialogVisible(true)
  }

  const goStep = (i: number) => {
    // Only allow jumping backward (forward requires validation)
    if (i < currentStep) setCurrentStep(i)
  }

  // step1 校验(对应原 el-form rules)
  const validateStep1 = () => {
    const next: Record<string, string> = {}
    if (!form.provider_name) {
      next.provider_name = t('mcpProvider.wizard.step1.nameHint')
    } else if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(form.provider_name)) {
      next.provider_name = t('mcpProvider.wizard.step1.nameHint')
    }
    if (!form.command) {
      next.command = t('mcpProvider.wizard.step1.commandHint')
    }
    setErrors(next)
    return Object.keys(next).length === 0
  }

  const goNext = () => {
    if (currentStep === 0) {
      if (validateStep1()) setCurrentStep(1)
    } else if (currentStep === 1) {
      setCurrentStep(2)
    }
  }

  const buildTestPayload = () => ({
    provider_name: form.provider_name,
    transport: form.transport,
    command: form.command,
    args: flattenArgPairs(form.argPairs),
    env: buildEnvObject(form.envRows)
  })

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const res: any = await testAppMcpProviderReq(buildTestPayload())
      setTestResult(res.data || { ok: false, error: 'empty response' })
    } catch (err: any) {
      const resp = err?.response?.data
      let message
      if (resp?.errors && Array.isArray(resp.errors) && resp.errors.length) {
        message = `${resp.message || '请求校验失败'}\n\n` + resp.errors.join('\n')
      } else {
        message = resp?.message || resp?.msg || err?.message || String(err)
      }
      setTestResult({ ok: false, error: message })
    } finally {
      setTesting(false)
    }
  }

  const loadList = async () => {
    if (!isAppScope && !projectId) return
    setLoading(true)
    try {
      const res: any = isAppScope ? await listAppMcpProvidersReq() : await listMcpProvidersReq(projectId)
      if (res.success) {
        setDataList(res.data || [])
      } else {
        notifications.show({ color: 'red', message: res.msg || '加载失败' })
      }
    } catch (err) {
      console.error('loadMcpProviders error:', err)
      notifications.show({ color: 'red', message: '加载失败' })
    } finally {
      setLoading(false)
    }
  }

  const selectItem = (row: any) => {
    setSelectedItemId(row.id)
    onSelectionChange?.(row.id)
  }

  const handleDelete = (row: any) => {
    const isProjectReset = !isAppScope
    modals.openConfirmModal({
      title: isProjectReset ? '恢复 App 默认' : t('mcpProvider.list.deleteConfirm.title'),
      children: isProjectReset ? `清除「${row.provider_name}」在当前项目的启用覆盖。` : t('mcpProvider.list.deleteConfirm.message'),
      labels: {
        confirm: isProjectReset ? '恢复继承' : t('mcpProvider.list.deleteConfirm.ok'),
        cancel: t('mcpProvider.list.deleteConfirm.cancel')
      },
      confirmProps: { color: isProjectReset ? 'blue' : 'red' },
      onConfirm: async () => {
        try {
          const res: any = isAppScope
            ? await deleteAppMcpProviderReq(row.provider_name)
            : await deleteProjectMcpBindingReq(projectId, row.provider_name)
          if (res.success || res.data?.deleted || res.data) {
            notifications.show({ color: 'green', message: isProjectReset ? '已恢复 App 默认' : t('mcpProvider.messages.deleteSuccess') })
            await loadList()
          } else {
            notifications.show({ color: 'red', message: res.msg || '删除失败' })
          }
        } catch (err) {
          console.error('delete error:', err)
          notifications.show({ color: 'red', message: '删除失败' })
        }
      }
    })
  }

  const handleProjectToggle = async (row: any, enabled: boolean) => {
    if (isAppScope || !projectId) return
    setDataList((items) =>
      items.map((item) =>
        item.provider_name === row.provider_name
          ? { ...item, is_enabled: enabled, effective_enabled: enabled, enabled_override: enabled }
          : item
      )
    )
    try {
      const res: any = await bindProjectMcpProviderReq(projectId, row.provider_name, { enabled_override: enabled })
      if (res.success) {
        await loadList()
      } else {
        notifications.show({ color: 'red', message: res.msg || '更新失败' })
        await loadList()
      }
    } catch (err) {
      notifications.show({ color: 'red', message: String(err) })
      await loadList()
    }
  }

  const handleSubmit = async () => {
    // Guard: user could step back and invalidate step 1 fields
    if (!form.provider_name || !form.command) {
      notifications.show({ color: 'yellow', message: t('mcpProvider.wizard.step1.commandHint') })
      setCurrentStep(0)
      return
    }
    if (!isAppScope && !projectId) {
      notifications.show({ color: 'red', message: '当前项目未加载，请刷新页面后重试' })
      console.error('[mcp] project_id missing when submitting wizard')
      return
    }
    setSubmitting(true)
    try {
      const payload = {
        provider_name: form.provider_name,
        transport: form.transport,
        command: form.command,
        args: flattenArgPairs(form.argPairs),
        env: buildEnvObject(form.envRows)
      }
      const res: any = await createAppMcpProviderReq(payload)
      if (res.success) {
        notifications.show({ color: 'green', message: t('mcpProvider.messages.createSuccess') })
        setDialogVisible(false)
        await loadList()
      } else {
        notifications.show({ color: 'red', message: res.msg || '创建失败' })
      }
    } catch (err) {
      console.error('create error:', err)
      notifications.show({ color: 'red', message: '创建失败' })
    } finally {
      setSubmitting(false)
    }
  }

  const handleItemUpdated = () => {
    loadList()
  }

  // watch(() => props.projectId) + onMounted(loadList) —— projectId 变化(含首挂载)即加载
  useEffect(() => {
    if (isAppScope || projectId) loadList()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // watch(() => props.initialItemId)
  useEffect(() => {
    if (initialItemId) setSelectedItemId(initialItemId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialItemId])

  // env 过滤(用于 recap)
  const recapEnvRows = form.envRows.filter((r) => r.key)

  return (
    <div className="ad-page-list">
      {/* 列表视图 */}
      {!selectedItemId ? (
        <>
          {dataList.length > 0 && (
            <div className="ad-page-toolbar">
              <span className="toolbar-count">
                {isAppScope ? 'MCP Provider Library' : t('mcpProvider.title')} ({dataList.length})
              </span>
              <div className="toolbar-actions">
                {isAppScope && (
                  <Button onClick={openWizard} leftSection={<ElSvgIcon name="Plus" size={16} />}>
                    {t('mcpProvider.list.empty.cta')}
                  </Button>
                )}
              </div>
            </div>
          )}

          {dataList.length > 0 && (
            <div className="ad-page-content ad-card-grid" style={{ position: 'relative' }}>
              <LoadingOverlay visible={loading} />
              {dataList.map((item) => (
                <div
                  key={item.id}
                  className={`ad-grid-card ${styles.mcpCard} ${!item.is_enabled ? styles.isDisabled : ''}`}
                  onClick={() => selectItem(item)}
                >
                  <div className="grid-card-header">
                    <div className="grid-card-title">
                      <ElSvgIcon name="Link" size={16} />
                      <span title={item.provider_name}>{item.provider_name}</span>
                      <Badge size="sm" color="gray">
                        {item.transport}
                      </Badge>
                      {!item.is_enabled && (
                        <Badge size="sm" color="orange">
                          {t('mcpProvider.list.statusDisabled')}
                        </Badge>
                      )}
                      {!isAppScope && item.enabled_override === null && (
                        <Badge size="sm" color="gray">
                          继承
                        </Badge>
                      )}
                      {!isAppScope && item.availability === 'blocked' && (
                        <Badge size="sm" color="red">
                          App 已关闭
                        </Badge>
                      )}
                    </div>
                    <div className="grid-card-actions" onClick={(e) => e.stopPropagation()}>
                      {!isAppScope && (
                        <Button
                          variant="subtle"
                          size="compact-sm"
                          onClick={() => handleProjectToggle(item, !item.is_enabled)}
                          leftSection={<ElSvgIcon name={item.is_enabled ? 'Close' : 'Check'} size={14} />}
                        >
                          {item.is_enabled ? '禁用' : '启用'}
                        </Button>
                      )}
                      <Button
                        variant="subtle"
                        size="compact-sm"
                        onClick={() => selectItem(item)}
                        leftSection={<ElSvgIcon name="Edit" size={14} />}
                      >
                        {t('common.manage')}
                      </Button>
                      {isAppScope ? (
                        <Button
                          variant="subtle"
                          color="red"
                          size="compact-sm"
                          onClick={() => handleDelete(item)}
                          leftSection={<ElSvgIcon name="Delete" size={14} />}
                        >
                          {t('common.delete')}
                        </Button>
                      ) : item.binding ? (
                        <Button
                          variant="subtle"
                          size="compact-sm"
                          onClick={() => handleDelete(item)}
                        >
                          继承
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  <div className="grid-card-body">
                    <div className={`grid-card-desc ${styles.mcpCommand}`}>{item.command}</div>
                    <div className="grid-card-info">
                      <span className="info-tag">
                        {t('mcpProvider.list.card.argsCount', { n: (item.args || []).length })}
                      </span>
                      <span className="info-tag">
                        {t('mcpProvider.list.card.envCount', {
                          n: Object.keys(item.env || {}).length
                        })}
                      </span>
                      {item.last_error && (
                        <span className={`info-tag ${styles.infoTag} ${styles.isWarning}`}>
                          {t('mcpProvider.list.card.hasError')}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="grid-card-footer">
                    {t('mcpProvider.list.card.lastDiscovered', {
                      time: formatRelativeTime(item.last_discovered_at)
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 空状态 */}
          {!loading && dataList.length === 0 && (
            <div className={`ad-page-empty ${styles.mcpEmpty}`}>
              <div className={styles.emptyIllustration}>
                <div className={styles.illustrationContainer}>
                  <div className={`${styles.mcpSatellite} ${styles.left}`}>
                    <ElSvgIcon name="Position" size={18} />
                    <span className={styles.satLabel}>gitee</span>
                  </div>
                  <div className={`${styles.mcpSatellite} ${styles.right}`}>
                    <ElSvgIcon name="FolderOpened" size={18} />
                    <span className={styles.satLabel}>fs</span>
                  </div>
                  <div className={`${styles.mcpSatellite} ${styles.top}`}>
                    <ElSvgIcon name="Operation" size={18} />
                    <span className={styles.satLabel}>api</span>
                  </div>
                  <div className={styles.centerHub}>
                    <ElSvgIcon name="Link" size={22} color="#fff" />
                  </div>
                  <svg className={styles.connectLines} viewBox="0 0 200 180" aria-hidden="true">
                    <line x1="100" y1="95" x2="32" y2="135" />
                    <line x1="100" y1="95" x2="168" y2="135" />
                    <line x1="100" y1="95" x2="100" y2="28" />
                  </svg>
                </div>
              </div>
              <div className={styles.emptyContent}>
                <h3 className={styles.emptyTitle}>{isAppScope ? t('mcpProvider.list.empty.title') : '暂无可用 MCP Provider'}</h3>
                <p className={styles.emptyDesc}>
                  {isAppScope ? t('mcpProvider.list.empty.description') : '请先在 App 设置 → MCP 服务器中创建 Provider，然后在项目中启用或禁用。'}
                </p>
                <div className={styles.emptyFeatures}>
                  <div className={styles.featureItem}>
                    <ElSvgIcon name="Connection" size={15} />
                    <span>{t('mcpProvider.list.empty.featureStdio')}</span>
                  </div>
                  <div className={styles.featureItem}>
                    <ElSvgIcon name="Tools" size={15} />
                    <span>{t('mcpProvider.list.empty.featureAutoDiscover')}</span>
                  </div>
                  <div className={styles.featureItem}>
                    <ElSvgIcon name="Lock" size={15} />
                    <span>{t('mcpProvider.list.empty.featurePerProject')}</span>
                  </div>
                </div>
                {isAppScope && (
                  <Button
                    size="lg"
                    onClick={openWizard}
                    leftSection={<ElSvgIcon name="Plus" size={18} />}
                  >
                    {t('mcpProvider.list.empty.cta')}
                  </Button>
                )}
              </div>
            </div>
          )}
        </>
      ) : (
        /* 详情视图 */
        <McpProviderDetail
          projectId={projectId}
          scope={scope}
          itemId={selectedItemId}
          onBack={() => {
            setSelectedItemId(null)
            onSelectionChange?.(null)
          }}
          onUpdated={handleItemUpdated}
        />
      )}

      {/* 新建 Provider — 多步向导 Dialog */}
      <Modal
        opened={dialogVisible}
        onClose={() => setDialogVisible(false)}
        withCloseButton={false}
        closeOnClickOutside={false}
        closeOnEscape={false}
        size="80%"
        padding={0}
        styles={{ inner: { paddingTop: '3vh', alignItems: 'flex-start' } }}
        onExitTransitionEnd={resetWizard}
      >
        {dialogVisible && (
          <div className={styles.setupGuide}>
            {/* 关闭按钮 */}
            <div className={styles.guideCloseHeader}>
              <button
                type="button"
                className={styles.closeButton}
                onClick={() => setDialogVisible(false)}
              >
                <ElSvgIcon name="Close" size={18} />
              </button>
            </div>

            {/* 步骤指示器 */}
            <div className={styles.guideHeader}>
              <div className={styles.guideSteps}>
                {stepDefs.map((s, i) => (
                  <div key={s.key} style={{ display: 'flex', alignItems: 'center' }}>
                    <div
                      className={[
                        styles.stepItem,
                        currentStep === i ? styles.active : '',
                        currentStep > i ? styles.completed : '',
                        currentStep > i ? styles.clickable : ''
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      onClick={() => goStep(i)}
                    >
                      <div className={styles.stepNumber}>
                        {currentStep > i ? <ElSvgIcon name="Check" size={16} /> : <span>{i + 1}</span>}
                      </div>
                      <div className={styles.stepLabel}>{t(s.labelKey)}</div>
                    </div>
                    {i < stepDefs.length - 1 && <div className={styles.stepConnector} />}
                  </div>
                ))}
              </div>
            </div>

            {/* 步骤内容 */}
            <div className={styles.guideContent}>
              {/* Step 1: 身份与命令 */}
              {currentStep === 0 && (
                <div className={styles.stepPanel}>
                  <div className={styles.stepIntro}>
                    <h3 className={styles.stepIntro__title}>{t('mcpProvider.wizard.step1.title')}</h3>
                    <p className={styles.stepIntro__desc}>{t('mcpProvider.wizard.step1.desc')}</p>
                  </div>

                  <div>
                    <div className={styles.formItem}>
                      <label className={styles.formLabel}>{t('mcpProvider.form.providerName')}</label>
                      <TextInput
                        value={form.provider_name}
                        onChange={(e) => updateForm({ provider_name: e.currentTarget.value })}
                        placeholder={t('mcpProvider.wizard.step1.namePlaceholder')}
                        maxLength={64}
                        error={errors.provider_name}
                      />
                      <div className={styles.fieldHint}>{t('mcpProvider.wizard.step1.nameHint')}</div>
                    </div>

                    <div className={styles.formItem}>
                      <label className={styles.formLabel}>{t('mcpProvider.form.command')}</label>
                      <TextInput
                        value={form.command}
                        onChange={(e) => updateForm({ command: e.currentTarget.value })}
                        placeholder={t('mcpProvider.wizard.step1.commandPlaceholder')}
                        error={errors.command}
                      />
                      <div className={styles.fieldHint}>
                        {t('mcpProvider.wizard.step1.commandHint')}
                      </div>
                    </div>

                    <div className={styles.formItem}>
                      <label className={styles.formLabel}>{t('mcpProvider.form.args')}</label>
                      <div className={styles.argsEditor}>
                        {form.argPairs.length > 0 && (
                          <div className={styles.argsEditorHead}>
                            <span>{t('mcpProvider.wizard.step1.argFlagLabel')}</span>
                            <span>{t('mcpProvider.wizard.step1.argValueLabel')}</span>
                            <span />
                          </div>
                        )}
                        {form.argPairs.map((pair, index) => {
                          const secret = isSecretPair(pair)
                          const reveal = argSecretVisible[index]
                          return (
                            <div key={index} className={styles.argsEditorRow}>
                              <TextInput
                                value={pair.flag}
                                onChange={(e) => setArgPairField(index, 'flag', e.currentTarget.value)}
                                placeholder={t('mcpProvider.wizard.step1.argFlagPlaceholder')}
                                className={styles.argsInput}
                              />
                              {secret && !reveal ? (
                                <PasswordInput
                                  value={pair.value}
                                  onChange={(e) =>
                                    setArgPairField(index, 'value', e.currentTarget.value)
                                  }
                                  placeholder={t('mcpProvider.wizard.step1.argValuePlaceholder')}
                                  className={styles.argsInput}
                                  visible={false}
                                  onVisibilityChange={() => toggleArgSecretVisibility(index)}
                                />
                              ) : (
                                <TextInput
                                  value={pair.value}
                                  onChange={(e) =>
                                    setArgPairField(index, 'value', e.currentTarget.value)
                                  }
                                  placeholder={t('mcpProvider.wizard.step1.argValuePlaceholder')}
                                  className={styles.argsInput}
                                  rightSection={
                                    secret ? (
                                      <span
                                        className={styles.envEyeIcon}
                                        onClick={() => toggleArgSecretVisibility(index)}
                                      >
                                        <ElSvgIcon name={reveal ? 'View' : 'Hide'} size={16} />
                                      </span>
                                    ) : undefined
                                  }
                                />
                              )}
                              <button
                                type="button"
                                className={styles.iconBtnDanger}
                                onClick={() => removeArgPair(index)}
                              >
                                <ElSvgIcon name="Delete" size={16} />
                              </button>
                            </div>
                          )
                        })}
                        <Button
                          variant="subtle"
                          className={styles.btnAddRow}
                          onClick={addArgPair}
                          leftSection={<ElSvgIcon name="Plus" size={14} />}
                        >
                          {t('mcpProvider.wizard.step1.argsAddRow')}
                        </Button>
                      </div>
                      <div className={styles.fieldHint}>{t('mcpProvider.wizard.step1.argsHint')}</div>
                    </div>

                    <div className={styles.formItem}>
                      <label className={styles.formLabel}>{t('mcpProvider.form.transport')}</label>
                      <Select
                        value={form.transport}
                        onChange={(v) => updateForm({ transport: v || 'stdio' })}
                        data={[{ value: 'stdio', label: 'stdio' }]}
                        disabled
                        style={{ width: '100%' }}
                      />
                      <div className={styles.fieldHint}>
                        {t('mcpProvider.wizard.step1.transportHint')}
                      </div>
                    </div>
                  </div>

                  {form.command && (
                    <div className={styles.commandPreview}>
                      <span className={styles.commandPreview__label}>
                        {t('mcpProvider.wizard.step1.previewLabel')}
                      </span>
                      <code className={styles.commandPreview__code}>
                        {form.command}
                        {displayArgs.map((a, i) => (
                          <span key={i}> {a}</span>
                        ))}
                      </code>
                      {hasSecretArg && (
                        <span className={styles.commandPreview__note}>
                          {t('mcpProvider.wizard.step1.secretArgNote')}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Step 2: 环境变量 */}
              {currentStep === 1 && (
                <div className={styles.stepPanel}>
                  <div className={styles.stepIntro}>
                    <h3 className={styles.stepIntro__title}>{t('mcpProvider.wizard.step2.title')}</h3>
                    <p className={styles.stepIntro__desc}>{t('mcpProvider.wizard.step2.desc')}</p>
                  </div>

                  {form.envRows.length === 0 ? (
                    <div className={styles.envEmpty}>
                      <p className={styles.envEmpty__line}>
                        {t('mcpProvider.wizard.step2.emptyLine1')}
                      </p>
                      <p className={styles.envEmpty__hint}>
                        {t('mcpProvider.wizard.step2.emptyLine2')}
                      </p>
                      <Button
                        variant="subtle"
                        className={styles.btnAddRow}
                        onClick={addEnvRow}
                        leftSection={<ElSvgIcon name="Plus" size={14} />}
                      >
                        {t('mcpProvider.wizard.step2.addRow')}
                      </Button>
                    </div>
                  ) : (
                    <div className={styles.envEditor}>
                      <div className={styles.envEditorHead}>
                        <span>{t('mcpProvider.wizard.step2.key')}</span>
                        <span>{t('mcpProvider.wizard.step2.value')}</span>
                        <span />
                      </div>
                      {form.envRows.map((row, index) => {
                        const secret = isSecretKey(row.key)
                        const reveal = secretVisible[index]
                        return (
                          <div key={index} className={styles.envEditorRow}>
                            <TextInput
                              value={row.key}
                              onChange={(e) => setEnvRowField(index, 'key', e.currentTarget.value)}
                              placeholder={t('mcpProvider.form.envKeyPlaceholder')}
                              className={styles.envInput}
                            />
                            {secret && !reveal ? (
                              <PasswordInput
                                value={row.value}
                                onChange={(e) =>
                                  setEnvRowField(index, 'value', e.currentTarget.value)
                                }
                                placeholder={t('mcpProvider.form.envValuePlaceholder')}
                                className={styles.envInput}
                                visible={false}
                                onVisibilityChange={() => toggleSecretVisibility(index)}
                              />
                            ) : (
                              <TextInput
                                value={row.value}
                                onChange={(e) =>
                                  setEnvRowField(index, 'value', e.currentTarget.value)
                                }
                                placeholder={t('mcpProvider.form.envValuePlaceholder')}
                                className={styles.envInput}
                                rightSection={
                                  secret ? (
                                    <span
                                      className={styles.envEyeIcon}
                                      onClick={() => toggleSecretVisibility(index)}
                                    >
                                      <ElSvgIcon name={reveal ? 'View' : 'Hide'} size={16} />
                                    </span>
                                  ) : undefined
                                }
                              />
                            )}
                            <button
                              type="button"
                              className={styles.iconBtnDanger}
                              onClick={() => removeEnvRow(index)}
                            >
                              <ElSvgIcon name="Delete" size={16} />
                            </button>
                          </div>
                        )
                      })}
                      <Button
                        variant="subtle"
                        className={styles.btnAddRow}
                        onClick={addEnvRow}
                        leftSection={<ElSvgIcon name="Plus" size={14} />}
                      >
                        {t('mcpProvider.wizard.step2.addRow')}
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {/* Step 3: 测试并保存 */}
              {currentStep === 2 && (
                <div className={styles.stepPanel}>
                  <div className={styles.stepIntro}>
                    <h3 className={styles.stepIntro__title}>{t('mcpProvider.wizard.step3.title')}</h3>
                    <p className={styles.stepIntro__desc}>{t('mcpProvider.wizard.step3.desc')}</p>
                  </div>

                  {/* 配置快照 */}
                  <div className={styles.configRecap}>
                    <div className={styles.recapRow}>
                      <div className={styles.recapLabel}>{t('mcpProvider.form.providerName')}</div>
                      <div className={styles.recapValue}>{form.provider_name || '—'}</div>
                    </div>
                    <div className={styles.recapRow}>
                      <div className={styles.recapLabel}>{t('mcpProvider.wizard.step3.launch')}</div>
                      <div className={styles.recapValue}>
                        <code className={styles.codeInline}>
                          {form.command}
                          {displayArgs.map((a, i) => (
                            <span key={i}> {a}</span>
                          ))}
                        </code>
                      </div>
                    </div>
                    {recapEnvRows.length > 0 && (
                      <div className={styles.recapRow}>
                        <div className={styles.recapLabel}>{t('mcpProvider.form.env')}</div>
                        <div className={styles.recapValue}>
                          {recapEnvRows.map((row, i) => (
                            <Badge
                              key={i}
                              size="sm"
                              color="gray"
                              style={{ marginRight: 6 }}
                            >
                              {row.key}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* 测试区 */}
                  <div className={styles.testStage}>
                    {!testResult && !testing && (
                      <div className={styles.testStageIdle}>
                        <div className={styles.stageIcon}>
                          <ElSvgIcon name="Connection" size={40} color="#17483e" />
                        </div>
                        <h4>{t('mcpProvider.wizard.step3.ctaHeadline')}</h4>
                        <p className={styles.stageSub}>{t('mcpProvider.wizard.step3.ctaSub')}</p>
                        <Button onClick={handleTest}>{t('mcpProvider.wizard.step3.runTest')}</Button>
                      </div>
                    )}

                    {testing && (
                      <div className={styles.testStageRunning}>
                        <div className={`${styles.stageIcon} ${styles.stageIconSpin}`}>
                          <ElSvgIcon name="Loading" size={40} color="#17483e" />
                        </div>
                        <h4>{t('mcpProvider.wizard.step3.running')}</h4>
                        <p className={styles.stageSub}>{t('mcpProvider.wizard.step3.runningSub')}</p>
                      </div>
                    )}

                    {!testing && testResult && testResult.ok && (
                      <div>
                        <Alert color="green" title={t('mcpProvider.wizard.step3.successHeadline')}>
                          <div className={styles.alertBody}>
                            <span>
                              {t('mcpProvider.wizard.step3.successSub', {
                                count: testResult.tools?.length || 0
                              })}
                            </span>
                            <Button variant="subtle" size="compact-sm" onClick={handleTest}>
                              {t('mcpProvider.wizard.step3.retest')}
                            </Button>
                          </div>
                        </Alert>
                        <table className={styles.toolListTable}>
                          <thead>
                            <tr>
                              <th style={{ width: 260 }}>
                                {t('mcpProvider.wizard.step3.toolName')}
                              </th>
                              <th>{t('mcpProvider.wizard.step3.toolDesc')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(testResult.tools || []).map((row: any, i: number) => (
                              <tr key={i}>
                                <td>
                                  <code className={styles.codeInline}>{row.name}</code>
                                </td>
                                <td>
                                  <span className={styles.descText} title={row.description || '—'}>
                                    {row.description || '—'}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {!testing && testResult && !testResult.ok && (
                      <div>
                        <Alert color="red" title={t('mcpProvider.wizard.step3.failHeadline')}>
                          <div className={styles.alertBody}>
                            <span>{t('mcpProvider.wizard.step3.failSub')}</span>
                            <Button variant="subtle" size="compact-sm" onClick={handleTest}>
                              {t('mcpProvider.wizard.step3.retry')}
                            </Button>
                          </div>
                        </Alert>
                        <pre className={styles.failDetail}>{testResult.error}</pre>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* 底部操作 */}
            <div className={styles.guideFooter}>
              <Button variant="default" onClick={() => setDialogVisible(false)}>
                {t('mcpProvider.form.cancel')}
              </Button>
              {currentStep > 0 && (
                <Button variant="default" onClick={() => setCurrentStep(currentStep - 1)}>
                  {t('mcpProvider.wizard.footer.back')}
                </Button>
              )}
              <div className={styles.footerSpacer}>
                {currentStep === 2 && testResult && !testResult.ok && (
                  <span className={styles.footerNote}>
                    {t('mcpProvider.wizard.footer.saveAnyway')}
                  </span>
                )}
              </div>
              {currentStep < 2 ? (
                <Button onClick={goNext}>{t('mcpProvider.wizard.footer.next')}</Button>
              ) : (
                <Button loading={submitting} onClick={handleSubmit}>
                  {t('mcpProvider.wizard.footer.save')}
                </Button>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
