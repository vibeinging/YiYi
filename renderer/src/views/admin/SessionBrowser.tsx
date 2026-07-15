import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Pagination, Select, Skeleton, TextInput } from '@mantine/core'
import ElSvgIcon from '@/components/ElSvgIcon'
import { getAdminSessionsReq, getAdminSessionMessagesReq } from '@/api/admin-sessions'
import { MessageItem } from '@/views/session/components'
import { FeedbackMapContext } from '@/views/session/components/MessageItem'
import { ShareReadonlyContext } from '@/views/share/index'
import { parseHistoryMessage } from '@/utils/StreamParser'
import { useTablePagination } from '@/views/session/composables/useTablePagination'
import styles from './SessionBrowser.module.scss'

// 全局非 scoped 样式（对应 Vue <style lang="scss"> @use '@/views/session/styles/*.scss'）
import '@/views/session/styles/message.scss'
import '@/views/session/styles/markdown.scss'
import '@/views/session/styles/blocks.scss'

const ACTION_LABELS: Record<string, string> = {
  smart_query: '智能问数',
  root_cause: '归因分析',
  deep_research: '深度研究',
  data_claw: 'Data Claw',
  nl2sql: 'NL2SQL',
  data_science: '数据科学',
}

// 功能类型图标（对应原 getActionTypeIcon，使用 EP 名）
const ACTION_TYPE_ICON: Record<string, string> = {
  nl2sql: 'Connection',
  smart_query: 'QuestionFilled',
  root_cause: 'TrendCharts',
  deep_research: 'DataAnalysis',
  data_science: 'DataAnalysis',
}

const formatTime = (iso: any) => {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const formatRelativeTime = (dateStr: any) => {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const minutes = Math.floor(diff / (1000 * 60))
  const hours = Math.floor(diff / (1000 * 60 * 60))
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))

  if (minutes < 60) return `${minutes} 分钟前`
  if (hours < 24) return `${hours} 小时前`
  if (days < 7) return `${days} 天前`
  return date.toLocaleDateString()
}

// 上述工具函数（getActionLabel / getActionTypeIcon）当前模板未直接使用，
// 但保留映射以与原 Vue 行为完全一致，便于后续扩展。
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const getActionLabel = (type: string) => ACTION_LABELS[type] || type
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const getActionTypeIcon = (actionType: string) =>
  ACTION_TYPE_ICON[actionType] || 'QuestionFilled'

export default function SessionBrowser() {
  const [loading, setLoading] = useState(false)
  const [sessions, setSessions] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const pageSize = 20
  const [filters, setFilters] = useState<{ action_type: string; user_name: string }>({
    action_type: '',
    user_name: '',
  })

  const [selectedSessionId, setSelectedSessionId] = useState('')
  const [selectedSession, setSelectedSession] = useState<any>(null)
  const [messages, setMessages] = useState<any[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const messagesListRef = useRef<HTMLDivElement>(null)

  // 提供 feedbackMap 给 MessageItem 子组件（对应 provide('feedbackMap', feedbackMap)）
  const [feedbackMap, setFeedbackMap] = useState<Record<string, string>>({})

  // 提供表格分页给 MessageItem -> ContentBlock / TaskProgress 子组件
  // （对应 provide('getTablePagination' ...)，React 侧由 ShareReadonlyContext 承载）
  const {
    getTablePagination,
    getTableData,
    getTableColumns,
    getPaginatedTableData,
    getTableSummary,
  } = useTablePagination()

  // ref 镜像 filters/page，供回调内读到最新值（避免闭包陈旧）
  const filtersRef = useRef(filters)
  filtersRef.current = filters
  const pageRef = useRef(page)
  pageRef.current = page

  const loadSessions = async () => {
    setLoading(true)
    try {
      const params: any = { page: pageRef.current, page_size: pageSize }
      if (filtersRef.current.action_type) params.action_type = filtersRef.current.action_type
      if (filtersRef.current.user_name) params.user_name = filtersRef.current.user_name
      const res: any = await getAdminSessionsReq(params)
      setSessions(res.data?.items || [])
      setTotal(res.data?.total || 0)
    } catch (e) {
      console.error('加载会话列表失败:', e)
    } finally {
      setLoading(false)
    }
  }

  const selectSession = async (item: any) => {
    setSelectedSessionId(item.id)
    setSelectedSession(item)
    setMessagesLoading(true)
    try {
      const res: any = await getAdminSessionMessagesReq(item.id, { limit: 200 })
      const rawMessages = res.data?.messages || []
      setMessages(
        rawMessages
          .filter(
            (msg: any) =>
              !(msg.role === 'user' && msg.message_metadata?.is_user_input_response)
          )
          .map((msg: any) => parseHistoryMessage(msg))
      )
      // 等待渲染后把滚动条复位到顶部（对应 nextTick + scrollTop = 0）
      requestAnimationFrame(() => {
        if (messagesListRef.current) {
          messagesListRef.current.scrollTop = 0
        }
      })
    } catch (e) {
      console.error('加载消息失败:', e)
      setMessages([])
    } finally {
      setMessagesLoading(false)
    }
  }

  const handlePageChange = (p: number) => {
    setPage(p)
    pageRef.current = p
    setSelectedSessionId('')
    setSelectedSession(null)
    setMessages([])
    loadSessions()
  }

  const handleSearch = () => {
    setPage(1)
    pageRef.current = 1
    setSelectedSessionId('')
    setSelectedSession(null)
    setMessages([])
    loadSessions()
  }

  useEffect(() => {
    loadSessions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // el-pagination total 模式下页数（对应 el-pagination 的 total/page-size 内部换算）
  const pageCount = useMemo(
    () => Math.max(1, Math.ceil(total / pageSize)),
    [total]
  )

  // 只读上下文值，供 MessageItem 子链路（ContentBlock / TaskProgress）使用
  const shareCtxValue = useMemo(
    () => ({
      readonly: true,
      feedbackMap,
      businessId: null,
      sessionId: selectedSessionId,
      getTablePagination,
      getTableData,
      getTableColumns,
      getPaginatedTableData,
      getTableSummary,
    }),
    [
      feedbackMap,
      selectedSessionId,
      getTablePagination,
      getTableData,
      getTableColumns,
      getPaginatedTableData,
      getTableSummary,
    ]
  )

  return (
    <div className={styles.sessionBrowser}>
      {/* 顶部筛选区 */}
      <div className={styles.filterBar}>
        <div className={styles.titleSection}>
          <h2>会话浏览器</h2>
          {total > 0 && <span className={styles.totalCount}>共 {total} 条记录</span>}
        </div>
        <div className={styles.filters}>
          <TextInput
            value={filters.user_name}
            placeholder="搜索用户"
            style={{ width: 160 }}
            leftSection={<ElSvgIcon name="Search" size={16} />}
            onChange={(e) =>
              setFilters((prev) => ({ ...prev, user_name: e.currentTarget.value }))
            }
            onKeyUp={(e) => {
              if (e.key === 'Enter') handleSearch()
            }}
          />
          <Select
            value={filters.action_type || null}
            placeholder="功能类型"
            clearable
            style={{ width: 160 }}
            data={[
              { label: '智能问数', value: 'smart_query' },
              { label: '归因分析', value: 'root_cause' },
              { label: '深度研究', value: 'deep_research' },
            ]}
            onChange={(val) => {
              setFilters((prev) => ({ ...prev, action_type: val || '' }))
              filtersRef.current = { ...filtersRef.current, action_type: val || '' }
              handleSearch()
            }}
          />
          <Button
            variant="default"
            leftSection={<ElSvgIcon name="Refresh" size={16} />}
            onClick={loadSessions}
          >
            刷新
          </Button>
        </div>
      </div>

      {/* 主体区域：左侧列表 + 右侧消息 */}
      <div className={styles.mainArea}>
        {/* 左侧会话列表 */}
        <div className={styles.sessionListPanel}>
          {loading ? (
            <div className={styles.loadingSection}>
              <Skeleton height={16} mb={12} radius="sm" />
              <Skeleton height={16} mb={12} radius="sm" />
              <Skeleton height={16} mb={12} radius="sm" />
              <Skeleton height={16} mb={12} radius="sm" />
              <Skeleton height={16} mb={12} radius="sm" />
              <Skeleton height={16} mb={12} radius="sm" />
              <Skeleton height={16} mb={12} radius="sm" />
              <Skeleton height={16} radius="sm" />
            </div>
          ) : sessions.length === 0 ? (
            <div className={styles.emptyState}>
              <span style={{ color: 'var(--el-text-color-secondary)' }}>暂无会话</span>
            </div>
          ) : (
            <div className={styles.historyList}>
              {sessions.map((item) => (
                <div
                  key={item.id}
                  className={`${styles.historyItem} ${
                    selectedSessionId === item.id ? styles.active : ''
                  }`}
                  onClick={() => selectSession(item)}
                >
                  <div className={styles.itemHeader}>
                    <div className={styles.leftInfo}>
                      <h3 className={styles.title}>{item.title || '无标题'}</h3>
                      <div className={styles.metaInfo}>
                        <span className={styles.userTag}>
                          <ElSvgIcon name="User" size={12} />
                          {item.user_name}
                        </span>
                        <span className={styles.createdTime}>
                          <ElSvgIcon name="Clock" size={12} />
                          {formatRelativeTime(item.created_at)}
                        </span>
                        {item.message_count ? (
                          <span className={styles.messageCount}>
                            <ElSvgIcon name="Grid" size={12} />
                            {item.message_count} 条消息
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 分页 */}
          <div className={styles.listPagination}>
            <Pagination
              size="sm"
              value={page}
              total={pageCount}
              onChange={handlePageChange}
            />
          </div>
        </div>

        {/* 右侧消息详情 */}
        <div className={styles.messagePanel}>
          {!selectedSessionId ? (
            <div className={styles.emptyState}>
              <span style={{ color: 'var(--el-text-color-secondary)' }}>
                选择左侧会话查看消息
              </span>
            </div>
          ) : messagesLoading ? (
            <div className={styles.loadingSection}>
              <Skeleton height={16} mb={12} radius="sm" />
              <Skeleton height={16} mb={12} radius="sm" />
              <Skeleton height={16} mb={12} radius="sm" />
              <Skeleton height={16} mb={12} radius="sm" />
              <Skeleton height={16} mb={12} radius="sm" />
              <Skeleton height={16} radius="sm" />
            </div>
          ) : (
            <div className={styles.sessionDetail}>
              {/* 详情头部 */}
              <div className={styles.sessionHeader}>
                <h2 className={styles.sessionTitle}>
                  {selectedSession?.title || '会话详情'}
                </h2>
                <span className={styles.sessionMeta}>
                  {selectedSession?.user_name} · {formatTime(selectedSession?.created_at)}
                </span>
              </div>

              {/* 消息列表 */}
              <div className={styles.sessionContent}>
                <div className={styles.messagesContainer} ref={messagesListRef}>
                  {/* 把 feedbackMap / 表格分页 注入子组件链路，对应 Vue 的多个 provide */}
                  <ShareReadonlyContext.Provider value={shareCtxValue}>
                    <FeedbackMapContext.Provider
                      value={{ map: feedbackMap, setMap: setFeedbackMap }}
                    >
                      {messages.map((msg) => (
                        <div key={msg.id} className={styles.messageSelectWrapper}>
                          <MessageItem
                            message={msg}
                            sessionId={selectedSessionId}
                            readonly
                          />
                        </div>
                      ))}
                    </FeedbackMapContext.Provider>
                  </ShareReadonlyContext.Provider>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
