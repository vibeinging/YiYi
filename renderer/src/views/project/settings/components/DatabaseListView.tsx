import { useState, useEffect, useRef } from 'react'
import { Button, Badge, Modal, LoadingOverlay } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import { useTranslation } from 'react-i18next'
import ElSvgIcon from '@/components/ElSvgIcon'
import { databaseListReq, deleteDatabaseReq } from '@/api/database'
import DatabaseDetail from './DatabaseDetail'
import DatabaseSetupGuide from '@/views/database/components/DatabaseSetupGuide'
import styles from './DatabaseListView.module.scss'

interface DatabaseListViewProps {
  projectId?: string
  initialSelectedItem?: any
  initialItemId?: string
  // defineEmits(['item-selected', 'selection-change'])
  onItemSelected?: () => void
  onSelectionChange?: (id: string | null) => void
}

// EP el-tag type → Mantine Badge color
const TAG_TYPE_TO_COLOR: Record<string, string> = {
  primary: 'blue',
  success: 'green',
  danger: 'red',
  warning: 'orange',
  info: 'gray'
}

export default function DatabaseListView({
  projectId = '',
  initialSelectedItem = null,
  initialItemId = '',
  onItemSelected,
  onSelectionChange
}: DatabaseListViewProps) {
  const { t } = useTranslation()

  const [loading, setLoading] = useState(false)
  const [dataList, setDataList] = useState<any[]>([])
  const [selectedItem, setSelectedItem] = useState<any>(null)
  const [guideDialogVisible, setGuideDialogVisible] = useState(false)

  // dataList 最新值用 ref 暴露给异步闭包(loadList 后立即查找)
  const dataListRef = useRef<any[]>([])
  dataListRef.current = dataList

  // 格式化日期
  const formatDate = (dateStr: any) => {
    if (!dateStr) return '-'
    const date = new Date(dateStr)
    return date.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    })
  }

  // 名称展示：最多 8 个字，超出用省略号
  const getDisplayName = (name: any) => {
    if (!name) return ''
    const maxLength = 8
    // 直接按字符长度截断，中文/英文统一按 1 计
    return name.length > maxLength ? `${name.slice(0, maxLength)}...` : name
  }

  // 数据库类型标签颜色
  const getDbTypeTagType = (dbType: any) => {
    const typeMap: Record<string, string> = {
      MySQL: 'primary',
      PostgreSQL: 'success',
      Oracle: 'danger',
      SQLServer: 'warning',
      SQLite: 'info',
      OpenGauss: 'success',
      ClickHouse: 'warning'
    }
    return typeMap[dbType] || 'info'
  }

  // 加载列表
  const loadList = async (autoSelectId: any = null) => {
    if (!projectId) return

    setLoading(true)
    try {
      const res: any = await databaseListReq(projectId)
      const items = res.data?.items || []
      setDataList(items)
      dataListRef.current = items

      // 根据 ID 自动选中
      if (autoSelectId) {
        const found = items.find((item: any) => item.id === autoSelectId)
        if (found) {
          setSelectedItem(found)
        }
      }
    } catch (err) {
      console.error('Load list failed:', err)
      notifications.show({ color: 'red', message: t('project.database.loadListFailed') })
    } finally {
      setLoading(false)
    }
  }

  // 选择项目
  const selectItem = (item: any) => {
    setSelectedItem(item)
    onSelectionChange?.(item?.id || null)
  }

  // 返回列表
  const backToList = () => {
    setSelectedItem(null)
    onSelectionChange?.(null)
    loadList()
  }

  // 开始创建
  const startCreate = () => {
    setGuideDialogVisible(true)
  }

  // 取消创建
  const cancelCreate = () => {
    setGuideDialogVisible(false)
  }

  // 向导中创建了数据库
  const handleDatabaseCreatedInGuide = async (_database: any) => {
    // 刷新列表
    await loadList()
  }

  // 向导完成
  const handleGuideFinish = async (database: any) => {
    setGuideDialogVisible(false)
    await loadList()

    if (database) {
      // 向导完成后进入详情页（非向导模式）
      const found = dataListRef.current.find((item: any) => item.id === database.id)
      if (found) {
        setSelectedItem(found)
      }
    }
  }

  // 删除
  const handleDelete = (item: any) => {
    modals.openConfirmModal({
      title: t('project.database.deleteConfirm'),
      children: t('project.database.deleteConfirmMsg', { name: item.name }),
      labels: { confirm: t('common.confirm'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await deleteDatabaseReq(projectId, item.id)
          notifications.show({ color: 'green', message: t('project.database.deleteSuccess') })
          await loadList()
        } catch (err: any) {
          console.error('删除失败:', err)
          // 检查是否已经有错误消息（axios拦截器已经显示），如果有就不显示通用错误
          const errorMessage =
            err?.response?.data?.message || err?.response?.data?.msg || err?.message || err?.msg
          if (!errorMessage) {
            notifications.show({ color: 'red', message: t('project.database.deleteFailed') })
          }
        }
      }
    })
  }

  // 更新
  const handleItemUpdated = async (updatedItem: any) => {
    await loadList()
    const found = dataListRef.current.find((item: any) => item.id === updatedItem.id)
    if (found) {
      setSelectedItem(found)
    }
  }

  // 从详情页删除
  const handleItemDeleted = async (database: any) => {
    try {
      await deleteDatabaseReq(projectId, database.id)
      notifications.show({ color: 'green', message: t('project.database.deleteSuccess') })
      setSelectedItem(null)
      onSelectionChange?.(null)
      await loadList()
    } catch (err: any) {
      console.error('删除失败:', err)
      const errorMessage =
        err?.response?.data?.message || err?.response?.data?.msg || err?.message || err?.msg
      if (!errorMessage) {
        notifications.show({ color: 'red', message: t('project.database.deleteFailed') })
      }
    }
  }

  // 监听 projectId 变化（含首次加载，对应原 watch immediate）
  const prevProjectIdRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const newId = projectId
    const oldId = prevProjectIdRef.current
    prevProjectIdRef.current = newId
    if (newId) {
      // 首次加载且有 initialItemId 时自动选中
      const autoSelectId = !oldId && initialItemId ? initialItemId : null
      if (!autoSelectId) {
        setSelectedItem(null)
      }
      loadList(autoSelectId)
      setGuideDialogVisible(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // 监听 initialSelectedItem 变化（从业务配置跳转过来）
  useEffect(() => {
    if (initialSelectedItem) {
      setSelectedItem(initialSelectedItem)
      onItemSelected?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSelectedItem])

  return (
    <div className="ad-page-list">
      {/* 列表视图 */}
      {!selectedItem ? (
        <>
          {dataList.length > 0 && (
            <div className="ad-page-toolbar">
              <span className="toolbar-count">
                {t('project.database.totalConnections', { count: dataList.length })}
              </span>
              <div className="toolbar-actions">
                <Button onClick={startCreate} leftSection={<ElSvgIcon name="Plus" size={16} />}>
                  {t('project.database.createConnection')}
                </Button>
              </div>
            </div>
          )}

          <div className="ad-page-content ad-card-grid" style={{ position: 'relative' }}>
            <LoadingOverlay visible={loading} />
            {dataList.map((item) => (
              <div key={item.id} className="ad-grid-card" onClick={() => selectItem(item)}>
                <div className="grid-card-header">
                  <div className="grid-card-title">
                    <span title={item.name}>{getDisplayName(item.name)}</span>
                    <Badge color={TAG_TYPE_TO_COLOR[getDbTypeTagType(item.db_type)]} size="sm">
                      {item.db_type}
                    </Badge>
                  </div>
                  <div className="grid-card-actions" onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="subtle"
                      size="compact-sm"
                      onClick={() => selectItem(item)}
                      leftSection={<ElSvgIcon name="Edit" size={14} />}
                    >
                      {t('common.manage')}
                    </Button>
                    <Button
                      variant="subtle"
                      color="red"
                      size="compact-sm"
                      onClick={() => handleDelete(item)}
                      leftSection={<ElSvgIcon name="Delete" size={14} />}
                    >
                      {t('common.delete')}
                    </Button>
                  </div>
                </div>
                <div className="grid-card-body">
                  {item.description && <div className="grid-card-desc">{item.description}</div>}
                  {item.port && (
                    <div className="grid-card-info">
                      <span className="info-tag">
                        {item.host}:{item.port}
                      </span>
                      <span className="info-tag">{item.database}</span>
                    </div>
                  )}
                </div>
                <div className="grid-card-footer">
                  {t('project.database.createdAt', { date: formatDate(item.created_at) })}
                </div>
              </div>
            ))}

            {/* 空状态 */}
            {!loading && dataList.length === 0 && (
              <div className={`ad-page-empty ${styles.databaseEmpty}`}>
                <div className={styles.emptyIllustration}>
                  <div className={styles.illustrationContainer}>
                    <div className={`${styles.dbIcon} ${styles.mysql}`}>
                      <span className={styles.dbLabel}>MySQL</span>
                    </div>
                    <div className={`${styles.dbIcon} ${styles.pg}`}>
                      <span className={styles.dbLabel}>PG</span>
                    </div>
                    <div className={styles.centerHub}>
                      <ElSvgIcon name="Coin" size={26} color="#fff" />
                    </div>
                  </div>
                </div>
                <div className={styles.emptyContent}>
                  <h3 className={styles.emptyTitle}>
                    {t('project.database.createFirstConnection')}
                  </h3>
                  <p className={styles.emptyDesc}>{t('project.database.emptyDescription')}</p>
                  <div className={styles.emptyFeatures}>
                    <div className={styles.featureItem}>
                      <ElSvgIcon name="Connection" size={16} color="#17483e" />
                      <span>{t('project.database.featureMultiDb')}</span>
                    </div>
                    <div className={styles.featureItem}>
                      <ElSvgIcon name="Search" size={16} color="#17483e" />
                      <span>{t('project.database.featureNlQuery')}</span>
                    </div>
                    <div className={styles.featureItem}>
                      <ElSvgIcon name="DataLine" size={16} color="#17483e" />
                      <span>{t('project.database.featureSmartAnalysis')}</span>
                    </div>
                  </div>
                  <Button
                    size="lg"
                    onClick={startCreate}
                    leftSection={<ElSvgIcon name="Plus" size={18} />}
                  >
                    {t('project.database.createConnection')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </>
      ) : (
        /* 详情视图 */
        <DatabaseDetail
          projectId={projectId}
          database={selectedItem}
          onBack={backToList}
          onUpdated={handleItemUpdated}
          onDeleted={handleItemDeleted}
        />
      )}

      {/* 创建数据库向导 Dialog */}
      <Modal
        opened={guideDialogVisible}
        onClose={cancelCreate}
        withCloseButton={false}
        closeOnClickOutside={false}
        closeOnEscape={false}
        size="80%"
        padding={0}
        className={styles.guideDialog}
        styles={{ inner: { paddingTop: '3vh', alignItems: 'flex-start' } }}
      >
        {guideDialogVisible && (
          <DatabaseSetupGuide
            projectId={projectId}
            database={null}
            initialStep="select-type"
            onFinish={handleGuideFinish}
            onBack={cancelCreate}
            onDatabaseCreated={handleDatabaseCreatedInGuide}
            onDatabaseUpdated={handleItemUpdated}
          />
        )}
      </Modal>
    </div>
  )
}
