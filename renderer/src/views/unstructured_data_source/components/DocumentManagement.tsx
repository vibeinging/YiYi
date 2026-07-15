import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Accordion,
  Badge,
  Button,
  Center,
  Checkbox,
  Modal,
  NumberInput,
  Pagination,
  Progress,
  SegmentedControl,
  Stepper,
  Table,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core'
import { Dropzone } from '@mantine/dropzone'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import {
  IconAlertTriangleFilled,
  IconCheck,
  IconEdit,
  IconEye,
  IconFileText,
  IconFilePlus,
  IconFolderOpen,
  IconInfoCircle,
  IconRefresh,
  IconSparkles,
  IconTrash,
} from '@tabler/icons-react'
import {
  listDocumentsReq,
  deleteDocumentReq,
  processDocumentsReq,
  deleteDocumentsBatchReq,
  createDocumentsReq,
  uploadDocumentsReq,
  getDocumentChunksReq,
  generateDocumentDescriptionsReq,
  updateDocumentDescriptionReq,
} from '@/api/unstructured_data_source/document'
import { useProjectStore, projectGetters } from '@/store/project'
import { useResponsive } from '@/hooks/use-responsive'
import styles from './DocumentManagement.module.scss'

interface DocumentManagementProps {
  dataSourceId: string
}

// 本地文件项（前端临时态）
interface UploadFileItem {
  uid: string
  name: string
  size: number
  progress: number
  success: boolean
  failed: boolean
  error: string
  source: File
  relative_path: string
  timer: any
}

const acceptedExtensions = ['.pdf', '.doc', '.docx', '.txt', '.md', '.markdown', '.html', '.htm', '.rtf', '.ofd']
const acceptedFileTypes = {
  'application/pdf': ['.pdf'],
  'application/msword': ['.doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'text/plain': ['.txt'],
  'text/markdown': ['.md', '.markdown'],
  'text/html': ['.html', '.htm'],
  'application/rtf': ['.rtf'],
  'text/rtf': ['.rtf'],
  'application/vnd.ofd': ['.ofd']
}
const acceptedExtensionSet = new Set(acceptedExtensions)

const getFileExtension = (fileName: string) => {
  const normalized = fileName.toLowerCase()
  const dotIndex = normalized.lastIndexOf('.')
  return dotIndex >= 0 ? normalized.slice(dotIndex) : ''
}

const validateAcceptedFileType = (file: File) => {
  if (acceptedExtensionSet.has(getFileExtension(file.name))) return null
  return {
    code: 'file-invalid-type',
    message: 'Unsupported file type'
  }
}

const isAcceptedLocalPath = (filePath: string) => acceptedExtensionSet.has(getFileExtension(filePath))

const getFileNameFromPath = (filePath: string) => filePath.split(/[\\/]/).filter(Boolean).pop() || filePath

export default function DocumentManagement({ dataSourceId }: DocumentManagementProps) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language || 'zh'

  const projectId = useProjectStore((s) => projectGetters.currentProjectId(s))
  const { isMobile } = useResponsive()

  // ============ 列表模式状态 ============
  const [loading, setLoading] = useState(false)
  const [documentList, setDocumentList] = useState<any[]>([])
  const [openingDocumentIds, setOpeningDocumentIds] = useState<Set<any>>(new Set())
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [totalCount, setTotalCount] = useState(0)
  const pollingTimer = useRef<any>(null)
  const [selectedRowKeys, setSelectedRowKeys] = useState<Set<any>>(new Set())

  // ============ 添加本地文档状态 ============
  const [uploadDialogVisible, setUploadDialogVisible] = useState(false)
  const [uploadStep, setUploadStep] = useState(0)
  const [uploadedFiles, setUploadedFiles] = useState<UploadFileItem[]>([])
  const [chunkSize, setChunkSize] = useState<number | string>(512)
  const [delimiter, setDelimiter] = useState('')
  const [delimiterError, setDelimiterError] = useState('')
  const [splitStrategy, setSplitStrategy] = useState('smart')
  const [breakpointThresholdType, setBreakpointThresholdType] = useState('percentile')
  const [submitting, setSubmitting] = useState(false)

  // ============ 描述生成状态 ============
  const [generatingDescriptions, setGeneratingDescriptions] = useState(false)
  const [descDialogVisible, setDescDialogVisible] = useState(false)
  const [descDialogDoc, setDescDialogDoc] = useState<any>(null)
  const [descDialogText, setDescDialogText] = useState('')
  const [descSaving, setDescSaving] = useState(false)
  const [descGenerating, setDescGenerating] = useState(false)

  // ============ 查看分块状态 ============
  const [chunksDialogVisible, setChunksDialogVisible] = useState(false)
  const [currentChunks, setCurrentChunks] = useState<any[]>([])
  const [chunksLoading, setChunksLoading] = useState(false)
  const [chunksCurrentPage, setChunksCurrentPage] = useState(1)
  const [chunksPageSize, setChunksPageSize] = useState(20)
  const [chunksTotal, setChunksTotal] = useState(0)
  const [chunksDialogDoc, setChunksDialogDoc] = useState<any>(null)
  const [chunkTextMode, setChunkTextMode] = useState<'clean' | 'raw'>('clean')
  const currentChunksDocumentId = useRef<any>(null)

  // 用 ref 保存最新的列表数据，供轮询与无依赖回调读取
  const documentListRef = useRef<any[]>([])
  documentListRef.current = documentList

  const successUploadCount = useMemo(() => uploadedFiles.filter((f) => f.success).length, [uploadedFiles])
  const hasNativePathPicker = typeof (window as any).electronAPI?.pickPaths === 'function'
  const documentStats = useMemo(() => {
    const processing = documentList.filter((item) => item.status === 'processing' || item.status === 'pending').length
    const completed = documentList.filter((item) => item.status === 'completed').length
    const vectorized = documentList.filter((item) => item.embedding_status === 'completed').length
    const failed = documentList.filter((item) => item.status === 'failed' || item.status === 'cancelled').length
    return {
      total: totalCount || documentList.length,
      completed,
      vectorized,
      processing,
      failed,
      selected: selectedRowKeys.size,
    }
  }, [documentList, selectedRowKeys.size, totalCount])
  const chunkDialogStats = useMemo(() => {
    const vectorized = currentChunks.filter((chunk) => chunk.is_embedding).length
    return {
      total: chunksTotal || currentChunks.length,
      current: currentChunks.length,
      vectorized,
      page: chunksCurrentPage,
      pageTotal: Math.max(1, Math.ceil((chunksTotal || currentChunks.length || 1) / chunksPageSize)),
    }
  }, [chunksCurrentPage, chunksPageSize, chunksTotal, currentChunks])

  const strategyOptions = useMemo(
    () => [
      { value: 'smart', label: t('unstructuredData.strategySmart'), desc: t('unstructuredData.strategySmartDesc') },
      {
        value: 'table_aware',
        label: t('unstructuredData.strategyTableAware'),
        desc: t('unstructuredData.strategyTableAwareDesc'),
      },
      {
        value: 'recursive',
        label: t('unstructuredData.strategyRecursive'),
        desc: t('unstructuredData.strategyRecursiveDesc'),
      },
    ],
    [t]
  )

  const thresholdOptions = useMemo(
    () => [
      { value: 'percentile', label: t('unstructuredData.thresholdPercentile') },
      { value: 'standard_deviation', label: t('unstructuredData.thresholdStdDev') },
      { value: 'interquartile', label: t('unstructuredData.thresholdIQR') },
      { value: 'gradient', label: t('unstructuredData.thresholdGradient') },
    ],
    [t]
  )

  // 验证分隔符
  useEffect(() => {
    if (delimiter && (delimiter.length < 1 || delimiter.length > 10 || /\s/.test(delimiter))) {
      setDelimiterError(t('unstructuredData.delimiterError'))
    } else {
      setDelimiterError('')
    }
  }, [delimiter, t])

  // onMounted + 翻页/改页大小时重新拉取（首次挂载也走此 effect，避免重复请求）
  useEffect(() => {
    getDocuments()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage, pageSize])

  // onBeforeUnmount：停止轮询
  useEffect(() => {
    return () => {
      stopPolling()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 生成表格行唯一 key，避免重复 key 导致行数显示异常
  const rowKey = (row: any) => row._rowKey || row.id || row.file_path || row.file_name

  // 统一整理列表数据，补充 _rowKey
  const normalizeDocumentList = (items: any) => {
    if (!Array.isArray(items)) return []
    return items.map((item: any, index: number) => ({
      ...item,
      _rowKey:
        item.id || item.document_id || `${item.file_path || item.relative_path || item.file_name || 'row'}-${index}`,
    }))
  }

  // ============ 列表模式逻辑 ============

  // 获取文档列表
  // silent: 静默刷新（轮询时使用），不显示 loading
  const getDocuments = async (silent = false) => {
    if (!silent) {
      setLoading(true)
    }
    try {
      const res: any = await listDocumentsReq(projectId, dataSourceId, currentPage, pageSize)
      setTotalCount(res?.data?.total || 0)
      // 确保 documentList 始终是数组
      const items = res?.data?.items
      const newList = normalizeDocumentList(items)

      // 静默刷新时，只更新有变化的行（避免整表刷新闪烁）
      const prev = documentListRef.current
      let nextList: any[]
      if (silent && prev.length === newList.length) {
        // 逐行对比更新
        nextList = prev.map((oldItem: any, index: number) => {
          const newItem = newList[index]
          if (oldItem && newItem && oldItem.id === newItem.id) {
            // 只更新变化的字段
            if (
              oldItem.status !== newItem.status ||
              oldItem.progress !== newItem.progress ||
              oldItem.chunk_count !== newItem.chunk_count ||
              oldItem.embedding_count !== newItem.embedding_count ||
              oldItem.embedding_status !== newItem.embedding_status
            ) {
              return { ...oldItem, ...newItem }
            }
            return oldItem
          }
          // ID 不匹配，直接替换
          return newItem
        })
      } else {
        // 首次加载或列表长度变化，直接替换
        nextList = newList
      }
      documentListRef.current = nextList
      setDocumentList(nextList)

      checkAndManagePolling(nextList)
    } catch (error) {
      if (!silent) {
        notifications.show({ color: 'red', message: t('unstructuredData.getDocumentListFailed') })
      }
      // 出错时也确保 documentList 是空数组
      documentListRef.current = []
      setDocumentList([])
    } finally {
      if (!silent) {
        setLoading(false)
      }
    }
  }

  // 检查是否有处理中的文档，管理轮询
  const checkAndManagePolling = (list: any[]) => {
    const hasProcessing = list.some((item: any) => {
      return item.status === 'pending' || item.status === 'processing'
    })

    if (hasProcessing) {
      startPolling()
    } else {
      stopPolling()
    }
  }

  // 启动轮询（静默刷新，不显示 loading）
  const startPolling = () => {
    if (pollingTimer.current) return
    pollingTimer.current = setInterval(() => {
      getDocuments(true)
    }, 3000)
  }

  // 停止轮询
  const stopPolling = () => {
    if (pollingTimer.current) {
      clearInterval(pollingTimer.current)
      pollingTimer.current = null
    }
  }

  const patchDocumentsLocally = (documentIds: any[], patch: Record<string, any>) => {
    const idSet = new Set(documentIds.filter(Boolean))
    if (idSet.size === 0) return

    setDocumentList((prev) => {
      const next = prev.map((item) => (idSet.has(item.id) ? { ...item, ...patch } : item))
      documentListRef.current = next
      checkAndManagePolling(next)
      return next
    })
  }

  // 当前选中行（基于 _rowKey 集合派生）
  const selectedRows = useMemo(
    () => documentList.filter((row) => selectedRowKeys.has(rowKey(row))),
    [documentList, selectedRowKeys]
  )

  // 处理选择变化（派生 ids 与 uploads）
  const { selectedDocumentIds, selectedUploadedPaths } = useMemo(() => {
    const ids: any[] = []
    const uploads: any[] = []
    selectedRows.forEach((r: any) => {
      if (r.status === 'uploaded' && !r.id && r.file_path) {
        uploads.push(r.file_path)
      }
      if (r.id) {
        ids.push(r.id)
      }
    })
    return { selectedDocumentIds: ids, selectedUploadedPaths: uploads }
  }, [selectedRows])

  const allSelected = documentList.length > 0 && selectedRowKeys.size === documentList.length
  const someSelected = selectedRowKeys.size > 0 && !allSelected

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedRowKeys(new Set())
    } else {
      setSelectedRowKeys(new Set(documentList.map((row) => rowKey(row))))
    }
  }

  const toggleSelectRow = (row: any) => {
    const key = rowKey(row)
    setSelectedRowKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const clearSelection = () => setSelectedRowKeys(new Set())

  // 批量处理未处理文件
  const batchProcessUploaded = async () => {
    if (selectedUploadedPaths.length === 0) return

    try {
      // 创建文档记录
      const createFormData = new FormData()
      createFormData.append('data_source_id', dataSourceId)
      createFormData.append('file_paths', JSON.stringify(selectedUploadedPaths))

      const createRes: any = await createDocumentsReq(projectId, createFormData)
      if (!createRes.success) {
        notifications.show({ color: 'red', message: t('unstructuredData.createDocumentFailed') })
        return
      }

      const createdDocs = createRes.data?.created_documents || []
      const documentIds = createdDocs.map((doc: any) => doc.document_id).filter((id: any) => id)

      if (documentIds.length === 0) {
        notifications.show({ color: 'yellow', message: t('unstructuredData.noDocumentCreated') })
        return
      }

      // 提交处理任务
      const processFormData = new FormData()
      processFormData.append('data_source_id', dataSourceId)
      processFormData.append('document_ids', JSON.stringify(documentIds))
      processFormData.append('chunk_size', '512')

      const res: any = await processDocumentsReq(projectId, processFormData)
      if (res.success) {
        notifications.show({ color: 'green', message: t('unstructuredData.batchProcessSubmitted') })
        clearSelection()
        setTimeout(() => getDocuments(), 500)
      } else {
        notifications.show({ color: 'red', message: t('unstructuredData.batchProcessFailed') })
      }
    } catch (error) {
      notifications.show({ color: 'red', message: t('unstructuredData.batchProcessFailed') })
    }
  }

  // ==================== 描述生成 ====================

  const handleGenerateDescriptions = async () => {
    if (selectedDocumentIds.length === 0) return
    setGeneratingDescriptions(true)
    try {
      const res: any = await generateDocumentDescriptionsReq(projectId, {
        data_source_id: dataSourceId,
        document_ids: selectedDocumentIds,
        language: locale || 'zh',
      })
      if (res?.data) {
        const { documents_generated, documents_processed } = res.data
        notifications.show({
          color: 'green',
          message: t('unstructuredData.descriptionGenerated', {
            success: documents_generated,
            total: documents_processed,
          }),
        })
        await getDocuments()
      }
    } catch (e: any) {
      notifications.show({
        color: 'red',
        message: t('unstructuredData.descriptionGenerateFailed', { error: e.message || e }),
      })
    } finally {
      setGeneratingDescriptions(false)
    }
  }

  const openDescriptionDialog = (row: any) => {
    setDescDialogDoc(row)
    setDescDialogText(row.description || '')
    setDescDialogVisible(true)
  }

  const handleGenerateSingleDesc = async () => {
    if (!descDialogDoc) return
    setDescGenerating(true)
    try {
      const res: any = await generateDocumentDescriptionsReq(projectId, {
        data_source_id: dataSourceId,
        document_ids: [descDialogDoc.id],
        language: locale || 'zh',
      })
      const detail = res?.data?.details?.[0]
      if (detail?.success) {
        setDescDialogText(detail.description)
        notifications.show({ color: 'green', message: t('unstructuredData.aiGenerateComplete') })
      } else {
        notifications.show({
          color: 'red',
          message: t('unstructuredData.generateFailed', {
            error: detail?.error || t('unstructuredData.unknownError'),
          }),
        })
      }
    } catch (e: any) {
      notifications.show({
        color: 'red',
        message: t('unstructuredData.generateFailed', { error: e.message || e }),
      })
    } finally {
      setDescGenerating(false)
    }
  }

  const saveDescriptionFromDialog = async () => {
    if (!descDialogDoc) return
    setDescSaving(true)
    try {
      await updateDocumentDescriptionReq(projectId, descDialogDoc.id, descDialogText)
      // 同步更新列表中对应行的描述
      setDocumentList((prev) =>
        prev.map((row) => (row.id === descDialogDoc.id ? { ...row, description: descDialogText } : row))
      )
      setDescDialogVisible(false)
      notifications.show({ color: 'green', message: t('unstructuredData.descriptionSaved') })
    } catch (e: any) {
      notifications.show({ color: 'red', message: t('unstructuredData.saveFailed', { error: e.message || e }) })
    } finally {
      setDescSaving(false)
    }
  }

  // 批量删除
  const batchDeleteAll = () => {
    if (selectedDocumentIds.length === 0) {
      notifications.show({ color: 'yellow', message: t('unstructuredData.pleaseSelectDocuments') })
      return
    }

    modals.openConfirmModal({
      title: t('unstructuredData.confirmBatchDeleteTitle'),
      children: t('unstructuredData.confirmBatchDelete', { count: selectedDocumentIds.length }),
      labels: { confirm: t('common.confirm') || '确定', cancel: t('common.cancel') || '取消' },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          const formData = new FormData()
          formData.append('document_ids', JSON.stringify(selectedDocumentIds))

          const res: any = await deleteDocumentsBatchReq(projectId, dataSourceId, formData)
          if (res?.success) {
            const deletedIds = res?.data?.deleted_ids || []
            notifications.show({
              color: 'green',
              message: t('unstructuredData.deleteSuccessCount', { count: deletedIds.length }),
            })
          } else {
            notifications.show({ color: 'red', message: t('unstructuredData.batchDeleteFailed') })
          }
        } catch (error) {
          notifications.show({ color: 'red', message: t('unstructuredData.batchDeleteFailed') })
        } finally {
          clearSelection()
          getDocuments()
        }
      },
    })
  }

  // 重新处理文档
  const reprocessDocument = async (row: any) => {
    try {
      const formData = new FormData()
      formData.append('data_source_id', dataSourceId)
      formData.append('document_ids', JSON.stringify([row.id]))
      formData.append('chunk_size', '512')

      const res: any = await processDocumentsReq(projectId, formData)
      if (res.success) {
        const submittedIds = (res?.data?.documents || [])
          .map((item: any) => item?.document_id || item?.id)
          .filter(Boolean)
        patchDocumentsLocally(submittedIds.length ? submittedIds : [row.id], {
          status: 'pending',
          progress: 0,
          error_msg: null,
        })
        notifications.show({ color: 'green', message: t('unstructuredData.reprocessSubmitted') })
        setTimeout(() => getDocuments(true), 500)
      } else {
        notifications.show({ color: 'red', message: t('unstructuredData.submitFailed') })
      }
    } catch (error) {
      notifications.show({ color: 'red', message: t('unstructuredData.reprocessFailed') })
    }
  }

  const openDocumentLocation = async (row: any) => {
    if (!row?.id || openingDocumentIds.has(row.id)) {
      return
    }

    const filePath = row.file_path || row.path || row.source_path
    if (!filePath) {
      notifications.show({ color: 'yellow', message: t('unstructuredData.openDocumentMissing') })
      return
    }

    const electronAPI = (window as any).electronAPI
    if (!electronAPI?.revealInFinder) {
      notifications.show({ color: 'yellow', message: t('unstructuredData.openDocumentDesktopOnly') })
      return
    }

    setOpeningDocumentIds((prev) => {
      const next = new Set(prev)
      next.add(row.id)
      return next
    })
    try {
      const ok = await electronAPI.revealInFinder(filePath)
      if (!ok) {
        notifications.show({ color: 'red', message: t('unstructuredData.openDocumentFailed') })
      }
    } catch (error) {
      notifications.show({ color: 'red', message: t('unstructuredData.openDocumentFailed') })
    } finally {
      setOpeningDocumentIds((prev) => {
        const next = new Set(prev)
        next.delete(row.id)
        return next
      })
    }
  }

  // 删除文档
  const deleteDocument = (row: any) => {
    modals.openConfirmModal({
      title: t('unstructuredData.confirmDeleteTitle'),
      children: t('unstructuredData.confirmDeleteDocument', { name: row.file_name }),
      labels: { confirm: t('common.confirm') || '确定', cancel: t('common.cancel') || '取消' },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          const res: any = await deleteDocumentReq(projectId, dataSourceId, row.id)
          if (res?.success) {
            notifications.show({ color: 'green', message: t('unstructuredData.deleteSuccess') })
            getDocuments()
          } else {
            notifications.show({ color: 'red', message: t('unstructuredData.deleteFailed') })
          }
        } catch (error) {
          notifications.show({ color: 'red', message: t('unstructuredData.deleteFailed') })
        }
      },
    })
  }

  // 工具函数
  const formatFileSize = (bytes: number) => {
    if (!bytes) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${Number.parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
  }

  const formatUploadTime = (value: any) => {
    if (!value) return '-'
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return String(value)
    return date.toLocaleString(locale.startsWith('zh') ? 'zh-CN' : 'en-US', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const getChunkText = (chunk: any) => chunk?.content_info?.content || chunk?.chunk_content || ''

  const formatChunkTextForDisplay = (value: any) => {
    const text = String(value || '').replace(/\r\n/g, '\n')
    const lines = text.split('\n')
    const out: string[] = []
    let shortLineGroup = ''

    const flushShortLineGroup = () => {
      if (shortLineGroup) {
        out.push(shortLineGroup)
        shortLineGroup = ''
      }
    }

    lines.forEach((rawLine) => {
      const line = rawLine.trim().replace(/\s+/g, ' ')
      if (!line) {
        flushShortLineGroup()
        if (out[out.length - 1] !== '') out.push('')
        return
      }

      const isSingleWordLine = line.length <= 4 && /[\u4e00-\u9fa5A-Za-z0-9]/.test(line)
      if (isSingleWordLine) {
        shortLineGroup += line
        return
      }

      flushShortLineGroup()
      out.push(line)
    })

    flushShortLineGroup()
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  }

  const formatChunkPreview = (chunk: any) => {
    const rawText = getChunkText(chunk)
    return (chunkTextMode === 'clean' ? formatChunkTextForDisplay(rawText) : String(rawText || ''))
      .replace(/\s+/g, ' ')
      .trim()
  }

  const getStatusText = (status: string) => {
    const statusMap: Record<string, string> = {
      pending: t('unstructuredData.statusPending'),
      processing: t('unstructuredData.statusProcessing'),
      embedding: '正在生成向量',
      embedding_partial: '部分向量失败',
      embedding_failed: '向量生成失败',
      completed: t('unstructuredData.statusCompleted'),
      failed: t('unstructuredData.statusFailed'),
      cancelled: t('unstructuredData.statusCancelled'),
      uploaded: t('unstructuredData.statusUnprocessed'),
    }
    return statusMap[status] || status
  }

  const getEmbeddingStatus = (row: any) => {
    const chunkCount = Number(row.chunk_count || 0)
    if (row.status !== 'completed' || chunkCount <= 0) return null
    const embeddingCount = Number(row.embedding_count || 0)
    const status = row.embedding_status || (embeddingCount >= chunkCount ? 'completed' : embeddingCount > 0 ? 'partial' : 'none')
    const tooltip = t('unstructuredData.embeddingStatusTooltip', {
      count: embeddingCount,
      total: chunkCount,
    })
    if (status === 'completed') {
      return {
        text: t('unstructuredData.embeddingStatusReady'),
        className: styles.embeddingReady,
        tooltip,
      }
    }
    if (status === 'partial') {
      return {
        text: t('unstructuredData.embeddingStatusPartial'),
        className: styles.embeddingPartial,
        tooltip,
      }
    }
    return {
      text: t('unstructuredData.embeddingStatusMissing'),
      className: styles.embeddingMissing,
      tooltip,
    }
  }

  // ============ 添加本地文档逻辑 ============

  // 打开添加文档对话框
  const enterUploadMode = () => {
    setUploadDialogVisible(true)
    setUploadStep(0)
    setUploadedFiles([])
    setChunkSize(512)
    setDelimiter('')
    setDelimiterError('')
  }

  // 关闭添加文档对话框
  const handleCloseUploadDialog = () => {
    setUploadDialogVisible(false)
    setUploadStep(0)
    setUploadedFiles([])
  }

  // 退出添加文档模式（处理完成后）
  const exitUploadMode = () => {
    setUploadDialogVisible(false)
    setUploadStep(0)
    setUploadedFiles([])
    getDocuments()
  }

  // 读取单个本地文件路径（桌面端不复制文件内容）
  const uploadSingleFile = async (file: File) => {
    const item: UploadFileItem = {
      uid: ((file as any).uid || Date.now() + Math.random()).toString(),
      name: file.name,
      size: file.size || 0,
      progress: 1,
      success: false,
      failed: false,
      error: '',
      source: file,
      relative_path: '',
      timer: null,
    }

    const uid = item.uid
    setUploadedFiles((prev) => [...prev, item])

    const form = new FormData()
    form.append('data_source_id', dataSourceId)
    form.append('files', file)

    // 模拟进度
    const timer = setInterval(() => {
      setUploadedFiles((prev) =>
        prev.map((f) => {
          if (f.uid !== uid) return f
          if (f.success || f.failed) return f
          if (f.progress < 90) {
            return { ...f, progress: Math.min(90, f.progress + Math.max(1, Math.round(Math.random() * 5))) }
          }
          return f
        })
      )
    }, 200)

    setUploadedFiles((prev) => prev.map((f) => (f.uid === uid ? { ...f, timer } : f)))

    try {
      const res: any = await uploadDocumentsReq(projectId, form)
      if (res.success && res.data) {
        clearInterval(timer)

        // 保存本地文件路径；这里没有把文件复制到项目目录。
        const selectedFilePaths = res.data.uploaded_files || []
        const relativePath = selectedFilePaths.length > 0 ? selectedFilePaths[0] : file.name

        setUploadedFiles((prev) =>
          prev.map((f) =>
            f.uid === uid
              ? { ...f, progress: 100, success: true, failed: false, error: '', relative_path: relativePath }
              : f
          )
        )

      } else {
        const errMessage = res.message || t('unstructuredData.uploadFailed')
        clearInterval(timer)
        setUploadedFiles((prev) =>
          prev.map((f) => (f.uid === uid ? { ...f, failed: true, error: errMessage, progress: 0 } : f))
        )
      }
    } catch (e: any) {
      clearInterval(timer)
      setUploadedFiles((prev) =>
        prev.map((f) =>
          f.uid === uid
            ? { ...f, failed: true, error: e?.message || t('unstructuredData.uploadFailed'), progress: 0 }
            : f
        )
      )
    }
  }

  // Dropzone 接收文件（支持多文件）
  const handleDrop = (files: File[]) => {
    files.forEach((file) => {
      uploadSingleFile(file)
    })
  }

  const handleReject = () => {
    notifications.show({
      color: 'red',
      message: t('unstructuredData.unsupportedFileType', { formats: acceptedExtensions.join(', ') })
    })
  }

  const addLocalFilePaths = (filePaths: string[]) => {
    const acceptedPaths = filePaths.filter(isAcceptedLocalPath)
    if (acceptedPaths.length !== filePaths.length) {
      handleReject()
    }
    if (acceptedPaths.length === 0) return

    setUploadedFiles((prev) => {
      const existing = new Set(prev.map((item) => item.relative_path).filter(Boolean))
      const nextItems = acceptedPaths
        .filter((filePath) => !existing.has(filePath))
        .map((filePath) => {
          const name = getFileNameFromPath(filePath)
          return {
            uid: `${Date.now()}-${Math.random()}`,
            name,
            size: 0,
            progress: 100,
            success: true,
            failed: false,
            error: '',
            source: new File([], name),
            relative_path: filePath,
            timer: null,
          }
        })
      return [...prev, ...nextItems]
    })
  }

  const handlePickLocalFiles = async () => {
    const pickPaths = (window as any).electronAPI?.pickPaths
    if (typeof pickPaths !== 'function') return
    try {
      const picked = await pickPaths(null)
      if (!Array.isArray(picked) || picked.length === 0) return
      const filePaths = picked.filter((item: any) => item && !item.isDir && typeof item.path === 'string').map((item: any) => item.path)
      if (filePaths.length !== picked.length) {
        handleReject()
      }
      addLocalFilePaths(filePaths)
    } catch {
      notifications.show({ color: 'red', message: t('unstructuredData.uploadFailed') })
    }
  }

  const handleDropzoneClick = (event: any) => {
    if (!hasNativePathPicker) return
    event.preventDefault()
    void handlePickLocalFiles()
  }

  // 重试读取本地文件路径
  const retryFileUpload = async (idx: number) => {
    const uf = uploadedFiles[idx]
    if (!uf || !uf.source) return
    const uid = uf.uid

    // 重置状态
    setUploadedFiles((prev) =>
      prev.map((f) => (f.uid === uid ? { ...f, failed: false, error: '', success: false, progress: 1 } : f))
    )

    const form = new FormData()
    form.append('data_source_id', dataSourceId)
    form.append('files', uf.source)

    const timer = setInterval(() => {
      setUploadedFiles((prev) =>
        prev.map((f) => {
          if (f.uid !== uid) return f
          if (f.success || f.failed) return f
          if (f.progress < 90) {
            return { ...f, progress: Math.min(90, f.progress + Math.max(1, Math.round(Math.random() * 5))) }
          }
          return f
        })
      )
    }, 200)

    setUploadedFiles((prev) => prev.map((f) => (f.uid === uid ? { ...f, timer } : f)))

    try {
      const res: any = await uploadDocumentsReq(projectId, form)
      if (res.success && res.data) {
        clearInterval(timer)

        // 保存本地文件路径；这里没有把文件复制到项目目录。
        const selectedFilePaths = res.data.uploaded_files || []
        const relativePath = selectedFilePaths.length > 0 ? selectedFilePaths[0] : uf.name

        setUploadedFiles((prev) =>
          prev.map((f) =>
            f.uid === uid
              ? { ...f, progress: 100, success: true, failed: false, error: '', relative_path: relativePath }
              : f
          )
        )
      } else {
        clearInterval(timer)
        setUploadedFiles((prev) =>
          prev.map((f) =>
            f.uid === uid
              ? { ...f, failed: true, error: res.message || t('unstructuredData.uploadFailed'), progress: 0 }
              : f
          )
        )
      }
    } catch (e: any) {
      clearInterval(timer)
      setUploadedFiles((prev) =>
        prev.map((f) =>
          f.uid === uid
            ? { ...f, failed: true, error: e?.message || t('unstructuredData.uploadFailed'), progress: 0 }
            : f
        )
      )
    }
  }

  // 删除文件
  const removeUploadedFile = (idx: number) => {
    setUploadedFiles((prev) => prev.filter((_, i) => i !== idx))
  }

  // 清空所有文件
  const clearUploadedFiles = () => {
    setUploadedFiles([])
  }

  // 提交处理
  const handleSubmitUpload = async () => {
    // 验证分隔符
    if (delimiterError) {
      notifications.show({ color: 'yellow', message: delimiterError })
      return
    }

    const uploadedFileList = uploadedFiles.filter((f) => f.success && f.relative_path)
    const filePaths = uploadedFileList.map((f) => f.relative_path)

    if (filePaths.length === 0) {
      notifications.show({ color: 'yellow', message: t('unstructuredData.noProcessableFiles') })
      return
    }

    setSubmitting(true)
    try {
      // 1. 创建Document记录
      const createFormData = new FormData()
      createFormData.append('data_source_id', dataSourceId)
      createFormData.append('file_paths', JSON.stringify(filePaths))

      const createRes: any = await createDocumentsReq(projectId, createFormData)
      if (!createRes.success) {
        notifications.show({ color: 'red', message: createRes.message || t('unstructuredData.createDocumentFailed') })
        return
      }

      // 2. 提取document_ids
      const documentIds =
        createRes.data?.created_documents?.map((doc: any) => doc.document_id)?.filter((id: any) => id != null) || []

      if (documentIds.length === 0) {
        notifications.show({ color: 'red', message: t('unstructuredData.noDocumentCreated') })
        return
      }

      // 3. 处理文档（向量化）
      const processFormData = new FormData()
      processFormData.append('data_source_id', dataSourceId)
      processFormData.append('document_ids', JSON.stringify(documentIds))
      processFormData.append('chunk_size', String(chunkSize))
      if (delimiter) {
        processFormData.append('delimiter', delimiter)
      }
      processFormData.append('split_strategy', splitStrategy)
      if (splitStrategy === 'smart') {
        processFormData.append('breakpoint_threshold_type', breakpointThresholdType)
      }

      const processRes: any = await processDocumentsReq(projectId, processFormData)
      if (processRes.success) {
        notifications.show({ color: 'green', message: t('unstructuredData.addedToQueue') })
        exitUploadMode()
      } else {
        notifications.show({ color: 'red', message: processRes.message || t('unstructuredData.addToQueueFailed') })
      }
    } catch (error: any) {
      notifications.show({ color: 'red', message: error.message || t('unstructuredData.processFailed') })
    } finally {
      setSubmitting(false)
    }
  }

  // ============ 查看分块逻辑 ============

  // 显示分块
  const showChunks = (row: any) => {
    if (!row.id) {
      notifications.show({ color: 'yellow', message: t('unstructuredData.documentNotProcessed') })
      return
    }

    if (row.chunk_count === 0) {
      notifications.show({ color: 'yellow', message: t('unstructuredData.noChunkInfo') })
      return
    }

    setChunksDialogVisible(true)
    setChunksDialogDoc(row)
    setChunkTextMode('clean')
    setChunksCurrentPage(1)
    setChunksPageSize(20)
    currentChunksDocumentId.current = row.id

    loadChunksData(1, 20)
  }

  const closeChunksDialog = () => {
    setChunksDialogVisible(false)
    setChunksDialogDoc(null)
    setCurrentChunks([])
    currentChunksDocumentId.current = null
  }

  // 加载分块数据
  const loadChunksData = async (page = chunksCurrentPage, size = chunksPageSize) => {
    if (!currentChunksDocumentId.current) return

    setChunksLoading(true)
    setCurrentChunks([])

    try {
      const res: any = await getDocumentChunksReq(projectId, dataSourceId, currentChunksDocumentId.current, page, size)
      if (res.success && res.data) {
        const chunks = res.data.chunks || []
        setCurrentChunks(chunks)
        setChunksTotal(res.data.total || 0)
        if (chunks.length === 0) {
          notifications.show({ color: 'blue', message: t('unstructuredData.noChunkInfo') })
        }
      } else {
        notifications.show({ color: 'red', message: res.message || t('unstructuredData.getChunksFailed') })
      }
    } catch (error) {
      console.error('获取分块信息失败:', error)
      notifications.show({ color: 'red', message: t('unstructuredData.getChunksFailed') })
    } finally {
      setChunksLoading(false)
    }
  }

  // 分块翻页
  const handleChunksPageChange = (page: number) => {
    setChunksCurrentPage(page)
    loadChunksData(page, chunksPageSize)
  }

  // 渲染状态列
  const renderStatus = (row: any) => {
    const effectiveStatus = row.status === 'completed' && row.embedding_status !== 'completed'
      ? row.embedding_status === 'partial' ? 'embedding_partial' : 'embedding_failed'
      : row.status
    const statusClassMap: Record<string, string> = {
      completed: styles.statusCompleted,
      failed: styles.statusFailed,
      embedding_partial: styles.statusFailed,
      embedding_failed: styles.statusFailed,
      cancelled: styles.statusCancelled,
      uploaded: styles.statusUploaded,
      pending: styles.statusProcessing,
      processing: styles.statusProcessing,
    }
    const statusText = getStatusText(effectiveStatus)
    const pill = (
      <span className={`${styles.statusPill} ${statusClassMap[effectiveStatus] || styles.statusProcessing}`}>
        {(effectiveStatus === 'failed' || effectiveStatus.startsWith('embedding_')) && <IconAlertTriangleFilled size={12} />}
        {statusText}
      </span>
    )
    const embeddingStatus = getEmbeddingStatus(row)

    if (effectiveStatus === 'completed') {
      return (
        <div className={styles.statusStack}>
          {pill}
          {embeddingStatus && (
            <Tooltip withArrow openDelay={300} label={embeddingStatus.tooltip}>
              <span className={`${styles.embeddingPill} ${embeddingStatus.className}`}>{embeddingStatus.text}</span>
            </Tooltip>
          )}
        </div>
      )
    }
    if (effectiveStatus === 'failed' || effectiveStatus.startsWith('embedding_')) {
      const errorMessage = row.error_msg || (effectiveStatus.startsWith('embedding_')
        ? '文档解析已完成，但向量尚未生成。请配置嵌入模型后重新处理。'
        : t('unstructuredData.unknownError'))
      return (
        <div className={styles.statusCell}>
          {pill}
          <Tooltip multiline w={320} withArrow openDelay={350} label={errorMessage} position="top-start">
            <span className={styles.statusErrorText}>{errorMessage}</span>
          </Tooltip>
        </div>
      )
    }
    if (row.status === 'cancelled') {
      return pill
    }
    if (row.status === 'uploaded') {
      return pill
    }
    return (
      <div className={styles.statusCell}>
        <Progress value={row.progress || 0} color="yiw" size={6} className={styles.statusProgress} />
        {pill}
      </div>
    )
  }

  return (
    <div className={styles.documentManagement}>
      {/* 列表模式 */}
      <div className={styles.listMode}>
        <div className={`${styles.contentCard} ${styles.documentCard}`} style={{ position: 'relative' }}>
          <div className={styles.operationsHeader}>
            <div className={styles.headerLeft}>
              <div className={styles.titleBlock}>
                <h3 className={styles.cardTitle}>
                  <span className={styles.cardTitleIcon} style={{ display: 'inline-flex' }}>
                    <IconFileText size={18} />
                  </span>
                  {t('unstructuredData.documentManagement')}
                </h3>
                <div className={styles.statsRow} aria-label={t('unstructuredData.documentStats')}>
                  <span>
                    {t('unstructuredData.totalDocuments')} <strong>{documentStats.total}</strong>
                  </span>
                  <span>
                    {t('unstructuredData.statusCompleted')} <strong>{documentStats.completed}</strong>
                  </span>
                  <span>
                    {t('unstructuredData.vectorizedDocuments')} <strong>{documentStats.vectorized}</strong>
                  </span>
                  <span>
                    {t('unstructuredData.statusProcessing')} <strong>{documentStats.processing}</strong>
                  </span>
                  <span>
                    {t('unstructuredData.statusFailed')} <strong>{documentStats.failed}</strong>
                  </span>
                  <span>
                    {t('unstructuredData.selectedDocuments')} <strong>{documentStats.selected}</strong>
                  </span>
                </div>
              </div>
              <div className={styles.selectionActions}>
                <Button
                  size="xs"
                  variant="default"
                  loading={generatingDescriptions}
                  disabled={selectedDocumentIds.length === 0}
                  leftSection={<IconSparkles size={14} />}
                  onClick={handleGenerateDescriptions}
                >
                  {generatingDescriptions
                    ? t('unstructuredData.generating')
                    : t('unstructuredData.aiGenerateDescription')}
                </Button>
                <Button
                  size="xs"
                  color="red"
                  variant="outline"
                  disabled={selectedDocumentIds.length === 0}
                  onClick={batchDeleteAll}
                >
                  {t('unstructuredData.batchDelete', { count: selectedDocumentIds.length })}
                </Button>
                {selectedUploadedPaths.length > 0 && (
                  <Button size="xs" variant="outline" onClick={batchProcessUploaded}>
                    {t('unstructuredData.batchProcessUnprocessed', { count: selectedUploadedPaths.length })}
                  </Button>
                )}
              </div>
            </div>
            <div className={styles.headerActions}>
              <Button leftSection={<IconFilePlus size={16} />} onClick={enterUploadMode}>
                {t('unstructuredData.uploadDocument')}
              </Button>
            </div>
          </div>

          <div className={styles.tableWrapper}>
            <div className={styles.tableScroll}>
              <Table className={styles.documentTable} verticalSpacing="sm" highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th style={{ width: 48 }}>
                      <Checkbox
                        aria-label="select-all"
                        checked={allSelected}
                        indeterminate={someSelected}
                        onChange={toggleSelectAll}
                      />
                    </Table.Th>
                    <Table.Th style={{ minWidth: 280 }}>{t('unstructuredData.fileName')}</Table.Th>
                    <Table.Th style={{ width: 96 }}>{t('unstructuredData.size')}</Table.Th>
                    <Table.Th style={{ width: 132 }}>{t('unstructuredData.time')}</Table.Th>
                    <Table.Th style={{ minWidth: 220 }}>{t('unstructuredData.description')}</Table.Th>
                    <Table.Th style={{ width: 126 }}>{t('unstructuredData.chunks')}</Table.Th>
                    <Table.Th style={{ width: 230 }}>{t('unstructuredData.status')}</Table.Th>
                    <Table.Th style={{ width: 120 }}>{t('unstructuredData.actions')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {documentList.map((row) => (
                    <Table.Tr key={rowKey(row)}>
                      <Table.Td>
                        <Checkbox
                          aria-label="select-row"
                          checked={selectedRowKeys.has(rowKey(row))}
                          onChange={() => toggleSelectRow(row)}
                        />
                      </Table.Td>
                      <Table.Td>
                        <Tooltip label={row.file_name} disabled={!row.file_name} withArrow>
                          <span className={styles.fileCell}>
                            <span className={styles.fileIcon}>
                              <IconFileText size={15} />
                            </span>
                            <span className={styles.fileTitle}>{row.file_name || '-'}</span>
                          </span>
                        </Tooltip>
                      </Table.Td>
                      <Table.Td className={styles.mutedCell}>{formatFileSize(row.size)}</Table.Td>
                      <Table.Td className={styles.mutedCell}>{formatUploadTime(row.created_at)}</Table.Td>
                      <Table.Td>
                        <div className={styles.descriptionCell}>
                          {row.description ? (
                            <Tooltip label={row.description} disabled={!row.description} multiline w={320} withArrow>
                              <span className={styles.descriptionText}>{row.description}</span>
                            </Tooltip>
                          ) : (
                            <span className={styles.emptyMark}>-</span>
                          )}
                          {row.status === 'completed' && (
                            <Button
                              size="xs"
                              variant="subtle"
                              className={styles.inlineIconBtn}
                              p={0}
                              onClick={() => openDescriptionDialog(row)}
                            >
                              <IconEdit size={14} />
                            </Button>
                          )}
                        </div>
                      </Table.Td>
                      <Table.Td>
                        {row.chunk_count > 0 ? (
                          <div className={styles.chunkCell}>
                            <span className={styles.chunkCount}>
                              {row.chunk_count} {t('unstructuredData.chunkUnit')}
                            </span>
                            <Button
                              size="xs"
                              variant="subtle"
                              className={styles.inlineIconBtn}
                              p={0}
                              onClick={() => showChunks(row)}
                            >
                              <IconEye size={14} />
                            </Button>
                          </div>
                        ) : (
                          <span className={styles.emptyMark}>-</span>
                        )}
                      </Table.Td>
                      <Table.Td>{renderStatus(row)}</Table.Td>
                      <Table.Td>
                        <div className={styles.rowActions}>
                          {row.id && (
                            <Tooltip label={t('unstructuredData.openDocumentLocation')} position="top" withArrow={false}>
                              <Button
                                variant="subtle"
                                size="xs"
                                className={styles.actionBtn}
                                loading={openingDocumentIds.has(row.id)}
                                disabled={openingDocumentIds.has(row.id)}
                                p={0}
                                onClick={() => openDocumentLocation(row)}
                              >
                                <IconFolderOpen size={16} className={styles.actionIcon} />
                              </Button>
                            </Tooltip>
                          )}
                          {row.id && (
                            <Tooltip label={t('unstructuredData.reprocessDocument')} position="top" withArrow={false}>
                              <Button
                                variant="subtle"
                                size="xs"
                                className={styles.actionBtn}
                                p={0}
                                onClick={() => reprocessDocument(row)}
                              >
                                <IconRefresh size={16} className={styles.actionIcon} />
                              </Button>
                            </Tooltip>
                          )}
                          {row.id && (
                            <Tooltip label={t('unstructuredData.deleteDocument')} position="top" withArrow={false}>
                              <Button
                                variant="subtle"
                                size="xs"
                                className={`${styles.actionBtn} ${styles.deleteBtn}`}
                                p={0}
                                onClick={() => deleteDocument(row)}
                              >
                                <IconTrash size={16} className={styles.actionIcon} />
                              </Button>
                            </Tooltip>
                          )}
                        </div>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
            {/* 分页 */}
            <div className={styles.pageFooter}>
              <Pagination
                value={currentPage}
                total={Math.max(1, Math.ceil(totalCount / pageSize))}
                onChange={setCurrentPage}
                size={isMobile ? 'sm' : 'md'}
              />
            </div>
          </div>
        </div>
      </div>

      {/* 文档描述编辑 Dialog */}
      <Modal
        opened={descDialogVisible}
        onClose={() => setDescDialogVisible(false)}
        title={descDialogDoc?.file_name || t('unstructuredData.description')}
        size="1200px"
        closeOnClickOutside={false}
      >
        <Textarea
          value={descDialogText}
          onChange={(e) => setDescDialogText(e.currentTarget.value)}
          autosize
          minRows={8}
          maxRows={20}
          placeholder={t('unstructuredData.descriptionPlaceholder')}
        />
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            width: '100%',
            marginTop: 16,
          }}
        >
          <Button
            className={styles.aiGenerateBtn}
            variant="light"
            loading={descGenerating}
            leftSection={<IconSparkles size={16} />}
            onClick={handleGenerateSingleDesc}
          >
            {descGenerating ? t('unstructuredData.aiGenerating') : t('unstructuredData.aiGenerate')}
          </Button>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="default" onClick={() => setDescDialogVisible(false)}>
              {t('common.cancel') || '取消'}
            </Button>
            <Button loading={descSaving} onClick={saveDescriptionFromDialog}>
              {t('common.save') || '保存'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* 添加本地文档 Dialog */}
      <Modal
        opened={uploadDialogVisible}
        onClose={handleCloseUploadDialog}
        title={
          <div className={styles.localDocTitle}>
            <span className={styles.localDocTitleIcon}>
              <IconFilePlus size={18} />
            </span>
            <div>
              <strong>{t('unstructuredData.uploadDocument')}</strong>
              <small>{t('unstructuredData.localDocumentModalSubtitle')}</small>
            </div>
          </div>
        }
        size="min(1120px, 94vw)"
        closeOnClickOutside={false}
        centered
        classNames={{
          content: styles.localDocModalContent,
          header: styles.localDocModalHeader,
          title: styles.localDocModalTitle,
          body: styles.localDocModalBody,
          close: styles.localDocModalClose,
        }}
      >
        <div className={styles.localDocNotice}>
          <IconInfoCircle size={18} />
          <div>
            <strong>{t('unstructuredData.localDocumentSourceNoteTitle')}</strong>
            <span>{t('unstructuredData.localDocumentSourceNote')}</span>
          </div>
        </div>

        <Stepper active={uploadStep} onStepClick={setUploadStep} className={styles.steps} allowNextStepsSelect={false}>
          <Stepper.Step label={t('unstructuredData.stepSelectFiles')} />
          <Stepper.Step label={t('unstructuredData.stepConfigParams')} />
        </Stepper>

        {uploadStep === 0 && (
          <div className={styles.uploadSection}>
            <div className={styles.selectLayout}>
              <Dropzone
                className={styles.uploadDrop}
                multiple
                maxFiles={50}
                activateOnClick={!hasNativePathPicker}
                accept={acceptedFileTypes}
                validator={validateAcceptedFileType}
                onDrop={handleDrop}
                onReject={handleReject}
                onClick={handleDropzoneClick}
              >
                <span className={styles.uploadIcon} style={{ display: 'inline-flex' }}>
                  <IconFilePlus size={42} />
                </span>
                <div className={styles.uploadText}>{t('unstructuredData.uploadDragText')}</div>
                <div className={styles.uploadTip}>
                  <div>{t('unstructuredData.uploadMultipleHint')}</div>
                  <div>{t('unstructuredData.uploadFormatHint')}</div>
                </div>
              </Dropzone>

              <div className={styles.fileList}>
                <div className={styles.listHeader}>
                  <span>
                    {t('unstructuredData.uploadedCount', {
                      success: successUploadCount,
                      total: uploadedFiles.length,
                    })}
                  </span>
                  {uploadedFiles.length > 0 && (
                    <Button color="red" variant="subtle" size="compact-sm" onClick={clearUploadedFiles}>
                      {t('unstructuredData.clear')}
                    </Button>
                  )}
                </div>
                <div className={styles.fileListScroll}>
                  {uploadedFiles.length === 0 ? (
                    <div className={styles.filesEmpty}>
                      <IconFileText size={38} />
                      <span>{t('unstructuredData.noUploadedFiles')}</span>
                    </div>
                  ) : (
                    uploadedFiles.map((file, idx) => (
                      <div key={file.uid} className={styles.fileItem}>
                        <span className={styles.fileItemIcon}>
                          <IconFileText size={16} />
                        </span>
                        <span className={styles.fileName} title={file.name}>
                          {file.name}
                        </span>
                        <Progress
                          value={file.progress}
                          color={file.success ? 'teal' : file.failed ? 'red' : 'yiw'}
                          className={styles.fileProgress}
                        />
                        <span className={styles.fileSize}>{formatFileSize(file.size)}</span>
                        <span
                          className={`${styles.fileStatus} ${
                            file.failed ? styles.fileStatusFailed : file.success ? styles.fileStatusReady : ''
                          }`}
                        >
                          {file.failed
                            ? t('unstructuredData.statusFailed')
                            : file.success
                              ? t('unstructuredData.uploaded')
                              : t('unstructuredData.statusProcessing')}
                        </span>
                        {file.failed && (
                          <Button variant="subtle" size="compact-sm" onClick={() => retryFileUpload(idx)}>
                            {t('unstructuredData.retry')}
                          </Button>
                        )}
                        <Button color="red" variant="subtle" size="compact-sm" onClick={() => removeUploadedFile(idx)}>
                          {t('unstructuredData.delete')}
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {uploadStep === 1 && (
          <div className={styles.configSection}>
            <div className={styles.configHeader}>
              <div>
                <strong>{t('unstructuredData.dataProcessConfig')}</strong>
                <span>{t('unstructuredData.localDocumentProcessHint')}</span>
              </div>
              <span className={styles.configFileSummary}>
                {t('unstructuredData.uploadedCount', {
                  success: successUploadCount,
                  total: uploadedFiles.length,
                })}
              </span>
            </div>

            <div className={styles.configGrid}>
              <div className={styles.configColumn}>
                <div className={styles.configCard}>
                  <div className={styles.configCardHeader}>
                    <IconSparkles size={18} />
                    <span>{t('unstructuredData.splitStrategy')}</span>
                  </div>
                  <div className={styles.strategyCards}>
                    {strategyOptions.map((s) => (
                      <button
                        key={s.value}
                        type="button"
                        className={`${styles.strategyCard} ${splitStrategy === s.value ? styles.active : ''}`}
                        onClick={() => setSplitStrategy(s.value)}
                      >
                        <span className={styles.strategyCardInner}>
                          <span className={styles.strategyIcon}>
                            {s.value === 'smart' ? <IconSparkles size={19} /> : <IconFileText size={19} />}
                          </span>
                          <span className={styles.strategyText}>
                            <span className={styles.strategyName}>{s.label}</span>
                            <span className={styles.strategyDesc}>{s.desc}</span>
                          </span>
                        </span>
                        <span className={styles.strategyCheck}>
                          {splitStrategy === s.value && <IconCheck size={15} />}
                        </span>
                      </button>
                    ))}
                  </div>

                  {splitStrategy === 'smart' && (
                    <div className={styles.thresholdSection}>
                      <div className={styles.thresholdLabel}>{t('unstructuredData.breakpointThreshold')}</div>
                      <div className={styles.thresholdTags}>
                        {thresholdOptions.map((th) => (
                          <button
                            key={th.value}
                            type="button"
                            className={`${styles.thresholdTag} ${
                              breakpointThresholdType === th.value ? styles.active : ''
                            }`}
                            onClick={() => setBreakpointThresholdType(th.value)}
                          >
                            {th.label}
                          </button>
                        ))}
                      </div>
                      <div className={styles.thresholdTip}>{t('unstructuredData.breakpointThresholdTip')}</div>
                    </div>
                  )}
                </div>

                <div className={styles.configCard}>
                  <div className={styles.configCardHeader}>
                    <IconInfoCircle size={18} />
                    <span>{t('unstructuredData.chunkLength')}</span>
                  </div>
                  <div className={styles.paramRow}>
                    <div className={styles.paramItem}>
                      <div className={styles.paramLabel}>{t('unstructuredData.chunkLength')}</div>
                      <NumberInput value={chunkSize} onChange={setChunkSize} min={64} max={4096} step={64} w="100%" />
                      <div className={styles.paramTip}>{t('unstructuredData.chunkLengthTip')}</div>
                    </div>
                    <div className={styles.paramItem}>
                      <div className={styles.paramLabel}>{t('unstructuredData.delimiter')}</div>
                      <TextInput
                        value={delimiter}
                        onChange={(e) => setDelimiter(e.currentTarget.value)}
                        placeholder={t('unstructuredData.delimiterPlaceholder')}
                        w="100%"
                      />
                      <div className={styles.paramTip}>{t('unstructuredData.delimiterTip')}</div>
                      {delimiterError && <div className={styles.paramError}>{delimiterError}</div>}
                    </div>
                  </div>
                </div>
              </div>

              <div className={`${styles.configColumn} ${styles.filesColumn}`}>
                <div className={`${styles.configCard} ${styles.filesCard}`}>
                  <div className={styles.configCardHeader}>
                    <IconFileText size={18} />
                    <span>{t('unstructuredData.fileList')}</span>
                    <span className={styles.fileCountBadge}>{successUploadCount}</span>
                  </div>
                  <div className={styles.filesScroll}>
                    {uploadedFiles
                      .filter((f) => f.success)
                      .map((file) => (
                        <div key={file.uid} className={styles.fileChip}>
                          <IconFileText size={15} className={styles.fileChipIcon} />
                          <span className={styles.fileChipName} title={file.name}>
                            {file.name}
                          </span>
                          <button
                            type="button"
                            className={styles.fileChipClose}
                            aria-label={t('unstructuredData.delete')}
                            title={t('unstructuredData.delete')}
                            onClick={() => removeUploadedFile(uploadedFiles.indexOf(file))}
                          >
                            <IconTrash size={13} />
                          </button>
                        </div>
                      ))}
                    {successUploadCount === 0 && (
                      <div className={styles.filesEmpty}>
                        <IconFileText size={38} />
                        <span>{t('unstructuredData.noUploadedFiles')}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className={styles.dialogFooter}>
          <Button variant="default" onClick={handleCloseUploadDialog}>
            {t('unstructuredData.cancel')}
          </Button>
          <div className={styles.footerActions}>
            {uploadStep > 0 && (
              <Button variant="default" onClick={() => setUploadStep((s) => s - 1)}>
                {t('unstructuredData.previousStep')}
              </Button>
            )}
            {uploadStep === 0 && (
              <Button disabled={successUploadCount === 0} onClick={() => setUploadStep((s) => s + 1)}>
                {t('unstructuredData.nextStep')}
              </Button>
            )}
            {uploadStep === 1 && (
              <Button loading={submitting} disabled={successUploadCount === 0} onClick={handleSubmitUpload}>
                {t('unstructuredData.startProcessing')}
              </Button>
            )}
          </div>
        </div>
      </Modal>

      {/* 查看分块 Dialog */}
      <Modal
        opened={chunksDialogVisible}
        onClose={closeChunksDialog}
        title={
          <div className={styles.chunkDialogTitle}>
            <span className={styles.chunkDialogTitleIcon}>
              <IconFileText size={18} />
            </span>
            <div className={styles.chunkDialogTitleText}>
              <span>{t('unstructuredData.chunkDetails')}</span>
              <small>{chunksDialogDoc?.file_name || chunksDialogDoc?.title || '-'}</small>
            </div>
          </div>
        }
        size="min(1120px, calc(100vw - 32px))"
        centered
        classNames={{
          content: styles.chunkModalContent,
          header: styles.chunkModalHeader,
          title: styles.chunkModalTitle,
          body: styles.chunkModalBody,
          close: styles.chunkModalClose,
        }}
      >
        <div className={styles.chunkDialogToolbar}>
          <div className={styles.chunkDialogStats}>
            <span>
              {t('unstructuredData.totalChunks')} <strong>{chunkDialogStats.total}</strong>
            </span>
            <span>
              {t('unstructuredData.currentPageChunks')} <strong>{chunkDialogStats.current}</strong>
            </span>
            <span>
              {t('unstructuredData.vectorizedChunks')} <strong>{chunkDialogStats.vectorized}</strong>
            </span>
            <span>
              {t('unstructuredData.pageIndicator', {
                page: chunkDialogStats.page,
                total: chunkDialogStats.pageTotal,
              })}
            </span>
          </div>
          <SegmentedControl
            size="xs"
            value={chunkTextMode}
            onChange={(value) => setChunkTextMode(value as 'clean' | 'raw')}
            data={[
              { value: 'clean', label: t('unstructuredData.cleanedText') },
              { value: 'raw', label: t('unstructuredData.rawText') },
            ]}
            className={styles.chunkModeControl}
          />
        </div>

        <div className={styles.chunkDialogContent}>
          {chunksLoading ? (
            <Center className={styles.chunkEmpty}>
              <Text c="dimmed">{t('unstructuredData.loadingChunks')}</Text>
            </Center>
          ) : currentChunks.length > 0 ? (
            <Accordion className={styles.chunksCollapse} variant="separated">
              {currentChunks.map((chunk, index) => {
                const rawText = getChunkText(chunk)
                const displayText = chunkTextMode === 'clean' ? formatChunkTextForDisplay(rawText) : String(rawText || '')
                const chunkIndex = Number(chunk?.content_info?.content_index ?? index) + 1
                const tokenCount = chunk?.content_info?.token_count || 0

                return (
                  <Accordion.Item key={chunk.id || index} value={String(chunk.id || index)}>
                    <Accordion.Control className={styles.chunkAccordionControl}>
                      <div className={styles.chunkAccordionTitle}>
                        <div className={styles.chunkMetaLine}>
                          <span className={styles.chunkIndexBadge}>
                            {t('unstructuredData.chunk')} {chunkIndex}
                          </span>
                          {tokenCount > 0 && (
                            <span className={styles.chunkTokenBadge}>
                              {tokenCount} {t('unstructuredData.tokenUnit')}
                            </span>
                          )}
                          {chunk.is_embedding && (
                            <span className={styles.chunkVectorBadge}>{t('unstructuredData.vectorized')}</span>
                          )}
                        </div>
                        <span className={styles.chunkPreview}>{formatChunkPreview(chunk)}</span>
                      </div>
                    </Accordion.Control>
                    <Accordion.Panel>
                      <div className={styles.chunkContent}>
                        <pre className={styles.chunkText}>{displayText}</pre>
                      </div>
                    </Accordion.Panel>
                  </Accordion.Item>
                )
              })}
            </Accordion>
          ) : (
            <Center className={styles.chunkEmpty}>
              <Text c="dimmed">{t('unstructuredData.noChunkInfo')}</Text>
            </Center>
          )}
        </div>

        <div className={styles.chunkDialogFooter}>
          {chunksTotal > chunksPageSize && (
            <Pagination
              value={chunksCurrentPage}
              total={Math.max(1, Math.ceil(chunksTotal / chunksPageSize))}
              onChange={handleChunksPageChange}
            />
          )}
        </div>
      </Modal>
    </div>
  )
}
