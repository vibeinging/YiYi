import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Modal } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import ElSvgIcon from '@/components/ElSvgIcon'
import {
  getBusinessDataSourcesReq,
  addDataSourceToBusinessReq,
  removeDataSourceFromBusinessReq,
} from '@/api/business'
import { databaseListReq } from '@/api/database'
import { listDataSourcesReq as listUnstructuredReq } from '@/api/unstructured_data_source'
import { listDataSourcesReq as listStructuredReq } from '@/api/structured_data_source'
import { listWebSearchModelsReq } from '@/api/web_search_models'
import { projectPath } from '@/utils/project-route'
import styles from './BusinessDataSources.module.scss'

export interface BusinessDataSourcesProps {
  projectId: string
  businessId: string
  onUpdated?: () => void
  onNavigateToDatasource?: (payload: { sourceType: string; item: any }) => void
}

interface DataSourcesState {
  database_connections: any[]
  unstructured_data_sources: any[]
  structured_data_sources: any[]
  web_search_models: any[]
}

type SourceType =
  | 'database_connection'
  | 'unstructured_data_source'
  | 'structured_data_source'
  | 'web_search_model'

export default function BusinessDataSources({
  projectId,
  businessId,
  onUpdated,
  onNavigateToDatasource,
}: BusinessDataSourcesProps) {
  const navigate = useNavigate()
  const { t } = useTranslation()

  const [dataSources, setDataSources] = useState<DataSourcesState>({
    database_connections: [],
    unstructured_data_sources: [],
    structured_data_sources: [],
    web_search_models: [],
  })

  const [addDialogVisible, setAddDialogVisible] = useState(false)
  const [adding, setAdding] = useState(false)

  // 所有可用数据源
  const [allDatabaseSources, setAllDatabaseSources] = useState<any[]>([])
  const [allUnstructuredSources, setAllUnstructuredSources] = useState<any[]>([])
  const [allStructuredSources, setAllStructuredSources] = useState<any[]>([])
  const [allWebSearchModels, setAllWebSearchModels] = useState<any[]>([])

  // 选中的数据源（database/unstructured/structured 多选用 Set，web_search 单选用 id|null）
  const [selectedDatabase, setSelectedDatabase] = useState<Set<any>>(new Set())
  const [selectedUnstructured, setSelectedUnstructured] = useState<Set<any>>(new Set())
  const [selectedStructured, setSelectedStructured] = useState<Set<any>>(new Set())
  const [selectedWebSearch, setSelectedWebSearch] = useState<any>(null)

  // 计算总数
  const totalDataSources = useMemo(() => {
    return (
      (dataSources.database_connections?.length || 0) +
      (dataSources.unstructured_data_sources?.length || 0) +
      (dataSources.structured_data_sources?.length || 0) +
      (dataSources.web_search_models?.length || 0)
    )
  }, [dataSources])

  // 已选择数量
  const selectedCount = useMemo(() => {
    return (
      selectedDatabase.size +
      selectedUnstructured.size +
      selectedStructured.size +
      (selectedWebSearch ? 1 : 0)
    )
  }, [selectedDatabase, selectedUnstructured, selectedStructured, selectedWebSearch])

  // 加载业务关联的数据源
  const loadDataSources = async () => {
    try {
      const res: any = await getBusinessDataSourcesReq(projectId)
      setDataSources(
        res.data || {
          database_connections: [],
          unstructured_data_sources: [],
          structured_data_sources: [],
          web_search_models: [],
        }
      )
    } catch (error) {
      console.error('Failed to load data sources:', error)
      notifications.show({ color: 'red', message: t('business.dataSources.loadFailed') })
    }
  }

  // 加载所有可用数据源
  const loadAllSources = async () => {
    try {
      const [dbRes, unstructuredRes, structuredRes, webSearchRes]: any = await Promise.all([
        databaseListReq(projectId, undefined),
        listUnstructuredReq(projectId),
        listStructuredReq(projectId),
        listWebSearchModelsReq(projectId),
      ])

      setAllDatabaseSources(dbRes.data?.items || [])
      setAllUnstructuredSources(unstructuredRes.data?.items || [])
      setAllStructuredSources(structuredRes.data?.items || [])
      setAllWebSearchModels(webSearchRes.data?.items || [])
    } catch (error) {
      console.error('Failed to load available data sources:', error)
      notifications.show({ color: 'red', message: t('business.dataSources.loadAvailableFailed') })
    }
  }

  // 清空选择
  const clearSelection = () => {
    setSelectedDatabase(new Set())
    setSelectedUnstructured(new Set())
    setSelectedStructured(new Set())
    setSelectedWebSearch(null)
  }

  // 显示添加对话框
  const showAddDialog = async () => {
    setAddDialogVisible(true)
    clearSelection()
    await loadAllSources()
  }

  // 检查是否已经添加
  const isAlreadyAdded = (sourceType: SourceType, sourceId: any) => {
    if (sourceType === 'database_connection') {
      return dataSources.database_connections?.some((s) => s.id === sourceId)
    } else if (sourceType === 'unstructured_data_source') {
      return dataSources.unstructured_data_sources?.some((s) => s.id === sourceId)
    } else if (sourceType === 'structured_data_source') {
      return dataSources.structured_data_sources?.some((s) => s.id === sourceId)
    } else if (sourceType === 'web_search_model') {
      return dataSources.web_search_models?.some((s) => s.id === sourceId)
    }
    return false
  }

  // 检查是否选中
  const isSelected = (sourceType: SourceType, sourceId: any) => {
    if (sourceType === 'web_search_model') {
      return selectedWebSearch === sourceId
    }
    if (sourceType === 'database_connection') return selectedDatabase.has(sourceId)
    if (sourceType === 'unstructured_data_source') return selectedUnstructured.has(sourceId)
    if (sourceType === 'structured_data_source') return selectedStructured.has(sourceId)
    return false
  }

  // 切换选中状态
  const toggleSelect = (sourceType: SourceType, sourceId: any) => {
    if (isAlreadyAdded(sourceType, sourceId)) return

    if (sourceType === 'web_search_model') {
      // 网络搜索数据源为单选模式
      setSelectedWebSearch((prev: any) => (prev === sourceId ? null : sourceId))
      return
    }

    // 其他数据源为多选模式
    const setterMap: Record<string, React.Dispatch<React.SetStateAction<Set<any>>>> = {
      database_connection: setSelectedDatabase,
      unstructured_data_source: setSelectedUnstructured,
      structured_data_source: setSelectedStructured,
    }
    const setter = setterMap[sourceType]
    setter((prev) => {
      const next = new Set(prev)
      if (next.has(sourceId)) {
        next.delete(sourceId)
      } else {
        next.add(sourceId)
      }
      return next
    })
  }

  // 批量添加数据源
  const handleBatchAdd = async () => {
    if (selectedCount === 0) {
      notifications.show({ color: 'yellow', message: t('business.dataSources.selectAtLeastOne') })
      return
    }

    try {
      setAdding(true)

      // 收集所有要添加的数据源
      const addPromises: Promise<any>[] = []

      selectedDatabase.forEach((id) => {
        addPromises.push(
          addDataSourceToBusinessReq(projectId, {
            source_type: 'database_connection',
            source_id: id,
          })
        )
      })

      selectedUnstructured.forEach((id) => {
        addPromises.push(
          addDataSourceToBusinessReq(projectId, {
            source_type: 'unstructured_data_source',
            source_id: id,
          })
        )
      })

      selectedStructured.forEach((id) => {
        addPromises.push(
          addDataSourceToBusinessReq(projectId, {
            source_type: 'structured_data_source',
            source_id: id,
          })
        )
      })

      // 网络搜索数据源为单选
      if (selectedWebSearch) {
        addPromises.push(
          addDataSourceToBusinessReq(projectId, {
            source_type: 'web_search_model',
            source_id: selectedWebSearch,
          })
        )
      }

      // 并发添加所有数据源
      await Promise.all(addPromises)

      notifications.show({
        color: 'green',
        message: t('business.dataSources.addSuccess', { count: selectedCount }),
      })
      setAddDialogVisible(false)
      clearSelection()
      await loadDataSources()
      onUpdated?.()
    } catch (error: any) {
      console.error('Failed to batch add data sources:', error)
      notifications.show({
        color: 'red',
        message: error.response?.data?.message || t('business.dataSources.addFailed'),
      })
    } finally {
      setAdding(false)
    }
  }

  // 移除数据源
  const handleRemove = (sourceType: SourceType, sourceId: any) => {
    modals.openConfirmModal({
      title: t('business.dataSources.confirmRemoveTitle'),
      children: t('business.dataSources.confirmRemoveMsg'),
      labels: {
        confirm: t('business.dataSources.confirm'),
        cancel: t('business.dataSources.cancel'),
      },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await removeDataSourceFromBusinessReq(projectId, {
            source_type: sourceType,
            source_id: sourceId,
          })
          notifications.show({ color: 'green', message: t('business.dataSources.removeSuccess') })
          await loadDataSources()
          onUpdated?.()
        } catch (error: any) {
          console.error('Failed to remove data source:', error)
          notifications.show({
            color: 'red',
            message: error.response?.data?.message || t('business.dataSources.removeFailed'),
          })
        }
      },
    })
  }

  // 跳转到数据源详情
  const navigateToDataSource = (sourceType: string, item: any) => {
    // 如果是虚拟连接（有关联的结构化数据源），跳转到结构化数据源
    if (sourceType === 'database' && item.linked_structured_data_source) {
      onNavigateToDatasource?.({
        sourceType: 'structured',
        item: {
          id: item.linked_structured_data_source.id,
          name: item.linked_structured_data_source.name,
        },
      })
    } else {
      onNavigateToDatasource?.({ sourceType, item })
    }
  }

  // 跳转到创建数据库页面
  const goToCreateDatabase = () => {
    navigate(`${projectPath('settings')}#database`)
    setAddDialogVisible(false)
  }

  // 跳转到创建结构化数据源页面
  const goToCreateStructured = () => {
    navigate(`${projectPath('settings')}#structured`)
    setAddDialogVisible(false)
  }

  // 跳转到创建非结构化数据源页面
  const goToCreateUnstructured = () => {
    navigate(`${projectPath('settings')}#unstructured`)
    setAddDialogVisible(false)
  }

  // 跳转到创建Web搜索模型页面
  const goToCreateWebSearch = () => {
    navigate(`${projectPath('settings')}#websearch`)
    setAddDialogVisible(false)
  }

  // 监听业务ID变化（immediate）
  useEffect(() => {
    if (businessId) {
      loadDataSources()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId])

  // 渲染一个可选数据源卡片（对话框内）
  const renderSourceCard = (
    source: any,
    sourceType: SourceType,
    iconName: string,
    iconVariant: '' | 'structured' | 'unstructured' | 'web',
    details: React.ReactNode
  ) => {
    const selected = isSelected(sourceType, source.id)
    const disabled = isAlreadyAdded(sourceType, source.id)
    return (
      <div
        key={source.id}
        className={[
          styles.sourceCard,
          selected ? styles.selected : '',
          disabled ? styles.disabled : '',
        ]
          .filter(Boolean)
          .join(' ')}
        onClick={() => toggleSelect(sourceType, source.id)}
      >
        <div className={styles.cardCheckbox}>
          <div className={`${styles.checkboxBox} ${selected ? styles.checked : ''}`}>
            {selected && <ElSvgIcon name="Check" size={12} />}
          </div>
        </div>
        <div className={styles.cardContent}>
          <div className={styles.cardHeader}>
            <div className={`${styles.cardIcon} ${iconVariant ? styles[iconVariant] : ''}`}>
              <ElSvgIcon name={iconName} size={12} />
            </div>
            <div className={styles.cardName}>{source.name}</div>
          </div>
          <div className={styles.cardDetails}>{details}</div>
        </div>
        {disabled && (
          <div className={styles.cardBadge}>
            <Badge size="sm" color="gray" variant="light">
              {t('business.dataSources.alreadyLinked')}
            </Badge>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={styles.businessDataSourcesContainer}>
      <div className={styles.sectionHeader}>
        <h3>{t('business.dataSources.title')}</h3>
        <Button
          size="sm"
          leftSection={<ElSvgIcon name="Plus" size={16} />}
          onClick={showAddDialog}
        >
          {t('business.dataSources.batchAdd')}
        </Button>
      </div>

      {/* 已关联数据源列表 - 统一展示 */}
      <div className={styles.dataSourceList}>
        {/* 数据库连接 */}
        {dataSources.database_connections?.map((item) => (
          <div
            key={`db-${item.id}`}
            className={`${styles.dataSourceCard} ${styles.clickable}`}
            onClick={() => navigateToDataSource('database', item)}
          >
            <div
              className={`${styles.cardIcon} ${
                item.linked_structured_data_source ? styles.structured : styles.database
              }`}
            >
              {item.linked_structured_data_source ? (
                <ElSvgIcon name="Grid" size={24} />
              ) : (
                <ElSvgIcon name="Coin" size={24} />
              )}
            </div>
            <div className={styles.cardContent}>
              <div className={styles.cardTitle}>
                {item.linked_structured_data_source
                  ? item.linked_structured_data_source.name
                  : item.name}
              </div>
              <div className={styles.cardMeta}>
                {item.linked_structured_data_source ? (
                  <>
                    <Badge size="sm" color="yellow" variant="light">
                      {t('business.dataSources.tabularData')}
                    </Badge>
                    <Badge size="sm" color="gray" variant="light">
                      {t('business.dataSources.virtualConnection')}
                    </Badge>
                  </>
                ) : (
                  <>
                    <Badge size="sm" color="yiw" variant="light">
                      {t('business.dataSources.database')}
                    </Badge>
                    <Badge size="sm" color="gray" variant="light">
                      {item.db_type}
                    </Badge>
                  </>
                )}
              </div>
              {item.linked_structured_data_source ? (
                <div className={styles.cardDesc}>
                  {t('business.dataSources.linkedDuckDB')}: {item.name}
                </div>
              ) : (
                item.description && <div className={styles.cardDesc}>{item.description}</div>
              )}
            </div>
            <Button
              className={styles.removeBtn}
              color="red"
              size="compact-sm"
              variant="subtle"
              onClick={(e) => {
                e.stopPropagation()
                handleRemove('database_connection', item.id)
              }}
            >
              <ElSvgIcon name="Close" size={16} />
            </Button>
          </div>
        ))}

        {/* 非结构化数据源 */}
        {dataSources.unstructured_data_sources?.map((item) => (
          <div
            key={`unstructured-${item.id}`}
            className={`${styles.dataSourceCard} ${styles.clickable}`}
            onClick={() => navigateToDataSource('unstructured', item)}
          >
            <div className={`${styles.cardIcon} ${styles.unstructured}`}>
              <ElSvgIcon name="Document" size={24} />
            </div>
            <div className={styles.cardContent}>
              <div className={styles.cardTitle}>{item.name}</div>
              <div className={styles.cardMeta}>
                <Badge size="sm" color="green" variant="light">
                  {t('business.dataSources.unstructured')}
                </Badge>
              </div>
              {item.description && <div className={styles.cardDesc}>{item.description}</div>}
            </div>
            <Button
              className={styles.removeBtn}
              color="red"
              size="compact-sm"
              variant="subtle"
              onClick={(e) => {
                e.stopPropagation()
                handleRemove('unstructured_data_source', item.id)
              }}
            >
              <ElSvgIcon name="Close" size={16} />
            </Button>
          </div>
        ))}

        {/* 结构化数据源 */}
        {dataSources.structured_data_sources?.map((item) => (
          <div
            key={`structured-${item.id}`}
            className={`${styles.dataSourceCard} ${styles.clickable}`}
            onClick={() => navigateToDataSource('structured', item)}
          >
            <div className={`${styles.cardIcon} ${styles.structured}`}>
              <ElSvgIcon name="Folder" size={24} />
            </div>
            <div className={styles.cardContent}>
              <div className={styles.cardTitle}>{item.name}</div>
              <div className={styles.cardMeta}>
                <Badge size="sm" color="yellow" variant="light">
                  {t('business.dataSources.structured')}
                </Badge>
              </div>
              {item.description && <div className={styles.cardDesc}>{item.description}</div>}
            </div>
            <Button
              className={styles.removeBtn}
              color="red"
              size="compact-sm"
              variant="subtle"
              onClick={(e) => {
                e.stopPropagation()
                handleRemove('structured_data_source', item.id)
              }}
            >
              <ElSvgIcon name="Close" size={16} />
            </Button>
          </div>
        ))}

        {/* Web数据源 */}
        {dataSources.web_search_models?.map((item) => (
          <div
            key={`web-${item.id}`}
            className={`${styles.dataSourceCard} ${styles.clickable}`}
            onClick={() => navigateToDataSource('web', item)}
          >
            <div className={`${styles.cardIcon} ${styles.web}`}>
              <ElSvgIcon name="Search" size={24} />
            </div>
            <div className={styles.cardContent}>
              <div className={styles.cardTitle}>{item.name}</div>
              <div className={styles.cardMeta}>
                <Badge size="sm" color="gray" variant="light">
                  {t('business.dataSources.webDataSource')}
                </Badge>
                <Badge size="sm" color="yiw" variant="light">
                  {item.model}
                </Badge>
              </div>
              {item.description && <div className={styles.cardDesc}>{item.description}</div>}
            </div>
            <Button
              className={styles.removeBtn}
              color="red"
              size="compact-sm"
              variant="subtle"
              onClick={(e) => {
                e.stopPropagation()
                handleRemove('web_search_model', item.id)
              }}
            >
              <ElSvgIcon name="Close" size={16} />
            </Button>
          </div>
        ))}

        {/* 空状态 */}
        {totalDataSources === 0 && (
          <div className={styles.emptyWrap}>
            <div style={{ textAlign: 'center', color: '#909399', padding: '20px 0' }}>
              {t('business.dataSources.emptyDescription')}
            </div>
          </div>
        )}
      </div>

      {/* 批量添加数据源对话框 */}
      <Modal
        opened={addDialogVisible}
        onClose={() => setAddDialogVisible(false)}
        title=""
        size={900}
        withCloseButton
        closeOnClickOutside={false}
      >
        <div className={styles.addDialogContent}>
          {/* 头部 */}
          <div className={styles.dialogHeader}>
            <div className={styles.headerIcon}>
              <ElSvgIcon name="Plus" size={24} color="#fff" />
            </div>
            <div className={styles.headerText}>
              <h3>{t('business.dataSources.addDataSource')}</h3>
              <p>{t('business.dataSources.addDataSourceDesc')}</p>
            </div>
          </div>

          {/* 数据库连接 */}
          <div className={styles.sourceSection}>
            <div className={styles.sectionTitle}>
              <div className={`${styles.titleIcon} ${styles.database}`}>
                <ElSvgIcon name="Coin" size={16} />
              </div>
              <span>{t('business.dataSources.databaseConnection')}</span>
              <span className={styles.countBadge}>{allDatabaseSources.length}</span>
            </div>
            {allDatabaseSources.length > 0 ? (
              <div className={styles.sourceGrid}>
                {allDatabaseSources.map((source) =>
                  renderSourceCard(
                    source,
                    'database_connection',
                    'Coin',
                    '',
                    <Badge size="sm" color="yiw" variant="outline">
                      {source.db_type}
                    </Badge>
                  )
                )}
              </div>
            ) : (
              <div className={styles.emptySectionWithAction}>
                <div className={styles.emptyIcon}>
                  <ElSvgIcon name="Coin" size={22} />
                </div>
                <p>{t('business.dataSources.noDatabaseConnection')}</p>
                <Button
                  className={styles.createBtn}
                  variant="subtle"
                  leftSection={<ElSvgIcon name="Plus" size={14} />}
                  onClick={goToCreateDatabase}
                >
                  {t('business.dataSources.goToCreate')}
                </Button>
              </div>
            )}
          </div>

          {/* 结构化数据源 */}
          <div className={styles.sourceSection}>
            <div className={styles.sectionTitle}>
              <div className={`${styles.titleIcon} ${styles.structured}`}>
                <ElSvgIcon name="Grid" size={16} />
              </div>
              <span>{t('business.dataSources.tabularData')}</span>
              <span className={styles.countBadge}>{allStructuredSources.length}</span>
            </div>
            {allStructuredSources.length > 0 ? (
              <div className={styles.sourceGrid}>
                {allStructuredSources.map((source) =>
                  renderSourceCard(
                    source,
                    'structured_data_source',
                    'Grid',
                    'structured',
                    source.file_count !== undefined ? (
                      <Badge size="sm" color="yellow" variant="outline">
                        {t('business.dataSources.fileCount', { count: source.file_count })}
                      </Badge>
                    ) : (
                      <Badge size="sm" color="yellow" variant="outline">
                        Excel/CSV
                      </Badge>
                    )
                  )
                )}
              </div>
            ) : (
              <div className={styles.emptySectionWithAction}>
                <div className={`${styles.emptyIcon} ${styles.structured}`}>
                  <ElSvgIcon name="Grid" size={22} />
                </div>
                <p>{t('business.dataSources.noTabularData')}</p>
                <Button
                  className={styles.createBtn}
                  variant="subtle"
                  leftSection={<ElSvgIcon name="Plus" size={14} />}
                  onClick={goToCreateStructured}
                >
                  {t('business.dataSources.goToImport')}
                </Button>
              </div>
            )}
          </div>

          {/* 非结构化数据源 */}
          <div className={styles.sourceSection}>
            <div className={styles.sectionTitle}>
              <div className={`${styles.titleIcon} ${styles.unstructured}`}>
                <ElSvgIcon name="Document" size={16} />
              </div>
              <span>{t('business.dataSources.documents')}</span>
              <span className={styles.countBadge}>{allUnstructuredSources.length}</span>
            </div>
            {allUnstructuredSources.length > 0 ? (
              <div className={styles.sourceGrid}>
                {allUnstructuredSources.map((source) =>
                  renderSourceCard(
                    source,
                    'unstructured_data_source',
                    'Document',
                    'unstructured',
                    source.file_count !== undefined ? (
                      <Badge size="sm" color="green" variant="outline">
                        {t('business.dataSources.fileCount', { count: source.file_count })}
                      </Badge>
                    ) : (
                      <Badge size="sm" color="green" variant="outline">
                        {t('business.dataSources.document')}
                      </Badge>
                    )
                  )
                )}
              </div>
            ) : (
              <div className={styles.emptySectionWithAction}>
                <div className={`${styles.emptyIcon} ${styles.unstructured}`}>
                  <ElSvgIcon name="Document" size={22} />
                </div>
                <p>{t('business.dataSources.noDocuments')}</p>
                <Button
                  className={styles.createBtn}
                  variant="subtle"
                  leftSection={<ElSvgIcon name="Plus" size={14} />}
                  onClick={goToCreateUnstructured}
                >
                  {t('business.dataSources.goToImport')}
                </Button>
              </div>
            )}
          </div>

          {/* Web数据源 */}
          <div className={styles.sourceSection}>
            <div className={styles.sectionTitle}>
              <div className={`${styles.titleIcon} ${styles.web}`}>
                <ElSvgIcon name="Search" size={16} />
              </div>
              <span>{t('business.dataSources.webDataSource')}</span>
              <Badge size="sm" color="yellow" variant="outline" className={styles.singleSelectHint}>
                {t('business.dataSources.singleSelectHint')}
              </Badge>
              <span className={styles.countBadge}>{allWebSearchModels.length}</span>
            </div>
            {allWebSearchModels.length > 0 ? (
              <div className={styles.sourceGrid}>
                {allWebSearchModels.map((source) =>
                  renderSourceCard(
                    source,
                    'web_search_model',
                    'Search',
                    'web',
                    <Badge size="sm" color="gray" variant="outline">
                      {source.model}
                    </Badge>
                  )
                )}
              </div>
            ) : (
              <div className={styles.emptySectionWithAction}>
                <div className={`${styles.emptyIcon} ${styles.web}`}>
                  <ElSvgIcon name="Search" size={22} />
                </div>
                <p>{t('business.dataSources.noWebDataSource')}</p>
                <Button
                  className={styles.createBtn}
                  variant="subtle"
                  leftSection={<ElSvgIcon name="Plus" size={14} />}
                  onClick={goToCreateWebSearch}
                >
                  {t('business.dataSources.goToCreate')}
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* footer */}
        <div className={styles.dialogFooter}>
          <div className={styles.selectionSummary}>
            {t('business.dataSources.selectedCount', { count: selectedCount })}
          </div>
          <div className={styles.footerActions}>
            <Button variant="default" size="md" onClick={() => setAddDialogVisible(false)}>
              {t('business.dataSources.cancel')}
            </Button>
            <Button
              size="md"
              loading={adding}
              disabled={selectedCount === 0}
              onClick={handleBatchAdd}
            >
              {t('business.dataSources.confirmAdd')}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
