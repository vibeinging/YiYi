import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ActionIcon, Badge, Button, TextInput } from '@mantine/core'
import ElSvgIcon from '@/components/ElSvgIcon'
import styles from './UnstructuredDataSourceSidebar.module.scss'

interface DataSourceItem {
  id: string | number
  name: string
  description?: string
  embedding_model_name?: string
  embedding_model?: { name?: string }
  [k: string]: any
}

export interface UnstructuredDataSourceSidebarProps {
  // 由父级 composable 提供的数据源状态(dataSourceList / selectedDataSource / isCollapsed / getDataSourceList)
  dataSourceState: any
  onSelectDataSource?: (dataSource: DataSourceItem) => void
  onCreateDataSource?: () => void
}

export default function UnstructuredDataSourceSidebar({
  dataSourceState,
  onSelectDataSource,
  onCreateDataSource
}: UnstructuredDataSourceSidebarProps) {
  const { t } = useTranslation()

  // 从父级状态中取值。源里是 Vue ref(.value),迁移到 React 这里直接读取当前值。
  const rawSelectedDataSource = dataSourceState?.selectedDataSource
  const rawIsCollapsed = dataSourceState?.isCollapsed
  const dataSourceList: DataSourceItem[] = Array.isArray(dataSourceState?.dataSourceList)
    ? dataSourceState.dataSourceList
    : dataSourceState?.dataSourceList?.value ?? []
  const selectedDataSource: DataSourceItem | null =
    rawSelectedDataSource && typeof rawSelectedDataSource === 'object' && 'value' in rawSelectedDataSource
      ? rawSelectedDataSource.value
      : rawSelectedDataSource ?? null
  const isCollapsed: boolean =
    rawIsCollapsed && typeof rawIsCollapsed === 'object' && 'value' in rawIsCollapsed
      ? rawIsCollapsed.value
      : Boolean(rawIsCollapsed)

  // 简单的本地搜索状态
  const [localSearchKeyword, setLocalSearchKeyword] = useState('')

  const localFilteredList = useMemo<DataSourceItem[]>(() => {
    if (!localSearchKeyword.trim()) {
      return dataSourceList
    }
    const keyword = localSearchKeyword.toLowerCase()
    return dataSourceList.filter(
      (ds) =>
        ds.name.toLowerCase().includes(keyword) ||
        (ds.embedding_model_name && ds.embedding_model_name.toLowerCase().includes(keyword)) ||
        (ds.description && ds.description.toLowerCase().includes(keyword))
    )
  }, [localSearchKeyword, dataSourceList])

  const handleSearch = () => {
    // 搜索已通过 localFilteredList(派生值) 自动处理
  }

  // 处理数据源点击
  const handleDataSourceClick = (dataSource: DataSourceItem) => {
    onSelectDataSource?.(dataSource)
  }

  // 组件挂载时获取数据源列表
  useEffect(() => {
    dataSourceState?.getDataSourceList?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className={`${styles.dataSourceSidebar} ${isCollapsed ? styles.collapsed : ''}`}>
      <div className={styles.sidebarHeader}>
        <div className={styles.title}>{t('unstructuredData.sidebar.title')}</div>
        <TextInput
          className={styles.searchInput}
          value={localSearchKeyword}
          placeholder={t('unstructuredData.sidebar.searchPlaceholder')}
          onChange={(e) => setLocalSearchKeyword(e.currentTarget.value)}
          onKeyUp={(e) => {
            if (e.key === 'Enter') handleSearch()
          }}
          rightSection={
            <ActionIcon
              variant="subtle"
              color="gray"
              className={styles.searchIcon}
              onClick={handleSearch}
            >
              <ElSvgIcon name="Search" size={16} />
            </ActionIcon>
          }
        />
      </div>

      <div className={styles.dataSourceList}>
        {localFilteredList.map((item) => (
          <div
            key={item.id}
            data-testid="unstructured-datasource-item"
            data-source-id={item.id}
            data-source-name={item.name}
            className={`${styles.dataSourceItem} ${
              selectedDataSource?.id === item.id ? styles.active : ''
            }`}
            onClick={() => handleDataSourceClick(item)}
          >
            <div className={styles.dsInfo}>
              <div className={styles.dsIcon}>
                <ElSvgIcon name="Collection" size={32} color="var(--el-color-primary)" />
              </div>
              <div className={styles.dsContent}>
                <div className={styles.dsName}>{item.name}</div>
                {item.description && <div className={styles.dsExtra}>{item.description}</div>}
                <div className={styles.dsModel}>
                  <Badge size="sm" color="green">
                    {item.embedding_model_name ||
                      item.embedding_model?.name ||
                      t('unstructuredData.sidebar.unknownModel')}
                  </Badge>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* 底部新建按钮 */}
      <div className={styles.sidebarFooter}>
        <Button data-testid="unstructured-create-button" className={styles.createBtn} color="primary" onClick={() => onCreateDataSource?.()}>
          {t('unstructuredData.sidebar.createButton')}
        </Button>
      </div>
    </div>
  )
}
