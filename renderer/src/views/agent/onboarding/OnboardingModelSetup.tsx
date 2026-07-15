import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  IconAlertTriangle,
  IconChevronDown,
  IconCircleCheckFilled,
  IconCpu,
  IconDeviceFloppy,
  IconLoader2,
  IconMessageDots,
  IconPlugConnected,
  IconRefresh,
  IconSearch
} from '@tabler/icons-react'
import { notifications } from '@mantine/notifications'
import {
  createLLMModelReq,
  getLLMModelDetailReq,
  llmModelsReq,
  testModelConfigReq,
  updateLLMModelReq
} from '@/api/models'
import styles from './OnboardingModelSetup.module.scss'

type ModelKey = 'PRIMARY' | 'SECONDARY' | 'EMBEDDING'

interface OnboardingModelStatus {
  loading: boolean
  error: string
  PRIMARY: boolean
  SECONDARY: boolean
  EMBEDDING: boolean
}

interface OnboardingModelSetupProps {
  modelStatus: OnboardingModelStatus
  onModelsChanged?: () => Promise<void> | void
}

interface RoleDef {
  key: ModelKey
  label: string
  title: string
  desc: string
  required: boolean
  icon: typeof IconMessageDots
}

type FieldSpan = 'one' | 'two' | 'full'

type ModelFormState = Record<string, any>

const DEFAULT_CONTEXT_WINDOW = 128000
const MIN_CONTEXT_WINDOW = 32768

const ROLES: RoleDef[] = [
  {
    key: 'PRIMARY',
    label: '主模型',
    title: '对话与任务',
    desc: '负责对话、文件处理、工具调度和多步任务。',
    required: true,
    icon: IconMessageDots
  },
  {
    key: 'EMBEDDING',
    label: '向量模型',
    title: '内容检索',
    desc: '用于文档检索和内容匹配，需要时再配置。',
    required: false,
    icon: IconSearch
  },
  {
    key: 'SECONDARY',
    label: '副模型',
    title: '轻量任务',
    desc: '用于低成本抽取、分类和辅助处理，可稍后配置。',
    required: false,
    icon: IconCpu
  }
]

const API_FORMATS = [
  { value: 'chat_completions', label: 'Chat Completions' },
  { value: 'responses', label: 'Responses' },
  { value: 'anthropic', label: 'Anthropic Messages' }
]

function createInitialForm(category: ModelKey): ModelFormState {
  const isEmbedding = category === 'EMBEDDING'
  return {
    id: null,
    model_name: '',
    category,
    api_base: '',
    api_key: '',
    api_format: 'chat_completions',
    supports_streaming: !isEmbedding,
    dimension: isEmbedding ? 1024 : null,
    extra_headers: null,
    extra_body: null,
    input_field: 'input',
    supports_batch: isEmbedding,
    embed_batch_size: isEmbedding ? 100 : null,
    batch_input_field: isEmbedding ? 'input' : null,
    max_concurrency: isEmbedding ? 10 : null,
    context_window: isEmbedding ? null : DEFAULT_CONTEXT_WINDOW,
    thinking_param: '',
    thinking_value: false
  }
}

function readItems(res: any): any[] {
  const data = res?.data
  const items = data?.items || data || res?.items || []
  return Array.isArray(items) ? items : []
}

function parseExtraConfig(value: any) {
  if (!value) return {}
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch (error) {
    console.warn('解析 extra_config 失败:', error)
    return {}
  }
}

function flattenFirstLeaf(obj: any, prefix = ''): { path?: string; value?: any } {
  if (!obj || typeof obj !== 'object') return {}
  const keys = Object.keys(obj)
  if (!keys.length) return {}
  const key = keys[0]
  const path = prefix ? `${prefix}.${key}` : key
  const value = obj[key]
  return value && typeof value === 'object' ? flattenFirstLeaf(value, path) : { path, value }
}

function hydrateForm(detail: any): {
  form: ModelFormState
  extraHeadersText: string
  extraBodyText: string
} {
  const category = (detail.category || 'PRIMARY') as ModelKey
  const isEmbedding = category === 'EMBEDDING'
  const extraConfig = parseExtraConfig(detail.extra_config)
  const thinking = extraConfig.thinking
  const legacyThinking = extraConfig.disable_thinking
  let thinkingParam = ''
  let thinkingValue = false

  if (thinking && typeof thinking === 'object' && thinking.param) {
    thinkingParam = thinking.param
    thinkingValue = !!thinking.value
  } else if (legacyThinking && typeof legacyThinking === 'object' && legacyThinking.enabled) {
    const leaf = flattenFirstLeaf(legacyThinking.params)
    thinkingParam = leaf.path || 'enable_thinking'
    thinkingValue = !!leaf.value
  }

  const extraHeaders = extraConfig.extra_headers || null
  const extraBody = extraConfig.extra_body || null

  return {
    form: {
      ...createInitialForm(category),
      ...detail,
      supports_streaming: isEmbedding ? false : detail.supports_streaming !== false,
      dimension: isEmbedding ? 1024 : detail.dimension,
      extra_headers: extraHeaders,
      extra_body: extraBody,
      input_field: extraConfig.input_field || 'input',
      supports_batch: extraConfig.supports_batch !== false,
      embed_batch_size: extraConfig.embed_batch_size || 100,
      batch_input_field: extraConfig.batch_input_field || 'input',
      max_concurrency: extraConfig.max_concurrency || 10,
      context_window: isEmbedding ? null : Number(extraConfig.context_window || DEFAULT_CONTEXT_WINDOW),
      thinking_param: thinkingParam,
      thinking_value: thinkingValue
    },
    extraHeadersText: extraHeaders ? JSON.stringify(extraHeaders, null, 2) : '',
    extraBodyText: extraBody ? JSON.stringify(extraBody, null, 2) : ''
  }
}

function parseOptionalJson(text: string, label: string) {
  if (!text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} JSON 格式不正确`)
  }
}

function stripEmptyValues(data: Record<string, any>) {
  Object.keys(data).forEach((key) => {
    if (key !== 'dimension' && (data[key] === '' || data[key] === null)) {
      delete data[key]
    }
  })
}

function buildSubmitData(form: ModelFormState, extraHeadersText: string, extraBodyText: string) {
  const submitData: any = { ...form }
  const extraHeaders = parseOptionalJson(extraHeadersText, 'Extra Headers')
  const extraBody = parseOptionalJson(extraBodyText, 'Extra Body')
  const extraConfig: any = {}

  if (extraHeaders && Object.keys(extraHeaders).length > 0) extraConfig.extra_headers = extraHeaders
  if (extraBody && Object.keys(extraBody).length > 0) extraConfig.extra_body = extraBody

  if (submitData.category === 'PRIMARY' || submitData.category === 'SECONDARY') {
    if (Number.isFinite(Number(submitData.context_window)) && Number(submitData.context_window) > 0) {
      extraConfig.context_window = Math.floor(Number(submitData.context_window))
    }
    if (submitData.thinking_param && submitData.thinking_param.trim()) {
      extraConfig.thinking = {
        param: submitData.thinking_param.trim(),
        value: !!submitData.thinking_value
      }
    }
    delete submitData.dimension
    delete submitData.input_field
    submitData.supports_streaming = submitData.supports_streaming !== false
  } else if (submitData.category === 'EMBEDDING') {
    submitData.supports_streaming = false
    submitData.dimension = 1024
    extraConfig.input_field = submitData.input_field || 'input'
    extraConfig.supports_batch = !!submitData.supports_batch
    extraConfig.max_concurrency = submitData.max_concurrency || 10
    if (submitData.supports_batch) {
      extraConfig.embed_batch_size = submitData.embed_batch_size || 100
      extraConfig.batch_input_field = submitData.batch_input_field || 'input'
    }
  }

  submitData.extra_config = extraConfig
  delete submitData.extra_headers
  delete submitData.extra_body
  delete submitData.input_field
  delete submitData.supports_batch
  delete submitData.embed_batch_size
  delete submitData.batch_input_field
  delete submitData.max_concurrency
  delete submitData.context_window
  delete submitData.disable_thinking
  delete submitData.thinking_param
  delete submitData.thinking_value

  stripEmptyValues(submitData)
  return submitData
}

function buildTestData(form: ModelFormState, extraHeadersText: string, extraBodyText: string) {
  const testData: any = {
    ...form,
    extra_headers: parseOptionalJson(extraHeadersText, 'Extra Headers'),
    extra_body: parseOptionalJson(extraBodyText, 'Extra Body')
  }

  if (testData.category === 'EMBEDDING') {
    testData.dimension = 1024
    testData.test_type = 'embedding'
    delete testData.temperature
    delete testData.max_tokens
    delete testData.supports_streaming
  } else {
    testData.test_type = 'chat'
  }

  delete testData.extra_config
  delete testData.disable_thinking
  delete testData.thinking_param
  delete testData.thinking_value
  stripEmptyValues(testData)
  return testData
}

function validateForm(form: ModelFormState) {
  if (!form.model_name?.trim()) return '请填写模型名称'
  if (form.model_name.trim().length < 2 || form.model_name.trim().length > 100) {
    return '模型名称长度需要在 2 到 100 个字符之间'
  }
  if (!form.api_base?.trim()) return '请填写 API 地址'
  if (
    form.category !== 'EMBEDDING' &&
    (!Number.isFinite(Number(form.context_window)) || Number(form.context_window) < MIN_CONTEXT_WINDOW)
  ) {
    return '上下文长度不能小于 32768 tokens'
  }
  return ''
}

export default function OnboardingModelSetup({
  modelStatus,
  onModelsChanged
}: OnboardingModelSetupProps) {
  const [activeRole, setActiveRole] = useState<ModelKey>('PRIMARY')
  const [form, setForm] = useState<ModelFormState>(() => createInitialForm('PRIMARY'))
  const [extraHeadersText, setExtraHeadersText] = useState('')
  const [extraBodyText, setExtraBodyText] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<any>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const requestSeq = useRef(0)

  const activeDef = useMemo(
    () => ROLES.find((role) => role.key === activeRole) || ROLES[0],
    [activeRole]
  )
  const requiredReady = modelStatus.PRIMARY
  const ActiveIcon = activeDef.icon

  const updateField = (key: string, value: any) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const loadRole = useCallback(async (category: ModelKey) => {
    const seq = requestSeq.current + 1
    requestSeq.current = seq
    setLoading(true)
    setTestResult(null)

    try {
      const res = await llmModelsReq({ category, per_page: 100 })
      const items = readItems(res)
      if (requestSeq.current !== seq) return

      if (!items.length) {
        setForm(createInitialForm(category))
        setExtraHeadersText('')
        setExtraBodyText('')
        return
      }

      const detailRes = await getLLMModelDetailReq(items[0].id)
      if (requestSeq.current !== seq) return
      const next = hydrateForm(detailRes?.data || items[0])
      setForm(next.form)
      setExtraHeadersText(next.extraHeadersText)
      setExtraBodyText(next.extraBodyText)
    } catch (error: any) {
      if (requestSeq.current !== seq) return
      setForm(createInitialForm(category))
      setExtraHeadersText('')
      setExtraBodyText('')
      notifications.show({
        color: 'red',
        message: error.message || '模型配置读取失败'
      })
    } finally {
      if (requestSeq.current === seq) setLoading(false)
    }
  }, [])

  useEffect(() => {
    setAdvancedOpen(false)
    loadRole(activeRole)
  }, [activeRole, loadRole])

  const handleRefresh = async () => {
    await loadRole(activeRole)
    await onModelsChanged?.()
  }

  const handleTest = async () => {
    const validationError = validateForm(form)
    if (validationError) {
      notifications.show({ color: 'red', message: validationError })
      return
    }

    try {
      setTesting(true)
      setTestResult(null)
      const testData = buildTestData(form, extraHeadersText, extraBodyText)
      const res = await testModelConfigReq(testData)
      const result = res?.data || {}
      setTestResult(result)
      notifications.show({
        color: result.success ? 'green' : 'yellow',
        message: result.message || (result.success ? '连接测试成功' : '连接测试失败')
      })
    } catch (error: any) {
      const message = error.message || '连接测试失败'
      setTestResult({ success: false, message })
      notifications.show({ color: 'red', message })
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    const validationError = validateForm(form)
    if (validationError) {
      notifications.show({ color: 'red', message: validationError })
      return
    }

    try {
      setSaving(true)
      const submitData = buildSubmitData(form, extraHeadersText, extraBodyText)
      if (submitData.id) {
        await updateLLMModelReq(submitData)
        notifications.show({ color: 'green', message: '模型配置已更新' })
      } else {
        await createLLMModelReq(submitData)
        notifications.show({ color: 'green', message: '模型配置已保存' })
      }
      await loadRole(activeRole)
      await onModelsChanged?.()
    } catch (error: any) {
      notifications.show({
        color: 'red',
        message: error.message || '模型配置保存失败'
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={styles.modelSetup}>
      <aside className={styles.roleRail} aria-label="模型角色">
        <div className={styles.roleRailHeader}>
          <span>模型角色</span>
          <button type="button" className={styles.iconButton} onClick={handleRefresh} title="刷新模型状态">
            {modelStatus.loading || loading ? <IconLoader2 size={15} className={styles.spin} /> : <IconRefresh size={15} />}
          </button>
        </div>
        <div className={styles.roleList}>
          {ROLES.map((role) => {
            const Icon = role.icon
            const ready = modelStatus[role.key]
            const selected = activeRole === role.key
            return (
              <button
                key={role.key}
                type="button"
                className={styles.roleButton}
                data-active={selected ? 'true' : undefined}
                onClick={() => setActiveRole(role.key)}
              >
                <span className={styles.roleIcon}>
                  <Icon size={17} stroke={1.7} />
                </span>
                <span className={styles.roleText}>
                  <span>
                    {role.label}
                    {role.required && <em>建议</em>}
                  </span>
                  <small>{ready ? '已配置' : role.required ? '待配置' : '可选配置'}</small>
                </span>
                <span className={styles.roleState} data-ready={ready ? 'true' : undefined}>
                  {ready ? <IconCircleCheckFilled size={15} /> : <IconAlertTriangle size={15} />}
                </span>
              </button>
            )
          })}
        </div>
        <div className={styles.requirementBox} data-ready={requiredReady ? 'true' : undefined}>
          <strong>{requiredReady ? '主模型已配置' : '建议先配置主模型'}</strong>
          <span>未配置也可以继续；需要对话、处理文件或运行任务时再到设置页补齐。</span>
          {modelStatus.error && <small>{modelStatus.error}</small>}
        </div>
      </aside>

      <section className={styles.formPanel} aria-label={`${activeDef.label}配置`}>
        <div className={styles.formHeader}>
          <div className={styles.formHeaderTitle}>
            <span className={styles.formHeaderIcon}>
              <ActiveIcon size={18} stroke={1.7} />
            </span>
            <span>
              <strong>{activeDef.label}</strong>
              <small>{activeDef.desc}</small>
            </span>
          </div>
          <div className={styles.formActions}>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={handleTest}
              disabled={testing || loading}
            >
              {testing ? <IconLoader2 size={14} className={styles.spin} /> : <IconPlugConnected size={14} />}
              测试
            </button>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={handleSave}
              disabled={saving || loading}
            >
              {saving ? <IconLoader2 size={14} className={styles.spin} /> : <IconDeviceFloppy size={14} />}
              保存
            </button>
          </div>
        </div>

        {loading ? (
          <div className={styles.loadingBox}>
            <IconLoader2 size={18} className={styles.spin} />
            正在读取模型配置
          </div>
        ) : (
          <div className={styles.formBody}>
            {activeRole === 'EMBEDDING' ? (
              <div className={styles.embeddingBody}>
                <section className={styles.formSection}>
                  <div className={styles.sectionHeader}>
                    <strong>连接信息</strong>
                    <span>配置向量服务的模型、地址和访问密钥。</span>
                  </div>
                  <div className={`${styles.formGrid} ${styles.embeddingConnectionGrid}`}>
                    <Field label="模型名称" span="two" hint="例如 text-embedding-v4、bge-m3" emphasis>
                      <input
                        className={styles.input}
                        value={form.model_name || ''}
                        onChange={(event) => updateField('model_name', event.currentTarget.value)}
                        placeholder="text-embedding-v4"
                      />
                    </Field>
                    <Field label="向量维度" hint="当前固定为 1024">
                      <input className={styles.input} value="1024" readOnly />
                    </Field>
                    <Field label="API 地址" span="two" hint="填写兼容服务的 base URL" emphasis>
                      <input
                        className={styles.input}
                        value={form.api_base || ''}
                        onChange={(event) => updateField('api_base', event.currentTarget.value)}
                        placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
                      />
                    </Field>
                    <Field label="API Key" emphasis>
                      <input
                        className={styles.input}
                        type="password"
                        value={form.api_key || ''}
                        onChange={(event) => updateField('api_key', event.currentTarget.value)}
                        placeholder={form.id ? '留空表示不修改' : 'sk-...'}
                      />
                    </Field>
                  </div>
                </section>

                <AdvancedSettings
                  open={advancedOpen}
                  onToggle={() => setAdvancedOpen((value) => !value)}
                >
                  <section className={styles.formSection}>
                    <div className={styles.sectionHeader}>
                      <strong>向量化参数</strong>
                      <span>默认值已适配常见 embedding 服务，需要兼容特殊接口时再修改。</span>
                    </div>
                    <div className={`${styles.formGrid} ${styles.embeddingParamGrid}`}>
                      <Field label="输入字段" hint="多数 embedding 服务使用 input">
                        <input
                          className={styles.input}
                          value={form.input_field || ''}
                          onChange={(event) => updateField('input_field', event.currentTarget.value)}
                          placeholder="input"
                        />
                      </Field>
                      <Field label="批量字段">
                        <input
                          className={styles.input}
                          value={form.batch_input_field || ''}
                          onChange={(event) => updateField('batch_input_field', event.currentTarget.value)}
                          placeholder="input"
                        />
                      </Field>
                      <ToggleField
                        label="批量请求"
                        checked={!!form.supports_batch}
                        onChange={(value) => updateField('supports_batch', value)}
                        hint="支持批量时向量化更快。"
                      />
                      <Field label="批量大小">
                        <input
                          className={styles.input}
                          type="number"
                          min={1}
                          max={1000}
                          step={10}
                          value={form.embed_batch_size || 100}
                          onChange={(event) => updateField('embed_batch_size', Number(event.currentTarget.value))}
                        />
                      </Field>
                      <Field label="最大并发">
                        <input
                          className={styles.input}
                          type="number"
                          min={1}
                          max={50}
                          value={form.max_concurrency || 10}
                          onChange={(event) => updateField('max_concurrency', Number(event.currentTarget.value))}
                        />
                      </Field>
                    </div>
                  </section>

                  <section className={styles.formSection}>
                    <div className={styles.sectionHeader}>
                      <strong>高级请求参数</strong>
                      <span>只有服务商需要额外请求头或请求体字段时才填写。</span>
                    </div>
                    <div className={styles.advancedJsonGrid}>
                      <JsonConfigField
                        label="Extra Headers"
                        hint="追加到请求头的 JSON 对象。"
                        value={extraHeadersText}
                        onChange={setExtraHeadersText}
                        placeholder={'{\n  "Authorization": "Bearer xxx"\n}'}
                      />
                      <JsonConfigField
                        label="Extra Body"
                        hint="合并到请求体的 JSON 对象。"
                        value={extraBodyText}
                        onChange={setExtraBodyText}
                        placeholder={'{\n  "key": "value"\n}'}
                      />
                    </div>
                  </section>
                </AdvancedSettings>
              </div>
            ) : (
              <div className={styles.formGrid}>
                <Field label="模型名称" hint="例如 qwen-max、gpt-4.1" emphasis>
                  <input
                    className={styles.input}
                    value={form.model_name || ''}
                    onChange={(event) => updateField('model_name', event.currentTarget.value)}
                    placeholder="qwen-max"
                  />
                </Field>

                <Field label="API 格式">
                  <select
                    className={styles.input}
                    value={form.api_format || 'chat_completions'}
                    onChange={(event) => updateField('api_format', event.currentTarget.value)}
                  >
                    {API_FORMATS.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="上下文长度" hint="最小 32768 tokens">
                  <input
                    className={styles.input}
                    type="number"
                    min={MIN_CONTEXT_WINDOW}
                    max={2000000}
                    step={8192}
                    value={form.context_window || DEFAULT_CONTEXT_WINDOW}
                    onChange={(event) => updateField('context_window', Number(event.currentTarget.value))}
                  />
                </Field>

                <Field label="API 地址" span="two" hint="填写兼容服务的 base URL" emphasis>
                  <input
                    className={styles.input}
                    value={form.api_base || ''}
                    onChange={(event) => updateField('api_base', event.currentTarget.value)}
                    placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
                  />
                </Field>

                <Field label="API Key" emphasis>
                  <input
                    className={styles.input}
                    type="password"
                    value={form.api_key || ''}
                    onChange={(event) => updateField('api_key', event.currentTarget.value)}
                    placeholder={form.id ? '留空表示不修改' : 'sk-...'}
                  />
                </Field>

                <div className={styles.fieldSpanfull}>
                  <AdvancedSettings
                    open={advancedOpen}
                    onToggle={() => setAdvancedOpen((value) => !value)}
                  >
                    <div className={styles.formGrid}>
                      <Field label="思考参数" hint="不需要关闭思考时可留空">
                        <input
                          className={styles.input}
                          value={form.thinking_param || ''}
                          onChange={(event) => updateField('thinking_param', event.currentTarget.value)}
                          placeholder="enable_thinking"
                        />
                      </Field>
                      <ToggleField
                        label="关闭思考"
                        checked={form.thinking_value === false}
                        onChange={(value) => updateField('thinking_value', value ? false : true)}
                        hint="开启后会把该参数写为 false。"
                      />
                      <div className={`${styles.advancedJsonGrid} ${styles.fieldSpanfull}`}>
                        <JsonConfigField
                          label="Extra Headers"
                          hint="追加到请求头的 JSON 对象。"
                          value={extraHeadersText}
                          onChange={setExtraHeadersText}
                          placeholder={'{\n  "Authorization": "Bearer xxx"\n}'}
                        />
                        <JsonConfigField
                          label="Extra Body"
                          hint="合并到请求体的 JSON 对象。"
                          value={extraBodyText}
                          onChange={setExtraBodyText}
                          placeholder={'{\n  "temperature": 0.7,\n  "max_tokens": 2048\n}'}
                        />
                      </div>
                    </div>
                  </AdvancedSettings>
                </div>
              </div>
            )}

            {testResult && (
              <div className={styles.testResult} data-success={testResult.success ? 'true' : undefined}>
                {testResult.success ? <IconCircleCheckFilled size={16} /> : <IconAlertTriangle size={16} />}
                <span>{testResult.message || (testResult.success ? '连接测试成功' : '连接测试失败')}</span>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  )
}

function AdvancedSettings({
  open,
  onToggle,
  children
}: {
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div className={styles.advancedSettings} data-open={open ? 'true' : undefined}>
      <button
        type="button"
        className={styles.advancedToggle}
        onClick={onToggle}
        aria-expanded={open}
      >
        <span>
          <strong>高级设置</strong>
          <small>兼容特殊服务商参数，默认不用修改。</small>
        </span>
        <IconChevronDown size={15} stroke={1.8} />
      </button>
      {open && <div className={styles.advancedContent}>{children}</div>}
    </div>
  )
}

function JsonConfigField({
  label,
  hint,
  value,
  placeholder,
  onChange
}: {
  label: string
  hint: string
  value: string
  placeholder: string
  onChange: (value: string) => void
}) {
  return (
    <label className={styles.jsonField}>
      <span className={styles.jsonFieldHeader}>
        <span>
          <b>{label}</b>
          <small>{hint}</small>
        </span>
        <em>JSON</em>
      </span>
      <textarea
        className={styles.jsonTextarea}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={placeholder}
        spellCheck={false}
      />
    </label>
  )
}

function Field({
  label,
  hint,
  span = 'one',
  emphasis = false,
  children
}: {
  label: string
  hint?: string
  span?: FieldSpan
  emphasis?: boolean
  children: ReactNode
}) {
  return (
    <label className={[styles.field, styles[`fieldSpan${span}`], emphasis ? styles.fieldEmphasis : ''].filter(Boolean).join(' ')}>
      <span className={styles.fieldLabel}>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  )
}

function ToggleField({
  label,
  hint,
  checked,
  onChange
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <label className={`${styles.field} ${styles.toggleField}`}>
      <span className={styles.fieldLabel}>{label}</span>
      <span className={styles.toggleRow}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
        <span className={styles.switchTrack} />
        <span className={styles.toggleText}>{checked ? '开启' : '关闭'}</span>
      </span>
      {hint && <small>{hint}</small>}
    </label>
  )
}
