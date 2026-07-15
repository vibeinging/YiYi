import { useMemo, useState } from 'react'
import { Alert, Button, Checkbox, Modal, Text } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import { useTranslation } from 'react-i18next'
import {
  generateSingleTableDescriptionReq,
  storeSingleTableVectorReq,
  storeTableColumnsVectorReq,
  deleteCachedTableReq,
  batchSyncTableExampleValuesReq
} from '@/api/database'
import { useProjectStore, projectGetters } from '@/store/project'
import { useResponsive } from '@/hooks/use-responsive'
import ElSvgIcon from '@/components/ElSvgIcon'
import styles from './StructuredTableBatchActions.module.scss'

interface StructuredTableBatchActionsProps {
  dataSourceId: string
  tables?: any[]
  onRefresh?: () => void
  onLoadColumns?: (tableId: any) => void
  onTestRetrieval?: () => void
}

export default function StructuredTableBatchActions({
  dataSourceId,
  tables = [],
  onRefresh,
  onLoadColumns,
  onTestRetrieval
}: StructuredTableBatchActionsProps) {
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
  // generatingDescriptions 仅在已隐藏的批量生成描述逻辑中使用
  const [, setGeneratingDescriptions] = useState(false)

  // 计算属性
  const canStoreVectors = useMemo(() => tables.length > 0, [tables])
  const canStoreColumnsVectors = useMemo(() => tables.length > 0, [tables])
  const canBatchPreview = useMemo(() => tables.length > 0, [tables])

  // 批量删除表
  const handleBatchDeleteTables = () => {
    if (!dataSourceId) {
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
              if (!table?.database_connection_id) {
                failCount++
                continue
              }
              const res: any = await deleteCachedTableReq(
                currentProjectId,
                table.database_connection_id,
                tableId
              )
              if (res.success) {
                successCount++
                console.log(`表 ${table?.table_name} 删除成功`)
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

  // 批量生成表描述
  const handleGenerateTableDescriptions = async () => {
    console.log('handleGenerateTableDescriptions 被调用')
    if (!dataSourceId) {
      notifications.show({ color: 'yellow', message: t('structuredData.pleaseSelectDataSource') })
      return
    }

    if (!tables || tables.length === 0) {
      notifications.show({ color: 'yellow', message: t('structuredData.noTableData') })
      return
    }

    modals.openConfirmModal({
      title: t('structuredData.confirmBatchGenerate'),
      children: (
        <Text size="sm">{t('structuredData.confirmBatchGenerateDesc', { count: tables.length })}</Text>
      ),
      labels: { confirm: t('structuredData.confirmGenerate'), cancel: t('structuredData.cancel') },
      onConfirm: async () => {
        console.log('开始逐个调用 generateTableDescriptionReq API')

        setGeneratingDescriptions(true)

        try {
          let successCount = 0
          let failCount = 0
          const totalTables = tables.length

          notifications.show({
            color: 'blue',
            message: t('structuredData.startBatchGenerateDesc', { count: totalTables })
          })

          // 逐个调用单个生成API
          for (let i = 0; i < tables.length; i++) {
            const table = tables[i]
            try {
              console.log(`正在为表 ${table.table_name} (${i + 1}/${totalTables}) 生成描述...`)

              const res: any = await generateSingleTableDescriptionReq(
                currentProjectId,
                table.database_connection_id,
                table.id,
                2 // limitExamples
              )

              if (res.success) {
                successCount++
                console.log(`表 ${table.table_name} 描述生成成功`)

                // 延迟刷新当前表的列信息
                setTimeout(() => {
                  onLoadColumns?.(table.id)
                }, 1500) // 1.5秒后刷新单个表
              } else {
                failCount++
                console.warn(`表 ${table.table_name} 描述生成失败: ${res.msg || '未知错误'}`)
              }
            } catch (error) {
              failCount++
              console.error(`表 ${table.table_name} 描述生成失败:`, error)
            }

            // 添加短暂延迟，避免API调用过于频繁
            if (i < tables.length - 1) {
              await new Promise((resolve) => setTimeout(resolve, 1000)) // 间隔1秒
            }
          }

          // 批量操作完成后刷新所有表结构
          setTimeout(() => {
            onRefresh?.()
            notifications.show({ color: 'blue', message: t('structuredData.tableDescUpdated') })
          }, 2000)

          notifications.show({
            color: 'green',
            message: t('structuredData.batchGenerateResult', { success: successCount, fail: failCount })
          })
        } catch (error) {
          console.error('生成表描述失败:', error)
          notifications.show({ color: 'red', message: t('structuredData.generateDescFailed') })
        } finally {
          setGeneratingDescriptions(false)
        }
      }
    })
  }

  // 存储表向量（内部实现）
  const handleStoreTableVectorsInternal = async () => {
    console.log('handleStoreTableVectorsInternal 被调用')
    if (!dataSourceId) {
      notifications.show({ color: 'yellow', message: t('structuredData.pleaseSelectDataSource') })
      return
    }

    if (!tables || tables.length === 0) {
      notifications.show({ color: 'yellow', message: t('structuredData.noTableData') })
      return
    }

    try {
      let successCount = 0
      let failCount = 0
      const totalTables = tables.length

      notifications.show({
        color: 'blue',
        message: t('structuredData.startBatchGenerateVectors', { count: totalTables })
      })

      // 逐个调用单个生成API
      for (let i = 0; i < tables.length; i++) {
        const table = tables[i]
        try {
          console.log(`正在为表 ${table.table_name} (${i + 1}/${totalTables}) 生成召回向量...`)

          const res: any = await storeSingleTableVectorReq(
            currentProjectId,
            table.database_connection_id,
            table.id
          )

          if (res.success) {
            successCount++
            console.log(`表 ${table.table_name} 召回向量生成成功`)
          } else {
            failCount++
            console.warn(`表 ${table.table_name} 召回向量生成失败: ${res.msg || '未知错误'}`)
          }
        } catch (error) {
          failCount++
          console.error(`表 ${table.table_name} 召回向量生成失败:`, error)
        }

        // 添加短暂延迟，避免API调用过于频繁
        if (i < tables.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000)) // 间隔1秒
        }
      }

      notifications.show({
        color: 'green',
        message: t('structuredData.batchGenerateResult', { success: successCount, fail: failCount })
      })
    } catch (error) {
      console.error('存储表向量失败:', error)
      notifications.show({ color: 'red', message: t('structuredData.storeTableVectorsFailed') })
    }
  }

  const handleStoreTableVectors = async () => {
    console.log('handleStoreTableVectors 被调用')
    if (!dataSourceId) {
      notifications.show({ color: 'yellow', message: t('structuredData.pleaseSelectDataSource') })
      return
    }

    if (!tables || tables.length === 0) {
      notifications.show({ color: 'yellow', message: t('structuredData.noTableData') })
      return
    }

    modals.openConfirmModal({
      title: t('structuredData.confirmBatchGenerate'),
      children: (
        <Text size="sm">{t('structuredData.confirmBatchGenerateVectors', { count: tables.length })}</Text>
      ),
      labels: { confirm: t('structuredData.confirmGenerate'), cancel: t('structuredData.cancel') },
      onConfirm: async () => {
        console.log('开始逐个调用 storeTableVectorReq API')

        setStoringVectors(true)

        try {
          // 显示任务开始提示
          notifications.show({
            color: 'blue',
            message: t('structuredData.startBatchGenerateVectorsPlease', { count: tables.length })
          })

          await handleStoreTableVectorsInternal()
        } finally {
          setStoringVectors(false)
        }
      }
    })
  }

  // 批量存储列向量（内部实现）
  const handleStoreColumnsVectorsInternal = async () => {
    console.log('handleStoreColumnsVectorsInternal 被调用')
    if (!dataSourceId) {
      notifications.show({ color: 'yellow', message: t('structuredData.pleaseSelectDataSource') })
      return
    }

    if (!tables || tables.length === 0) {
      notifications.show({ color: 'yellow', message: t('structuredData.noTableData') })
      return
    }

    try {
      let successCount = 0
      let failCount = 0
      const totalTables = tables.length

      notifications.show({
        color: 'blue',
        message: t('structuredData.startBatchGenerateColumnVectors', { count: totalTables })
      })

      // 逐个调用单个生成API
      for (let i = 0; i < tables.length; i++) {
        const table = tables[i]
        try {
          console.log(`正在为表 ${table.table_name} (${i + 1}/${totalTables}) 生成列召回向量...`)

          const res: any = await storeTableColumnsVectorReq(
            currentProjectId,
            table.database_connection_id,
            table.id
          )

          if (res.success) {
            successCount++
            console.log(`表 ${table.table_name} 列召回向量生成成功`)
          } else {
            failCount++
            console.warn(`表 ${table.table_name} 列召回向量生成失败: ${res.msg || '未知错误'}`)
          }
        } catch (error) {
          failCount++
          console.error(`表 ${table.table_name} 列召回向量生成失败:`, error)
        }

        // 添加短暂延迟，避免API调用过于频繁
        if (i < tables.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000)) // 间隔1秒
        }
      }

      notifications.show({
        color: 'green',
        message: t('structuredData.batchGenerateResult', { success: successCount, fail: failCount })
      })
    } catch (error) {
      console.error('批量存储列向量失败:', error)
      notifications.show({ color: 'red', message: t('structuredData.storeColumnVectorsFailed') })
    }
  }

  const handleStoreColumnsVectors = async () => {
    console.log('handleStoreColumnsVectors 被调用')
    if (!dataSourceId) {
      notifications.show({ color: 'yellow', message: t('structuredData.pleaseSelectDataSource') })
      return
    }

    if (!tables || tables.length === 0) {
      notifications.show({ color: 'yellow', message: t('structuredData.noTableData') })
      return
    }

    modals.openConfirmModal({
      title: t('structuredData.confirmBatchGenerate'),
      children: (
        <Text size="sm">
          {t('structuredData.confirmBatchGenerateColumnVectors', { count: tables.length })}
        </Text>
      ),
      labels: { confirm: t('structuredData.confirmGenerate'), cancel: t('structuredData.cancel') },
      onConfirm: async () => {
        console.log('开始逐个调用 storeTableColumnsVectorReq API')

        setStoringColumnsVectors(true)

        try {
          // 显示任务开始提示
          notifications.show({
            color: 'blue',
            message: t('structuredData.startBatchGenerateColumnVectorsPlease', { count: tables.length })
          })

          await handleStoreColumnsVectorsInternal()
        } finally {
          setStoringColumnsVectors(false)
        }
      }
    })
  }

  const handleBatchPreviewTableData = async () => {
    if (!dataSourceId) {
      notifications.show({ color: 'yellow', message: t('structuredData.pleaseSelectDataSource') })
      return
    }

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
        await handleBatchPreviewTableDataInternal()
      }
    })
  }

  // 批量预览表数据（内部实现）
  const handleBatchPreviewTableDataInternal = async () => {
    if (!dataSourceId) {
      notifications.show({ color: 'yellow', message: t('structuredData.pleaseSelectDataSource') })
      return
    }

    if (!tables || tables.length === 0) {
      notifications.show({ color: 'yellow', message: t('structuredData.noTableData') })
      return
    }

    try {
      setBatchPreviewLoading(true)
      notifications.show({
        color: 'blue',
        message: t('structuredData.startGetExampleData', { count: tables.length })
      })

      // 使用批量接口获取示例值
      // 注意：需要从第一个表获取 database_connection_id，所有表应该属于同一个数据源
      if (!tables || tables.length === 0) {
        notifications.show({ color: 'yellow', message: t('structuredData.noTableData') })
        return
      }

      const firstTable = tables[0]
      if (!firstTable?.database_connection_id) {
        notifications.show({ color: 'red', message: t('structuredData.missingConnectionId') })
        return
      }

      const tableIds = tables.map((table) => table.id)
      const res: any = await batchSyncTableExampleValuesReq(
        currentProjectId,
        firstTable.database_connection_id,
        tableIds,
        2 // limit: 每列获取2个示例值
      )

      if (res.success && res.data) {
        const { success_count, fail_count, total, results } = res.data

        // 显示详细结果
        if (fail_count > 0) {
          const failedTables = results
            .filter((r: any) => !r.success)
            .map((r: any) => r.table_name)
            .join('、')
          notifications.show({
            color: 'yellow',
            message: t('structuredData.exampleDataPartialResult', {
              success: success_count,
              fail: fail_count,
              tables: failedTables
            })
          })
        } else {
          notifications.show({
            color: 'green',
            message: t('structuredData.exampleDataSuccess', { success: success_count, total: total })
          })
        }
      } else {
        notifications.show({ color: 'red', message: t('structuredData.batchGetExampleDataFailed') })
      }

      // 刷新数据
      onRefresh?.()
    } catch (error: any) {
      console.error('批量预览表数据失败:', error)
      notifications.show({
        color: 'red',
        message: t('structuredData.getExampleDataError', { msg: error?.message || '' })
      })
    } finally {
      setBatchPreviewLoading(false)
    }
  }

  // 测试召回
  const handleTestRetrieval = () => {
    onTestRetrieval?.()
  }

  return (
    <>
      <div className={`${styles.actionGroup} ${styles.rightActions}`}>
        {/* v-if="false"：批量删除表(已隐藏) */}
        {false && (
          <Button
            variant="default"
            onClick={() => handleBatchDeleteTables()}
            disabled={tables.length === 0}
            className={styles.batchActionBtn}
            leftSection={<ElSvgIcon name="Delete" />}
          >
            {t('structuredData.batchDeleteTables')}
          </Button>
        )}
        {/* v-if="false"：批量生成表召回向量(已隐藏) */}
        {false && (
          <Button
            variant="default"
            onClick={() => handleStoreTableVectors()}
            disabled={!canStoreVectors}
            loading={storingVectors}
            className={styles.batchActionBtn}
            leftSection={<ElSvgIcon name="Box" />}
          >
            {t('structuredData.batchGenerateTableVectors')}
          </Button>
        )}
        {/* v-if="false"：批量生成列召回向量(已隐藏) */}
        {false && (
          <Button
            variant="default"
            onClick={() => handleStoreColumnsVectors()}
            disabled={!canStoreColumnsVectors}
            loading={storingColumnsVectors}
            className={styles.batchActionBtn}
            leftSection={<ElSvgIcon name="Box" />}
          >
            {t('structuredData.batchGenerateColumnVectors')}
          </Button>
        )}
        {/* v-if="false"：批量获取示例数据(已隐藏) */}
        {false && (
          <Button
            variant="default"
            onClick={() => handleBatchPreviewTableData()}
            disabled={!canBatchPreview}
            loading={batchPreviewLoading}
            className={styles.batchActionBtn}
            leftSection={<ElSvgIcon name="View" />}
          >
            {t('structuredData.batchGetExampleData')}
          </Button>
        )}
        <Button
          variant="default"
          onClick={() => handleTestRetrieval()}
          className={styles.batchActionBtn}
          leftSection={<ElSvgIcon name="Search" />}
        >
          {t('structuredData.testRetrieval')}
        </Button>
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
            </div>
            <Checkbox.Group value={selectedTableIds} onChange={setSelectedTableIds}>
              <div className={styles.tableCheckboxGroup}>
                {tables.map((table) => (
                  <Checkbox
                    key={table.id}
                    value={table.id}
                    label={table.table_name}
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
