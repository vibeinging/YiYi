/**
 * 数据库列表同步 Hook
 * 用于在keep-alive组件间同步数据库列表变更
 */
import { useEffect, useRef } from 'react'
import bus from '@/utils/bus'

export function useDatabaseSync() {
  // 通YiW据库列表变更
  const notifyDatabaseListChanged = () => {
    console.log('发送数据库列表变更事件')
    // 使用全局的bus对象（对齐原 auto-imports 自动导入的 bus）
    bus.emit('database-list-changed')
  }

  // 监听数据库列表变更
  const listenDatabaseListChanged = (callback: () => void) => {
    // 用 ref 保存最新 callback，避免因 callback 引用变化反复注册/注销监听
    const callbackRef = useRef(callback)
    callbackRef.current = callback

    // 保存清理函数引用，以便返回手动清理能力
    const cleanupRef = useRef<(() => void) | null>(null)

    useEffect(() => {
      const handleChange = () => {
        console.log('收到数据库列表变更事件')
        callbackRef.current()
      }
      bus.on('database-list-changed', handleChange)

      const cleanupListener = () => {
        bus.off('database-list-changed', handleChange)
      }
      cleanupRef.current = cleanupListener

      // onMounted 注册 -> onBeforeUnmount 清理
      return cleanupListener
    }, [])

    // 返回手动清理函数，以防需要提前清理
    return () => {
      cleanupRef.current?.()
    }
  }

  return {
    notifyDatabaseListChanged,
    listenDatabaseListChanged
  }
}
