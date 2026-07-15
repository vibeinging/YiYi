import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  Radio,
  Select,
  Tabs,
  TextInput,
  Textarea,
} from '@mantine/core'
import { useForm } from '@mantine/form'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import ElSvgIcon from '@/components/ElSvgIcon'
import {
  getWebSearchModelReq,
  updateWebSearchModelReq,
  deleteWebSearchModelReq,
  testWebSearchModelReq,
  getWebSearchModelTypesReq,
  inferWebSearchResponseMappingsReq,
} from '@/api/web_search_models'
import WebSearchQATestDialog from '@/views/web_search_models/components/WebSearchQATestDialog'
import { te } from '@/lang'
import styles from './WebSearchDetail.module.scss'

export interface WebSearchDetailProps {
  projectId: string
  websearchModel: any
  // defineEmits(['back', 'updated', 'deleted']) → 回调 props
  onBack?: () => void
  onUpdated?: (data: any) => void
  onDeleted?: () => void
}

// 预设搜索引擎的 API 地址映射
const PRESET_ENDPOINTS: Record<string, string> = {
  博查: 'https://api.bocha.cn/v1/web-search',
  Serper: 'https://google.serper.dev/search',
  Tavily: 'https://api.tavily.com/search',
  Perplexity: 'https://api.perplexity.ai/search',
  SerpApi: 'https://serpapi.com/search?engine=google_scholar',
}

const ENGINE_KEY_MAP: Record<string, string> = {
  博查: 'bocha',
  Bocha: 'bocha',
  Serper: 'serper',
  Tavily: 'tavily',
  Perplexity: 'perplexity',
  SerpApi: 'serpapi',
  custom: 'custom',
}

interface WebSearchForm {
  id: string
  name: string
  model: string
  api: string
  description: string
  config_type: string
  // 自定义模式字段
  customEndpoint: string
  customMethod: string
  requestParamsJson: string
  responseMappingsJson: string
}

// el-tag type → Mantine Badge color 映射
const TAG_TYPE_TO_COLOR: Record<string, string> = {
  primary: 'blue',
  success: 'green',
  warning: 'yellow',
  danger: 'red',
  info: 'gray',
}

export default function WebSearchDetail({
  projectId,
  websearchModel,
  onBack,
  onUpdated,
  onDeleted,
}: WebSearchDetailProps) {
  const { t, i18n } = useTranslation()

  const [activeTab, setActiveTab] = useState<string | null>('info')
  const [testing, setTesting] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [showApi, setShowApi] = useState(false)
  const [qaTestDialogVisible, setQaTestDialogVisible] = useState(false)

  const [searchModelOptions, setSearchModelOptions] = useState<any[]>([])

  const form = useForm<WebSearchForm>({
    initialValues: {
      id: '',
      name: '',
      model: '',
      api: '',
      description: '',
      config_type: 'preset',
      customEndpoint: '',
      customMethod: 'GET',
      requestParamsJson: '',
      responseMappingsJson: '',
    },
    validate: {
      name: (value) => (value ? null : t('webSearch.dataSourceNamePlaceholder')),
      model: (value) => (value ? null : t('webSearch.selectSearchEngine')),
      // api 仅在非 custom 模式必填
      api: (value, values) =>
        values.model === 'custom' || value ? null : t('webSearch.apiKeyRequiredPlaceholder'),
    },
  })

  // 搜索引擎标签颜色
  const getModelTagType = (model: any): string => {
    const typeMap: Record<string, string> = {
      博查: 'primary',
      Bocha: 'primary',
      Serper: 'success',
      SerpApi: 'success',
      Tavily: 'warning',
      Perplexity: 'danger',
      OpenAI: 'info',
    }
    return typeMap[model] || 'info'
  }

  const getModelTagColor = (model: any): string =>
    TAG_TYPE_TO_COLOR[getModelTagType(model)] || 'gray'

  const getEngineKey = (model: any): string =>
    ENGINE_KEY_MAP[model] || String(model || '').toLowerCase()

  const getLocalizedEngineLabel = (model: any): string => {
    const key = getEngineKey(model)
    const i18nKey = `webSearch.engineLabels.${key}`
    return te(i18nKey) ? t(i18nKey) : model
  }

  // 格式化日期时间
  const formatDateTime = (dateStr: any): string => {
    if (!dateStr) return '-'
    const date = new Date(dateStr)
    return date.toLocaleString(i18n.language === 'zh' ? 'zh-CN' : 'en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  // 隐藏 API
  const maskApi = (api: any): string => {
    if (!api) return '-'
    if (showApi) return api
    if (api.length <= 8) return '*'.repeat(api.length)
    return api.substring(0, 4) + '*'.repeat(api.length - 8) + api.substring(api.length - 4)
  }

  // 获取预设 API 地址
  const getPresetUrl = (model: any): string => PRESET_ENDPOINTS[model] || ''

  // 获取预设描述
  const getPresetDescription = (model: any): string => {
    const key = getEngineKey(model)
    const i18nKey = `webSearch.engineDescriptions.${key}`
    return te(i18nKey) ? t(i18nKey) : ''
  }

  const getLocalizedEngineDescription = (model: any): string => {
    const key = getEngineKey(model)
    const i18nKey = `webSearch.engineDescriptions.${key}`
    return te(i18nKey) ? t(i18nKey) : ''
  }

  // 搜索引擎切换处理
  const handleModelChange = (value: string | null) => {
    const v = value || ''
    form.setFieldValue('model', v)
    // 切换搜索引擎时，如果是切换到 preset，清空自定义配置
    if (v !== 'custom') {
      form.setFieldValue('config_type', 'preset')
      form.setFieldValue('customEndpoint', getPresetUrl(v))
      form.setFieldValue('customMethod', 'GET')
      form.setFieldValue('requestParamsJson', '')
      form.setFieldValue('responseMappingsJson', '')
    } else {
      form.setFieldValue('config_type', 'custom')
    }
  }

  // 加载支持的搜索引擎类型
  const loadModelTypes = async () => {
    if (!projectId) {
      setSearchModelOptions([])
      return
    }
    try {
      const res: any = await getWebSearchModelTypesReq()
      if (!res.success) {
        notifications.show({ color: 'red', message: res.msg || t('webSearch.msg.loadTypesFailed') })
        return
      }
      const items = res.data?.items || []
      setSearchModelOptions(
        items.map((item: any) => ({
          ...item,
          label: item.label ?? item.value,
        }))
      )
    } catch (err) {
      console.error('加载搜索引擎类型失败:', err)
      notifications.show({ color: 'red', message: t('webSearch.msg.loadTypesFailed') })
    }
  }

  // 加载详情
  const loadDetail = async () => {
    if (!projectId || !websearchModel?.id) return
    try {
      const res: any = await getWebSearchModelReq(projectId, websearchModel.id)
      if (res.success && res.data) {
        form.setValues((prev) => ({
          ...prev,
          id: res.data.id,
          name: res.data.name,
          model: res.data.model,
          api: res.data.api || '',
          description: res.data.description || '',
          config_type: res.data.config_type || 'preset',
        }))

        // 加载自定义配置
        if (res.data.custom_config) {
          const customConfig = res.data.custom_config
          form.setFieldValue('customEndpoint', customConfig.endpoint || '')
          form.setFieldValue('customMethod', customConfig.method || 'GET')
          // 加载请求参数配置，如果为空对象则不显示
          if (
            customConfig.request_params &&
            Object.keys(customConfig.request_params).length > 0
          ) {
            form.setFieldValue(
              'requestParamsJson',
              JSON.stringify(customConfig.request_params, null, 2)
            )
          } else {
            form.setFieldValue('requestParamsJson', '')
          }
          if (
            customConfig.response_mappings &&
            Object.keys(customConfig.response_mappings).length > 0
          ) {
            form.setFieldValue(
              'responseMappingsJson',
              JSON.stringify(customConfig.response_mappings, null, 2)
            )
          } else {
            form.setFieldValue('responseMappingsJson', '')
          }
        } else if (res.data.model !== 'custom') {
          form.setFieldValue('customEndpoint', getPresetUrl(res.data.model))
        }
      }
    } catch (err) {
      console.error('加载详情失败:', err)
      notifications.show({ color: 'red', message: t('webSearch.msg.loadDetailFailed') })
    }
  }

  // tab 点击时刷新数据
  const handleTabChange = (value: string | null) => {
    setActiveTab(value)
    if (value === 'settings') {
      loadDetail()
    }
  }

  // 提交
  const handleSubmit = async () => {
    if (!projectId || !websearchModel?.id) return

    const validation = form.validate()
    if (validation.hasErrors) return

    const values = form.getValues()

    setSubmitting(true)
    try {
      // 解析 JSON 配置
      let requestParams: any = {}
      let responseMappings: any = {}
      try {
        if (values.requestParamsJson && values.requestParamsJson.trim()) {
          requestParams = JSON.parse(values.requestParamsJson)
        }
      } catch (err) {
        notifications.show({ color: 'red', message: t('webSearch.msg.invalidJsonParams') })
        return
      }
      try {
        if (values.responseMappingsJson && values.responseMappingsJson.trim()) {
          responseMappings = JSON.parse(values.responseMappingsJson)
        }
      } catch (err) {
        notifications.show({ color: 'red', message: t('webSearch.msg.responseMappingJsonError') })
        return
      }

      const submitData = {
        name: values.name,
        model: values.model,
        api: values.api || null,
        description: values.description || null,
        config_type: values.model === 'custom' ? 'custom' : 'preset',
        // 自定义模式的配置
        custom_config: {
          endpoint: values.customEndpoint || null,
          method: values.customMethod,
          request_params: requestParams,
          response_mappings: responseMappings,
        },
      }

      // custom 模式必须填写 API 地址
      if (values.model === 'custom' && !values.customEndpoint) {
        notifications.show({ color: 'yellow', message: t('webSearch.msg.enterApiAddress') })
        return
      }

      // 预设模式需要 API KEY
      if (values.model !== 'custom' && !values.api) {
        notifications.show({ color: 'yellow', message: t('webSearch.msg.enterApiKey') })
        return
      }

      const res: any = await updateWebSearchModelReq(projectId, values.id, submitData)

      if (res.success) {
        notifications.show({ color: 'green', message: res.msg || t('webSearch.msg.saveSuccess') })
        onUpdated?.(res.data)
      } else {
        notifications.show({ color: 'red', message: res.msg || t('webSearch.msg.saveFailed') })
      }
    } catch (err) {
      console.error('提交失败:', err)
      notifications.show({ color: 'red', message: t('webSearch.msg.saveFailed') })
    } finally {
      setSubmitting(false)
    }
  }

  // 测试连接（从 header）：使用当前表单值，避免未保存时仍用旧配置
  const handleTestConnection = async () => {
    if (!projectId || !websearchModel?.id) return
    const values = form.getValues()
    setTesting(true)
    try {
      const configType = values.model === 'custom' ? 'custom' : 'preset'

      // 解析请求参数
      let requestParams: any = {}
      try {
        if (values.requestParamsJson && values.requestParamsJson.trim()) {
          requestParams = JSON.parse(values.requestParamsJson)
        }
      } catch {
        notifications.show({ color: 'red', message: t('webSearch.msg.invalidJsonParams') })
        setTesting(false)
        return
      }

      const testData = {
        model: values.model,
        name: values.name,
        api: values.api,
        config_type: configType,
        // 所有搜索引擎都支持 custom_config
        custom_config: {
          endpoint: values.customEndpoint || null,
          method: values.customMethod || 'GET',
          request_params: requestParams,
        },
      }

      // custom 模式必须填写 API 地址
      if (configType === 'custom' && !values.customEndpoint) {
        notifications.show({ color: 'yellow', message: t('webSearch.msg.enterApiAddress') })
        setTesting(false)
        return
      }

      if (configType !== 'custom' && !values.api) {
        notifications.show({ color: 'yellow', message: t('webSearch.msg.enterApiKeyFirst') })
        setTesting(false)
        return
      }

      const res: any = await testWebSearchModelReq(projectId, testData)

      if (res.success) {
        notifications.show({ color: 'green', message: t('webSearch.msg.connectionSuccess') })
        // 只有自定义模式才自动推断响应解析
        if (configType === 'custom') {
          const rawResponse = res.data?.data?.raw_response
          if (rawResponse) {
            let suggested: any = null
            try {
              const inferRes: any = await inferWebSearchResponseMappingsReq(projectId, {
                raw_response: rawResponse,
              })
              if (inferRes?.success) {
                suggested = inferRes.data?.response_mappings || null
              }
            } catch (_) {
              // LLM 推断失败，不回退
            }

            if (suggested) {
              form.setFieldValue('responseMappingsJson', JSON.stringify(suggested, null, 2))
              setActiveTab('settings')
              notifications.show({ color: 'green', message: t('webSearch.msg.autoInferSuccess') })
            } else {
              notifications.show({ color: 'yellow', message: t('webSearch.msg.autoInferFailed') })
            }
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
  const handleDelete = () => {
    if (!projectId || !websearchModel?.id) return
    modals.openConfirmModal({
      title: t('webSearch.msg.deleteConfirm'),
      children: (
        <span>{t('webSearch.msg.deleteConfirmMsg', { name: websearchModel.name })}</span>
      ),
      labels: { confirm: t('webSearch.deleteBtn'), cancel: t('webSearch.hide') },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await deleteWebSearchModelReq(projectId, websearchModel.id)
          notifications.show({ color: 'green', message: t('webSearch.msg.deleteSuccess') })
          onDeleted?.()
        } catch (err) {
          console.error('删除失败:', err)
          notifications.show({ color: 'red', message: t('webSearch.msg.deleteFailed') })
        }
      },
    })
  }

  // 监听 websearchModel 变化（watch immediate）
  useEffect(() => {
    if (websearchModel) {
      loadDetail()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [websearchModel])

  // 初始化（onMounted）
  useEffect(() => {
    loadModelTypes()
    if (websearchModel) {
      loadDetail()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const formValues = form.getValues()

  return (
    <div className="ad-detail-page">
      {/* 返回按钮 */}
      <div className="ad-detail-page-header">
        <Button variant="subtle" color="gray" onClick={() => onBack?.()} px={6}>
          <ElSvgIcon name="ArrowLeft" size={18} />
        </Button>
        <span className="header-title">
          {websearchModel?.name || t('webSearch.defaultConfigTitle')}
        </span>
        <Badge color={getModelTagColor(websearchModel?.model)} size="sm">
          {getLocalizedEngineLabel(websearchModel?.model)}
        </Badge>
        <div className={styles.headerActions}>
          <Button
            variant="default"
            onClick={handleTestConnection}
            loading={testing}
            leftSection={<ElSvgIcon name="Connection" size={16} />}
          >
            {t('webSearch.testConnection')}
          </Button>
          <Button
            variant="default"
            onClick={() => setQaTestDialogVisible(true)}
            leftSection={<ElSvgIcon name="ChatDotRound" size={16} />}
          >
            {t('webSearch.testQA')}
          </Button>
        </div>
      </div>

      <div className="ad-detail-page-content">
        <Tabs value={activeTab} onChange={handleTabChange} className="ad-detail-tabs">
          <Tabs.List>
            {/* 基本信息 */}
            <Tabs.Tab value="info">
              <span className="ad-tab-label">
                <ElSvgIcon name="InfoFilled" size={16} />
                <span>{t('webSearch.basicInfo')}</span>
              </span>
            </Tabs.Tab>
            {/* 配置设置 */}
            <Tabs.Tab value="settings">
              <span className="ad-tab-label">
                <ElSvgIcon name="Setting" size={16} />
                <span>{t('webSearch.configSettings')}</span>
              </span>
            </Tabs.Tab>
          </Tabs.List>

          {/* 基本信息 */}
          <Tabs.Panel value="info">
            {activeTab === 'info' && (
              <div className={styles.infoSection}>
                {/* el-descriptions 替代：两列表格 */}
                <table className={styles.descriptions}>
                  <tbody>
                    <tr>
                      <th>{t('webSearch.dataSourceName')}</th>
                      <td>{websearchModel?.name}</td>
                    </tr>
                    <tr>
                      <th>{t('webSearch.searchEngine')}</th>
                      <td>
                        <Badge color={getModelTagColor(websearchModel?.model)} size="sm">
                          {websearchModel?.model}
                        </Badge>
                      </td>
                    </tr>
                    <tr>
                      <th>{t('webSearch.apiKey')}</th>
                      <td>
                        <span className={styles.apiMasked}>{maskApi(websearchModel?.api)}</span>
                        <Button
                          variant="subtle"
                          size="compact-xs"
                          onClick={() => setShowApi(!showApi)}
                          style={{ marginLeft: 8 }}
                        >
                          {showApi ? t('webSearch.hide') : t('webSearch.show')}
                        </Button>
                      </td>
                    </tr>
                    <tr>
                      <th>{t('webSearch.descriptionLabel')}</th>
                      <td>{websearchModel?.description || t('webSearch.noDescription')}</td>
                    </tr>
                    <tr>
                      <th>{t('webSearch.createdAt')}</th>
                      <td>{formatDateTime(websearchModel?.created_at)}</td>
                    </tr>
                    <tr>
                      <th>{t('webSearch.updatedAt')}</th>
                      <td>{formatDateTime(websearchModel?.updated_at)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </Tabs.Panel>

          {/* 配置设置 */}
          <Tabs.Panel value="settings">
            {activeTab === 'settings' && (
              <div className={styles.settingsSection}>
                <form
                  className={styles.settingsForm}
                  onSubmit={(e) => {
                    e.preventDefault()
                    handleSubmit()
                  }}
                >
                  <TextInput
                    label={t('webSearch.dataSourceName')}
                    withAsterisk
                    placeholder={t('webSearch.dataSourceNamePlaceholder')}
                    {...form.getInputProps('name')}
                    mb="md"
                  />

                  <Select
                    label={t('webSearch.searchEngine')}
                    withAsterisk
                    placeholder={t('webSearch.selectSearchEngine')}
                    style={{ width: '100%' }}
                    value={formValues.model}
                    onChange={handleModelChange}
                    error={form.errors.model}
                    data={searchModelOptions.map((option) => ({
                      value: option.value,
                      label: getLocalizedEngineLabel(option.value),
                    }))}
                    renderOption={({ option }) => (
                      <span>
                        <span style={{ fontWeight: 500 }}>
                          {getLocalizedEngineLabel(option.value)}
                        </span>
                        {getLocalizedEngineDescription(option.value) && (
                          <span style={{ color: '#999', fontSize: 12, marginLeft: 8 }}>
                            - {getLocalizedEngineDescription(option.value)}
                          </span>
                        )}
                      </span>
                    )}
                    mb="md"
                  />

                  {/* API 地址：预设和自定义模式都可编辑 */}
                  <TextInput
                    label={t('webSearch.apiEndpoint')}
                    placeholder={
                      formValues.model === 'custom'
                        ? t('webSearch.customEndpointPlaceholder')
                        : getPresetUrl(formValues.model)
                    }
                    {...form.getInputProps('customEndpoint')}
                  />
                  <div className={styles.formTip} style={{ marginTop: 6, marginBottom: 16 }}>
                    <span className={styles.formTipIcon}>
                      <ElSvgIcon name="InfoFilled" size={14} />
                    </span>
                    <span>
                      {formValues.model === 'custom'
                        ? t('webSearch.customApiDesc1')
                        : getPresetDescription(formValues.model)}
                    </span>
                  </div>

                  {/* API KEY：预设模式必填，自定义模式可选 */}
                  <TextInput
                    label={t('webSearch.apiKey')}
                    type="password"
                    placeholder={
                      formValues.model === 'custom'
                        ? t('webSearch.apiKeyOptionalPlaceholder')
                        : t('webSearch.apiKeyRequiredPlaceholder')
                    }
                    {...form.getInputProps('api')}
                    mb="md"
                  />

                  {/* 自定义配置：仅自定义模式显示 */}
                  {formValues.model === 'custom' && (
                    <>
                      {/* 请求方法 */}
                      <Radio.Group
                        label={t('webSearch.requestMethod')}
                        value={formValues.customMethod}
                        onChange={(v) => form.setFieldValue('customMethod', v)}
                        mb="md"
                      >
                        <div style={{ display: 'flex', gap: 16, marginTop: 6 }}>
                          <Radio value="GET" label="GET" />
                          <Radio value="POST" label="POST" />
                        </div>
                      </Radio.Group>

                      {/* 请求参数配置 */}
                      <Textarea
                        label={t('webSearch.requestParams')}
                        rows={4}
                        placeholder='{"query": "{{query}}", "limit": {{limit}}}'
                        {...form.getInputProps('requestParamsJson')}
                      />
                      <div className={styles.formTip} style={{ marginTop: 6, marginBottom: 16 }}>
                        <span className={styles.formTipIcon}>
                          <ElSvgIcon name="InfoFilled" size={14} />
                        </span>
                        <span>{t('webSearch.requestParamsTip')}</span>
                      </div>

                      {/* 响应解析 */}
                      <Textarea
                        label={t('webSearch.responseMapping')}
                        rows={4}
                        placeholder='{"results_path": "data.items[*]", "title": "title", "url": "url"}'
                        {...form.getInputProps('responseMappingsJson')}
                      />
                      <div className={styles.formTip} style={{ marginTop: 6, marginBottom: 16 }}>
                        <span className={styles.formTipIcon}>
                          <ElSvgIcon name="InfoFilled" size={14} />
                        </span>
                        <span>{t('webSearch.responseMappingAutoHint')}</span>
                      </div>
                    </>
                  )}

                  <Textarea
                    label={t('webSearch.descriptionLabel')}
                    rows={3}
                    placeholder={t('webSearch.descriptionPlaceholder')}
                    {...form.getInputProps('description')}
                    mb="md"
                  />

                  <div className={styles.formActions}>
                    <Button type="submit" loading={submitting}>
                      {t('webSearch.save')}
                    </Button>
                    <Button type="button" color="red" variant="outline" onClick={handleDelete}>
                      {t('webSearch.deleteBtn')}
                    </Button>
                  </div>
                </form>
              </div>
            )}
          </Tabs.Panel>
        </Tabs>
      </div>

      {/* 问答测试对话框 */}
      <WebSearchQATestDialog
        modelValue={qaTestDialogVisible}
        onUpdateModelValue={setQaTestDialogVisible}
        projectId={projectId}
        modelId={websearchModel?.id || ''}
      />
    </div>
  )
}
