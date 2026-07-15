import { useMemo, useState } from 'react'
import { Alert, Button, Checkbox, Modal, Text } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import { useTranslation } from 'react-i18next'
import {
  storeSingleTableVectorReq,
  storeTableColumnsVectorReq,
  deleteCachedTableReq,
  batchSyncTableExampleValuesReq
} from '@/api/database'
import { useProjectStore, projectGetters } from '@/store/project'
import { useResponsive } from '@/hooks/use-responsive'
import ElSvgIcon from '@/components/ElSvgIcon'
import { formatTableDisplayName } from '@/utils/tableDisplay'
import styles from './UnifiedTableBatchActions.module.scss'

interface UnifiedTableBatchActionsProps {
  // 数据库连接ID或数据源ID
  databaseId: string
  tables?: any[]
  // 是否为结构化数据源
  isStructuredDataSource?: boolean
  onRefresh?: () => void
  onOpenRetrievalTest?: () => void
  onLoadColumns?: (tableId?: any) => void | Promise<void>
}

export default function UnifiedTableBatchActions({
  databaseId,
  tables = [],
  isStructuredDataSource = false,
  onRefresh,
  onOpenRetrievalTest,
  onLoadColumns
}: UnifiedTableBatchActionsProps) {
  const { t } = useTranslation()

  const currentProjectId = useProjectStore(projectGetters.currentProjectId)
  const { isMobile } = useResponsive()
  const batchDeleteDialogWidth = useMemo(
    () => (isMobile ? 'calc(100vw - 24px)' : '60%'),
    [isMobile]
  )

  // 加载状态
  const [storingVectors, setStoringVectors] = useState(false)
  const [storingColumnsVectors, setStoringColumnsVectors] = useState(false)
  const [batchPreviewLoading, setBatchPreviewLoading] = useState(false)
  const [batchDeleteDialogVisible, setBatchDeleteDialogVisible] = useState(false)
  const [deletingTables, setDeletingTables] = useState(false)
  const [selectedTableIds, setSelectedTableIds] = useState<any[]>([])

  // 计算属性
  const canTestRetrieval = useMemo(() => tables.length > 0, [tables])
  const canStoreVectors = useMemo(() => tables.length > 0, [tables])
  const canStoreColumnsVectors = useMemo(() => tables.length > 0, [tables])
  const canBatchPreview = useMemo(() => tables.length > 0, [tables])

  // 获取表显示名称（处理默认 schema 的情况）
  const getTableDisplayName = (table: any) => formatTableDisplayName(table)

  // 获取表的 database_connection_id
  const getTableConnectionId = (table: any) => {
    // 如果是结构化数据源，使用表的 database_connection_id
    if (isStructuredDataSource && table.database_connection_id) {
      return table.database_connection_id
    }
    // 否则使用传入的 databaseId
    return databaseId
  }

  // 批量删除表
  const handleBatchDeleteTables = () => {
    if (!databaseId) {
      notifications.show({ color: 'yellow', message: t('structuredData.pleaseSelectDataSource') })
      return
    }

    if (!tables || tables.length === 0) {
      notifications.show({ color: 'yellow', message: t('structuredData.noTableData') })
      return
    }

    setSelectedTableIds([])
    setBatchDeleteDialogVisible(true)
  }

  const confirmBatchDelete = async () => {
    if (selectedTableIds.length === 0) {
      notifications.show({ color: 'yellow', message: t('structuredData.pleaseSelectAtLeastOneTable') })
      return
    }

    modals.openConfirmModal({
      title: t('structuredData.deleteConfirmTitle'),
      children: (
        <Text size="sm">
          {t('structuredData.confirmDeleteSelected', { count: selectedTableIds.length })}
        </Text>
      ),
      labels: { confirm: t('structuredData.confirmDelete'), cancel: t('structuredData.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          setDeletingTables(true)
          let successCount = 0
          let failCount = 0

          for (const tableId of selectedTableIds) {
            try {
              const table = tables.find((tb) => tb.id === tableId)
              if (!table) {
                failCount++
                continue
              }

              const connectionId = getTableConnectionId(table)
              const res: any = await deleteCachedTableReq(
                currentProjectId,
                connectionId,
                tableId
              )
              if (res.success) {
                successCount++
                console.log(`表 ${getTableDisplayName(table)} 删除成功`)
              } else {
                failCount++
              }
            } catch (error) {
              failCount++
              console.error('删除表失败:', error)
            }
          }

          setBatchDeleteDialogVisible(false)
          setSelectedTableIds([])

          if (failCount === 0) {
            notifications.show({
              color: 'green',
              message: t('structuredData.deleteSuccessCount', { count: successCount })
            })
          } else {
            notifications.show({
              color: 'yellow',
              message: t('structuredData.deletePartialResult', { success: successCount, fail: failCount })
            })
          }

          onRefresh?.()
        } catch (error) {
          console.error('批量删除表失败:', error)
          notifications.show({ color: 'red', message: t('structuredData.batchDeleteFailed') })
        } finally {
          setDeletingTables(false)
        }
      }
    })
  }

  const cancelBatchDelete = () => {
    setBatchDeleteDialogVisible(false)
    setSelectedTableIds([])
  }

  const selectAllTables = () => {
    setSelectedTableIds(tables.map((table) => table.id))
  }

  // 批量生成表召回向量
  const handleStoreTableVectors = async () => {
    if (!tables || tables.length === 0) {
      notifications.show({ color: 'yellow', message: t('structuredData.noTableData') })
      return
    }

    modals.openConfirmModal({
      title: t('structuredData.confirmBatchGenerateTableVectorsTitle'),
      children: (
        <Text size="sm">{t('structuredData.confirmBatchGenerateVectors', { count: tables.length })}</Text>
      ),
      labels: { confirm: t('structuredData.confirmGenerate'), cancel: t('structuredData.cancel') },
      onConfirm: async () => {
        try {
          setStoringVectors(true)
          notifications.show({
            color: 'blue',
            message: t('structuredData.startBatchGenerateVectors', { count: tables.length })
          })

          let successCount = 0
          let failCount = 0

          for (const table of tables) {
            try {
              const connectionId = getTableConnectionId(table)
              const res: any = await storeSingleTableVectorReq(
                currentProjectId,
                connectionId,
                table.id
              )

              if (res?.success !== false) {
                successCount++
              } else {
                failCount++
              }
            } catch (error) {
              failCount++
              console.error(`为表 ${getTableDisplayName(table)} 生成召回向量失败:`, error)
            }
          }

          if (failCount === 0) {
            notifications.show({
              color: 'green',
              message: t('structuredData.batchGenerateTableVectorsComplete', { count: successCount })
            })
          } else {
            notifications.show({
              color: 'yellow',
              message: t('structuredData.batchGenerateResult', { success: successCount, fail: failCount })
            })
          }

          onRefresh?.()
        } catch (error) {
          console.error('批量生成表召回向量失败:', error)
          notifications.show({ color: 'red', message: t('structuredData.batchGenerateTableVectorsFailed') })
        } finally {
          setStoringVectors(false)
        }
      }
    })
  }

  // 批量生成列召回向量
  const handleStoreColumnsVectors = async () => {
    if (!tables || tables.length === 0) {
      notifications.show({ color: 'yellow', message: t('structuredData.noTableData') })
      return
    }

    modals.openConfirmModal({
      title: t('structuredData.confirmBatchGenerateColumnVectorsTitle'),
      children: (
        <Text size="sm">
          {t('structuredData.confirmBatchGenerateColumnVectors', { count: tables.length })}
        </Text>
      ),
      labels: { confirm: t('structuredData.confirmGenerate'), cancel: t('structuredData.cancel') },
      onConfirm: async () => {
        try {
          setStoringColumnsVectors(true)
          notifications.show({
            color: 'blue',
            message: t('structuredData.startBatchGenerateColumnVectorsPlease', { count: tables.length })
          })

          let successCount = 0
          let failCount = 0

          for (const table of tables) {
            try {
              const connectionId = getTableConnectionId(table)
              const res: any = await storeTableColumnsVectorReq(
                currentProjectId,
                connectionId,
                table.id
              )

              if (res?.success !== false) {
                successCount++
              } else {
                failCount++
              }
            } catch (error) {
              failCount++
              console.error(`为表 ${getTableDisplayName(table)} 的列生成召回向量失败:`, error)
            }
          }

          if (failCount === 0) {
            notifications.show({
              color: 'green',
              message: t('structuredData.batchGenerateColumnVectorsComplete', { count: successCount })
            })
          } else {
            notifications.show({
              color: 'yellow',
              message: t('structuredData.batchGenerateResult', { success: successCount, fail: failCount })
            })
          }

          onRefresh?.()
        } catch (error) {
          console.error('批量生成列召回向量失败:', error)
          notifications.show({ color: 'red', message: t('structuredData.batchGenerateColumnVectorsFailed') })
        } finally {
          setStoringColumnsVectors(false)
        }
      }
    })
  }

  // 批量获取示例数据
  const handleBatchPreviewTableData = async () => {
    if (!tables || tables.length === 0) {
      notifications.show({ color: 'yellow', message: t('structuredData.noTableData') })
      return
    }

    modals.openConfirmModal({
      title: t('structuredData.confirmBatchGetExampleDataTitle'),
      children: (
        <Text size="sm">{t('structuredData.confirmBatchGetExampleData', { count: tables.length })}</Text>
      ),
      labels: { confirm: t('structuredData.confirmGet'), cancel: t('structuredData.cancel') },
      onConfirm: async () => {
        try {
          setBatchPreviewLoading(true)
          notifications.show({
            color: 'blue',
            message: t('structuredData.startGetExampleData', { count: tables.length })
          })

          // 收集所有表的 connectionId 和 tableId
          const tableGroups = new Map<any, any[]>()
          for (const table of tables) {
            const connectionId = getTableConnectionId(table)
            if (!tableGroups.has(connectionId)) {
              tableGroups.set(connectionId, [])
            }
            tableGroups.get(connectionId)!.push(table.id)
          }

          let totalSuccess = 0
          let totalFail = 0

          // 按 connectionId 分组批量获取
          for (const [connectionId, tableIds] of tableGroups.entries()) {
            try {
              const res: any = await batchSyncTableExampleValuesReq(
                currentProjectId,
                connectionId,
                tableIds,
                2 // limit: 每列获取2个示例值
              )

              if (res.success && res.data) {
                const { success_count, fail_count } = res.data
                totalSuccess += success_count
                totalFail += fail_count
              } else {
                totalFail += tableIds.length
              }
            } catch (error) {
              totalFail += tableIds.length
              console.error(`获取连接 ${connectionId} 的示例数据失败:`, error)
            }
          }

          if (totalFail === 0) {
            notifications.show({
              color: 'green',
              message: t('structuredData.exampleDataSuccess', { success: totalSuccess, total: totalSuccess })
            })
          } else {
            notifications.show({
              color: 'yellow',
              message: t('structuredData.deletePartialResult', { success: totalSuccess, fail: totalFail })
            })
          }

          onRefresh?.()
          onLoadColumns?.()
        } catch (error) {
          console.error('批量获取示例数据失败:', error)
          notifications.show({ color: 'red', message: t('structuredData.batchGetExampleDataFailed') })
        } finally {
          setBatchPreviewLoading(false)
        }
      }
    })
  }

  // 测试召回
  const handleTestRetrieval = () => {
    onOpenRetrievalTest?.()
  }

  return (
    <>
      <div className={`${styles.actionGroup} ${styles.rightActions}`}>
        {/* 测试召回 */}
        <Button
          size="xs"
          onClick={() => handleTestRetrieval()}
          disabled={!canTestRetrieval}
          className={styles.batchActionBtn}
          leftSection={<ElSvgIcon name="Search" />}
        >
          {t('structuredData.testRetrieval')}
        </Button>

        {/* 批量删除表（仅结构化数据源显示） */}
        {false && (
          <Button
            variant="default"
            size="xs"
            onClick={() => handleBatchDeleteTables()}
            disabled={tables.length === 0}
            className={styles.batchActionBtn}
            leftSection={<ElSvgIcon name="Delete" />}
          >
            {t('structuredData.batchDeleteTables')}
          </Button>
        )}

        {/* 批量生成表召回向量（仅结构化数据源显示） */}
        {false && (
          <Button
            variant="default"
            size="xs"
            onClick={() => handleStoreTableVectors()}
            disabled={!canStoreVectors}
            loading={storingVectors}
            className={styles.batchActionBtn}
            leftSection={<ElSvgIcon name="Box" />}
          >
            {t('structuredData.batchGenerateTableVectors')}
          </Button>
        )}

        {/* 批量生成列召回向量（仅结构化数据源显示） */}
        {false && (
          <Button
            variant="default"
            size="xs"
            onClick={() => handleStoreColumnsVectors()}
            disabled={!canStoreColumnsVectors}
            loading={storingColumnsVectors}
            className={styles.batchActionBtn}
            leftSection={<ElSvgIcon name="Box" />}
          >
            {t('structuredData.batchGenerateColumnVectors')}
          </Button>
        )}

        {/* 批量获取示例数据（仅结构化数据源显示） */}
        {false && (
          <Button
            variant="default"
            size="xs"
            onClick={() => handleBatchPreviewTableData()}
            disabled={!canBatchPreview}
            loading={batchPreviewLoading}
            className={styles.batchActionBtn}
            leftSection={<ElSvgIcon name="View" />}
          >
            {t('structuredData.batchGetExampleData')}
          </Button>
        )}
      </div>

      {/* 批量删除表对话框 */}
      <Modal
        opened={batchDeleteDialogVisible}
        onClose={cancelBatchDelete}
        title={t('structuredData.batchDeleteTables')}
        size={batchDeleteDialogWidth}
        closeOnClickOutside={false}
        className={styles.batchDeleteDialog}
      >
        <div className={styles.batchDeleteContent}>
          <Alert color="yellow" withCloseButton={false} style={{ marginBottom: 16 }}>
            {t('structuredData.deleteWarning')}
          </Alert>
          <div className={styles.tableSelection}>
            <div className={styles.selectionHeader}>
              <span>{t('structuredData.selectTablesToDelete', { count: tables.length })}</span>
              <Button
                size="xs"
                variant="light"
                onClick={selectAllTables}
                className={styles.selectAllBtn}
              >
                {t('structuredData.selectAll')}
              </Button>
            </div>
            <Checkbox.Group value={selectedTableIds} onChange={setSelectedTableIds}>
              <div className={styles.tableCheckboxGroup}>
                {tables.map((table) => (
                  <Checkbox
                    key={table.id}
                    value={table.id}
                    label={getTableDisplayName(table)}
                    className={styles.tableCheckbox}
                  />
                ))}
              </div>
            </Checkbox.Group>
          </div>
        </div>
        <div className={styles.dialogFooter}>
          <Button variant="default" onClick={cancelBatchDelete}>
            {t('structuredData.cancel')}
          </Button>
          <Button
            color="red"
            onClick={confirmBatchDelete}
            loading={deletingTables}
            disabled={selectedTableIds.length === 0}
          >
            {t('structuredData.deleteSelectedTables', { count: selectedTableIds.length })}
          </Button>
        </div>
      </Modal>
    </>
  )
}
