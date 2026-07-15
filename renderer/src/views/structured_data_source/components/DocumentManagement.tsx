import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Tooltip,
  Progress,
  Table,
  Checkbox,
  Pagination,
  Select,
  Modal,
  LoadingOverlay
} from '@mantine/core'
import { Dropzone } from '@mantine/dropzone'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import {
  IconFileSpreadsheet,
  IconFilePlus,
  IconFileText,
  IconFolderOpen,
  IconInfoCircle,
  IconRefresh,
  IconTrash,
} from '@tabler/icons-react'
import {
  listDocumentsReq,
  deleteDocumentReq,
  processDocumentsReq,
  deleteDocumentsBatchReq,
  createDocumentsReq,
  uploadDocumentsReq
} from '@/api/structured_data_source/document'
import { useProjectStore, projectGetters } from '@/store/project'
import { useResponsive } from '@/hooks/use-responsive'
import styles from './DocumentManagement.module.scss'

export interface DocumentManagementProps {
  dataSourceId: string
  /** defineEmits('documents-processed') */
  onDocumentsProcessed?: () => void
}

// 本地文件状态项类型（用于显示进度、失败重试）
interface UploadedItem {
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

const acceptedExtensions = ['.csv', '.xlsx', '.xls', '.json', '.jsonl']
const acceptedFileTypes = {
  'text/csv': ['.csv'],
  'application/csv': ['.csv'],
  'application/vnd.ms-excel': ['.csv', '.xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/json': ['.json', '.jsonl'],
  'application/x-ndjson': ['.jsonl']
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

const getFileNameFromPath = (filePath: any) => {
  if (!filePath || typeof filePath !== 'string') return ''
  return filePath.split(/[\\/]/).filter(Boolean).pop() || filePath
}

const getDocumentName = (row: any) => row?.file_name || row?.title || row?.name || getFileNameFromPath(row?.file_path || row?.relative_path) || '-'

const getDocumentPath = (row: any) => row?.file_path || row?.relative_path || ''

export default function DocumentManagement({ dataSourceId, onDocumentsProcessed }: DocumentManagementProps) {
  const { t } = useTranslation()
  const projectId = useProjectStore((s) => projectGetters.currentProjectId(s))
  const { isMobile } = useResponsive()

  // 列表模式状态
  const [loading, setLoading] = useState(false)
  const [documentList, setDocumentList] = useState<any[]>([])
  const [openingDocumentIds, setOpeningDocumentIds] = useState<Set<any>>(new Set())
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [totalCount, setTotalCount] = useState(0)
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<any[]>([])
  const [selectedUploadedPaths, setSelectedUploadedPaths] = useState<any[]>([])
  // 选中的行 key 集合（对齐 el-table 的 selection）
  const [selectedRowKeys, setSelectedRowKeys] = useState<Set<any>>(new Set())

  // 添加本地文件状态
  const [uploadDialogVisible, setUploadDialogVisible] = useState(false)
  const [uploadedFiles, setUploadedFiles] = useState<UploadedItem[]>([])
  const [submitting, setSubmitting] = useState(false)

  // 轮询定时器 + 列表快照（对齐 Vue ref，避免闭包读到旧值）
  const pollingTimerRef = useRef<any>(null)
  const documentStatusSnapshotRef = useRef<Map<any, any>>(new Map())
  const isDocumentListInitializedRef = useRef(false)

  // 镜像最新依赖，供异步回调/定时器读取（对齐 Vue ref.value 语义）
  const dataSourceIdRef = useRef(dataSourceId)
  const projectIdRef = useRef(projectId)
  dataSourceIdRef.current = dataSourceId
  projectIdRef.current = projectId

  const successUploadCount = useMemo(() => uploadedFiles.filter((f) => f.success).length, [uploadedFiles])
  const hasNativePathPicker = typeof (window as any).electronAPI?.pickPaths === 'function'
  const documentStats = useMemo(() => {
    const processing = documentList.filter((item) => item.status === 'processing' || item.status === 'pending').length
    const completed = documentList.filter((item) => item.status === 'completed').length
    const failed = documentList.filter((item) => item.status === 'failed' || item.status === 'cancelled').length
    return {
      total: totalCount || documentList.length,
      completed,
      processing,
      failed,
      selected: selectedDocumentIds.length + selectedUploadedPaths.length
    }
  }, [documentList, selectedDocumentIds.length, selectedUploadedPaths.length, totalCount])

  // 生成表格行唯一 key，避免重复 key 导致行数显示异常
  const rowKey = (row: any) => row._rowKey || row.id || row.file_path || row.relative_path || getDocumentName(row)

  // 统一整理列表数据，补充 _rowKey
  const normalizeDocumentList = (items: any) => {
    if (!Array.isArray(items)) return []
    return items.map((item, index) => ({
      ...item,
      _rowKey:
        item.id || item.document_id || `${item.file_path || item.relative_path || getDocumentName(item) || 'row'}-${index}`
    }))
  }

  // ============ 列表模式逻辑 ============

  // 停止轮询
  const stopPolling = useCallback(() => {
    if (pollingTimerRef.current) {
      clearInterval(pollingTimerRef.current)
      pollingTimerRef.current = null
    }
  }, [])

  // 获取文档列表
  const getDocuments = useCallback(async () => {
    if (!dataSourceIdRef.current || !projectIdRef.current) return

    setLoading(true)
    try {
      const res: any = await listDocumentsReq(projectIdRef.current, dataSourceIdRef.current, currentPage, pageSize)
      setTotalCount(res?.data?.total || 0)
      // 确保 documentList 始终是数组
      const items = res?.data?.items
      const newList = normalizeDocumentList(items)

      let hasNewlyCompleted = false
      if (isDocumentListInitializedRef.current) {
        for (const doc of newList) {
          const key = doc.id || doc._rowKey
          const prevStatus = documentStatusSnapshotRef.current.get(key)
          if (doc.status === 'completed' && prevStatus && prevStatus !== 'completed') {
            hasNewlyCompleted = true
            break
          }
        }
      }

      documentStatusSnapshotRef.current = new Map(newList.map((doc) => [doc.id || doc._rowKey, doc.status]))
      isDocumentListInitializedRef.current = true
      setDocumentList(newList)

      if (hasNewlyCompleted) {
        onDocumentsProcessed?.()
      }

      checkAndManagePolling(newList)
    } catch (error) {
      notifications.show({ color: 'red', message: t('structuredData.getDocumentListFailed') })
      // 出错时也确保 documentList 是空数组
      setDocumentList([])
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage, pageSize, onDocumentsProcessed, t])

  // 用 ref 镜像 getDocuments，供定时器/事件回调调用最新版本
  const getDocumentsRef = useRef(getDocuments)
  getDocumentsRef.current = getDocuments

  // 启动轮询
  const startPolling = useCallback(() => {
    if (pollingTimerRef.current) return
    pollingTimerRef.current = setInterval(() => {
      getDocumentsRef.current()
    }, 3000)
  }, [])

  // 检查是否有处理中的文档，管理轮询
  const checkAndManagePolling = useCallback(
    (list: any[]) => {
      const hasProcessing = list.some((item) => {
        return item.status === 'pending' || item.status === 'processing'
      })

      if (hasProcessing) {
        startPolling()
      } else {
        stopPolling()
      }
    },
    [startPolling, stopPolling]
  )

  // 监听数据源ID和projectId变化(对应 watch(immediate: true))
  useEffect(() => {
    if (dataSourceId && projectId) {
      getDocumentsRef.current()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataSourceId, projectId])

  // 分页/页码变化时重新获取列表（对应 @size-change / @current-change）
  const isFirstPageEffect = useRef(true)
  useEffect(() => {
    if (isFirstPageEffect.current) {
      isFirstPageEffect.current = false
      return
    }
    getDocumentsRef.current()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage, pageSize])

  // 组件卸载时停止轮询(对应 onBeforeUnmount)
  useEffect(() => {
    return () => {
      stopPolling()
    }
  }, [stopPolling])

  // 处理选择变化（基于选中的行 key 集合派生）
  const computeSelection = (rows: any[]) => {
    const ids: any[] = []
    const uploads: any[] = []

    rows.forEach((r) => {
      if (r.status === 'uploaded' && !r.id && r.file_path) {
        uploads.push(r.file_path)
      }
      if (r.id) {
        ids.push(r.id)
      }
    })

    setSelectedDocumentIds(ids)
    setSelectedUploadedPaths(uploads)
  }

  // 单行勾选切换
  const toggleRowSelection = (row: any, checked: boolean) => {
    const key = rowKey(row)
    const next = new Set(selectedRowKeys)
    if (checked) next.add(key)
    else next.delete(key)
    setSelectedRowKeys(next)
    computeSelection(documentList.filter((r) => next.has(rowKey(r))))
  }

  // 全选切换
  const allSelected = documentList.length > 0 && documentList.every((r) => selectedRowKeys.has(rowKey(r)))
  const someSelected = documentList.some((r) => selectedRowKeys.has(rowKey(r))) && !allSelected
  const toggleSelectAll = (checked: boolean) => {
    if (checked) {
      const next = new Set(documentList.map((r) => rowKey(r)))
      setSelectedRowKeys(next)
      computeSelection(documentList)
    } else {
      setSelectedRowKeys(new Set())
      computeSelection([])
    }
  }

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
        notifications.show({ color: 'red', message: t('structuredData.createDocumentFailed') })
        return
      }

      const createdDocs = createRes.data?.created_documents || []
      const documentIds = createdDocs.map((doc: any) => doc.document_id).filter((id: any) => id)

      if (documentIds.length === 0) {
        notifications.show({ color: 'yellow', message: t('structuredData.noDocumentsCreated') })
        return
      }

      // 提交处理任务
      const processFormData = new FormData()
      processFormData.append('data_source_id', dataSourceId)
      processFormData.append('document_ids', JSON.stringify(documentIds))
      const res: any = await processDocumentsReq(projectId, processFormData)
      if (res.success) {
        notifications.show({ color: 'green', message: t('structuredData.batchProcessSubmitted') })
        setSelectedUploadedPaths([])
        setTimeout(() => getDocumentsRef.current(), 500)
      } else {
        notifications.show({ color: 'red', message: t('structuredData.batchProcessFailed') })
      }
    } catch (error) {
      notifications.show({ color: 'red', message: t('structuredData.batchProcessFailed') })
    }
  }

  // 批量删除
  const batchDeleteAll = () => {
    const documentIds = selectedDocumentIds.filter(Boolean)
    if (documentIds.length === 0) {
      notifications.show({ color: 'yellow', message: t('structuredData.pleaseSelectDocuments') })
      return
    }

    modals.openConfirmModal({
      title: t('structuredData.batchDeleteTitle'),
      children: t('structuredData.batchDeleteConfirm', { count: documentIds.length }),
      labels: { confirm: t('structuredData.confirm'), cancel: t('structuredData.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          const formData = new FormData()
          formData.append('data_source_id', dataSourceId)
          formData.append('document_ids', JSON.stringify(documentIds))

          const res: any = await deleteDocumentsBatchReq(projectId, formData)
          if (res?.success) {
            const deletedIds = res?.data?.deleted_ids || []
            notifications.show({
              color: 'green',
              message: t('structuredData.batchDeleteSuccess', { count: deletedIds.length })
            })
          } else {
            notifications.show({ color: 'red', message: t('structuredData.batchDeleteFailed') })
          }
        } catch (error) {
          notifications.show({ color: 'red', message: t('structuredData.batchDeleteFailed') })
        } finally {
          setSelectedDocumentIds([])
          setSelectedUploadedPaths([])
          setSelectedRowKeys(new Set())
          getDocumentsRef.current()
        }
      }
    })
  }

  // 重新处理文档
  const reprocessDocument = async (row: any) => {
    try {
      const formData = new FormData()
      formData.append('data_source_id', dataSourceId)
      formData.append('document_ids', JSON.stringify([row.id]))
      const res: any = await processDocumentsReq(projectId, formData)
      if (res.success) {
        notifications.show({ color: 'green', message: t('structuredData.reprocessSubmitted') })
        setTimeout(() => getDocumentsRef.current(), 500)
      } else {
        notifications.show({ color: 'red', message: t('structuredData.submitFailed') })
      }
    } catch (error) {
      notifications.show({ color: 'red', message: t('structuredData.reprocessFailed') })
    }
  }

  const openDocumentLocation = async (row: any) => {
    const key = rowKey(row)
    if (!row?.id || openingDocumentIds.has(key)) {
      return
    }

    const filePath = getDocumentPath(row)
    if (!filePath) {
      notifications.show({ color: 'yellow', message: t('structuredData.openDocumentMissing') })
      return
    }

    const electronAPI = (window as any).electronAPI
    if (!electronAPI?.revealInFinder) {
      notifications.show({ color: 'yellow', message: t('structuredData.openDocumentDesktopOnly') })
      return
    }

    setOpeningDocumentIds((prev) => {
      const next = new Set(prev)
      next.add(key)
      return next
    })
    try {
      const ok = await electronAPI.revealInFinder(filePath)
      if (!ok) {
        notifications.show({ color: 'red', message: t('structuredData.openDocumentFailed') })
      }
    } catch (error) {
      notifications.show({ color: 'red', message: t('structuredData.openDocumentFailed') })
    } finally {
      setOpeningDocumentIds((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  // 删除文档
  const deleteDocument = (row: any) => {
    if (!row?.id) {
      notifications.show({ color: 'yellow', message: t('structuredData.pleaseSelectDocuments') })
      return
    }

    modals.openConfirmModal({
      title: t('structuredData.deleteConfirmTitle'),
      children: t('structuredData.deleteDocumentConfirm', { name: getDocumentName(row) }),
      labels: { confirm: t('structuredData.confirm'), cancel: t('structuredData.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          const formData = { document_id: row.id }
          const res: any = await deleteDocumentReq(projectId, formData)
          if (res?.success) {
            notifications.show({ color: 'green', message: t('structuredData.deleteSuccess') })
            getDocumentsRef.current()
          } else {
            notifications.show({ color: 'red', message: t('structuredData.deleteFailed') })
          }
        } catch (error) {
          notifications.show({ color: 'red', message: t('structuredData.deleteFailed') })
        }
      }
    })
  }

  // 工具函数
  const formatFileSize = (bytes: any) => {
    if (!bytes) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${Number.parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
  }

  const getStatusText = (status: any, errorMsg: any = null) => {
    const statusMap: Record<string, string> = {
      pending: t('structuredData.statusPending'),
      processing: t('structuredData.statusProcessing'),
      completed: t('structuredData.statusCompleted'),
      failed: t('structuredData.statusFailed'),
      cancelled: t('structuredData.statusCancelled'),
      uploaded: t('structuredData.statusUnprocessed')
    }
    // 如果有错误消息，显示错误消息
    if (errorMsg && status === 'processing') {
      return errorMsg
    }
    return statusMap[status] || status
  }

  const getStatusClass = (status: any) => {
    if (status === 'completed') return 'status-completed'
    if (status === 'failed') return 'status-failed'
    if (status === 'cancelled') return 'status-cancelled'
    if (status === 'uploaded') return 'status-uploaded'
    return 'status-processing'
  }

  const formatUploadTime = (value: any) => {
    if (!value) return '-'
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return String(value)
    return date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  // 渲染状态单元格
  const renderStatusCell = (row: any) => {
    const statusText = getStatusText(row.status, row.error_msg)
    const statusClass = styles[getStatusClass(row.status)]
    if (['completed', 'failed', 'cancelled', 'uploaded'].includes(row.status)) {
      return <span className={`${styles['status-pill']} ${statusClass}`}>{statusText}</span>
    }
    return (
      <div className={styles['progress-status']}>
        <Progress
          value={row.progress || 0}
          color={row.status === 'failed' ? 'red' : undefined}
          size={6}
          className={styles['status-progress']}
        />
        <span className={`${styles['status-pill']} ${statusClass}`}>{statusText}</span>
      </div>
    )
  }

  // ============ 添加本地文件逻辑 ============

  // 打开添加本地文件对话框
  const enterUploadMode = () => {
    setUploadDialogVisible(true)
    setUploadedFiles([])
    // 重置本地文件选择状态
  }

  // 关闭添加本地文件对话框
  const handleCloseUploadDialog = () => {
    setUploadDialogVisible(false)
    setUploadedFiles([])
  }

  // 退出添加本地文件模式（处理完成后）
  const exitUploadMode = () => {
    setUploadDialogVisible(false)
    setUploadedFiles([])
    getDocumentsRef.current()
  }

  // 读取本地文件路径（桌面端不复制文件内容）
  const customUploadRequest = useCallback(
    async (file: File) => {
      const form = new FormData()
      form.append('data_source_id', dataSourceIdRef.current)
      form.append('files', file)

      const uid = ((file as any).uid || Date.now() + Math.random()).toString()
      const item: UploadedItem = {
        uid,
        name: file.name,
        size: file.size || 0,
        progress: 1,
        success: false,
        failed: false,
        error: '',
        source: file,
        relative_path: '',
        timer: null
      }
      setUploadedFiles((prev) => [...prev, item])

      // 模拟进度
      const timer = setInterval(() => {
        setUploadedFiles((prev) =>
          prev.map((it) => {
            if (it.uid !== uid) return it
            if (it.success || it.failed) {
              clearInterval(timer)
              return it
            }
            if (it.progress < 90) {
              return { ...it, progress: Math.min(90, it.progress + Math.max(1, Math.round(Math.random() * 5))) }
            }
            return it
          })
        )
      }, 200)
      setUploadedFiles((prev) => prev.map((it) => (it.uid === uid ? { ...it, timer } : it)))

      try {
        const res: any = await uploadDocumentsReq(projectIdRef.current, form)
        if (res.success && res.data) {
          clearInterval(timer)

          // 保存本地文件路径；这里没有把文件复制到项目目录。
          const selectedFilePaths = res.data.uploaded_files || []
          const relativePath = selectedFilePaths.length > 0 ? selectedFilePaths[0] : file.name

          setUploadedFiles((prev) =>
            prev.map((it) =>
              it.uid === uid
                ? { ...it, progress: 100, success: true, failed: false, error: '', relative_path: relativePath }
                : it
            )
          )

        } else {
          const errMsg = res.message || t('structuredData.uploadFailed')
          clearInterval(timer)

          setUploadedFiles((prev) =>
            prev.map((it) => (it.uid === uid ? { ...it, failed: true, error: errMsg, progress: 0 } : it))
          )
        }
      } catch (e: any) {
        clearInterval(timer)

        setUploadedFiles((prev) =>
          prev.map((it) =>
            it.uid === uid ? { ...it, failed: true, error: e?.message || t('structuredData.uploadFailed'), progress: 0 } : it
          )
        )
      }
    },
    [t]
  )

  // Dropzone drop 回调：多文件逐个读取路径
  const handleDrop = useCallback(
    (files: File[]) => {
      files.forEach((f) => {
        void customUploadRequest(f)
      })
    },
    [customUploadRequest]
  )

  const handleReject = () => {
    notifications.show({
      color: 'red',
      message: t('structuredData.unsupportedFileFormat')
    })
  }

  const addLocalFilePaths = (filePaths: string[]) => {
    const acceptedPaths = filePaths.filter(isAcceptedLocalPath)
    if (acceptedPaths.length !== filePaths.length) {
      handleReject()
    }
    if (acceptedPaths.length === 0) return

    setUploadedFiles((prev) => {
      const existing = new Set(prev.map((it) => it.relative_path).filter(Boolean))
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
            timer: null
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
      notifications.show({ color: 'red', message: t('structuredData.uploadFailed') })
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

    // 重置状态
    setUploadedFiles((prev) =>
      prev.map((it, i) => (i === idx ? { ...it, failed: false, error: '', success: false, progress: 1 } : it))
    )

    const form = new FormData()
    form.append('data_source_id', dataSourceIdRef.current)
    form.append('files', uf.source)

    const timer = setInterval(() => {
      setUploadedFiles((prev) =>
        prev.map((it, i) => {
          if (i !== idx) return it
          if (it.success || it.failed) {
            clearInterval(timer)
            return it
          }
          if (it.progress < 90) {
            return { ...it, progress: Math.min(90, it.progress + Math.max(1, Math.round(Math.random() * 5))) }
          }
          return it
        })
      )
    }, 200)
    setUploadedFiles((prev) => prev.map((it, i) => (i === idx ? { ...it, timer } : it)))

    try {
      const res: any = await uploadDocumentsReq(projectIdRef.current, form)
      if (res.success && res.data) {
        clearInterval(timer)

        // 保存本地文件路径；这里没有把文件复制到项目目录。
        const selectedFilePaths = res.data.uploaded_files || []
        const relativePath = selectedFilePaths.length > 0 ? selectedFilePaths[0] : uf.name

        setUploadedFiles((prev) =>
          prev.map((it, i) =>
            i === idx
              ? { ...it, progress: 100, success: true, failed: false, error: '', relative_path: relativePath }
              : it
          )
        )
      } else {
        clearInterval(timer)

        setUploadedFiles((prev) =>
          prev.map((it, i) =>
            i === idx ? { ...it, failed: true, error: res.message || t('structuredData.uploadFailed'), progress: 0 } : it
          )
        )
      }
    } catch (e: any) {
      clearInterval(timer)

      setUploadedFiles((prev) =>
        prev.map((it, i) =>
          i === idx ? { ...it, failed: true, error: e?.message || t('structuredData.uploadFailed'), progress: 0 } : it
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
    const uploadedFileList = uploadedFiles.filter((f) => f.success && f.relative_path)
    const filePaths = uploadedFileList.map((f) => f.relative_path)

    if (filePaths.length === 0) {
      notifications.show({ color: 'yellow', message: t('structuredData.noFilesToProcess') })
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
        notifications.show({ color: 'red', message: createRes.message || t('structuredData.createDocumentFailed') })
        return
      }

      // 2. 提取document_ids
      const documentIds =
        createRes.data?.created_documents?.map((doc: any) => doc.document_id)?.filter((id: any) => id != null) || []

      if (documentIds.length === 0) {
        notifications.show({ color: 'red', message: t('structuredData.noDocumentsCreated') })
        return
      }

      // 3. 处理文档
      const processFormData = new FormData()
      processFormData.append('data_source_id', dataSourceId)
      processFormData.append('document_ids', JSON.stringify(documentIds))

      const processRes: any = await processDocumentsReq(projectId, processFormData)
      if (processRes.success) {
        notifications.show({ color: 'green', message: t('structuredData.addedToProcessQueue') })
        exitUploadMode()
      } else {
        notifications.show({ color: 'red', message: processRes.message || t('structuredData.addToQueueFailed') })
      }
    } catch (error: any) {
      notifications.show({ color: 'red', message: error.message || t('structuredData.processFailed') })
    } finally {
      setSubmitting(false)
    }
  }

  const pageCount = Math.max(1, Math.ceil(totalCount / pageSize))

  return (
    <div className={styles['document-management']}>
      {/* 列表模式 */}
      <div className={styles['list-mode']}>
        <div className={`${styles['content-card']} ${styles['document-card']}`} style={{ position: 'relative' }}>
          <LoadingOverlay visible={loading} zIndex={10} />
          <div className={styles['operations-header']}>
            <div className={styles['header-copy']}>
              <div className={styles['title-row']}>
                <span className={styles['title-icon']}>
                  <IconFileSpreadsheet size={18} stroke={1.7} />
                </span>
                <div>
                  <h3>{t('structuredData.tabs.files')}</h3>
                  <p>{t('structuredData.fileManagementSubtitle')}</p>
                </div>
              </div>
              <div className={styles['stats-row']}>
                <div className={styles['stat-item']}>
                  <span>{t('structuredData.totalFiles')}</span>
                  <strong>{documentStats.total}</strong>
                </div>
                <div className={styles['stat-item']}>
                  <span>{t('structuredData.statusCompleted')}</span>
                  <strong>{documentStats.completed}</strong>
                </div>
                <div className={styles['stat-item']}>
                  <span>{t('structuredData.statusProcessing')}</span>
                  <strong>{documentStats.processing}</strong>
                </div>
                <div className={styles['stat-item']}>
                  <span>{t('structuredData.statusFailed')}</span>
                  <strong>{documentStats.failed}</strong>
                </div>
                <div className={styles['stat-item']}>
                  <span>{t('structuredData.selectedFiles')}</span>
                  <strong>{documentStats.selected}</strong>
                </div>
              </div>
            </div>
            <div className={styles['header-actions']}>
              <Button color="yiw" onClick={enterUploadMode} leftSection={<IconFilePlus size={16} stroke={1.6} />}>
                {t('structuredData.uploadDocument')}
              </Button>
              <Button
                variant="light"
                color="yiw"
                disabled={selectedUploadedPaths.length === 0}
                onClick={batchProcessUploaded}
              >
                {t('structuredData.batchProcessUnprocessed', { count: selectedUploadedPaths.length })}
              </Button>
              <Button
                variant="light"
                color="red"
                disabled={selectedDocumentIds.length === 0}
                onClick={batchDeleteAll}
              >
                {t('structuredData.batchDelete', { count: selectedDocumentIds.length })}
              </Button>
            </div>
          </div>

          {/* 文档列表 */}
          <div className={styles['table-wrapper']}>
            {documentList.length === 0 ? (
              <div className={styles['empty-state']}>
                <span className={styles['empty-icon']}>
                  <IconFileSpreadsheet size={24} stroke={1.7} />
                </span>
                <h4>{t('structuredData.emptyFileTitle')}</h4>
                <p>{t('structuredData.emptyFileDesc')}</p>
                <Button color="yiw" onClick={enterUploadMode} leftSection={<IconFilePlus size={16} stroke={1.6} />}>
                  {t('structuredData.uploadDocument')}
                </Button>
              </div>
            ) : (
              <div className={styles['table-shell']}>
                <Table className={styles['document-table']} style={{ width: '100%' }} verticalSpacing="sm">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th style={{ width: 48 }}>
                        <Checkbox
                          aria-label="select-all"
                          checked={allSelected}
                          indeterminate={someSelected}
                          onChange={(e) => toggleSelectAll(e.currentTarget.checked)}
                        />
                      </Table.Th>
                      <Table.Th style={{ minWidth: 240 }}>{t('structuredData.fileName')}</Table.Th>
                      <Table.Th style={{ width: 100 }}>{t('structuredData.size')}</Table.Th>
                      <Table.Th style={{ width: 140 }}>{t('structuredData.time')}</Table.Th>
                      <Table.Th style={{ width: 190 }}>{t('structuredData.status')}</Table.Th>
                      <Table.Th style={{ width: 124 }}>{t('structuredData.actions')}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {documentList.map((row) => {
                      const key = rowKey(row)
                      const documentName = getDocumentName(row)
                      return (
                        <Table.Tr key={key}>
                          <Table.Td>
                            <Checkbox
                              aria-label="select-row"
                              checked={selectedRowKeys.has(key)}
                              onChange={(e) => toggleRowSelection(row, e.currentTarget.checked)}
                            />
                          </Table.Td>
                          <Table.Td>
                            <div className={styles['file-cell']}>
                              <span className={styles['file-icon']}>
                                <IconFileText size={16} stroke={1.7} />
                              </span>
                              <Tooltip label={documentName} withArrow>
                                <span className={styles['file-name']}>{documentName}</span>
                              </Tooltip>
                            </div>
                          </Table.Td>
                          <Table.Td className={styles['muted-cell']}>{formatFileSize(row.size)}</Table.Td>
                          <Table.Td className={styles['muted-cell']}>{formatUploadTime(row.created_at)}</Table.Td>
                          <Table.Td>{renderStatusCell(row)}</Table.Td>
                          <Table.Td>
                            <div className={styles['row-actions']}>
                              {row.id && (
                                <Tooltip label={t('structuredData.openDocumentLocation')} position="top" withArrow={false}>
                                  <Button
                                    variant="subtle"
                                    size="xs"
                                    className={`${styles['action-btn']} ${styles['icon-only-btn']}`}
                                    loading={openingDocumentIds.has(key)}
                                    disabled={openingDocumentIds.has(key)}
                                    onClick={() => openDocumentLocation(row)}
                                  >
                                    <IconFolderOpen className={styles['action-icon']} size={16} stroke={1.6} />
                                  </Button>
                                </Tooltip>
                              )}
                              {row.id && (
                                <Tooltip label={t('structuredData.reprocessDocument')} position="top" withArrow={false}>
                                  <Button
                                    variant="subtle"
                                    size="xs"
                                    className={`${styles['action-btn']} ${styles['icon-only-btn']}`}
                                    onClick={() => reprocessDocument(row)}
                                  >
                                    <IconRefresh className={styles['action-icon']} size={16} stroke={1.6} />
                                  </Button>
                                </Tooltip>
                              )}
                              {row.id && (
                                <Tooltip label={t('structuredData.deleteDocument')} position="top" withArrow={false}>
                                  <Button
                                    variant="subtle"
                                    size="xs"
                                    className={`${styles['action-btn']} ${styles['delete-btn']} ${styles['icon-only-btn']}`}
                                    onClick={() => deleteDocument(row)}
                                  >
                                    <IconTrash className={styles['action-icon']} size={16} stroke={1.6} />
                                  </Button>
                                </Tooltip>
                              )}
                            </div>
                          </Table.Td>
                        </Table.Tr>
                      )
                    })}
                  </Table.Tbody>
                </Table>
              </div>
            )}
            {/* 分页 */}
            {documentList.length > 0 && (
              <div className={styles['page-footer']}>
                <Select
                  size={isMobile ? 'xs' : 'sm'}
                  w={120}
                  value={String(pageSize)}
                  onChange={(v) => {
                    setPageSize(Number(v) || 20)
                    setCurrentPage(1)
                  }}
                  data={[10, 20, 50, 100].map((n) => ({ value: String(n), label: `${n} / page` }))}
                  comboboxProps={{ withinPortal: true }}
                />
                <Pagination
                  value={currentPage}
                  onChange={setCurrentPage}
                  total={pageCount}
                  size={isMobile ? 'sm' : 'md'}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 添加本地文件 Dialog */}
      <Modal
        opened={uploadDialogVisible}
        onClose={handleCloseUploadDialog}
        title={
          <div className={styles['local-file-title']}>
            <span className={styles['local-file-title-icon']}>
              <IconFilePlus size={18} stroke={1.7} />
            </span>
            <div>
              <strong>{t('structuredData.uploadDocument')}</strong>
              <small>{t('structuredData.localFileModalSubtitle')}</small>
            </div>
          </div>
        }
        size="min(1080px, 94vw)"
        closeOnClickOutside={false}
        centered
        className={styles['upload-dialog']}
        styles={{ body: { display: 'flex', flexDirection: 'column' } }}
      >
        <div className={styles['local-file-notice']}>
          <IconInfoCircle size={18} stroke={1.7} />
          <div>
            <strong>{t('structuredData.localFileSourceNoteTitle')}</strong>
            <span>{t('structuredData.localFileSourceNote')}</span>
          </div>
        </div>

        <div className={styles['upload-section']}>
          <div className={styles['select-layout']}>
            <Dropzone
              className={styles['upload-drop']}
              multiple
              maxFiles={50}
              activateOnClick={!hasNativePathPicker}
              accept={acceptedFileTypes}
              validator={validateAcceptedFileType}
              onDrop={handleDrop}
              onReject={handleReject}
              onClick={handleDropzoneClick}
            >
              <div className={styles['dropzone-inner']}>
                <span className={styles['upload-icon']}>
                  <IconFilePlus size={42} stroke={1.7} />
                </span>
                <div className={styles['upload-text']}>{t('structuredData.uploadDragText')}</div>
                <div className={styles['upload-tip']}>
                  <div>{t('structuredData.uploadMultipleHint')}</div>
                  <div>{t('structuredData.uploadFormatHint')}</div>
                </div>
              </div>
            </Dropzone>

            <div className={styles['file-list']}>
              <div className={styles['list-header']}>
                <span>
                  {t('structuredData.uploadedCount', { success: successUploadCount, total: uploadedFiles.length })}
                </span>
                {uploadedFiles.length > 0 && (
                  <Button variant="subtle" color="red" size="xs" onClick={clearUploadedFiles}>
                    {t('structuredData.clear')}
                  </Button>
                )}
              </div>
              <div className={styles['file-list-scroll']}>
                {uploadedFiles.length === 0 ? (
                  <div className={styles['files-empty']}>
                    <IconFileSpreadsheet size={38} stroke={1.7} />
                    <span>{t('structuredData.noUploadedFiles')}</span>
                  </div>
                ) : (
                  uploadedFiles.map((file, idx) => (
                    <div key={file.uid} className={styles['file-item']}>
                      <span className={styles['file-item-icon']}>
                        <IconFileText size={16} stroke={1.7} />
                      </span>
                      <span className={styles['file-name']} title={file.name}>
                        {file.name}
                      </span>
                      <Progress
                        value={file.progress}
                        color={file.success ? 'teal' : file.failed ? 'red' : 'yiw'}
                        className={styles['file-progress']}
                      />
                      <span className={styles['file-size']}>{formatFileSize(file.size)}</span>
                      <span
                        className={`${styles['file-status']} ${
                          file.failed ? styles['file-status-failed'] : file.success ? styles['file-status-ready'] : ''
                        }`}
                      >
                        {file.failed
                          ? t('structuredData.statusFailed')
                          : file.success
                            ? t('structuredData.statusUploaded')
                            : t('structuredData.statusProcessing')}
                      </span>
                      {file.failed && (
                        <Button variant="subtle" color="yiw" size="xs" onClick={() => retryFileUpload(idx)}>
                          {t('structuredData.retry')}
                        </Button>
                      )}
                      <Button variant="subtle" color="red" size="xs" onClick={() => removeUploadedFile(idx)}>
                        {t('structuredData.delete')}
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>

        {/* 底部按钮 */}
        <div className={styles['dialog-footer']}>
          <Button variant="default" onClick={handleCloseUploadDialog}>
            {t('structuredData.cancel')}
          </Button>
          <Button
            color="yiw"
            loading={submitting}
            disabled={successUploadCount === 0}
            onClick={handleSubmitUpload}
          >
            {t('structuredData.startProcessing')}
          </Button>
        </div>
      </Modal>
    </div>
  )
}
