import { forwardRef, useEffect, useImperativeHandle, useMemo, useReducer, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Grid,
  NumberInput,
  PasswordInput,
  Select,
  Switch,
  Textarea,
  TextInput,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  IconMessageDots,
  IconCpu,
  IconChartHistogram,
  IconSettings,
  IconAdjustments,
  IconLink,
  IconLock,
  IconFileText,
  IconCircleCheckFilled,
  IconTrash,
  IconSend,
  IconPlugConnected,
} from '@tabler/icons-react'
import { useResponsive } from '@/hooks/use-responsive'
import { copyToClipboard } from '@/utils/clipboard'
import ModelTestResult from './ModelTestResult'
import styles from './ModelForm.module.scss'

// JSON 占位示例：含花括号，不能走 i18n（vue-i18n 会把 {} 当插值占位符报错），也无翻译价值
const PLACEHOLDER_EXTRA_HEADERS = '{"Authorization": "Bearer xxx"}'
const PLACEHOLDER_EXTRA_BODY = '{"temperature": 0.7, "max_tokens": 2048}'
const PLACEHOLDER_EXTRA_BODY_SHORT = '{"key": "value"}'

export interface ModelFormProps {
  modelForm: any
  formSubmitting?: boolean
  // edit 模式下，删除按钮可显示 loading；create 模式下无意义
  deleting?: boolean
  testLoading?: boolean
  testResult?: any
  showTestResult?: boolean
  extraHeadersText?: string
  extraBodyText?: string
  // 是否允许删除 EMBEDDING：系统级（admin）禁删（删了断语义搜索）；
  // 项目级删除=恢复系统默认（回退系统 embedding，安全），故项目设置页传 true
  embeddingDeletable?: boolean
  // 回调（对应 defineEmits）
  onTestConfig?: () => void
  onSubmit?: () => void
  onDelete?: () => void
  onExtraHeadersChange?: (value: string) => void
  onExtraBodyChange?: (value: string) => void
}

export interface ModelFormHandle {
  formRef: { validate: () => Promise<boolean> }
}

// ============ 角色 Hero 派生信息（按 category 切色/图标/标题）============
// PRIMARY/SECONDARY/EMBEDDING 用 yiw/yiw/teal 三套色调，强化"现在配什么"的辨识度
const ROLE_META: Record<string, { icon: any; theme: string; labelKey: string; descKey: string }> = {
  PRIMARY: { icon: IconMessageDots, theme: styles.rolePrimary, labelKey: 'models.tabs.chat', descKey: 'models.role.primaryDesc' },
  SECONDARY: { icon: IconCpu, theme: styles.roleSecondary, labelKey: 'models.tabs.operatorChat', descKey: 'models.role.secondaryDesc' },
  EMBEDDING: { icon: IconChartHistogram, theme: styles.roleEmbedding, labelKey: 'models.tabs.embedding', descKey: 'models.role.embeddingDesc' },
}

// 无对应 i18n key 时的中文 fallback（避免界面显示原始 key 路径）
const ROLE_DESC_FALLBACK: Record<string, string> = {
  PRIMARY: '主力对话模型，承担 NL2SQL / 多轮规划等核心任务',
  SECONDARY: '副模型（小型任务），用于语义算子、轻量结构化抽取',
  EMBEDDING: '向量检索基础设施，统一维度 1024',
}

const ModelForm = forwardRef<ModelFormHandle, ModelFormProps>(function ModelForm(props, ref) {
  const {
    modelForm,
    formSubmitting = false,
    deleting = false,
    testLoading = false,
    testResult = null,
    showTestResult = false,
    extraHeadersText = '',
    extraBodyText = '',
    embeddingDeletable = false,
    onTestConfig,
    onSubmit,
    onDelete,
    onExtraHeadersChange,
    onExtraBodyChange,
  } = props

  const { t } = useTranslation()
  const { isMobile } = useResponsive()

  // 父组件传入的 modelForm 是同一引用（对齐 Vue reactive 的"就地修改"语义）：
  // 这里就地写字段 + 强制本组件重渲染
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0)
  const setField = (key: string, value: any) => {
    modelForm[key] = value
    forceUpdate()
  }

  // 宽屏（≥1280px）双列布局；窄屏自动单列——避免 EMBEDDING 模式下左右卡片数差异大造成的视觉抖动
  // useResponsive 的 isDesktop 阈值是 1024 偏小（双列下两列各 ~500px 字段都被压窄）
  const [isWideScreen, setIsWideScreen] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const wideMql = window.matchMedia('(min-width: 1280px)')
    const handleWideChange = (e: MediaQueryListEvent) => setIsWideScreen(e.matches)
    wideMql.addEventListener('change', handleWideChange)
    setIsWideScreen(wideMql.matches)
    return () => wideMql.removeEventListener('change', handleWideChange)
  }, [])

  const layoutColSpan = isWideScreen ? 6 : 12

  // 角色 Hero 派生信息
  const meta = ROLE_META[modelForm.category] || ROLE_META.PRIMARY
  const CategoryIcon = meta.icon
  const roleThemeClass = meta.theme
  const categoryLabel = t(meta.labelKey)
  const categoryDesc = useMemo(() => {
    const m = ROLE_META[modelForm.category] || ROLE_META.PRIMARY
    const translated = t(m.descKey)
    // i18n 未定义时 $t 返回 key 路径自身——回落到 hardcoded 中文
    return translated === m.descKey ? ROLE_DESC_FALLBACK[modelForm.category] : translated
  }, [modelForm.category, t])

  // 处理额外配置的方法
  const handleExtraHeadersChange = (value: string) => {
    onExtraHeadersChange?.(value)
  }

  const handleExtraBodyChange = (value: string) => {
    onExtraBodyChange?.(value)
  }

  const handleTestConfig = () => {
    onTestConfig?.()
  }

  // 表单验证：对齐 element-plus modelRules（required + 长度 + EMBEDDING 维度）
  const validate = async (): Promise<boolean> => {
    const fail = (message: string) => {
      notifications.show({ color: 'red', message })
      return false
    }
    if (!modelForm.model_name) return fail(t('models.rules.modelName'))
    if (modelForm.model_name.length < 2 || modelForm.model_name.length > 100) {
      return fail(t('models.rules.modelNameLength'))
    }
    if (!modelForm.api_base) return fail(t('models.rules.apiBase'))
    // 只有 embedding 模型才需要向量维度
    if (modelForm.category === 'EMBEDDING' && !modelForm.dimension) {
      return fail(t('models.rules.dimension'))
    }
    return true
  }

  const handleSubmit = async () => {
    const valid = await validate()
    if (valid) {
      onSubmit?.()
    }
  }

  const handleDelete = () => {
    onDelete?.()
  }

  // 复制原始响应数据
  const handleCopyRawResponse = async (text: any) => {
    const success = await copyToClipboard(text)
    if (success) {
      notifications.show({ color: 'green', message: t('models.message.rawResponseCopied') })
    } else {
      notifications.show({ color: 'red', message: t('common.copyFailed') })
    }
  }

  // defineExpose({ formRef })：父组件可调用 formRef.validate()
  useImperativeHandle(ref, () => ({ formRef: { validate } }))

  return (
    <div className={styles.modelFormInline}>
      {/* 角色 Hero：按 category 切色（yiw/yiw/teal），强化"现在在配什么" */}
      <div className={`${styles.roleHero} ${roleThemeClass}`}>
        <div className={styles.roleHeroLeft}>
          <div className={styles.roleHeroIcon}>
            <CategoryIcon size={28} stroke={1.6} />
          </div>
          <div className={styles.roleHeroBody}>
            <div className={styles.roleHeroTitle}>{categoryLabel}</div>
            <div className={styles.roleHeroDesc}>{categoryDesc}</div>
          </div>
        </div>
        <div className={styles.roleHeroRight}>
          {modelForm.id ? (
            <span className={`${styles.roleStatus} ${styles.configured}`}>
              <IconCircleCheckFilled size={13} />
              {modelForm.model_name}
            </span>
          ) : (
            <span className={`${styles.roleStatus} ${styles.pending}`}>
              {t('models.status.unconfigured')}
            </span>
          )}
        </div>
      </div>

      <div className={styles.modelForm}>
        <Grid gutter={isMobile ? 0 : 20}>
          {/* 左列 */}
          <Grid.Col span={layoutColSpan}>
            {/* 基本配置卡片 */}
            <div className={styles.formCard}>
              <div className={styles.cardHeader}>
                <IconSettings size={15} stroke={1.6} />
                <span>{t('models.formCard.basic')}</span>
              </div>
              <div className={styles.cardContent}>
                <div className={styles.formItem}>
                  <TextInput
                    label={t('models.form.name')}
                    className={styles.formInput}
                    value={modelForm.model_name || ''}
                    onChange={(e) => setField('model_name', e.currentTarget.value)}
                    placeholder={t('models.placeholder.modelName')}
                    leftSection={<IconFileText size={16} stroke={1.6} />}
                  />
                </div>

                <div className={`${styles.formItem} ${styles.formItemApiBase}`}>
                  <TextInput
                    label={t('models.form.apiBase')}
                    className={styles.formInput}
                    value={modelForm.api_base || ''}
                    onChange={(e) => setField('api_base', e.currentTarget.value)}
                    placeholder={t('models.placeholder.apiBase')}
                    leftSection={<IconLink size={16} stroke={1.6} />}
                  />
                </div>

                <div className={styles.formItem}>
                  <PasswordInput
                    label={t('models.form.apiKey')}
                    className={styles.formInput}
                    value={modelForm.api_key || ''}
                    onChange={(e) => setField('api_key', e.currentTarget.value)}
                    placeholder={t('models.placeholder.apiKey')}
                    leftSection={<IconLock size={16} stroke={1.6} />}
                  />
                </div>

                {/* API 格式（对话模型）：决定请求端点 / 请求体 / 响应解析。Embedding 走 /embeddings 不适用 */}
                {modelForm.category !== 'EMBEDDING' && (
                  <div className={styles.formItem}>
                    <Select
                      label="API 格式"
                      className={styles.formInput}
                      value={modelForm.api_format || 'chat_completions'}
                      onChange={(v) => setField('api_format', v || 'chat_completions')}
                      allowDeselect={false}
                      checkIconPosition="right"
                      leftSection={<IconPlugConnected size={16} stroke={1.6} />}
                      data={[
                        { value: 'anthropic', label: 'Anthropic Messages (/v1/messages)' },
                        { value: 'chat_completions', label: 'Chat Completions (/chat/completions)' },
                        { value: 'responses', label: 'Responses (/responses)' },
                      ]}
                    />
                    <div className={styles.formItemTip}>
                      多数 OpenAI 兼容服务选 Chat Completions；Claude 原生选 Anthropic Messages；OpenAI 新版选 Responses。
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Embedding 批处理配置（仅 EMBEDDING 显示）。向量维度固定 1024 不暴露 UI */}
            {modelForm.category === 'EMBEDDING' && (
              <div className={styles.formCard}>
                <div className={styles.cardHeader}>
                  <IconAdjustments size={15} stroke={1.6} />
                  <span>{t('models.formCard.batch')}</span>
                </div>
                <div className={styles.cardContent}>
                  <div className={styles.formItem}>
                    <Switch
                      label={t('models.formLabel.supportsBatch')}
                      checked={!!modelForm.supports_batch}
                      onChange={(e) => setField('supports_batch', e.currentTarget.checked)}
                    />
                    <div className={styles.formItemTip}>{t('models.formTip.supportsBatch')}</div>
                  </div>
                  {modelForm.supports_batch && (
                    <Grid gutter={isMobile ? 0 : 16}>
                      <Grid.Col span={layoutColSpan}>
                        <div className={styles.formItem}>
                          <NumberInput
                            label={t('models.formLabel.batchSize')}
                            value={modelForm.embed_batch_size}
                            onChange={(v) => setField('embed_batch_size', v)}
                            min={1}
                            max={1000}
                            step={10}
                            placeholder="100"
                            style={{ width: '100%' }}
                          />
                          <div className={styles.formItemTip}>{t('models.formTip.batchSize')}</div>
                        </div>
                      </Grid.Col>
                      <Grid.Col span={layoutColSpan}>
                        <div className={styles.formItem}>
                          <TextInput
                            label={t('models.formLabel.batchInputField')}
                            value={modelForm.batch_input_field || ''}
                            onChange={(e) => setField('batch_input_field', e.currentTarget.value)}
                            placeholder="input"
                          />
                          <div className={styles.formItemTip}>{t('models.formTip.batchInputField')}</div>
                        </div>
                      </Grid.Col>
                    </Grid>
                  )}
                  <Grid gutter={isMobile ? 0 : 16}>
                    <Grid.Col span={layoutColSpan}>
                      <div className={styles.formItem}>
                        <NumberInput
                          label={t('models.formLabel.maxConcurrency')}
                          value={modelForm.max_concurrency}
                          onChange={(v) => setField('max_concurrency', v)}
                          min={1}
                          max={50}
                          step={1}
                          placeholder="10"
                          style={{ width: '100%' }}
                        />
                        <div className={styles.formItemTip}>{t('models.formTip.maxConcurrency')}</div>
                      </div>
                    </Grid.Col>
                  </Grid>
                </div>
              </div>
            )}
          </Grid.Col>

          {/* 右列 */}
          <Grid.Col span={layoutColSpan}>
            {/* CHAT额外配置卡片 */}
            {(modelForm.category === 'PRIMARY' || modelForm.category === 'SECONDARY') && (
              <div className={styles.formCard}>
                <div className={styles.cardHeader}>
                  <IconSettings size={15} stroke={1.6} />
                  <span>{t('models.formCard.extra')}</span>
                  <span className={styles.optionalLabel}>{t('models.formLabel.optional')}</span>
                </div>
                <div className={styles.cardContent}>
                  <div className={styles.formItem}>
                    <Textarea
                      label={t('models.formLabel.extraHeaders')}
                      className={styles.configTextarea}
                      value={extraHeadersText}
                      onChange={(e) => handleExtraHeadersChange(e.currentTarget.value)}
                      rows={3}
                      placeholder={PLACEHOLDER_EXTRA_HEADERS}
                    />
                  </div>

                  <div className={styles.formItem}>
                    <Textarea
                      label={t('models.formLabel.extraBody')}
                      className={styles.configTextarea}
                      value={extraBodyText}
                      onChange={(e) => handleExtraBodyChange(e.currentTarget.value)}
                      rows={3}
                      placeholder={PLACEHOLDER_EXTRA_BODY}
                    />
                  </div>

                  {/* 思考设置：参数名（支持点路径表达嵌套）+ 开关同一行；开关定值（已关闭思考=参数值 false，保留思考=true） */}
                  <div className={styles.thinkingTitle}>{t('models.formLabel.thinkingTitle')}</div>
                  <div className={styles.formItem}>
                    <div style={{ fontWeight: 600, color: 'var(--el-text-color-primary)', fontSize: 13, marginBottom: 6 }}>
                      {t('models.formLabel.thinkingParam')}
                    </div>
                    <div className={styles.thinkingRow}>
                      <TextInput
                        className={styles.thinkingParamInput}
                        value={modelForm.thinking_param || ''}
                        onChange={(e) => setField('thinking_param', e.currentTarget.value)}
                        placeholder="enable_thinking"
                      />
                      {/* active-value=false / inactive-value=true：checked 反向映射到 thinking_value */}
                      <Switch
                        checked={modelForm.thinking_value === false}
                        onChange={(e) => setField('thinking_value', e.currentTarget.checked ? false : true)}
                        onLabel={t('models.thinkingSwitch.on')}
                        offLabel={t('models.thinkingSwitch.off')}
                      />
                    </div>
                    <div className={styles.formItemTip}>{t('models.formTip.thinkingParam')}</div>
                  </div>
                </div>
              </div>
            )}

            {/* Embedding额外配置卡片 */}
            {modelForm.category === 'EMBEDDING' && (
              <div className={styles.formCard}>
                <div className={styles.cardHeader}>
                  <IconSettings size={15} stroke={1.6} />
                  <span>{t('models.formCard.extra')}</span>
                  <span className={styles.optionalLabel}>{t('models.formLabel.optional')}</span>
                </div>
                <div className={styles.cardContent}>
                  <div className={styles.formItem}>
                    <Textarea
                      label={t('models.formLabel.extraHeaders')}
                      className={styles.configTextarea}
                      value={extraHeadersText}
                      onChange={(e) => handleExtraHeadersChange(e.currentTarget.value)}
                      rows={3}
                      placeholder={PLACEHOLDER_EXTRA_HEADERS}
                    />
                  </div>

                  <div className={styles.formItem}>
                    <Textarea
                      label={t('models.formLabel.extraBody')}
                      className={styles.configTextarea}
                      value={extraBodyText}
                      onChange={(e) => handleExtraBodyChange(e.currentTarget.value)}
                      rows={3}
                      placeholder={PLACEHOLDER_EXTRA_BODY_SHORT}
                    />
                  </div>

                  <div className={styles.formItem}>
                    <TextInput
                      label={t('models.formLabel.inputField')}
                      value={modelForm.input_field || ''}
                      onChange={(e) => setField('input_field', e.currentTarget.value)}
                      placeholder="input"
                    />
                    <div className={styles.formItemTip}>{t('models.formTip.inputField')}</div>
                  </div>
                </div>
              </div>
            )}
          </Grid.Col>
        </Grid>

        {/* 测试连接：独立 form-card，跨列展示，视觉权重等同于配置卡 */}
        <div className={`${styles.formCard} ${styles.testCard}`}>
          <div className={styles.cardHeader}>
            <IconPlugConnected size={15} stroke={1.6} />
            <span>{t('models.test.testConfig')}</span>
            <span className={styles.cardHint}>{t('models.test.hint')}</span>
          </div>
          <div className={styles.cardContent}>
            <Button
              variant="light"
              loading={testLoading}
              onClick={handleTestConfig}
              disabled={
                !modelForm.api_base ||
                !modelForm.model_name ||
                (modelForm.category === 'EMBEDDING' && !modelForm.dimension)
              }
              leftSection={<IconSend size={16} stroke={1.6} />}
            >
              {testLoading ? t('models.test.testing') : t('models.test.testConfig')}
            </Button>

            <ModelTestResult
              result={testResult}
              showResult={showTestResult}
              category={modelForm.category}
              onCopyRawResponse={handleCopyRawResponse}
            />
          </div>
        </div>
      </div>

      {/* Sticky 底部操作栏：删除（左下）+ 主操作（右下）
          系统级 EMBEDDING 是向量检索基础设施，删了会让所有语义搜索/向量查询断，故不暴露删除（只能编辑替换）。
          项目级 EMBEDDING 删除=恢复系统默认（回退系统 embedding，安全），由 embeddingDeletable 放开。 */}
      <div className={styles.modelFormFooter}>
        {modelForm.id && (modelForm.category !== 'EMBEDDING' || embeddingDeletable) && (
          <Button
            variant="light"
            color="red"
            onClick={handleDelete}
            loading={deleting}
            className={styles.btnDelete}
            leftSection={<IconTrash size={14} stroke={1.6} />}
          >
            {t('common.delete')}
          </Button>
        )}
        <div className={styles.footerSpacer} />
        <Button onClick={handleSubmit} loading={formSubmitting} className={styles.btnSubmit}>
          {t('common.save')}
        </Button>
      </div>
    </div>
  )
})

export default ModelForm
