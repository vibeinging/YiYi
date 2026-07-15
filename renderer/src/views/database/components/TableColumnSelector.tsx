import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  Center,
  Checkbox,
  CloseButton,
  Group,
  LoadingOverlay,
  Pagination,
  Text,
  TextInput
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { getCachedTablesReq, getTableColumnsReq } from '@/api/database'
import { useProjectStore } from '@/store/project'
import ElSvgIcon from '@/components/ElSvgIcon'
import { formatTableDisplayName } from '@/utils/tableDisplay'
import styles from './TableColumnSelector.module.scss'

// 已选配置：{ table_name: [column_name1, column_name2] }
interface TableColumnSelectorProps {
  databaseId: string
  /** 对应 Vue v-model:modelValue */
  modelValue?: Record<string, string[]>
  /** 对应 Vue emit('update:modelValue') */
  onUpdateModelValue?: (configs: Record<string, string[]>) => void
}

const tablePageSize = 20
const columnPageSize = 20

export default function TableColumnSelector({
  databaseId,
  modelValue = {},
  onUpdateModelValue
}: TableColumnSelectorProps) {
  const { t } = useTranslation()

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
    const start = (tableCurrentPage - 1) * tablePageSize
    const end = start + tablePageSize
    return filteredTables.slice(start, end)
  }, [filteredTables, tableCurrentPage])

  // 计算属性：表总页数
  const tableTotalPages = useMemo(() => {
    return Math.ceil(filteredTables.length / tablePageSize)
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
    const start = (columnCurrentPage - 1) * columnPageSize
    const end = start + columnPageSize
    return filteredColumns.slice(start, end)
  }, [filteredColumns, columnCurrentPage])

  // 计算属性：列总页数
  const columnTotalPages = useMemo(() => {
    return Math.ceil(filteredColumns.length / columnPageSize)
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

  // 加载表列表
  const loadTables = async () => {
    setLoadingTables(true)
    try {
      const projectId = useProjectStore.getState().currentProject?.id || null
      const res: any = await getCachedTablesReq(projectId, databaseId)
      if (res.success) {
        setAllTables(res.data.items || [])
      }
    } catch (error) {
      console.error('加载表列表失败:', error)
      notifications.show({ color: 'red', message: t('database.columnSelector.loadTablesFailed') })
    } finally {
      setLoadingTables(false)
    }
  }

  // 加载列列表
  const loadColumns = async (tableId: any) => {
    setLoadingColumns(true)
    try {
      const projectId = useProjectStore.getState().currentProject?.id || null
      const res: any = await getTableColumnsReq(projectId, databaseId, tableId)
      if (res.success) {
        setCurrentTableColumns(res.data.items || [])
      }
    } catch (error) {
      console.error('加载列列表失败:', error)
      notifications.show({ color: 'red', message: t('database.columnSelector.loadColumnsFailed') })
    } finally {
      setLoadingColumns(false)
    }
  }

  // 处理表搜索
  const handleTableSearch = () => {
    setTableCurrentPage(1)
  }

  // 处理列搜索
  const handleColumnSearch = () => {
    setColumnCurrentPage(1)
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

  // 处理列checkbox变化
  const handleColumnCheckChange = (column: any, checked: boolean) => {
    if (checked) {
      if (!isColumnSelected(column)) {
        setSelectedColumns((prev) => [...prev, column])
      }
    } else {
      setSelectedColumns((prev) => {
        const index = prev.findIndex((col) => col.column_name === column.column_name)
        if (index > -1) {
          const next = [...prev]
          next.splice(index, 1)
          return next
        }
        return prev
      })
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

    const configs: Record<string, string[]> = { ...(modelValue || {}) }
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

    const addedCount = selectedColumns.length
    onUpdateModelValue?.(configs)
    setSelectedColumns([])
    // 保持原逻辑：原 Vue 在清空后才读 length，此处对齐为已记录的数量
    notifications.show({
      color: 'green',
      message: t('database.columnSelector.addedColumns', { count: addedCount })
    })
  }

  // 处理移除列
  const handleRemoveColumn = (tableName: string, columnName: string) => {
    const configs: Record<string, string[]> = { ...(modelValue || {}) }
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
    const configs: Record<string, string[]> = { ...(modelValue || {}) }
    delete configs[tableName]
    onUpdateModelValue?.(configs)
  }

  // 监听 databaseId 变化，重新加载表（immediate）
  useEffect(() => {
    if (databaseId) {
      loadTables()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databaseId])

  return (
    <div className={styles.tableColumnSelector}>
      {/* 左侧和中间：表和列的联动选择区域 */}
      <div className={styles.tableColumnSelectionPanel}>
        {/* 表选择区 */}
        <div className={styles.tableSelectArea}>
          <div className={styles.areaHeader}>
            <h4>{t('database.columnSelector.selectTable')}</h4>
          </div>
          <div className={styles.tableSearchBox}>
            <TextInput
              value={tableSearchKeyword}
              placeholder={t('database.columnSelector.searchTable')}
              leftSection={<ElSvgIcon name="Search" size={14} />}
              size="xs"
              onChange={(e) => {
                setTableSearchKeyword(e.currentTarget.value)
                handleTableSearch()
              }}
            />
          </div>
          {paginatedTables.length > 0 ? (
            <div className={styles.tablesListContainer}>
              <LoadingOverlay visible={loadingTables} />
              {paginatedTables.map((table) => (
                <div
                  key={table.id}
                  className={`${styles.tableListItem} ${
                    activeTableId === table.id ? styles.active : ''
                  }`}
                  onClick={() => handleTableSelect(table)}
                >
                  <span className={styles.tableName}>{formatTableDisplayName(table)}</span>
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
                  ? t('database.columnSelector.noMatchTable')
                  : t('database.columnSelector.noTable')}
              </span>
            </div>
          )}
          {tableTotalPages > 1 && (
            <div className={styles.tablePaginationMini}>
              <Pagination
                value={tableCurrentPage}
                total={tableTotalPages}
                onChange={setTableCurrentPage}
                size="sm"
              />
            </div>
          )}
        </div>

        {/* 列选择区 */}
        <div className={styles.columnSelectArea}>
          <div className={styles.areaHeader}>
            <h4>{t('database.columnSelector.selectColumn')}</h4>
          </div>
          {activeTableId ? (
            <>
              <div className={styles.areaHeader}>
                <div className={styles.columnActions}>
                  <TextInput
                    value={columnSearchKeyword}
                    placeholder={t('database.columnSelector.searchColumn')}
                    leftSection={<ElSvgIcon name="Search" size={14} />}
                    size="xs"
                    style={{ flex: 1 }}
                    onChange={(e) => {
                      setColumnSearchKeyword(e.currentTarget.value)
                      handleColumnSearch()
                    }}
                  />
                  <Checkbox
                    checked={isAllColumnsSelected}
                    indeterminate={isSomeColumnsSelected && !isAllColumnsSelected}
                    onChange={(e) => handleToggleSelectAll(e.currentTarget.checked)}
                    size="xs"
                    label={t('database.columnSelector.selectAll')}
                  />
                  <Button
                    size="xs"
                    disabled={selectedColumns.length === 0}
                    leftSection={<ElSvgIcon name="Plus" size={14} />}
                    onClick={handleAddSelectedColumns}
                  >
                    {t('database.columnSelector.add')} ({selectedColumns.length})
                  </Button>
                </div>
              </div>
              {paginatedColumns.length > 0 ? (
                <div className={styles.columnsCheckboxList}>
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
                      ? t('database.columnSelector.noMatchColumn')
                      : t('database.columnSelector.noColumn')}
                  </span>
                </div>
              )}
              {columnTotalPages > 1 && (
                <div className={styles.columnPaginationMini}>
                  <Pagination
                    value={columnCurrentPage}
                    total={columnTotalPages}
                    onChange={setColumnCurrentPage}
                    size="sm"
                  />
                </div>
              )}
            </>
          ) : (
            <div className={styles.noTableSelectedHint}>
              <Center style={{ flexDirection: 'column', gap: 8 }}>
                <ElSvgIcon name="Document" size={60} color="#dcdfe6" />
                <Text c="dimmed" size="sm">
                  {t('database.columnSelector.selectTableHint')}
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
            {t('database.columnSelector.selectedConfig')} ({configStats.tableCount}{' '}
            {t('database.columnSelector.tables')} {configStats.columnCount}{' '}
            {t('database.columnSelector.columns')})
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
                      {tableGroup.columns.length} {t('database.columnSelector.columns')}
                    </span>
                  </div>
                  <Button
                    size="xs"
                    color="red"
                    variant="subtle"
                    onClick={() => handleRemoveTable(tableGroup.table_name)}
                  >
                    {t('database.columnSelector.removeAll')}
                  </Button>
                </div>
                <div className={styles.configColumnsTags}>
                  {tableGroup.columns.map((col) => (
                    <Badge
                      key={col}
                      color="gray"
                      size="sm"
                      variant="light"
                      rightSection={
                        <CloseButton
                          size={14}
                          radius="xl"
                          variant="transparent"
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
            <Center style={{ flexDirection: 'column', gap: 8 }}>
              <ElSvgIcon name="Document" size={60} color="#dcdfe6" />
              <Text c="dimmed" size="sm">
                {t('database.columnSelector.noConfig')}
              </Text>
              <p className={styles.hintText}>{t('database.columnSelector.addHint')}</p>
            </Center>
          </div>
        )}
      </div>
    </div>
  )
}
