import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Center, Table, Text, Textarea, TextInput } from '@mantine/core'
import ElSvgIcon from '@/components/ElSvgIcon'
import { getDocumentTablesReq } from '@/api/structured_data_source/document'
import { getTableColumnsReq, updateTableDescriptionReq } from '@/api/database'
import styles from './DocumentTableExpand.module.scss'

interface DocumentTableExpandProps {
  projectId: string
  documentId: string
}

export default function DocumentTableExpand({ projectId, documentId }: DocumentTableExpandProps) {
  const { t } = useTranslation()

  // 状态管理
  const [tables, setTables] = useState<any[]>([])
  const [currentTable, setCurrentTable] = useState<any>(null)
  const [columns, setColumns] = useState<any[]>([])
  const [columnsLoading, setColumnsLoading] = useState(false)
  const [searchKeyword, setSearchKeyword] = useState('')
  const [isEditingDescription, setIsEditingDescription] = useState(false)
  const [editingDescription, setEditingDescription] = useState('')

  // 过滤后的列数据
  const filteredColumns = useMemo(() => {
    if (!searchKeyword) {
      return columns
    }
    const keyword = searchKeyword.toLowerCase()
    return columns.filter((col) => col.column_name.toLowerCase().includes(keyword))
  }, [columns, searchKeyword])

  // 加载列信息（使用 database.js 的统一接口）
  const loadColumns = async (_tableId: any, connectionId: any, tableId: any) => {
    setColumnsLoading(true)
    try {
      const res: any = await getTableColumnsReq(projectId, connectionId, tableId)
      if (res?.data?.items && res.data.items.length > 0) {
        setColumns(res.data.items)
      } else {
        // API 返回空数组，设置为空
        setColumns([])
      }
    } catch (error) {
      console.error('加载列信息失败:', error)
      // API 调用失败，设置为空
      setColumns([])
    } finally {
      setColumnsLoading(false)
    }
  }

  // 加载表列表
  const loadTables = async () => {
    try {
      const res: any = await getDocumentTablesReq(projectId, documentId)
      if (res?.data?.items && res.data.items.length > 0) {
        const items = res.data.items
        setTables(items)
        // 默认选择第一个表
        const first = items[0]
        setCurrentTable(first)
        await loadColumns(first.id, first.database_connection_id, first.id)
      } else {
        // 表列表为空，不加载列信息
        setTables([])
        setCurrentTable(null)
        setColumns([])
      }
    } catch (error) {
      console.error('加载表列表失败:', error)
      // 出错时也不使用模拟数据，避免调用不存在的表
      setTables([])
      setCurrentTable(null)
      setColumns([])
    }
  }

  // 监听 documentId 变化，加载数据（immediate + onMounted 合并为一次 effect）
  useEffect(() => {
    if (documentId) {
      loadTables()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId])

  // 格式化示例值
  const formatExampleValues = (values: any) => {
    if (Array.isArray(values)) {
      return values.slice(0, 3).join(', ') + (values.length > 3 ? '...' : '')
    }
    return values || t('structuredData.noExampleValues')
  }

  // 表描述编辑
  const startEditDescription = () => {
    setIsEditingDescription(true)
    setEditingDescription(currentTable?.description || '')
  }

  // 用 ref 记录最新编辑值，blur 时读取，避免闭包旧值
  const editingDescriptionRef = useRef(editingDescription)
  editingDescriptionRef.current = editingDescription

  const handleDescriptionBlur = async () => {
    if (currentTable) {
      const oldDescription = currentTable.description
      const nextDescription = editingDescriptionRef.current
      // 乐观更新
      setCurrentTable((prev: any) => (prev ? { ...prev, description: nextDescription } : prev))

      // 调用 API 保存描述（使用 database.js 的统一接口）
      try {
        await updateTableDescriptionReq(
          projectId,
          currentTable.database_connection_id,
          currentTable.id,
          nextDescription
        )
      } catch (error) {
        console.error('保存表描述失败:', error)
        // 恢复原始值
        setCurrentTable((prev: any) => (prev ? { ...prev, description: oldDescription } : prev))
      }
    }
    setIsEditingDescription(false)
  }

  const cancelEditDescription = () => {
    setIsEditingDescription(false)
    setEditingDescription(currentTable?.description || '')
  }

  return (
    <div className={styles.documentTableExpand}>
      {/* 空状态 */}
      {!currentTable ? (
        <div className={styles.emptyState}>
          <Center>
            <Text c="dimmed">{t('structuredData.noRelatedTables')}</Text>
          </Center>
        </div>
      ) : (
        <>
          {/* 表描述区域 */}
          <div className={styles.tableDescriptionSection}>
            <div className={styles.descriptionHeader}>
              <span className={styles.label}>{t('structuredData.tableDescription')}:</span>
              {isEditingDescription ? (
                <Textarea
                  autoFocus
                  value={editingDescription}
                  onChange={(e) => setEditingDescription(e.currentTarget.value)}
                  autosize
                  minRows={2}
                  placeholder={t('structuredData.tableDescPlaceholder')}
                  className={styles.descriptionInput}
                  onBlur={handleDescriptionBlur}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      cancelEditDescription()
                    }
                  }}
                />
              ) : (
                <div className={styles.descriptionDisplay} onClick={startEditDescription}>
                  {currentTable?.description ? (
                    <span className={styles.descriptionText}>{currentTable.description}</span>
                  ) : (
                    <span className={styles.descriptionPlaceholder}>{t('structuredData.clickToEdit')}</span>
                  )}
                  <span className={styles.editIcon}>
                    <ElSvgIcon name="Edit" size={16} />
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* 操作按钮区域 */}
          <div className={styles.actionButtonsSection}>
            <Button
              variant="filled"
              className={styles.actionBtn}
              disabled
              leftSection={<ElSvgIcon name="Sunny" size={16} />}
            >
              {t('structuredData.generateTableDesc')}
            </Button>
            <Button
              variant="filled"
              className={styles.actionBtn}
              disabled
              leftSection={<ElSvgIcon name="Upload" size={16} />}
            >
              {t('structuredData.generateTableVector')}
            </Button>
            <Button
              variant="filled"
              className={styles.actionBtn}
              disabled
              leftSection={<ElSvgIcon name="Upload" size={16} />}
            >
              {t('structuredData.generateColumnVector')}
            </Button>
            <Button
              variant="filled"
              className={styles.actionBtn}
              disabled
              leftSection={<ElSvgIcon name="Document" size={16} />}
            >
              {t('structuredData.getTableExampleData')}
            </Button>
            <Button
              variant="filled"
              className={styles.actionBtn}
              disabled
              leftSection={<ElSvgIcon name="Edit" size={16} />}
            >
              {t('structuredData.editTable')}
            </Button>
            <Button
              variant="filled"
              className={styles.actionBtn}
              disabled
              leftSection={<ElSvgIcon name="Star" size={16} />}
            >
              {t('structuredData.markHighRecall')}
            </Button>
          </div>

          {/* 列信息表格 */}
          <div className={styles.columnsSection}>
            {/* 搜索栏 */}
            <div className={styles.searchBar}>
              <TextInput
                value={searchKeyword}
                onChange={(e) => setSearchKeyword(e.currentTarget.value)}
                placeholder={t('structuredData.searchColumnPlaceholder')}
                className={styles.searchInput}
                leftSection={<ElSvgIcon name="Search" size={16} />}
              />
            </div>

            {/* 列信息表格 */}
            <Table className={styles.columnsTable} style={{ width: '100%' }}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th style={{ width: 200 }}>{t('structuredData.columnName')}</Table.Th>
                  <Table.Th style={{ width: 150 }}>{t('structuredData.dataType')}</Table.Th>
                  <Table.Th style={{ width: 100 }}>{t('structuredData.highRecall')}</Table.Th>
                  <Table.Th style={{ minWidth: 200 }}>{t('structuredData.descriptionLabel')}</Table.Th>
                  <Table.Th style={{ minWidth: 200 }}>{t('structuredData.exampleValues')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {filteredColumns.length === 0 ? (
                  <Table.Tr>
                    <Table.Td colSpan={5}>
                      <div className={styles.emptyTableText}>
                        {columnsLoading ? t('structuredData.loading') : t('structuredData.noColumnInfo')}
                      </div>
                    </Table.Td>
                  </Table.Tr>
                ) : (
                  filteredColumns.map((row: any, index: number) => (
                    <Table.Tr key={row.id ?? row.column_name ?? index}>
                      <Table.Td>{row.column_name}</Table.Td>
                      <Table.Td>{row.data_type}</Table.Td>
                      <Table.Td>
                        <Badge color={row.is_high_recall ? 'green' : 'gray'} size="sm">
                          {row.is_high_recall ? 'YES' : 'NO'}
                        </Badge>
                      </Table.Td>
                      <Table.Td>{row.description ? <span>{row.description}</span> : null}</Table.Td>
                      <Table.Td>
                        {row.example_values && row.example_values.length > 0 ? (
                          <span>{formatExampleValues(row.example_values)}</span>
                        ) : (
                          <span className={styles.emptyText}>{t('structuredData.noExampleValues')}</span>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  ))
                )}
              </Table.Tbody>
            </Table>
          </div>
        </>
      )}
    </div>
  )
}
