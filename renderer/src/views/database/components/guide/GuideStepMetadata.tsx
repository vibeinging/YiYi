import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Textarea } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import { IconArrowLeft, IconArrowRight, IconWand, IconInfoCircleFilled, IconBox } from '@tabler/icons-react'
import ElSvgIcon from '@/components/ElSvgIcon'

import {
  getCachedTablesReq,
  generateDatabaseDescriptionReq,
  getTableColumnsReq,
  getDatabaseDetailReq,
  updateDatabaseReq,
  generateColumnsDescriptionsReq,
  getSyncPendingReq,
  clearSyncPendingReq,
  storeSingleTableVectorReq,
  storeTableColumnsVectorReq
} from '@/api/database'
import { useProjectStore, projectGetters } from '@/store/project'

// 这两个子组件目前仍是迁移 stub，未声明 props 类型；用 any 转型以保留预期回调契约（对齐原 Vue emit）
import TableStructureViewRaw from '../TableStructureView'
import TableEditDialogRaw from '../TableEditDialog'

const TableStructureView = TableStructureViewRaw as React.ComponentType<any>
const TableEditDialog = TableEditDialogRaw as React.ComponentType<any>

import styles from './GuideStepMetadata.module.scss'

export interface GuideStepMetadataProps {
  projectId: string
  database?: any
  databaseId?: string | null
  isFirstStep?: boolean
  standalone?: boolean
  graphContent?: ReactNode
  initialBodyViewMode?: 'table' | 'er'
  // defineEmits(['step-completed', 'prev'])
  onStepCompleted?: () => void
  onPrev?: () => void
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

export default function GuideStepMetadata({
  database = null,
  databaseId = null,
  isFirstStep = false,
  standalone = false,
  graphContent = null,
  initialBodyViewMode = 'table',
  onStepCompleted,
  onPrev
}: GuideStepMetadataProps) {
  const { t } = useTranslation()

  const currentProjectId = useProjectStore(projectGetters.currentProjectId)

  // ── 表数据 ──────────────────────────────────────────────────
  const [tables, setTables] = useState<any[]>([])
  const [totalColumns, setTotalColumns] = useState(0)
  const [tablesWithDescription, setTablesWithDescription] = useState(0)
  const [columnsWithDescription, setColumnsWithDescription] = useState(0)
  const [databaseWithDescription, setDatabaseWithDescription] = useState(false)

  // 数据库描述文本（用于 inline 编辑）
  const [databaseDescription, setDatabaseDescription] = useState('')

  // Redis 同步表信息
  const [syncPendingInfo, setSyncPendingInfo] = useState<any>(null)

  // 当前选中的表和列
  const [currentTable, setCurrentTable] = useState<any>(null)
  const [bodyViewMode, setBodyViewMode] = useState<'table' | 'er'>(initialBodyViewMode)

  // 数据库描述编辑状态
  const [dbDescFocused, setDbDescFocused] = useState(false)
  const [savingDbDesc, setSavingDbDesc] = useState(false)

  // 编辑表对话框
  const [editDialogVisible, setEditDialogVisible] = useState(false)
  const [editingTable, setEditingTable] = useState<any>(null)

  // 生成状态
  const [generatingAll, setGeneratingAll] = useState(false)
  const [generatingTableDesc, setGeneratingTableDesc] = useState(false)
  const [generatingColumnDesc, setGeneratingColumnDesc] = useState(false)
  const [generatingDatabaseDesc, setGeneratingDatabaseDesc] = useState(false)

  // 向量生成状态
  const [generatingTableVectors, setGeneratingTableVectors] = useState(false)
  const [generatingColumnVectors, setGeneratingColumnVectors] = useState(false)
  const generatingVectors = generatingTableVectors || generatingColumnVectors
  const [apiTablesWithVectors, setApiTablesWithVectors] = useState(0)
  const [apiColumnsWithVectors, setApiColumnsWithVectors] = useState(0)
  const [genTableVectorCount, setGenTableVectorCount] = useState(0)
  const [genColumnVectorCount, setGenColumnVectorCount] = useState(0)
  const [genTableVectorTotal, setGenTableVectorTotal] = useState(0)
  const [genColumnVectorTotal, setGenColumnVectorTotal] = useState(0)

  // ── 镜像 ref（对齐 Vue 的 .value 语义，供异步处理器读取/写入最新值，避免闭包陈旧） ──
  const tablesRef = useRef<any[]>(tables)
  const totalColumnsRef = useRef(totalColumns)
  const columnsWithDescriptionRef = useRef(columnsWithDescription)
  const tablesWithDescriptionRef = useRef(tablesWithDescription)
  const syncPendingInfoRef = useRef<any>(syncPendingInfo)
  const currentTableRef = useRef<any>(currentTable)
  const generatingColumnDescRef = useRef(generatingColumnDesc)
  const generatingTableDescRef = useRef(generatingTableDesc)
  const databaseDescriptionRef = useRef(databaseDescription)
  const projectIdRef = useRef(currentProjectId)
  const databaseIdRef = useRef(databaseId)

  useEffect(() => {
    tablesRef.current = tables
  }, [tables])
  useEffect(() => {
    totalColumnsRef.current = totalColumns
  }, [totalColumns])
  useEffect(() => {
    columnsWithDescriptionRef.current = columnsWithDescription
  }, [columnsWithDescription])
  useEffect(() => {
    tablesWithDescriptionRef.current = tablesWithDescription
  }, [tablesWithDescription])
  useEffect(() => {
    syncPendingInfoRef.current = syncPendingInfo
  }, [syncPendingInfo])
  useEffect(() => {
    currentTableRef.current = currentTable
  }, [currentTable])
  useEffect(() => {
    setBodyViewMode(initialBodyViewMode)
  }, [databaseId, initialBodyViewMode])
  useEffect(() => {
    if (!graphContent && bodyViewMode === 'er') {
      setBodyViewMode('table')
    }
  }, [graphContent, bodyViewMode])
  useEffect(() => {
    generatingColumnDescRef.current = generatingColumnDesc
  }, [generatingColumnDesc])
  useEffect(() => {
    generatingTableDescRef.current = generatingTableDesc
  }, [generatingTableDesc])
  useEffect(() => {
    databaseDescriptionRef.current = databaseDescription
  }, [databaseDescription])
  useEffect(() => {
    projectIdRef.current = currentProjectId
  }, [currentProjectId])
  useEffect(() => {
    databaseIdRef.current = databaseId
  }, [databaseId])

  // ── 计算属性（computed） ────────────────────────────────────
  const tablesWithVectors = generatingTableVectors ? genTableVectorCount : apiTablesWithVectors
  const columnsWithVectors = generatingColumnVectors ? genColumnVectorCount : apiColumnsWithVectors

  const vectorPendingTablesCount = useMemo(() => {
    if (generatingTableVectors && genTableVectorTotal > 0) return genTableVectorTotal
    if (!syncPendingInfo) return tables.length
    if (syncPendingInfo.is_full_sync) return tables.length
    const tableKeys = syncPendingInfo.table_keys || []
    const tableIds = syncPendingInfo.table_ids || []
    const count = tableKeys.length > 0 ? tableKeys.length : tableIds.length
    return count > 0 ? count : tables.length
  }, [
    generatingTableVectors,
    genTableVectorTotal,
    generatingColumnVectors,
    genColumnVectorTotal,
    syncPendingInfo,
    tables
  ])

  // 判断是否有任何操作正在执行
  const isAnyOperationRunning =
    generatingAll || generatingColumnDesc || generatingTableDesc || generatingDatabaseDesc || generatingVectors

  // 计算属性：获取待处理的表数量
  const pendingTablesCount = useMemo(() => {
    if (!syncPendingInfo) return tables.length
    if (syncPendingInfo.is_full_sync) return tables.length
    const tableKeys = syncPendingInfo.table_keys || []
    const tableIds = syncPendingInfo.table_ids || []
    const count = tableKeys.length > 0 ? tableKeys.length : tableIds.length
    return count > 0 ? count : tables.length
  }, [syncPendingInfo, tables])

  // 计算属性：获取待处理的列数量
  const pendingColumnsCount = useMemo(() => {
    if (!syncPendingInfo) return totalColumns
    if (syncPendingInfo.is_full_sync) return totalColumns

    let cols = 0
    let hasMatchedTables = false

    if (syncPendingInfo.table_keys && syncPendingInfo.table_keys.length > 0) {
      for (const tableKey of syncPendingInfo.table_keys) {
        const table = tables.find((tb: any) => {
          const key = tb.schema_name ? `${tb.schema_name}.${tb.table_name}` : tb.table_name
          return key === tableKey
        })
        if (table && table.column_count !== undefined) {
          cols += table.column_count || 0
          hasMatchedTables = true
        }
      }
    } else if (syncPendingInfo.table_ids && syncPendingInfo.table_ids.length > 0) {
      for (const tableId of syncPendingInfo.table_ids) {
        const table = tables.find((tb: any) => tb.id === tableId)
        if (table && table.column_count !== undefined) {
          cols += table.column_count || 0
          hasMatchedTables = true
        }
      }
    }

    return hasMatchedTables ? cols : totalColumns
  }, [syncPendingInfo, tables, totalColumns])

  const vectorPendingColumnsCount = useMemo(() => {
    if (generatingColumnVectors && genColumnVectorTotal > 0) return genColumnVectorTotal
    return pendingColumnsCount
  }, [generatingColumnVectors, genColumnVectorTotal, pendingColumnsCount])

  const tableVectorCompleted = useMemo(() => {
    const target = vectorPendingTablesCount
    return tablesWithVectors >= target && target > 0
  }, [vectorPendingTablesCount, tablesWithVectors])

  const columnVectorCompleted = useMemo(() => {
    const target = vectorPendingColumnsCount
    return columnsWithVectors >= target && target > 0
  }, [vectorPendingColumnsCount, columnsWithVectors])

  const tableVectorProgressPercentage = useMemo(() => {
    const target = vectorPendingTablesCount
    if (target === 0) return 0
    return Math.min(100, Math.round((tablesWithVectors / target) * 100))
  }, [vectorPendingTablesCount, tablesWithVectors])

  const columnVectorProgressPercentage = useMemo(() => {
    const target = vectorPendingColumnsCount
    if (target === 0) return 0
    return Math.min(100, Math.round((columnsWithVectors / target) * 100))
  }, [vectorPendingColumnsCount, columnsWithVectors])

  const allVectorsCompleted = tableVectorCompleted && columnVectorCompleted

  // 列描述完成状态（仅依赖自身数据，不依赖其他生成状态）
  const isColumnDescCompleted = useMemo(() => {
    if (generatingColumnDesc) return false
    const targetCount = pendingColumnsCount
    return columnsWithDescription === targetCount && targetCount > 0
  }, [generatingColumnDesc, pendingColumnsCount, columnsWithDescription])

  // 表描述完成状态（仅依赖自身数据，不依赖其他生成状态）
  const isTableDescCompleted = useMemo(() => {
    if (generatingTableDesc) return false
    const targetCount = pendingTablesCount
    return tablesWithDescription === targetCount && targetCount > 0
  }, [generatingTableDesc, pendingTablesCount, tablesWithDescription])

  // 数据库描述完成状态
  const isDatabaseDescCompleted = databaseWithDescription

  // 全部完成需要三项都完成
  const isAllCompleted = isColumnDescCompleted && isTableDescCompleted && isDatabaseDescCompleted

  // ── 加载 Redis 同步表信息 ───────────────────────────────────
  const loadSyncPendingInfo = useCallback(async () => {
    if (!databaseIdRef.current) return
    try {
      const res: any = await getSyncPendingReq(projectIdRef.current, databaseIdRef.current)
      if (res.success && res.data) {
        const normalized = normalizeSyncPendingInfo(res.data)
        setSyncPendingInfo(normalized)
        syncPendingInfoRef.current = normalized
      } else {
        setSyncPendingInfo(null)
        syncPendingInfoRef.current = null
      }
    } catch (error) {
      console.error('加载 Redis 同步表信息失败:', error)
      setSyncPendingInfo(null)
      syncPendingInfoRef.current = null
    }
  }, [])

  // ── 加载表数据 ──────────────────────────────────────────────
  // 声明在前，handleTableChange 内引用；用 ref 解互相依赖
  const handleTableChangeRef = useRef<(table: any) => Promise<void>>(async () => {})

  const loadTables = useCallback(async () => {
    if (!databaseIdRef.current) return

    try {
      const res: any = await getCachedTablesReq(projectIdRef.current, databaseIdRef.current)
      if (res.success && res.data) {
        const tableList = res.data.items || res.data || []
        setTables(tableList)
        tablesRef.current = tableList

        const sync = syncPendingInfoRef.current

        // 获取待处理表列表
        let tablesToCount = tableList
        if (sync && !sync.is_full_sync) {
          if (sync.table_keys && sync.table_keys.length > 0) {
            tablesToCount = tableList.filter((table: any) => {
              const tableKey = table.schema_name ? `${table.schema_name}.${table.table_name}` : table.table_name
              return sync.table_keys.includes(tableKey)
            })
          } else if (sync.table_ids && sync.table_ids.length > 0) {
            tablesToCount = tableList.filter((table: any) => sync.table_ids.includes(table.id))
          }
        }

        // 统计描述完成度和向量状态
        let totalCols = 0
        let tablesWithDesc = 0
        let colsWithDesc = 0
        let tablesWithVec = 0
        let colsWithVec = 0

        for (const table of tablesToCount) {
          if (table.description && table.description.trim()) tablesWithDesc++
          if (table.column_count !== undefined) totalCols += table.column_count || 0
          if (table.columns_with_description !== undefined) colsWithDesc += table.columns_with_description || 0
          if (table.has_embedding) tablesWithVec++
          colsWithVec += getTableColumnVectorCount(table)
        }

        setApiTablesWithVectors(tablesWithVec)
        setApiColumnsWithVectors(colsWithVec)

        setTotalColumns(totalCols)
        totalColumnsRef.current = totalCols

        if (!generatingColumnDescRef.current) {
          const wasCompleted =
            columnsWithDescriptionRef.current === totalColumnsRef.current && totalColumnsRef.current > 0
          if (wasCompleted && colsWithDesc < totalCols) {
            // 保持完成状态
          } else {
            setColumnsWithDescription(colsWithDesc)
            columnsWithDescriptionRef.current = colsWithDesc
          }
        }

        if (!generatingTableDescRef.current) {
          const targetCount = tablesToCount.length
          // pendingTablesCount 等价计算（基于最新 sync + tableList）
          const computedPending = (() => {
            if (!sync) return tableList.length
            if (sync.is_full_sync) return tableList.length
            const tableKeys = sync.table_keys || []
            const tableIds = sync.table_ids || []
            const count = tableKeys.length > 0 ? tableKeys.length : tableIds.length
            return count > 0 ? count : tableList.length
          })()
          const wasCompleted = tablesWithDescriptionRef.current === computedPending && computedPending > 0
          if (wasCompleted && tablesWithDesc < targetCount) {
            // 保持完成状态
          } else {
            setTablesWithDescription(tablesWithDesc)
            tablesWithDescriptionRef.current = tablesWithDesc
          }
        }

        // 检查数据库描述
        try {
          const dbRes: any = await getDatabaseDetailReq(projectIdRef.current, databaseIdRef.current)
          if (dbRes.success && dbRes.data) {
            setDatabaseWithDescription(!!(dbRes.data.description && dbRes.data.description.trim()))
            const desc = dbRes.data.description || ''
            setDatabaseDescription(desc)
            databaseDescriptionRef.current = desc
          }
        } catch (error) {
          console.error('获取数据库详情失败:', error)
        }

        // 同步当前选中表的最新数据，或自动选中第一个表
        const cur = currentTableRef.current
        if (cur) {
          const updated = tableList.find((tb: any) => tb.id === cur.id)
          if (updated) {
            // 保留已加载的列数据
            const merged = { ...updated, columns: cur.columns }
            setCurrentTable(merged)
            currentTableRef.current = merged
          }
        } else if (tableList.length > 0) {
          await handleTableChangeRef.current(tableList[0])
        }
      }
    } catch (error) {
      console.error('加载表数据失败:', error)
    }
  }, [])

  // ── 保存数据库描述 ──────────────────────────────────────────
  const handleSaveDatabaseDescription = useCallback(async () => {
    if (!databaseIdRef.current) return
    setSavingDbDesc(true)
    try {
      const res: any = await updateDatabaseReq(projectIdRef.current, {
        id: databaseIdRef.current,
        description: databaseDescriptionRef.current
      })
      if (res.success) {
        setDatabaseWithDescription(
          !!(databaseDescriptionRef.current && databaseDescriptionRef.current.trim())
        )
        notifications.show({ color: 'green', message: t('database.guide.metadata.dbDescSaved') })
      } else {
        notifications.show({ color: 'red', message: res.msg || t('database.guide.metadata.dbDescSaveFailed') })
      }
    } catch (error) {
      console.error('保存数据库描述失败:', error)
      notifications.show({ color: 'red', message: t('database.guide.metadata.dbDescSaveFailed') })
    } finally {
      setSavingDbDesc(false)
      setDbDescFocused(false)
    }
  }, [t])

  // ── 数据库描述失焦 ──────────────────────────────────────────
  const dbDescBlurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleDbDescBlur = useCallback(() => {
    // 延迟关闭，让保存按钮的 mousedown 有机会触发
    if (dbDescBlurTimer.current) clearTimeout(dbDescBlurTimer.current)
    dbDescBlurTimer.current = setTimeout(() => {
      setDbDescFocused(false)
      dbDescBlurTimer.current = null
    }, 150)
  }, [])

  // ── 处理表切换 ──────────────────────────────────────────────
  const handleTableChange = useCallback(async (table: any) => {
    if (!table) return
    // 如果表没有列数据，先加载
    if (!table.columns || table.columns.length === 0) {
      try {
        const res: any = await getTableColumnsReq(projectIdRef.current, databaseIdRef.current, table.id)
        if (res.success && res.data) {
          table.columns = res.data.items || res.data || []
        }
      } catch (error) {
        console.error('加载列数据失败:', error)
      }
    }
    setCurrentTable(table)
    currentTableRef.current = table
  }, [])

  useEffect(() => {
    handleTableChangeRef.current = handleTableChange
  }, [handleTableChange])

  // ── 处理从 TableStructureView 触发的列加载 ────────────────────
  const handleLoadColumns = useCallback(async (tableId: any) => {
    try {
      const res: any = await getTableColumnsReq(projectIdRef.current, databaseIdRef.current, tableId)
      if (res.success && res.data) {
        const table = tablesRef.current.find((tb: any) => tb.id === tableId)
        if (table) {
          table.columns = res.data.items || res.data || []
        }
      }
    } catch (error) {
      console.error('加载列数据失败:', error)
    }
  }, [])

  // ── 处理从 TableStructureView 触发的刷新 ──────────────────────
  const handleRefreshFromStructure = useCallback(async () => {
    await loadTables()
    // 如果有当前选中的表，重新加载其列数据
    const cur = currentTableRef.current
    if (cur) {
      try {
        const res: any = await getTableColumnsReq(projectIdRef.current, databaseIdRef.current, cur.id)
        if (res.success && res.data) {
          const columns = res.data.items || res.data || []
          const tableInList = tablesRef.current.find((tb: any) => tb.id === cur.id)
          if (tableInList) {
            tableInList.columns = columns
            const merged = { ...tableInList, columns }
            setCurrentTable(merged)
            currentTableRef.current = merged
          }
        }
      } catch (error) {
        console.error('刷新列数据失败:', error)
      }
    }
  }, [loadTables])

  // ── 打开编辑表对话框 ────────────────────────────────────────
  const handleOpenEditDialog = useCallback((table: any) => {
    setEditingTable(table)
    setEditDialogVisible(true)
  }, [])

  // ── 表编辑保存后刷新 ────────────────────────────────────────
  const handleAfterTableEditSaved = useCallback(async () => {
    await loadTables()
    if (currentTableRef.current) {
      await handleRefreshFromStructure()
    }
  }, [loadTables, handleRefreshFromStructure])

  // ── 获取待处理表 IDs 的辅助方法 ─────────────────────────────
  const getPendingTableIds = useCallback(async () => {
    let tableIds: any[] | null = null
    try {
      const pendingRes: any = await getSyncPendingReq(projectIdRef.current, databaseIdRef.current)
      if (pendingRes.success && pendingRes.data) {
        const pendingInfo = normalizeSyncPendingInfo(pendingRes.data)
        setSyncPendingInfo(pendingInfo)
        syncPendingInfoRef.current = pendingInfo
        if (pendingInfo?.is_full_sync) {
          tableIds = tablesRef.current.map((table: any) => table.id)
        } else {
          if (pendingInfo?.table_keys && pendingInfo.table_keys.length > 0) {
            const matchedTables = tablesRef.current.filter((table: any) => {
              const tableKey = table.schema_name ? `${table.schema_name}.${table.table_name}` : table.table_name
              return pendingInfo.table_keys.includes(tableKey)
            })
            tableIds = matchedTables.map((table: any) => table.id)
          } else if (pendingInfo?.table_ids && pendingInfo.table_ids.length > 0) {
            tableIds = pendingInfo.table_ids
          }
        }
      }
    } catch (error) {
      console.warn('获取待处理表信息失败，使用全量处理:', error)
    }
    if (!tableIds || tableIds.length === 0) {
      tableIds = tablesRef.current.map((table: any) => table.id)
    }
    return tableIds
  }, [])

  // ── 一键生成所有描述（确认后执行的主流程） ────────────────────
  const runGenerateAll = useCallback(async () => {
    try {
      setGeneratingAll(true)
      const tableIds = await getPendingTableIds()

      // 第一步：批量生成列描述和表描述
      notifications.show({ color: 'blue', message: t('database.guide.metadata.step1Generating') })
      setGeneratingColumnDesc(true)
      generatingColumnDescRef.current = true
      setGeneratingTableDesc(true)
      generatingTableDescRef.current = true

      try {
        const res: any = await generateColumnsDescriptionsReq(
          projectIdRef.current,
          databaseIdRef.current,
          tableIds,
          2,
          false
        )

        if (res.success && res.data) {
          const { columns_generated, tables_generated, details } = res.data
          await loadTables()
          const failedTables = (details || [])
            .filter((r: any) => !r.success || r.error)
            .map((r: any) => r.table_name)
            .join('、')
          if (failedTables) {
            notifications.show({
              color: 'yellow',
              message: t('database.guide.metadata.descGeneratedWithFailures', {
                columns: columns_generated,
                tables: tables_generated,
                failed: failedTables
              })
            })
          } else {
            notifications.show({
              color: 'green',
              message: t('database.guide.metadata.descGenerated', {
                columns: columns_generated,
                tables: tables_generated
              })
            })
          }

          try {
            await clearSyncPendingReq(projectIdRef.current, databaseIdRef.current)
            await loadSyncPendingInfo()
          } catch (error) {
            console.warn('清除Redis待处理表信息失败:', error)
          }
        } else {
          throw new Error(res.msg || t('database.guide.metadata.batchGenerateFailed'))
        }
      } catch (error: any) {
        console.error('批量生成列描述和表描述失败:', error)
        notifications.show({
          color: 'red',
          message:
            t('database.guide.metadata.generateError') +
            (error.message || t('database.guide.metadata.unknownError'))
        })
      } finally {
        setGeneratingColumnDesc(false)
        generatingColumnDescRef.current = false
        setGeneratingTableDesc(false)
        generatingTableDescRef.current = false
        await loadTables()
      }

      // 第二步：生成数据库描述
      notifications.show({ color: 'blue', message: t('database.guide.metadata.step2Generating') })
      setGeneratingDatabaseDesc(true)

      try {
        const res: any = await generateDatabaseDescriptionReq(projectIdRef.current, databaseIdRef.current)
        if (res.success && res.data) {
          setDatabaseWithDescription(true)
          const desc = res.data.description || databaseDescriptionRef.current
          setDatabaseDescription(desc)
          databaseDescriptionRef.current = desc
          notifications.show({ color: 'green', message: t('database.guide.metadata.dbDescGenerateComplete') })
        } else {
          throw new Error(res.msg || t('database.guide.metadata.dbDescGenerateFailed'))
        }
      } catch (error: any) {
        console.error('生成数据库描述失败:', error)
        notifications.show({
          color: 'yellow',
          message: error.message || t('database.guide.metadata.dbDescGenerateFailed')
        })
      }

      setGeneratingDatabaseDesc(false)
      await loadTables()
      await loadSyncPendingInfo()

      // 第三步：生成 Schema 向量（表向量 + 列向量）
      notifications.show({ color: 'blue', message: t('database.guide.metadata.step3GeneratingVectors') })
      const allTableIds = tablesRef.current.map((tb: any) => tb.id)
      const tablesToProcess = tablesRef.current.filter((tb: any) => allTableIds.includes(tb.id))
      const tableVectorTargets = tablesToProcess.filter((table: any) => !table.has_embedding)
      const columnVectorTargets = tablesToProcess.filter(tableNeedsColumnVectors)
      const baseTableVectorCount = countTableVectors(tablesToProcess)
      const baseColumnVectorCount = countColumnVectors(tablesToProcess)
      const totalColumnVectorCount = countColumns(tablesToProcess)

      // 表向量
      setGenTableVectorCount(baseTableVectorCount)
      setGenTableVectorTotal(tablesToProcess.length)
      setGeneratingTableVectors(true)
      let tableVectorSuccess = 0
      for (const table of tableVectorTargets) {
        try {
          const res: any = await storeSingleTableVectorReq(projectIdRef.current, databaseIdRef.current, table.id)
          const generated = Number(res.data?.tables || 0)
          if (res.success && generated > 0) {
            tableVectorSuccess += generated
            setGenTableVectorCount(
              Math.min(baseTableVectorCount + tableVectorSuccess, tablesToProcess.length)
            )
          }
        } catch (error) {
          console.error(`生成表 ${table.table_name} 向量失败:`, error)
        }
      }
      setGeneratingTableVectors(false)

      // 列向量
      setGenColumnVectorCount(baseColumnVectorCount)
      setGenColumnVectorTotal(totalColumnVectorCount)
      setGeneratingColumnVectors(true)
      let columnVectorSuccess = 0
      for (const table of columnVectorTargets) {
        try {
          const res: any = await storeTableColumnsVectorReq(projectIdRef.current, databaseIdRef.current, table.id)
          const generated = Number(res.data?.columns || 0)
          if (res.success && generated > 0) {
            columnVectorSuccess += generated
            setGenColumnVectorCount(
              Math.min(baseColumnVectorCount + columnVectorSuccess, totalColumnVectorCount)
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
        message: t('database.guide.metadata.allGenerateComplete', {
          vectorSuccess: Math.min(baseTableVectorCount + tableVectorSuccess, tablesToProcess.length),
          total: tablesToProcess.length
        })
      })

      try {
        await clearSyncPendingReq(projectIdRef.current, databaseIdRef.current)
        await loadSyncPendingInfo()
      } catch (error) {
        console.warn('清除Redis待处理表信息失败:', error)
      }

      // 刷新当前选中表的列数据
      if (currentTableRef.current) {
        await handleRefreshFromStructure()
      }
    } catch (e) {
      notifications.show({ color: 'red', message: t('database.guide.metadata.generateProcessError') })
    } finally {
      resetAllGeneratingStates()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getPendingTableIds, loadTables, loadSyncPendingInfo, handleRefreshFromStructure, t])

  // ── 一键生成所有描述（入口：弹确认框） ───────────────────────
  const handleGenerateAll = useCallback(() => {
    if (tablesRef.current.length === 0) {
      notifications.show({ color: 'yellow', message: t('database.guide.metadata.noTableData') })
      return
    }

    modals.openConfirmModal({
      title: t('database.guide.metadata.confirmGenerate'),
      children: t('database.guide.metadata.generateAllConfirmMsg'),
      labels: {
        confirm: t('database.guide.metadata.confirmGenerateBtn'),
        cancel: t('common.cancel')
      },
      onConfirm: () => {
        void runGenerateAll()
      }
    })
  }, [runGenerateAll, t])

  // ── 批量生成列描述和表描述 ──────────────────────────────────
  const handleBatchGenerateColumnDesc = useCallback(async () => {
    if (tablesRef.current.length === 0 || isAnyOperationRunningRef.current) return

    try {
      setGeneratingColumnDesc(true)
      generatingColumnDescRef.current = true
      setGeneratingTableDesc(true)
      generatingTableDescRef.current = true
      const tableIds = await getPendingTableIds()

      const res: any = await generateColumnsDescriptionsReq(
        projectIdRef.current,
        databaseIdRef.current,
        tableIds,
        2,
        false
      )

      if (res.success && res.data) {
        const { columns_generated, tables_generated, details } = res.data
        const failedTables = (details || [])
          .filter((r: any) => !r.success || r.error)
          .map((r: any) => r.table_name)
          .join('、')
        if (failedTables) {
          notifications.show({
            color: 'yellow',
            message: t('database.guide.metadata.descGeneratedWithFailures', {
              columns: columns_generated,
              tables: tables_generated,
              failed: failedTables
            })
          })
        } else {
          notifications.show({
            color: 'green',
            message: t('database.guide.metadata.descGenerated', {
              columns: columns_generated,
              tables: tables_generated
            })
          })
        }

        try {
          await clearSyncPendingReq(projectIdRef.current, databaseIdRef.current)
          await loadSyncPendingInfo()
        } catch (error) {
          console.warn('清除Redis待处理表信息失败:', error)
        }
      } else {
        throw new Error(res.msg || t('database.guide.metadata.batchGenerateFailed'))
      }
    } catch (error: any) {
      console.error('批量生成列描述和表描述失败:', error)
      notifications.show({
        color: 'red',
        message:
          t('database.guide.metadata.generateError') +
          (error.message || t('database.guide.metadata.unknownError'))
      })
    } finally {
      setGeneratingColumnDesc(false)
      generatingColumnDescRef.current = false
      setGeneratingTableDesc(false)
      generatingTableDescRef.current = false
      await loadTables()
      if (currentTableRef.current) {
        await handleRefreshFromStructure()
      }
    }
  }, [getPendingTableIds, loadTables, loadSyncPendingInfo, handleRefreshFromStructure, t])
  // 保留 handleBatchGenerateColumnDesc 业务逻辑（原组件内定义但模板未直接调用）
  void handleBatchGenerateColumnDesc

  // ── 生成数据库描述 ──────────────────────────────────────────
  const handleGenerateDatabaseDescription = useCallback(async () => {
    if (tablesRef.current.length === 0) {
      notifications.show({ color: 'yellow', message: t('database.guide.metadata.noTableData') })
      return
    }

    try {
      setGeneratingDatabaseDesc(true)
      const res: any = await generateDatabaseDescriptionReq(projectIdRef.current, databaseIdRef.current)
      if (res.success && res.data) {
        setDatabaseWithDescription(true)
        const desc = res.data.description || databaseDescriptionRef.current
        setDatabaseDescription(desc)
        databaseDescriptionRef.current = desc
        notifications.show({ color: 'green', message: t('database.guide.metadata.dbDescGenerateComplete') })
      } else {
        throw new Error(res.msg || t('database.guide.metadata.dbDescGenerateFailed'))
      }
    } catch (error: any) {
      console.error('生成数据库描述失败:', error)
      notifications.show({
        color: 'yellow',
        message: error.message || t('database.guide.metadata.dbDescGenerateFailed')
      })
    } finally {
      setGeneratingDatabaseDesc(false)
      await loadTables()
    }
  }, [loadTables, t])

  // ── 向量生成（确认后主流程） ─────────────────────────────────
  const runGenerateAllVectors = useCallback(
    async (tablesToProcess: any[]) => {
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
            const res: any = await storeSingleTableVectorReq(projectIdRef.current, databaseIdRef.current, table.id)
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
              projectIdRef.current,
              databaseIdRef.current,
              table.id
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
            total: tablesToProcess.length
          })
        })

        try {
          await clearSyncPendingReq(projectIdRef.current, databaseIdRef.current)
          await loadSyncPendingInfo()
        } catch (error) {
          console.warn('清除Redis待处理表信息失败:', error)
        }
      } catch (e) {
        // User cancelled / 其它异常
      } finally {
        setGeneratingTableVectors(false)
        setGeneratingColumnVectors(false)
      }
    },
    [loadTables, loadSyncPendingInfo, t]
  )

  // ── 向量生成（入口：弹确认框） ───────────────────────────────
  const handleGenerateAllVectors = useCallback(async () => {
    if (tablesRef.current.length === 0 || isAnyOperationRunningRef.current) return
    const tableIds = await getPendingTableIds()
    const tablesToProcess = tablesRef.current.filter((tb: any) => tableIds.includes(tb.id))

    modals.openConfirmModal({
      title: t('database.guide.advanced.confirmGenerate'),
      children: t('database.guide.advanced.confirmGenerateAllVectors', { count: tablesToProcess.length }),
      labels: {
        confirm: t('database.guide.advanced.confirmGenerateBtn'),
        cancel: t('common.cancel')
      },
      onConfirm: () => {
        void runGenerateAllVectors(tablesToProcess)
      }
    })
  }, [getPendingTableIds, runGenerateAllVectors, t])

  // ── 上一步 / 下一步 ─────────────────────────────────────────
  const handlePrev = useCallback(() => {
    onPrev?.()
  }, [onPrev])

  const handleNext = useCallback(() => {
    onStepCompleted?.()
  }, [onStepCompleted])

  // ── 重置所有生成状态 ────────────────────────────────────────
  const resetAllGeneratingStates = useCallback(() => {
    setGeneratingAll(false)
    setGeneratingColumnDesc(false)
    generatingColumnDescRef.current = false
    setGeneratingTableDesc(false)
    generatingTableDescRef.current = false
    setGeneratingDatabaseDesc(false)
    setGeneratingTableVectors(false)
    setGeneratingColumnVectors(false)
  }, [])

  // isAnyOperationRunning 的 ref 镜像（供异步处理器读取）
  const isAnyOperationRunningRef = useRef(isAnyOperationRunning)
  useEffect(() => {
    isAnyOperationRunningRef.current = isAnyOperationRunning
  }, [isAnyOperationRunning])

  // ── 初始化（对应 onMounted） ────────────────────────────────
  useEffect(() => {
    let cancelled = false
    const init = async () => {
      resetAllGeneratingStates()
      await loadSyncPendingInfo()
      await loadTables()

      // 延迟刷新一次，确保获取到最新数据
      setTimeout(async () => {
        if (!cancelled) await loadTables()
      }, 800)
    }
    void init()

    // 组件卸载时重置状态（对应 onBeforeUnmount）
    return () => {
      cancelled = true
      resetAllGeneratingStates()
      if (dbDescBlurTimer.current) clearTimeout(dbDescBlurTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── 监听 databaseId 变化（跳过首次挂载） ─────────────────────
  const didMountRef = useRef(false)
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true
      return
    }
    if (databaseId) {
      const onChange = async () => {
        resetAllGeneratingStates()
        setCurrentTable(null)
        currentTableRef.current = null
        await loadSyncPendingInfo()
        await loadTables()
      }
      void onChange()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databaseId])

  // ── 渲染 ────────────────────────────────────────────────────
  const tableKeysOrIdsLen = (() => {
    if (!syncPendingInfo) return 0
    return (syncPendingInfo.table_keys || syncPendingInfo.table_ids || []).length
  })()

  return (
    <div
      className={[styles['guide-step-metadata'], standalone ? styles.standalone : '']
        .filter(Boolean)
        .join(' ')}
    >
      {/* 顶部概览区 */}
      <div className={styles['overview-section']}>
        {/* 标题行 */}
        <div className={styles['overview-header']}>
          <div className={styles['title-block']}>
            {!standalone && <span className={styles['step-badge']}>Step 5</span>}
            <h2 className={styles['step-title']}>{t('database.guide.metadata.title')}</h2>
          </div>
          <div className={styles['header-right']}>
            {!standalone && (
              <div className={styles['skip-tip']}>
                <span className={styles['el-icon']}>
                  <IconInfoCircleFilled size={13} />
                </span>
                <span>{t('database.guide.metadata.skipTip')}</span>
              </div>
            )}
            <button
              className={[
                styles['generate-all-btn'],
                generatingAll ? styles.loading : '',
                isAllCompleted && !generatingAll ? styles.done : ''
              ]
                .filter(Boolean)
                .join(' ')}
              disabled={tables.length === 0 || isAnyOperationRunning}
              onClick={handleGenerateAll}
            >
              <span className={styles['gen-btn-icon']}>
                {!generatingAll ? <IconWand size={18} /> : <span className={styles['spin-ring']}></span>}
              </span>
              <span className={styles['gen-btn-text']}>
                {generatingAll
                  ? t('database.guide.metadata.generatingAll')
                  : isAllCompleted
                  ? t('database.guide.metadata.regenerateAll')
                  : t('database.guide.metadata.generateAll')}
              </span>
            </button>
          </div>
        </div>

        {/* 内容行：数据库描述 + 进度卡片 + 生成按钮 */}
        <div className={styles['overview-body']}>
          {/* 数据库描述 */}
          <div className={[styles['db-desc-card'], dbDescFocused ? styles.focused : ''].filter(Boolean).join(' ')}>
            <div className={styles['card-label']}>
              <span className={styles['label-dot']}></span>
              {t('database.guide.metadata.dbDescription')}
            </div>
            <Textarea
              className={styles['desc-textarea']}
              value={databaseDescription}
              onChange={(e) => {
                setDatabaseDescription(e.currentTarget.value)
                databaseDescriptionRef.current = e.currentTarget.value
              }}
              autosize
              minRows={2}
              maxRows={4}
              disabled={generatingDatabaseDesc}
              placeholder={t('database.guide.metadata.dbDescPlaceholder')}
              onFocus={() => setDbDescFocused(true)}
              onBlur={handleDbDescBlur}
            />
            <div className={styles['db-desc-bottom']}>
              <button
                className={[styles['ai-chip-btn'], generatingDatabaseDesc ? styles.loading : '']
                  .filter(Boolean)
                  .join(' ')}
                disabled={tables.length === 0 || isAnyOperationRunning}
                onClick={handleGenerateDatabaseDescription}
              >
                <span className={styles['ai-chip-icon']}>
                  {!generatingDatabaseDesc ? <IconWand size={13} /> : <span className={styles['spin-dot']}></span>}
                </span>
                <span>
                  {generatingDatabaseDesc
                    ? t('database.guide.metadata.generatingShort')
                    : t('database.guide.metadata.aiGenerate')}
                </span>
              </button>
              {(dbDescFocused || savingDbDesc) && (
                <button
                  className={styles['save-chip-btn']}
                  disabled={savingDbDesc}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    handleSaveDatabaseDescription()
                  }}
                >
                  {savingDbDesc && <span className={styles['spin-dot-sm']}></span>}
                  <span>
                    {savingDbDesc ? t('database.guide.metadata.saving') : t('database.action.save')}
                  </span>
                </button>
              )}
            </div>
          </div>

          {/* 进度统计 */}
          <div className={styles['progress-cards']}>
            <div
              className={[
                styles['prog-card'],
                styles['prog-card-wide'],
                isColumnDescCompleted && isTableDescCompleted ? styles.done : '',
                generatingColumnDesc || generatingTableDesc ? styles.running : ''
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <div className={styles['prog-card-top']}>
                <span className={styles['prog-label']}>{t('database.guide.metadata.columnTableDesc')}</span>
                {(generatingColumnDesc || generatingTableDesc) && (
                  <span className={styles['prog-status-hint']}>
                    <span className={styles['spin-dot-xs']}></span>
                    <span>{t('database.guide.metadata.generatingShort')}</span>
                  </span>
                )}
              </div>
              <div className={styles['prog-dual-bars']}>
                <div className={styles['prog-bar-row']}>
                  <span className={styles['prog-bar-label']}>{t('database.guide.metadata.column')}</span>
                  <div className={styles['prog-bar-track']}>
                    <div
                      className={styles['prog-bar-fill']}
                      style={{
                        width:
                          pendingColumnsCount > 0
                            ? (columnsWithDescription / pendingColumnsCount) * 100 + '%'
                            : '0%'
                      }}
                    ></div>
                  </div>
                  <span className={styles['prog-bar-num']}>
                    {columnsWithDescription}/{pendingColumnsCount}
                  </span>
                </div>
                <div className={styles['prog-bar-row']}>
                  <span className={styles['prog-bar-label']}>{t('database.guide.metadata.table')}</span>
                  <div className={styles['prog-bar-track']}>
                    <div
                      className={styles['prog-bar-fill']}
                      style={{
                        width:
                          pendingTablesCount > 0
                            ? (tablesWithDescription / pendingTablesCount) * 100 + '%'
                            : '0%'
                      }}
                    ></div>
                  </div>
                  <span className={styles['prog-bar-num']}>
                    {tablesWithDescription}/{pendingTablesCount}
                  </span>
                </div>
              </div>
            </div>

            <div
              className={[
                styles['prog-card'],
                isDatabaseDescCompleted ? styles.done : '',
                generatingDatabaseDesc ? styles.running : ''
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <div className={styles['prog-card-top']}>
                <span className={styles['prog-label']}>{t('database.guide.metadata.dbDesc')}</span>
                {generatingDatabaseDesc && (
                  <span className={styles['prog-status-hint']}>
                    <span className={styles['spin-dot-xs']}></span>
                    <span>{t('database.guide.metadata.generatingShort')}</span>
                  </span>
                )}
              </div>
              <div className={styles['prog-bar-track']}>
                <div
                  className={styles['prog-bar-fill']}
                  style={{ width: isDatabaseDescCompleted ? '100%' : '0%' }}
                ></div>
              </div>
              <div className={styles['prog-count']}>
                {isDatabaseDescCompleted
                  ? t('database.guide.metadata.completed')
                  : t('database.guide.metadata.notGenerated')}
              </div>
            </div>

            {/* 向量进度卡片 */}
            <div
              className={[
                styles['prog-card'],
                styles['prog-card-wide'],
                allVectorsCompleted ? styles.done : '',
                generatingVectors ? styles.running : ''
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <div className={styles['prog-card-top']}>
                <span className={styles['prog-label']}>{t('database.guide.advanced.schemaVectors')}</span>
                <button
                  className={[
                    styles['ai-chip-btn'],
                    styles['ai-chip-btn-sm'],
                    generatingVectors ? styles.loading : ''
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  disabled={tables.length === 0 || isAnyOperationRunning}
                  onClick={handleGenerateAllVectors}
                >
                  <span className={styles['ai-chip-icon']}>
                    {!generatingVectors ? <IconBox size={11} /> : <span className={styles['spin-dot-xs']}></span>}
                  </span>
                  <span>
                    {generatingVectors
                      ? t('database.guide.advanced.generating')
                      : t('database.guide.advanced.generate')}
                  </span>
                </button>
              </div>
              {(vectorPendingTablesCount > 0 || vectorPendingColumnsCount > 0) && (
                <div className={styles['prog-dual-bars']}>
                  <div className={styles['prog-bar-row']}>
                    <span className={styles['prog-bar-label']}>
                      {t('database.guide.advanced.tableVectorShort')}
                    </span>
                    <div className={styles['prog-bar-track']}>
                      <div
                        className={styles['prog-bar-fill']}
                        style={{ width: tableVectorProgressPercentage + '%' }}
                      ></div>
                    </div>
                    <span className={styles['prog-bar-num']}>
                      {tablesWithVectors}/{vectorPendingTablesCount}
                    </span>
                  </div>
                  <div className={styles['prog-bar-row']}>
                    <span className={styles['prog-bar-label']}>
                      {t('database.guide.advanced.columnVectorShort')}
                    </span>
                    <div className={styles['prog-bar-track']}>
                      <div
                        className={styles['prog-bar-fill']}
                        style={{ width: columnVectorProgressPercentage + '%' }}
                      ></div>
                    </div>
                    <span className={styles['prog-bar-num']}>
                      {columnsWithVectors}/{vectorPendingColumnsCount}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Redis 同步表信息 */}
        {syncPendingInfo && (
          <div className={styles['sync-notice']}>
            <span className={styles['el-icon']}>
              <IconInfoCircleFilled size={12} />
            </span>
            <span>
              {syncPendingInfo.is_full_sync
                ? t('database.guide.metadata.fullSyncMode')
                : t('database.guide.metadata.tableSyncMode')}
              {tableKeysOrIdsLen > 0 && (
                <> · {t('database.guide.metadata.pendingTables', { count: tableKeysOrIdsLen })}</>
              )}
            </span>
          </div>
        )}
      </div>

      {/* 主体区：表列表 / ER 关系图 */}
      <div className={styles['table-structure-section']}>
        {standalone && graphContent && (
          <div className={styles['body-view-switch']}>
            <div className={styles['view-switcher']}>
              <button
                className={`${styles['switcher-btn']} ${bodyViewMode === 'table' ? styles.active : ''}`}
                onClick={() => setBodyViewMode('table')}
              >
                <ElSvgIcon name="Grid" size={14} />
                <span>{t('project.database.tableView')}</span>
              </button>
              <button
                className={`${styles['switcher-btn']} ${bodyViewMode === 'er' ? styles.active : ''}`}
                onClick={() => setBodyViewMode('er')}
              >
                <ElSvgIcon name="Share" size={14} />
                <span>{t('project.database.erView')}</span>
              </button>
              <div
                className={`${styles['switcher-indicator']} ${
                  bodyViewMode === 'er' ? styles['at-er'] : ''
                }`}
              ></div>
            </div>
          </div>
        )}

        {bodyViewMode === 'table' && (
          <div className={styles['table-structure-wrapper']}>
            <TableStructureView
              databaseId={databaseId}
              tables={tables}
              totalTables={tables.length}
              currentTable={currentTable}
              isFromGuide={true}
              onTableChange={handleTableChange}
              onRefresh={handleRefreshFromStructure}
              onOpenEditDialog={handleOpenEditDialog}
              onLoadColumns={handleLoadColumns}
            />
          </div>
        )}

        {graphContent && bodyViewMode === 'er' && (
          <div className={styles['er-graph-wrapper']}>{graphContent}</div>
        )}
      </div>

      {/* 底部导航（向导模式下显示） */}
      {!standalone && (
        <div className={styles['step-footer']}>
          {!isFirstStep && (
            <button className={[styles['nav-btn'], styles['nav-btn-ghost']].join(' ')} onClick={handlePrev}>
              <span className={styles['el-icon']}>
                <IconArrowLeft size={14} />
              </span>
              {t('database.action.prev')}
            </button>
          )}
          <div className={styles['footer-spacer']}></div>
          <button
            className={[
              styles['nav-btn'],
              styles['nav-btn-primary'],
              isAnyOperationRunning ? styles.disabled : ''
            ]
              .filter(Boolean)
              .join(' ')}
            disabled={isAnyOperationRunning}
            onClick={handleNext}
          >
            {t('database.guide.metadata.nextAdvanced')}
            <span className={styles['el-icon']}>
              <IconArrowRight size={14} />
            </span>
          </button>
        </div>
      )}

      {/* 编辑表对话框 */}
      <TableEditDialog
        opened={editDialogVisible}
        onClose={() => setEditDialogVisible(false)}
        table={editingTable}
        databaseId={databaseId}
        onSaved={handleAfterTableEditSaved}
      />
    </div>
  )
}
