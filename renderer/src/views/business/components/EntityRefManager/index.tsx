// 由 EntityRefManager/index.vue 迁移：业务侧实体引用管理
// 复用 EntityManager 的 useDataSource composable 与 EntityList / 四个对话框组件。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  Center,
  Checkbox,
  LoadingOverlay,
  Modal,
  Pagination,
  Select,
  Table,
  Text,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import ElSvgIcon from '@/components/ElSvgIcon'

// API
import {
  createColumnNameEntitiesReq,
  createEntityConfigReq,
  deleteEntityConfigReq,
  generateEntityEmbeddingsReq,
  getEntityConfigsReq,
  searchEntitiesReq,
  testEntityAgentReq,
  updateEntityConfigReq,
} from '@/api/business-semantic'
import {
  addEntityRefsReq,
  getAvailableEntityConfigsReq,
  removeEntityRefReq,
  toggleEntityRefActiveReq,
} from '@/api/business'

// Composable & 组件 —— 复用 EntityManager
import { useDataSource } from '../EntityManager/composables/useDataSource'
import EntityList from '../EntityManager/components/EntityList'
import AddColumnValueDialog from '../EntityManager/components/dialogs/AddColumnValueDialog'
import ColumnNameDialog from '../EntityManager/components/dialogs/ColumnNameDialog'
import SearchTestDialog from '../EntityManager/components/dialogs/SearchTestDialog'
import EditRuleDialog from '../EntityManager/components/dialogs/EditRuleDialog'

import styles from './index.module.scss'

export interface EntityRefManagerProps {
  projectId: string
  businessId: string
}

export default function EntityRefManager({ projectId, businessId }: EntityRefManagerProps) {
  const { t } = useTranslation()

  // Data source composable（源里用 toRef(props, 'xxx')，React 直接传值即可）
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

  // Pagination
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [total, setTotal] = useState(0)
  const [loadingMappings, setLoadingMappings] = useState(false)

  // Dialog visibility
  const [addEntityDialogVisible, setAddEntityDialogVisible] = useState(false)
  const [columnNameDialogVisible, setColumnNameDialogVisible] = useState(false)
  const [searchDialogVisible, setSearchDialogVisible] = useState(false)
  const [editRuleDialogVisible, setEditRuleDialogVisible] = useState(false)
  const [addRefDialogVisible, setAddRefDialogVisible] = useState(false)

  // Add ref state
  const [availableConfigs, setAvailableConfigs] = useState<any[]>([])
  const [loadingAvailable, setLoadingAvailable] = useState(false)
  const [selectedRefIds, setSelectedRefIds] = useState<any[]>([])
  const [addingRefs, setAddingRefs] = useState(false)

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

  // Computed
  const groupedColumnValueMappings = useMemo(() => {
    const grouped: Record<string, any> = {}
    entityMappings
      .filter((config) => config.entity_type === 'column_value')
      .forEach((config) => {
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
      .filter((config) => config.entity_type === 'column_name')
      .map((config) => ({
        id: config.id,
        ref_id: config.ref_id,
        import_type: config.import_type,
        table_name: config.table_name,
        columns: config.columns || [],
        vector_status: config.vector_status,
        vector_error: config.vector_error,
        entity_count: config.entity_count || 0,
        is_active: config.is_active !== false,
        ref_is_active: config.ref_is_active,
      }))
  }, [entityMappings])

  const mergedEntityMappings = useMemo(() => {
    const result: any[] = []
    groupedColumnValueMappings.forEach((table: any) => {
      result.push({ ...table, type: 'column_value', key: `cv-${table.table_name}` })
    })
    groupedColumnNameMappings.forEach((table: any) => {
      result.push({ ...table, type: 'column_name', key: `cn-${table.table_name}` })
    })
    return result
  }, [groupedColumnValueMappings, groupedColumnNameMappings])

  // Methods
  const loadEntityMappings = useCallback(
    async (page = currentPage, size = pageSize) => {
      try {
        setLoadingMappings(true)
        const res = await getEntityConfigsReq(projectId, page, size)
        if (res.success) {
          setEntityMappings(res.data.items || [])
          setTotal(res.data.total || 0)
          setCurrentPage(page)
          setPageSize(size)
        }
      } catch (error) {
        console.error('加载标准名词失败:', error)
      } finally {
        setLoadingMappings(false)
      }
    },
    [projectId, businessId, currentPage, pageSize],
  )

  const handlePageChange = (page: number) => loadEntityMappings(page, pageSize)
  const handleSizeChange = (size: number) => loadEntityMappings(1, size)

  const handleDataSourceChange = async (source: any) => {
    await changeDataSource(source)
  }

  const handleSelectTable = async (table: any) => {
    if (!table.columns || table.columns.length === 0) {
      table.columns = await loadTableColumns(table.id)
    }
  }

  // --- Add entity ref dialog ---
  const openAddRefDialog = async () => {
    setAddRefDialogVisible(true)
    setLoadingAvailable(true)
    setSelectedRefIds([])
    try {
      const res = await getAvailableEntityConfigsReq(projectId)
      if (res.success) {
        setAvailableConfigs(res.data.items || res.data || [])
      }
    } catch (error) {
      console.error('加载可用实体配置失败:', error)
    } finally {
      setLoadingAvailable(false)
    }
  }

  // el-table selection → 手动维护选中 id 集合（不可选行：is_referenced）
  const toggleRefSelection = (row: any, checked: boolean) => {
    setSelectedRefIds((prev) =>
      checked ? [...prev, row.id] : prev.filter((id) => id !== row.id),
    )
  }

  const selectableConfigs = useMemo(
    () => availableConfigs.filter((row) => !row.is_referenced),
    [availableConfigs],
  )

  const allRefSelected = useMemo(
    () => selectableConfigs.length > 0 && selectedRefIds.length === selectableConfigs.length,
    [selectableConfigs, selectedRefIds],
  )

  const someRefSelected = selectedRefIds.length > 0 && !allRefSelected

  const toggleSelectAllRefs = (checked: boolean) => {
    setSelectedRefIds(checked ? selectableConfigs.map((row) => row.id) : [])
  }

  const addRefs = async () => {
    if (selectedRefIds.length === 0) return
    setAddingRefs(true)
    try {
      const res = await addEntityRefsReq(projectId, selectedRefIds)
      if (res.success) {
        notifications.show({ color: 'green', message: res.data.message || '添加成功' })
        setAddRefDialogVisible(false)
        await loadEntityMappings()
      }
    } catch (error: any) {
      console.error('添加引用失败:', error)
      notifications.show({
        color: 'red',
        message: error?.message || t('business.entity.addRefFailed') || '添加引用失败',
      })
    } finally {
      setAddingRefs(false)
    }
  }

  // --- Open dialogs ---
  const openAddEntityDialog = async () => {
    setAddEntityDialogVisible(true)
    await loadAvailableDataSources()
    if (selectedDataSource) await loadTables()
  }

  const openColumnNameDialog = async () => {
    setColumnNameDialogVisible(true)
    await loadAvailableDataSources()
    if (selectedDataSource) await loadTables()
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
          metadata_fields:
            config.metadata_fields?.length > 0 ? config.metadata_fields : null,
          rule: config.rule?.trim() || null,
        })
      }
      notifications.show({
        color: 'green',
        message: t('business.entity.createColumnValueSuccess', { count: configs.length }),
      })
      setAddEntityDialogVisible(false)
      await loadEntityMappings()
    } catch (error: any) {
      console.error('创建数据名词失败:', error)
      notifications.show({
        color: 'red',
        message: error?.message || t('business.entity.createFailed') || '创建失败',
      })
    } finally {
      setSaving(false)
    }
  }

  const saveColumnNameEntities = async (configs: any[]) => {
    if (configs.length === 0) return
    setSavingColumnNameEntities(true)
    try {
      const sourceType = selectedDataSource?.type || 'database'
      const tableGroups: Record<string, any[]> = {}
      for (const config of configs) {
        if (!tableGroups[config.table_id]) tableGroups[config.table_id] = []
        tableGroups[config.table_id].push({
          column_name: config.column_name,
          description:
            config.entity_name !== config.column_name ? config.entity_name : null,
        })
      }
      let totalCount = 0
      for (const [tableId, columns] of Object.entries(tableGroups)) {
        const res = await createColumnNameEntitiesReq(projectId, tableId,
          sourceType,
          columns,
        )
        if (res.success) totalCount += res.data.count || columns.length
      }
      notifications.show({
        color: 'green',
        message: t('business.entity.createColumnNameSuccess', { count: totalCount }),
      })
      setColumnNameDialogVisible(false)
      await loadEntityMappings()
    } catch (error: any) {
      console.error('创建字段名词失败:', error)
      notifications.show({
        color: 'red',
        message: error?.message || t('business.entity.createFailed') || '创建失败',
      })
    } finally {
      setSavingColumnNameEntities(false)
    }
  }

  const saveRule = async (ruleValue: string) => {
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
      }
    } catch (error: any) {
      console.error('更新规则失败:', error)
      notifications.show({
        color: 'red',
        message: error?.message || t('business.entity.ruleUpdateFailed') || '更新失败',
      })
    } finally {
      setSavingRule(false)
    }
  }

  // Toggle active - uses ref_id if available
  const toggleConfigActive = async (config: any, isActive: boolean) => {
    setTogglingConfig(config.id)
    try {
      const refId = config.ref_id
      if (refId) {
        // Toggle via ref (business-level switch)
        const res = await toggleEntityRefActiveReq(projectId, refId, isActive)
        if (res.success) {
          notifications.show({
            color: 'green',
            message: isActive ? t('business.entity.enabled') : t('business.entity.disabled'),
          })
        }
      } else {
        // Fallback: toggle config directly (Excel imports)
        const res = await updateEntityConfigReq(projectId, config.id, {
          is_active: isActive,
        })
        if (res.success) {
          notifications.show({
            color: 'green',
            message: isActive ? t('business.entity.enabled') : t('business.entity.disabled'),
          })
        }
      }
      // 同步本地状态（源里 config.is_active 由列表数据响应式驱动，这里乐观更新）
      setEntityMappings((prev) =>
        prev.map((c) => (c.id === config.id ? { ...c, is_active: isActive } : c)),
      )
    } catch (error) {
      // 回滚
      setEntityMappings((prev) =>
        prev.map((c) => (c.id === config.id ? { ...c, is_active: !isActive } : c)),
      )
      console.error('更新状态失败:', error)
      notifications.show({
        color: 'red',
        message: t('business.entity.updateStatusFailed') || '更新状态失败',
      })
    } finally {
      setTogglingConfig(null)
    }
  }

  const toggleColumnNameConfigActive = async (table: any, isActive: boolean) => {
    setTogglingConfig(table.id)
    try {
      const config = entityMappings.find((c) => c.id === table.id)
      const refId = config?.ref_id
      if (refId) {
        await toggleEntityRefActiveReq(projectId, refId, isActive)
      } else {
        await updateEntityConfigReq(projectId, table.id, { is_active: isActive })
      }
      setEntityMappings((prev) =>
        prev.map((c) => (c.id === table.id ? { ...c, is_active: isActive } : c)),
      )
      notifications.show({
        color: 'green',
        message: isActive ? t('business.entity.enabled') : t('business.entity.disabled'),
      })
    } catch (error) {
      console.error('更新状态失败:', error)
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
      }
    } catch (error) {
      console.error('生成向量失败:', error)
      notifications.show({
        color: 'red',
        message: t('business.entity.generateVectorFailed') || '生成向量失败',
      })
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
      }
    } catch (error) {
      console.error('生成向量失败:', error)
      notifications.show({
        color: 'red',
        message: t('business.entity.generateVectorFailed') || '生成向量失败',
      })
    } finally {
      setGeneratingColumnNameTable(null)
    }
  }

  // Delete / Remove ref
  const confirmDeleteOrRemoveRef = (config: any) => {
    const refId = config.ref_id
    if (refId && config.import_type !== 'excel') {
      // Has ref: offer to remove reference (not delete underlying data)
      modals.openConfirmModal({
        title: t('business.entity.removeRef') || '移除引用',
        children: (
          <Text size="sm">
            {t('business.entity.confirmRemoveRef') ||
              '确定移除此实体引用？底层数据不会被删除。'}
          </Text>
        ),
        labels: {
          confirm: t('common.confirm') || '确定',
          cancel: t('common.cancel') || '取消',
        },
        confirmProps: { color: 'red' },
        onConfirm: async () => {
          setDeletingTableColumn(`${config.table_name}-${config.column_name}`)
          try {
            await removeEntityRefReq(projectId, refId)
            notifications.show({
              color: 'green',
              message: t('business.entity.removeRefSuccess') || '引用已移除',
            })
            await loadEntityMappings()
          } catch (e) {
            console.error(e)
          } finally {
            setDeletingTableColumn(null)
          }
        },
      })
    } else {
      // Excel import or no ref: delete the config
      const { id, table_name: tableName, column_name: columnName } = config
      modals.openConfirmModal({
        title: t('common.warning') || '警告',
        children: (
          <Text size="sm">
            {`${t('business.entity.confirmDeleteColumnValue') || '确定删除'} ${tableName}.${columnName}?`}
          </Text>
        ),
        labels: {
          confirm: t('common.confirm') || '确定',
          cancel: t('common.cancel') || '取消',
        },
        confirmProps: { color: 'red' },
        onConfirm: async () => {
          setDeletingTableColumn(`${tableName}-${columnName}`)
          try {
            await deleteEntityConfigReq(projectId, id)
            notifications.show({
              color: 'green',
              message: t('business.entity.deleteColumnValueSuccess', {
                table: tableName,
                column: columnName,
              }),
            })
            await loadEntityMappings()
          } catch (e) {
            console.error(e)
          } finally {
            setDeletingTableColumn(null)
          }
        },
      })
    }
  }

  const confirmDeleteColumnNameTable = (table: any) => {
    const config = entityMappings.find((c) => c.id === table.id)
    const refId = config?.ref_id

    if (refId && config?.import_type !== 'excel') {
      modals.openConfirmModal({
        title: t('business.entity.removeRef') || '移除引用',
        children: (
          <Text size="sm">
            {t('business.entity.confirmRemoveRef') ||
              '确定移除此实体引用？底层数据不会被删除。'}
          </Text>
        ),
        labels: {
          confirm: t('common.confirm') || '确定',
          cancel: t('common.cancel') || '取消',
        },
        confirmProps: { color: 'red' },
        onConfirm: async () => {
          setDeletingColumnNameTable(table.table_name)
          try {
            await removeEntityRefReq(projectId, refId)
            notifications.show({
              color: 'green',
              message: t('business.entity.removeRefSuccess') || '引用已移除',
            })
            await loadEntityMappings()
          } catch (e) {
            console.error(e)
          } finally {
            setDeletingColumnNameTable(null)
          }
        },
      })
    } else {
      modals.openConfirmModal({
        title: t('common.warning') || '警告',
        children: (
          <Text size="sm">
            {`${t('business.entity.confirmDeleteColumnName') || '确定删除'} ${table.table_name}?`}
          </Text>
        ),
        labels: {
          confirm: t('common.confirm') || '确定',
          cancel: t('common.cancel') || '取消',
        },
        confirmProps: { color: 'red' },
        onConfirm: async () => {
          setDeletingColumnNameTable(table.table_name)
          try {
            await deleteEntityConfigReq(projectId, table.id)
            notifications.show({
              color: 'green',
              message: t('business.entity.deleteColumnNameSuccess', {
                table: table.table_name,
              }),
            })
            await loadEntityMappings()
          } catch (e) {
            console.error(e)
          } finally {
            setDeletingColumnNameTable(null)
          }
        },
      })
    }
  }

  // Search
  const handleVectorSearch = async () => {
    if (!searchKeyword.trim()) return
    setSearchResults([])
    setAgentResult(null)
    setSearching(true)
    setHasSearched(true)
    try {
      const res = await searchEntitiesReq(projectId, searchKeyword.trim(), 10)
      if (res.success) {
        setSearchResults(res.data.items || res.data || [])
      }
    } catch (error) {
      console.error('搜索失败:', error)
      notifications.show({
        color: 'red',
        message: t('business.entity.searchFailed') || '搜索失败',
      })
    } finally {
      setSearching(false)
    }
  }

  const handleAgentTest = async () => {
    if (!searchKeyword.trim()) return
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
      }
    } catch (error) {
      console.error('Agent 测试失败:', error)
      notifications.show({
        color: 'red',
        message: t('business.entity.agentTestFailed') || 'Agent 测试失败',
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

  // ====== 生成中状态轮询 ======
  const pollingTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  // 用 ref 持有最新 mappings 供轮询判断
  const entityMappingsRef = useRef<any[]>(entityMappings)
  entityMappingsRef.current = entityMappings

  const startPollingIfNeeded = useCallback(() => {
    if (pollingTimer.current) return
    if (!entityMappingsRef.current.some((c) => c.vector_status === '生成中')) return
    pollingTimer.current = setInterval(async () => {
      await loadEntityMappings()
      if (!entityMappingsRef.current.some((c) => c.vector_status === '生成中')) {
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

  // onMounted: 首次加载 + 启动轮询；onUnmounted: 停止轮询
  useEffect(() => {
    ;(async () => {
      await loadEntityMappings()
      startPollingIfNeeded()
    })()
    return () => {
      stopPolling()
    }
    // 仅 mount 时执行一次（对齐 Vue onMounted）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // mappings 变化时按需补启动轮询（生成新向量后会出现"生成中"）
  useEffect(() => {
    startPollingIfNeeded()
  }, [entityMappings, startPollingIfNeeded])

  return (
    <div className={styles.tabContainer}>
      <div className={`${styles.contentCard} ${styles.entityManagerContent}`}>
        {/* 顶部操作区 */}
        <div className={styles.toolbar}>
          <div className={styles.toolbarLeft}>
            <Button
              onClick={openAddRefDialog}
              leftSection={<ElSvgIcon name="Plus" size={14} />}
            >
              {t('business.entity.addFromDatasource') || '从数据源添加'}
            </Button>
            <Button
              variant="default"
              onClick={openAddEntityDialog}
              leftSection={<ElSvgIcon name="Plus" size={14} />}
            >
              {t('business.entity.addColumnValue') || '添加数据名词'}
            </Button>
            <Button
              variant="default"
              onClick={openColumnNameDialog}
              leftSection={<ElSvgIcon name="Plus" size={14} />}
            >
              {t('business.entity.addColumnName') || '添加字段名词'}
            </Button>
          </div>
          <div className={styles.toolbarRight}>
            <Button
              variant="default"
              onClick={openSearchDialog}
              leftSection={<ElSvgIcon name="Search" size={14} />}
            >
              {t('business.entity.searchTest') || '搜索测试'}
            </Button>
          </div>
        </div>

        {/* 已引用的实体配置列表 */}
        <div className={styles.configuredEntitiesSection} style={{ position: 'relative' }}>
          {mergedEntityMappings.length > 0 ? (
            <>
              <LoadingOverlay visible={loadingMappings} />
              <EntityList
                mergedEntityMappings={mergedEntityMappings}
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
                onDeleteColumnValue={confirmDeleteOrRemoveRef}
                onDeleteColumnNameTable={confirmDeleteColumnNameTable}
              />
            </>
          ) : (
            !loadingMappings && (
              <div className={styles.emptyState}>
                <Center style={{ flexDirection: 'column', gap: 12 }}>
                  <Text c="dimmed" size="sm">
                    {t('business.entity.noEntities') || '暂无实体配置'}
                  </Text>
                  <Button onClick={openAddRefDialog}>
                    {t('business.entity.addFromDatasource') || '从数据源添加'}
                  </Button>
                </Center>
              </div>
            )
          )}
        </div>

        {/* 分页 */}
        {total > 0 && (
          <div className={styles.paginationWrapper}>
            <span className={styles.paginationInfo}>
              {t('common.total', { total }) || `共 ${total} 条`}
            </span>
            <Select
              value={String(pageSize)}
              onChange={(val) => val && handleSizeChange(Number(val))}
              data={[10, 20, 50, 100].map((n) => ({
                value: String(n),
                label: `${n}/页`,
              }))}
              w={100}
              comboboxProps={{ withinPortal: true }}
            />
            <Pagination
              value={currentPage}
              total={Math.max(1, Math.ceil(total / pageSize))}
              onChange={handlePageChange}
            />
          </div>
        )}
      </div>

      {/* 从数据源添加引用对话框 */}
      <Modal
        opened={addRefDialogVisible}
        onClose={() => setAddRefDialogVisible(false)}
        title={t('business.entity.addFromDatasource') || '从数据源添加实体引用'}
        size={700}
      >
        <div className={styles.addRefContent}>
          <LoadingOverlay visible={loadingAvailable} />
          {availableConfigs.length > 0 ? (
            <Table.ScrollContainer minWidth={640} mah={400} type="native">
              <Table>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th style={{ width: 50 }}>
                      <Checkbox
                        checked={allRefSelected}
                        indeterminate={someRefSelected}
                        onChange={(e) => toggleSelectAllRefs(e.currentTarget.checked)}
                        disabled={selectableConfigs.length === 0}
                      />
                    </Table.Th>
                    <Table.Th style={{ width: 180 }}>
                      {t('business.entity.tableName') || '表名'}
                    </Table.Th>
                    <Table.Th style={{ width: 150 }}>
                      {t('business.entity.columnName') || '列名'}
                    </Table.Th>
                    <Table.Th style={{ width: 100 }}>
                      {t('business.entity.entityType') || '类型'}
                    </Table.Th>
                    <Table.Th style={{ width: 80 }}>
                      {t('business.entity.entityCount') || '实体数'}
                    </Table.Th>
                    <Table.Th style={{ width: 100 }}>
                      {t('business.entity.vectorStatus') || '向量'}
                    </Table.Th>
                    <Table.Th style={{ width: 80 }}>
                      {t('business.entity.status') || '状态'}
                    </Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {availableConfigs.map((row) => (
                    <Table.Tr key={row.id}>
                      <Table.Td>
                        <Checkbox
                          checked={selectedRefIds.includes(row.id)}
                          disabled={row.is_referenced}
                          onChange={(e) => toggleRefSelection(row, e.currentTarget.checked)}
                        />
                      </Table.Td>
                      <Table.Td>{row.table_name}</Table.Td>
                      <Table.Td>{row.column_name}</Table.Td>
                      <Table.Td>
                        <Badge
                          size="sm"
                          color={row.entity_type === 'column_name' ? 'orange' : 'blue'}
                        >
                          {row.entity_type === 'column_name' ? '字段名词' : '数据名词'}
                        </Badge>
                      </Table.Td>
                      <Table.Td>{row.entity_count}</Table.Td>
                      <Table.Td>{row.vector_status}</Table.Td>
                      <Table.Td>
                        {row.is_referenced ? (
                          <Badge color="green" size="sm">
                            {t('business.entity.referenced') || '已引用'}
                          </Badge>
                        ) : (
                          <Badge color="gray" size="sm">
                            {t('business.entity.unreferenced') || '未引用'}
                          </Badge>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          ) : (
            !loadingAvailable && (
              <Center style={{ flexDirection: 'column', padding: '24px 0' }}>
                <Text c="dimmed" size="sm">
                  {t('business.entity.noAvailableConfigs') || '关联数据源中暂无实体配置'}
                </Text>
              </Center>
            )
          )}
        </div>
        <div className={styles.dialogFooter}>
          <Button variant="default" onClick={() => setAddRefDialogVisible(false)}>
            {t('common.cancel') || '取消'}
          </Button>
          <Button
            loading={addingRefs}
            disabled={selectedRefIds.length === 0}
            onClick={addRefs}
          >
            {t('business.entity.addSelected') || '添加选中'} ({selectedRefIds.length})
          </Button>
        </div>
      </Modal>

      {/* 复用原有的对话框组件 */}
      <AddColumnValueDialog
        visible={addEntityDialogVisible}
        availableDataSources={availableDataSources}
        selectedDataSource={selectedDataSource}
        loadingDataSources={loadingDataSources}
        allTables={allTables}
        saving={saving}
        onUpdateVisible={setAddEntityDialogVisible}
        onChangeDataSource={handleDataSourceChange}
        onSelectTable={handleSelectTable}
        onSave={saveColumnValueEntities}
      />

      <ColumnNameDialog
        visible={columnNameDialogVisible}
        availableDataSources={availableDataSources}
        selectedDataSource={selectedDataSource}
        loadingDataSources={loadingDataSources}
        allTables={allTables}
        saving={savingColumnNameEntities}
        onUpdateVisible={setColumnNameDialogVisible}
        onChangeDataSource={handleDataSourceChange}
        onSelectTable={handleSelectTable}
        onSave={saveColumnNameEntities}
      />

      <SearchTestDialog
        visible={searchDialogVisible}
        keyword={searchKeyword}
        searching={searching}
        agentTesting={agentTesting}
        searchResults={searchResults}
        agentResult={agentResult}
        hasSearched={hasSearched}
        onUpdateVisible={setSearchDialogVisible}
        onUpdateKeyword={setSearchKeyword}
        onVectorSearch={handleVectorSearch}
        onAgentTest={handleAgentTest}
        onClearResults={clearSearchResults}
        onClearAgentResult={clearAgentResult}
      />

      <EditRuleDialog
        visible={editRuleDialogVisible}
        config={editingRuleConfig}
        saving={savingRule}
        onUpdateVisible={setEditRuleDialogVisible}
        onSave={saveRule}
      />
    </div>
  )
}
