import { useState, useCallback } from 'react'

// Vue composable → React hook
// ref → useState；保持导出名与返回字段名一致
export function useStructuredDataSourceState() {
  // 基础状态
  const [dataSourceList, setDataSourceList] = useState<any[]>([])
  const [searchKeyword, setSearchKeyword] = useState<string>('')
  const [selectedDataSource, setSelectedDataSource] = useState<any>(null)
  const [isCollapsed, setIsCollapsed] = useState<boolean>(false)

  // 占位方法，由主页面实现
  const getDataSourceList = useCallback(() => {}, [])

  return {
    // 状态
    dataSourceList,
    setDataSourceList,
    searchKeyword,
    setSearchKeyword,
    selectedDataSource,
    setSelectedDataSource,
    isCollapsed,
    setIsCollapsed,

    // 占位方法，由主页面实现
    getDataSourceList
  }
}
