// TODO(migration): 源 Vue 用全局 <style> @use 了 session/styles 下的 message.scss / markdown.scss /
//   blocks.scss（消息气泡 / Markdown / 内容块样式），这些是 MessageItem/ContentBlock 依赖的全局类。
//   待 session 样式迁移到 app/renderer 后，在此 import 一次即可让分享页里的消息块拥有完整视觉样式。
// TODO(migration): el-result 无 Mantine 等价物，失效态用 Center + 自建结构 + Tabler 警告图标替代。
import { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button, Center, Loader, Stack, Text } from '@mantine/core'
import { IconAlertTriangle } from '@tabler/icons-react'
// MessageItem 目前仍是迁移 stub（无 props 类型），用 any 桥接，待其完成迁移后保留原 props 契约。
import MessageItemRaw from '@/views/session/components/MessageItem'
const MessageItem = MessageItemRaw as any
import { parseHistoryMessages } from '@/utils/StreamParser'
import { getSharedSession } from '@/api/share'
import styles from './index.module.scss'

/**
 * 表格分页逻辑（源自 session/composables/useTablePagination）。
 * 只读分享场景下交互均已禁用，提供空值/分页能力即可。
 */
function useTablePagination() {
  // 表格分页状态管理（key: messageId-blockIndex）
  const tablePagination = useRef(new Map<string, { currentPage: number; pageSize: number }>())

  // 获取或初始化表格分页状态
  const getTablePagination = useCallback((messageId: any, blockIndex: any) => {
    const key = `${messageId}-${blockIndex}`
    if (!tablePagination.current.has(key)) {
      tablePagination.current.set(key, { currentPage: 1, pageSize: 10 })
    }
    return tablePagination.current.get(key)
  }, [])

  // 获取表格数据
  const getTableData = useCallback((data: any) => {
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
  const getTableColumns = useCallback((data: any) => {
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
    (data: any, messageId: any, blockIndex: any) => {
      const rows = getTableData(data)
      const pagination = getTablePagination(messageId, blockIndex)!
      const start = (pagination.currentPage - 1) * pagination.pageSize
      const end = start + pagination.pageSize
      return rows.slice(start, end)
    },
    [getTableData, getTablePagination]
  )

  // 获取表格汇总
  const getTableSummary = useCallback((data: any) => {
    if (!data || typeof data !== 'object') {
      return null
    }
    return data.summary || null
  }, [])

  return {
    getTablePagination,
    getTableData,
    getTableColumns,
    getPaginatedTableData,
    getTableSummary
  }
}

// 全局只读上下文：兜底所有内容块/控件（含未显式接 readonly prop 的未来组件）。
// 对应 Vue 的 provide('readonly' / 'feedbackMap' / 'projectId' / 'sessionId' / 'getTable*')。
export const ShareReadonlyContext = createContext<any>({
  readonly: true,
  feedbackMap: {},
  projectId: null,
  sessionId: '',
  getTablePagination: undefined,
  getTableData: undefined,
  getTableColumns: undefined,
  getPaginatedTableData: undefined,
  getTableSummary: undefined
})

export default function Share() {
  const { shareToken } = useParams()
  const navigate = useNavigate()
  const { t } = useTranslation()

  const [loaded, setLoaded] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const [sessionMeta, setSessionMeta] = useState<any>({})
  const [messages, setMessages] = useState<any[]>([])

  // MessageItem / ContentBlock 依赖的注入项（只读场景下交互均已禁用，提供空值/分页能力即可）
  const {
    getTablePagination,
    getTableData,
    getTableColumns,
    getPaginatedTableData,
    getTableSummary
  } = useTablePagination()

  const sessionId = useMemo(() => sessionMeta.id || '', [sessionMeta])

  const goHome = () => {
    navigate('/')
  }

  useEffect(() => {
    const loadShared = async () => {
      const token = shareToken
      if (!token) {
        setInvalid(true)
        setLoaded(true)
        return
      }
      try {
        const res: any = await getSharedSession(token)
        if (!res?.success || !res?.data) {
          setInvalid(true)
          return
        }
        const session = res.data.session || {}
        setSessionMeta(session)
        setMessages(parseHistoryMessages(res.data.messages))
        document.title = `${session.title || t('share.readonlyBadge')} · YiW`
      } catch (e) {
        // 链接失效 / 已撤销 / 不存在
        setInvalid(true)
      } finally {
        setLoaded(true)
      }
    }
    loadShared()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareToken])

  // 全局只读上下文值
  const ctxValue = useMemo(
    () => ({
      readonly: true,
      feedbackMap: {},
      businessId: null,
      sessionId,
      getTablePagination,
      getTableData,
      getTableColumns,
      getPaginatedTableData,
      getTableSummary
    }),
    [sessionId, getTablePagination, getTableData, getTableColumns, getPaginatedTableData, getTableSummary]
  )

  return (
    <ShareReadonlyContext.Provider value={ctxValue}>
      <div className={styles.sharePage}>
        {/* 顶部栏 */}
        <header className={styles.shareHeader}>
          <div className={styles.shareHeaderInner}>
            <div className={styles.shareBrand}>
              <span className={styles.shareLogo}>YiW</span>
              <span className={styles.shareBadge}>{t('share.readonlyBadge')}</span>
            </div>
            {loaded && !invalid && (
              <div className={styles.shareTitleWrap}>
                <span className={styles.shareTitle}>{sessionMeta.title || t('session.newConversation')}</span>
              </div>
            )}
          </div>
        </header>

        {/* 内容区 */}
        <main className={styles.shareMain}>
          {/* 加载中 */}
          {!loaded ? (
            <div className={styles.shareState}>
              <Stack align="center" gap="sm">
                <Loader />
                <Text size="sm" c="dimmed">
                  {t('share.loading')}
                </Text>
              </Stack>
            </div>
          ) : invalid ? (
            /* 失效 */
            <div className={styles.shareState}>
              <Center>
                <Stack align="center" gap="md">
                  <IconAlertTriangle size={56} color="var(--mantine-color-yellow-6)" />
                  <Text fw={600} size="lg">
                    {t('share.invalidTitle')}
                  </Text>
                  <Text size="sm" c="dimmed">
                    {t('share.invalidDesc')}
                  </Text>
                  <Button onClick={goHome}>{t('share.goHome')}</Button>
                </Stack>
              </Center>
            </div>
          ) : (
            /* 正常渲染 */
            <div className={styles.shareContent}>
              <div className={styles.messagesContainer}>
                {messages.map((message: any) => (
                  <MessageItem
                    key={message.id}
                    message={message}
                    databaseId={null}
                    sessionId={sessionMeta.id || ''}
                    readonly={true}
                  />
                ))}
              </div>

              {/* 只读说明 */}
              <div className={styles.shareReadonlyNote}>{t('share.readonlyNote')}</div>
            </div>
          )}
        </main>

        {/* 底部轻量引导 */}
        {loaded && !invalid && (
          <footer className={styles.shareFooter}>
            <span className={styles.shareFooterText}>{t('share.ctaText')}</span>
            <Button radius="xl" size="xs" onClick={goHome}>
              {t('share.ctaButton')}
            </Button>
          </footer>
        )}
      </div>
    </ShareReadonlyContext.Provider>
  )
}
