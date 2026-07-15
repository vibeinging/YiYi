import { useEffect, useRef, useState } from 'react'
import {
  Badge,
  Button,
  LoadingOverlay,
  PasswordInput,
  Radio,
  Select,
  Textarea,
  TextInput
} from '@mantine/core'
import { useForm } from '@mantine/form'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import { useTranslation } from 'react-i18next'
import ElSvgIcon from '@/components/ElSvgIcon'
import {
  listWebSearchModelsReq,
  createWebSearchModelReq,
  testWebSearchModelReq,
  deleteWebSearchModelReq,
  getWebSearchModelTypesReq,
  inferWebSearchResponseMappingsReq
} from '@/api/web_search_models'
import WebSearchDetailRaw from './WebSearchDetail'
import styles from './WebSearchDataSourceListView.module.scss'

// WebSearchDetail 尚未迁移(仍为 stub)，先 as any 透传 props(project-id/websearch-model/back/updated/deleted)
const WebSearchDetail = WebSearchDetailRaw as any

// 创建配置时选 SerpApi 填占位 API KEY（后端搜索用固定 key）
const SERPAPI_UI_PLACEHOLDER_API = '570d******+**************************************************1111'

// 预设搜索引擎的 API 地址映射
const PRESET_ENDPOINTS: Record<string, string> = {
  '博查': 'https://api.bocha.cn/v1/web-search',
  'Serper': 'https://google.serper.dev/search',
  'Tavily': 'https://api.tavily.com/search',
  'Perplexity': 'https://api.perplexity.ai/search',
  'SerpApi': 'https://serpapi.com/search?engine=google_scholar'
}

const ENGINE_KEY_MAP: Record<string, string> = {
  '博查': 'bocha',
  Bocha: 'bocha',
  Serper: 'serper',
  Tavily: 'tavily',
  Perplexity: 'perplexity',
  SerpApi: 'serpapi',
  custom: 'custom'
}

interface WebSearchDataSourceListViewProps {
  projectId: string
  initialItemId?: string
  // defineEmits(['item-selected', 'selection-change']) → 回调 props
  onItemSelected?: (item: any) => void
  onSelectionChange?: (id: string | null) => void
}

export default function WebSearchDataSourceListView({
  projectId,
  initialItemId = '',
  onItemSelected,
  onSelectionChange
}: WebSearchDataSourceListViewProps) {
  const { t, i18n } = useTranslation()
  // te → i18n.exists；locale → i18n.language
  const te = (key: string) => i18n.exists(key)

  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [testing, setTesting] = useState(false)

  const [dataList, setDataList] = useState<any[]>([])
  const [selectedItem, setSelectedItem] = useState<any>(null)
  const [isCreating, setIsCreating] = useState(false)

  const [searchModelOptions, setSearchModelOptions] = useState<any[]>([])

  // dataList 最新值用 ref 暴露给异步闭包(loadList 后立即查找)
  const dataListRef = useRef<any[]>([])
  dataListRef.current = dataList

  // 上一次选中的搜索引擎(用于 SerpApi 占位 key 切换逻辑)
  const createFormPrevEngine = useRef('')

  // 表单 + 校验规则
  const form = useForm({
    initialValues: {
      name: '',
      model: '',
      api: '',
      description: '',
      // 自定义模式字段
      customEndpoint: '',
      customMethod: 'GET',
      requestParamsJson: '',
      responseMappingsJson: ''
    },
    validate: {
      name: (value: string) => (!value ? t('webSearch.msg.enterConfigName') : null),
      model: (value: string) => (!value ? t('webSearch.msg.selectSearchEngine') : null),
      // 自定义模式 API KEY 可选，预设模式必填
      api: (value: string, values: any) =>
        values.model !== 'custom' && !value ? t('webSearch.msg.enterApiKey') : null
    }
  })

  // 格式化日期
  const formatDate = (dateStr: any) => {
    if (!dateStr) return '-'
    const date = new Date(dateStr)
    return date.toLocaleDateString(i18n.language === 'zh' ? 'zh-CN' : 'en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    })
  }

  // 搜索引擎标签颜色
  const getModelTagType = (model: any) => {
    const typeMap: Record<string, string> = {
      '博查': 'primary',
      Bocha: 'primary',
      'Serper': 'success',
      'SerpApi': 'success',
      'Tavily': 'warning',
      'Perplexity': 'danger',
      'OpenAI': 'info'
    }
    return typeMap[model] || 'info'
  }

  // el-tag type → Mantine Badge color
  const tagColorMap: Record<string, string> = {
    primary: 'blue',
    success: 'green',
    warning: 'orange',
    danger: 'red',
    info: 'gray'
  }
  const getBadgeColor = (model: any) => tagColorMap[getModelTagType(model)] || 'gray'

  const getEngineKey = (model: any) => ENGINE_KEY_MAP[model] || String(model || '').toLowerCase()

  const getLocalizedEngineLabel = (model: any) => {
    const key = getEngineKey(model)
    const i18nKey = `webSearch.engineLabels.${key}`
    return te(i18nKey) ? t(i18nKey) : model
  }

  // 获取预设 API 地址
  const getPresetUrl = (model: any) => {
    return PRESET_ENDPOINTS[model] || ''
  }

  // 获取预设描述
  const getPresetDescription = (model: any) => {
    const key = getEngineKey(model)
    const i18nKey = `webSearch.engineDescriptions.${key}`
    return te(i18nKey) ? t(i18nKey) : ''
  }

  const getLocalizedEngineDescription = (model: any) => {
    const key = getEngineKey(model)
    const i18nKey = `webSearch.engineDescriptions.${key}`
    return te(i18nKey) ? t(i18nKey) : ''
  }

  // 搜索引擎切换处理
  const handleModelChange = (value: string | null) => {
    const v = value || ''
    const prev = createFormPrevEngine.current
    // 切换搜索引擎时清空自定义配置
    if (v !== 'custom') {
      form.setFieldValue('customEndpoint', getPresetUrl(v))
      form.setFieldValue('customMethod', 'GET')
      form.setFieldValue('requestParamsJson', '')
      form.setFieldValue('responseMappingsJson', '')
    }
    if (v === 'SerpApi') {
      form.setFieldValue('api', SERPAPI_UI_PLACEHOLDER_API)
    } else if (prev === 'SerpApi') {
      form.setFieldValue('api', '')
    }
    createFormPrevEngine.current = v
  }

  // 加载支持的搜索引擎类型
  const loadModelTypes = async () => {
    try {
      const res: any = await getWebSearchModelTypesReq()
      if (!res.success) {
        notifications.show({ color: 'red', message: res.msg || t('webSearch.msg.fetchTypesFailed') })
        return
      }
      setSearchModelOptions(res.data?.items || [])
    } catch (err) {
      console.error('加载搜索引擎类型失败:', err)
      notifications.show({ color: 'red', message: t('webSearch.msg.fetchTypesFailed') })
    }
  }

  // 加载列表
  const loadList = async (autoSelectId: any = null) => {
    if (!projectId) return

    setLoading(true)
    try {
      const res: any = await listWebSearchModelsReq(projectId)
      const items = res.data?.items || []
      setDataList(items)
      dataListRef.current = items

      if (autoSelectId) {
        const found = items.find((item: any) => item.id === autoSelectId)
        if (found) {
          setSelectedItem(found)
        }
      }
    } catch (err) {
      console.error('加载列表失败:', err)
      notifications.show({ color: 'red', message: t('webSearch.msg.loadListFailed') })
    } finally {
      setLoading(false)
    }
  }

  // 选择项目
  const selectItem = (item: any) => {
    setSelectedItem(item)
    onItemSelected?.(item)
    onSelectionChange?.(item?.id || null)
  }

  // 返回列表
  const backToList = () => {
    setSelectedItem(null)
    setIsCreating(false)
    onSelectionChange?.(null)
    loadList()
  }

  // 重置表单
  const resetForm = () => {
    form.setValues({
      name: '',
      model: '',
      api: '',
      description: '',
      customEndpoint: '',
      customMethod: 'GET',
      requestParamsJson: '',
      responseMappingsJson: ''
    })
    createFormPrevEngine.current = ''
    form.clearErrors()
  }

  // 开始创建
  const startCreate = () => {
    setIsCreating(true)
    resetForm()
    loadModelTypes()
  }

  // 取消创建
  const cancelCreate = () => {
    setIsCreating(false)
    resetForm()
  }

  // 提交
  const handleSubmit = async () => {
    const validation = form.validate()
    if (validation.hasErrors) return

    const f = form.values
    setSubmitting(true)
    try {
      // 在名称前添加搜索引擎类型前缀（如果还没有）
      const finalName = f.name.startsWith(f.model + ' - ') ? f.name : `${f.model} - ${f.name}`

      // 解析请求参数 & 响应解析 JSON（所有引擎通用）
      let requestParams: any = {}
      let responseMappings: any = {}
      try {
        if (f.requestParamsJson && f.requestParamsJson.trim()) {
          requestParams = JSON.parse(f.requestParamsJson)
        }
      } catch (err) {
        notifications.show({ color: 'red', message: t('webSearch.msg.invalidJsonParams') })
        setSubmitting(false)
        return
      }
      try {
        if (f.responseMappingsJson && f.responseMappingsJson.trim()) {
          responseMappings = JSON.parse(f.responseMappingsJson)
        }
      } catch (err) {
        notifications.show({ color: 'red', message: t('webSearch.msg.responseMappingJsonError') })
        setSubmitting(false)
        return
      }

      // 准备提交数据
      const submitData: any = {
        name: finalName,
        model: f.model,
        api: f.api || null, // 两个模式下都支持空值
        description: f.description || null,
        config_type: f.model === 'custom' ? 'custom' : 'preset',
        custom_config: {
          endpoint: f.customEndpoint || null,
          method: f.customMethod || 'GET',
          request_params: requestParams,
          response_mappings: responseMappings
        }
      }

      // 自定义模式必须填写 API 地址
      if (f.model === 'custom' && !submitData.custom_config.endpoint) {
        notifications.show({ color: 'yellow', message: t('webSearch.msg.enterApiAddress') })
        setSubmitting(false)
        return
      }

      if (f.model !== 'custom') {
        // 预设模式需要 API KEY
        if (!f.api) {
          notifications.show({ color: 'yellow', message: t('webSearch.msg.enterApiKey') })
          setSubmitting(false)
          return
        }
      }

      const res: any = await createWebSearchModelReq(projectId, submitData)

      if (res.success) {
        notifications.show({ color: 'green', message: res.msg || t('webSearch.msg.createSuccess') })
        setIsCreating(false)
        await loadList()

        if (res.data?.id) {
          // 创建后选中新创建的项
          const newItem = dataListRef.current.find((d: any) => d.id === res.data.id)
          if (newItem) {
            setSelectedItem(newItem)
            onItemSelected?.(newItem)
          }
        }

        resetForm()
      } else {
        notifications.show({ color: 'red', message: res.msg || t('webSearch.msg.createFailed') })
      }
    } catch (err) {
      console.error('创建失败:', err)
      notifications.show({ color: 'red', message: t('webSearch.msg.createFailed') })
    } finally {
      setSubmitting(false)
    }
  }

  // 测试连接
  const handleTestConnection = async () => {
    const f = form.values
    if (!f.model) {
      notifications.show({ color: 'yellow', message: t('webSearch.msg.selectSearchEngineFirst') })
      return
    }

    // 预设模式需要 API KEY
    if (f.model !== 'custom' && !f.api) {
      notifications.show({ color: 'yellow', message: t('webSearch.msg.enterApiKeyFirst') })
      return
    }

    // 如果是自定义模式，验证必填字段
    if (f.model === 'custom' && !f.customEndpoint) {
      notifications.show({ color: 'yellow', message: t('webSearch.msg.enterCustomApiAddress') })
      return
    }

    setTesting(true)
    try {
      const testData: any = {
        model: f.model,
        name: f.name || `${f.model} - ${t('webSearch.testConnection')}`,
        api: f.api || null, // 两个模式下都支持空值
        config_type: f.model === 'custom' ? 'custom' : 'preset'
      }

      // 如果是自定义模式，添加 custom_config
      if (f.model === 'custom') {
        try {
          // 解析请求参数 JSON，如果为空则使用空对象
          let requestParams: any = {}
          if (f.requestParamsJson && f.requestParamsJson.trim()) {
            requestParams = JSON.parse(f.requestParamsJson)
          }

          testData.custom_config = {
            endpoint: f.customEndpoint,
            method: f.customMethod,
            // 请求参数配置
            request_params: requestParams
          }
        } catch (err) {
          notifications.show({ color: 'red', message: t('webSearch.msg.invalidJsonParams') })
          setTesting(false)
          return
        }
      }

      const res: any = await testWebSearchModelReq(projectId, testData)

      if (res.success) {
        notifications.show({ color: 'green', message: t('webSearch.msg.connectionSuccess') })
        // 自定义模式且返回了原始响应时，自动推断并填入响应解析
        const rawResponse = res.data?.data?.raw_response
        if (f.model === 'custom' && rawResponse) {
          let suggested: any = null
          try {
            const inferRes: any = await inferWebSearchResponseMappingsReq(projectId, {
              raw_response: rawResponse
            })
            if (inferRes?.success) {
              suggested = inferRes.data?.response_mappings || null
            }
          } catch (_) {
            // LLM 推断失败，不回退
          }

          if (suggested) {
            form.setFieldValue('responseMappingsJson', JSON.stringify(suggested, null, 2))
            notifications.show({ color: 'green', message: t('webSearch.msg.autoInferSuccess') })
          } else {
            notifications.show({ color: 'yellow', message: t('webSearch.msg.autoInferFailed') })
          }
        }
      } else {
        notifications.show({ color: 'red', message: res.msg || t('webSearch.msg.connectionFailed') })
      }
    } catch (err) {
      console.error('测试连接失败:', err)
      notifications.show({ color: 'red', message: t('webSearch.msg.connectionFailed') })
    } finally {
      setTesting(false)
    }
  }

  // 删除
  const handleDelete = (item: any) => {
    modals.openConfirmModal({
      title: t('webSearch.msg.deleteConfirm'),
      children: t('webSearch.msg.deleteConfirmMsg', { name: item.name }),
      labels: { confirm: t('common.confirm'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await deleteWebSearchModelReq(projectId, item.id)
          notifications.show({ color: 'green', message: t('webSearch.msg.deleteSuccess') })
          await loadList()
        } catch (err: any) {
          console.error('删除失败:', err)
          const errorMessage =
            err?.response?.data?.message || err?.response?.data?.msg || err?.message || err?.msg
          if (errorMessage) {
            notifications.show({ color: 'red', message: errorMessage })
          } else {
            notifications.show({ color: 'red', message: t('webSearch.msg.deleteFailed') })
          }
        }
      }
    })
  }

  // 更新
  const handleItemUpdated = async () => {
    await loadList()
  }

  // 删除后
  const handleItemDeleted = async () => {
    setSelectedItem(null)
    onSelectionChange?.(null)
    await loadList()
  }

  // 监听 projectId 变化（含首次加载，对应原 watch immediate）
  const prevProjectIdRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const newId = projectId
    const oldId = prevProjectIdRef.current
    prevProjectIdRef.current = newId
    if (newId) {
      const autoSelectId = !oldId && initialItemId ? initialItemId : null
      if (!autoSelectId) {
        setSelectedItem(null)
      }
      loadList(autoSelectId)
      setIsCreating(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // 初始化(对应原 setup 末尾的 loadModelTypes())
  useEffect(() => {
    loadModelTypes()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const model = form.values.model

  return (
    <div className="ad-page-list">
      {/* 列表视图 */}
      {!selectedItem && !isCreating ? (
        <>
          {dataList.length > 0 && (
            <div className="ad-page-toolbar">
              <span className="toolbar-count">
                {t('webSearch.configCount', { count: dataList.length })}
              </span>
              <div className="toolbar-actions">
                <Button onClick={startCreate} leftSection={<ElSvgIcon name="Plus" size={16} />}>
                  {t('webSearch.createConfig')}
                </Button>
              </div>
            </div>
          )}

          <div className="ad-page-content ad-card-grid" style={{ position: 'relative' }}>
            <LoadingOverlay visible={loading} />
            {dataList.map((item) => (
              <div key={item.id} className="ad-grid-card" onClick={() => selectItem(item)}>
                <div className="grid-card-header">
                  <div className="grid-card-title">
                    <ElSvgIcon name="Connection" size={18} color="#17483e" />
                    <span>{item.name}</span>
                    <Badge color={getBadgeColor(item.model)} size="sm">
                      {getLocalizedEngineLabel(item.model)}
                    </Badge>
                  </div>
                  <div className="grid-card-actions" onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="subtle"
                      size="compact-sm"
                      onClick={() => selectItem(item)}
                      leftSection={<ElSvgIcon name="Edit" size={14} />}
                    >
                      {t('common.manage')}
                    </Button>
                    <Button
                      variant="subtle"
                      color="red"
                      size="compact-sm"
                      onClick={() => handleDelete(item)}
                      leftSection={<ElSvgIcon name="Delete" size={14} />}
                    >
                      {t('common.delete')}
                    </Button>
                  </div>
                </div>
                <div className="grid-card-body">
                  {item.description ? (
                    <div className="grid-card-desc">{item.description}</div>
                  ) : (
                    <div className={`grid-card-desc ${styles.textMuted}`}>
                      {t('webSearch.noDescription')}
                    </div>
                  )}
                </div>
                <div className="grid-card-footer">
                  <span>
                    {t('webSearch.createdAt')} {formatDate(item.created_at)}
                  </span>
                </div>
              </div>
            ))}

            {/* 空状态 */}
            {!loading && dataList.length === 0 && (
              <div className={`ad-page-empty ${styles.websearchEmpty}`}>
                <div className={styles.emptyIllustration}>
                  <div className={styles.illustrationContainer}>
                    <div className={`${styles.webIcon} ${styles.tavily}`}>
                      <ElSvgIcon name="Search" size={20} color="#fff" />
                    </div>
                    <div className={`${styles.webIcon} ${styles.serper}`}>
                      <ElSvgIcon name="Position" size={20} color="#006064" />
                    </div>
                    <div className={styles.centerHub}>
                      <ElSvgIcon name="Promotion" size={26} color="#fff" />
                    </div>
                  </div>
                </div>
                <div className={styles.emptyContent}>
                  <h3 className={styles.emptyTitle}>{t('webSearch.emptyTitle')}</h3>
                  <p className={styles.emptyDesc}>{t('webSearch.emptyDesc')}</p>
                  <div className={styles.emptyFeatures}>
                    <div className={styles.featureItem}>
                      <ElSvgIcon name="Connection" size={16} color="#17483e" />
                      <span>{t('webSearch.featureMultiEngine')}</span>
                    </div>
                    <div className={styles.featureItem}>
                      <ElSvgIcon name="Search" size={16} color="#17483e" />
                      <span>{t('webSearch.featureRealtime')}</span>
                    </div>
                    <div className={styles.featureItem}>
                      <ElSvgIcon name="Promotion" size={16} color="#17483e" />
                      <span>{t('webSearch.featureSmartIntegration')}</span>
                    </div>
                  </div>
                  <Button
                    size="lg"
                    onClick={startCreate}
                    leftSection={<ElSvgIcon name="Plus" size={18} />}
                  >
                    {t('webSearch.createConfig')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </>
      ) : isCreating ? (
        /* 创建视图 */
        <div className={styles.createContent}>
          <div className={styles.createFormCard}>
            <div className={styles.formIcon}>
              <div className={styles.iconCircle}>
                <ElSvgIcon name="Connection" size={36} color="#fff" />
              </div>
            </div>
            <div className={styles.formHeader}>
              <h3>{t('webSearch.createConfigTitle')}</h3>
              <p>{t('webSearch.createConfigDesc')}</p>
            </div>
            <form className={styles.businessForm} onSubmit={form.onSubmit(() => handleSubmit())}>
              <TextInput
                label={t('webSearch.dataSourceName')}
                placeholder={t('webSearch.dataSourceNamePlaceholder')}
                size="lg"
                mb="md"
                {...form.getInputProps('name')}
              />

              <Select
                label={t('webSearch.searchEngine')}
                placeholder={t('webSearch.selectSearchEngine')}
                size="lg"
                mb="md"
                style={{ width: '100%' }}
                data={searchModelOptions.map((option: any) => ({
                  value: option.value,
                  label: getLocalizedEngineLabel(option.value)
                }))}
                renderOption={({ option }: any) => (
                  <span>
                    <span style={{ fontWeight: 500 }}>{getLocalizedEngineLabel(option.value)}</span>
                    {getLocalizedEngineDescription(option.value) && (
                      <span style={{ color: '#999', fontSize: 12, marginLeft: 8 }}>
                        - {getLocalizedEngineDescription(option.value)}
                      </span>
                    )}
                  </span>
                )}
                {...form.getInputProps('model')}
                onChange={(value) => {
                  form.setFieldValue('model', value || '')
                  handleModelChange(value)
                }}
              />

              {/* API 地址：预设和自定义模式都可编辑 */}
              <TextInput
                label={t('webSearch.apiEndpoint')}
                placeholder={
                  model === 'custom'
                    ? t('webSearch.customEndpointPlaceholder')
                    : getPresetUrl(model)
                }
                size="lg"
                {...form.getInputProps('customEndpoint')}
              />
              <div className={styles.formTip} style={{ marginTop: 6, marginBottom: 24 }}>
                <ElSvgIcon name="InfoFilled" size={14} />
                <span>
                  {model === 'custom'
                    ? t('webSearch.customApiDesc1')
                    : getPresetDescription(model)}
                </span>
              </div>

              {/* API KEY：预设模式必填，自定义模式可选 */}
              <PasswordInput
                label={t('webSearch.apiKey')}
                placeholder={
                  model === 'custom'
                    ? t('webSearch.apiKeyOptionalPlaceholder')
                    : t('webSearch.apiKeyRequiredPlaceholder')
                }
                size="lg"
                mb="md"
                {...form.getInputProps('api')}
              />

              {/* 自定义配置：仅自定义模式显示 */}
              {model === 'custom' && (
                <>
                  {/* 请求方法 */}
                  <Radio.Group
                    label={t('webSearch.requestMethod')}
                    mb="md"
                    {...form.getInputProps('customMethod')}
                  >
                    <Radio value="GET" label="GET" mt="xs" />
                    <Radio value="POST" label="POST" mt="xs" />
                  </Radio.Group>

                  {/* 请求参数配置 */}
                  <div className={styles.formItem}>
                    <div className={styles.formLabel}>{t('webSearch.requestParams')}</div>
                    <div className={styles.formWithTipRow}>
                      <Textarea
                        rows={4}
                        size="lg"
                        placeholder={'{"query": "{{query}}", "limit": {{limit}}}'}
                        style={{ flex: 1 }}
                        {...form.getInputProps('requestParamsJson')}
                      />
                      <div className={`${styles.formTip} ${styles.inlineTip}`}>
                        <ElSvgIcon name="InfoFilled" size={14} />
                        <span>{t('webSearch.requestParamsTip')}</span>
                      </div>
                    </div>
                  </div>

                  {/* 响应解析 */}
                  <div className={styles.formItem}>
                    <div className={styles.formLabel}>{t('webSearch.responseMapping')}</div>
                    <div className={styles.formWithTipRow}>
                      <Textarea
                        rows={4}
                        size="lg"
                        placeholder={
                          '{"results_path": "data.items[*]", "title": "title", "url": "url"}'
                        }
                        style={{ flex: 1 }}
                        {...form.getInputProps('responseMappingsJson')}
                      />
                      <div className={`${styles.formTip} ${styles.inlineTip}`}>
                        <ElSvgIcon name="InfoFilled" size={14} />
                        <span>{t('webSearch.responseMappingAutoHint')}</span>
                      </div>
                    </div>
                  </div>
                </>
              )}

              <Textarea
                label={t('webSearch.descriptionLabel')}
                placeholder={t('webSearch.descriptionPlaceholder')}
                rows={3}
                mb="md"
                {...form.getInputProps('description')}
              />

              <div className={styles.formActions}>
                <Button
                  type="submit"
                  loading={submitting}
                  size="lg"
                  leftSection={<ElSvgIcon name="Plus" size={16} />}
                >
                  {t('webSearch.createConfig')}
                </Button>
                <Button
                  variant="default"
                  type="button"
                  loading={testing}
                  size="lg"
                  onClick={handleTestConnection}
                >
                  {t('webSearch.testConnection')}
                </Button>
                <Button variant="default" type="button" size="lg" onClick={cancelCreate}>
                  {t('common.cancel')}
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : (
        /* 详情视图 */
        <WebSearchDetail
          projectId={projectId}
          websearchModel={selectedItem}
          onBack={backToList}
          onUpdated={handleItemUpdated}
          onDeleted={handleItemDeleted}
        />
      )}
    </div>
  )
}
