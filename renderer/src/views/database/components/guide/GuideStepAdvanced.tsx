import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Modal, Progress } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'

import ElSvgIcon from '@/components/ElSvgIcon'
import {
  getCachedTablesReq,
  storeSingleTableVectorReq,
  storeTableColumnsVectorReq,
  getSyncPendingReq,
  clearSyncPendingReq,
  getRelationshipsReq,
} from '@/api/database'
import RelationshipERDiagram from '@/views/database/components/RelationshipERDiagram'
import AdvancedEntitySection, {
  type AdvancedEntitySectionHandle,
} from './advanced/AdvancedEntitySection'
import { useProjectStore, projectGetters } from '@/store/project'

import styles from './GuideStepAdvanced.module.scss'

// RelationshipERDiagram 仍是 stub(无 props 类型)；迁移完成后会被替换为接收 databaseId/key 的实现。
// 这里用 any 旁路 stub 的空 props 类型，避免类型阻塞。
const ERDiagram = RelationshipERDiagram as unknown as (props: any) => JSX.Element

export interface GuideStepAdvancedProps {
  projectId: string
  database?: any
  databaseId?: string | null
  // defineEmits(['prev', 'finish'])
  onPrev?: () => void
  onFinish?: () => void
}

function normalizeSyncPendingInfo(data: any) {
  if (!data) return null
  const tableKeys = Array.isArray(data.table_keys) ? data.table_keys : []
  const tableIds = Array.isArray(data.table_ids) ? data.table_ids : []
  if (data.pending === false && !data.is_full_sync && tableKeys.length === 0 && tableIds.length === 0) {
    return null
  }
  return data
}

function getTableColumnCount(table: any) {
  return Number(table?.column_count || 0)
}

function getTableColumnVectorCount(table: any) {
  return Number(table?.columns_with_vectors || 0)
}

function countColumns(list: any[]) {
  return list.reduce((sum, table) => sum + getTableColumnCount(table), 0)
}

function countTableVectors(list: any[]) {
  return list.filter((table) => !!table.has_embedding).length
}

function countColumnVectors(list: any[]) {
  return list.reduce((sum, table) => sum + getTableColumnVectorCount(table), 0)
}

function tableNeedsColumnVectors(table: any) {
  return getTableColumnCount(table) > getTableColumnVectorCount(table)
}

export default function GuideStepAdvanced({
  databaseId = null,
  onPrev,
  onFinish,
}: GuideStepAdvancedProps) {
  const { t } = useTranslation()
  const currentProjectId = useProjectStore(projectGetters.currentProjectId)

  // Refs
  const entitySectionRef = useRef<AdvancedEntitySectionHandle | null>(null)

  // State (ref()/reactive() → useState)
  const [entityConfigCount, setEntityConfigCount] = useState(0)
  const [tables, setTables] = useState<any[]>([])
  const [syncPendingInfo, setSyncPendingInfo] = useState<any>(null)
  const [showRelationshipDialog, setShowRelationshipDialog] = useState(false)
  const [relationshipCount, setRelationshipCount] = useState(0)
  const [configuringAll, setConfiguringAll] = useState(false)
  const [generatingTableVectors, setGeneratingTableVectors] = useState(false)
  const [generatingColumnVectors, setGeneratingColumnVectors] = useState(false)
  const [entitySuggesting, setEntitySuggesting] = useState(false)

  const generatingVectors = generatingTableVectors || generatingColumnVectors

  // 向量进度：API 读取的已有状态
  const [apiTablesWithVectors, setApiTablesWithVectors] = useState(0)
  const [apiColumnsWithVectors, setApiColumnsWithVectors] = useState(0)

  // 向量进度：当前生成过程的实时计数器
  const [genTableVectorCount, setGenTableVectorCount] = useState(0)
  const [genColumnVectorCount, setGenColumnVectorCount] = useState(0)
  const [genTableVectorTotal, setGenTableVectorTotal] = useState(0)
  const [genColumnVectorTotal, setGenColumnVectorTotal] = useState(0)

  // 对外暴露的进度值：生成中用计数器，否则用 API 状态
  const tablesWithVectors = generatingTableVectors ? genTableVectorCount : apiTablesWithVectors
  const columnsWithVectors = generatingColumnVectors ? genColumnVectorCount : apiColumnsWithVectors

  // Computed
  const pendingTables = useMemo(() => {
    if (!syncPendingInfo) return tables
    if (syncPendingInfo.is_full_sync) return tables
    const tableKeys = syncPendingInfo.table_keys || []
    const tableIds = syncPendingInfo.table_ids || []
    if (tableKeys.length > 0) {
      return tables.filter((table: any) => {
        const tableKey = table.schema_name ? `${table.schema_name}.${table.table_name}` : table.table_name
        return tableKeys.includes(tableKey)
      })
    }
    if (tableIds.length > 0) return tables.filter((table: any) => tableIds.includes(table.id))
    return tables
  }, [syncPendingInfo, tables])

  const pendingTablesCount = useMemo(() => {
    if (generatingTableVectors && genTableVectorTotal > 0) return genTableVectorTotal
    return pendingTables.length
  }, [generatingTableVectors, genTableVectorTotal, pendingTables])

  const pendingColumnsCount = useMemo(() => {
    if (generatingColumnVectors && genColumnVectorTotal > 0) return genColumnVectorTotal
    return countColumns(pendingTables)
  }, [generatingColumnVectors, genColumnVectorTotal, pendingTables])

  const tableVectorCompleted = useMemo(() => {
    const target = pendingTablesCount
    return tablesWithVectors >= target && target > 0
  }, [pendingTablesCount, tablesWithVectors])

  const columnVectorCompleted = useMemo(() => {
    const target = pendingColumnsCount
    return columnsWithVectors >= target && target > 0
  }, [pendingColumnsCount, columnsWithVectors])

  const tableVectorProgressPercentage = useMemo(() => {
    const target = pendingTablesCount
    if (target === 0) return 0
    return Math.min(100, Math.round((tablesWithVectors / target) * 100))
  }, [pendingTablesCount, tablesWithVectors])

  const columnVectorProgressPercentage = useMemo(() => {
    const target = pendingColumnsCount
    if (target === 0) return 0
    return Math.min(100, Math.round((columnsWithVectors / target) * 100))
  }, [pendingColumnsCount, columnsWithVectors])

  const allVectorsCompleted = tableVectorCompleted && columnVectorCompleted

  // Data loading
  const loadSyncPendingInfo = useCallback(async () => {
    if (!databaseId) return
    try {
      const res: any = await getSyncPendingReq(currentProjectId, databaseId)
      setSyncPendingInfo(res.success && res.data ? normalizeSyncPendingInfo(res.data) : null)
    } catch (error) {
      console.error('加载 Redis 同步表信息失败:', error)
      setSyncPendingInfo(null)
    }
  }, [currentProjectId, databaseId])

  // 注意：loadTables 内部引用了最新的 syncPendingInfo；用 ref 镜像避免闭包过期
  const syncPendingInfoRef = useRef<any>(null)
  syncPendingInfoRef.current = syncPendingInfo

  const loadTables = useCallback(async () => {
    if (!databaseId) return
    try {
      const res: any = await getCachedTablesReq(currentProjectId, databaseId)
      if (res.success && res.data) {
        const tableList = res.data.items || res.data || []
        setTables(tableList)

        const sp = syncPendingInfoRef.current
        let tablesToCount = tableList
        if (sp && !sp.is_full_sync) {
          if (sp.table_keys && sp.table_keys.length > 0) {
            tablesToCount = tableList.filter((table: any) => {
              const tableKey = table.schema_name
                ? `${table.schema_name}.${table.table_name}`
                : table.table_name
              return sp.table_keys.includes(tableKey)
            })
          } else if (sp.table_ids && sp.table_ids.length > 0) {
            tablesToCount = tableList.filter((table: any) => sp.table_ids.includes(table.id))
          }
        }

        let tablesWithVec = 0
        let colsWithVec = 0
        for (const table of tablesToCount) {
          if (table.has_embedding) tablesWithVec++
          colsWithVec += getTableColumnVectorCount(table)
        }

        // 只更新 API 状态，不影响生成过程中的实时计数器
        setApiTablesWithVectors(tablesWithVec)
        setApiColumnsWithVectors(colsWithVec)
      }
    } catch (error) {
      console.error('加载表数据失败:', error)
    }
  }, [currentProjectId, databaseId])

  // One-click config — confirm 之后的主流程
  const runOneClickConfig = useCallback(async () => {
    try {
      setConfiguringAll(true)

      const tablesToProcess = pendingTables.length > 0 ? pendingTables : tables
      const tableVectorTargets = tablesToProcess.filter((table: any) => !table.has_embedding)
      const columnVectorTargets = tablesToProcess.filter(tableNeedsColumnVectors)
      const baseTableVectorCount = countTableVectors(tablesToProcess)
      const baseColumnVectorCount = countColumnVectors(tablesToProcess)
      const totalColumnVectorCount = countColumns(tablesToProcess)

      // Step 1: Table vectors
      notifications.show({ message: t('database.guide.advanced.startGeneratingTableVectors') })
      setGenTableVectorCount(baseTableVectorCount)
      setGenTableVectorTotal(tablesToProcess.length)
      setGeneratingTableVectors(true)
      let tableSuccessCount = 0
      for (const table of tableVectorTargets) {
        try {
          const res: any = await storeSingleTableVectorReq(currentProjectId, databaseId, table.id)
          const generated = Number(res.data?.tables || 0)
          if (res.success && generated > 0) {
            tableSuccessCount += generated
            setGenTableVectorCount(
              Math.min(baseTableVectorCount + tableSuccessCount, tablesToProcess.length)
            )
          }
        } catch (error) {
          console.error(`生成表 ${table.table_name} 向量失败:`, error)
        }
      }
      setGeneratingTableVectors(false)
      notifications.show({
        color: 'green',
        message: t('database.guide.advanced.tableVectorComplete', {
          success: Math.min(baseTableVectorCount + tableSuccessCount, tablesToProcess.length),
          total: tablesToProcess.length,
        }),
      })
      await loadTables()

      // Step 2: Column vectors
      notifications.show({ message: t('database.guide.advanced.startGeneratingColumnVectors') })
      setGenColumnVectorCount(baseColumnVectorCount)
      setGenColumnVectorTotal(totalColumnVectorCount)
      setGeneratingColumnVectors(true)
      let columnSuccessCount = 0
      for (const table of columnVectorTargets) {
        try {
          const res: any = await storeTableColumnsVectorReq(currentProjectId, databaseId, table.id)
          const generated = Number(res.data?.columns || 0)
          if (res.success && generated > 0) {
            columnSuccessCount += generated
            setGenColumnVectorCount(
              Math.min(baseColumnVectorCount + columnSuccessCount, totalColumnVectorCount)
            )
          }
        } catch (error) {
          console.error(`生成表 ${table.table_name} 列向量失败:`, error)
        }
      }
      setGeneratingColumnVectors(false)
      notifications.show({
        color: 'green',
        message: t('database.guide.advanced.columnVectorComplete', {
          success: Math.min(baseColumnVectorCount + columnSuccessCount, totalColumnVectorCount),
          total: totalColumnVectorCount,
        }),
      })
      await loadTables()

      // Clear Redis pending
      try {
        await clearSyncPendingReq(currentProjectId, databaseId)
        await loadSyncPendingInfo()
      } catch (error) {
        console.warn('清除Redis待处理表信息失败:', error)
      }

      // Step 3: Entity suggest + create
      notifications.show({ message: t('database.guide.advanced.startEntitySuggest') })
      if (entitySectionRef.current) {
        await entitySectionRef.current.autoSuggestAndCreate()
      }

      // Step 4: Entity embeddings
      notifications.show({ message: t('database.guide.advanced.startEntityVectors') })
      if (entitySectionRef.current) {
        await entitySectionRef.current.autoGenerateEmbeddings()
      }

      notifications.show({
        color: 'green',
        message: t('database.guide.advanced.oneClickComplete'),
      })
    } catch (e: any) {
      if (e !== 'cancel') {
        notifications.show({ color: 'red', message: t('database.guide.advanced.configError') })
      }
    } finally {
      setConfiguringAll(false)
      setGeneratingTableVectors(false)
      setGeneratingColumnVectors(false)
    }
  }, [currentProjectId, databaseId, tables, pendingTables, t, loadTables, loadSyncPendingInfo])

  const handleOneClickConfig = useCallback(() => {
    if (tables.length === 0) {
      notifications.show({
        color: 'yellow',
        message: t('database.guide.advanced.noTableData'),
      })
      return
    }
    // ElMessageBox.confirm → modals.openConfirmModal
    modals.openConfirmModal({
      title: t('database.guide.advanced.confirmConfig'),
      children: t('database.guide.advanced.oneClickConfirmMsg'),
      labels: {
        confirm: t('database.guide.advanced.confirmConfigBtn'),
        cancel: t('common.cancel'),
      },
      onConfirm: () => {
        void runOneClickConfig()
      },
    })
  }, [tables, t, runOneClickConfig])

  // Generate all vectors (table + column combined) — confirm 之后的主流程
  const runGenerateAllVectors = useCallback(
    async (tablesToProcess: any[], targetCount: number) => {
      try {
        const tableVectorTargets = tablesToProcess.filter((table: any) => !table.has_embedding)
        const columnVectorTargets = tablesToProcess.filter(tableNeedsColumnVectors)
        const baseTableVectorCount = countTableVectors(tablesToProcess)
        const baseColumnVectorCount = countColumnVectors(tablesToProcess)
        const totalColumnVectorCount = countColumns(tablesToProcess)

        // Phase 1: Table vectors
        setGenTableVectorCount(baseTableVectorCount)
        setGenTableVectorTotal(tablesToProcess.length)
        setGeneratingTableVectors(true)
        let tableSuccessCount = 0

        for (const table of tableVectorTargets) {
          try {
            const res: any = await storeSingleTableVectorReq(currentProjectId, databaseId, table.id)
            const generated = Number(res.data?.tables || 0)
            if (res.success && generated > 0) {
              tableSuccessCount += generated
              setGenTableVectorCount(
                Math.min(baseTableVectorCount + tableSuccessCount, tablesToProcess.length)
              )
            }
          } catch (error) {
            console.error(`生成表 ${table.table_name} 向量失败:`, error)
          }
        }
        setGeneratingTableVectors(false)
        await loadTables()

        // Phase 2: Column vectors
        setGenColumnVectorCount(baseColumnVectorCount)
        setGenColumnVectorTotal(totalColumnVectorCount)
        setGeneratingColumnVectors(true)
        let columnSuccessCount = 0

        for (const table of columnVectorTargets) {
          try {
            const res: any = await storeTableColumnsVectorReq(
              currentProjectId,
              databaseId,
              table.id,
            )
            const generated = Number(res.data?.columns || 0)
            if (res.success && generated > 0) {
              columnSuccessCount += generated
              setGenColumnVectorCount(
                Math.min(baseColumnVectorCount + columnSuccessCount, totalColumnVectorCount)
              )
            }
          } catch (error) {
            console.error(`生成表 ${table.table_name} 列向量失败:`, error)
          }
        }
        setGeneratingColumnVectors(false)
        await loadTables()

        notifications.show({
          color: 'green',
          message: t('database.guide.advanced.allVectorsComplete', {
            success: Math.min(baseTableVectorCount + tableSuccessCount, tablesToProcess.length),
            total: targetCount,
          }),
        })

        try {
          await clearSyncPendingReq(currentProjectId, databaseId)
          await loadSyncPendingInfo()
        } catch (error) {
          console.warn('清除Redis待处理表信息失败:', error)
        }
      } catch (e) {
        // User cancelled
      } finally {
        setGeneratingTableVectors(false)
        setGeneratingColumnVectors(false)
      }
    },
    [currentProjectId, databaseId, t, loadTables, loadSyncPendingInfo],
  )

  const handleGenerateAllVectors = useCallback(async () => {
    if (tables.length === 0) {
      notifications.show({
        color: 'yellow',
        message: t('database.guide.advanced.noTableData'),
      })
      return
    }

    let tablesToProcess = tables
    try {
      const pendingRes: any = await getSyncPendingReq(currentProjectId, databaseId)
      const pendingInfo = pendingRes.success ? normalizeSyncPendingInfo(pendingRes.data) : null
      if (pendingInfo?.table_ids) {
        if (!pendingInfo.is_full_sync && pendingInfo.table_ids.length > 0) {
          tablesToProcess = tables.filter((table: any) =>
            pendingInfo.table_ids.includes(table.id),
          )
        }
      } else if (pendingInfo?.table_keys?.length > 0) {
        tablesToProcess = tables.filter((table: any) => {
          const tableKey = table.schema_name ? `${table.schema_name}.${table.table_name}` : table.table_name
          return pendingInfo.table_keys.includes(tableKey)
        })
      }
    } catch (error) {
      console.warn('获取待处理表信息失败，使用全量处理:', error)
    }

    const targetCount = tablesToProcess.length
    // ElMessageBox.confirm → modals.openConfirmModal
    modals.openConfirmModal({
      title: t('database.guide.advanced.confirmGenerate'),
      children: t('database.guide.advanced.confirmGenerateAllVectors', { count: targetCount }),
      labels: {
        confirm: t('database.guide.advanced.confirmGenerateBtn'),
        cancel: t('common.cancel'),
      },
      onConfirm: () => {
        void runGenerateAllVectors(tablesToProcess, targetCount)
      },
    })
  }, [tables, currentProjectId, databaseId, t, runGenerateAllVectors])

  // Relationships
  const loadRelationshipCount = useCallback(async () => {
    if (!databaseId) return
    try {
      const res: any = await getRelationshipsReq(currentProjectId, databaseId)
      if (res.success && res.data) {
        setRelationshipCount(Array.isArray(res.data) ? res.data.length : 0)
      }
    } catch (error) {
      console.error('加载关系数据失败:', error)
    }
  }, [currentProjectId, databaseId])

  const handleEntitySuggest = useCallback(() => {
    if (entitySectionRef.current) {
      entitySectionRef.current.handleSuggest()
    }
  }, [])
  const handleEntityAddManually = useCallback(() => {
    if (entitySectionRef.current) {
      entitySectionRef.current.openAddDialog()
    }
  }, [])
  const handleOpenRelationship = useCallback(() => {
    setShowRelationshipDialog(true)
  }, [])
  const handleRelationshipDialogClosed = useCallback(() => {
    loadRelationshipCount()
  }, [loadRelationshipCount])
  const handleEntityConfigChanged = useCallback((count: number) => {
    setEntityConfigCount(count)
  }, [])
  const handlePrev = useCallback(() => {
    onPrev?.()
  }, [onPrev])
  const handleFinish = useCallback(() => {
    onFinish?.()
  }, [onFinish])

  // Lifecycle: onMounted + watch(databaseId)
  useEffect(() => {
    const run = async () => {
      await loadSyncPendingInfo()
      await loadTables()
      loadRelationshipCount()
    }
    if (databaseId) {
      run()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databaseId])

  const syncTableKeysLen =
    (syncPendingInfo?.table_keys || syncPendingInfo?.table_ids || []).length || 0

  return (
    <div className={styles.guideStepAdvanced}>
      {/* 顶部标题 + 一键配置横幅 */}
      <div className={styles.pageTop}>
        <div className={styles.titleRow}>
          <h2 className={styles.pageTitle}>{t('database.guide.advanced.title')}</h2>
          <div className={styles.titleBadges}>
            <span className={`${styles.badge} ${allVectorsCompleted ? styles.done : ''}`}>
              <i className={styles.dot} />
              {t('database.guide.advanced.schemaVectors')}
            </span>
            <span className={`${styles.badge} ${entityConfigCount > 0 ? styles.done : ''}`}>
              <i className={styles.dot} />
              {t('database.guide.advanced.entityConfig')}
            </span>
            <span className={`${styles.badge} ${relationshipCount > 0 ? styles.done : ''}`}>
              <i className={styles.dot} />
              {t('database.guide.advanced.configRelationship')}
            </span>
          </div>
        </div>
        <div className={styles.oneclickBanner}>
          <div className={styles.bannerLeft}>
            <span className={styles.bannerIcon}>
              <ElSvgIcon name="MagicStick" size={22} />
            </span>
            <div className={styles.bannerText}>
              <strong>{t('database.guide.advanced.oneClickTitle')}</strong>
              <span className={styles.bannerSub}>
                {t('database.guide.advanced.oneClickSubtitle')}
              </span>
            </div>
          </div>
          <Button
            onClick={handleOneClickConfig}
            loading={configuringAll}
            disabled={tables.length === 0}
            className={styles.oneclickBtn}
            leftSection={!configuringAll ? <ElSvgIcon name="MagicStick" size={16} /> : undefined}
          >
            {configuringAll
              ? t('database.guide.advanced.configuring')
              : t('database.guide.advanced.oneClickConfig')}
          </Button>
        </div>
      </div>

      {/* 可滚动内容区 */}
      <div className={styles.pageBody}>
        {/* Section 1: Schema 向量化 */}
        <div className={styles.panel}>
          <div className={styles.panelHeader}>
            <span className={styles.panelLabel}>
              {t('database.guide.advanced.vectorRecallTitle')}
            </span>
            <span className={styles.panelHint}>
              {t('database.guide.advanced.vectorRecallDesc')}
            </span>
          </div>
          <div className={styles.panelBody}>
            {/* Redis 同步提示 */}
            {syncPendingInfo && tables.length > 0 && (
              <div className={styles.syncBar}>
                <ElSvgIcon name="InfoFilled" size={14} />
                {syncPendingInfo.is_full_sync ? (
                  <span>
                    {t('database.guide.advanced.fullSync')} ·{' '}
                    {t('database.guide.advanced.allTables', { count: tables.length })}
                  </span>
                ) : (
                  syncTableKeysLen > 0 && (
                    <span>
                      {t('database.guide.advanced.tableSync')} ·{' '}
                      {t('database.guide.advanced.tableCount', { count: syncTableKeysLen })}
                    </span>
                  )
                )}
              </div>
            )}

            <div
              className={`${styles.vectorCombined} ${
                allVectorsCompleted ? styles.completed : ''
              } ${generatingVectors ? styles.active : ''}`}
            >
              <div className={styles.vcTop}>
                <div className={`${styles.vcIcon} ${allVectorsCompleted ? styles.completed : ''}`}>
                  <ElSvgIcon name="Box" size={22} />
                </div>
                <div className={styles.vcInfo}>
                  <div className={styles.vcTitle}>
                    {t('database.guide.advanced.generateSchemaVectors')}
                  </div>
                  <div className={styles.vcDesc}>
                    {t('database.guide.advanced.schemaVectorsDesc')}
                  </div>
                </div>
                <div className={styles.vcAction}>
                  <Button
                    color={allVectorsCompleted ? 'green' : 'grape'}
                    size="xs"
                    onClick={handleGenerateAllVectors}
                    loading={generatingVectors}
                    disabled={tables.length === 0}
                  >
                    {generatingVectors
                      ? t('database.guide.advanced.generating')
                      : allVectorsCompleted
                        ? t('database.guide.advanced.generated')
                        : t('database.guide.advanced.generate')}
                  </Button>
                </div>
              </div>
              {/* 双进度条 */}
              {pendingTablesCount > 0 && (
                <div className={styles.vcProgressGroup}>
                  <div className={styles.vcProgressRow}>
                    <span className={styles.vcProgressLabel}>
                      {t('database.guide.advanced.tableVectorShort')}
                    </span>
                    <Progress
                      className={styles.vcBar}
                      value={tableVectorProgressPercentage}
                      color={tableVectorCompleted ? 'green' : undefined}
                      size={4}
                    />
                    <span
                      className={`${styles.vcProgressNum} ${
                        tableVectorCompleted ? styles.done : ''
                      }`}
                    >
                      {tablesWithVectors}/{pendingTablesCount}
                    </span>
                  </div>
                  <div className={styles.vcProgressRow}>
                    <span className={styles.vcProgressLabel}>
                      {t('database.guide.advanced.columnVectorShort')}
                    </span>
                    <Progress
                      className={styles.vcBar}
                      value={columnVectorProgressPercentage}
                      color={columnVectorCompleted ? 'green' : undefined}
                      size={4}
                    />
                    <span
                      className={`${styles.vcProgressNum} ${
                        columnVectorCompleted ? styles.done : ''
                      }`}
                    >
                      {columnsWithVectors}/{pendingColumnsCount}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Section 2: 实体配置 */}
        <div className={`${styles.panel} ${styles.panelEntity}`}>
          <div className={`${styles.panelHeader} ${styles.panelHeaderBetween}`}>
            <div className={styles.panelHeaderLeft}>
              <span className={styles.panelLabel}>
                {t('database.guide.advanced.entityConfig')}
              </span>
              <span className={styles.panelHint}>
                {t('database.guide.advanced.entityConfigDesc')}
              </span>
            </div>
            <div className={styles.panelHeaderActions}>
              <Button
                size="xs"
                onClick={handleEntitySuggest}
                loading={entitySuggesting}
                disabled={tables.length === 0}
                leftSection={<ElSvgIcon name="MagicStick" size={14} />}
              >
                {entitySuggesting
                  ? t('database.guide.advanced.suggesting')
                  : t('database.guide.advanced.suggestEntity')}
              </Button>
              <Button
                variant="default"
                size="xs"
                onClick={handleEntityAddManually}
                disabled={tables.length === 0}
                leftSection={<ElSvgIcon name="Plus" size={14} />}
              >
                {t('database.guide.advanced.addEntityManually')}
              </Button>
            </div>
          </div>
          <div className={styles.panelBody}>
            <AdvancedEntitySection
              ref={entitySectionRef as any}
              databaseId={databaseId}
              tables={tables}
              disabled={tables.length === 0}
              onConfigChanged={handleEntityConfigChanged}
              onSuggestingChanged={(v: boolean) => setEntitySuggesting(v)}
            />
          </div>
        </div>

        {/* Section 3: 表关系 */}
        <div className={styles.panel}>
          <div className={styles.panelHeader}>
            <span className={styles.panelLabel}>
              {t('database.guide.advanced.configRelationship')}
            </span>
            <span className={styles.panelHint}>
              {t('database.guide.advanced.relationshipDesc')}
            </span>
          </div>
          <div className={styles.panelBody}>
            <div className={styles.relRow}>
              <div className={styles.relInfo}>
                <span className={styles.relIcon}>
                  <ElSvgIcon name="Connection" size={18} />
                </span>
                {relationshipCount > 0 ? (
                  <span className={`${styles.relCount} ${styles.done}`}>
                    {t('database.guide.advanced.relationshipCountLabel', {
                      count: relationshipCount,
                    })}
                  </span>
                ) : (
                  <span className={styles.relCount}>
                    {t('database.guide.advanced.noRelationship')}
                  </span>
                )}
              </div>
              <Button
                color={relationshipCount > 0 ? 'green' : 'grape'}
                size="xs"
                onClick={handleOpenRelationship}
                disabled={tables.length === 0}
              >
                {relationshipCount > 0
                  ? t('database.guide.advanced.viewEdit')
                  : t('database.guide.advanced.configure')}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* 表关系图弹窗 */}
      <Modal
        opened={showRelationshipDialog}
        onClose={() => setShowRelationshipDialog(false)}
        title={t('database.guide.advanced.configRelationship')}
        size="90%"
        // destroy-on-close + @closed → 关闭时刷新关系数量
        onExitTransitionEnd={handleRelationshipDialogClosed}
        styles={{ body: { padding: 0, overflow: 'hidden' } }}
      >
        <div className={styles.relationshipDialogBody}>
          {showRelationshipDialog && (
            <ERDiagram key={`er-guide-${databaseId}`} databaseId={databaseId} />
          )}
        </div>
      </Modal>

      {/* 底部导航 */}
      <div className={styles.pageFooter}>
        <Button
          variant="default"
          onClick={handlePrev}
          leftSection={<ElSvgIcon name="ArrowLeft" size={16} />}
        >
          {t('database.action.prev')}
        </Button>
        <Button
          onClick={handleFinish}
          rightSection={<ElSvgIcon name="Check" size={16} />}
        >
          {t('database.guide.advanced.finishConfig')}
        </Button>
      </div>
    </div>
  )
}
