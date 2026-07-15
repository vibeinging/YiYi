import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Tabs } from '@mantine/core'
import ElSvgIcon from '@/components/ElSvgIcon'
import DocumentManagement from '@/views/unstructured_data_source/components/DocumentManagement'
import DocumentSearch from '@/views/unstructured_data_source/components/DocumentSearch'
import DataSourceSettings from '@/views/unstructured_data_source/components/DataSourceSettings'
import styles from './UnstructuredDataSourceDetail.module.scss'

// defineProps({ dataSource }) + defineEmits(['back', 'updated', 'deleted'])
export interface UnstructuredDataSourceDetailProps {
  dataSource: any
  onBack?: () => void
  onUpdated?: (updatedDataSource: any) => void
  onDeleted?: () => void
}

export default function UnstructuredDataSourceDetail({
  dataSource,
  onBack,
  onUpdated,
  onDeleted
}: UnstructuredDataSourceDetailProps) {
  const { t } = useTranslation()

  const [activeTab, setActiveTab] = useState('documents')

  const handleUpdated = (updatedDataSource: any) => {
    onUpdated?.(updatedDataSource)
  }

  const handleDeleted = () => {
    onDeleted?.()
  }

  return (
    <div className={styles['ad-detail-page']}>
      {/* 返回按钮 */}
      <div className={styles['ad-detail-page-header']}>
        <Button variant="subtle" onClick={() => onBack?.()} p={4}>
          <ElSvgIcon name="ArrowLeft" size={16} />
        </Button>
        <span className={styles['header-title']}>
          {dataSource?.name || t('project.dataSource.detail')}
        </span>
      </div>

      <div className={styles['ad-detail-page-content']}>
        <Tabs
          value={activeTab}
          onChange={(v) => setActiveTab(v || 'documents')}
          className={styles['ad-detail-tabs']}
        >
          <Tabs.List>
            {/* 文档管理 */}
            <Tabs.Tab value="documents" leftSection={<ElSvgIcon name="Document" size={14} />}>
              <span className={styles['ad-tab-label']}>
                {t('project.dataSource.documentManagement')}
              </span>
            </Tabs.Tab>
            {/* 搜索测试 */}
            <Tabs.Tab value="search" leftSection={<ElSvgIcon name="Search" size={14} />}>
              <span className={styles['ad-tab-label']}>{t('project.dataSource.searchTest')}</span>
            </Tabs.Tab>
            {/* 数据源设置 */}
            <Tabs.Tab value="settings" leftSection={<ElSvgIcon name="Setting" size={14} />}>
              <span className={styles['ad-tab-label']}>{t('project.dataSource.settings')}</span>
            </Tabs.Tab>
          </Tabs.List>

          {/* 文档管理 */}
          <Tabs.Panel value="documents">
            <DocumentManagement dataSourceId={dataSource.id} key="documents" />
          </Tabs.Panel>

          {/* 搜索测试 */}
          <Tabs.Panel value="search">
            <DocumentSearch dataSourceId={dataSource.id} key="search" />
          </Tabs.Panel>

          {/* 数据源设置 */}
          <Tabs.Panel value="settings">
            <DataSourceSettings
              dataSource={dataSource}
              onUpdated={handleUpdated}
              onDeleted={handleDeleted}
            />
          </Tabs.Panel>
        </Tabs>
      </div>
    </div>
  )
}
