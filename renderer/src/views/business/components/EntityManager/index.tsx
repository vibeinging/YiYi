// 实体管理（标准名词）视图
// 源：views/business/components/EntityManager/index.vue
// 说明：
// - el-pagination → 自建 分页行（total 文本 + page-size Select + Mantine Pagination 翻页器 + jumper）
// - ElMessageBox.prompt（精确文本确认 + 一键填充按钮）→ 自建受控 ConfirmDeleteModal，保留原 i18n key 与校验逻辑
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Group, LoadingOverlay, NumberInput, Pagination, Select, Text, TextInput, Modal, Button, Stack } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useTranslation } from 'react-i18next'

import { useResponsive } from '@/hooks/use-responsive'

// API
import {
  createEntityConfigReq,
  getEntityConfigsReq,
  deleteEntityConfigReq,
  updateEntityConfigReq,
  searchEntitiesReq,
  generateEntityEmbeddingsReq,
  createColumnNameEntitiesReq,
  testEntityAgentReq,
  batchRevertAutoPromotedEntitiesReq,
} from '@/api/business-semantic'

// Composables
import { useDataSource } from './composables/useDataSource'

// Components
import EntityToolbar from './components/EntityToolbar'
import EntityList from './components/EntityList'
import EmptyState from './components/EmptyState'
import AddColumnValueDialog from './components/dialogs/AddColumnValueDialog'
import ColumnNameDialog from './components/dialogs/ColumnNameDialog'
import SearchTestDialog from './components/dialogs/SearchTestDialog'
import EditRuleDialog from './components/dialogs/EditRuleDialog'

import styles from './index.module.scss'

export interface EntityManagerProps {
  projectId: string
  businessId: string
}

// ElMessageBox.prompt 的受控替代弹窗的内部状态
interface DeletePromptState {
  open: boolean
  title: string // 弹窗标题
  hint: string // confirmInputHint 文案
  expected: string // 需要精确输入的文本（如 table.column 或 tableName）
  placeholder: string // 输入框占位
  onConfirm: () => void // 校验通过后的删除回调
}

export default function EntityManager(props: EntityManagerProps) {
  const { projectId, businessId } = props
  const { t } = useTranslation()
  const { isMobile } = useResponsive()

  // Use composables
  const {
    availableDataSources,
    selectedDataSource,
    loadingDataSources,
    allTables,
    loadAvailableDataSources,
    loadTables,
    loadTableColumns,
    handleDataSourceChange: changeDataSource,
  } = useDataSource(projectId)

  // State
  const [entityMappings, setEntityMappings] = useState<any[]>([])
  const [saving, setSaving] = useState(false)
  const [savingColumnNameEntities, setSavingColumnNameEntities] = useState(false)

  // 分页状态
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [total, setTotal] = useState(0)
  const [loadingMappings, setLoadingMappings] = useState(false)

  // Dialog visibility
  const [addEntityDialogVisible, setAddEntityDialogVisible] = useState(false)
  const [columnNameDialogVisible, setColumnNameDialogVisible] = useState(false)
  const [searchDialogVisible, setSearchDialogVisible] = useState(false)
  const [editRuleDialogVisible, setEditRuleDialogVisible] = useState(false)

  // Search state
  const [searchKeyword, setSearchKeyword] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [searching, setSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const [agentTesting, setAgentTesting] = useState(false)
  const [agentResult, setAgentResult] = useState<any>(null)

  // Edit rule state
  const [editingRuleConfig, setEditingRuleConfig] = useState<any>(null)
  const [savingRule, setSavingRule] = useState(false)

  // Loading states
  const [togglingConfig, setTogglingConfig] = useState<any>(null)
  const [generatingTableColumn, setGeneratingTableColumn] = useState<any>(null)
  const [generatingColumnNameTable, setGeneratingColumnNameTable] = useState<any>(null)
  const [deletingTableColumn, setDeletingTableColumn] = useState<any>(null)
  const [deletingColumnNameTable, setDeletingColumnNameTable] = useState<any>(null)

  // D.3 自动生成实体筛选
  const [showAutoPromotedOnly, setShowAutoPromotedOnly] = useState(false)

  const paginationLayout = useMemo(
    () => (isMobile ? 'total, prev, pager, next' : 'total, sizes, prev, pager, next, jumper'),
    [isMobile]
  )

  // Computed: 按表分组的 column_value 配置
  const groupedColumnValueMappings = useMemo(() => {
    const grouped: Record<string, any> = {}
    entityMappings
      .filter((config: any) => config.entity_type === 'column_value')
      .forEach((config: any) => {
        const tableName = config.table_name
        if (!grouped[tableName]) {
          grouped[tableName] = {
            table_name: tableName,
            configs: [],
            totalEntities: 0,
          }
        }
        grouped[tableName].configs.push(config)
        grouped[tableName].totalEntities += config.entity_count || 0
      })
    return Object.values(grouped)
  }, [entityMappings])

  const groupedColumnNameMappings = useMemo(() => {
    return entityMappings
      .filter((config: any) => config.entity_type === 'column_name')
      .map((config: any) => ({
        id: config.id,
        table_name: config.table_name,
        columns: config.columns || [], // 使用返回的 columns 字段（包含 column_name 和 description）
        vector_status: config.vector_status,
        vector_error: config.vector_error,
        entity_count: config.entity_count || 0,
        is_active: config.is_active !== false,
      }))
  }, [entityMappings])

  const mergedEntityMappings = useMemo(() => {
    const result: any[] = []
    groupedColumnValueMappings.forEach((table: any) => {
      result.push({
        ...table,
        type: 'column_value',
        key: `cv-${table.table_name}`,
      })
    })
    groupedColumnNameMappings.forEach((table: any) => {
      result.push({
        ...table,
        type: 'column_name',
        key: `cn-${table.table_name}`,
      })
    })
    return result
  }, [groupedColumnValueMappings, groupedColumnNameMappings])

  // 是否存在任何 auto_promoted=true 的配置
  const hasAutoPromoted = useMemo(
    () =>
      entityMappings.some((config: any) => {
        if (config.auto_promoted === true) return true
        // column_name 类型可能在 columns 数组里标
        if (Array.isArray(config.columns) && config.columns.some((c: any) => c.auto_promoted)) return true
        return false
      }),
    [entityMappings]
  )

  // 应用 filter 后的展示列表
  const displayedEntityMappings = useMemo(() => {
    if (!showAutoPromotedOnly) return mergedEntityMappings
    return mergedEntityMappings
      .map((table: any) => {
        if (table.type === 'column_value') {
          const filtered = (table.configs || []).filter((c: any) => c.auto_promoted)
          if (!filtered.length) return null
          // 重算 totalEntities 跟过滤后的 configs 一致
          const totalEntities = filtered.reduce((sum: number, c: any) => sum + (c.entity_count || 0), 0)
          return { ...table, configs: filtered, totalEntities }
        }
        if (table.type === 'column_name') {
          const filteredCols = (table.columns || []).filter((c: any) => c.auto_promoted)
          if (!filteredCols.length) return null
          return { ...table, columns: filteredCols }
        }
        return null
      })
      .filter(Boolean)
  }, [showAutoPromotedOnly, mergedEntityMappings])

  function handleToggleAutoPromotedFilter(v: any) {
    setShowAutoPromotedOnly(!!v)
  }

  // ====== 生成中状态轮询 ======
  const pollingTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  // 用 ref 持有最新的 entityMappings，供轮询回调读取（避免闭包旧值）
  const entityMappingsRef = useRef<any[]>(entityMappings)
  entityMappingsRef.current = entityMappings

  // Methods
  const loadEntityMappings = useCallback(
    async (page?: number, size?: number) => {
      const p = page ?? currentPage
      const s = size ?? pageSize
      try {
        setLoadingMappings(true)
        const res = await getEntityConfigsReq(projectId, p, s)
        if (res.success) {
          setEntityMappings(res.data.items || [])
          setTotal(res.data.total || 0)
          setCurrentPage(p)
          setPageSize(s)
        }
      } catch (error) {
        console.error('加载标准名词失败:', error)
      } finally {
        setLoadingMappings(false)
      }
    },
    [projectId, businessId, currentPage, pageSize]
  )

  const startPollingIfNeeded = useCallback(() => {
    if (pollingTimer.current) return
    if (!entityMappingsRef.current.some((c: any) => c.vector_status === '生成中')) return
    pollingTimer.current = setInterval(async () => {
      await loadEntityMappings()
      if (!entityMappingsRef.current.some((c: any) => c.vector_status === '生成中')) {
        if (pollingTimer.current) {
          clearInterval(pollingTimer.current)
          pollingTimer.current = null
        }
      }
    }, 5000)
  }, [loadEntityMappings])

  const stopPolling = useCallback(() => {
    if (pollingTimer.current) {
      clearInterval(pollingTimer.current)
      pollingTimer.current = null
    }
  }, [])

  // onMounted + onUnmounted
  useEffect(() => {
    ;(async () => {
      await loadEntityMappings()
      startPollingIfNeeded()
    })()
    return () => {
      stopPolling()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 批量撤销自动生成
  async function handleBatchRevertAutoPromoted() {
    if (!hasAutoPromoted) {
      notifications.show({ color: 'blue', message: t('business.entity.batchRevertEmpty', '当前没有自动生成的实体配置') })
      return
    }
    try {
      const res = await batchRevertAutoPromotedEntitiesReq(projectId)
      if (res.success) {
        const count = res.data?.reverted_count ?? res.data?.count ?? 0
        notifications.show({ color: 'green', message: t('business.entity.batchRevertSuccess', { count }) })
        await loadEntityMappings()
      } else {
        notifications.show({
          color: 'yellow',
          message: res.msg || t('business.entity.batchRevertPendingBackend', '后端 API 开发中,暂不可用'),
        })
      }
    } catch (error: any) {
      // 后端 API 未实现(404)或权限/网络异常 → 不阻塞用户,只提示
      const status = error?.response?.status
      if (status === 404 || status === 501) {
        notifications.show({
          color: 'yellow',
          message: t('business.entity.batchRevertPendingBackend', '后端 API 开发中,暂不可用'),
        })
      } else {
        notifications.show({
          color: 'red',
          message: error?.response?.data?.message || error?.message || 'Batch revert failed',
        })
      }
    }
  }

  // 分页事件
  const handlePageChange = (page: number) => {
    loadEntityMappings(page, pageSize)
  }

  const handleSizeChange = (size: number) => {
    loadEntityMappings(1, size)
  }

  const handleDataSourceChange = async (source: any) => {
    await changeDataSource(source)
  }

  const handleSelectTable = async (table: any) => {
    if (!table.columns || table.columns.length === 0) {
      table.columns = await loadTableColumns(table.id)
    }
  }

  // Open dialogs
  const openAddEntityDialog = async () => {
    setAddEntityDialogVisible(true)
    await loadAvailableDataSources()
    if (selectedDataSource) {
      await loadTables()
    }
  }

  const openColumnNameDialog = async () => {
    setColumnNameDialogVisible(true)
    await loadAvailableDataSources()
    if (selectedDataSource) {
      await loadTables()
    }
  }

  const openSearchDialog = () => {
    setSearchDialogVisible(true)
    setSearchKeyword('')
    setSearchResults([])
    setHasSearched(false)
    setAgentResult(null)
  }

  const openEditRuleDialog = (config: any) => {
    setEditingRuleConfig(config)
    setEditRuleDialogVisible(true)
  }

  // Save methods
  const saveColumnValueEntities = async (configs: any[]) => {
    if (configs.length === 0) return

    setSaving(true)
    try {
      for (const config of configs) {
        await createEntityConfigReq(projectId, {
          source_id: config.source_id,
          source_type: config.source_type,
          table_id: config.table_id,
          column_name: config.column_name,
          metadata_fields: config.metadata_fields?.length > 0 ? config.metadata_fields : null,
          rule: config.rule?.trim() || null,
        })
      }
      notifications.show({
        color: 'green',
        message: t('business.entity.createColumnValueSuccess', { count: configs.length }),
      })
      setAddEntityDialogVisible(false)
      await loadEntityMappings()
    } catch (error) {
      console.error('创建数据名词失败:', error)
    } finally {
      setSaving(false)
    }
  }

  const saveColumnNameEntities = async (configs: any[]) => {
    if (configs.length === 0) return

    setSavingColumnNameEntities(true)
    try {
      // 获取数据源类型
      const sourceType = selectedDataSource?.type || 'database'

      // 按表分组，保留列名和描述
      const tableGroups: Record<string, any[]> = {}
      for (const config of configs) {
        if (!tableGroups[config.table_id]) {
          tableGroups[config.table_id] = []
        }
        tableGroups[config.table_id].push({
          column_name: config.column_name,
          description: config.entity_name !== config.column_name ? config.entity_name : null,
        })
      }

      let totalCount = 0
      for (const [tableId, columns] of Object.entries(tableGroups)) {
        const res = await createColumnNameEntitiesReq(projectId, tableId, sourceType, columns)
        if (res.success) {
          totalCount += res.data.count || columns.length
        } else {
          notifications.show({
            color: 'red',
            message: res.msg || t('business.entity.createColumnNamePartialFail'),
          })
        }
      }

      notifications.show({
        color: 'green',
        message: t('business.entity.createColumnNameSuccess', { count: totalCount }),
      })
      setColumnNameDialogVisible(false)
      await loadEntityMappings()
    } catch (error) {
      console.error('创建字段名词失败:', error)
    } finally {
      setSavingColumnNameEntities(false)
    }
  }

  const saveRule = async (ruleValue: any) => {
    if (savingRule || !editingRuleConfig) return

    setSavingRule(true)
    try {
      const res = await updateEntityConfigReq(projectId, editingRuleConfig.id, {
        rule: ruleValue,
      })
      if (res.success) {
        notifications.show({ color: 'green', message: t('business.entity.ruleUpdated') })
        setEditRuleDialogVisible(false)
        await loadEntityMappings()
      } else {
        notifications.show({ color: 'red', message: res.msg || t('business.entity.ruleUpdateFailed') })
      }
    } catch (error: any) {
      console.error('更新规则描述失败:', error)
      notifications.show({ color: 'red', message: t('business.entity.ruleUpdateFailed') + ': ' + error.message })
    } finally {
      setSavingRule(false)
    }
  }

  // Toggle active state
  const toggleConfigActive = async (config: any, isActive: boolean) => {
    setTogglingConfig(config.id)
    try {
      const res = await updateEntityConfigReq(projectId, config.id, {
        is_active: isActive,
      })
      if (res.success) {
        notifications.show({
          color: 'green',
          message: isActive ? t('business.entity.enabled') : t('business.entity.disabled'),
        })
        // 本地同步状态（源里直接改 config.is_active，React 走 entityMappings 更新）
        setEntityMappings((prev) =>
          prev.map((c: any) => (c.id === config.id ? { ...c, is_active: isActive } : c))
        )
      } else {
        // 回滚
        setEntityMappings((prev) =>
          prev.map((c: any) => (c.id === config.id ? { ...c, is_active: !isActive } : c))
        )
        notifications.show({ color: 'red', message: res.msg || t('business.entity.updateStatusFailed') })
      }
    } catch (error: any) {
      setEntityMappings((prev) =>
        prev.map((c: any) => (c.id === config.id ? { ...c, is_active: !isActive } : c))
      )
      console.error('更新激活状态失败:', error)
      notifications.show({ color: 'red', message: t('business.entity.updateStatusFailed') + ': ' + error.message })
    } finally {
      setTogglingConfig(null)
    }
  }

  const toggleColumnNameConfigActive = async (table: any, isActive: boolean) => {
    setTogglingConfig(table.id)
    try {
      const res = await updateEntityConfigReq(projectId, table.id, {
        is_active: isActive,
      })
      if (res.success) {
        setEntityMappings((prev) =>
          prev.map((c: any) => (c.id === table.id ? { ...c, is_active: isActive } : c))
        )
        notifications.show({
          color: 'green',
          message: isActive ? t('business.entity.enabled') : t('business.entity.disabled'),
        })
      } else {
        notifications.show({ color: 'red', message: res.msg || t('business.entity.updateStatusFailed') })
        await loadEntityMappings()
      }
    } catch (error: any) {
      console.error('更新激活状态失败:', error)
      notifications.show({ color: 'red', message: t('business.entity.updateStatusFailed') + ': ' + error.message })
      await loadEntityMappings()
    } finally {
      setTogglingConfig(null)
    }
  }

  // Generate embeddings
  const generateTableColumnEmbeddings = async (configId: any) => {
    try {
      setGeneratingTableColumn(configId)
      const res = await generateEntityEmbeddingsReq(projectId, configId)
      if (res.success) {
        notifications.show({
          color: 'green',
          message: res.data.message || t('business.entity.generateVectorSuccess'),
        })
        await loadEntityMappings()
      } else {
        notifications.show({ color: 'red', message: res.msg || t('business.entity.generateVectorFailed') })
      }
    } catch (error: any) {
      console.error('生成向量失败:', error)
      notifications.show({ color: 'red', message: t('business.entity.generateVectorFailed') + ': ' + error.message })
    } finally {
      setGeneratingTableColumn(null)
    }
  }

  const generateColumnNameEmbeddings = async (configId: any) => {
    try {
      setGeneratingColumnNameTable(configId)
      const res = await generateEntityEmbeddingsReq(projectId, configId)
      if (res.success) {
        notifications.show({
          color: 'green',
          message: res.data.message || t('business.entity.generateColumnNameVectorSuccess'),
        })
        await loadEntityMappings()
      } else {
        notifications.show({ color: 'red', message: res.msg || t('business.entity.generateVectorFailed') })
      }
    } catch (error: any) {
      console.error('生成向量失败:', error)
      notifications.show({ color: 'red', message: t('business.entity.generateVectorFailed') + ': ' + error.message })
    } finally {
      setGeneratingColumnNameTable(null)
    }
  }

  // ====== Delete 确认弹窗（ElMessageBox.prompt 替代）======
  const [deletePrompt, setDeletePrompt] = useState<DeletePromptState>({
    open: false,
    title: '',
    hint: '',
    expected: '',
    placeholder: '',
    onConfirm: () => {},
  })
  const [deleteInput, setDeleteInput] = useState('')
  const [deleteError, setDeleteError] = useState('')

  const closeDeletePrompt = () => {
    setDeletePrompt((s) => ({ ...s, open: false }))
    setDeleteInput('')
    setDeleteError('')
  }

  const confirmDeletePrompt = () => {
    // 精确文本校验（对应 ElMessageBox 的 inputPattern: ^expected$）
    if (deleteInput !== deletePrompt.expected) {
      setDeleteError(t('business.entity.inputExactConfirmText', { text: deletePrompt.expected }))
      return
    }
    const cb = deletePrompt.onConfirm
    closeDeletePrompt()
    cb()
  }

  const confirmDeleteTableColumnEntities = (config: any) => {
    const { id, table_name: tableName, column_name: columnName } = config
    const expectedConfirmation = `${tableName}.${columnName}`
    setDeleteInput('')
    setDeleteError('')
    setDeletePrompt({
      open: true,
      title: t('business.entity.confirmDeleteColumnValue'),
      hint: t('business.entity.confirmInputHint'),
      expected: expectedConfirmation,
      placeholder: t('business.entity.inputConfirmText'),
      onConfirm: async () => {
        const key = `${tableName}-${columnName}`
        setDeletingTableColumn(key)
        try {
          const response = await deleteEntityConfigReq(projectId, id)
          if (response.success) {
            notifications.show({
              color: 'green',
              message: t('business.entity.deleteColumnValueSuccess', { table: tableName, column: columnName }),
            })
            await loadEntityMappings()
          } else {
            notifications.show({ color: 'red', message: response.msg || t('business.entity.deleteConfigFailed') })
          }
        } finally {
          setDeletingTableColumn(null)
        }
      },
    })
  }

  const confirmDeleteColumnNameTable = (table: any) => {
    const { id, table_name: tableName } = table
    setDeleteInput('')
    setDeleteError('')
    setDeletePrompt({
      open: true,
      title: t('business.entity.confirmDeleteColumnName'),
      hint: t('business.entity.confirmInputHint'),
      expected: tableName,
      placeholder: t('business.entity.inputTableNameConfirm'),
      onConfirm: async () => {
        setDeletingColumnNameTable(tableName)
        try {
          const response = await deleteEntityConfigReq(projectId, id)
          if (response.success) {
            notifications.show({
              color: 'green',
              message: t('business.entity.deleteColumnNameSuccess', { table: tableName }),
            })
            await loadEntityMappings()
          } else {
            notifications.show({ color: 'red', message: response.msg || t('business.entity.deleteFailed') })
          }
        } catch (error: any) {
          console.error('删除字段名词失败:', error)
          notifications.show({
            color: 'red',
            message: t('business.entity.deleteColumnNameError') + ': ' + error.message,
          })
        } finally {
          setDeletingColumnNameTable(null)
        }
      },
    })
  }

  // Search methods
  const handleVectorSearch = async () => {
    if (!searchKeyword.trim()) {
      notifications.show({ color: 'yellow', message: t('business.entity.pleaseInputSearchKeyword') })
      return
    }

    setSearchResults([])
    setAgentResult(null)
    setSearching(true)
    setHasSearched(true)

    try {
      const res = await searchEntitiesReq(projectId, searchKeyword.trim(), 10)
      if (res.success) {
        const items = res.data.items || res.data || []
        setSearchResults(items)
        if (items.length > 0) {
          notifications.show({
            color: 'green',
            message: t('business.entity.foundSimilarEntities', { count: items.length }),
          })
        } else {
          notifications.show({ color: 'blue', message: t('business.entity.noSimilarEntities') })
        }
      } else {
        notifications.show({ color: 'red', message: res.msg || t('business.entity.searchFailed') })
        setSearchResults([])
      }
    } catch (error) {
      console.error('搜索失败:', error)
      notifications.show({ color: 'red', message: t('business.entity.searchFailed') })
      setSearchResults([])
    } finally {
      setSearching(false)
    }
  }

  const handleAgentTest = async () => {
    if (!searchKeyword.trim()) {
      notifications.show({ color: 'yellow', message: t('business.entity.pleaseInputTestQuestion') })
      return
    }

    setSearchResults([])
    setAgentResult(null)
    setHasSearched(false)
    setAgentTesting(true)

    try {
      const res = await testEntityAgentReq(projectId, searchKeyword.trim())
      if (res.success) {
        setAgentResult({
          original_question: searchKeyword.trim(),
          rewritten_question: res.data.user_message || searchKeyword.trim(),
          entities: res.data.entities || [],
        })
        if (res.data.entities && res.data.entities.length > 0) {
          notifications.show({
            color: 'green',
            message: t('business.entity.agentReplacedEntities', { count: res.data.entities.length }),
          })
        } else {
          notifications.show({ color: 'blue', message: t('business.entity.noEntitiesRecognized') })
        }
      } else {
        notifications.show({ color: 'red', message: res.msg || t('business.entity.agentTestFailed') })
      }
    } catch (error: any) {
      console.error('Agent 测试失败:', error)
      notifications.show({
        color: 'red',
        message:
          t('business.entity.agentTestFailed') + ': ' + (error.message || t('business.entity.unknownError')),
      })
    } finally {
      setAgentTesting(false)
    }
  }

  const clearSearchResults = () => {
    setSearchResults([])
    setHasSearched(false)
  }

  const clearAgentResult = () => {
    setAgentResult(null)
  }

  // 分页布局解析（对应 el-pagination 的 layout 字段，决定显示哪些部件）
  const showSizes = paginationLayout.includes('sizes')
  const showJumper = paginationLayout.includes('jumper')
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className={styles.tabContainer}>
      <div className={`${styles.contentCard} ${styles.entityManagerContent}`}>
        {/* 顶部操作区(真·空状态下隐藏,空态自带添加 CTA;加载中或已有名词则显示) */}
        {(loadingMappings || entityMappings.length > 0) && (
        <EntityToolbar
          hasEntities={entityMappings.length > 0}
          hasAutoPromoted={hasAutoPromoted}
          showAutoPromotedOnly={showAutoPromotedOnly}
          onAddColumnValue={openAddEntityDialog}
          onAddColumnName={openColumnNameDialog}
          onSearchTest={openSearchDialog}
          onToggleAutoPromotedFilter={handleToggleAutoPromotedFilter}
          onBatchRevertAutoPromoted={handleBatchRevertAutoPromoted}
        />
        )}

        {/* 已配置的标准名词列表 */}
        <div className={styles.configuredEntitiesSection}>
          {displayedEntityMappings.length > 0 ? (
            // v-loading="loadingMappings" → LoadingOverlay（需相对定位容器）
            <Box pos="relative">
              <LoadingOverlay visible={loadingMappings} zIndex={10} />
              <EntityList
                mergedEntityMappings={displayedEntityMappings}
                togglingConfig={togglingConfig}
                generatingTableColumn={generatingTableColumn}
                generatingColumnNameTable={generatingColumnNameTable}
                deletingTableColumn={deletingTableColumn}
                deletingColumnNameTable={deletingColumnNameTable}
                onEditRule={openEditRuleDialog}
                onToggleConfigActive={toggleConfigActive}
                onToggleColumnNameActive={toggleColumnNameConfigActive}
                onGenerateEmbeddings={generateTableColumnEmbeddings}
                onGenerateColumnNameEmbeddings={generateColumnNameEmbeddings}
                onDeleteColumnValue={confirmDeleteTableColumnEntities}
                onDeleteColumnNameTable={confirmDeleteColumnNameTable}
              />
            </Box>
          ) : !loadingMappings ? (
            <EmptyState onAddColumnValue={openAddEntityDialog} onAddColumnName={openColumnNameDialog} />
          ) : null}
        </div>

        {/* 分页（固定在底部） */}
        {total > 0 && (
          <div className={styles.paginationWrapper}>
            <Group gap="md" wrap="wrap" align="center" justify="center">
              {/* total 文本 */}
              <Text size="sm" c="dimmed">
                {t('common.total', '共')} {total}
              </Text>

              {/* sizes 选择器 */}
              {showSizes && (
                <Select
                  size="xs"
                  w={110}
                  data={[10, 20, 50, 100].map((n) => ({ value: String(n), label: `${n}/page` }))}
                  value={String(pageSize)}
                  onChange={(v) => v && handleSizeChange(Number(v))}
                  allowDeselect={false}
                  comboboxProps={{ withinPortal: true }}
                />
              )}

              {/* prev / pager / next */}
              <Pagination
                size={isMobile ? 'sm' : 'md'}
                total={totalPages}
                value={currentPage}
                onChange={handlePageChange}
                withControls
              />

              {/* jumper */}
              {showJumper && (
                <Group gap={4} align="center">
                  <Text size="sm" c="dimmed">
                    {t('common.goto', '前往')}
                  </Text>
                  <NumberInput
                    size="xs"
                    w={64}
                    min={1}
                    max={totalPages}
                    hideControls
                    value={currentPage}
                    onChange={(v) => {
                      const page = Number(v)
                      if (page >= 1 && page <= totalPages) handlePageChange(page)
                    }}
                  />
                </Group>
              )}
            </Group>
          </div>
        )}
      </div>

      {/* 添加数据名词对话框 */}
      <AddColumnValueDialog
        visible={addEntityDialogVisible}
        onUpdateVisible={setAddEntityDialogVisible}
        availableDataSources={availableDataSources}
        selectedDataSource={selectedDataSource}
        loadingDataSources={loadingDataSources}
        allTables={allTables}
        saving={saving}
        onChangeDataSource={handleDataSourceChange}
        onSelectTable={handleSelectTable}
        onSave={saveColumnValueEntities}
      />

      {/* 字段名词对话框 */}
      <ColumnNameDialog
        visible={columnNameDialogVisible}
        onUpdateVisible={setColumnNameDialogVisible}
        availableDataSources={availableDataSources}
        selectedDataSource={selectedDataSource}
        loadingDataSources={loadingDataSources}
        allTables={allTables}
        saving={savingColumnNameEntities}
        onChangeDataSource={handleDataSourceChange}
        onSelectTable={handleSelectTable}
        onSave={saveColumnNameEntities}
      />

      {/* 搜索测试对话框 */}
      <SearchTestDialog
        visible={searchDialogVisible}
        onUpdateVisible={setSearchDialogVisible}
        keyword={searchKeyword}
        onUpdateKeyword={setSearchKeyword}
        searching={searching}
        agentTesting={agentTesting}
        searchResults={searchResults}
        agentResult={agentResult}
        hasSearched={hasSearched}
        onVectorSearch={handleVectorSearch}
        onAgentTest={handleAgentTest}
        onClearResults={clearSearchResults}
        onClearAgentResult={clearAgentResult}
      />

      {/* 编辑规则弹窗 */}
      <EditRuleDialog
        visible={editRuleDialogVisible}
        onUpdateVisible={setEditRuleDialogVisible}
        config={editingRuleConfig}
        saving={savingRule}
        onSave={saveRule}
      />

      {/* 删除确认弹窗（替代 ElMessageBox.prompt：精确输入文本 + 一键填充） */}
      <Modal
        opened={deletePrompt.open}
        onClose={closeDeletePrompt}
        title={deletePrompt.title}
        centered
        zIndex={3000}
      >
        <Stack gap="sm">
          <Group gap={6} align="center" wrap="wrap">
            <Text size="sm">
              {deletePrompt.hint}
              <strong>{deletePrompt.expected}</strong>
            </Text>
            {/* 一键填充按钮（对应原 HTML 里的 fillBtn） */}
            <Button
              size="compact-xs"
              variant="default"
              onClick={() => {
                setDeleteInput(deletePrompt.expected)
                setDeleteError('')
              }}
            >
              {t('business.entity.fillBtn')}
            </Button>
          </Group>
          <TextInput
            placeholder={deletePrompt.placeholder}
            value={deleteInput}
            error={deleteError || undefined}
            onChange={(e) => {
              setDeleteInput(e.currentTarget.value)
              if (deleteError) setDeleteError('')
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirmDeletePrompt()
            }}
            data-autofocus
          />
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={closeDeletePrompt}>
              {t('business.entity.cancel')}
            </Button>
            <Button color="red" onClick={confirmDeletePrompt}>
              {t('business.entity.confirmDelete')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </div>
  )
}
