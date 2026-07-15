import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Alert,
  Badge,
  Button,
  Center,
  Checkbox,
  Modal,
  Pagination,
  Select,
  Switch,
  Table,
  Text,
  TextInput,
  Textarea
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import * as XLSX from 'xlsx'
import ElSvgIcon from '@/components/ElSvgIcon'
import { useResponsive } from '@/hooks/use-responsive'
import {
  getMetricsReq,
  createMetricReq,
  updateMetricReq,
  updateMetricStatusReq,
  deleteMetricReq,
  deleteMetricsReq,
  generateMetricEmbeddingsReq,
  getMetricEmbeddingPendingCountReq,
  bulkImportMetricsReq,
  searchMetricsReq
} from '@/api/business-semantic'
import { getBusinessDataSourcesReq } from '@/api/business'
import { getCachedTablesReq, getTableColumnsReq as getDatabaseTableColumnsReq } from '@/api/database'
import MetricEmptyState from './MetricEmptyState'
import TableColumnSelector from './TableColumnSelector'
import CodeKnowledgeConditionBuilder from './CodeKnowledgeConditionBuilder'
import styles from './MetricManager.module.scss'

export interface MetricManagerProps {
  projectId: string
  businessId: string
}

// 指标表单结构
interface MetricForm {
  name: string
  description: string
  aliases: string // 前端存储为逗号分隔的字符串，提交时转换为数组
  sql_template: string
  source_id: string
  source_type: string
  related_tables: string[]
  related_columns: Record<string, any>
  code_knowledge: any // 存储为对象，直接由 EnumValueSelector 管理
}

const EMPTY_FORM: MetricForm = {
  name: '',
  description: '',
  aliases: '',
  sql_template: '',
  source_id: '',
  source_type: '',
  related_tables: [],
  related_columns: {},
  code_knowledge: null
}

// 仅对尚未向量化的指标分批生成；pendingCount 可由导入流程传入，避免误用业务指标总数
const EMBEDDING_NGINX_HINT_THRESHOLD = 500

// 清理 SQL 模板显示
const cleanSqlTemplate = (sqlTemplate?: string) => {
  if (!sqlTemplate) return ''
  return sqlTemplate
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export default function MetricManager({ projectId, businessId }: MetricManagerProps) {
  const { t } = useTranslation()
  const { isMobile } = useResponsive()

  // 数据
  const [metrics, setMetrics] = useState<any[]>([])
  const [, setLoading] = useState(false)
  const [generatingAll, setGeneratingAll] = useState(false)
  const [generatingMetricId, setGeneratingMetricId] = useState<any>(null) // 正在生成向量的指标ID
  const [togglingMetricId, setTogglingMetricId] = useState<any>(null) // 正在切换激活状态的指标ID
  const [submitting, setSubmitting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [bulkDeleteMode, setBulkDeleteMode] = useState(false)
  const [selectedMetricIds, setSelectedMetricIds] = useState<Set<any>>(new Set())
  const [selectAllAcrossPages, setSelectAllAcrossPages] = useState(false)

  // 数据源
  const [dataSources, setDataSources] = useState<any[]>([])
  const [selectedSourceType, setSelectedSourceType] = useState('database') // 当前选择的数据源类型

  // 分页
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [totalMetrics, setTotalMetrics] = useState(0) // 后端返回的总数

  // 对话框
  const [metricDialogVisible, setMetricDialogVisible] = useState(false)
  const [bulkImportDialogVisible, setBulkImportDialogVisible] = useState(false)
  const [showSearchDialog, setShowSearchDialog] = useState(false)
  const [codeKnowledgeHelpDialogVisible, setCodeKnowledgeHelpDialogVisible] = useState(false)
  const [editingMetric, setEditingMetric] = useState<any>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [bulkImportSourceId, setBulkImportSourceId] = useState('') // 批量导入时选择的数据源ID
  const [bulkImportOverwrite, setBulkImportOverwrite] = useState(false) // 批量导入时是否覆盖已存在的指标
  const fileInputRef = useRef<HTMLInputElement>(null) // 上传组件引用

  // 搜索相关
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [searching, setSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)

  // 已选配置（用于最终提交，由TableColumnSelector组件管理）
  const [selectedTableColumnsConfig, setSelectedTableColumnsConfig] = useState<Record<string, any>>({}) // { table_name: [column_name1, column_name2] }

  // 当前选择的数据源ID（用于TableColumnSelector）
  const [connectionId, setConnectionId] = useState<any>(null)
  const [selectedDatabaseConnectionId, setSelectedDatabaseConnectionId] = useState<any>(null) // 结构化数据源的 database_connection_id

  // 列的枚举映射数据: { table_name: { column_name: { enum_mappings, description } } }
  const [columnEnumMappings, setColumnEnumMappings] = useState<Record<string, any>>({})

  // 表单
  const [metricForm, setMetricForm] = useState<MetricForm>({ ...EMPTY_FORM })
  // 表单校验错误（对应 el-form rules）
  const [formErrors, setFormErrors] = useState<{ name?: string; sql_template?: string }>({})

  // 防抖定时器
  const loadColumnMappingsTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // ref 引用，便于在闭包内拿到最新值（替代直接读 .value）
  const connectionIdRef = useRef<any>(null)
  const selectedConfigRef = useRef<Record<string, any>>({})
  connectionIdRef.current = connectionId
  selectedConfigRef.current = selectedTableColumnsConfig

  const setFormField = (patch: Partial<MetricForm>) => {
    setMetricForm((prev) => ({ ...prev, ...patch }))
  }

  // 分页 layout（移动端简化）
  const metricPaginationLayout = isMobile ? 'total, prev, pager, next' : 'total, sizes, prev, pager, next, jumper'

  // 计算属性
  const selectedCount = useMemo(
    () => (selectAllAcrossPages ? totalMetrics : selectedMetricIds.size),
    [selectAllAcrossPages, totalMetrics, selectedMetricIds]
  )
  const isAllPageSelected = useMemo(
    () =>
      metrics.length > 0 &&
      metrics.every((m) => selectAllAcrossPages || selectedMetricIds.has(m.id)),
    [metrics, selectAllAcrossPages, selectedMetricIds]
  )
  const isAllSelected = useMemo(() => {
    if (selectAllAcrossPages) return true
    if (metrics.length === 0) return false
    return metrics.every((m) => selectedMetricIds.has(m.id))
  }, [metrics, selectAllAcrossPages, selectedMetricIds])
  const isIndeterminate = useMemo(() => {
    if (selectAllAcrossPages || metrics.length === 0) return false
    const pageSelectedCount = metrics.filter((m) => selectedMetricIds.has(m.id)).length
    return pageSelectedCount > 0 && pageSelectedCount < metrics.length
  }, [metrics, selectAllAcrossPages, selectedMetricIds])
  const hasCrossPageSelection = useMemo(() => {
    if (selectAllAcrossPages || metrics.length === 0) return false
    const pageIds = new Set(metrics.map((m) => m.id))
    const selectedOnPage = [...selectedMetricIds].filter((id) => pageIds.has(id)).length
    return selectedMetricIds.size > selectedOnPage
  }, [metrics, selectAllAcrossPages, selectedMetricIds])

  // 总页数（用于 Mantine Pagination）
  const totalPages = useMemo(() => Math.max(1, Math.ceil(totalMetrics / pageSize)), [totalMetrics, pageSize])

  // 方法
  const loadMetrics = async (page = currentPage, size = pageSize, resetPage = false) => {
    const targetPage = resetPage ? 1 : page
    if (resetPage) setCurrentPage(1)
    try {
      setLoading(true)
      const response = await getMetricsReq(projectId, targetPage, size)
      if (response && response.success) {
        setMetrics(response.data?.items || [])
        setTotalMetrics(response.data?.total || 0)
      }
    } catch (error: any) {
      notifications.show({ color: 'red', message: t('business.metric.loadFailed') + ': ' + error.message })
    } finally {
      setLoading(false)
    }
  }

  // 加载业务关联的数据源
  const loadDataSources = async () => {
    try {
      const response = await getBusinessDataSourcesReq(projectId)
      if (response && response.success) {
        // API 返回格式: { database_connections: [], unstructured_data_sources: [], structured_data_sources: [] }
        const data = response.data || {}
        const dbConnections = data.database_connections || []
        const structuredSources = data.structured_data_sources || []

        // 合并数据库连接和结构化数据源
        const sources: any[] = []

        // 数据库连接（支持表和列选择）
        dbConnections.forEach((ds: any) => {
          sources.push({
            id: `db_${ds.id}`,
            name: ds.name || ds.connection_name || ds.display_name || t('business.dataSources.database'),
            source_id: ds.id,
            source_type: ds.source_type, // 使用后端返回的 source_type
            db_type: ds.db_type, // 保留 db_type 用于其他逻辑
            type: 'database'
          })
        })

        // 结构化数据源
        structuredSources.forEach((ds: any) => {
          sources.push({
            id: `struct_${ds.id}`,
            name: ds.name || ds.display_name || t('business.dataSources.structured'),
            source_id: ds.id,
            source_type: ds.source_type, // 使用后端返回的 source_type
            database_connection_id: ds.database_connection_id, // 从数据源级别获取
            type: 'structured'
          })
        })

        setDataSources(sources)
      }
    } catch (error) {
      console.error('加载数据源失败:', error)
    }
  }

  // 处理分页变化
  const handlePageChange = (page: number) => {
    setCurrentPage(page)
    loadMetrics(page, pageSize)
    document.querySelector('.metrics-section')?.scrollIntoView({ behavior: 'smooth' })
  }

  // 处理每页数量变化
  const handlePageSizeChange = (size: number) => {
    setPageSize(size)
    setCurrentPage(1)
    loadMetrics(1, size)
  }

  // 数据源选择变化
  const handleDataSourceChange = (sourceId: any) => {
    // 根据选择的 sourceId 找到对应的数据源
    const selectedSource = dataSources.find((ds) => ds.source_id === sourceId)

    if (selectedSource) {
      setConnectionId(sourceId)
      setSelectedSourceType(selectedSource.type)
      setSelectedDatabaseConnectionId(selectedSource.database_connection_id || null)
      setFormField({ source_type: selectedSource.source_type, source_id: sourceId || '' }) // 直接使用后端返回的 source_type
    } else {
      setConnectionId(null)
      setSelectedSourceType('database')
      setSelectedDatabaseConnectionId(null)
      setFormField({ source_type: '', source_id: sourceId || '' })
    }

    // 清空已选择的表列配置
    setSelectedTableColumnsConfig({})
    setColumnEnumMappings({})
  }

  // 加载列的枚举映射数据
  const loadColumnEnumMappings = async () => {
    const curConnectionId = connectionIdRef.current
    const curConfig = selectedConfigRef.current
    if (!curConnectionId || !curConfig) {
      setColumnEnumMappings({})
      return
    }

    try {
      const tables = Object.keys(curConfig)
      const mappings: Record<string, any> = {}

      // 获取所有表
      const tablesRes = await getCachedTablesReq(projectId, curConnectionId)
      if (!tablesRes?.success) {
        return
      }

      const allTables = tablesRes.data?.items || []
      const tableMap = new Map<string, any>(allTables.map((tb: any) => [tb.table_name, tb.id]))

      // 遍历每个表的每一列，获取枚举映射
      for (const tableName of tables) {
        let tableId = tableMap.get(tableName)

        // 尝试去掉 schema 前缀匹配
        if (!tableId && tableName.includes('.')) {
          const shortName = tableName.split('.').pop() as string
          tableId = tableMap.get(shortName)
        }

        if (!tableId) {
          continue
        }

        const columns = curConfig[tableName] || []
        mappings[tableName] = {}

        // 获取该表的所有列信息
        const columnsRes = await getDatabaseTableColumnsReq(projectId, curConnectionId, tableId)

        if (columnsRes?.success) {
          const allColumns = columnsRes.data?.items || []

          for (const column of columns) {
            const columnInfo = allColumns.find((c: any) => c.column_name === column)
            if (columnInfo) {
              mappings[tableName][column] = {
                description: columnInfo.description,
                enum_mappings: columnInfo.enum_mappings
              }
            }
          }
        }
      }

      setColumnEnumMappings(mappings)
    } catch (error) {
      console.error('加载列枚举映射失败:', error)
    }
  }

  const resetMetricForm = () => {
    setMetricForm({ ...EMPTY_FORM })
    // 清除选择状态
    setConnectionId(null)
    setSelectedTableColumnsConfig({})
    setColumnEnumMappings({})
    setFormErrors({})
  }

  const openAddMetricDialog = () => {
    setEditingMetric(null)
    resetMetricForm()
    setMetricDialogVisible(true)
  }

  // 根据 metric 恢复数据源 / 表列选择状态（editMetric / copyMetric 复用）
  const restoreSourceState = (metric: any, sourceType: string) => {
    if (metric.source_id) {
      // 根据 source_id 找到对应的数据源
      const selectedSource = dataSources.find((ds) => ds.source_id === metric.source_id)
      if (selectedSource) {
        setConnectionId(metric.source_id)
        setSelectedSourceType(selectedSource.type)
        setSelectedDatabaseConnectionId(selectedSource.database_connection_id || null)
        connectionIdRef.current = metric.source_id
        return selectedSource.source_type // 使用后端返回的 source_type
      } else {
        // 如果数据源不在列表中，仍然设置 connectionId 以便显示表列选择器
        setConnectionId(metric.source_id)
        setSelectedSourceType(sourceType === 'database' ? 'database' : 'structured')
        setSelectedDatabaseConnectionId(null)
        connectionIdRef.current = metric.source_id
        return sourceType || ''
      }
    } else {
      setConnectionId(null)
      setSelectedSourceType('database')
      setSelectedDatabaseConnectionId(null)
      connectionIdRef.current = null
      return sourceType || ''
    }
  }

  const editMetric = (metric: any) => {
    setEditingMetric(metric)
    const sourceType = restoreSourceState(metric, metric.source_type || '')
    setMetricForm({
      name: metric.name,
      description: metric.description || '',
      aliases: Array.isArray(metric.aliases) ? metric.aliases.join(', ') : '',
      sql_template: metric.sql_template,
      source_id: metric.source_id || '',
      source_type: sourceType,
      related_tables: metric.related_tables || [],
      related_columns: metric.related_columns || {},
      code_knowledge: metric.code_knowledge || null // 直接存储对象
    })
    setFormErrors({})

    // 恢复选中状态
    const config = { ...(metric.related_columns || {}) }
    setSelectedTableColumnsConfig(config)
    selectedConfigRef.current = config

    // 加载列的枚举映射
    loadColumnEnumMappings()

    setMetricDialogVisible(true)
  }

  const copyMetric = (metric: any) => {
    setEditingMetric(null)
    const sourceType = restoreSourceState(metric, metric.source_type || '')
    setMetricForm({
      name: metric.name + ` (${t('business.metric.copyLabel')})`,
      description: metric.description || '',
      aliases: Array.isArray(metric.aliases) ? metric.aliases.join(', ') : '',
      sql_template: metric.sql_template,
      source_id: metric.source_id || '',
      source_type: sourceType,
      related_tables: metric.related_tables || [],
      related_columns: JSON.parse(JSON.stringify(metric.related_columns || {})),
      code_knowledge: metric.code_knowledge ? JSON.parse(JSON.stringify(metric.code_knowledge)) : null
    })
    setFormErrors({})

    // 恢复选中状态
    const config = JSON.parse(JSON.stringify(metric.related_columns || {}))
    setSelectedTableColumnsConfig(config)
    selectedConfigRef.current = config

    // 加载列的枚举映射
    loadColumnEnumMappings()

    setMetricDialogVisible(true)
  }

  const submitMetricForm = async () => {
    // 同步表列配置到表单
    const relatedTables = Object.keys(selectedTableColumnsConfig)
    const relatedColumns = { ...selectedTableColumnsConfig }

    // 表单校验（对应 el-form rules）
    const errors: { name?: string; sql_template?: string } = {}
    if (!metricForm.name?.trim()) errors.name = t('business.metric.metricNameRequired')
    if (!metricForm.sql_template?.trim()) errors.sql_template = t('business.metric.sqlTemplateRequired')
    setFormErrors(errors)
    if (Object.keys(errors).length > 0) return

    try {
      setSubmitting(true)

      // 准备提交数据，处理 aliases 转换
      const submitData = {
        name: metricForm.name,
        description: metricForm.description,
        sql_template: metricForm.sql_template,
        source_id: metricForm.source_id,
        source_type: metricForm.source_type,
        related_tables: relatedTables,
        related_columns: relatedColumns,
        // aliases: 逗号分隔的字符串 → 数组（过滤空字符串）
        // 支持中文逗号和英文逗号，统一替换为英文逗号后再分割
        // 移除所有类型的空格（包括全角空格）
        aliases: metricForm.aliases
          ? metricForm.aliases
              .replace(/，/g, ',') // 中文逗号 → 英文逗号
              .replace(/\s+/g, '') // 移除所有空格
              .split(',')
              .filter((s) => s)
          : [],
        // code_knowledge: 直接使用对象（由 EnumValueSelector 管理）
        code_knowledge: metricForm.code_knowledge
      }

      const isNew = !editingMetric
      let response: any

      // 根据是新建还是编辑调用不同的API
      if (isNew) {
        response = await createMetricReq(projectId, submitData)
      } else {
        response = await updateMetricReq(projectId, editingMetric.id, submitData)
      }

      if (response.success) {
        notifications.show({
          color: 'green',
          message: isNew ? t('business.metric.createSuccess') : t('business.metric.updateSuccess')
        })
        setMetricDialogVisible(false)
        await loadMetrics()

        // 如果是更新且需要更新向量，询问用户
        if (!isNew && response.data?.vector_needs_update) {
          modals.openConfirmModal({
            title: t('business.metric.updateVector'),
            children: t('business.metric.vectorNeedsUpdateMsg'),
            labels: {
              confirm: t('business.metric.updateVector'),
              cancel: t('business.metric.notNow')
            },
            onConfirm: async () => {
              // 用户确认，调用向量生成
              await generateSingleEmbedding(editingMetric)
            }
          })
        }
      }
    } catch (error: any) {
      if (error.name !== 'Error') {
        notifications.show({
          color: 'red',
          message: t('business.metric.operationFailed') + ': ' + error.message
        })
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handleRowClick = (row: any) => {
    if (bulkDeleteMode) return
    editMetric(row)
  }

  const isSelected = (metricId: any) => {
    return selectAllAcrossPages || selectedMetricIds.has(metricId)
  }

  const setSelected = (metricId: any, selected: boolean) => {
    if (selectAllAcrossPages) {
      setSelectAllAcrossPages(false)
      if (!selected) {
        setSelectedMetricIds(new Set(metrics.map((m) => m.id).filter((id) => id !== metricId)))
      } else {
        setSelectedMetricIds(new Set(metrics.map((m) => m.id)))
      }
      return
    }
    const next = new Set(selectedMetricIds)
    if (selected) next.add(metricId)
    else next.delete(metricId)
    setSelectedMetricIds(next)
  }

  const enterBulkDeleteMode = () => {
    setBulkDeleteMode(true)
    setSelectAllAcrossPages(false)
    setSelectedMetricIds(new Set())
  }

  const exitBulkDeleteMode = () => {
    setBulkDeleteMode(false)
    setSelectAllAcrossPages(false)
    setSelectedMetricIds(new Set())
  }

  const clearAllSelection = () => {
    setSelectAllAcrossPages(false)
    setSelectedMetricIds(new Set())
  }

  const selectAllMetricsAcrossPages = () => {
    setSelectAllAcrossPages(true)
    setSelectedMetricIds(new Set(metrics.map((m) => m.id)))
  }

  const toggleSelectAll = () => {
    if (selectAllAcrossPages) {
      clearAllSelection()
      return
    }
    const pageIds = metrics.map((m) => m.id)
    const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedMetricIds.has(id))
    const next = new Set(selectedMetricIds)
    if (allPageSelected) {
      pageIds.forEach((id) => next.delete(id))
    } else {
      pageIds.forEach((id) => next.add(id))
    }
    setSelectedMetricIds(next)
  }

  const confirmBulkDelete = () => {
    if (selectedCount === 0) {
      notifications.show({ color: 'yellow', message: t('business.metric.selectMetricsFirst') })
      return
    }

    const count = selectedCount
    const confirmMsg = selectAllAcrossPages
      ? t('business.metric.confirmBulkDeleteAllMsg', { count })
      : t('business.metric.confirmBulkDeleteMsg', { count })

    modals.openConfirmModal({
      title: t('business.metric.confirmBulkDeleteTitle'),
      children: confirmMsg,
      labels: {
        confirm: t('business.metric.confirm'),
        cancel: t('business.metric.cancel')
      },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          const response = selectAllAcrossPages
            ? await deleteMetricsReq(projectId, { deleteAll: true })
            : await deleteMetricsReq(projectId, {
                metricIds: Array.from(selectedMetricIds)
              })
          if (response.success) {
            const deletedCount = response.data?.deleted_count ?? count
            notifications.show({
              color: 'green',
              message: response.message || t('business.metric.bulkDeleteSuccess', { count: deletedCount })
            })
            exitBulkDeleteMode()
            await loadMetrics(currentPage, pageSize, true)
          }
        } catch (error: any) {
          notifications.show({
            color: 'red',
            message: t('business.metric.bulkDeleteFailed') + ': ' + error.message
          })
        }
      }
    })
  }

  const confirmDeleteMetric = (metric: any) => {
    modals.openConfirmModal({
      title: t('business.metric.confirmDeleteTitle'),
      children: t('business.metric.confirmDeleteMsg', { name: metric.name }),
      labels: {
        confirm: t('business.metric.confirm'),
        cancel: t('business.metric.cancel')
      },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          const response = await deleteMetricReq(projectId, metric.id)
          if (response.success) {
            notifications.show({ color: 'green', message: t('business.metric.deleteSuccess') })
            // 删除后重新加载，如果当前页只有一条数据则返回上一页
            const isLastItemOnPage = metrics.length === 1
            const nextPage = isLastItemOnPage && currentPage > 1 ? currentPage - 1 : currentPage
            if (nextPage !== currentPage) setCurrentPage(nextPage)
            await loadMetrics(nextPage, pageSize)
          }
        } catch (error: any) {
          notifications.show({
            color: 'red',
            message: t('business.metric.deleteFailed') + ': ' + error.message
          })
        }
      }
    })
  }

  // 切换指标激活状态
  const toggleMetricActive = async (metric: any, isActive: boolean) => {
    try {
      setTogglingMetricId(metric.id)
      // 确保 isActive 是布尔值
      const activeValue = Boolean(isActive)
      console.log('更新指标状态:', metric.id, 'is_active:', activeValue)
      // 使用专门的启用/禁用状态更新 API，只传递 is_active 字段
      const response = await updateMetricStatusReq(projectId, metric.id, activeValue)
      if (response.success) {
        // 更新本地状态
        setMetrics((prev) => prev.map((m) => (m.id === metric.id ? { ...m, is_active: activeValue } : m)))
        notifications.show({
          color: 'green',
          message: activeValue ? t('business.metric.enabled') : t('business.metric.disabled')
        })
      }
    } catch (error: any) {
      console.error('更新指标状态失败:', error)
      notifications.show({
        color: 'red',
        message: t('business.metric.operationFailed') + ': ' + error.message
      })
    } finally {
      setTogglingMetricId(null)
    }
  }

  // 为单个指标生成向量
  const generateSingleEmbedding = async (metric: any) => {
    try {
      setGeneratingMetricId(metric.id)
      const response = await generateMetricEmbeddingsReq(projectId, metric.id)
      if (response.success) {
        notifications.show({
          color: 'green',
          message: t('business.metric.singleVectorGenSuccess', { name: metric.name })
        })
        await loadMetrics()
      }
    } catch (error: any) {
      console.error('生成向量失败:', error)
      notifications.show({
        color: 'red',
        message: t('business.metric.singleVectorGenFailed') + ': ' + error.message
      })
    } finally {
      setGeneratingMetricId(null)
    }
  }

  const generateAllEmbeddings = async (options: { fromImport?: boolean; pendingCount?: number } = {}) => {
    try {
      const countRes = await getMetricEmbeddingPendingCountReq(projectId)
      const pendingInBusiness = countRes?.data?.pending ?? 0
      if (!pendingInBusiness || pendingInBusiness <= 0) {
        notifications.show({ color: 'yellow', message: t('business.metric.noPendingEmbedding') })
        return
      }

      // 导入后「立即生成」：提示用本次导入未向量化的条数；工具栏「全部向量化」用业务内待处理总数
      const pendingForMessage =
        options.fromImport && options.pendingCount != null ? options.pendingCount : pendingInBusiness

      setGeneratingAll(true)
      setGeneratingMetricId(null)

      let waitMsg = t('business.metric.batchEmbeddingWait', { pending: pendingForMessage })
      if (options.fromImport) {
        waitMsg = t('business.metric.importEmbeddingWait', { pending: pendingForMessage })
        if (pendingInBusiness > pendingForMessage) {
          waitMsg +=
            ' ' +
            t('business.metric.importEmbeddingAlsoPendingInBusiness', {
              total: pendingInBusiness
            })
        }
      } else if (pendingInBusiness >= EMBEDDING_NGINX_HINT_THRESHOLD) {
        waitMsg += ' ' + t('business.metric.batchEmbeddingNginxHint')
      }
      notifications.show({ color: 'blue', message: waitMsg })

      const response = await generateMetricEmbeddingsReq(projectId)

      if (response?.success) {
        const d = response.data || {}
        const processedCount = typeof d.processed === 'number' ? d.processed : 0
        const countLine = t('business.metric.embeddingProcessedCount', { count: processedCount })

        if (d.completed === false) {
          const body = [response.message, countLine].filter(Boolean).join('\n')
          notifications.show({
            color: 'yellow',
            message: body,
            autoClose: 10000
          })
          await loadMetrics()
          return
        }

        if (processedCount > 0) {
          const body = [response.message, countLine].filter(Boolean).join('\n')
          notifications.show({ color: 'green', message: body })
        } else {
          notifications.show({
            color: 'green',
            message: response.message || t('business.metric.allVectorGenSuccess', { count: 0 })
          })
        }
        await loadMetrics()
      }
    } catch (error: any) {
      console.error('批量生成向量失败:', error)
      const respData = error?.data
      const processedCount = typeof respData?.processed === 'number' ? respData.processed : null
      const base = t('business.metric.batchVectorGenFailed') + ': ' + (error.message || '')
      if (processedCount !== null) {
        notifications.show({
          color: 'red',
          message: [base, t('business.metric.embeddingProcessedCount', { count: processedCount })].join('\n')
        })
      } else {
        notifications.show({ color: 'red', message: base })
      }
    } finally {
      setGeneratingAll(false)
      setGeneratingMetricId(null)
    }
  }

  const openBulkImportDialog = () => {
    setSelectedFile(null)
    setBulkImportSourceId('')
    // 重置上传组件
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
    setBulkImportDialogVisible(true)
    // 确保数据源列表已加载
    if (dataSources.length === 0) {
      loadDataSources()
    }
  }

  // 下载导入模板
  const downloadTemplate = () => {
    try {
      // 创建示例数据
      const templateData = [
        {
          指标名称: '个人住房贷款余额',
          指标向量化内容: '',
          SQL模板: "SELECT SUM(balance) FROM loans WHERE type = '住房贷款' AND {ENTITY_CONDITIONS}",
          描述: '个人住房贷款的总余额',
          关联表: 'loans',
          关联列: 'loans.balance,loans.type'
        },
        {
          指标名称: '企业贷款总额',
          指标向量化内容: '',
          SQL模板: 'SELECT SUM(amount) FROM enterprise_loans WHERE {ENTITY_CONDITIONS}',
          描述: '企业贷款的总金额',
          关联表: 'enterprise_loans',
          关联列: 'enterprise_loans.amount'
        },
        {
          指标名称: '存款余额',
          指标向量化内容: '',
          SQL模板: 'SELECT SUM(balance) FROM deposits WHERE {ENTITY_CONDITIONS}',
          描述: '所有存款账户的总余额',
          关联表: 'deposits',
          关联列: 'deposits.balance'
        }
      ]

      // 创建工作簿
      const workbook = XLSX.utils.book_new()

      // 创建工作表
      const worksheet = XLSX.utils.json_to_sheet(templateData)

      // 设置列宽
      worksheet['!cols'] = [
        { wch: 25 }, // 指标名称
        { wch: 50 }, // 指标向量化内容（预计算 embedding，可为空）
        { wch: 60 }, // SQL模板
        { wch: 30 }, // 描述
        { wch: 20 }, // 关联表
        { wch: 30 } // 关联列
      ]

      // 添加工作表到工作簿
      XLSX.utils.book_append_sheet(workbook, worksheet, '指标导入模板')

      // 下载文件
      XLSX.writeFile(workbook, '指标导入模板.xlsx')

      notifications.show({ color: 'green', message: t('business.metric.templateDownloadSuccess') })
    } catch (error: any) {
      console.error('下载模板失败:', error)
      notifications.show({
        color: 'red',
        message:
          t('business.metric.downloadTemplateFailed') +
          ': ' +
          (error.message || t('business.metric.unknownError'))
      })
    }
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null
    setSelectedFile(file)
  }

  const submitBulkImport = async () => {
    if (!selectedFile) {
      notifications.show({ color: 'yellow', message: t('business.metric.selectFileFirst') })
      return
    }

    // 校验文件对象
    const fileObj: any = selectedFile
    if (!(fileObj instanceof File) && !(fileObj instanceof Blob)) {
      notifications.show({ color: 'red', message: t('business.metric.invalidFileFormat') })
      return
    }

    try {
      setImporting(true)

      // 根据选择的数据源获取 source_id 和 source_type
      let sourceId = ''
      let sourceType = ''

      if (bulkImportSourceId) {
        const selectedSource = dataSources.find((ds) => ds.source_id === bulkImportSourceId)
        if (selectedSource) {
          sourceId = selectedSource.source_id
          sourceType = selectedSource.source_type
        }
      }

      const response = await bulkImportMetricsReq(projectId, sourceId,
        sourceType,
        selectedFile,
        bulkImportOverwrite
      )

      if (response.success) {
        const result = response.data
        const showImportErrorDialog = () => {
          const escapeHtml = (s: any) =>
            String(s ?? '')
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
          const listItems = result.errors
            .map((e: any) => {
              const hasRow = e.row != null && e.row !== ''
              const hasName = e.metric_name != null && e.metric_name !== ''
              let label = ''
              if (hasRow && hasName) {
                label =
                  escapeHtml(t('business.metric.importErrorRowLabel', { row: e.row })) +
                  `「${escapeHtml(e.metric_name)}」`
              } else if (hasName) {
                label = `「${escapeHtml(e.metric_name)}」`
              } else if (hasRow) {
                label = escapeHtml(t('business.metric.importErrorRowLabel', { row: e.row }))
              }
              return `<li style="margin:6px 0;line-height:1.5"><span style="font-weight:600">${label}</span>：${escapeHtml(e.error)}</li>`
            })
            .join('')
          const errorHtml = `<ul style="margin:8px 0 0;padding-left:20px;max-height:min(60vh,420px);overflow:auto;text-align:left">${listItems}</ul>`
          modals.open({
            title: t('business.metric.partialImportFailed'),
            children: <div dangerouslySetInnerHTML={{ __html: errorHtml }} />
          })
        }

        const validationFailed =
          result.error_count > 0 &&
          result.created === 0 &&
          result.updated === 0 &&
          result.skipped === 0
        if (validationFailed) {
          notifications.show({ color: 'yellow', message: result.message })
          showImportErrorDialog()
          return
        }

        notifications.show({ color: 'green', message: result.message })
        setBulkImportDialogVisible(false)
        // 状态重置会在关闭对话框的 onClose 中处理
        await loadMetrics()

        // 仅当本次新增指标存在未写入的向量时，才询问是否生成向量
        if (result.success_count > 0 && result.needs_embedding_prompt !== false) {
          modals.openConfirmModal({
            title: t('business.metric.generateVector'),
            children: t('business.metric.importSuccessGenVector', {
              total: result.created ?? result.success_count ?? 0,
              pending: result.pending_embedding_count ?? result.success_count ?? 0
            }),
            labels: {
              confirm: t('business.metric.generateNow'),
              cancel: t('business.metric.generateLater')
            },
            onConfirm: async () => {
              // 用户选择立即生成，调用生成所有向量
              await generateAllEmbeddings({
                fromImport: true,
                pendingCount: result.pending_embedding_count
              })
            }
          })
        }
      }
    } catch (error: any) {
      notifications.show({ color: 'red', message: t('business.metric.importFailed') + ': ' + error.message })
    } finally {
      setImporting(false)
    }
  }

  // 搜索指标
  const handleTestSearch = async () => {
    if (!searchQuery.trim()) {
      notifications.show({ color: 'yellow', message: t('business.metric.pleaseInputSearch') })
      return
    }

    try {
      setSearching(true)
      setHasSearched(true)
      const response = await searchMetricsReq(projectId, searchQuery, 10)
      if (response.success) {
        const items = response.data?.items || []
        setSearchResults(items)
        if (items.length === 0) {
          notifications.show({ color: 'blue', message: t('business.metric.noSimilarMetrics') })
        }
      }
    } catch (error: any) {
      console.error('搜索失败:', error)
      notifications.show({ color: 'red', message: t('business.metric.searchFailed') + ': ' + error.message })
    } finally {
      setSearching(false)
    }
  }

  // 监听 selectedTableColumnsConfig 变化，加载列的枚举映射（防抖）
  useEffect(() => {
    if (loadColumnMappingsTimer.current) {
      clearTimeout(loadColumnMappingsTimer.current)
    }
    loadColumnMappingsTimer.current = setTimeout(() => {
      loadColumnEnumMappings()
    }, 500)
    return () => {
      if (loadColumnMappingsTimer.current) clearTimeout(loadColumnMappingsTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTableColumnsConfig])

  // 生命周期：onMounted + watch(businessId)
  useEffect(() => {
    loadMetrics(1, pageSize, true)
    loadDataSources()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId])

  // 重置搜索状态（对话框关闭时）
  useEffect(() => {
    if (!showSearchDialog) {
      setSearchQuery('')
      setSearchResults([])
      setHasSearched(false)
    }
  }, [showSearchDialog])

  // 重置批量导入对话框状态（对话框关闭时）
  useEffect(() => {
    if (!bulkImportDialogVisible) {
      setSelectedFile(null)
      setBulkImportSourceId('')
      setBulkImportOverwrite(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }, [bulkImportDialogVisible])

  // 数据源下拉选项
  const dataSourceOptions = useMemo(
    () => dataSources.map((ds) => ({ value: String(ds.source_id), label: ds.name })),
    [dataSources]
  )

  // 自定义渲染：数据源选项前缀图标
  const renderDataSourceOption = ({ option }: any) => {
    const ds = dataSources.find((d) => String(d.source_id) === option.value)
    return (
      <div className={styles.rowSC} style={{ gap: 8 }}>
        {ds?.type === 'database' ? <ElSvgIcon name="Connection" size={16} /> : <ElSvgIcon name="Grid" size={16} />}
        <span>{option.label}</span>
      </div>
    )
  }

  return (
    <div className={styles.tabContainer}>
      {/* 统一的内容卡片 */}
      <div className={styles.contentCard}>
        {/* 顶部操作区 */}
        {metrics.length > 0 && (
          <div className={styles.operationsHeader}>
            <div className={styles.headerIntro}>
              <span>{t('business.metric.headerIntro')}</span>
            </div>
            <div className={styles.headerActions}>
              <Button
                variant="outline"
                color="red"
                disabled={bulkDeleteMode ? selectedCount === 0 : false}
                leftSection={<ElSvgIcon name="Delete" size={16} />}
                onClick={() => (bulkDeleteMode ? confirmBulkDelete() : enterBulkDeleteMode())}
              >
                {bulkDeleteMode
                  ? t('business.metric.bulkDelete') + (selectedCount > 0 ? `(${selectedCount})` : '')
                  : t('business.metric.deleteAll')}
              </Button>
              <Button
                variant="default"
                leftSection={<ElSvgIcon name="Search" size={16} />}
                onClick={() => setShowSearchDialog(true)}
              >
                {t('business.metric.searchMetric')}
              </Button>
              <Button
                variant="default"
                leftSection={<ElSvgIcon name="Plus" size={16} />}
                onClick={openAddMetricDialog}
              >
                {t('business.metric.createMetric')}
              </Button>
              <Button
                variant="default"
                leftSection={<ElSvgIcon name="Upload" size={16} />}
                onClick={openBulkImportDialog}
              >
                {t('business.metric.bulkImport')}
              </Button>
              <Button
                variant="default"
                loading={generatingAll}
                disabled={metrics.length === 0}
                leftSection={<ElSvgIcon name="Connection" size={16} />}
                onClick={() => generateAllEmbeddings()}
              >
                {t('business.metric.generateAllVectors')}
              </Button>
            </div>
          </div>
        )}

        {/* 指标列表 */}
        <div className={`${styles.metricsSection} metrics-section`}>
          {metrics.length === 0 ? (
            <MetricEmptyState onAddMetric={openAddMetricDialog} onBulkImport={openBulkImportDialog} />
          ) : (
            <div className={styles.metricsList}>
              {bulkDeleteMode && isAllPageSelected && !selectAllAcrossPages && totalMetrics > metrics.length && (
                <div className={styles.bulkSelectBanner}>
                  <span>{t('business.metric.selectAllPagesHint', { pageCount: metrics.length })}</span>
                  <Button variant="subtle" size="compact-sm" onClick={selectAllMetricsAcrossPages}>
                    {t('business.metric.selectAllMetricsAction', { total: totalMetrics })}
                  </Button>
                </div>
              )}
              {bulkDeleteMode && selectAllAcrossPages ? (
                <div className={styles.bulkSelectBanner}>
                  <span>{t('business.metric.selectAllMetricsDone', { total: totalMetrics })}</span>
                  <Button variant="subtle" size="compact-sm" onClick={clearAllSelection}>
                    {t('business.metric.clearSelectAllMetrics')}
                  </Button>
                </div>
              ) : (
                bulkDeleteMode &&
                hasCrossPageSelection && (
                  <div className={styles.bulkSelectBanner}>
                    <span>{t('business.metric.crossPageSelectedHint', { count: selectedCount })}</span>
                  </div>
                )
              )}

              <Table className={styles.metricsTable} verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    {bulkDeleteMode && (
                      <Table.Th style={{ width: 120, textAlign: 'center' }}>
                        <div className={styles.bulkSelectHeader} onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            checked={isAllSelected}
                            indeterminate={isIndeterminate}
                            onChange={toggleSelectAll}
                          />
                          <span className={styles.bulkSelectCancel} onClick={exitBulkDeleteMode}>
                            {t('business.metric.cancelDelete')}
                          </span>
                        </div>
                      </Table.Th>
                    )}
                    <Table.Th style={{ width: 70, textAlign: 'center' }}>{t('business.metric.enable')}</Table.Th>
                    <Table.Th style={{ minWidth: 180 }}>{t('business.metric.metricName')}</Table.Th>
                    <Table.Th style={{ minWidth: 250 }}>{t('business.metric.calcMethod')}</Table.Th>
                    <Table.Th style={{ width: 120, textAlign: 'center' }}>
                      {t('business.metric.vectorization')}
                    </Table.Th>
                    <Table.Th style={{ width: 150, textAlign: 'right' }}>{t('business.metric.actions')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {metrics.map((row) => (
                    <Table.Tr key={row.id} onClick={() => handleRowClick(row)}>
                      {bulkDeleteMode && (
                        <Table.Td style={{ textAlign: 'center' }}>
                          <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex' }}>
                            <Checkbox
                              checked={isSelected(row.id)}
                              onChange={(e) => setSelected(row.id, e.currentTarget.checked)}
                            />
                          </span>
                        </Table.Td>
                      )}
                      <Table.Td style={{ textAlign: 'center' }}>
                        <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex' }}>
                          <Switch
                            size="sm"
                            checked={!!row.is_active}
                            disabled={togglingMetricId === row.id}
                            onChange={(e) => toggleMetricActive(row, e.currentTarget.checked)}
                          />
                        </span>
                      </Table.Td>
                      <Table.Td>
                        <div className={styles.nameCell}>
                          <span className={styles.nameText}>{row.name}</span>
                          {row.description && <span className={styles.nameDesc}>{row.description}</span>}
                        </div>
                      </Table.Td>
                      <Table.Td>
                        <span className={styles.sqlText}>{cleanSqlTemplate(row.sql_template)}</span>
                      </Table.Td>
                      <Table.Td>
                        <div className={styles.embeddingCell} onClick={(e) => e.stopPropagation()}>
                          <Badge color={row.has_embedding ? 'green' : 'yellow'} size="sm">
                            {row.has_embedding
                              ? t('business.metric.vectorized')
                              : t('business.metric.notVectorized')}
                          </Badge>
                          {generatingMetricId !== row.id ? (
                            <span
                              className={styles.refreshIcon}
                              title={
                                row.has_embedding
                                  ? t('business.metric.reVectorize')
                                  : t('business.metric.vectorize')
                              }
                              onClick={() => generateSingleEmbedding(row)}
                            >
                              <ElSvgIcon name="Refresh" size={14} />
                            </span>
                          ) : (
                            <span className={`${styles.refreshIcon} ${styles.loading}`}>
                              <ElSvgIcon name="Loading" size={14} />
                            </span>
                          )}
                        </div>
                      </Table.Td>
                      <Table.Td>
                        <div className={styles.actionLinks} onClick={(e) => e.stopPropagation()}>
                          <span className={`${styles.actionLink} ${styles.primary}`} onClick={() => copyMetric(row)}>
                            {t('business.metric.copy')}
                          </span>
                          <span className={`${styles.actionLink} ${styles.primary}`} onClick={() => editMetric(row)}>
                            {t('business.metric.edit')}
                          </span>
                          <span
                            className={`${styles.actionLink} ${styles.danger}`}
                            onClick={() => confirmDeleteMetric(row)}
                          >
                            {t('business.metric.delete')}
                          </span>
                        </div>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>

              {/* 分页 */}
              {totalMetrics > 0 && (
                <div className={styles.paginationWrapper}>
                  {/* TODO(migration): el-pagination 的 sizes/jumper/total 在 Mantine 无内置，保留页码 + 每页数量选择 */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <Text size="sm" c="dimmed">
                      {totalMetrics}
                    </Text>
                    {!isMobile && metricPaginationLayout.includes('sizes') && (
                      <Select
                        size="xs"
                        w={110}
                        value={String(pageSize)}
                        data={[12, 20, 50, 100].map((n) => ({ value: String(n), label: `${n} / page` }))}
                        onChange={(val) => val && handlePageSizeChange(Number(val))}
                      />
                    )}
                    <Pagination
                      total={totalPages}
                      value={currentPage}
                      onChange={handlePageChange}
                      size={isMobile ? 'sm' : 'md'}
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 新建/编辑指标对话框 */}
      <Modal
        opened={metricDialogVisible}
        onClose={() => {
          setMetricDialogVisible(false)
          resetMetricForm()
        }}
        title={editingMetric ? t('business.metric.editMetric') : t('business.metric.createMetric')}
        size="90%"
        centered={false}
      >
        <div className={styles.metricFormRef}>
          <TextInput
            label={t('business.metric.metricName')}
            required
            value={metricForm.name}
            placeholder={t('business.metric.metricNamePlaceholder')}
            error={formErrors.name}
            onChange={(e) => setFormField({ name: e.currentTarget.value })}
            mb="md"
          />
          <TextInput
            label={t('business.metric.metricAlias')}
            value={metricForm.aliases}
            placeholder={t('business.metric.aliasPlaceholder')}
            description={t('business.metric.aliasTip')}
            onChange={(e) => setFormField({ aliases: e.currentTarget.value })}
            mb="md"
          />
          <Textarea
            label={t('business.metric.description')}
            value={metricForm.description}
            autosize
            minRows={2}
            placeholder={t('business.metric.descriptionPlaceholder')}
            onChange={(e) => setFormField({ description: e.currentTarget.value })}
            mb="md"
          />
          <Textarea
            label={t('business.metric.calcMethod')}
            required
            value={metricForm.sql_template}
            autosize
            minRows={3}
            placeholder={t('business.metric.calcPlaceholder')}
            description={t('business.metric.calcTip')}
            error={formErrors.sql_template}
            onChange={(e) => setFormField({ sql_template: e.currentTarget.value })}
            mb="md"
          />

          {/* 关联表与列 */}
          <div className={styles.fullWidthFormItem} style={{ marginBottom: 16 }}>
            <Text size="sm" fw={500} mb={6}>
              {t('business.metric.relatedTablesColumns')}
            </Text>
            <div className={styles.schemaSection}>
              <div className={styles.schemaSelectorHeader}>
                <Select
                  value={metricForm.source_id ? String(metricForm.source_id) : null}
                  placeholder={t('business.metric.selectDataSource')}
                  clearable
                  data={dataSourceOptions}
                  renderOption={renderDataSourceOption}
                  onChange={(val) => handleDataSourceChange(val ? val : null)}
                  style={{ width: 300 }}
                />
              </div>
              {connectionId ? (
                <TableColumnSelector
                  modelValue={selectedTableColumnsConfig}
                  databaseId={connectionId}
                  sourceType={selectedSourceType}
                  databaseConnectionId={selectedDatabaseConnectionId}
                  {...{
                    'onUpdate:modelValue': (val: any) => {
                      setSelectedTableColumnsConfig(val)
                      selectedConfigRef.current = val
                    }
                  }}
                />
              ) : (
                <div className={styles.noDatasourceHint}>
                  <Center>
                    <Text c="dimmed" size="sm">
                      {t('business.metric.selectDataSourceHint')}
                    </Text>
                  </Center>
                </div>
              )}
            </div>
          </div>

          {/* 码值配置（统一数据结构） */}
          <div className={styles.fullWidthFormItem} style={{ marginBottom: 16 }}>
            <Text size="sm" fw={500} mb={6}>
              {t('business.metric.codeKnowledgeLabel')}
            </Text>
            <CodeKnowledgeConditionBuilder
              codeKnowledge={metricForm.code_knowledge}
              relatedColumns={selectedTableColumnsConfig}
              columnEnumMappings={columnEnumMappings}
              businessId={businessId}
              projectId={projectId}
              {...{
                'onUpdate:codeKnowledge': (val: any) => setFormField({ code_knowledge: val })
              }}
            />
            <Text c="dimmed" size="xs" mt={8} style={{ display: 'block' }}>
              {t('business.metric.codeKnowledgeTip')}
            </Text>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Button variant="default" onClick={() => setMetricDialogVisible(false)}>
            {t('business.metric.cancel')}
          </Button>
          <Button onClick={submitMetricForm} loading={submitting}>
            {editingMetric ? t('business.metric.save') : t('business.metric.create')}
          </Button>
        </div>
      </Modal>

      {/* 批量导入对话框 */}
      <Modal
        opened={bulkImportDialogVisible}
        onClose={() => setBulkImportDialogVisible(false)}
        title={t('business.metric.bulkImportMetric')}
        size="50%"
      >
        <div className={styles.bulkImportContent}>
          <Alert color="blue" title={t('business.metric.excelFormatTitle')} mb={16}>
            <div>
              <strong>{t('business.metric.requiredColumns')}</strong>
            </div>
            <ul>
              <li>
                <strong>{t('business.metric.metricName')}</strong>: {t('business.metric.metricNameDesc')}
              </li>
              <li>
                <strong>{t('business.metric.calcMethod')}</strong>: {t('business.metric.calcMethodDesc')}
              </li>
            </ul>
            <div>
              <strong>{t('business.metric.optionalColumns')}</strong>
            </div>
            <ul>
              <li>
                <strong>{t('business.metric.vectorizationContentColumn')}</strong>:{' '}
                {t('business.metric.vectorizationContentDesc')}
              </li>
              <li>
                <strong>{t('business.metric.description')}</strong>: {t('business.metric.descColumnDesc')}
              </li>
              <li>
                <strong>{t('business.metric.relatedTables')}</strong>: {t('business.metric.relatedTablesDesc')}
              </li>
              <li>
                <strong>{t('business.metric.relatedColumns')}</strong>: {t('business.metric.relatedColumnsDesc')}
              </li>
            </ul>
            <div style={{ marginTop: 12, color: '#909399', fontSize: 12 }}>
              <strong>{t('business.metric.noteLabel')}</strong>
              {t('business.metric.noteContent')}
            </div>
          </Alert>
          <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center' }}>
            <Button leftSection={<ElSvgIcon name="Download" size={16} />} onClick={downloadTemplate}>
              {t('business.metric.downloadTemplate')}
            </Button>
            {/* el-upload(:auto-upload=false) → 隐藏 input + 触发按钮 */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
            <Button variant="default" onClick={() => fileInputRef.current?.click()}>
              {t('business.metric.selectExcelFile')}
            </Button>
          </div>
          {selectedFile && (
            <div className={styles.selectedFile} style={{ marginBottom: 16 }}>
              <Text>
                {t('business.metric.selectedFile')}: {selectedFile.name}
              </Text>
            </div>
          )}

          {/* 数据源选择（始终显示） */}
          <div style={{ marginTop: 20 }}>
            <Text size="sm" fw={500} mb={6}>
              {t('business.metric.relatedDataSource')}
            </Text>
            <Select
              value={bulkImportSourceId ? String(bulkImportSourceId) : null}
              placeholder={t('business.metric.selectDataSourceOptional')}
              clearable
              disabled={dataSources.length === 0}
              data={dataSourceOptions}
              renderOption={renderDataSourceOption}
              onChange={(val) => setBulkImportSourceId(val || '')}
              style={{ width: '100%' }}
            />
            <Text c="dimmed" size="xs" mt={8} style={{ display: 'block' }}>
              {t('business.metric.importDataSourceTip')}
            </Text>
            {dataSources.length === 0 && (
              <Text c="orange" size="xs" mt={8} style={{ display: 'block' }}>
                {t('business.metric.noAvailableDataSources')}
              </Text>
            )}
          </div>

          {/* 覆盖选项 */}
          <div style={{ marginTop: 16, display: 'flex', alignItems: 'center' }}>
            <Checkbox
              checked={bulkImportOverwrite}
              onChange={(e) => setBulkImportOverwrite(e.currentTarget.checked)}
              label={t('business.metric.overwriteExisting')}
            />
            <Text c="dimmed" size="xs" ml={8}>
              {t('business.metric.overwriteTip')}
            </Text>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Button variant="default" onClick={() => setBulkImportDialogVisible(false)}>
            {t('business.metric.cancel')}
          </Button>
          <Button onClick={submitBulkImport} loading={importing} disabled={!selectedFile}>
            {t('business.metric.startImport')}
          </Button>
        </div>
      </Modal>

      {/* 搜索指标对话框 */}
      <Modal
        opened={showSearchDialog}
        onClose={() => setShowSearchDialog(false)}
        title={t('business.metric.searchMetric')}
        size="70%"
      >
        <div className={styles.searchDialogContent}>
          <TextInput
            className={styles.searchInput}
            size="lg"
            value={searchQuery}
            placeholder={t('business.metric.searchPlaceholder')}
            onChange={(e) => setSearchQuery(e.currentTarget.value)}
            onKeyUp={(e) => {
              if (e.key === 'Enter') handleTestSearch()
            }}
            rightSection={
              <span
                className={`${styles.searchIconBtn} ${searching ? styles.searching : ''}`}
                onClick={handleTestSearch}
              >
                {!searching ? <ElSvgIcon name="Search" size={22} /> : <ElSvgIcon name="Loading" size={22} />}
              </span>
            }
          />

          {/* 搜索结果 */}
          {searchResults.length > 0 ? (
            <div className={styles.searchResultsList}>
              <div className={styles.resultsHeader}>
                <h4>
                  {t('business.metric.recallResults')} ({searchResults.length})
                </h4>
              </div>
              <div className={styles.resultsList}>
                {searchResults.map((result, index) => (
                  <div key={index} className={styles.resultItem} onClick={() => editMetric(result)}>
                    <div className={styles.resultHeader}>
                      <Badge size="sm" color="green">
                        {t('business.metric.similarity')}: {(result.similarity * 100).toFixed(1)}%
                      </Badge>
                    </div>
                    <div className={styles.resultBody}>
                      <div className={styles.resultName}>
                        <span className={styles.label}>{t('business.metric.metricName')}:</span>
                        <span className={styles.content}>{result.name}</span>
                      </div>
                      {result.description && (
                        <div className={styles.resultDescription}>
                          <span className={styles.label}>{t('business.metric.description')}:</span>
                          <span className={styles.content}>{result.description}</span>
                        </div>
                      )}
                      <div className={styles.resultSql}>
                        <span className={styles.label}>{t('business.metric.calcMethod')}:</span>
                        <pre className={styles.content}>{result.sql_template}</pre>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            hasSearched &&
            searchResults.length === 0 && (
              <div className={styles.noResults}>
                <Center>
                  <Text c="dimmed">{t('business.metric.noSimilarMetrics')}</Text>
                </Center>
              </div>
            )
          )}
        </div>
      </Modal>

      {/* 码值配置说明对话框 */}
      <Modal
        opened={codeKnowledgeHelpDialogVisible}
        onClose={() => setCodeKnowledgeHelpDialogVisible(false)}
        title={t('business.metric.codeKnowledgeHelpTitle')}
        size="70%"
      >
        <div className={styles.codeKnowledgeHelpContent}>
          <Alert color="blue" title={t('business.metric.codeKnowledgeWhatTitle')} mb={16}>
            <p>{t('business.metric.codeKnowledgeWhatDesc1')}</p>
            <p>{t('business.metric.codeKnowledgeWhatDesc2')}</p>
          </Alert>

          <h3>{t('business.metric.codeKnowledgeJsonExample')}</h3>
          <Textarea
            readOnly
            autosize
            minRows={15}
            value={`{\n  "fields": [\n    {\n      "field_name": "CARD_KIND_CD",\n      "field_display_name": "卡种类",\n      "description": "银行卡种类编码",\n      "code_values": [\n        {\n          "code": "01",\n          "label": "借记卡",\n          "aliases": ["储蓄卡", "银行卡"]\n        },\n        {\n          "code": "02",\n          "label": "贷记卡",\n          "aliases": ["信用卡"]\n        },\n        {\n          "code": "03",\n          "label": "绿卡通",\n          "aliases": []\n        }\n      ]\n    }\n  ],\n  "common_filters": [\n    {\n      "description": "查询绿卡通",\n      "condition": "CARD_KIND_CD = \\"03\\"",\n      "user_keywords": ["绿卡通", "绿卡通卡"]\n    },\n    {\n      "description": "查询借记卡",\n      "condition": "CARD_KIND_CD IN (\\"01\\", \\"03\\")",\n      "user_keywords": ["借记卡", "储蓄卡"]\n    }\n  ]\n}`}
            styles={{ input: { fontFamily: 'monospace' } }}
            mb={16}
          />

          <h3>{t('business.metric.codeKnowledgeFieldDesc')}</h3>
          {/* el-descriptions → Mantine 无等价物，用 Table 呈现字段说明 */}
          <Table withTableBorder withColumnBorders>
            <Table.Tbody>
              {[
                ['fields', t('business.metric.codeKnowledgeFieldsDesc')],
                ['field_name', t('business.metric.codeKnowledgeFieldNameDesc')],
                ['field_display_name', t('business.metric.codeKnowledgeDisplayNameDesc')],
                ['description', t('business.metric.codeKnowledgeDescriptionDesc')],
                ['code_values', t('business.metric.codeKnowledgeCodeValuesDesc')],
                ['code', t('business.metric.codeKnowledgeCodeDesc')],
                ['label', t('business.metric.codeKnowledgeLabelDesc')],
                ['aliases', t('business.metric.codeKnowledgeAliasesDesc')],
                ['common_filters', t('business.metric.codeKnowledgeCommonFiltersDesc')],
                ['description', t('business.metric.codeKnowledgeConditionDescDesc')],
                ['condition', t('business.metric.codeKnowledgeConditionDesc')],
                ['user_keywords', t('business.metric.codeKnowledgeUserKeywordsDesc')]
              ].map(([label, desc], i) => (
                <Table.Tr key={i}>
                  <Table.Th style={{ width: 180, whiteSpace: 'nowrap' }}>{label}</Table.Th>
                  <Table.Td>{desc}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>

          <Alert color="yellow" title={t('business.metric.codeKnowledgeTipTitle')} mt={16}>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              <li>{t('business.metric.codeKnowledgeTip1')}</li>
              <li>{t('business.metric.codeKnowledgeTip2')}</li>
              <li>{t('business.metric.codeKnowledgeTip3')}</li>
            </ul>
          </Alert>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <Button onClick={() => setCodeKnowledgeHelpDialogVisible(false)}>{t('business.metric.gotIt')}</Button>
        </div>
      </Modal>
    </div>
  )
}
