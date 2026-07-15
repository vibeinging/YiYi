import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Modal,
  Group,
  TextInput,
  Select,
  Badge,
  Button,
  Pagination,
  LoadingOverlay,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useTranslation } from 'react-i18next'
import ElSvgIcon from '@/components/ElSvgIcon'
import { panelApi } from '@/api/dashboard'
import styles from './PanelSelector.module.scss'

export interface PanelSelectorProps {
  /** 对话框是否可见 */
  visible?: boolean
  /** 目标 Dashboard ID */
  dashboardId?: string
  /** 项目 ID(必填) */
  projectId: string
  /** v-model:visible → 回调 */
  onUpdateVisible?: (val: boolean) => void
  /** select 事件 → 回调,返回新增的 panel 数据 */
  onSelect?: (data: any) => void
}

const pageSize = 10

// 获取类型图标(返回 Element Plus 图标名,交给 ElSvgIcon 渲染)
const getTypeIcon = (type: string): string => {
  const icons: Record<string, string> = {
    table: 'Grid',
    bar: 'TrendCharts',
    line: 'DataLine',
    pie: 'PieChart',
    custom: 'Setting',
  }
  return icons[type] || 'Grid'
}

// 获取类型颜色
const getTypeColor = (type: string): string => {
  const colors: Record<string, string> = {
    table: '#409eff',
    bar: '#67c23a',
    line: '#e6a23c',
    pie: '#f56c6c',
    custom: '#909399',
  }
  return colors[type] || '#409eff'
}

// 获取类型标签类型 → Mantine Badge color
const getTypeTagColor = (type: string): string => {
  const colors: Record<string, string> = {
    table: 'gray',
    bar: 'green',
    line: 'yellow',
    pie: 'red',
    custom: 'blue',
  }
  return colors[type] || 'gray'
}

export default function PanelSelector({
  visible = false,
  dashboardId = '',
  projectId,
  onUpdateVisible,
  onSelect,
}: PanelSelectorProps) {
  const { t } = useTranslation()

  const [dialogVisible, setDialogVisible] = useState(false)
  const [loading, setLoading] = useState(false)
  const [panels, setPanels] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [searchQuery, setSearchQuery] = useState('')
  const [filterType, setFilterType] = useState<string>('')
  const [selectedPanelId, setSelectedPanelId] = useState<any>(null)
  const [, setSelectedPanel] = useState<any>(null)

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 加载 Panel 列表
  const loadPanels = async (page = currentPage) => {
    setLoading(true)
    try {
      const response: any = await panelApi.getPanelList(projectId, {
        page,
        per_page: pageSize,
        search: searchQuery || undefined,
        form_type: filterType || undefined,
      })

      if (response.data) {
        setPanels(response.data.panels || [])
        setTotal(response.data.total || 0)
      }
    } catch (error) {
      console.error('加载Panel列表失败:', error)
      notifications.show({ color: 'red', message: t('dashboardMgmt.panelLib.loadFailed') })
    } finally {
      setLoading(false)
    }
  }

  // 监听 visible 变化:同步内部可见状态,并在打开时加载列表
  useEffect(() => {
    setDialogVisible(visible)
    if (visible) {
      loadPanels()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  // 监听 dialogVisible 变化同步到父组件
  useEffect(() => {
    onUpdateVisible?.(dialogVisible)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogVisible])

  // 搜索处理(防抖)
  const handleSearch = (val: string) => {
    setSearchQuery(val)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => {
      setCurrentPage(1)
      loadPanels(1)
    }, 300)
  }

  // 筛选处理
  const handleFilter = (val: string | null) => {
    const next = val || ''
    setFilterType(next)
    setCurrentPage(1)
    // 用最新值重新加载(state 更新异步,这里直接构造请求参数)
    setLoading(true)
    panelApi
      .getPanelList(projectId, {
        page: 1,
        per_page: pageSize,
        search: searchQuery || undefined,
        form_type: next || undefined,
      })
      .then((response: any) => {
        if (response.data) {
          setPanels(response.data.panels || [])
          setTotal(response.data.total || 0)
        }
      })
      .catch((error: any) => {
        console.error('加载Panel列表失败:', error)
        notifications.show({ color: 'red', message: t('dashboardMgmt.panelLib.loadFailed') })
      })
      .finally(() => setLoading(false))
  }

  // 分页切换
  const handlePageChange = (page: number) => {
    setCurrentPage(page)
    loadPanels(page)
  }

  // 选择 Panel
  const selectPanel = (panel: any) => {
    if (selectedPanelId === panel.id) {
      setSelectedPanelId(null)
      setSelectedPanel(null)
    } else {
      setSelectedPanelId(panel.id)
      setSelectedPanel(panel)
    }
  }

  // 关闭对话框
  const handleClose = () => {
    setDialogVisible(false)
    setSelectedPanelId(null)
    setSelectedPanel(null)
    setSearchQuery('')
    setFilterType('')
  }

  // 确认选择
  const handleConfirm = async () => {
    if (!selectedPanelId || !dashboardId) return

    try {
      setLoading(true)
      const response: any = await panelApi.copyToDashboard(projectId, selectedPanelId, dashboardId)

      if (response.data) {
        notifications.show({ color: 'green', message: t('dashboardMgmt.msg.panelAdded') })
        onSelect?.(response.data)
        handleClose()
      }
    } catch (error) {
      console.error('添加Panel失败:', error)
      notifications.show({ color: 'red', message: t('dashboardMgmt.msg.addPanelFailed') })
    } finally {
      setLoading(false)
    }
  }

  // 获取类型名称
  const getTypeName = (type: string): string => {
    const names: Record<string, string> = {
      table: t('dashboardMgmt.panelLib.typeTable'),
      bar: t('dashboardMgmt.panelLib.typeBar'),
      line: t('dashboardMgmt.panelLib.typeLine'),
      pie: t('dashboardMgmt.panelLib.typePie'),
      custom: t('dashboardMgmt.editor.displayCustom'),
    }
    return names[type] || t('dashboardMgmt.panelLib.typeUnknown')
  }

  // 格式化日期
  const formatDate = (dateString?: string): string => {
    if (!dateString) return '--'
    const date = new Date(dateString)
    if (isNaN(date.getTime())) return '--'
    return date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const typeOptions = useMemo(
    () => [
      { value: 'table', label: t('dashboardMgmt.panelLib.typeTable') },
      { value: 'bar', label: t('dashboardMgmt.panelLib.typeBar') },
      { value: 'line', label: t('dashboardMgmt.panelLib.typeLine') },
      { value: 'pie', label: t('dashboardMgmt.panelLib.typePie') },
      { value: 'custom', label: t('dashboardMgmt.editor.displayCustom') },
    ],
    [t],
  )

  return (
    <Modal
      opened={dialogVisible}
      onClose={handleClose}
      title={t('dashboardMgmt.selector.title')}
      size={800}
      closeOnClickOutside={false}
    >
      {/* 搜索和筛选 */}
      <div className={styles.selectorHeader}>
        <TextInput
          value={searchQuery}
          placeholder={t('dashboardMgmt.panelLib.searchPlaceholder')}
          leftSection={<ElSvgIcon name="Search" size={16} />}
          style={{ width: 300 }}
          onChange={(e) => handleSearch(e.currentTarget.value)}
        />
        <Select
          value={filterType || null}
          placeholder={t('dashboardMgmt.selector.typeFilter')}
          clearable
          style={{ width: 120, marginLeft: 12 }}
          data={typeOptions}
          onChange={handleFilter}
        />
      </div>

      {/* Panel 列表 */}
      <div className={styles.panelList}>
        <LoadingOverlay visible={loading} />
        {panels.length === 0 ? (
          <div className={styles.emptyState}>
            <ElSvgIcon name="FolderOpened" size={48} color="#c0c4cc" />
            <p>{t('dashboardMgmt.selector.empty')}</p>
          </div>
        ) : (
          panels.map((panel) => (
            <div
              key={panel.id}
              className={`${styles.panelItem} ${selectedPanelId === panel.id ? styles.selected : ''}`}
              onClick={() => selectPanel(panel)}
            >
              <div className={styles.panelIcon}>
                <ElSvgIcon
                  name={getTypeIcon(panel.form_type)}
                  size={24}
                  color={getTypeColor(panel.form_type)}
                />
              </div>
              <div className={styles.panelInfo}>
                <div className={styles.panelTitle}>{panel.title}</div>
                <div className={styles.panelMeta}>
                  <Badge size="sm" color={getTypeTagColor(panel.form_type)}>
                    {getTypeName(panel.form_type)}
                  </Badge>
                  <span className={styles.updateTime}>{formatDate(panel.updated_at)}</span>
                </div>
              </div>
              {selectedPanelId === panel.id && (
                <div className={styles.panelCheck}>
                  <ElSvgIcon name="Check" color="var(--el-color-primary)" />
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* 分页 */}
      {total > pageSize && (
        <div className={styles.paginationWrapper}>
          <Pagination
            value={currentPage}
            total={Math.ceil(total / pageSize)}
            onChange={handlePageChange}
          />
        </div>
      )}

      {/* footer */}
      <Group justify="flex-end" mt="md">
        <Button variant="default" onClick={handleClose}>
          {t('common.cancel')}
        </Button>
        <Button color="blue" disabled={!selectedPanelId} onClick={handleConfirm}>
          {t('dashboardMgmt.selector.addToDashboard')}
        </Button>
      </Group>
    </Modal>
  )
}
