import { useState } from 'react'

/**
 * 业务页面的基础状态 hook
 * 对应 Vue 版的 useBusinessState composable（ref → useState）
 * 保持导出名与返回字段名一致；额外暴露各 setter 供主页面更新状态
 */
export function useBusinessState() {
  // 基础状态
  const [businessList, setBusinessList] = useState<any[]>([])
  const [selectedBusiness, setSelectedBusiness] = useState<any>(null)
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [total, setTotal] = useState(0)

  return {
    // 状态
    businessList,
    selectedBusiness,
    isCollapsed,
    currentPage,
    pageSize,
    total,

    // setter（React 友好，替代 Vue ref 的 .value 赋值）
    setBusinessList,
    setSelectedBusiness,
    setIsCollapsed,
    setCurrentPage,
    setPageSize,
    setTotal,

    // 占位方法，由主页面实现
    getBusinessList: () => {},
  }
}
