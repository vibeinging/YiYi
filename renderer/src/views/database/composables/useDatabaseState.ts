import { useCallback, useState } from 'react'

export function useDatabaseState() {
  // 基础状态
  const [databaseList, setDatabaseList] = useState<any[]>([])
  const [searchKeyword, setSearchKeyword] = useState<string>('')
  const [selectedDatabase, setSelectedDatabase] = useState<any>(null)
  const [isCollapsed, setIsCollapsed] = useState<boolean>(false)

  // 数据库类型标签颜色映射
  const getDbTypeTagType = useCallback((dbType: string) => {
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
  }, [])

  return {
    // 状态
    databaseList,
    searchKeyword,
    selectedDatabase,
    isCollapsed,

    // 状态 setter（React 中需显式暴露写入能力，对应 Vue 中对 ref 的直接赋值）
    setDatabaseList,
    setSearchKeyword,
    setSelectedDatabase,
    setIsCollapsed,

    // 方法
    getDbTypeTagType,

    // 占位方法，由主页面实现
    getDatabaseList: () => {}
  }
}
