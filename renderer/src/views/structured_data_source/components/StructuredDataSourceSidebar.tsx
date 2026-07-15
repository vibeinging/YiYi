import { useState, useMemo, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { TextInput, Button, Badge } from '@mantine/core'
import ElSvgIcon from '@/components/ElSvgIcon'
import styles from './StructuredDataSourceSidebar.module.scss'

// dataSourceState 来自 useStructuredDataSourceState() composable(已转 React)。
// 注意：迁移后该 state 字段为普通值而非 Vue ref：
//   dataSourceList: any[]、selectedDataSource: any、isCollapsed: boolean、getDataSourceList: () => void
interface StructuredDataSourceSidebarProps {
  dataSourceState: any
  /** defineEmits('select-data-source') */
  onSelectDataSource?: (dataSource: any) => void
  /** defineEmits('create-data-source') */
  onCreateDataSource?: () => void
}

export default function StructuredDataSourceSidebar({
  dataSourceState,
  onSelectDataSource,
  onCreateDataSource
}: StructuredDataSourceSidebarProps) {
  const { t } = useTranslation()

  // 使用状态管理
  const { dataSourceList, selectedDataSource, isCollapsed } = dataSourceState

  // 简单的本地搜索状态
  const [localSearchKeyword, setLocalSearchKeyword] = useState('')

  const localFilteredList = useMemo(() => {
    const list: any[] = dataSourceList || []
    if (!localSearchKeyword.trim()) {
      return list
    }
    const keyword = localSearchKeyword.toLowerCase()
    return list.filter(
      (ds) =>
        ds.name.toLowerCase().includes(keyword) ||
        (ds.embedding_model_name && ds.embedding_model_name.toLowerCase().includes(keyword)) ||
        (ds.description && ds.description.toLowerCase().includes(keyword))
    )
  }, [dataSourceList, localSearchKeyword])

  const handleSearch = () => {
    // 搜索已通过 useMemo 自动处理
  }

  // 处理数据源点击
  const handleDataSourceClick = (dataSource: any) => {
    onSelectDataSource?.(dataSource)
  }

  // 组件挂载时获取数据源列表
  useEffect(() => {
    dataSourceState.getDataSourceList?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className={`${styles.dataSourceSidebar} ${isCollapsed ? styles.collapsed : ''}`}>
      <div className={styles.sidebarHeader}>
        <div className={styles.title}>{t('structuredData.sidebar.title')}</div>
        <TextInput
          className={styles.searchInput}
          value={localSearchKeyword}
          placeholder={t('structuredData.sidebar.searchPlaceholder')}
          size="md"
          onChange={(e) => setLocalSearchKeyword(e.currentTarget.value)}
          onKeyUp={(e) => {
            if (e.key === 'Enter') handleSearch()
          }}
          rightSection={
            <span className={styles.searchIcon} onClick={handleSearch}>
              <ElSvgIcon name="Search" size={16} />
            </span>
          }
        />
      </div>

      <div className={styles.dataSourceList}>
        {localFilteredList.map((item: any) => (
          <div
            key={item.id}
            data-testid="structured-datasource-item"
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
                  <Badge size="sm" color="green" variant="light">
                    {item.embedding_model_name ||
                      item.embedding_model?.name ||
                      t('structuredData.sidebar.unknownModel')}
                  </Badge>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* 底部新建按钮 */}
      <div className={styles.sidebarFooter}>
        <Button
          data-testid="structured-create-button"
          className={styles.createBtn}
          size="md"
          color="primary"
          onClick={() => onCreateDataSource?.()}
        >
          {t('structuredData.sidebar.createButton')}
        </Button>
      </div>
    </div>
  )
}
