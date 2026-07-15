import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { notifications } from '@mantine/notifications'
import { getDataSourceTablesReq } from '@/api/structured_data_source/document'
import { getTableColumnsReq } from '@/api/database'
import { useProjectStore, projectGetters } from '@/store/project'
import ElSvgIcon from '@/components/ElSvgIcon'
import UnifiedTableBatchActions from './UnifiedTableBatchActions'
import TableStructureView from '@/views/database/components/TableStructureView'
import TableEditDialog from './TableEditDialog'
import StructuredTableRetrievalTestDialog from './StructuredTableRetrievalTestDialog'
import styles from './TableManagement.module.scss'

export interface TableManagementProps {
  dataSourceId: string
  /** defineEmits('table-selected') */
  onTableSelected?: (table: any) => void
  /** defineEmits('table-unselected') */
  onTableUnselected?: () => void
}

export default function TableManagement({ dataSourceId, onTableSelected, onTableUnselected }: TableManagementProps) {
  const { t } = useTranslation()
  const projectId = useProjectStore((s) => projectGetters.currentProjectId(s))

  // 状态管理
  const [loading, setLoading] = useState(false)
  const [tables, setTables] = useState<any[]>([])
  const [currentTable, setCurrentTable] = useState<any>(null)
  const hasTables = tables.length > 0

  // 表编辑弹窗状态
  const [showEditDialog, setShowEditDialog] = useState(false)
  const [editingTableData, setEditingTableData] = useState<any>(null)

  // 测试召回对话框状态
  const [showRetrievalDialog, setShowRetrievalDialog] = useState(false)

  // 用 ref 镜像最新的 tables / currentTable，便于在异步回调里读取到最新值(对齐 Vue ref.value 语义)
  const tablesRef = useRef<any[]>([])
  const currentTableRef = useRef<any>(null)
  tablesRef.current = tables
  currentTableRef.current = currentTable

  // 获取表的 database_connection_id（用于调用 database 接口）
  // 如果所有表都有相同的 database_connection_id，返回第一个；否则返回 null
  const getDatabaseConnectionId = () => {
    const list = tablesRef.current
    if (list.length === 0) return null

    // 获取第一个表的 database_connection_id
    const firstConnectionId = list[0]?.database_connection_id
    if (!firstConnectionId) return null

    // 检查是否所有表都有相同的 connection_id
    const allSame = list.every((table) => table.database_connection_id === firstConnectionId)
    return allSame ? firstConnectionId : null
  }

  // 加载表列信息
  const loadTableColumns = useCallback(
    async (tableId: any) => {
      try {
        // 获取表的 database_connection_id
        const list = tablesRef.current
        const targetTable = list.find((tb) => tb.id === tableId)
        const connectionId = targetTable?.database_connection_id
        if (!connectionId) {
          console.error('表缺少 database_connection_id')
          return
        }
        const res: any = await getTableColumnsReq(projectId, connectionId, tableId)
        if (res.success) {
          const columns = res.data.items || []

          // 更新对应表的列信息
          const cur = tablesRef.current
          const table = cur.find((tb) => tb.id === tableId)
          if (table) {
            table.columns = columns

            // 如果当前选中的是这个表，更新currentTable
            if (currentTableRef.current && currentTableRef.current.id === tableId) {
              setCurrentTable(table)
            }
            // 同步刷新 tables 引用，触发子组件 rerender
            setTables([...cur])
          }
        }
      } catch (error) {
        console.error('获取表列信息失败:', error)
        notifications.show({ color: 'red', message: t('structuredData.table.columnsFetchFailed') })
      }
    },
    [projectId, t]
  )

  // 获取表列表
  const fetchTables = useCallback(async () => {
    if (!dataSourceId || !projectId) return

    try {
      setLoading(true)
      const res: any = await getDataSourceTablesReq(projectId, dataSourceId)

      const tableList = res?.data?.items || []

      // 确保每个表都有 schema_name（处理无 schema 的情况）
      const mapped = tableList.map((table: any) => ({
        ...table,
        schema_name: table.schema_name || null // 保持 null，让 TableStructureView 处理
      }))
      tablesRef.current = mapped
      setTables(mapped)

      // 如果有表，默认选择第一个
      if (mapped.length > 0 && !currentTableRef.current) {
        const first = mapped[0]
        currentTableRef.current = first
        setCurrentTable(first)
        onTableSelected?.(first)
        await loadTableColumns(first.id)
      } else if (mapped.length === 0) {
        // 如果没有表了，通知父组件
        currentTableRef.current = null
        setCurrentTable(null)
        onTableUnselected?.()
      }
    } catch (error) {
      console.error('获取表列表失败:', error)
      notifications.show({ color: 'red', message: t('structuredData.table.fetchFailed') })
    } finally {
      setLoading(false)
    }
  }, [dataSourceId, projectId, loadTableColumns, onTableSelected, onTableUnselected, t])

  // 表切换处理
  const handleTableChange = async (table: any) => {
    currentTableRef.current = table
    setCurrentTable(table)
    // 通知父组件表已选中
    if (table) {
      onTableSelected?.(table)
    } else {
      onTableUnselected?.()
    }
    // 如果表没有列信息，则加载
    if (table && (!table.columns || table.columns.length === 0)) {
      await loadTableColumns(table.id)
    }
  }

  // 批量操作后的刷新
  const handleRefreshAfterBatchOperation = async () => {
    await fetchTables()
    // 如果当前表还存在，刷新其列信息
    if (currentTableRef.current) {
      const list = tablesRef.current
      const table = list.find((tb) => tb.id === currentTableRef.current.id)
      if (table) {
        currentTableRef.current = table
        setCurrentTable(table)
        await loadTableColumns(table.id)
      } else {
        // 如果当前表已被删除，选择第一个表
        if (list.length > 0) {
          const first = list[0]
          currentTableRef.current = first
          setCurrentTable(first)
          onTableSelected?.(first)
          await loadTableColumns(first.id)
        } else {
          currentTableRef.current = null
          setCurrentTable(null)
          onTableUnselected?.()
        }
      }
    }
  }

  // 单个操作后的刷新
  const handleRefreshAfterSingleOperation = async () => {
    await fetchTables()
    if (currentTableRef.current) {
      await loadTableColumns(currentTableRef.current.id)
    }
  }

  // 打开编辑对话框
  const handleOpenEditDialog = async (table: any) => {
    if (!table || !table.id) {
      notifications.show({ color: 'yellow', message: t('structuredData.table.selectFirst') })
      return
    }

    // 确保表的列信息已加载
    if (!table.columns || table.columns.length === 0) {
      await loadTableColumns(table.id)
      // 重新获取表对象（包含列信息）
      const updatedTable = tablesRef.current.find((tb) => tb.id === table.id)
      if (updatedTable) {
        table = updatedTable
      }
    }

    // 深拷贝表数据用于编辑
    setEditingTableData(JSON.parse(JSON.stringify(table)))
    setShowEditDialog(true)
  }

  // 表编辑保存后的回调
  const handleTableEditSaved = async () => {
    // 刷新表列表和当前表的列信息
    await fetchTables()
    if (currentTableRef.current) {
      await loadTableColumns(currentTableRef.current.id)
    }
  }

  // 打开测试召回对话框
  const handleOpenRetrievalTest = () => {
    setShowRetrievalDialog(true)
  }

  // 监听数据源ID和projectId变化(对应 watch(immediate: true))
  useEffect(() => {
    tablesRef.current = []
    currentTableRef.current = null
    setTables([])
    setCurrentTable(null)
    onTableUnselected?.()
    if (dataSourceId && projectId) {
      void fetchTables()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataSourceId, projectId])

  return (
    <div className={styles['table-management']}>
      <div className={styles['tab-container']}>
        {/* 统一的内容卡片 */}
        <div className={styles['content-card']}>
          {/* 加载状态 */}
          {loading ? (
            <div className={styles['loading-placeholder']}>
              <div className={styles['loading-content']}>
                <div className={styles['loading-icon']}>
                  <ElSvgIcon name="Loading" size={48} />
                </div>
                <div className={styles['loading-text']}>{t('structuredData.table.loading')}</div>
                <div className={styles['loading-subtext']}>{t('structuredData.table.loadingSubtext')}</div>
              </div>
            </div>
          ) : hasTables ? (
            <>
              {/* 顶部操作区 */}
              <div className={styles['operations-header']}>
                <div className={styles['header-actions']}>
                  {/* 批量操作按钮组 */}
                  <UnifiedTableBatchActions
                    databaseId={dataSourceId}
                    tables={tables}
                    isStructuredDataSource={true}
                    onRefresh={handleRefreshAfterBatchOperation}
                    onOpenRetrievalTest={handleOpenRetrievalTest}
                    onLoadColumns={loadTableColumns}
                  />
                </div>
              </div>

              {/* 表结构展示 */}
              <TableStructureView
                databaseId={getDatabaseConnectionId() || dataSourceId}
                tables={tables}
                totalTables={tables.length}
                currentTable={currentTable}
                isFromGuide={false}
                onTableChange={handleTableChange}
                onRefresh={handleRefreshAfterSingleOperation}
                onOpenEditDialog={handleOpenEditDialog}
                onLoadColumns={loadTableColumns}
                onOpenRetrievalTest={handleOpenRetrievalTest}
              />
            </>
          ) : (
            /* 没有表结构信息时的提示 */
            <div className={styles['empty-placeholder']}>
              {/* el-empty → 简单的居中空状态 */}
              <div style={{ alignSelf: 'center', textAlign: 'center', color: '#909399' }}>
                {t('structuredData.table.empty')}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 表编辑弹窗 (v-model → opened + onOpenedChange) */}
      <TableEditDialog
        opened={showEditDialog}
        onOpenedChange={setShowEditDialog}
        onClose={() => setShowEditDialog(false)}
        table={editingTableData}
        onSaved={handleTableEditSaved}
      />

      {/* 测试召回对话框 (v-model → opened + onOpenedChange) */}
      <StructuredTableRetrievalTestDialog
        opened={showRetrievalDialog}
        onOpenedChange={setShowRetrievalDialog}
        onClose={() => setShowRetrievalDialog(false)}
        dataSourceId={dataSourceId}
      />
    </div>
  )
}
