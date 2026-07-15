import { useEffect, useMemo, useState, type ComponentType } from 'react'
import { useTranslation } from 'react-i18next'
import { useProjectStore, projectGetters } from '@/store/project'
import DocumentManagementRaw from '@/views/structured_data_source/components/DocumentManagement'
import DataSourceSettings from '@/views/structured_data_source/components/DataSourceSettings'
import { getDataSourceDetailReq } from '@/api/structured_data_source'
import DatabaseDetail, { type DatabaseDetailExtraTab } from './DatabaseDetail'

const DocumentManagement = DocumentManagementRaw as ComponentType<{
  dataSourceId: any
  onDocumentsProcessed?: () => void
}>

export interface StructuredDataSourceDetailProps {
  dataSource: any
  onBack?: () => void
  onUpdated?: (updatedDataSource: any) => void
  onDeleted?: () => void
}

export default function StructuredDataSourceDetail({
  dataSource,
  onBack,
  onUpdated,
  onDeleted
}: StructuredDataSourceDetailProps) {
  const { t } = useTranslation()
  const projectId = useProjectStore(projectGetters.currentProjectId) || ''

  const [currentDataSource, setCurrentDataSource] = useState<any>(dataSource)
  const [databaseConnectionId, setDatabaseConnectionId] = useState<string | null>(
    dataSource?.database_connection_id || null
  )
  const [refreshKey, setRefreshKey] = useState(0)

  const loadDataSourceDetail = async (force = false): Promise<string | null> => {
    if (!force && currentDataSource?.database_connection_id) {
      setDatabaseConnectionId(currentDataSource.database_connection_id)
      return currentDataSource.database_connection_id
    }
    if (!projectId || !currentDataSource?.id) return null

    try {
      const res: any = await getDataSourceDetailReq(projectId, currentDataSource.id)
      if (res?.success && res.data) {
        setCurrentDataSource((prev: any) => ({ ...prev, ...res.data }))
        const connectionId = res.data.database_connection_id || null
        setDatabaseConnectionId(connectionId)
        return connectionId
      }
    } catch (error) {
      console.error('Failed to get structured data source detail:', error)
    }
    return null
  }

  useEffect(() => {
    setCurrentDataSource(dataSource)
    setDatabaseConnectionId(dataSource?.database_connection_id || null)
  }, [dataSource])

  useEffect(() => {
    void loadDataSourceDetail()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, currentDataSource?.id])

  const handleDocumentsProcessed = async () => {
    await loadDataSourceDetail(true)
    setRefreshKey((key) => key + 1)
  }

  const handleUpdated = (updatedDataSource: any) => {
    const next = { ...currentDataSource, ...updatedDataSource }
    setCurrentDataSource(next)
    onUpdated?.(next)
  }

  const databaseForSharedDetail = useMemo(
    () => ({
      id: databaseConnectionId || '',
      name: currentDataSource?.name || dataSource?.name,
      db_type: 'DuckDB',
      database: currentDataSource?.duckdb_path || currentDataSource?.folder_path || '',
      description: currentDataSource?.description || '',
      created_at: currentDataSource?.created_at,
      updated_at: currentDataSource?.updated_at
    }),
    [
      currentDataSource?.created_at,
      currentDataSource?.description,
      currentDataSource?.duckdb_path,
      currentDataSource?.folder_path,
      currentDataSource?.name,
      currentDataSource?.updated_at,
      dataSource?.name,
      databaseConnectionId
    ]
  )

  const documentTab: DatabaseDetailExtraTab[] = [
    {
      value: 'documents',
      label: t('structuredData.tabs.files'),
      icon: 'Document',
      content: (
        <DocumentManagement
          dataSourceId={currentDataSource?.id}
          onDocumentsProcessed={handleDocumentsProcessed}
        />
      )
    }
  ]

  const subtitle = currentDataSource?.description || currentDataSource?.duckdb_path || t('router.structuredDataSource')

  return (
    <DatabaseDetail
      projectId={projectId}
      database={databaseForSharedDetail}
      onBack={onBack}
      onUpdated={handleUpdated}
      onDeleted={() => onDeleted?.()}
      initialTab="documents"
      beforeTabs={documentTab}
      settingsTabContent={
        <DataSourceSettings
          dataSource={currentDataSource}
          databaseConnectionId={databaseConnectionId}
          onUpdated={handleUpdated}
          onDeleted={onDeleted}
        />
      }
      settingsTabLabel={t('structuredData.tabs.settings')}
      headerTitle={currentDataSource?.name || dataSource?.name || t('router.structuredDataSource')}
      headerSubtitle={subtitle}
      headerIcon="Document"
      typeBadgeLabel="STRUCTURED"
      refreshKey={refreshKey}
      showDatabaseTabs={Boolean(databaseConnectionId)}
      showMetaSyncTab={false}
    />
  )
}
