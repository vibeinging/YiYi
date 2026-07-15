// 反馈管理（源：views/admin/FeedbackManagement.vue）
// el-table → Mantine Table 手动 map（含 type=selection 全选/单选）；el-dialog → Modal；
// ElMessage → notifications.show；ElMessageBox → modals.openConfirmModal；
// provide('feedbackMap' / 'getTablePagination' ...) → FeedbackMapContext + ShareReadonlyContext。
import { useEffect, useMemo, useRef, useState } from 'react'
import { apiStreamFetch } from '@/utils/api-stream'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  Checkbox,
  LoadingOverlay,
  Modal,
  Pagination,
  Select,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import ElSvgIcon from '@/components/ElSvgIcon'
import {
  getAdminFeedbacks,
  getAdminFeedbackContext,
  deleteAdminFeedbacks,
} from '@/api/feedback'
import { createAPIURL } from '@/utils/url-helper'
import { useBasicStore } from '@/store/basic'
import { parseHistoryMessage } from '@/utils/StreamParser'
import { MessageItem } from '@/views/session/components'
import { FeedbackMapContext } from '@/views/session/components/MessageItem'
import { ShareReadonlyContext } from '@/views/share/index'
import { useTablePagination } from '@/views/session/composables/useTablePagination'
import styles from './FeedbackManagement.module.scss'

// 全局非 scoped 样式（对应 Vue <style lang="scss"> @use '@/views/session/styles/*.scss'）
import '@/views/session/styles/message.scss'
import '@/views/session/styles/markdown.scss'
import '@/views/session/styles/blocks.scss'

const formatTime = (timeStr: any) => {
  if (!timeStr) return '-'
  const d = new Date(timeStr)
  return d.toLocaleString('zh-CN', { hour12: false })
}

export default function FeedbackManagement() {
  const { t } = useTranslation()

  // 提供 MessageItem 需要的依赖（对应 provide('feedbackMap', feedbackMap)）
  const [feedbackMap, setFeedbackMap] = useState<Record<string, string>>({})

  // 表格分页函数（对应 provide('getTablePagination' ...)，React 侧由 ShareReadonlyContext 承载）
  const {
    getTablePagination,
    getTableData,
    getTableColumns,
    getPaginatedTableData,
    getTableSummary,
  } = useTablePagination()

  const [loading, setLoading] = useState(false)
  const [tableData, setTableData] = useState<any[]>([])
  const [selectedIds, setSelectedIds] = useState<any[]>([])
  const [detailVisible, setDetailVisible] = useState(false)
  const [detailData, setDetailData] = useState<any>(null)
  const [contextLoading, setContextLoading] = useState(false)
  const [contextMessages, setContextMessages] = useState<any[]>([])

  // 搜索
  const [keyword, setKeyword] = useState('')
  const [feedbackType, setFeedbackType] = useState('')

  // pagination(reactive) → useState 对象
  const [pagination, setPagination] = useState({ page: 1, page_size: 20, total: 0 })

  // ref 镜像，供回调内读到最新值（避免闭包陈旧）
  const keywordRef = useRef(keyword)
  keywordRef.current = keyword
  const feedbackTypeRef = useRef(feedbackType)
  feedbackTypeRef.current = feedbackType
  const paginationRef = useRef(pagination)
  paginationRef.current = pagination
  const selectedIdsRef = useRef(selectedIds)
  selectedIdsRef.current = selectedIds

  const loadData = async () => {
    setLoading(true)
    try {
      const params: any = {
        page: paginationRef.current.page,
        page_size: paginationRef.current.page_size,
      }
      if (keywordRef.current) params.keyword = keywordRef.current
      if (feedbackTypeRef.current) params.feedback_type = feedbackTypeRef.current

      const res: any = await getAdminFeedbacks(params)
      if (res.success) {
        setTableData(res.data.items || [])
        setPagination((prev) => ({ ...prev, total: res.data.total || 0 }))
      }
    } catch (error) {
      console.error('加载反馈列表失败:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleSearch = () => {
    setPagination((prev) => ({ ...prev, page: 1 }))
    paginationRef.current = { ...paginationRef.current, page: 1 }
    loadData()
  }

  const handlePageChange = (page: number) => {
    setPagination((prev) => ({ ...prev, page }))
    paginationRef.current = { ...paginationRef.current, page }
    loadData()
  }

  const handleSizeChange = (pageSizeStr: string | null) => {
    const page_size = Number(pageSizeStr) || 20
    setPagination((prev) => ({ ...prev, page: 1, page_size }))
    paginationRef.current = { ...paginationRef.current, page: 1, page_size }
    loadData()
  }

  // 选择变化（对应 @selection-change handleSelectionChange）
  const handleSelectionChange = (rows: any[]) => {
    setSelectedIds(rows.map((r) => r.id))
  }

  // 全选/取消全选
  const allChecked = tableData.length > 0 && selectedIds.length === tableData.length
  const indeterminate = selectedIds.length > 0 && selectedIds.length < tableData.length
  const toggleSelectAll = () => {
    if (allChecked) {
      handleSelectionChange([])
    } else {
      handleSelectionChange(tableData)
    }
  }
  const toggleRow = (row: any, checked: boolean) => {
    const rows = checked
      ? tableData.filter((r) => selectedIds.includes(r.id) || r.id === row.id)
      : tableData.filter((r) => selectedIds.includes(r.id) && r.id !== row.id)
    handleSelectionChange(rows)
  }

  // 单条删除
  const handleDelete = (row: any) => {
    // ElMessageBox.confirm → modals.openConfirmModal（确认逻辑搬到 onConfirm）
    modals.openConfirmModal({
      title: t('admin.feedback.deleteConfirmTitle'),
      children: t('admin.feedback.deleteConfirmMsg'),
      labels: { confirm: t('common.delete'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          const res: any = await deleteAdminFeedbacks([row.id])
          if (res.success) {
            notifications.show({ color: 'green', message: t('admin.feedback.deleted') })
            loadData()
          }
        } catch (error) {
          notifications.show({ color: 'red', message: t('admin.feedback.deleteFailed') })
        }
      },
    })
  }

  // 批量删除
  const handleBatchDelete = () => {
    modals.openConfirmModal({
      title: t('admin.feedback.batchDeleteConfirmTitle'),
      children: t('admin.feedback.batchDeleteConfirmMsg', {
        count: selectedIdsRef.current.length,
      }),
      labels: { confirm: t('common.delete'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          const res: any = await deleteAdminFeedbacks(selectedIdsRef.current)
          if (res.success) {
            notifications.show({
              color: 'green',
              message: t('admin.feedback.batchDeleted', { count: res.data.deleted }),
            })
            setSelectedIds([])
            loadData()
          }
        } catch (error) {
          notifications.show({ color: 'red', message: t('admin.feedback.deleteFailed') })
        }
      },
    })
  }

  // 导出CSV 的真实下载逻辑（抽出以便确认弹窗 onConfirm 复用）
  const doExport = () => {
    const token = useBasicStore.getState().token
    const params = new URLSearchParams()
    if (keywordRef.current) params.set('keyword', keywordRef.current)
    if (feedbackTypeRef.current) params.set('feedback_type', feedbackTypeRef.current)
    if (selectedIdsRef.current.length > 0)
      params.set('ids', selectedIdsRef.current.join(','))
    const qs = params.toString()
    const url = createAPIURL(`/api/admin/feedbacks/export${qs ? '?' + qs : ''}`)

    apiStreamFetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.blob()
      })
      .then((blob) => {
        const blobUrl = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = blobUrl
        link.download = `feedback_${new Date()
          .toLocaleDateString('zh-CN')
          .replace(/\//g, '-')}.csv`
        link.click()
        URL.revokeObjectURL(blobUrl)
        notifications.show({ color: 'green', message: t('admin.feedback.exportSuccess') })
      })
      .catch(() =>
        notifications.show({ color: 'red', message: t('admin.feedback.exportFailed') })
      )
  }

  // 导出CSV
  const handleExport = () => {
    if (selectedIdsRef.current.length === 0) {
      // 未勾选 → 先确认导出全部
      modals.openConfirmModal({
        title: t('admin.feedback.exportConfirmTitle'),
        children: t('admin.feedback.exportAllConfirmMsg'),
        labels: { confirm: t('admin.feedback.exportAll'), cancel: t('common.cancel') },
        onConfirm: () => doExport(),
      })
      return
    }
    doExport()
  }

  const showDetail = async (row: any) => {
    setDetailData(row)
    setDetailVisible(true)
    setContextMessages([])
    setContextLoading(true)

    try {
      const res: any = await getAdminFeedbackContext(row.message_id, row.session_id)
      if (res.success) {
        const msgs: any[] = []
        if (res.data.user_message) {
          msgs.push(parseHistoryMessage(res.data.user_message))
        }
        if (res.data.ai_message) {
          msgs.push(parseHistoryMessage(res.data.ai_message))
        }
        setContextMessages(msgs)
      }
    } catch (error) {
      console.error('加载消息上下文失败:', error)
    } finally {
      setContextLoading(false)
    }
  }

  useEffect(() => {
    loadData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // el-pagination total 模式下页数（对应 el-pagination 的 total/page-size 内部换算）
  const pageCount = useMemo(
    () => Math.max(1, Math.ceil(pagination.total / pagination.page_size)),
    [pagination.total, pagination.page_size]
  )

  // 只读上下文值，供 MessageItem 子链路（ContentBlock / TaskProgress）使用
  const shareCtxValue = useMemo(
    () => ({
      readonly: true,
      feedbackMap,
      businessId: null,
      sessionId: detailData?.session_id,
      getTablePagination,
      getTableData,
      getTableColumns,
      getPaginatedTableData,
      getTableSummary,
    }),
    [
      feedbackMap,
      detailData,
      getTablePagination,
      getTableData,
      getTableColumns,
      getPaginatedTableData,
      getTableSummary,
    ]
  )

  return (
    <div className={styles['admin-feedback-management']}>
      {/* 页面头部 */}
      <div className={styles['page-header']}>
        <div className={styles['header-left']}>
          <h1>{t('admin.feedback.title')}</h1>
          <p>{t('admin.feedback.subtitle')}</p>
        </div>
        <div className={styles['header-right']}>
          <Button
            variant="default"
            leftSection={<ElSvgIcon name="Download" size={16} />}
            onClick={handleExport}
          >
            {t('admin.feedback.exportCSV')}
          </Button>
          <Button
            leftSection={<ElSvgIcon name="Refresh" size={16} />}
            loading={loading}
            onClick={loadData}
          >
            {t('common.refresh')}
          </Button>
        </div>
      </div>

      {/* 搜索栏 */}
      <div className={styles['search-bar']}>
        <TextInput
          value={keyword}
          placeholder={t('admin.feedback.searchPlaceholder')}
          style={{ width: 300 }}
          leftSection={<ElSvgIcon name="Search" size={16} />}
          onChange={(e) => setKeyword(e.currentTarget.value)}
          onKeyUp={(e) => {
            if (e.key === 'Enter') handleSearch()
          }}
        />
        <Select
          value={feedbackType || null}
          placeholder={t('admin.feedback.allTypes')}
          clearable
          style={{ width: 130 }}
          data={[
            { label: t('admin.feedback.like'), value: 'like' },
            { label: t('admin.feedback.dislike'), value: 'dislike' },
          ]}
          onChange={(val) => {
            const next = val || ''
            setFeedbackType(next)
            feedbackTypeRef.current = next
            handleSearch()
          }}
        />
        <Button onClick={handleSearch}>{t('common.search')}</Button>
        {selectedIds.length > 0 && (
          <Button color="red" variant="light" onClick={handleBatchDelete}>
            {t('admin.feedback.deleteSelected', { count: selectedIds.length })}
          </Button>
        )}
      </div>

      {/* 数据表格 */}
      <div className={styles['table-wrapper']}>
        <LoadingOverlay visible={loading} />
        <Table striped highlightOnHover style={{ width: '100%' }}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th style={{ width: 45, textAlign: 'center' }}>
                <Checkbox
                  aria-label="select-all"
                  checked={allChecked}
                  indeterminate={indeterminate}
                  onChange={toggleSelectAll}
                />
              </Table.Th>
              <Table.Th style={{ width: 70, textAlign: 'center' }}>
                {t('admin.feedback.feedback')}
              </Table.Th>
              <Table.Th style={{ width: 120 }}>{t('admin.feedback.user')}</Table.Th>
              <Table.Th style={{ width: 160 }}>{t('admin.feedback.session')}</Table.Th>
              <Table.Th style={{ minWidth: 200 }}>
                {t('admin.feedback.userQuestion')}
              </Table.Th>
              <Table.Th style={{ minWidth: 250 }}>
                {t('admin.feedback.aiResponse')}
              </Table.Th>
              <Table.Th style={{ minWidth: 200 }}>
                {t('admin.feedback.dislikeReason')}
              </Table.Th>
              <Table.Th style={{ width: 170 }}>{t('admin.feedback.time')}</Table.Th>
              <Table.Th style={{ width: 140, textAlign: 'center' }}>
                {t('admin.feedback.actions')}
              </Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {tableData.map((row) => (
              <Table.Tr key={row.id}>
                <Table.Td style={{ textAlign: 'center' }}>
                  <Checkbox
                    aria-label={`select-${row.id}`}
                    checked={selectedIds.includes(row.id)}
                    onChange={(e) => toggleRow(row, e.currentTarget.checked)}
                  />
                </Table.Td>
                <Table.Td style={{ textAlign: 'center' }}>
                  <Badge
                    size="sm"
                    color={row.feedback_type === 'like' ? 'green' : 'red'}
                  >
                    {row.feedback_type === 'like'
                      ? t('admin.feedback.thumbUp')
                      : t('admin.feedback.thumbDown')}
                  </Badge>
                </Table.Td>
                <Table.Td>{row.username}</Table.Td>
                <Table.Td>
                  <Tooltip label={row.session_title} disabled={!row.session_title}>
                    <Text size="sm" lineClamp={1}>
                      {row.session_title}
                    </Text>
                  </Tooltip>
                </Table.Td>
                <Table.Td>
                  <Tooltip label={row.user_question} disabled={!row.user_question} multiline maw={400}>
                    <Text size="sm" lineClamp={1}>
                      {row.user_question}
                    </Text>
                  </Tooltip>
                </Table.Td>
                <Table.Td>
                  <Tooltip label={row.ai_response} disabled={!row.ai_response} multiline maw={400}>
                    <Text size="sm" lineClamp={1}>
                      {row.ai_response}
                    </Text>
                  </Tooltip>
                </Table.Td>
                <Table.Td>
                  {row.feedback_reason ? (
                    <Tooltip label={row.feedback_reason} multiline maw={400}>
                      <Text size="sm" lineClamp={1}>
                        {row.feedback_reason}
                      </Text>
                    </Tooltip>
                  ) : (
                    <span className={styles['text-muted']}>-</span>
                  )}
                </Table.Td>
                <Table.Td>{formatTime(row.created_at)}</Table.Td>
                <Table.Td style={{ textAlign: 'center' }}>
                  <Button
                    variant="subtle"
                    size="compact-sm"
                    className={styles['action-btn']}
                    onClick={() => showDetail(row)}
                  >
                    {t('admin.feedback.detail')}
                  </Button>
                  <Button
                    variant="subtle"
                    color="red"
                    size="compact-sm"
                    className={styles['action-btn']}
                    onClick={() => handleDelete(row)}
                  >
                    {t('common.delete')}
                  </Button>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>

      {/* 分页 */}
      <div className={styles['pagination-wrapper']}>
        <Text size="sm" c="dimmed">
          共 {pagination.total} 条
        </Text>
        <Select
          value={String(pagination.page_size)}
          data={[
            { label: '20', value: '20' },
            { label: '50', value: '50' },
            { label: '100', value: '100' },
          ]}
          style={{ width: 90 }}
          onChange={handleSizeChange}
        />
        <Pagination
          size="sm"
          value={pagination.page}
          total={pageCount}
          onChange={handlePageChange}
        />
      </div>

      {/* 详情弹窗 */}
      <Modal
        opened={detailVisible}
        onClose={() => setDetailVisible(false)}
        title={t('admin.feedback.detailTitle')}
        size="70%"
        styles={{ inner: { paddingTop: '5vh' } }}
      >
        {detailData && (
          <div className={styles['feedback-detail']}>
            {/* 元信息 */}
            <div className={styles['detail-meta']}>
              <span>
                <b>{t('admin.feedback.user')}:</b> {detailData.username}
              </span>
              <span>
                <b>{t('admin.feedback.session')}:</b> {detailData.session_title || '-'}
              </span>
              <span>
                <b>{t('admin.feedback.feedback')}:</b>{' '}
                <Badge
                  size="sm"
                  color={detailData.feedback_type === 'like' ? 'green' : 'red'}
                >
                  {detailData.feedback_type === 'like'
                    ? t('admin.feedback.like')
                    : t('admin.feedback.dislike')}
                </Badge>
              </span>
              <span>
                <b>{t('admin.feedback.time')}:</b> {formatTime(detailData.created_at)}
              </span>
            </div>

            {/* 反对理由 */}
            {detailData.feedback_reason && (
              <div className={styles['detail-reason']}>
                <b>{t('admin.feedback.dislikeReason')}:</b> {detailData.feedback_reason}
              </div>
            )}

            {/* 消息上下文 */}
            <div className={styles['detail-messages']}>
              <LoadingOverlay visible={contextLoading} />
              {contextMessages.length > 0 ? (
                <ShareReadonlyContext.Provider value={shareCtxValue}>
                  <FeedbackMapContext.Provider
                    value={{ map: feedbackMap, setMap: setFeedbackMap }}
                  >
                    {contextMessages.map((msg) => (
                      <div key={msg.id} className={styles['message-select-wrapper']}>
                        <MessageItem
                          message={msg}
                          databaseId={null}
                          sessionId={detailData.session_id}
                        />
                      </div>
                    ))}
                  </FeedbackMapContext.Provider>
                </ShareReadonlyContext.Provider>
              ) : (
                !contextLoading && (
                  <Text size="sm" c="dimmed" ta="center" py="xl">
                    {t('admin.feedback.messageUnavailable')}
                  </Text>
                )
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
