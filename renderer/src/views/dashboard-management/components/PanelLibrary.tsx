import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Button, TextInput, Select, Pagination, LoadingOverlay } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import { useTranslation } from 'react-i18next'
import {
  IconTable,
  IconTrendingUp,
  IconChartLine,
  IconChartPie,
  IconFileText
} from '@tabler/icons-react'
import ElSvgIcon from '@/components/ElSvgIcon'
import type { TablerIcon } from '@/lib/icon-map'
import { panelApi } from '@/api/dashboard'
import styles from './PanelLibrary.module.scss'

interface PanelLibraryProps {
  visible?: boolean
  projectId: string
  // defineEmits(['update:visible', 'close'])
  onUpdateVisible?: (v: boolean) => void
  onClose?: () => void
}

const PAGE_SIZE = 10

export default function PanelLibrary({
  visible = false,
  projectId,
  onUpdateVisible,
  onClose
}: PanelLibraryProps) {
  const { t } = useTranslation()

  const [loading, setLoading] = useState(false)
  const [panels, setPanels] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [searchQuery, setSearchQuery] = useState('')
  const [filterType, setFilterType] = useState<string>('')

  // 拖拽状态
  const [isDragging, setIsDragging] = useState(false)
  const [dragPanel, setDragPanel] = useState<any>(null)
  const [mouseX, setMouseX] = useState(0)
  const [mouseY, setMouseY] = useState(0)

  // 用 ref 保存最新值，供 loadPanels / 防抖闭包使用
  const currentPageRef = useRef(currentPage)
  const searchQueryRef = useRef(searchQuery)
  const filterTypeRef = useRef(filterType)
  currentPageRef.current = currentPage
  searchQueryRef.current = searchQuery
  filterTypeRef.current = filterType

  // 加载 Panel 列表
  const loadPanels = useCallback(async () => {
    setLoading(true)
    try {
      const response: any = await panelApi.getPanelList(projectId, {
        page: currentPageRef.current,
        per_page: PAGE_SIZE,
        search: searchQueryRef.current || undefined,
        form_type: filterTypeRef.current || undefined
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
  }, [projectId, t])

  // 监听 visible（对应 watch immediate）
  useEffect(() => {
    if (visible) {
      loadPanels()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  // 搜索（防抖）
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleSearch = (val: string) => {
    setSearchQuery(val)
    searchQueryRef.current = val
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => {
      setCurrentPage(1)
      currentPageRef.current = 1
      loadPanels()
    }, 300)
  }

  // 筛选
  const handleFilter = (val: string) => {
    setFilterType(val)
    filterTypeRef.current = val
    setCurrentPage(1)
    currentPageRef.current = 1
    loadPanels()
  }

  // 分页切换
  const handlePageChange = (page: number) => {
    setCurrentPage(page)
    currentPageRef.current = page
    loadPanels()
  }

  // 关闭
  const handleClose = () => {
    onUpdateVisible?.(false)
    onClose?.()
  }

  // 更新鼠标位置
  const onDragOver = useCallback((e: DragEvent) => {
    setMouseX(e.clientX + 10)
    setMouseY(e.clientY + 10)
  }, [])

  // 拖拽开始
  const handleDragStart = (event: React.DragEvent, panel: any) => {
    setIsDragging(true)
    setDragPanel(panel)

    // 设置拖拽数据
    event.dataTransfer.setData(
      'application/json',
      JSON.stringify({
        type: 'panel',
        panelId: panel.id,
        panel: panel
      })
    )
    event.dataTransfer.effectAllowed = 'copy'

    // 隐藏默认拖拽图像
    const emptyImg = new Image()
    emptyImg.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
    event.dataTransfer.setDragImage(emptyImg, 0, 0)

    // 监听鼠标移动
    document.addEventListener('dragover', onDragOver)
  }

  // 拖拽结束
  const handleDragEnd = () => {
    setIsDragging(false)
    setDragPanel(null)
    document.removeEventListener('dragover', onDragOver)
  }

  // 清理
  useEffect(() => {
    return () => {
      document.removeEventListener('dragover', onDragOver)
    }
  }, [onDragOver])

  // 获取类型图标
  const getTypeIcon = (type: string): TablerIcon => {
    const icons: Record<string, TablerIcon> = {
      table: IconTable,
      bar: IconTrendingUp,
      line: IconChartLine,
      pie: IconChartPie,
      text: IconFileText
    }
    return icons[type] || IconFileText
  }

  // 获取类型颜色
  const getTypeColor = (type: string) => {
    const colors: Record<string, string> = {
      table: '#409eff',
      bar: '#67c23a',
      line: '#e6a23c',
      pie: '#f56c6c',
      text: '#909399'
    }
    return colors[type] || '#909399'
  }

  // 获取类型名称
  const getTypeName = (type: string) => {
    const names: Record<string, string> = {
      table: t('dashboardMgmt.panelLib.typeTable'),
      bar: t('dashboardMgmt.panelLib.typeBar'),
      line: t('dashboardMgmt.panelLib.typeLine'),
      pie: t('dashboardMgmt.panelLib.typePie'),
      text: t('dashboardMgmt.panelLib.typeText')
    }
    return names[type] || t('dashboardMgmt.panelLib.typeUnknown')
  }

  // 删除 Panel
  const handleDelete = (panel: any) => {
    modals.openConfirmModal({
      title: t('dashboardMgmt.msg.confirmDeleteTitle'),
      children: t('dashboardMgmt.panelLib.confirmDeleteMsg', { title: panel.title }),
      labels: { confirm: t('common.confirm'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await panelApi.deletePanel(projectId, panel.id)
          // 从列表中移除
          setPanels((prev) => prev.filter((p) => p.id !== panel.id))
          setTotal((prev) => Math.max(0, prev - 1))
          notifications.show({ color: 'green', message: t('dashboardMgmt.msg.panelDeleted') })

          // 如果当前页没有数据了，回到上一页
          if (panels.length - 1 === 0 && currentPageRef.current > 1) {
            const prevPage = currentPageRef.current - 1
            setCurrentPage(prevPage)
            currentPageRef.current = prevPage
            loadPanels()
          }
        } catch (error) {
          console.error('删除Panel失败:', error)
          notifications.show({ color: 'red', message: t('dashboardMgmt.msg.deleteFailed') })
        }
      }
    })
  }

  if (!visible) return null

  const typeCls: Record<string, string> = {
    table: styles.typeTable,
    bar: styles.typeBar,
    line: styles.typeLine,
    pie: styles.typePie,
    text: styles.typeText
  }

  return (
    <div
      className={styles.panelLibraryWrapper}
      onClick={(e) => {
        // @click.self
        if (e.target === e.currentTarget) handleClose()
      }}
    >
      <div className={styles.panelLibrary}>
        {/* 头部 */}
        <div className={styles.libraryHeader}>
          <span className={styles.title}>{t('dashboardMgmt.panelLib.title')}</span>
          <Button variant="subtle" color="gray" px={4} onClick={handleClose}>
            <ElSvgIcon name="Close" size={16} />
          </Button>
        </div>

        {/* 搜索和筛选 */}
        <div className={styles.libraryFilter}>
          <TextInput
            style={{ flex: 1, minWidth: 0 }}
            value={searchQuery}
            placeholder={t('dashboardMgmt.panelLib.searchPlaceholder')}
            leftSection={<ElSvgIcon name="Search" size={14} />}
            size="xs"
            onChange={(e) => handleSearch(e.currentTarget.value)}
          />
          <Select
            value={filterType || null}
            placeholder={t('dashboardMgmt.panelLib.typePlaceholder')}
            clearable
            size="xs"
            style={{ width: 90, marginLeft: 8 }}
            data={[
              { value: 'table', label: t('dashboardMgmt.panelLib.typeTable') },
              { value: 'bar', label: t('dashboardMgmt.panelLib.typeBar') },
              { value: 'line', label: t('dashboardMgmt.panelLib.typeLine') },
              { value: 'pie', label: t('dashboardMgmt.panelLib.typePie') }
            ]}
            onChange={(val) => handleFilter(val || '')}
          />
        </div>

        <div className={styles.libraryTip}>
          <ElSvgIcon name="InfoFilled" size={14} />
          <span>{t('dashboardMgmt.panelLib.dragTip')}</span>
        </div>

        {/* Panel 列表 */}
        <div className={styles.panelList}>
          <LoadingOverlay visible={loading} zIndex={5} />
          {panels.length === 0 ? (
            <div className={styles.emptyState}>
              <ElSvgIcon name="FolderOpened" size={40} color="#c0c4cc" />
              <p>{t('dashboardMgmt.panelLib.empty')}</p>
            </div>
          ) : (
            panels.map((panel) => {
              const TypeIcon = getTypeIcon(panel.display_type)
              return (
                <div
                  key={panel.id}
                  className={styles.panelItem}
                  draggable
                  onDragStart={(e) => handleDragStart(e, panel)}
                  onDragEnd={handleDragEnd}
                >
                  {/* 图标 */}
                  <div className={`${styles.panelIcon} ${typeCls[panel.display_type] || ''}`}>
                    <TypeIcon size={20} color={getTypeColor(panel.display_type)} />
                  </div>

                  {/* 信息 */}
                  <div className={styles.panelInfo}>
                    <div className={styles.panelTitle} title={panel.title}>
                      {panel.title}
                    </div>
                    <div className={styles.panelMeta}>
                      <span className={styles.typeName}>
                        {getTypeName(panel.display_type || 'text')}
                      </span>
                    </div>
                  </div>

                  {/* 操作按钮 */}
                  <div className={styles.panelActions}>
                    <span className={styles.dragIcon}>
                      <ElSvgIcon name="Rank" size={16} />
                    </span>
                    <span
                      className={styles.deleteIcon}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDelete(panel)
                      }}
                    >
                      <ElSvgIcon name="Delete" size={16} />
                    </span>
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* 分页 */}
        {total > PAGE_SIZE && (
          <div className={styles.paginationWrapper}>
            <Pagination
              value={currentPage}
              total={Math.ceil(total / PAGE_SIZE)}
              size="sm"
              onChange={handlePageChange}
            />
          </div>
        )}
      </div>

      {/* 拖拽虚影 (Teleport to body) */}
      {isDragging &&
        dragPanel &&
        createPortal(
          (() => {
            const GhostIcon = getTypeIcon(dragPanel.display_type)
            return (
              <div className={styles.dragGhost} style={{ left: mouseX, top: mouseY }}>
                <GhostIcon size={20} color={getTypeColor(dragPanel.display_type)} />
                <span>{dragPanel.title}</span>
              </div>
            )
          })(),
          document.body
        )}
    </div>
  )
}
