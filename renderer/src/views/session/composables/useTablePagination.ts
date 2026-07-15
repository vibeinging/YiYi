/**
 * 表格分页逻辑
 */
import { useCallback, useRef, useState } from 'react'

interface TablePaginationState {
  currentPage: number
  pageSize: number
}

export function useTablePagination() {
  // 表格分页状态管理（key: messageId-blockIndex）
  // 用 state 触发重渲染，用 ref 镜像保证回调内读到最新值（避免闭包陈旧）
  const [tablePagination, setTablePagination] = useState<Map<string, TablePaginationState>>(
    () => new Map()
  )
  const paginationRef = useRef(tablePagination)
  paginationRef.current = tablePagination

  // 获取或初始化表格分页状态
  const getTablePagination = useCallback(
    (messageId: any, blockIndex: any): TablePaginationState => {
      const key = `${messageId}-${blockIndex}`
      const current = paginationRef.current
      if (!current.has(key)) {
        const init: TablePaginationState = {
          currentPage: 1,
          pageSize: 10
        }
        // 初始化时写回 state（创建新 Map 触发重渲染）
        const next = new Map(current)
        next.set(key, init)
        paginationRef.current = next
        setTablePagination(next)
        return init
      }
      return current.get(key)!
    },
    []
  )

  // 获取表格数据
  const getTableData = useCallback((data: any): any[] => {
    if (!data || typeof data !== 'object') {
      return []
    }

    // 新格式: { data: [...] }
    if (data.data && Array.isArray(data.data)) {
      return data.data
    }

    // 旧格式: { rows: [] }
    if (data.rows && Array.isArray(data.rows)) {
      return data.rows
    }

    return []
  }, [])

  // 获取表格列
  const getTableColumns = useCallback((data: any): any[] => {
    if (!data || typeof data !== 'object') {
      return []
    }

    // 新格式: { data: [...], fields: [...] }
    if (data.data && Array.isArray(data.data) && data.data.length > 0) {
      if (data.fields && Array.isArray(data.fields)) {
        return data.fields.map((f: any) => f.alias || f.expression || f)
      }
      return Object.keys(data.data[0])
    }

    // 旧格式: { headers: [], rows: [] }
    if (data.headers && Array.isArray(data.headers)) {
      return data.headers
    }

    return []
  }, [])

  // 获取分页后的表格数据
  const getPaginatedTableData = useCallback(
    (data: any, messageId: any, blockIndex: any): any[] => {
      const rows = getTableData(data)
      const pagination = getTablePagination(messageId, blockIndex)
      const start = (pagination.currentPage - 1) * pagination.pageSize
      const end = start + pagination.pageSize
      return rows.slice(start, end)
    },
    [getTableData, getTablePagination]
  )

  // 表格分页切换事件
  const handleTablePageChange = useCallback((messageId: any, blockIndex: any, page: number) => {
    const key = `${messageId}-${blockIndex}`
    const current = paginationRef.current
    const pagination = current.get(key)
    if (pagination) {
      const next = new Map(current)
      next.set(key, { ...pagination, currentPage: page })
      paginationRef.current = next
      setTablePagination(next)
    }
  }, [])

  // 表格每页大小切换事件
  const handleTableSizeChange = useCallback((messageId: any, blockIndex: any, size: number) => {
    const key = `${messageId}-${blockIndex}`
    const current = paginationRef.current
    const pagination = current.get(key)
    if (pagination) {
      const next = new Map(current)
      next.set(key, { ...pagination, pageSize: size, currentPage: 1 })
      paginationRef.current = next
      setTablePagination(next)
    }
  }, [])

  // 清除所有分页状态（会话切换 / 全量重载时调用，避免 Map 无界增长）
  const clearTablePagination = useCallback(() => {
    const next = new Map<string, TablePaginationState>()
    paginationRef.current = next
    setTablePagination(next)
  }, [])

  // 清除指定 messageId 的分页状态（删除消息时调用）
  const clearTablePaginationFor = useCallback((messageId: any) => {
    const prefix = `${messageId}-`
    const current = paginationRef.current
    const next = new Map(current)
    for (const key of current.keys()) {
      if (key.startsWith(prefix)) {
        next.delete(key)
      }
    }
    paginationRef.current = next
    setTablePagination(next)
  }, [])

  // 获取表格统计信息
  const getTableSummary = useCallback(
    (data: any): string => {
      const rows = getTableData(data)
      if (rows.length === 0) {
        return '无数据'
      }
      const row_count = data.row_count !== undefined ? data.row_count : rows.length
      return `共 ${row_count} 条数据`
    },
    [getTableData]
  )

  return {
    tablePagination,
    getTablePagination,
    getTableData,
    getTableColumns,
    getPaginatedTableData,
    handleTablePageChange,
    handleTableSizeChange,
    getTableSummary,
    clearTablePagination,
    clearTablePaginationFor
  }
}
