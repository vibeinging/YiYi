// 模型管理页（源：views/models/index.vue）
// Tab 切换：单槽设计，每个 tab 直接展示该角色的编辑表单（无弹窗）。
// admin 与项目设置页共用本组件——projectId 非空走项目级自定义模型接口，否则走系统级接口。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import {
  createLLMModelReq,
  deleteLLMModelReq,
  llmModelsReq,
  updateLLMModelReq,
  testModelConfigReq,
  getLLMModelDetailReq,
} from '@/api/models'
import {
  getProjectModelsReq,
  createProjectModelReq,
  updateProjectModelReq,
  deleteProjectModelReq,
} from '@/api/project'
import ScrollableTabs from '@/components/ScrollableTabs'
import { Tabs } from '@mantine/core'
import ModelState from './components/ModelState'
import ModelFormRaw from './components/ModelForm'
import styles from './index.module.scss'
import type { ForwardRefExoticComponent, RefAttributes } from 'react'

// 子组件 ModelForm 暴露的句柄（forwardRef）。源 ModelForm.vue defineExpose({ formRef })，
// formRef 提供 el-form 的 validate()。ModelForm.tsx 尚为 stub，此处先本地声明契约避免耦合。
export interface ModelFormHandle {
  formRef: { validate: () => Promise<void> } | null
}

// ModelForm 子组件 props 契约（对应源 ModelForm.vue defineProps + defineEmits 的回调化）
export interface ModelFormProps {
  modelForm: Record<string, any>
  formSubmitting?: boolean
  deleting?: boolean
  testLoading?: boolean
  testResult?: any
  showTestResult?: boolean
  extraHeadersText?: string
  extraBodyText?: string
  embeddingDeletable?: boolean
  onTestConfig?: () => void
  onSubmit?: () => void
  onDelete?: () => void
  onExtraHeadersChange?: (v: string) => void
  onExtraBodyChange?: (v: string) => void
}

// ModelForm.tsx 目前仍是 stub（无类型 props/ref）。按契约 cast，
// 待其正式转好后类型自然对齐；当下保证本文件可编译且 stub 仍可渲染。
const ModelForm = ModelFormRaw as unknown as ForwardRefExoticComponent<
  ModelFormProps & RefAttributes<ModelFormHandle>
>

// defineProps → interface
interface ModelsProps {
  // 只读模式：项目管理员只能查看，不能增删改
  readonly?: boolean
  // 是否显示页面头部（独立页面显示，嵌入 admin 时不显示）
  showHeader?: boolean
  // 项目ID：非空 = 管理「项目级自定义模型」（走项目级 api）；null = 系统级（admin）
  projectId?: string | null
}

// 表单数据类型（核心字段 + extra_config 配置）。源里无类型，松散用 any 容纳动态字段。
type ModelFormState = Record<string, any>

// 创建模式下的表单初值
const createInitialForm = (category: string): ModelFormState => {
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
    extra_headers: {},
    extra_body: {},
    input_field: 'input',
    supports_batch: isEmbedding ? true : null,
    embed_batch_size: isEmbedding ? 100 : null,
    batch_input_field: isEmbedding ? 'input' : null,
    max_concurrency: isEmbedding ? 10 : null,
    thinking_param: '',
    thinking_value: false,
  }
}

export default function Models({
  readonly = false,
  showHeader = true,
  projectId = null,
}: ModelsProps) {
  const { t } = useTranslation()

  // api 适配层：projectId 非空走项目级自定义模型接口，否则走系统级接口。
  // 同一套表单/状态/提交逻辑两端复用，仅数据源不同——admin 与项目设置页共用本组件。
  const modelApi = useMemo(
    () => ({
      list: (params: any) =>
        projectId ? getProjectModelsReq(projectId, params) : llmModelsReq(params),
      create: (data: any) =>
        projectId ? createProjectModelReq(projectId, data) : createLLMModelReq(data),
      update: (data: any) =>
        projectId ? updateProjectModelReq(projectId, data) : updateLLMModelReq(data),
      remove: (id: any) =>
        projectId ? deleteProjectModelReq(projectId, id) : deleteLLMModelReq(id),
      // 项目级无独立 detail 接口：列表项已含 extra_config（仅缺 api_key），直接复用 row；
      // 编辑时 api_key 留空，后端 update 对 None 不覆盖 → 保留原 key。
      detail: (row: any) =>
        projectId ? Promise.resolve({ data: row }) : getLLMModelDetailReq(row.id),
    }),
    [projectId]
  )

  // Tab state
  const [activeTab, setActiveTab] = useState('PRIMARY')

  // 每个 category 的模型列表（单槽设计下最多 1 个）
  const [llmModels, setLlmModels] = useState<any[]>([])
  const [operatorChatModels, setOperatorChatModels] = useState<any[]>([])
  const [embedModels, setEmbedModels] = useState<any[]>([])
  const [llmLoading, setLlmLoading] = useState(false)
  const [operatorChatLoading, setOperatorChatLoading] = useState(false)
  const [embeddingLoading, setEmbeddingLoading] = useState(false)

  // 表单状态
  const [formSubmitting, setFormSubmitting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [testLoading, setTestLoading] = useState(false)
  const [testResult, setTestResult] = useState<any>(null)
  const [showTestResult, setShowTestResult] = useState(false)
  const [extraHeadersText, setExtraHeadersText] = useState('')
  const [extraBodyText, setExtraBodyText] = useState('')
  // 子组件暴露的句柄（含 formRef.validate）——对应源的 modelFormRef
  const modelFormRef = useRef<ModelFormHandle>(null)

  // 表单数据（核心字段 + extra_config 配置）。
  // Vue 用 reactive 对象 + Object.assign 原地改；React 用 state 触发渲染 + ref 镜像供 async 流程读最新值。
  const [modelForm, setModelFormState] = useState<ModelFormState>(() =>
    createInitialForm('PRIMARY')
  )
  const modelFormRefVal = useRef<ModelFormState>(modelForm)
  // 整体替换表单
  const replaceForm = useCallback((next: ModelFormState) => {
    modelFormRefVal.current = next
    setModelFormState(next)
  }, [])
  // 局部 patch 表单（对应 Object.assign(modelForm, patch)）
  const patchForm = useCallback((patch: ModelFormState) => {
    const next = { ...modelFormRefVal.current, ...patch }
    modelFormRefVal.current = next
    setModelFormState(next)
  }, [])

  // 文本/结果用 ref 镜像，供 async（handleSubmit/handleTestConfig）读取最新值
  const extraHeadersTextRef = useRef(extraHeadersText)
  const extraBodyTextRef = useRef(extraBodyText)
  const setExtraHeadersTextSync = useCallback((v: string) => {
    extraHeadersTextRef.current = v
    setExtraHeadersText(v)
  }, [])
  const setExtraBodyTextSync = useCallback((v: string) => {
    extraBodyTextRef.current = v
    setExtraBodyText(v)
  }, [])

  // ============ 当前 tab 派生信息 ============

  // category → [list, setList]
  const getModelDataRef = useCallback(
    (category: string): [any[], React.Dispatch<React.SetStateAction<any[]>>] => {
      const refs: Record<string, [any[], React.Dispatch<React.SetStateAction<any[]>>]> = {
        PRIMARY: [llmModels, setLlmModels],
        SECONDARY: [operatorChatModels, setOperatorChatModels],
        EMBEDDING: [embedModels, setEmbedModels],
      }
      return refs[category] || refs.PRIMARY
    },
    [llmModels, operatorChatModels, embedModels]
  )

  const getLoadingSetter = useCallback(
    (category: string): React.Dispatch<React.SetStateAction<boolean>> => {
      const refs: Record<string, React.Dispatch<React.SetStateAction<boolean>>> = {
        PRIMARY: setLlmLoading,
        SECONDARY: setOperatorChatLoading,
        EMBEDDING: setEmbeddingLoading,
      }
      return refs[category] || setLlmLoading
    },
    []
  )

  // computed: currentLoading
  const currentLoading = useMemo(() => {
    const map: Record<string, boolean> = {
      PRIMARY: llmLoading,
      SECONDARY: operatorChatLoading,
      EMBEDDING: embeddingLoading,
    }
    return map[activeTab] ?? llmLoading
  }, [activeTab, llmLoading, operatorChatLoading, embeddingLoading])

  // computed: currentTabEmpty
  const currentTabEmpty = useMemo(() => {
    const map: Record<string, any[]> = {
      PRIMARY: llmModels,
      SECONDARY: operatorChatModels,
      EMBEDDING: embedModels,
    }
    return (map[activeTab] || llmModels).length === 0
  }, [activeTab, llmModels, operatorChatModels, embedModels])

  // 只读模式空状态文案映射（按 category 区分图标/标题）
  const emptyState = useMemo(() => {
    const map: Record<string, { icon: string; titleKey: string; descReadonlyKey: string }> = {
      PRIMARY: {
        icon: 'ChatDotRound',
        titleKey: 'models.empty.chatTitle',
        descReadonlyKey: 'models.empty.chatDescReadonly',
      },
      SECONDARY: {
        icon: 'Cpu',
        titleKey: 'models.empty.operatorChatTitle',
        descReadonlyKey: 'models.empty.operatorChatDescReadonly',
      },
      EMBEDDING: {
        icon: 'Histogram',
        titleKey: 'models.empty.embeddingTitle',
        descReadonlyKey: 'models.empty.embeddingDescReadonly',
      },
    }
    return map[activeTab] || map.PRIMARY
  }, [activeTab])

  // ============ 模式切换：create / edit ============

  // 重置表单为「创建模式」（空槽时进入）
  const enterCreateMode = useCallback(
    (category: string) => {
      replaceForm(createInitialForm(category))
      setExtraHeadersTextSync('')
      setExtraBodyTextSync('')
      setTestResult(null)
      setShowTestResult(false)
    },
    [replaceForm, setExtraHeadersTextSync, setExtraBodyTextSync]
  )

  // 把旧 disable_thinking.params 拍平成第一个叶子的点路径 + 值（仅用于旧数据回填）
  const flattenFirstLeaf = useCallback(
    (obj: any, prefix = ''): { path?: string; value?: any } => {
      if (!obj || typeof obj !== 'object') return {}
      const keys = Object.keys(obj)
      if (!keys.length) return {}
      const k = keys[0]
      const path = prefix ? `${prefix}.${k}` : k
      const v = obj[k]
      return v && typeof v === 'object'
        ? flattenFirstLeaf(v, path)
        : { path, value: v }
    },
    []
  )

  // 填充表单为「编辑模式」（满槽时进入）。需异步 fetch 完整详情（含 api_key）
  const enterEditMode = useCallback(
    async (row: any) => {
      try {
        const res = await modelApi.detail(row)
        const detail = res.data
        const isEmbedding = detail.category === 'EMBEDDING'

        let extraConfig: any = {}
        try {
          if (detail.extra_config) {
            extraConfig =
              typeof detail.extra_config === 'string'
                ? JSON.parse(detail.extra_config)
                : detail.extra_config
          }
        } catch (error) {
          console.warn('解析 extra_config 失败:', error)
        }

        // 回填思考设置。新格式：thinking={param, value}；兼容旧格式 disable_thinking={enabled, params}
        const th = extraConfig.thinking
        const dt = extraConfig.disable_thinking
        let thinking_param = ''
        let thinking_value = false
        if (th && typeof th === 'object' && th.param) {
          thinking_param = th.param
          thinking_value = !!th.value
        } else if (dt && typeof dt === 'object' && dt.enabled) {
          // 旧格式：取 params 第一个叶子（参数名用点路径表达）
          const leaf = flattenFirstLeaf(dt.params)
          thinking_param = leaf.path || 'enable_thinking'
          thinking_value = !!leaf.value
        }

        replaceForm({
          ...detail,
          supports_streaming: isEmbedding ? false : detail.supports_streaming !== false,
          dimension: detail.dimension,
          extra_headers: extraConfig.extra_headers || {},
          extra_body: extraConfig.extra_body || {},
          input_field: extraConfig.input_field || 'input',
          supports_batch: extraConfig.supports_batch !== false,
          embed_batch_size: extraConfig.embed_batch_size || 100,
          batch_input_field: extraConfig.batch_input_field || 'input',
          max_concurrency: extraConfig.max_concurrency || 10,
          thinking_param,
          thinking_value,
        })

        setExtraHeadersTextSync(
          extraConfig.extra_headers && Object.keys(extraConfig.extra_headers).length > 0
            ? JSON.stringify(extraConfig.extra_headers, null, 2)
            : ''
        )
        setExtraBodyTextSync(
          extraConfig.extra_body && Object.keys(extraConfig.extra_body).length > 0
            ? JSON.stringify(extraConfig.extra_body, null, 2)
            : ''
        )
        setTestResult(null)
        setShowTestResult(false)
      } catch (error: any) {
        notifications.show({
          color: 'red',
          message: error.message || t('models.message.fetchError', { type: '' }),
        })
      }
    },
    [modelApi, flattenFirstLeaf, replaceForm, setExtraHeadersTextSync, setExtraBodyTextSync, t]
  )

  // ============ 额外配置处理（JSON 文本 → 对象）============

  const handleExtraHeadersChange = useCallback(
    (value: string) => {
      try {
        if (value && value.trim()) {
          patchForm({ extra_headers: JSON.parse(value) })
        } else {
          patchForm({ extra_headers: null })
        }
      } catch (error) {
        notifications.show({
          color: 'red',
          message: t('models.message.extraHeadersJsonError'),
        })
        console.warn('extra_headers JSON 格式错误:', error)
      }
    },
    [patchForm, t]
  )

  const handleExtraBodyChange = useCallback(
    (value: string) => {
      try {
        if (value && value.trim()) {
          patchForm({ extra_body: JSON.parse(value) })
        } else {
          patchForm({ extra_body: null })
        }
      } catch (error) {
        notifications.show({
          color: 'red',
          message: t('models.message.extraBodyJsonError'),
        })
        console.warn('extra_body JSON 格式错误:', error)
      }
    },
    [patchForm, t]
  )

  // ============ 测试配置 ============

  const handleTestConfig = useCallback(async () => {
    const formApi = modelFormRef.current?.formRef
    if (!formApi) return

    try {
      await formApi.validate()
      setTestLoading(true)
      setTestResult(null)
      setShowTestResult(false)

      const testData: any = { ...modelFormRefVal.current }
      if (modelFormRefVal.current.category === 'EMBEDDING') {
        testData.test_type = 'embedding'
        delete testData.temperature
        delete testData.max_tokens
        delete testData.supports_streaming
      } else {
        testData.test_type = 'chat'
      }

      Object.keys(testData).forEach((key) => {
        if (testData[key] === '' || testData[key] === null) {
          delete testData[key]
        }
      })

      const res = await testModelConfigReq(testData)
      setTestResult(res.data)
      setShowTestResult(true)
      if (res.data.success) {
        notifications.show({
          color: 'green',
          message: res.data.message || t('models.message.testConnectionSuccess'),
        })
      } else {
        notifications.show({
          color: 'yellow',
          message: res.data.message || t('models.message.testConnectionError'),
        })
      }
    } catch (error: any) {
      setTestResult({
        success: false,
        message: error.message || t('models.message.testRequestError'),
        test_type: 'request_error',
        error_details: error.message,
      })
      setShowTestResult(true)
      notifications.show({
        color: 'red',
        message: error.message || t('models.message.testConnectionError'),
      })
    } finally {
      setTestLoading(false)
    }
  }, [t])

  // ============ 保存 ============

  // 提交后刷新当前 tab 列表（创建后立即变为 edit 模式）。用 ref 形式以避免循环依赖。
  const fetchModelsRef = useRef<() => Promise<void>>(async () => {})

  const handleSubmit = useCallback(async () => {
    try {
      setFormSubmitting(true)
      // 提交前同步额外配置文本到表单对象
      handleExtraHeadersChange(extraHeadersTextRef.current)
      handleExtraBodyChange(extraBodyTextRef.current)

      const submitData: any = { ...modelFormRefVal.current }
      const extraConfig: any = {}
      if (submitData.extra_headers && Object.keys(submitData.extra_headers).length > 0) {
        extraConfig.extra_headers = submitData.extra_headers
      }
      if (submitData.extra_body && Object.keys(submitData.extra_body).length > 0) {
        extraConfig.extra_body = submitData.extra_body
      }
      if (submitData.input_field && submitData.input_field !== 'input') {
        extraConfig.input_field = submitData.input_field
      }
      // 思考设置（仅对话模型）：存 thinking={param, value}。param 支持点路径表达嵌套，
      // 后端按 param 把 value 写进请求 body（DashScope: enable_thinking；vLLM: chat_template_kwargs.enable_thinking）。
      if (
        (submitData.category === 'PRIMARY' || submitData.category === 'SECONDARY') &&
        submitData.thinking_param &&
        submitData.thinking_param.trim()
      ) {
        extraConfig.thinking = {
          param: submitData.thinking_param.trim(),
          value: !!submitData.thinking_value,
        }
      }
      if (submitData.category === 'EMBEDDING') {
        extraConfig.supports_batch = submitData.supports_batch
        extraConfig.max_concurrency = submitData.max_concurrency || 10
        if (submitData.supports_batch) {
          extraConfig.embed_batch_size = submitData.embed_batch_size || 100
          extraConfig.batch_input_field = submitData.batch_input_field || 'input'
        }
      }
      // 始终用组装结果覆盖 extra_config（即使为空 {}）。否则关掉「关闭思考」后 extraConfig 为空，
      // 会保留编辑时从详情带入的旧 extra_config（含 disable_thinking.enabled=true），导致关不掉、
      // 刷新又变回已关闭思考。已知字段（extra_headers/body/thinking 等）上面都已重新组装，覆盖安全。
      submitData.extra_config = extraConfig

      if (submitData.category === 'PRIMARY' || submitData.category === 'SECONDARY') {
        delete submitData.dimension
        delete submitData.input_field
        submitData.supports_streaming = submitData.supports_streaming !== false
      } else if (submitData.category === 'EMBEDDING') {
        submitData.supports_streaming = false
        // 维度固定 1024（UI 不再暴露）：覆盖老数据 / fetch 回的异常值，确保后端始终收到 1024
        submitData.dimension = 1024
      }

      // 清理临时字段
      delete submitData.extra_headers
      delete submitData.extra_body
      delete submitData.input_field
      delete submitData.supports_batch
      delete submitData.embed_batch_size
      delete submitData.batch_input_field
      delete submitData.max_concurrency
      delete submitData.disable_thinking
      delete submitData.thinking_param
      delete submitData.thinking_value

      // 清理空值（dimension 即便为 null 也保留）
      Object.keys(submitData).forEach((key) => {
        if (key !== 'dimension' && (submitData[key] === '' || submitData[key] === null)) {
          delete submitData[key]
        }
      })

      if (submitData.id) {
        await modelApi.update(submitData)
        notifications.show({ color: 'green', message: t('models.message.updateSuccess') })
      } else {
        await modelApi.create(submitData)
        notifications.show({ color: 'green', message: t('models.message.createSuccess') })
      }
      // 保存后刷新当前 tab 列表并保持 edit 态（创建后立即变为 edit 模式）
      await fetchModelsRef.current()
    } finally {
      setFormSubmitting(false)
    }
  }, [handleExtraHeadersChange, handleExtraBodyChange, modelApi, t])

  // ============ 删除 ============

  const handleDelete = useCallback(async () => {
    if (!modelFormRefVal.current.id) return
    // ElMessageBox.confirm → modals.openConfirmModal
    modals.openConfirmModal({
      title: t('common.tip'),
      children: t('models.message.deleteConfirm'),
      labels: { confirm: t('common.confirm'), cancel: t('common.cancel') },
      // type: 'warning'
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          setDeleting(true)
          await modelApi.remove(modelFormRefVal.current.id)
          notifications.show({ color: 'green', message: t('models.message.deleteSuccess') })
          // 删除后刷新（列表变空 → 自动进入 create 模式）
          await fetchModelsRef.current()
        } catch (error: any) {
          notifications.show({
            color: 'red',
            message: error.message || t('models.message.deleteError'),
          })
        } finally {
          setDeleting(false)
        }
      },
    })
  }, [modelApi, t])

  // ============ 数据获取 ============

  // fetch 完后根据列表是否非空，自动进入对应模式
  const syncFormToCurrentTab = useCallback(
    (category: string, list: any[]) => {
      if (list.length > 0) {
        enterEditMode(list[0])
      } else {
        enterCreateMode(category)
      }
    },
    [enterEditMode, enterCreateMode]
  )

  const fetchModels = useCallback(async () => {
    const category = activeTab
    const setLoading = getLoadingSetter(category)
    const [, setList] = getModelDataRef(category)

    setLoading(true)
    try {
      const res = await modelApi.list({ category, per_page: 100 })
      const items = res.data.items
      setList(items)
      // fetch 完后自动进入对应模式（满槽 edit / 空槽 create）
      syncFormToCurrentTab(category, items)
    } catch (error: any) {
      notifications.show({
        color: 'red',
        message: error.message || t('models.message.fetchError', { type: category }),
      })
    } finally {
      setLoading(false)
    }
  }, [activeTab, getLoadingSetter, getModelDataRef, modelApi, syncFormToCurrentTab, t])

  // 让 handleSubmit/handleDelete 内部能调到最新的 fetchModels
  useEffect(() => {
    fetchModelsRef.current = fetchModels
  }, [fetchModels])

  // Tab 切换：先把表单切到该 category 的"创建态"占位，再 fetch 后自动 sync
  // watch(activeTab) + onMounted(fetchModels) 合并：activeTab 变化或首挂均触发。
  useEffect(() => {
    enterCreateMode(activeTab)
    fetchModels()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab])

  return (
    <div
      className={`${styles['model-management']} ${!showHeader ? styles['is-embedded'] : ''}`}
    >
      {/* 页面头部（仅独立使用时显示） */}
      {showHeader && (
        <div className={styles['page-header']}>
          <div className={styles['header-left']}>
            <h1>{t('models.title')}</h1>
            <p>{t('models.description')}</p>
          </div>
        </div>
      )}

      {/* Tab 切换：单槽设计，每个 tab 直接展示该角色的编辑表单（无弹窗） */}
      <div className={styles['content-wrapper']}>
        <ScrollableTabs
          modelValue={activeTab}
          type="card"
          tabsClass="model-tabs"
          onUpdateModelValue={(v) => setActiveTab(v)}
        >
          <Tabs.List>
            <Tabs.Tab value="PRIMARY">{t('models.tabs.chat')}</Tabs.Tab>
            <Tabs.Tab value="SECONDARY">{t('models.tabs.operatorChat')}</Tabs.Tab>
            <Tabs.Tab value="EMBEDDING">{t('models.tabs.embedding')}</Tabs.Tab>
          </Tabs.List>
        </ScrollableTabs>

        <div className={styles['tab-panel']}>
          {/* Loading：fetch 模型列表中 */}
          {currentLoading ? (
            <ModelState type="loading" />
          ) : readonly && currentTabEmpty ? (
            /* 只读模式且无模型：仅展示空状态（项目级查看用） */
            <ModelState
              type="empty"
              icon={emptyState.icon}
              title={t(emptyState.titleKey)}
              description={t(emptyState.descReadonlyKey)}
            />
          ) : !readonly ? (
            /* 编辑/创建表单（单槽：内联展示，无弹窗） */
            <ModelForm
              ref={modelFormRef}
              modelForm={modelForm}
              formSubmitting={formSubmitting}
              deleting={deleting}
              testLoading={testLoading}
              testResult={testResult}
              showTestResult={showTestResult}
              extraHeadersText={extraHeadersText}
              extraBodyText={extraBodyText}
              embeddingDeletable={!!projectId}
              onTestConfig={handleTestConfig}
              onSubmit={handleSubmit}
              onDelete={handleDelete}
              onExtraHeadersChange={handleExtraHeadersChange}
              onExtraBodyChange={handleExtraBodyChange}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}
