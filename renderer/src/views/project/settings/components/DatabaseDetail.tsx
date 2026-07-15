import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Tabs, Badge, Table, Tooltip, TextInput, ScrollArea } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import ElSvgIcon from '@/components/ElSvgIcon'
import { useProjectStore, projectGetters } from '@/store/project'
import DatabaseConnectionInfo from '@/views/database/components/DatabaseConnectionInfo'
import DatabaseMetadataQuery from '@/views/database/components/DatabaseMetadataQuery'
import RelationshipERDiagram, {
  type RelationshipERDiagramHandle
} from '@/views/database/components/RelationshipERDiagram'
import TableEditDialog from '@/views/database/components/TableEditDialog'
import GuideStepSync from '@/views/database/components/guide/GuideStepSync'
import GuideStepMetadata from '@/views/database/components/guide/GuideStepMetadata'
import GuideStepEntity from '@/views/database/components/guide/GuideStepEntity'
import TableBatchActions from '@/views/database/components/TableBatchActions'
import TableRetrievalTestDialog from '@/views/database/components/TableRetrievalTestDialog'
import {
  updateTableHighRecallReq,
  generateSingleTableDescriptionReq,
  storeSingleTableVectorReq,
  storeTableColumnsVectorReq,
  syncTableExampleValuesReq,
  getTableColumnsReq,
  getCachedTablesReq
} from '@/api/database'
import { isDefaultSchemaName } from '@/utils/tableDisplay'
import styles from './DatabaseDetail.module.scss'

// defineProps + defineEmits(['back', 'updated', 'deleted'])
export interface DatabaseDetailProps {
  projectId?: string
  database: any
  onBack?: () => void
  onUpdated?: (updatedDatabase: any) => void
  onDeleted?: (database: any) => void
  initialTab?: string
  beforeTabs?: DatabaseDetailExtraTab[]
  settingsTabContent?: ReactNode
  settingsTabLabel?: ReactNode
  settingsTabIcon?: string
  headerTitle?: ReactNode
  headerSubtitle?: ReactNode
  headerIcon?: string
  typeBadgeLabel?: ReactNode
  refreshKey?: number
  showDatabaseTabs?: boolean
  showMetaSyncTab?: boolean
}

export interface DatabaseDetailExtraTab {
  value: string
  label: ReactNode
  icon?: string
  content: ReactNode
}

export default function DatabaseDetail({
  projectId = '',
  database,
  onBack,
  onUpdated,
  onDeleted,
  initialTab = 'metadata',
  beforeTabs = [],
  settingsTabContent,
  settingsTabLabel,
  settingsTabIcon = 'Setting',
  headerTitle,
  headerSubtitle,
  headerIcon = 'Coin',
  typeBadgeLabel,
  refreshKey = 0,
  showDatabaseTabs,
  showMetaSyncTab = true
}: DatabaseDetailProps) {
  const { t } = useTranslation()
  const currentProjectId = useProjectStore(projectGetters.currentProjectId)

  const erDiagramRef = useRef<RelationshipERDiagramHandle>(null)
  const [activeTab, setActiveTab] = useState(initialTab)
  const [syncKey, setSyncKey] = useState(0)
  const hasDatabaseConnection = Boolean(database?.id)
  const renderDatabaseTabs = showDatabaseTabs ?? hasDatabaseConnection
  const renderMetaSyncTab = renderDatabaseTabs && showMetaSyncTab

  // 批量操作用的表列表
  const [batchActionTables, setBatchActionTables] = useState<any[]>([])
  const loadBatchActionTables = async () => {
    if (!projectId || !database?.id) {
      setBatchActionTables([])
      return
    }
    try {
      const res: any = await getCachedTablesReq(projectId, database.id, { limit: 1000 })
      if (res.success && res.data) {
        setBatchActionTables(res.data.items || res.data || [])
      }
    } catch (e) {
      console.error('加载表列表失败:', e)
    }
  }
  useEffect(() => {
    setActiveTab(initialTab)
  }, [initialTab])

  // 初始加载以及外部刷新：结构化文件导入完成后会通过 refreshKey 触发。
  useEffect(() => {
    setSelectedTable(null)
    setBatchActionTables([])
    setSyncKey((k) => k + 1)
    loadBatchActionTables()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, database?.id, refreshKey])

  const handleBatchRefresh = () => {
    setSyncKey((k) => k + 1)
    loadBatchActionTables()
    if (erDiagramRef.current?.loadRelationships) {
      erDiagramRef.current.loadRelationships()
    }
  }

  // 表详情面板
  const [selectedTable, setSelectedTable] = useState<any>(null)
  const [columnSearchKeyword, setColumnSearchKeyword] = useState('')

  // 操作状态
  const [togglingHighRecall, setTogglingHighRecall] = useState(false)
  const [generatingDescriptions, setGeneratingDescriptions] = useState(false)
  const [generateDescBtnState, setGenerateDescBtnState] = useState<'idle' | 'generatingDesc' | 'generatingVector'>('idle')
  const generateDescButtonText = useMemo(() => {
    const map: Record<string, string> = {
      idle: 'project.database.aiGenerateDescVector',
      generatingDesc: 'project.database.generatingDesc',
      generatingVector: 'project.database.generatingVector'
    }
    return t(map[generateDescBtnState] || map.idle)
  }, [generateDescBtnState, t])
  const [syncingExampleValues, setSyncingExampleValues] = useState(false)
  const [regeneratingVectors, setRegeneratingVectors] = useState(false)
  const [retrievalTestVisible, setRetrievalTestVisible] = useState(false)
  const [tableEditDialogVisible, setTableEditDialogVisible] = useState(false)
  const [editingTable, setEditingTable] = useState<any>(null)

  // 列过滤
  const filteredColumns = useMemo(() => {
    const cols = selectedTable?.columns || []
    if (!columnSearchKeyword.trim()) return cols
    const kw = columnSearchKeyword.toLowerCase().trim()
    return cols.filter(
      (c: any) =>
        c.column_name.toLowerCase().includes(kw) || (c.description && c.description.toLowerCase().includes(kw))
    )
  }, [selectedTable, columnSearchKeyword])

  // 示例值格式化
  const formatExampleValues = (values: any) => {
    try {
      return JSON.stringify(values, null, 2)
    } catch {
      return String(values)
    }
  }
  const formatExamplePreview = (values: any[]) => {
    const valid = (values || []).filter((v) => v !== null && v !== undefined && v !== '')
    if (valid.length === 0) return '[]'
    const preview = valid.slice(0, 2).map((v) => {
      const s = String(v)
      return s.length > 6 ? s.substring(0, 6) + '...' : s
    })
    return valid.length > 2 ? `[${preview.join(', ')}...]` : `[${preview.join(', ')}]`
  }

  // 数据库类型标签颜色（EP tag type → Mantine Badge color）
  const getDbTypeTagColor = (dbType: string) => {
    const typeMap: Record<string, string> = {
      MySQL: 'blue',
      PostgreSQL: 'green',
      Oracle: 'red',
      SQLServer: 'orange',
      SQLite: 'gray',
      DuckDB: 'yiw',
      OpenGauss: 'green',
      ClickHouse: 'orange'
    }
    return typeMap[dbType] || 'gray'
  }

  const formatDate = (dateStr: any) => {
    if (!dateStr) return '-'
    const date = new Date(dateStr)
    return date.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    })
  }

  const endpointText = useMemo(() => {
    const host = database?.host || '-'
    const port = database?.port ? `:${database.port}` : ''
    const dbName = database?.database ? `/${database.database}` : ''
    return `${host}${port}${dbName}`
  }, [database?.host, database?.port, database?.database])
  const displayTitle = headerTitle ?? database?.name ?? t('project.database.databaseDetail')
  const displaySubtitle = headerSubtitle ?? endpointText
  const displayTypeBadge = typeBadgeLabel ?? database?.db_type

  const schemaCount = useMemo(() => {
    const schemas = new Set(
      batchActionTables
        .map((table: any) => table?.schema_name)
        .filter((schema: any) => schema && schema !== 'default')
    )
    return schemas.size
  }, [batchActionTables])

  const describedTableCount = useMemo(
    () => batchActionTables.filter((table: any) => !!table?.description).length,
    [batchActionTables]
  )

  const handleTableClick = (table: any) => {
    setSelectedTable(table)
    setColumnSearchKeyword('')
  }

  const closeTablePanel = () => {
    setSelectedTable(null)
  }

  const getTableConnectionId = () => {
    return selectedTable?.database_connection_id || database.id
  }

  // 刷新当前表列数据
  const refreshSelectedTableColumns = async () => {
    if (!selectedTable || !projectId || !database?.id) return
    try {
      const res: any = await getTableColumnsReq(currentProjectId, getTableConnectionId(), selectedTable.id)
      if (res?.success) {
        setSelectedTable((prev: any) => ({ ...prev, columns: res.data?.items || [] }))
      }
    } catch (e) {
      console.error('刷新列信息失败:', e)
    }
  }

  // 编辑表
  const handleEditTable = () => {
    setEditingTable(selectedTable)
    setTableEditDialogVisible(true)
  }

  const handleAfterTableEdit = async () => {
    await refreshSelectedTableColumns()
    await loadBatchActionTables()
    if (erDiagramRef.current?.loadRelationships) {
      erDiagramRef.current.loadRelationships()
    }
  }

  // ElMessageBox.confirm → modals.openConfirmModal 包成 Promise，保持原 try/catch 流
  const confirmAsync = (options: {
    title: string
    message: string
    confirmLabel: string
    cancelLabel: string
    color?: string
  }): Promise<'confirm'> =>
    new Promise((resolve, reject) => {
      modals.openConfirmModal({
        title: options.title,
        children: options.message,
        labels: { confirm: options.confirmLabel, cancel: options.cancelLabel },
        confirmProps: { color: options.color },
        onConfirm: () => resolve('confirm'),
        onCancel: () => reject('cancel')
      })
    })

  // 切换高召回
  const handleToggleHighRecall = async () => {
    const table = selectedTable
    if (!table || !projectId || !database?.id) return
    const newStatus = !table.is_high_recall
    try {
      await confirmAsync({
        message: t('project.database.highRecallConfirmMsg', {
          action: newStatus ? t('project.database.markHighRecall') : t('project.database.cancelHighRecall'),
          name: table.table_name
        }),
        title: t('project.database.confirmAction'),
        confirmLabel: t('common.confirm'),
        cancelLabel: t('common.cancel'),
        color: newStatus ? 'blue' : 'orange'
      })
      setTogglingHighRecall(true)
      const res: any = await updateTableHighRecallReq(
        currentProjectId,
        getTableConnectionId(),
        table.id,
        newStatus
      )
      if (res.success) {
        notifications.show({ color: 'green', message: t('project.database.operationSuccess') })
        setSelectedTable({ ...table, is_high_recall: newStatus })
      } else {
        notifications.show({ color: 'red', message: res.msg || t('project.database.operationFailed') })
      }
    } catch (e) {
      if (e !== 'cancel') {
        console.error('Toggle high recall failed:', e)
        notifications.show({ color: 'red', message: t('project.database.operationFailed') })
      }
    } finally {
      setTogglingHighRecall(false)
    }
  }

  // AI 生成描述 & 向量
  const handleGenerateDescriptions = async () => {
    const table = selectedTable
    if (!table || !projectId || !database?.id) return
    const connectionId = getTableConnectionId()
    try {
      await confirmAsync({
        message: t('project.database.generateDescConfirmMsg', { name: table.table_name }),
        title: t('project.database.confirmGenerateVector'),
        confirmLabel: t('project.database.confirmGenerate'),
        cancelLabel: t('common.cancel'),
        color: 'blue'
      })
      setGeneratingDescriptions(true)
      setGenerateDescBtnState('generatingDesc')
      const descRes: any = await generateSingleTableDescriptionReq(currentProjectId, connectionId, table.id, 2)
      if (!descRes.success || !descRes.data) {
        notifications.show({ color: 'red', message: descRes.msg || t('project.database.generateDescFailed') })
        return
      }
      const { columns_generated, table_description_generated } = descRes.data
      notifications.show({
        color: 'green',
        message: t('project.database.generateDescSuccess', {
          colCount: columns_generated,
          tableUpdated: table_description_generated
            ? t('project.database.updated')
            : t('project.database.notUpdated')
        })
      })
      try {
        setGenerateDescBtnState('generatingVector')
        await Promise.all([
          storeSingleTableVectorReq(currentProjectId, connectionId, table.id),
          storeTableColumnsVectorReq(currentProjectId, connectionId, table.id)
        ])
      } catch (e) {
        console.error('Generate vector failed:', e)
        notifications.show({ color: 'yellow', message: t('project.database.vectorUpdatePartialFailed') })
      }
      await refreshSelectedTableColumns()
    } catch (e) {
      if (e !== 'cancel') {
        console.error('Generate descriptions failed:', e)
        notifications.show({ color: 'red', message: t('project.database.generateError') })
      }
    } finally {
      setGenerateDescBtnState('idle')
      setGeneratingDescriptions(false)
    }
  }

  // 获取示例值
  const handleSyncExampleValues = async () => {
    const table = selectedTable
    if (!table || !projectId || !database?.id) return
    try {
      setSyncingExampleValues(true)
      const res: any = await syncTableExampleValuesReq(currentProjectId, getTableConnectionId(), table.id)
      if (res?.success !== true) {
        notifications.show({ color: 'red', message: res?.msg || t('project.database.syncExampleValuesFailed') })
        return
      }
      notifications.show({
        color: 'green',
        message: res?.data?.message || t('project.database.syncExampleValuesSuccess', { name: table.table_name })
      })
      await refreshSelectedTableColumns()
    } catch (e) {
      console.error('Sync example values failed:', e)
      notifications.show({ color: 'red', message: t('project.database.syncExampleValuesFailed') })
    } finally {
      setSyncingExampleValues(false)
    }
  }

  // 重新生成召回向量
  const handleRegenerateVectors = async () => {
    const table = selectedTable
    if (!table || !projectId || !database?.id) return
    const connectionId = getTableConnectionId()
    try {
      setRegeneratingVectors(true)
      await Promise.all([
        storeSingleTableVectorReq(currentProjectId, connectionId, table.id),
        storeTableColumnsVectorReq(currentProjectId, connectionId, table.id)
      ])
      notifications.show({ color: 'green', message: t('database.tableStructure.regenerateVectorsSuccess') })
    } catch (e) {
      console.error('Regenerate vectors failed:', e)
      notifications.show({ color: 'red', message: t('database.tableStructure.regenerateVectorsFailed') })
    } finally {
      setRegeneratingVectors(false)
    }
  }

  // 同步完成后刷新 ER 图和表列表
  const handleSyncCompleted = () => {
    setSyncKey((k) => k + 1)
    loadBatchActionTables()
  }

  // 数据库更新
  const handleDatabaseUpdated = (updatedDatabase: any) => {
    onUpdated?.(updatedDatabase)
  }

  // 删除数据库
  const handleDelete = (db: any) => {
    onDeleted?.(db)
  }

  const metadataGraphContent = (
    <>
      <div className={styles['er-with-panel']}>
        <RelationshipERDiagram
          ref={erDiagramRef}
          databaseId={database.id}
          selectedTableId={selectedTable?.id || ''}
          key={`er-${database.id}-${syncKey}`}
          onTableClick={handleTableClick}
        />
        {selectedTable && (
          <div className={`${styles['table-detail-panel']} ${styles['slide-left-enter']}`}>
            <div className={styles['panel-header']}>
              <div className={styles['panel-title-row']}>
                <ElSvgIcon name="Grid" size={16} />
                <span className={styles['panel-title']}>{selectedTable.table_name}</span>
                {selectedTable.is_high_recall && (
                  <Badge color="orange" size="sm" variant="light">
                    {t('project.database.highRecall')}
                  </Badge>
                )}
              </div>
              <Button variant="subtle" onClick={closeTablePanel} p={4}>
                <ElSvgIcon name="Close" size={16} />
              </Button>
            </div>

            <div className={styles['panel-actions']}>
              <Button size="xs" onClick={handleEditTable} leftSection={<ElSvgIcon name="EditPen" size={14} />}>
                {t('project.database.editTable')}
              </Button>
              <Button
                size="xs"
                variant="default"
                onClick={handleToggleHighRecall}
                loading={togglingHighRecall}
                leftSection={<ElSvgIcon name="Star" size={14} />}
              >
                {selectedTable.is_high_recall
                  ? t('project.database.cancelHighRecall')
                  : t('project.database.markHighRecall')}
              </Button>
              <Button
                variant="light"
                size="xs"
                onClick={handleGenerateDescriptions}
                loading={generatingDescriptions}
                leftSection={<ElSvgIcon name="MagicStick" size={14} />}
              >
                {generateDescButtonText}
              </Button>
              <Button
                size="xs"
                variant="default"
                onClick={handleSyncExampleValues}
                loading={syncingExampleValues}
                leftSection={<ElSvgIcon name="DocumentCopy" size={14} />}
              >
                {t('project.database.getExampleValues')}
              </Button>
              <Button
                size="xs"
                variant="default"
                onClick={handleRegenerateVectors}
                loading={regeneratingVectors}
                leftSection={<ElSvgIcon name="Refresh" size={14} />}
              >
                {t('database.tableStructure.regenerateVectors')}
              </Button>
            </div>

            {selectedTable.description && (
              <div className={styles['panel-desc']}>{selectedTable.description}</div>
            )}
            {!isDefaultSchemaName(selectedTable.schema_name) && (
              <div className={styles['panel-schema']}>
                Schema: <strong>{selectedTable.schema_name}</strong>
              </div>
            )}

            <div className={styles['panel-column-header']}>
              <TextInput
                value={columnSearchKeyword}
                onChange={(e) => setColumnSearchKeyword(e.currentTarget.value)}
                placeholder={t('project.database.searchColumns')}
                leftSection={<ElSvgIcon name="Search" size={14} />}
                size="xs"
                className={styles['column-search-input']}
              />
              <span className={styles['column-count']}>
                {t('project.database.totalColumns', { count: selectedTable.columns?.length || 0 })}
              </span>
            </div>

            <div className={styles['panel-column-list']}>
              <ScrollArea style={{ height: '100%' }}>
                <Table striped highlightOnHover stickyHeader style={{ width: '100%' }}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th style={{ minWidth: 110 }}>{t('project.database.columnName')}</Table.Th>
                      <Table.Th style={{ width: 90, textAlign: 'center' }}>
                        {t('project.database.type')}
                      </Table.Th>
                      <Table.Th style={{ width: 65, textAlign: 'center' }}>
                        {t('project.database.highRecall')}
                      </Table.Th>
                      <Table.Th style={{ minWidth: 130 }}>{t('project.database.description')}</Table.Th>
                      <Table.Th style={{ width: 140, textAlign: 'center' }}>
                        {t('project.database.exampleValues')}
                      </Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {filteredColumns.map((row: any, idx: number) => (
                      <Table.Tr key={row.id || row.column_name || idx}>
                        <Table.Td>
                          <span className={styles['col-name-cell']}>
                            {row.is_primary_key ? (
                              <span className={`${styles['col-badge']} ${styles.pk}`}>PK</span>
                            ) : row.is_foreign_key ? (
                              <span className={`${styles['col-badge']} ${styles.fk}`}>FK</span>
                            ) : null}
                            {row.column_name}
                          </span>
                        </Table.Td>
                        <Table.Td style={{ textAlign: 'center' }}>{row.data_type}</Table.Td>
                        <Table.Td style={{ textAlign: 'center' }}>
                          <Badge color={row.is_high_recall ? 'green' : 'gray'} size="sm" variant="light">
                            {row.is_high_recall ? 'YES' : 'NO'}
                          </Badge>
                        </Table.Td>
                        <Table.Td>
                          <Tooltip label={row.description || '-'} multiline maw={320} disabled={!row.description}>
                            <span className={styles['col-desc']}>{row.description || '-'}</span>
                          </Tooltip>
                        </Table.Td>
                        <Table.Td style={{ textAlign: 'center' }}>
                          {row.example_values && row.example_values.length > 0 ? (
                            <Tooltip
                              color="dark"
                              position="top"
                              multiline
                              maw={360}
                              label={
                                <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                                  {formatExampleValues(row.example_values)}
                                </pre>
                              }
                            >
                              <span className={styles['example-preview']}>
                                {formatExamplePreview(row.example_values)}
                              </span>
                            </Tooltip>
                          ) : (
                            <span className={styles['col-desc']}>{t('project.apiKey.none')}</span>
                          )}
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </ScrollArea>
            </div>
          </div>
        )}
      </div>

      <TableEditDialog
        opened={tableEditDialogVisible}
        onClose={() => setTableEditDialogVisible(false)}
        table={editingTable}
        databaseId={database.id}
        onSaved={handleAfterTableEdit}
      />
    </>
  )

  return (
    <div className={styles['ad-detail-page']}>
      <div className={styles['ad-detail-page-header']}>
        <div className={styles['header-main']}>
          <Button
            variant="subtle"
            onClick={() => onBack?.()}
            p={0}
            className={styles['back-button']}
            aria-label="返回数据库列表"
          >
            <ElSvgIcon name="ArrowLeft" size={16} />
          </Button>
          <div className={styles['database-mark']}>
            <ElSvgIcon name={headerIcon} size={18} />
          </div>
          <div className={styles['title-stack']}>
            <div className={styles['title-row']}>
              <span className={styles['header-title']}>{displayTitle}</span>
              {displayTypeBadge && (
                <Badge color={getDbTypeTagColor(database?.db_type)} size="sm" variant="light">
                  {displayTypeBadge}
                </Badge>
              )}
            </div>
            <div className={styles['meta-line']}>
              <span>{displaySubtitle}</span>
              {database?.created_at && (
                <span>{t('project.database.createdAt', { date: formatDate(database?.created_at) })}</span>
              )}
            </div>
          </div>
        </div>
        <div className={styles['database-summary']}>
          <div className={styles['summary-item']}>
            <span>已缓存表</span>
            <strong>{batchActionTables.length}</strong>
          </div>
          <div className={styles['summary-item']}>
            <span>Schema</span>
            <strong>{schemaCount || '-'}</strong>
          </div>
          <div className={styles['summary-item']}>
            <span>已描述</span>
            <strong>{describedTableCount}</strong>
          </div>
        </div>
        {hasDatabaseConnection && (
          <div className={styles['header-actions']}>
            <TableBatchActions
              databaseId={database.id}
              tables={batchActionTables}
              onRefresh={handleBatchRefresh}
            />
            <Button
              size="xs"
              variant="default"
              onClick={() => setRetrievalTestVisible(true)}
              leftSection={<ElSvgIcon name="Search" size={14} />}
            >
              {t('project.database.schemaRetrievalTest')}
            </Button>
          </div>
        )}
      </div>

      <div className={styles['ad-detail-page-content']}>
        <Tabs
          value={activeTab}
          onChange={(v) => setActiveTab(v || initialTab)}
          variant="pills"
          className={styles['ad-detail-tabs-bordered']}
          keepMounted={false}
        >
          <Tabs.List>
            {beforeTabs.map((tab) => (
              <Tabs.Tab
                key={tab.value}
                value={tab.value}
                leftSection={tab.icon ? <ElSvgIcon name={tab.icon} size={14} /> : undefined}
              >
                {tab.label}
              </Tabs.Tab>
            ))}
            {/* 元数据同步 */}
            {renderMetaSyncTab && (
              <Tabs.Tab value="metaSync" leftSection={<ElSvgIcon name="Refresh" size={14} />}>
                {t('project.database.metaSync')}
              </Tabs.Tab>
            )}
            {/* 元数据增强 */}
            {renderDatabaseTabs && (
              <Tabs.Tab value="metadata" leftSection={<ElSvgIcon name="MagicStick" size={14} />}>
                {t('project.database.metadataEnhance')}
              </Tabs.Tab>
            )}
            {/* 实体配置 */}
            {renderDatabaseTabs && (
              <Tabs.Tab value="entity" leftSection={<ElSvgIcon name="Collection" size={14} />}>
                {t('project.database.entityConfig')}
              </Tabs.Tab>
            )}
            {/* 元数据查询 */}
            {renderDatabaseTabs && (
              <Tabs.Tab value="metadataQuery" leftSection={<ElSvgIcon name="Search" size={14} />}>
                {t('project.database.metadataQuery')}
              </Tabs.Tab>
            )}
            {/* 数据源设置 */}
            <Tabs.Tab value="settings" leftSection={<ElSvgIcon name={settingsTabIcon} size={14} />}>
              {settingsTabLabel ?? t('project.dataSource.settings')}
            </Tabs.Tab>
          </Tabs.List>

          {beforeTabs.map((tab) => (
            <Tabs.Panel key={tab.value} value={tab.value}>
              {tab.content}
            </Tabs.Panel>
          ))}

          {/* 元数据同步 */}
          {renderMetaSyncTab && (
            <Tabs.Panel value="metaSync">
              <div className={styles['tab-step-wrapper']}>
                <GuideStepSync
                  projectId={projectId}
                  database={database}
                  databaseId={database.id}
                  standalone
                  variant="settings"
                  onSyncCompleted={handleSyncCompleted}
                />
              </div>
            </Tabs.Panel>
          )}

          {/* 元数据增强 */}
          {renderDatabaseTabs && (
            <Tabs.Panel value="metadata">
              <div className={styles['tab-step-wrapper']}>
                <GuideStepMetadata
                  projectId={projectId}
                  database={database}
                  databaseId={database.id}
                  standalone
                  graphContent={metadataGraphContent}
                  initialBodyViewMode="er"
                />
              </div>
            </Tabs.Panel>
          )}

          {/* 实体配置 */}
          {renderDatabaseTabs && (
            <Tabs.Panel value="entity">
              <div className={styles['tab-step-wrapper']}>
                <GuideStepEntity
                  projectId={projectId}
                  database={database}
                  databaseId={database.id}
                  standalone
                />
              </div>
            </Tabs.Panel>
          )}

          {/* 元数据查询 */}
          {renderDatabaseTabs && (
            <Tabs.Panel value="metadataQuery">
              <DatabaseMetadataQuery databaseId={database.id} dbType={database.db_type} />
            </Tabs.Panel>
          )}

          {/* 数据源设置 */}
          <Tabs.Panel value="settings">
            {settingsTabContent ?? (
              <DatabaseConnectionInfo
                database={database}
                onDatabaseUpdated={handleDatabaseUpdated}
                onDelete={handleDelete}
              />
            )}
          </Tabs.Panel>
        </Tabs>
      </div>

      {/* 召回测试弹窗 */}
      {hasDatabaseConnection && (
        <TableRetrievalTestDialog
          opened={retrievalTestVisible}
          onClose={() => setRetrievalTestVisible(false)}
          databaseId={database.id}
        />
      )}
    </div>
  )
}
