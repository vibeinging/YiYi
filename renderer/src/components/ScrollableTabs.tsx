// ScrollableTabs —— 可横向滚动的 Tabs 包装器（源：components/ScrollableTabs.vue）
// 在切换 / 点击 tab 时，把当前激活的 tab 平滑滚动到滚动容器中心。
// TODO(migration): 源组件基于 el-tabs（.el-tabs__item.is-active / .el-tabs__nav-scroll）。
//   Mantine Tabs 的 DOM 结构不同：激活项为 [data-active]，横向滚动容器为 .mantine-Tabs-list 的父级 ScrollArea。
//   这里改用 Mantine Tabs + ScrollArea，并按 Mantine 的选择器定位激活 tab 实现「滚动到中心」，行为对齐源逻辑。
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type ReactNode,
} from 'react'
import { ScrollArea, Tabs } from '@mantine/core'
import styles from './ScrollableTabs.module.scss'

// defineProps → interface
interface ScrollableTabsProps {
  // v-model="modelValue"
  modelValue?: string | number
  // el-tabs type（'border-card' | 'card' | ''）
  type?: string
  // 透传到 Tabs 根节点的 class
  tabsClass?: string
  // 自定义选择器，用于定位 tabs 滚动容器（支持多实例场景）
  navScrollSelector?: string
  // defineEmits(['update:modelValue', 'tab-click'])
  onUpdateModelValue?: (value: string) => void
  onTabClick?: (value: string, event: React.MouseEvent) => void
  // 默认插槽：Tabs.List / Tabs.Tab / Tabs.Panel 等
  children?: ReactNode
}

// defineExpose({ scrollActiveTabToCenter }) → forwardRef + useImperativeHandle
export interface ScrollableTabsHandle {
  scrollActiveTabToCenter: () => void
}

const ScrollableTabs = forwardRef<ScrollableTabsHandle, ScrollableTabsProps>(
  function ScrollableTabs(
    {
      modelValue = '',
      type = 'border-card',
      tabsClass = '',
      navScrollSelector = '',
      onUpdateModelValue,
      onTabClick,
      children,
    },
    ref
  ) {
    // ref="tabsRef" —— 指向 Tabs 根 DOM
    const tabsRef = useRef<HTMLDivElement>(null)

    /**
     * 将 active tab 滚动到中心位置
     */
    const scrollActiveTabToCenter = useCallback(() => {
      // nextTick → requestAnimationFrame，等待 DOM/激活态更新后再计算
      requestAnimationFrame(() => {
        // 获取 tabs 容器元素
        const tabsEl = tabsRef.current
        if (!tabsEl) return

        // 查找 active 的 tab 元素（Mantine 激活 tab 带 [data-active] / aria-selected）
        const activeTab =
          tabsEl.querySelector<HTMLElement>('[role="tab"][data-active]') ||
          tabsEl.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
        if (!activeTab) return

        // 查找滚动容器
        const navScroll = navScrollSelector
          ? document.querySelector<HTMLElement>(navScrollSelector)
          : tabsEl.querySelector<HTMLElement>(
              '[data-scrollarea-viewport], .mantine-ScrollArea-viewport'
            )
        if (!navScroll) return

        // 计算滚动位置：将 active tab 居中
        const tabCenter = activeTab.offsetLeft + activeTab.offsetWidth / 2
        const navCenter = navScroll.offsetWidth / 2
        const scrollLeft = tabCenter - navCenter

        // 平滑滚动到目标位置
        navScroll.scrollTo({
          left: Math.max(0, scrollLeft),
          behavior: 'smooth',
        })
      })
    }, [navScrollSelector])

    // 处理 tab 切换事件（Mantine Tabs onChange 给出新 value）
    const handleChange = (value: string | null) => {
      const name = value ?? ''
      onUpdateModelValue?.(name)
      // 切换后滚动到中心
      scrollActiveTabToCenter()
    }

    // 处理 tab 点击事件，透传 tab-click（保留事件对象）
    const handleTabClick = (value: string, event: React.MouseEvent) => {
      onTabClick?.(value, event)
    }

    // watch(() => props.modelValue) → 监听 modelValue 变化，自动滚动
    useEffect(() => {
      scrollActiveTabToCenter()
    }, [modelValue, scrollActiveTabToCenter])

    // 暴露方法供外部调用（defineExpose）
    useImperativeHandle(ref, () => ({ scrollActiveTabToCenter }), [
      scrollActiveTabToCenter,
    ])

    // 根据 el-tabs type 映射 Mantine variant
    // border-card → outline，card → outline（带 card class），其它 → default
    const variant = type === 'border-card' || type === 'card' ? 'outline' : 'default'

    return (
      <Tabs
        ref={tabsRef}
        value={String(modelValue)}
        onChange={handleChange}
        variant={variant}
        keepMounted={false}
        className={[styles.scrollableTabs, tabsClass].filter(Boolean).join(' ')}
        data-tabs-type={type}
        onClick={(e) => {
          // 捕获 tab 点击，透传 tab-click（对应源 @tab-click emit）
          // Mantine tab 不带 data-value，从 aria-controls（panel id，形如 *-panel-{value}）反解 value
          const tabEl = (e.target as HTMLElement).closest<HTMLElement>(
            '[role="tab"]'
          )
          if (!tabEl) return
          const panelId = tabEl.getAttribute('aria-controls') || ''
          const value = panelId.split('-panel-').pop() || ''
          if (value) handleTabClick(value, e)
        }}
      >
        {/* 默认插槽：包裹 ScrollArea 以支持横向滚动 */}
        <ScrollArea type="never" scrollbarSize={0}>
          {children}
        </ScrollArea>
      </Tabs>
    )
  }
)

export default ScrollableTabs
