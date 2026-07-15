import { useState } from 'react'

export function useUnstructuredDataSourceState() {
  // 基础状态
  const [dataSourceList, setDataSourceList] = useState<any[]>([])
  const [searchKeyword, setSearchKeyword] = useState<string>('')
  const [selectedDataSource, setSelectedDataSource] = useState<any>(null)
  const [isCollapsed, setIsCollapsed] = useState<boolean>(false)

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
    getDataSourceList: () => {}
  }
}
