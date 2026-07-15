import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  Center,
  Checkbox,
  CloseButton,
  LoadingOverlay,
  Pagination,
  Text,
  TextInput
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import ElSvgIcon from '@/components/ElSvgIcon'
import { getCachedTablesReq, getTableColumnsReq } from '@/api/database'
import { getDataSourceTablesReq } from '@/api/structured_data_source/document'
import { useProjectStore, projectGetters } from '@/store/project'
import styles from './TableColumnSelector.module.scss'

// 已选配置：{ table_name: [column_name1, column_name2] }
export interface TableColumnSelectorProps {
  databaseId: string
  sourceType?: string
  // 结构化数据源的 database_connection_id（可选，从数据源级别获取）
  databaseConnectionId?: string | null
  modelValue?: Record<string, string[]>
  // defineEmits(['update:modelValue']) → 回调 props
  'onUpdate:modelValue'?: (configs: Record<string, string[]>) => void
}

const TABLE_PAGE_SIZE = 20
const COLUMN_PAGE_SIZE = 20

export default function TableColumnSelector({
  databaseId,
  sourceType = 'database',
  databaseConnectionId = null,
  modelValue = {},
  'onUpdate:modelValue': onUpdateModelValue
}: TableColumnSelectorProps) {
  const { t } = useTranslation()

  // currentProjectId getter（对应 projectStore.currentProjectId）
  const currentProjectId = useProjectStore(projectGetters.currentProjectId)

  // 表相关状态
  const [allTables, setAllTables] = useState<any[]>([])
  const [tableSearchKeyword, setTableSearchKeyword] = useState('')
  const [tableCurrentPage, setTableCurrentPage] = useState(1)
  const [loadingTables, setLoadingTables] = useState(false)

  // 列相关状态
  const [activeTableId, setActiveTableId] = useState<any>(null)
  const [activeTableName, setActiveTableName] = useState('')
  const [currentTableColumns, setCurrentTableColumns] = useState<any[]>([])
  const [columnSearchKeyword, setColumnSearchKeyword] = useState('')
  const [columnCurrentPage, setColumnCurrentPage] = useState(1)
  const [loadingColumns, setLoadingColumns] = useState(false)
  const [selectedColumns, setSelectedColumns] = useState<any[]>([])

  // 计算属性：过滤后的表
  const filteredTables = useMemo(() => {
    if (!tableSearchKeyword.trim()) {
      return allTables
    }
    const keyword = tableSearchKeyword.toLowerCase().trim()
    return allTables.filter(
      (table) =>
        table.table_name.toLowerCase().includes(keyword) ||
        (table.description && table.description.toLowerCase().includes(keyword))
    )
  }, [allTables, tableSearchKeyword])

  // 计算属性：分页后的表
  const paginatedTables = useMemo(() => {
    const start = (tableCurrentPage - 1) * TABLE_PAGE_SIZE
    const end = start + TABLE_PAGE_SIZE
    return filteredTables.slice(start, end)
  }, [filteredTables, tableCurrentPage])

  // 计算属性：表总页数
  const tableTotalPages = useMemo(() => {
    return Math.ceil(filteredTables.length / TABLE_PAGE_SIZE)
  }, [filteredTables])

  // 计算属性：过滤后的列
  const filteredColumns = useMemo(() => {
    if (!columnSearchKeyword.trim()) {
      return currentTableColumns
    }
    const keyword = columnSearchKeyword.toLowerCase().trim()
    return currentTableColumns.filter(
      (col) =>
        col.column_name.toLowerCase().includes(keyword) ||
        (col.description && col.description.toLowerCase().includes(keyword))
    )
  }, [currentTableColumns, columnSearchKeyword])

  // 计算属性：分页后的列
  const paginatedColumns = useMemo(() => {
    const start = (columnCurrentPage - 1) * COLUMN_PAGE_SIZE
    const end = start + COLUMN_PAGE_SIZE
    return filteredColumns.slice(start, end)
  }, [filteredColumns, columnCurrentPage])

  // 计算属性：列总页数
  const columnTotalPages = useMemo(() => {
    return Math.ceil(filteredColumns.length / COLUMN_PAGE_SIZE)
  }, [filteredColumns])

  // 判断列是否已选
  const isColumnSelected = (column: any) => {
    return selectedColumns.some((col) => col.column_name === column.column_name)
  }

  // 判断列是否已添加到配置
  const isColumnDisabled = (column: any) => {
    const configs = modelValue || {}
    return configs[activeTableName]?.includes(column.column_name) || false
  }

  // 计算属性：是否全选
  const isAllColumnsSelected = useMemo(() => {
    if (filteredColumns.length === 0) return false
    const selectableColumns = filteredColumns.filter((col) => !isColumnDisabled(col))
    if (selectableColumns.length === 0) return false
    return selectableColumns.every((col) => isColumnSelected(col))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredColumns, selectedColumns, modelValue, activeTableName])

  // 计算属性：是否部分选中
  const isSomeColumnsSelected = useMemo(() => {
    if (filteredColumns.length === 0) return false
    const selectableColumns = filteredColumns.filter((col) => !isColumnDisabled(col))
    return selectableColumns.some((col) => isColumnSelected(col))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredColumns, selectedColumns, modelValue, activeTableName])

  // 计算属性：已选配置分组
  const groupedConfigs = useMemo(() => {
    const configs = modelValue || {}
    return Object.keys(configs)
      .filter((tableName) => configs[tableName] && configs[tableName].length > 0)
      .map((tableName) => ({
        table_name: tableName,
        columns: configs[tableName]
      }))
  }, [modelValue])

  // 计算属性：配置统计
  const configStats = useMemo(() => {
    const tableCount = groupedConfigs.length
    const columnCount = groupedConfigs.reduce((sum, group) => sum + group.columns.length, 0)
    return { tableCount, columnCount }
  }, [groupedConfigs])

  // 加载列列表
  const loadColumns = async (tableId: any) => {
    setLoadingColumns(true)
    try {
      // 获取连接ID：优先使用 props.databaseConnectionId（从数据源级别获取）
      let connectionId = databaseId
      if (sourceType === 'structured') {
        // 优先使用从数据源级别传入的 database_connection_id
        connectionId = databaseConnectionId || databaseId
      }
      const res: any = await getTableColumnsReq(currentProjectId, connectionId, tableId)
      if (res?.success) {
        setCurrentTableColumns(res.data.items || [])
      }
    } catch (error) {
      console.error('加载列列表失败:', error)
      notifications.show({ color: 'red', message: t('business.tableColumnSelector.loadColumnsFailed') })
    } finally {
      setLoadingColumns(false)
    }
  }

  // 处理表选择
  const handleTableSelect = async (table: any) => {
    setActiveTableId(table.id)
    setActiveTableName(table.table_name)
    setSelectedColumns([])
    setColumnSearchKeyword('')
    setColumnCurrentPage(1)
    await loadColumns(table.id)
  }

  // 用 ref 持有最新值，供 effect / 异步回调读取，避免闭包陈旧
  const activeTableIdRef = useRef<any>(activeTableId)
  activeTableIdRef.current = activeTableId
  const allTablesRef = useRef<any[]>(allTables)
  allTablesRef.current = allTables
  const modelValueRef = useRef<Record<string, string[]>>(modelValue)
  modelValueRef.current = modelValue
  const handleTableSelectRef = useRef(handleTableSelect)
  handleTableSelectRef.current = handleTableSelect

  // 加载表列表
  const loadTables = async () => {
    setLoadingTables(true)
    try {
      let res: any
      if (sourceType === 'structured') {
        res = await getDataSourceTablesReq(currentProjectId, databaseId)
      } else {
        res = await getCachedTablesReq(currentProjectId, databaseId)
      }
      if (res?.success) {
        setAllTables(res.data.items || [])
      }
    } catch (error) {
      console.error('加载表列表失败:', error)
      notifications.show({ color: 'red', message: t('business.tableColumnSelector.loadTablesFailed') })
    } finally {
      setLoadingTables(false)
    }
  }
  const loadTablesRef = useRef(loadTables)
  loadTablesRef.current = loadTables

  // 处理表搜索
  const handleTableSearch = (val: string) => {
    setTableSearchKeyword(val)
    setTableCurrentPage(1)
  }

  // 处理列搜索
  const handleColumnSearch = (val: string) => {
    setColumnSearchKeyword(val)
    setColumnCurrentPage(1)
  }

  // 处理列checkbox变化
  const handleColumnCheckChange = (column: any, checked: boolean) => {
    if (checked) {
      if (!isColumnSelected(column)) {
        setSelectedColumns((prev) => [...prev, column])
      }
    } else {
      setSelectedColumns((prev) => prev.filter((col) => col.column_name !== column.column_name))
    }
  }

  // 处理全选/取消全选
  const handleToggleSelectAll = (checked: boolean) => {
    if (checked) {
      // 全选：添加所有未禁用的列
      const selectableColumns = filteredColumns.filter((col) => !isColumnDisabled(col))
      setSelectedColumns([...selectableColumns])
    } else {
      // 取消全选
      setSelectedColumns([])
    }
  }

  // 处理添加已选列
  const handleAddSelectedColumns = () => {
    if (selectedColumns.length === 0) return

    const configs = { ...modelValue }
    if (!configs[activeTableName]) {
      configs[activeTableName] = []
    } else {
      configs[activeTableName] = [...configs[activeTableName]]
    }

    selectedColumns.forEach((col) => {
      if (!configs[activeTableName].includes(col.column_name)) {
        configs[activeTableName].push(col.column_name)
      }
    })

    onUpdateModelValue?.(configs)
    setSelectedColumns([])
    // 保持原逻辑：count 取清空后的 selectedColumns.length（即 0）
    notifications.show({
      color: 'green',
      message: t('business.tableColumnSelector.addedColumns', { count: 0 })
    })
  }

  // 处理移除列
  const handleRemoveColumn = (tableName: string, columnName: string) => {
    const configs = { ...modelValue }
    if (configs[tableName]) {
      configs[tableName] = configs[tableName].filter((col) => col !== columnName)
      if (configs[tableName].length === 0) {
        delete configs[tableName]
      }
    }
    onUpdateModelValue?.(configs)
  }

  // 处理移除表的所有列
  const handleRemoveTable = (tableName: string) => {
    const configs = { ...modelValue }
    delete configs[tableName]
    onUpdateModelValue?.(configs)
  }

  // 监听 databaseId 变化，重新加载表（immediate）
  const prevDatabaseIdRef = useRef<any>(undefined)
  useEffect(() => {
    const newId = databaseId
    const oldId = prevDatabaseIdRef.current
    prevDatabaseIdRef.current = newId
    if (newId) {
      // 如果数据源变化，重置选中状态
      if (oldId !== undefined && oldId && oldId !== newId) {
        setActiveTableId(null)
        setActiveTableName('')
        setCurrentTableColumns([])
        setSelectedColumns([])
      }
      loadTablesRef.current()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databaseId])

  // 监听 modelValue 变化，自动选中第一个有列的表（immediate + deep）
  useEffect(() => {
    const newValue = modelValue
    if (newValue && Object.keys(newValue).length > 0 && !activeTableIdRef.current) {
      // 找到第一个有列的表
      const firstTableName = Object.keys(newValue).find(
        (tableName) => newValue[tableName] && newValue[tableName].length > 0
      )
      if (firstTableName && allTablesRef.current.length > 0) {
        // 在表列表中找到对应的表
        const table = allTablesRef.current.find((tb) => tb.table_name === firstTableName)
        if (table) {
          handleTableSelectRef.current(table)
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelValue])

  // 监听表列表加载完成，如果有已选配置，自动选中第一个表
  useEffect(() => {
    const tables = allTables
    const mv = modelValueRef.current
    if (tables.length > 0 && mv && Object.keys(mv).length > 0 && !activeTableIdRef.current) {
      // 找到第一个有列的表
      const firstTableName = Object.keys(mv).find(
        (tableName) => mv[tableName] && mv[tableName].length > 0
      )
      if (firstTableName) {
        const table = tables.find((tb) => tb.table_name === firstTableName)
        if (table) {
          handleTableSelectRef.current(table)
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allTables])

  return (
    <div className={styles.tableColumnSelector}>
      {/* 左侧和中间：表和列的联动选择区域 */}
      <div className={styles.tableColumnSelectionPanel}>
        {/* 表选择区 */}
        <div className={styles.tableSelectArea}>
          <div className={styles.areaHeader}>
            <h4>{t('business.tableColumnSelector.selectTable')}</h4>
          </div>
          <div className={styles.tableSearchBox}>
            <TextInput
              value={tableSearchKeyword}
              placeholder={t('business.tableColumnSelector.searchTable')}
              leftSection={<ElSvgIcon name="Search" size={16} />}
              size="xs"
              onChange={(e) => handleTableSearch(e.currentTarget.value)}
            />
          </div>
          {paginatedTables.length > 0 ? (
            <div className={styles.tablesListContainer} style={{ position: 'relative' }}>
              <LoadingOverlay visible={loadingTables} />
              {paginatedTables.map((table) => (
                <div
                  key={table.id}
                  className={`${styles.tableListItem} ${activeTableId === table.id ? styles.active : ''}`}
                  onClick={() => handleTableSelect(table)}
                >
                  <span className={styles.tableName}>{table.table_name}</span>
                  {table.description && (
                    <span className={styles.tableDesc} title={table.description}>
                      {table.description}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className={styles.noTablesMini}>
              <span>
                {tableSearchKeyword
                  ? t('business.tableColumnSelector.noMatchingTables')
                  : t('business.tableColumnSelector.noTables')}
              </span>
            </div>
          )}
          {tableTotalPages > 1 && (
            <div className={styles.tablePaginationMini}>
              <Pagination
                value={tableCurrentPage}
                total={tableTotalPages}
                onChange={setTableCurrentPage}
                size="xs"
                withControls
                withEdges={false}
              />
            </div>
          )}
        </div>

        {/* 列选择区 */}
        <div className={styles.columnSelectArea}>
          <div className={styles.areaHeader}>
            <h4>{t('business.tableColumnSelector.selectColumn')}</h4>
          </div>
          {activeTableId ? (
            <>
              <div className={styles.areaHeader}>
                <div className={styles.columnActions}>
                  <TextInput
                    value={columnSearchKeyword}
                    placeholder={t('business.tableColumnSelector.searchColumn')}
                    leftSection={<ElSvgIcon name="Search" size={16} />}
                    size="xs"
                    style={{ flex: 1 }}
                    onChange={(e) => handleColumnSearch(e.currentTarget.value)}
                  />
                  <Checkbox
                    checked={isAllColumnsSelected}
                    indeterminate={isSomeColumnsSelected && !isAllColumnsSelected}
                    onChange={(e) => handleToggleSelectAll(e.currentTarget.checked)}
                    size="xs"
                    label={t('business.tableColumnSelector.selectAll')}
                  />
                  <Button
                    size="xs"
                    disabled={selectedColumns.length === 0}
                    onClick={handleAddSelectedColumns}
                    leftSection={<ElSvgIcon name="Plus" size={14} />}
                  >
                    {t('business.tableColumnSelector.add')} ({selectedColumns.length})
                  </Button>
                </div>
              </div>
              {paginatedColumns.length > 0 ? (
                <div className={styles.columnsCheckboxList} style={{ position: 'relative' }}>
                  <LoadingOverlay visible={loadingColumns} />
                  {paginatedColumns.map((column) => (
                    <div
                      key={column.column_name}
                      className={`${styles.columnCheckboxItem} ${
                        isColumnDisabled(column) ? styles.disabled : ''
                      }`}
                    >
                      <Checkbox
                        checked={isColumnSelected(column)}
                        disabled={isColumnDisabled(column)}
                        onChange={(e) => handleColumnCheckChange(column, e.currentTarget.checked)}
                        label={
                          <div className={styles.columnInfo}>
                            <span className={styles.columnName}>{column.column_name}</span>
                            {column.description && (
                              <span className={styles.columnDesc} title={column.description}>
                                {column.description}
                              </span>
                            )}
                          </div>
                        }
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <div className={styles.noColumnsMini}>
                  <span>
                    {columnSearchKeyword
                      ? t('business.tableColumnSelector.noMatchingColumns')
                      : t('business.tableColumnSelector.noColumns')}
                  </span>
                </div>
              )}
              {columnTotalPages > 1 && (
                <div className={styles.columnPaginationMini}>
                  <Pagination
                    value={columnCurrentPage}
                    total={columnTotalPages}
                    onChange={setColumnCurrentPage}
                    size="xs"
                    withControls
                    withEdges={false}
                  />
                </div>
              )}
            </>
          ) : (
            <div className={styles.noTableSelectedHint}>
              {/* el-empty → Center + Text */}
              <Center style={{ flexDirection: 'column' }}>
                <Text size="sm" c="dimmed">
                  {t('business.tableColumnSelector.selectTableHint')}
                </Text>
              </Center>
            </div>
          )}
        </div>
      </div>

      {/* 右侧：已选配置区域 */}
      <div className={styles.selectedConfigsPanel}>
        <div className={styles.areaHeader}>
          <h4>
            {t('business.tableColumnSelector.selectedConfig')} ({configStats.tableCount}{' '}
            {t('business.tableColumnSelector.tables')} {configStats.columnCount}{' '}
            {t('business.tableColumnSelector.columns')})
          </h4>
        </div>
        {groupedConfigs.length > 0 ? (
          <div className={styles.configsListContainer}>
            {groupedConfigs.map((tableGroup) => (
              <div key={tableGroup.table_name} className={styles.configTableGroup}>
                <div className={styles.configGroupHeader}>
                  <div className={styles.groupTitle}>
                    <Badge color="gray" size="sm" variant="light">
                      {tableGroup.table_name}
                    </Badge>
                    <span className={styles.groupCount}>
                      {tableGroup.columns.length} {t('business.tableColumnSelector.columns')}
                    </span>
                  </div>
                  <Button
                    size="xs"
                    color="red"
                    variant="subtle"
                    onClick={() => handleRemoveTable(tableGroup.table_name)}
                  >
                    {t('business.tableColumnSelector.removeAll')}
                  </Button>
                </div>
                <div className={styles.configColumnsTags}>
                  {tableGroup.columns.map((col) => (
                    <Badge
                      key={col}
                      size="sm"
                      color="gray"
                      variant="light"
                      rightSection={
                        <CloseButton
                          size="xs"
                          aria-hidden
                          onClick={() => handleRemoveColumn(tableGroup.table_name, col)}
                        />
                      }
                    >
                      {col}
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.noConfigsHint}>
            {/* el-empty + slot → Center + Text */}
            <Center style={{ flexDirection: 'column' }}>
              <Text size="sm" c="dimmed">
                {t('business.tableColumnSelector.noSelectedConfig')}
              </Text>
              <p className={styles.hintText}>{t('business.tableColumnSelector.noSelectedConfigHint')}</p>
            </Center>
          </div>
        )}
      </div>
    </div>
  )
}
