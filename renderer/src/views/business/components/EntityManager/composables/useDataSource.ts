/**
 * Data Source Composable
 * 数据源和表列加载
 */
// TODO(migration): @/api/structured_data_source/document 尚未迁移到 React 工程，
// 此处保持与源一致的 import 路径，待该 api 模块迁移后即可解析
import { useState, useMemo, useCallback } from 'react'
import { notifications } from '@mantine/notifications'
import { t } from '@/lang'
import { getCachedTablesReq, getTableColumnsReq as getDatabaseTableColumnsReq } from '@/api/database'
import { getDataSourceTablesReq } from '@/api/structured_data_source/document'
import { getBusinessDataSourcesReq } from '@/api/business'

export function useDataSource(projectId: any) {
  const [availableDataSources, setAvailableDataSources] = useState<any[]>([])
  const [selectedDataSource, setSelectedDataSource] = useState<any>(null)
  const [loadingDataSources, setLoadingDataSources] = useState(false)
  const [loadingTables, setLoadingTables] = useState(false)
  const [allTables, setAllTables] = useState<any[]>([])

  // 加载业务关联的数据源
  const loadAvailableDataSources = useCallback(async () => {
    try {
      setLoadingDataSources(true)
      const res = await getBusinessDataSourcesReq(projectId)
      if (res.success) {
        const sources: any[] = []
        // 添加数据库连接
        const dbConnections = res.data?.database_connections || []
        dbConnections.forEach((db: any) => {
          sources.push({
            id: db.id,
            name: db.name,
            type: 'database',
            db_type: db.db_type,
            description: db.description
          })
        })
        // 添加结构化数据源
        const structuredSources = res.data?.structured_data_sources || []
        structuredSources.forEach((ds: any) => {
          sources.push({
            id: ds.id,
            name: ds.name,
            type: 'structured',
            description: ds.description,
            database_connection_id: ds.database_connection_id // 从数据源级别获取
          })
        })
        setAvailableDataSources(sources)
        // 默认选第一个数据源
        if (sources.length > 0) {
          setSelectedDataSource(sources[0])
        } else {
          setSelectedDataSource(null)
        }
      }
    } catch (error) {
      console.error('加载数据源失败:', error)
      notifications.show({ color: 'red', message: t('business.entity.loadDataSourceFailed') })
    } finally {
      setLoadingDataSources(false)
    }
  }, [projectId])

  // 加载表列表（根据数据源类型）
  const loadTables = useCallback(async () => {
    if (!selectedDataSource) {
      setAllTables([])
      return
    }

    try {
      setLoadingTables(true)
      const source = selectedDataSource
      let res: any

      if (source.type === 'database') {
        res = await getCachedTablesReq(projectId, source.id)
      } else if (source.type === 'structured') {
        res = await getDataSourceTablesReq(projectId, source.id)
      }

      if (res?.success) {
        setAllTables(res.data.items || [])
      } else {
        setAllTables([])
      }
    } catch (error) {
      console.error('加载表列表失败:', error)
      notifications.show({ color: 'red', message: t('business.entity.loadTableListFailed') })
      setAllTables([])
    } finally {
      setLoadingTables(false)
    }
  }, [selectedDataSource, projectId])

  // 加载表列信息（根据数据源类型）
  const loadTableColumns = useCallback(
    async (tableId: any) => {
      if (!selectedDataSource) return []

      try {
        const source = selectedDataSource
        let connectionId = source.id

        // 结构化数据源从数据源级别获取 database_connection_id
        if (source.type === 'structured') {
          connectionId = source.database_connection_id || source.id
        }

        const res = await getDatabaseTableColumnsReq(projectId, connectionId, tableId)
        if (res?.success) {
          return res.data.items || []
        }
      } catch (error) {
        console.error('加载列信息失败:', error)
      }
      return []
    },
    [selectedDataSource, projectId]
  )

  // 数据源变更
  const handleDataSourceChange = useCallback(async (source: any) => {
    setSelectedDataSource(source)
    setAllTables([])
    // 注意：source 变更后由调用方负责触发 loadTables（或依赖 selectedDataSource 的 effect），
    // 此处先按源逻辑直接用新 source 加载表列表
    try {
      setLoadingTables(true)
      let res: any
      if (source?.type === 'database') {
        res = await getCachedTablesReq(projectId, source.id)
      } else if (source?.type === 'structured') {
        res = await getDataSourceTablesReq(projectId, source.id)
      }
      if (res?.success) {
        setAllTables(res.data.items || [])
      } else {
        setAllTables([])
      }
    } catch (error) {
      console.error('加载表列表失败:', error)
      notifications.show({ color: 'red', message: t('business.entity.loadTableListFailed') })
      setAllTables([])
    } finally {
      setLoadingTables(false)
    }
  }, [projectId])

  // 获取表对象
  const getTableById = useCallback(
    (tableId: any) => {
      return allTables.find((tb: any) => tb.id === tableId)
    },
    [allTables]
  )

  // 获取表名
  const getTableName = useCallback(
    (tableId: any) => {
      const table = getTableById(tableId)
      return table?.table_name || ''
    },
    [getTableById]
  )

  // 计算属性：当前选中的表名
  const activeTableName = useMemo(() => {
    return selectedDataSource?.name || ''
  }, [selectedDataSource])

  return {
    availableDataSources,
    selectedDataSource,
    loadingDataSources,
    loadingTables,
    allTables,
    activeTableName,
    loadAvailableDataSources,
    loadTables,
    loadTableColumns,
    handleDataSourceChange,
    getTableById,
    getTableName
  }
}
