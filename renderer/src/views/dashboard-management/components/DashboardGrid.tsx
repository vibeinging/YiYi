// 由 DashboardGrid.vue 迁移：@noction/vue-draggable-grid → react-grid-layout
// react-grid-layout 的样式由 main.tsx 全局 import（react-grid-layout/css + react-resizable/css）
import { useState, useMemo, useEffect, useRef, type ReactNode, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import RGL, { WidthProvider, type Layout } from 'react-grid-layout'
import { Button } from '@mantine/core'
import ElSvgIcon from '@/components/ElSvgIcon'
import styles from './DashboardGrid.module.scss'

const GridLayout = WidthProvider(RGL)

// 内部布局项 - react-grid-layout 需要 i 字段，这里业务上用 id
interface InternalLayoutItem {
  id: string | number
  x: number
  y: number
  w: number
  h: number
}

// 外部布局项（与 index 双向同步的格式）
interface ExternalLayoutItem {
  i: string | number
  x: number
  y: number
  w: number
  h: number
}

interface PanelDropPayload {
  panelId: any
  panel: any
  position: { x: number; y: number }
}

export interface DashboardGridProps {
  // 布局数据 [{i, x, y, w, h}, ...] 或 [{id, x, y, w, h}, ...]
  layout?: any[]
  // Panel 数据列表
  panels?: any[]
  // 是否处于编辑模式
  isEditing?: boolean
  // 行高
  rowHeight?: number
  // 容器高度（用于计算最小高度）
  containerHeight?: number
  // 事件回调（对应 defineEmits）
  onUpdateLayout?: (layout: ExternalLayoutItem[]) => void
  onLayoutChange?: (layout: ExternalLayoutItem[]) => void
  onGotoChat?: () => void
  onPanelDrop?: (payload: PanelDropPayload) => void
  // 作用域插槽 #panel="{ panel, item }" → render-prop
  renderPanel?: (ctx: { panel: any; item: InternalLayoutItem }) => ReactNode
  // 具名插槽 #empty → ReactNode（可选，覆盖默认空状态）
  emptySlot?: ReactNode
}

export default function DashboardGrid({
  layout = [],
  panels = [],
  isEditing = false,
  rowHeight = 100,
  containerHeight = 600,
  onUpdateLayout,
  onLayoutChange,
  onGotoChat,
  onPanelDrop,
  renderPanel,
  emptySlot,
}: DashboardGridProps) {
  const { t } = useTranslation()

  // 与 index.vue 767 断点一致；初始同步读宽度，避免首屏先渲染栅格再切换导致空白
  const [isMobileStackMode, setIsMobileStackMode] = useState<boolean>(
    typeof window !== 'undefined' && window.innerWidth < 768
  )

  // 内部布局状态 - react-grid-layout 需要 id 字段
  const [internalLayout, setInternalLayout] = useState<InternalLayoutItem[]>([])

  // 拖放状态
  const [isDropActive, setIsDropActive] = useState(false)

  const gridRootRef = useRef<HTMLDivElement>(null)

  // 计算当前布局占用的最大行数
  const maxUsedRow = useMemo(() => {
    if (internalLayout.length === 0) return 0
    return Math.max(...internalLayout.map((item) => (item.y || 0) + (item.h || 3)))
  }, [internalLayout])

  // 计算 grid 的最小高度（当前内容高度 + 额外空间供拖放）
  const gridMinHeight = useMemo(() => {
    const contentHeight = maxUsedRow * (rowHeight + 16) // rowHeight + margin
    const minHeight = Math.max(containerHeight, contentHeight + 400) // 额外400px供拖放
    return `${minHeight}px`
  }, [maxUsedRow, rowHeight, containerHeight])

  // 移动端按网格阅读顺序排列
  const mobileOrderedLayout = useMemo(
    () => [...internalLayout].sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x)),
    [internalLayout]
  )

  const panelShellMinPx = (item: InternalLayoutItem | undefined) =>
    Math.max(240, (item?.h ?? 3) * rowHeight)

  // 初始化布局 - 转换为 grid-layout 需要的格式 {id, x, y, w, h}
  // 对应 watch(() => props.layout, ..., { immediate: true, deep: true })
  useEffect(() => {
    if (layout && layout.length > 0) {
      setInternalLayout(
        layout.map((item) => ({
          id: item.i || item.id,
          x: item.x ?? 0,
          y: item.y ?? 0,
          w: item.w ?? 6,
          h: item.h ?? 3,
        }))
      )
    } else {
      setInternalLayout([])
    }
  }, [layout])

  // 栅格库用 offsetWidth 计算列宽；在移动端 flex+子项 width:0 等场景下首帧可能为 0，需触发一次重算
  const bumpGridContainerMeasure = () => {
    queueMicrotask(() => {
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event('resize'))
      })
    })
  }

  // 同步移动端断点 + 首屏重算（对应 onMounted + onBeforeUnmount）
  useEffect(() => {
    const syncMobileStackMode = () => {
      if (typeof window === 'undefined') return
      setIsMobileStackMode(window.innerWidth < 768)
    }
    syncMobileStackMode()
    window.addEventListener('resize', syncMobileStackMode)
    bumpGridContainerMeasure()
    return () => {
      window.removeEventListener('resize', syncMobileStackMode)
    }
  }, [])

  // 布局长度变化触发重算（对应 watch(() => internalLayout.value.length)）
  useEffect(() => {
    if (internalLayout.length > 0) bumpGridContainerMeasure()
  }, [internalLayout.length])

  // 退出移动端堆叠模式时重算（对应 watch(isMobileStackMode)）
  useEffect(() => {
    if (!isMobileStackMode) bumpGridContainerMeasure()
  }, [isMobileStackMode])

  // 根据 ID 获取 Panel 数据
  const getPanelById = (id: any) => {
    return panels.find((p) => p.id === id)
  }

  // 布局更新处理
  const handleLayoutUpdate = (newLayout: Layout[]) => {
    // react-grid-layout 用 i 作为 key（这里就是 id），回写内部状态
    const next: InternalLayoutItem[] = newLayout.map((l) => ({
      id: l.i,
      x: l.x,
      y: l.y,
      w: l.w,
      h: l.h,
    }))
    setInternalLayout(next)

    // 转换为外部格式
    const externalLayout: ExternalLayoutItem[] = next.map((item) => ({
      i: item.id,
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
    }))
    onUpdateLayout?.(externalLayout)
    onLayoutChange?.(externalLayout)
  }

  // 拖放处理
  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    // 检查是否是来自 Panel 库的拖拽
    if (event.dataTransfer.types.includes('application/json')) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      setIsDropActive(true)
    }
  }

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    // 只有真正离开 grid 区域才取消高亮
    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX
    const y = event.clientY

    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      setIsDropActive(false)
    }
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    setIsDropActive(false)

    console.log('DashboardGrid handleDrop triggered')

    try {
      const dataStr = event.dataTransfer.getData('application/json')
      console.log('Drop data:', dataStr)

      if (!dataStr) {
        console.warn('No data in dataTransfer')
        return
      }

      const data = JSON.parse(dataStr)
      if (data.type === 'panel' && data.panelId) {
        // 计算放置位置（网格坐标）
        const rect = event.currentTarget.getBoundingClientRect()
        const x = Math.floor((event.clientX - rect.left) / ((rect.width - 32) / 12)) // 考虑 margin
        const y = Math.floor((event.clientY - rect.top) / (rowHeight + 16)) // 考虑 margin

        console.log('Emitting panel-drop:', { panelId: data.panelId, x, y })

        onPanelDrop?.({
          panelId: data.panelId,
          panel: data.panel,
          position: {
            x: Math.max(0, Math.min(x, 6)), // 限制 x 在 0-6 之间（默认宽度6）
            y: Math.max(0, y),
          },
        })
      }
    } catch (error) {
      console.error('解析拖放数据失败:', error)
    }
  }

  // 默认 panel 内容（slot 未提供 / panel 为空时）
  const renderPanelContent = (item: InternalLayoutItem) => {
    const panel = getPanelById(item.id)
    if (renderPanel) {
      const node = renderPanel({ panel, item })
      // 作用域插槽内部有 v-if="panel"，render-prop 自行处理；这里若返回空则回退默认内容
      if (node) return node
    }
    return <div className={styles['default-panel']}>Panel {item.id}</div>
  }

  // react-grid-layout 的 layout 数组（i = id）
  const rglLayout: Layout[] = internalLayout.map((item) => ({
    i: String(item.id),
    x: item.x,
    y: item.y,
    w: item.w,
    h: item.h,
  }))

  return (
    <div
      ref={gridRootRef}
      className={`${styles['dashboard-grid']} ${isDropActive ? styles['drop-active'] : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {internalLayout.length > 0 && (
        <>
          {isMobileStackMode ? (
            // 移动端：纵向堆叠，避免栅格库在窄屏下 offsetWidth/绝对定位导致面板不可见
            <div className={styles['mobile-panel-stack']}>
              {mobileOrderedLayout.map((item) => (
                <div
                  key={item.id}
                  className={styles['mobile-panel-card']}
                  style={{ minHeight: `${panelShellMinPx(item)}px` }}
                >
                  <div
                    className={`${styles['grid-item-content']} ${styles['grid-item-content--mobile-stack']} ${
                      isEditing ? styles['is-editing'] : ''
                    }`}
                    style={{ minHeight: `${panelShellMinPx(item)}px` }}
                  >
                    {renderPanelContent(item)}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div
              className={styles['grid-wrapper']}
              style={{ minHeight: gridMinHeight }}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
            >
              <GridLayout
                className="layout"
                layout={rglLayout}
                cols={12}
                rowHeight={rowHeight}
                isDraggable={isEditing}
                isResizable={isEditing}
                verticalCompact
                compactType="vertical"
                margin={[16, 16]}
                onLayoutChange={handleLayoutUpdate}
              >
                {internalLayout.map((item) => (
                  <div
                    key={String(item.id)}
                    className={`${styles['grid-item-content']} ${isEditing ? styles['is-editing'] : ''}`}
                  >
                    {renderPanelContent(item)}
                  </div>
                ))}
              </GridLayout>
            </div>
          )}
        </>
      )}

      {/* 空状态 / 拖放区域 */}
      {internalLayout.length === 0 && (
        <div
          className={`${styles['empty-state']} ${isDropActive ? styles['drop-highlight'] : ''}`}
        >
          {emptySlot ?? (
            <>
              <ElSvgIcon name="DataBoard" size={64} color="var(--el-color-primary)" />
              <h3>
                {isDropActive
                  ? t('dashboardMgmt.releaseToAddPanel')
                  : t('dashboardMgmt.noPanels')}
              </h3>
              <p className={styles['tip-text']}>
                {isDropActive ? '' : t('dashboardMgmt.emptyHint')}
              </p>
              {!isDropActive && (
                <Button onClick={() => onGotoChat?.()}>
                  {t('dashboardMgmt.goToChat')}
                </Button>
              )}
            </>
          )}
        </div>
      )}

      {/* 拖放指示区域（有内容时） */}
      {internalLayout.length > 0 && isDropActive && (
        <div className={styles['drop-indicator']}>
          <ElSvgIcon name="Plus" size={32} />
          <span>{t('dashboardMgmt.releaseToAdd')}</span>
        </div>
      )}
    </div>
  )
}
