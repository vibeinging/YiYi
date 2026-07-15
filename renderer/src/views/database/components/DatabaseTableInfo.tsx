// 从 Vue 迁移：views/database/components/DatabaseTableInfo.vue
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { Modal, Button, MultiSelect } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import ElSvgIcon from '@/components/ElSvgIcon'
import {
  syncDatabaseSchemaReq,
  syncDatabaseTablesReq,
  getTableColumnsReq,
  getCachedTablesReq,
  getSourceTablesReq,
} from '@/api/database'
import { useProjectStore } from '@/store/project'
import TableBatchActions from './TableBatchActions'
import TableStructureView from './TableStructureView'
import TableEditDialog from './TableEditDialog'
import TableRetrievalTestDialog from './TableRetrievalTestDialog'
import { formatTableDisplayName } from '@/utils/tableDisplay'
import styles from './DatabaseTableInfo.module.scss'

export interface DatabaseTableInfoProps {
  databaseId: string
  isFromGuide?: boolean
  // defineEmits(['open-sync-guide'])
  onOpenSyncGuide?: () => void
}

export interface DatabaseTableInfoHandle {
  handleRefreshStructure: (skipConfirm?: boolean) => Promise<void>
  handleRefreshTableListOnly: () => Promise<void>
}

const TABLES_FETCH_LIMIT = 1000

// 读取当前项目 ID（对齐 Pinia store 的即时读取，避免闭包过期）
const getCurrentProjectId = () => useProjectStore.getState().currentProject?.id || null

const DatabaseTableInfo = forwardRef<DatabaseTableInfoHandle, DatabaseTableInfoProps>(
  function DatabaseTableInfo(props, ref) {
    const { databaseId, isFromGuide = false, onOpenSyncGuide } = props
    const { t } = useTranslation()

    // 内部状态
    const [tables, setTables] = useState<any[]>([])
    const [tablesTotal, setTablesTotal] = useState(0)
    // currentTableName 仅内部维护，对齐源逻辑
    const currentTableNameRef = useRef('')
    const [currentTable, setCurrentTable] = useState<any>(null)
    const [hasTableStructure, setHasTableStructure] = useState(false)
    const [fetchingStructure, setFetchingStructure] = useState(false)
    const [autoFetchingStructure] = useState(false)

    // 对话框状态
    const [singleTableEditDialogVisible, setSingleTableEditDialogVisible] = useState(false)
    const [testRetrievalDialogVisible, setTestRetrievalDialogVisible] = useState(false)
    const [singleEditingTable, setSingleEditingTable] = useState<any>(null)

    // 同步选项对话框状态
    const [syncDialogVisible, setSyncDialogVisible] = useState(false)
    const [syncMode, setSyncMode] = useState<'all' | 'schema' | 'table'>('all')
    const [selectedSchemas, setSelectedSchemas] = useState<string[]>([])
    const [selectedTables, setSelectedTables] = useState<any[]>([])
    // 原始数据库表列表（用于按表同步）
    const [sourceTables, setSourceTables] = useState<any[]>([])
    const [loadingSourceTables, setLoadingSourceTables] = useState(false)

    // 用 ref 持有最新值，供异步/imperative 方法读取，避免闭包过期
    const tablesRef = useRef<any[]>([])
    const currentTableRef = useRef<any>(null)
    const sourceTablesRef = useRef<any[]>([])
    const loadingSourceTablesRef = useRef(false)
    const hasTableStructureRef = useRef(false)
    tablesRef.current = tables
    currentTableRef.current = currentTable
    sourceTablesRef.current = sourceTables
    loadingSourceTablesRef.current = loadingSourceTables
    hasTableStructureRef.current = hasTableStructure

    // 可用的 Schema 列表
    const availableSchemas = useMemo(() => {
      const schemas = new Set<string>()
      tables.forEach((table) => {
        if (table.schema_name) {
          schemas.add(table.schema_name)
        }
      })
      return Array.from(schemas).sort()
    }, [tables])

    // 同步模式选项
    const syncModeOptions = useMemo(
      () => [
        {
          value: 'all',
          label: t('database.sync.syncAllLabel'),
          desc: t('database.sync.syncAllDesc'),
          icon: 'Files',
          color: '#409eff',
        },
        {
          value: 'schema',
          label: t('database.sync.syncSchemaLabel'),
          desc: t('database.sync.syncSchemaDesc'),
          icon: 'FolderOpened',
          color: '#67c23a',
        },
        {
          value: 'table',
          label: t('database.sync.syncTableLabel'),
          desc: t('database.sync.syncTableDesc'),
          icon: 'Coin',
          color: '#e6a23c',
        },
      ],
      [t]
    )

    // 全选 Schema
    const selectAllSchemas = () => {
      if (selectedSchemas.length === availableSchemas.length) {
        setSelectedSchemas([])
      } else {
        setSelectedSchemas([...availableSchemas])
      }
    }

    // 切换 Schema 选中状态
    const toggleSchemaSelection = (schema: string) => {
      setSelectedSchemas((prev) => {
        const index = prev.indexOf(schema)
        if (index > -1) {
          const next = [...prev]
          next.splice(index, 1)
          return next
        }
        return [...prev, schema]
      })
    }

    // 加载原始数据库表列表
    const loadSourceTables = async () => {
      if (!databaseId || loadingSourceTablesRef.current) return

      try {
        setLoadingSourceTables(true)
        loadingSourceTablesRef.current = true
        const res: any = await getSourceTablesReq(getCurrentProjectId(), databaseId)
        if (res?.success) {
          setSourceTables(res.data?.items || [])
        } else {
          setSourceTables([])
        }
      } catch (error) {
        console.error('加载原始数据库表列表失败:', error)
        setSourceTables([])
      } finally {
        setLoadingSourceTables(false)
        loadingSourceTablesRef.current = false
      }
    }

    // 全选表
    const selectAllTables = () => {
      if (syncMode === 'table') {
        // 按表同步模式：使用原始数据库表列表
        const currentTables = sourceTablesRef.current
        if (selectedTables.length === currentTables.length) {
          setSelectedTables([])
        } else {
          setSelectedTables(
            currentTables.map((tb: any) => ({
              schema_name: tb.schema_name || 'default',
              table_name: tb.table_name,
            }))
          )
        }
      } else {
        // 其他模式：使用缓存的表列表
        if (selectedTables.length === tablesRef.current.length) {
          setSelectedTables([])
        } else {
          setSelectedTables(tablesRef.current.map((tb: any) => tb.id))
        }
      }
    }

    // 加载表列信息
    const loadTableColumns = useCallback(
      async (tableId: any) => {
        try {
          const res: any = await getTableColumnsReq(getCurrentProjectId(), databaseId, tableId)
          if (res.success) {
            const table = tablesRef.current.find((tb: any) => tb.id === tableId)
            if (table) {
              table.columns = res.data.items || []

              // 确保列描述字段存在
              if (table.columns) {
                table.columns.forEach((col: any) => {
                  if (!Object.prototype.hasOwnProperty.call(col, 'description')) {
                    col.description = ''
                  }
                })
              }

              // 触发列表更新（列信息已挂在 table 对象上）
              setTables((prev) => [...prev])

              // 如果当前选中的是这个表，更新 currentTable
              if (currentTableRef.current && currentTableRef.current.id === tableId) {
                setCurrentTable(table)
              }
            }
          }
        } catch (error) {
          console.error('获取表列信息失败:', error)
        }
      },
      [databaseId]
    )

    // 获取表结构（自动拉全：避免后端默认 limit=100 导致漏表/数量误判）
    const getTableStructure = useCallback(
      async (dbId: any, preserveTableId: any = null) => {
        try {
          setFetchingStructure(true)
          const allTables: any[] = []
          let offset = 0
          let total: number | null = null

          // eslint-disable-next-line no-constant-condition
          while (true) {
            const res: any = await getCachedTablesReq(getCurrentProjectId(), dbId, {
              limit: TABLES_FETCH_LIMIT,
              offset,
            })

            if (!res || !res.success) {
              throw new Error(res?.msg || '获取表结构失败')
            }

            const items = res.data?.items || []
            total = typeof res.data?.total === 'number' ? res.data.total : total
            allTables.push(...items)

            offset += items.length

            // 没有更多数据，或已取满 total
            if (items.length === 0 || (typeof total === 'number' && offset >= total)) {
              break
            }

            // 兜底：防止异常情况下死循环
            if (items.length < TABLES_FETCH_LIMIT) {
              break
            }
          }

          tablesRef.current = allTables
          setTables(allTables)
          setTablesTotal(typeof total === 'number' ? total : allTables.length)
          if (allTables.length > 0) {
            setHasTableStructure(allTables.length > 0)
            hasTableStructureRef.current = allTables.length > 0
            if (allTables.length > 0) {
              // 尝试恢复之前选中的表
              let selectedTable: any = null
              if (preserveTableId) {
                selectedTable = allTables.find((tb: any) => tb.id === preserveTableId)
              }

              // 如果没有找到之前选中的表，或者没有指定 preserveTableId，则选择第一个表
              if (!selectedTable) {
                selectedTable = allTables[0]
              }

              currentTableNameRef.current = selectedTable.table_name
              currentTableRef.current = selectedTable
              setCurrentTable(selectedTable)
              await loadTableColumns(selectedTable.id)
            } else {
              // 空数据时清空当前选中的表
              currentTableNameRef.current = ''
              currentTableRef.current = null
              setCurrentTable(null)
            }
          } else {
            // 空数据时清空当前选中的表
            currentTableNameRef.current = ''
            currentTableRef.current = null
            setCurrentTable(null)
            setHasTableStructure(false)
            hasTableStructureRef.current = false
            setTablesTotal(0)
          }
        } catch (error: any) {
          console.error('获取表结构失败:', error)
          // 发生错误时，清空表列表
          tablesRef.current = []
          setTables([])
          setTablesTotal(0)
          setHasTableStructure(false)
          hasTableStructureRef.current = false
          currentTableNameRef.current = ''
          currentTableRef.current = null
          setCurrentTable(null)
          // 只有非 404 错误才显示错误提示（404 可能是资源不存在，空数据是正常情况）
          if (error.response?.status !== 404) {
            notifications.show({ color: 'red', message: t('database.message.fetchStructureFailed') })
          }
        } finally {
          setFetchingStructure(false)
        }
      },
      [loadTableColumns, t]
    )

    // 监听数据库 ID 变化（watch immediate）
    useEffect(() => {
      let cancelled = false
      const run = async () => {
        if (databaseId) {
          await getTableStructure(databaseId)
        } else {
          // 清空状态
          if (cancelled) return
          tablesRef.current = []
          setTables([])
          currentTableNameRef.current = ''
          currentTableRef.current = null
          setCurrentTable(null)
          setHasTableStructure(false)
          hasTableStructureRef.current = false
        }
      }
      run()
      return () => {
        cancelled = true
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [databaseId])

    // 执行同步
    const performSync = async (mode: string, schemas: any[] = [], tablesArg: any[] = []) => {
      if (!databaseId) return

      setFetchingStructure(true)
      setSyncDialogVisible(false)

      try {
        let res: any
        const projectId = getCurrentProjectId()
        if (mode === 'all') {
          notifications.show({ color: 'blue', message: t('database.sync.syncingAll') })
          res = await syncDatabaseSchemaReq(projectId, databaseId)
        } else if (mode === 'schema') {
          notifications.show({
            color: 'blue',
            message: t('database.sync.syncingSchemas', { count: schemas.length }),
          })
          res = await syncDatabaseSchemaReq(projectId, databaseId, { schemas })
        } else if (mode === 'table') {
          notifications.show({
            color: 'blue',
            message: t('database.sync.syncingTables', { count: tablesArg.length }),
          })
          // 按表同步模式：传递表名列表
          // tablesArg 已经是 {schema_name, table_name} 格式的对象数组
          const tableNames = tablesArg.map((tb: any) => ({
            schema_name: tb.schema_name || 'default',
            table_name: tb.table_name,
          }))
          res = await syncDatabaseTablesReq(projectId, databaseId, { tableNames })
        }

        if (res?.success) {
          const data = res.data || {}
          if (mode === 'table') {
            notifications.show({
              color: 'green',
              message: t('database.sync.successTable', { updated: data.updated_tables || 0 }),
            })
          } else if (mode === 'schema') {
            notifications.show({
              color: 'green',
              message: t('database.sync.successSchema', {
                added: data.added_tables || 0,
                updated: data.updated_tables || 0,
              }),
            })
          } else {
            notifications.show({
              color: 'green',
              message: t('database.sync.successAll', {
                added: data.added_tables || 0,
                updated: data.updated_tables || 0,
                deleted: data.deleted_tables || 0,
              }),
            })
          }
          const currentTableId = currentTableRef.current?.id
          await getTableStructure(databaseId, currentTableId)
        } else {
          notifications.show({ color: 'red', message: res?.msg || t('database.sync.failed') })
        }
      } catch (error: any) {
        if (error !== 'cancel') {
          console.error('同步数据库结构失败:', error)
          notifications.show({ color: 'red', message: t('database.sync.failed') })
        }
      } finally {
        setFetchingStructure(false)
      }
    }

    // 刷新表结构（供批量操作等调用）- 会触发整库同步，仅用于用户主动点击同步时
    const handleRefreshStructure = async (_skipConfirm = false) => {
      if (!databaseId) return
      await performSync('all')
    }

    // 仅刷新已同步的表列表（不请求远程库、不触发 sync-schema），用于完成配置/关闭向导后更新展示
    const handleRefreshTableListOnly = async () => {
      if (!databaseId) return
      const currentTableId = currentTableRef.current?.id
      await getTableStructure(databaseId, currentTableId)
    }

    // 打开配置向导
    const handleOpenGuide = () => {
      // 触发事件，通知父组件打开配置向导
      onOpenSyncGuide?.()
    }

    // 确认同步
    const handleSyncConfirm = async () => {
      if (!databaseId) return

      // 验证选择
      if (syncMode === 'schema' && selectedSchemas.length === 0) {
        notifications.show({ color: 'yellow', message: t('database.sync.pleaseSelectSchemas') })
        return
      }
      if (syncMode === 'table' && selectedTables.length === 0) {
        notifications.show({ color: 'yellow', message: t('database.sync.pleaseSelectTables') })
        return
      }

      const doSync = () =>
        performSync(
          syncMode,
          syncMode === 'schema' ? selectedSchemas : [],
          syncMode === 'table' ? selectedTables : []
        )

      // 全量同步需要确认
      if (syncMode === 'all') {
        const html = `<div style="line-height: 1.8;">
          <p style="margin-bottom: 12px; font-weight: 500;">${t('database.sync.fullSyncTitle')}</p>
          <p style="margin-bottom: 8px; color: #67C23A; font-weight: 500;">${t('database.sync.willKeep')}</p>
          <ul style="margin: 0; padding-left: 20px; color: #606266; margin-bottom: 12px;">
            <li>${t('database.sync.keepDescriptions')}</li>
            <li>${t('database.sync.keepMetadata')}</li>
          </ul>
          <p style="margin-bottom: 8px; color: #E6A23C; font-weight: 500;">${t('database.sync.notice')}</p>
          <ul style="margin: 0; padding-left: 20px; color: #606266;">
            <li>${t('database.sync.deleteNonExist')}</li>
            <li>${t('database.sync.addNewTables')}</li>
          </ul>
        </div>`
        modals.openConfirmModal({
          title: t('database.sync.title'),
          children: <div dangerouslySetInnerHTML={{ __html: html }} />,
          labels: {
            confirm: t('database.sync.startSync'),
            cancel: t('database.action.cancel'),
          },
          confirmProps: { color: 'orange' },
          onConfirm: () => {
            doSync()
          },
        })
        return
      }

      await doSync()
    }

    // 处理表切换
    const handleTableChange = async (selectedTable: any) => {
      // 懒加载：如果表没有列信息，则加载列信息
      if (!selectedTable.columns || selectedTable.columns.length === 0) {
        await loadTableColumns(selectedTable.id)
      }

      // 更新当前选中的表
      currentTableRef.current = selectedTable
      setCurrentTable(selectedTable)
      currentTableNameRef.current = selectedTable.table_name
    }

    // 处理打开编辑对话框
    const handleOpenEditDialog = (table: any) => {
      setSingleEditingTable(table)
      setSingleTableEditDialogVisible(true)
    }

    // 处理编辑保存后
    const handleAfterSaveEdit = async () => {
      // 保存当前选中的表 ID
      const currentTableId = currentTableRef.current?.id
      // 刷新表结构以获取最新数据，并保持当前选中的表
      await getTableStructure(databaseId, currentTableId)
    }

    // 处理批量操作后的刷新
    const handleRefreshAfterBatchOperation = async () => {
      // 保存当前选中的表 ID
      const currentTableId = currentTableRef.current?.id
      await getTableStructure(databaseId, currentTableId)
    }

    // 处理单个操作后的刷新
    const handleRefreshAfterSingleOperation = async () => {
      // 保存当前选中的表 ID
      const currentTableId = currentTableRef.current?.id
      await getTableStructure(databaseId, currentTableId)
    }

    // 打开测试召回对话框
    const handleOpenRetrievalTest = () => {
      setTestRetrievalDialogVisible(true)
    }

    // 暴露方法给父组件（defineExpose）
    useImperativeHandle(ref, () => ({
      handleRefreshStructure,
      handleRefreshTableListOnly,
    }))

    // 同步模式（用于按表同步时切换数据源）
    const optionSourceTables = syncMode === 'table' ? sourceTables : tables
    // el-select 多选数据（label/value）
    const tableSelectData = optionSourceTables.map((table: any) => {
      const label = formatTableDisplayName(table)
      const value =
        syncMode === 'table'
          ? JSON.stringify({ schema_name: table.schema_name || 'default', table_name: table.table_name })
          : String(table.id)
      return { value, label }
    })

    // 多选 Select 的 value（Mantine 需要 string[]）
    const tableSelectValue = selectedTables.map((v: any) =>
      syncMode === 'table' ? JSON.stringify(v) : String(v)
    )

    const handleTableSelectChange = (vals: string[]) => {
      if (syncMode === 'table') {
        setSelectedTables(vals.map((v) => JSON.parse(v)))
      } else {
        // 缓存表模式：value 为 table.id（保持原始类型）
        setSelectedTables(
          vals.map((v) => {
            const matched = tables.find((tb: any) => String(tb.id) === v)
            return matched ? matched.id : v
          })
        )
      }
    }

    return (
      <div className="tab-container">
        {/* 统一的内容卡片 */}
        <div className={`content-card ${styles.contentCard}`}>
          {/* 自动获取表结构时的 loading 状态 */}
          {autoFetchingStructure ? (
            <div className={styles.loadingPlaceholder}>
              <div className={styles.loadingContent}>
                <ElSvgIcon name="Loading" size={48} />
                <div className={styles.loadingText}>{t('database.tableInfo.autoFetching')}</div>
                <div className={styles.loadingSubtext}>{t('database.tableInfo.mayTakeMoment')}</div>
              </div>
            </div>
          ) : hasTableStructure ? (
            <>
              {/* 顶部操作区 */}
              <div className={styles.operationsHeader}>
                <div className={styles.headerActions}>
                  {/* 批量操作按钮组 */}
                  <TableBatchActions
                    databaseId={databaseId}
                    tables={tables}
                    isFromGuide={isFromGuide}
                    onRefresh={handleRefreshAfterBatchOperation}
                    onOpenRetrievalTest={handleOpenRetrievalTest}
                    onLoadColumns={loadTableColumns}
                  />
                </div>
              </div>

              {/* 表结构展示 */}
              <TableStructureView
                databaseId={databaseId}
                tables={tables}
                totalTables={tablesTotal}
                currentTable={currentTable}
                isFromGuide={isFromGuide}
                onTableChange={handleTableChange}
                onRefresh={handleRefreshAfterSingleOperation}
                onOpenEditDialog={handleOpenEditDialog}
                onLoadColumns={loadTableColumns}
                onOpenRetrievalTest={handleOpenRetrievalTest}
              />
            </>
          ) : (
            /* 没有表结构信息时的提示和引导 */
            <div className={styles.emptyPlaceholder}>
              <div className={styles.emptyGuideContainer}>
                <div className={styles.emptyGuideIcon}>
                  <ElSvgIcon name="Grid" size={80} color="#c0c4cc" />
                </div>
                <div className={styles.emptyGuideContent}>
                  <div className={styles.guideText}>
                    <p className={styles.guideTitle}>{t('database.tableInfo.noStructure')}</p>
                    <p className={styles.guideSubtitle}>{t('database.tableInfo.useWizard')}</p>
                    <p className={styles.guideDesc}>{t('database.tableInfo.wizardHelps')}</p>
                    <ul className={styles.guideFeatures}>
                      <li>{t('database.tableInfo.wizardSync')}</li>
                      <li>{t('database.tableInfo.wizardDescriptions')}</li>
                      <li>{t('database.tableInfo.wizardVectors')}</li>
                    </ul>
                  </div>
                  <Button
                    size="lg"
                    onClick={handleOpenGuide}
                    className={styles.guideButton}
                    leftSection={<ElSvgIcon name="SetUp" size={16} />}
                  >
                    {t('database.tableInfo.openWizard')}
                  </Button>
                  <div className={styles.guideHint}>
                    <ElSvgIcon name="InfoFilled" size={16} />
                    <span>{t('database.tableInfo.wizardHint')}</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 单表编辑对话框 */}
        <TableEditDialog
          opened={singleTableEditDialogVisible}
          onClose={() => setSingleTableEditDialogVisible(false)}
          table={singleEditingTable}
          databaseId={databaseId}
          onSaved={handleAfterSaveEdit}
        />

        {/* 测试召回对话框 */}
        <TableRetrievalTestDialog
          opened={testRetrievalDialogVisible}
          onClose={() => setTestRetrievalDialogVisible(false)}
          databaseId={databaseId}
        />

        {/* 同步选项对话框 */}
        <Modal
          opened={syncDialogVisible}
          onClose={() => setSyncDialogVisible(false)}
          title=""
          size={540}
          closeOnClickOutside={false}
          className="sync-dialog"
        >
          <div className={styles.syncDialogContent}>
            {/* 标题 */}
            <div className={styles.syncDialogHeader}>
              <div className={styles.headerIcon}>
                <ElSvgIcon name="Refresh" size={24} />
              </div>
              <div className={styles.headerText}>
                <div className={styles.headerTitle}>{t('database.sync.title')}</div>
                <div className={styles.headerSubtitle}>{t('database.sync.selectMethod')}</div>
              </div>
            </div>

            {/* 同步模式选择 */}
            <div className={styles.syncModeCards}>
              {syncModeOptions.map((mode) => (
                <div
                  key={mode.value}
                  className={`${styles.syncModeCard} ${syncMode === mode.value ? styles.active : ''}`}
                  onClick={() => setSyncMode(mode.value as 'all' | 'schema' | 'table')}
                >
                  <div
                    className={styles.cardIcon}
                    style={{ backgroundColor: mode.color + '20', color: mode.color }}
                  >
                    <ElSvgIcon name={mode.icon} size={20} />
                  </div>
                  <div className={styles.cardContent}>
                    <div className={styles.cardTitle}>{mode.label}</div>
                    <div className={styles.cardDesc}>{mode.desc}</div>
                  </div>
                  {syncMode === mode.value && (
                    <div className={styles.cardCheck}>
                      <ElSvgIcon name="CircleCheck" size={18} />
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* 同步模式说明 */}
            <div className={styles.syncModeDetail}>
              <div className={styles.detailTitle}>
                <ElSvgIcon name="InfoFilled" size={18} />
                <span>{t('database.sync.currentModeDesc')}</span>
              </div>
              <div className={styles.detailContent}>
                {syncMode === 'all' ? (
                  <div className={styles.detailList}>
                    <div className={styles.detailItem}>{t('database.sync.allAddNew')}</div>
                    <div className={styles.detailItem}>{t('database.sync.allUpdateExisting')}</div>
                    <div className={styles.detailItem}>{t('database.sync.allKeepDescriptions')}</div>
                    <div className={styles.detailItem}>{t('database.sync.allDeleteMissing')}</div>
                    <div className={`${styles.detailItem} ${styles.tip}`}>
                      {t('database.sync.allTip')}
                    </div>
                  </div>
                ) : syncMode === 'schema' ? (
                  <div className={styles.detailList}>
                    <div className={styles.detailItem}>{t('database.sync.schemaAddNew')}</div>
                    <div className={styles.detailItem}>{t('database.sync.schemaUpdateExisting')}</div>
                    <div className={styles.detailItem}>{t('database.sync.schemaKeepDescriptions')}</div>
                    <div className={styles.detailItem}>{t('database.sync.schemaDeleteMissing')}</div>
                    <div className={styles.detailItem}>
                      {t('database.sync.schemaOthersUnaffected')}
                    </div>
                    <div className={`${styles.detailItem} ${styles.tip}`}>
                      {t('database.sync.schemaTip')}
                    </div>
                  </div>
                ) : (
                  <div className={styles.detailList}>
                    <div className={styles.detailItem}>{t('database.sync.tableUpdateStructure')}</div>
                    <div className={styles.detailItem}>{t('database.sync.tableAddNewColumns')}</div>
                    <div className={styles.detailItem}>
                      {t('database.sync.tableDeleteMissingColumns')}
                    </div>
                    <div className={styles.detailItem}>{t('database.sync.tableKeepDescriptions')}</div>
                    <div className={styles.detailItem}>{t('database.sync.tableNoDeleteNoAdd')}</div>
                    <div className={`${styles.detailItem} ${styles.tip}`}>
                      {t('database.sync.tableTip')}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Schema 选择 */}
            {syncMode === 'schema' && (
              <div className={styles.syncSelectorSection}>
                <div className={styles.selectorHeader}>
                  <span className={styles.selectorLabel}>
                    {t('database.sync.selectSyncSchemas')}
                  </span>
                  {/* el-link → 文字按钮 */}
                  <a
                    style={{ color: 'var(--el-color-primary, #409eff)', cursor: 'pointer' }}
                    onClick={selectAllSchemas}
                  >
                    {t('database.sync.selectAll')}
                  </a>
                </div>
                <div className={styles.schemaTagsContainer}>
                  {availableSchemas.map((schema) => (
                    <span
                      key={schema}
                      className={`${styles.schemaTagItem} ${
                        selectedSchemas.includes(schema) ? styles.selected : ''
                      }`}
                      onClick={() => toggleSchemaSelection(schema)}
                    >
                      {schema}
                    </span>
                  ))}
                </div>
                {selectedSchemas.length > 0 && (
                  <div className={styles.selectorSummary}>
                    {t('database.sync.selectedSchemas', { count: selectedSchemas.length })}
                  </div>
                )}
              </div>
            )}

            {/* 表选择 */}
            {syncMode === 'table' && (
              <div className={styles.syncSelectorSection}>
                <div className={styles.selectorHeader}>
                  <span className={styles.selectorLabel}>
                    {t('database.sync.selectSyncTables')}
                  </span>
                  <a
                    style={{ color: 'var(--el-color-primary, #409eff)', cursor: 'pointer' }}
                    onClick={selectAllTables}
                  >
                    {t('database.sync.selectAll')}
                  </a>
                </div>
                <MultiSelect
                  searchable
                  className={styles.tableSelect}
                  placeholder={t('database.sync.selectTablePlaceholder')}
                  data={tableSelectData}
                  value={tableSelectValue as any}
                  disabled={loadingSourceTables}
                  onChange={handleTableSelectChange as any}
                  onDropdownOpen={() => {
                    if (sourceTables.length === 0) loadSourceTables()
                  }}
                />
                {selectedTables.length > 0 && (
                  <div className={styles.selectorSummary}>
                    {t('database.sync.selectedTables', { count: selectedTables.length })}
                  </div>
                )}
              </div>
            )}

            {/* 警告提示 */}
            {syncMode === 'all' ? (
              <div className={`${styles.syncWarning} ${styles.warning}`}>
                <span className={styles.warningIcon}>
                  <ElSvgIcon name="Warning" size={18} />
                </span>
                <span>{t('database.sync.warningAllDelete')}</span>
              </div>
            ) : syncMode === 'schema' ? (
              <div className={`${styles.syncWarning} ${styles.info}`}>
                <span className={styles.warningIcon}>
                  <ElSvgIcon name="InfoFilled" size={18} />
                </span>
                <span>{t('database.sync.warningSchema')}</span>
              </div>
            ) : (
              <div className={`${styles.syncWarning} ${styles.success}`}>
                <span className={styles.warningIcon}>
                  <ElSvgIcon name="CircleCheck" size={18} />
                </span>
                <span>{t('database.sync.warningTable')}</span>
              </div>
            )}
          </div>

          {/* footer */}
          <div className={styles.syncDialogFooter}>
            <Button variant="default" size="lg" onClick={() => setSyncDialogVisible(false)}>
              {t('database.action.cancel')}
            </Button>
            <Button size="lg" onClick={handleSyncConfirm} loading={fetchingStructure}>
              {t('database.sync.startSync')}
            </Button>
          </div>
        </Modal>
      </div>
    )
  }
)

export default DatabaseTableInfo
