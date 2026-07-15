/**
 * 响应式状态 hook
 *
 * 提供 isMobile / isTablet / isDesktop 响应式状态
 * 使用 window.matchMedia 高效监听断点变化
 * 在移动端自动收起侧边栏
 */
import { useEffect, useState } from 'react'
import { useBasicStore } from '@/store/basic'

// 断点值与 responsive.scss 保持一致
const BREAKPOINT_MOBILE = 768
const BREAKPOINT_TABLET = 1024

interface DeviceState {
  isMobile: boolean
  isTablet: boolean
  isDesktop: boolean
}

// 全局单例状态，避免多组件重复监听
let mqlMobile: MediaQueryList | null = null
let mqlTablet: MediaQueryList | null = null
let handleMobileChange: (() => void) | null = null
let handleTabletChange: (() => void) | null = null
let refCount = 0

// 当前断点状态（单例）+ 订阅者集合（用于通知各组件 setState）
let currentState: DeviceState = computeState()
const subscribers = new Set<(s: DeviceState) => void>()

function computeState(): DeviceState {
  if (typeof window === 'undefined') {
    return { isMobile: false, isTablet: false, isDesktop: true }
  }
  const width = window.innerWidth
  return {
    isMobile: width < BREAKPOINT_MOBILE,
    isTablet: width >= BREAKPOINT_MOBILE && width < BREAKPOINT_TABLET,
    isDesktop: width >= BREAKPOINT_TABLET
  }
}

function updateStates() {
  currentState = computeState()
  subscribers.forEach((fn) => fn(currentState))
}

function setupListeners() {
  if (typeof window === 'undefined') return

  mqlMobile = window.matchMedia(`(max-width: ${BREAKPOINT_MOBILE - 1}px)`)
  mqlTablet = window.matchMedia(`(min-width: ${BREAKPOINT_MOBILE}px) and (max-width: ${BREAKPOINT_TABLET - 1}px)`)

  handleMobileChange = () => updateStates()
  handleTabletChange = () => updateStates()

  mqlMobile.addEventListener('change', handleMobileChange)
  mqlTablet.addEventListener('change', handleTabletChange)

  // 初始状态
  updateStates()
}

function teardownListeners() {
  if (mqlMobile && handleMobileChange) {
    mqlMobile.removeEventListener('change', handleMobileChange)
  }
  if (mqlTablet && handleTabletChange) {
    mqlTablet.removeEventListener('change', handleTabletChange)
  }
  mqlMobile = null
  mqlTablet = null
  handleMobileChange = null
  handleTabletChange = null
}

interface UseResponsiveOptions {
  /** 移动端自动收起侧边栏 (默认 false) */
  autoCollapseSidebar?: boolean
}

/**
 * 响应式断点 hook
 *
 * @param options.autoCollapseSidebar - 移动端自动收起侧边栏 (默认 true)
 * @returns { isMobile, isTablet, isDesktop }(布尔值)
 */
export function useResponsive(options: UseResponsiveOptions = {}): DeviceState {
  const { autoCollapseSidebar = false } = options

  const [state, setState] = useState<DeviceState>(currentState)

  useEffect(() => {
    // 订阅单例状态（onMounted）
    subscribers.add(setState)

    refCount++
    if (refCount === 1) {
      setupListeners()
    } else {
      // 其他组件挂载时也刷新一次状态
      updateStates()
    }
    // 与单例最新状态同步
    setState(currentState)

    // 移动端自动收起侧边栏
    if (autoCollapseSidebar && currentState.isMobile) {
      useBasicStore.getState().setSidebarHidden(true)
    }

    // cleanup（onBeforeUnmount）
    return () => {
      subscribers.delete(setState)
      refCount--
      if (refCount <= 0) {
        teardownListeners()
        refCount = 0
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return state
}

/**
 * 非组件环境下获取当前设备类型（一次性判断）
 */
export function getDeviceType(): 'mobile' | 'tablet' | 'desktop' {
  if (typeof window === 'undefined') return 'desktop'
  const width = window.innerWidth
  if (width < BREAKPOINT_MOBILE) return 'mobile'
  if (width < BREAKPOINT_TABLET) return 'tablet'
  return 'desktop'
}
