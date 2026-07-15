import { useMemo, useRef, useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Modal,
  Textarea,
  TextInput,
  Badge,
  SegmentedControl,
  Group,
  Switch,
  Pagination,
  Select,
  Loader,
  LoadingOverlay,
  Center,
  Text,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import ElSvgIcon from '@/components/ElSvgIcon'
import { useResponsive } from '@/hooks/use-responsive'
import {
  getExamplesReq,
  getExamplesStatsReq,
  createExamplesReq,
  updateExampleReq,
  deleteExamplesReq,
  searchExamplesReq,
  generateExampleEmbeddingsReq,
} from '@/api/business-semantic'
import ExampleEmptyState from './ExampleEmptyState'
import styles from './ExampleManager.module.scss'

export interface ExampleManagerProps {
  projectId: string
  businessId: string
}

interface ExampleItem {
  question: string
  content: string
}

interface Pagination {
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export default function ExampleManager({ projectId, businessId }: ExampleManagerProps) {
  const { t } = useTranslation()
  const { isMobile } = useResponsive()

  // 响应式数据
  const [examplesStats, setExamplesStats] = useState<any>({
    total_examples: 0,
    status: 'empty',
    collection_name: '',
    database_id: businessId,
  })

  const [showAddDialog, setShowAddDialog] = useState(false)
  const [showSearchDialog, setShowSearchDialog] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const [adding, setAdding] = useState(false)
  const [searching, setSearching] = useState(false)
  const [loading, setLoading] = useState(false)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_deleting, setDeleting] = useState(false)
  const [generatingAll, setGeneratingAll] = useState(false)
  const [generatingExampleId, setGeneratingExampleId] = useState<any>(null)
  const [togglingExampleId, setTogglingExampleId] = useState<any>(null)
  const [searchQuestion, setSearchQuestion] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [examplesList, setExamplesList] = useState<any[]>([])
  const [showEditDialog, setShowEditDialog] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState<{ id: any; question: string; content: string }>({
    id: '',
    question: '',
    content: '',
  })

  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    pageSize: 20,
    total: 0,
    totalPages: 0,
  })

  // 添加样例对话框相关
  const [inputMode, setInputMode] = useState<'form' | 'json'>('form') // 'form' 或 'json'
  const [exampleItems, setExampleItems] = useState<ExampleItem[]>([{ question: '', content: '' }]) // 表单模式的样例列表
  const [jsonInput, setJsonInput] = useState('') // JSON模式的输入

  // 隐藏的文件 input（替代 el-upload）
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 计算属性
  const formattedJsonInput = useMemo(() => {
    try {
      const parsed = JSON.parse(jsonInput)
      return JSON.stringify(parsed, null, 2)
    } catch {
      return t('business.example.invalidJsonFormat')
    }
  }, [jsonInput, t])

  // 方法
  const loadExamplesStats = async () => {
    try {
      const response: any = await getExamplesStatsReq(projectId)
      if (response.success) {
        setExamplesStats(response.data)
      }
    } catch (error) {
      console.error('加载样例统计失败:', error)
    }
  }

  // 添加一行样例
  const addExampleItem = () => {
    setExampleItems((prev) => [...prev, { question: '', content: '' }])
  }

  // 删除一行样例
  const removeExampleItem = (index: number) => {
    setExampleItems((prev) => {
      if (prev.length > 1) {
        const next = [...prev]
        next.splice(index, 1)
        return next
      }
      return prev
    })
  }

  // 更新某一行样例字段
  const updateExampleItem = (index: number, key: keyof ExampleItem, value: string) => {
    setExampleItems((prev) => prev.map((item, i) => (i === index ? { ...item, [key]: value } : item)))
  }

  // 处理文件上传
  const handleFileUpload = (file: File) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string
        // 解析 JSON
        const parsed = JSON.parse(content)

        if (!Array.isArray(parsed)) {
          notifications.show({ color: 'red', message: t('business.example.jsonMustBeArray') })
          return
        }

        // 验证每个样例的字段
        const validItems = parsed.filter((item: any) => {
          if (!item.question || !item.content) {
            return false
          }
          return true
        })

        if (validItems.length === 0) {
          notifications.show({ color: 'red', message: t('business.example.noValidExamples') })
          return
        }

        // 追加到表单数据（如果当前只有一个空白行，先清空）
        setExampleItems((prev) => {
          let base = prev
          if (prev.length === 1 && !prev[0].question && !prev[0].content) {
            base = []
          }
          // 追加新数据
          const appended = validItems.map((item: any) => ({
            question: item.question.trim(),
            content: item.content.trim(),
          }))
          return [...base, ...appended]
        })

        // 切换到表单模式
        setInputMode('form')

        notifications.show({
          color: 'green',
          message: t('business.example.importSuccess', { count: validItems.length }),
        })
      } catch (error: any) {
        notifications.show({
          color: 'red',
          message: t('business.example.jsonFileFormatError', { message: error.message }),
        })
      }
    }
    reader.onerror = () => {
      notifications.show({ color: 'red', message: t('business.example.fileReadFailed') })
    }
    reader.readAsText(file)
  }

  // 文件 input change
  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      handleFileUpload(file)
    }
    // 允许重复选择同一个文件
    e.target.value = ''
  }

  // 导出 JSON 文件
  const handleExportJson = async () => {
    try {
      // 获取所有样例数据
      const response: any = await getExamplesReq(projectId, 1, 999999)

      if (!response || !response.success || !response.data?.items) {
        notifications.show({ color: 'red', message: t('business.example.getExamplesFailed') })
        return
      }

      const examples = response.data.items.map((item: any) => ({
        question: item.question,
        content: item.content,
      }))

      if (examples.length === 0) {
        notifications.show({ color: 'yellow', message: t('business.example.noExamplesExport') })
        return
      }

      // 创建 JSON 字符串
      const jsonStr = JSON.stringify(examples, null, 2)

      // 创建 Blob 对象
      const blob = new Blob([jsonStr], { type: 'application/json' })

      // 创建下载链接
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `examples_${businessId}_${new Date().getTime()}.json`

      // 触发下载
      document.body.appendChild(link)
      link.click()

      // 清理
      document.body.removeChild(link)
      URL.revokeObjectURL(url)

      notifications.show({
        color: 'green',
        message: t('business.example.exportSuccess', { count: examples.length }),
      })
    } catch (error: any) {
      console.error('导出失败:', error)
      notifications.show({
        color: 'red',
        message: t('business.example.exportFailed') + ': ' + error.message,
      })
    }
  }

  // 编辑样例
  const handleEditExample = (example: any) => {
    // 填充编辑表单
    setEditForm({
      id: example.id,
      question: example.question,
      content: example.content,
    })
    setShowEditDialog(true)
  }

  // 保存编辑
  const handleSaveEdit = async () => {
    try {
      if (!editForm.question.trim() || !editForm.content.trim()) {
        notifications.show({ color: 'yellow', message: t('business.example.questionAnswerRequired') })
        return
      }

      setEditing(true)

      // 直接更新样例
      await updateExampleReq(projectId, editForm.id, {
        question: editForm.question.trim(),
        content: editForm.content.trim(),
      })

      notifications.show({ color: 'green', message: t('business.example.editSuccess') })
      setShowEditDialog(false)

      // 刷新列表
      await loadExamplesStats()
      await loadExamplesList()
    } catch (error: any) {
      console.error('编辑失败:', error)
      notifications.show({
        color: 'red',
        message: t('business.example.editFailed') + ': ' + error.message,
      })
    } finally {
      setEditing(false)
    }
  }

  // 复制样例
  const copyExample = (example: any) => {
    // 填充表单并打开添加对话框
    setInputMode('form')
    setExampleItems([
      {
        question: example.question + ` (${t('business.example.copyLabel')})`,
        content: example.content,
      },
    ])
    setShowAddDialog(true)
  }

  // 切换样例激活状态
  const toggleExampleActive = async (example: any, isActive: boolean) => {
    try {
      setTogglingExampleId(example.id)
      const response: any = await updateExampleReq(projectId, example.id, {
        is_active: isActive,
      })
      if (response.success) {
        // 更新本地状态
        setExamplesList((prev) =>
          prev.map((item) => (item.id === example.id ? { ...item, is_active: isActive } : item))
        )
        notifications.show({
          color: 'green',
          message: isActive ? t('business.example.enabled') : t('business.example.disabled'),
        })
      }
    } catch (error: any) {
      notifications.show({
        color: 'red',
        message: t('business.example.operationFailed') + ': ' + error.message,
      })
    } finally {
      setTogglingExampleId(null)
    }
  }

  // 为单个样例生成向量
  const generateSingleEmbedding = async (example: any) => {
    try {
      setGeneratingExampleId(example.id)
      const response: any = await generateExampleEmbeddingsReq(projectId, example.id)
      if (response.success) {
        notifications.show({ color: 'green', message: t('business.example.vectorGenSuccess') })
        await loadExamplesList()
      }
    } catch (error: any) {
      console.error('生成向量失败:', error)
      notifications.show({
        color: 'red',
        message: t('business.example.singleVectorGenFailed') + ': ' + error.message,
      })
    } finally {
      setGeneratingExampleId(null)
    }
  }

  // 为所有样例生成向量
  const generateAllEmbeddings = async () => {
    if (examplesList.length === 0) {
      notifications.show({ color: 'yellow', message: t('business.example.noExamplesVector') })
      return
    }

    try {
      setGeneratingAll(true)
      notifications.show({ color: 'blue', message: t('business.example.startVectorGen') })

      const response: any = await generateExampleEmbeddingsReq(projectId)

      if (response.success) {
        notifications.show({ color: 'green', message: t('business.example.allVectorGenSuccess') })
        await loadExamplesList()
      }
    } catch (error: any) {
      console.error('批量生成向量失败:', error)
      notifications.show({
        color: 'red',
        message: t('business.example.batchVectorGenFailed') + ': ' + error.message,
      })
    } finally {
      setGeneratingAll(false)
    }
  }

  const handleAddExamples = async () => {
    try {
      let parsedExamples: any[] = []

      // 根据模式获取数据
      if (inputMode === 'form') {
        // 表单模式：验证并转换
        const validItems = exampleItems.filter((item) => item.question.trim() && item.content.trim())

        if (validItems.length === 0) {
          notifications.show({ color: 'yellow', message: t('business.example.fillAtLeastOne') })
          return
        }

        parsedExamples = validItems.map((item) => ({
          question: item.question.trim(),
          content: item.content.trim(),
        }))
      } else {
        // JSON模式：解析和验证
        if (!jsonInput.trim()) {
          notifications.show({ color: 'yellow', message: t('business.example.pleaseInputData') })
          return
        }

        try {
          parsedExamples = JSON.parse(jsonInput)
          if (!Array.isArray(parsedExamples)) {
            throw new Error(t('business.example.jsonMustBeArray'))
          }

          // 验证每个样例的必需字段
          for (let i = 0; i < parsedExamples.length; i++) {
            const example = parsedExamples[i]
            if (!example.question || !example.content) {
              throw new Error(t('business.example.exampleMissingFields', { index: i + 1 }))
            }
            // 清理多余字段，只保留question和content
            parsedExamples[i] = {
              question: example.question.trim(),
              content: example.content.trim(),
            }
          }
        } catch (error: any) {
          notifications.show({
            color: 'red',
            message: t('business.example.jsonFormatError') + ': ' + error.message,
          })
          return
        }
      }

      setAdding(true)

      const response: any = await createExamplesReq(projectId, {
        examples: parsedExamples,
        example_type: 'sql',
      })

      if (response.success) {
        notifications.show({
          color: 'green',
          message: response.msg || t('business.example.addSuccess'),
        })
        setShowAddDialog(false)
        // 清空表单
        setExampleItems([{ question: '', content: '' }])
        setJsonInput('')
        await loadExamplesStats()
        await loadExamplesList()
      } else {
        notifications.show({ color: 'red', message: response.msg || t('business.example.addFailed') })
      }
    } catch (error: any) {
      console.error('添加样例失败:', error)
      notifications.show({
        color: 'red',
        message: t('business.example.addFailed') + ': ' + error.message,
      })
    } finally {
      setAdding(false)
    }
  }

  // 注：handleClearAll 在 Vue 模板中未被绑定，但逻辑保留以保持业务一致
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleClearAll = async () => {
    modals.openConfirmModal({
      title: t('business.example.confirmClearTitle'),
      children: t('business.example.confirmClearMsg'),
      labels: {
        confirm: t('business.example.confirm'),
        cancel: t('business.example.cancel'),
      },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          // 获取所有样例 ID
          const allIds = examplesList.map((item) => item.id)
          if (allIds.length === 0) {
            notifications.show({ color: 'yellow', message: t('business.example.noExamplesClear') })
            return
          }

          const response: any = await deleteExamplesReq(projectId, allIds)
          if (response.success) {
            notifications.show({
              color: 'green',
              message: response.msg || t('business.example.clearSuccess'),
            })
            await loadExamplesStats()
            await loadExamplesList()
          } else {
            notifications.show({
              color: 'red',
              message: response.msg || t('business.example.clearFailed'),
            })
          }
        } catch (error: any) {
          console.error('清空样例失败:', error)
          notifications.show({
            color: 'red',
            message: t('business.example.clearFailed') + ': ' + error.message,
          })
        }
      },
    })
  }

  const handleTestSearch = async () => {
    if (!searchQuestion.trim()) {
      notifications.show({ color: 'yellow', message: t('business.example.pleaseInputSearch') })
      return
    }

    try {
      setSearching(true)
      setHasSearched(true)

      const response: any = await searchExamplesReq(projectId, searchQuestion)

      if (response.success) {
        setSearchResults(response.data?.items || [])
      } else {
        notifications.show({ color: 'red', message: response.msg || t('business.example.searchFailed') })
      }
    } catch (error: any) {
      console.error('搜索样例失败:', error)
      notifications.show({
        color: 'red',
        message: t('business.example.searchFailed') + ': ' + error.message,
      })
    } finally {
      setSearching(false)
    }
  }

  const handlePageChange = (page: number) => {
    setPagination((prev) => ({ ...prev, page }))
  }

  const handlePageSizeChange = (pageSize: number) => {
    setPagination((prev) => ({ ...prev, pageSize, page: 1 }))
  }

  const handleDeleteExample = (example: any) => {
    modals.openConfirmModal({
      title: t('business.example.confirmDeleteTitle'),
      children: t('business.example.confirmDeleteMsg', {
        question: example.question.substring(0, 50),
      }),
      labels: {
        confirm: t('business.example.confirm'),
        cancel: t('business.example.cancel'),
      },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          setDeleting(true)

          const response: any = await deleteExamplesReq(projectId, [example.id])

          if (response.success) {
            notifications.show({ color: 'green', message: t('business.example.deleteSuccess') })
            // 如果当前页只有一条数据且不是第一页，则返回上一页
            if (examplesList.length === 1 && pagination.page > 1) {
              setPagination((prev) => ({ ...prev, page: prev.page - 1 }))
            } else {
              await loadExamplesList()
            }
            await loadExamplesStats()
          } else {
            notifications.show({
              color: 'red',
              message: response.msg || t('business.example.deleteFailed'),
            })
          }
        } catch (error: any) {
          console.error('删除样例失败:', error)
          notifications.show({
            color: 'red',
            message: t('business.example.deleteFailed') + ': ' + error.message,
          })
        } finally {
          setDeleting(false)
        }
      },
    })
  }

  const loadExamplesList = async () => {
    try {
      setLoading(true)
      const response: any = await getExamplesReq(projectId, pagination.page,
        pagination.pageSize
      )

      if (response && response.success) {
        setExamplesList(response.data?.items || [])
        setPagination((prev) => {
          const total = response.data?.total || 0
          let totalPages
          // 计算总页数：如果有total_pages就用，否则根据total和pageSize计算
          if (response.data?.total_pages !== undefined) {
            totalPages = response.data.total_pages
          } else {
            totalPages = total > 0 ? Math.ceil(total / prev.pageSize) : 0
          }
          return { ...prev, total, totalPages }
        })
      } else {
        // 如果响应不成功，清空列表
        setExamplesList([])
        setPagination((prev) => ({ ...prev, total: 0, totalPages: 0 }))
      }
    } catch (error: any) {
      console.error('加载样例列表失败:', error)
      // 发生错误时，清空列表而不是显示错误（空数据是正常情况）
      setExamplesList([])
      setPagination((prev) => ({ ...prev, total: 0, totalPages: 0 }))
      // 只有非404错误才显示错误提示
      if (error.response?.status !== 404) {
        notifications.show({ color: 'red', message: t('business.example.loadListFailed') })
      }
    } finally {
      setLoading(false)
    }
  }

  // 关闭添加对话框（清空表单）
  const handleDialogClose = () => {
    if (adding) return
    // 清空表单
    setExampleItems([{ question: '', content: '' }])
    setJsonInput('')
    setShowAddDialog(false)
  }

  // 从空状态添加样例
  const handleAddFirst = () => {
    setInputMode('form')
    setShowAddDialog(true)
  }

  // 从空状态批量导入
  const handleBulkImport = () => {
    setInputMode('json')
    setShowAddDialog(true)
  }

  // 监听器
  // 监听数据库ID变化（immediate）
  useEffect(() => {
    if (businessId) {
      setExamplesStats((prev: any) => ({ ...prev, database_id: businessId }))
      loadExamplesStats()
      loadExamplesList()
    } else {
      // 清空状态
      setExamplesStats({
        total_examples: 0,
        status: 'empty',
        collection_name: '',
        database_id: businessId,
      })
      setExamplesList([])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId])

  // 分页 page / pageSize 变化时重新加载（对应原 handlePageChange/handlePageSizeChange 内的 loadExamplesList）
  useEffect(() => {
    if (businessId) {
      loadExamplesList()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pagination.page, pagination.pageSize])

  return (
    <div className={styles.tabContainer}>
      {/* 统一的内容卡片 */}
      <div className={styles.contentCard}>
        <LoadingOverlay visible={loading} zIndex={5} />

        {/* 顶部操作区 */}
        {examplesList.length > 0 && (
          <div className={styles.operationsHeader}>
            <div className={styles.headerIntro}>
              <span>{t('business.example.headerIntro')}</span>
            </div>
            <div className={styles.headerActions}>
              <Button
                variant="default"
                leftSection={<ElSvgIcon name="Search" size={16} />}
                onClick={() => setShowSearchDialog(true)}
              >
                {t('business.example.searchExample')}
              </Button>
              <Button
                variant="default"
                leftSection={<ElSvgIcon name="Plus" size={16} />}
                onClick={() => setShowAddDialog(true)}
              >
                {t('business.example.addExample')}
              </Button>
              <Button
                variant="default"
                leftSection={<ElSvgIcon name="Download" size={16} />}
                onClick={handleExportJson}
                disabled={examplesList.length === 0}
              >
                {t('business.example.exportAll')}
              </Button>
              <Button
                variant="default"
                leftSection={<ElSvgIcon name="Connection" size={16} />}
                onClick={generateAllEmbeddings}
                loading={generatingAll}
                disabled={examplesList.length === 0}
              >
                {t('business.example.generateAllVectors')}
              </Button>
            </div>
          </div>
        )}

        {/* 搜索区域已移除，改为对话框 */}

        {/* 内容区域 */}
        {/* 空状态 */}
        {!loading && examplesList.length === 0 ? (
          <ExampleEmptyState onAddFirst={handleAddFirst} onBulkImport={handleBulkImport} />
        ) : (
          /* 有数据时 */
          <div className={styles.examplesList}>
            <table className={styles.examplesTable}>
              <thead>
                <tr>
                  <th className={styles.colCenter} style={{ width: 70 }}>
                    {t('business.example.enable')}
                  </th>
                  <th style={{ minWidth: 200 }}>{t('business.example.question')}</th>
                  <th style={{ minWidth: 250 }}>{t('business.example.answer')}</th>
                  <th className={styles.colCenter} style={{ width: 120 }}>
                    {t('business.example.vectorization')}
                  </th>
                  <th className={styles.colRight} style={{ width: 150 }}>
                    {t('business.example.actions')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {examplesList.map((row) => (
                  <tr key={row.id} onClick={() => handleEditExample(row)}>
                    <td className={styles.colCenter}>
                      <Switch
                        size="sm"
                        checked={!!row.is_active}
                        onChange={(event) => toggleExampleActive(row, event.currentTarget.checked)}
                        disabled={togglingExampleId === row.id}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </td>
                    <td>
                      <span className={styles.questionText}>{row.question}</span>
                    </td>
                    <td>
                      <span className={styles.sqlText}>{row.content}</span>
                    </td>
                    <td>
                      <div className={styles.embeddingCell} onClick={(e) => e.stopPropagation()}>
                        <Badge size="sm" color={row.has_embedding ? 'green' : 'yellow'} variant="light">
                          {row.has_embedding
                            ? t('business.example.vectorized')
                            : t('business.example.notVectorized')}
                        </Badge>
                        {generatingExampleId !== row.id ? (
                          <span
                            className={styles.refreshIcon}
                            title={
                              row.has_embedding
                                ? t('business.example.reVectorize')
                                : t('business.example.vectorize')
                            }
                            onClick={() => generateSingleEmbedding(row)}
                          >
                            <ElSvgIcon name="Refresh" size={14} />
                          </span>
                        ) : (
                          <span className={`${styles.refreshIcon} ${styles.loading}`}>
                            <Loader size={14} />
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <div className={styles.actionLinks} onClick={(e) => e.stopPropagation()}>
                        <span
                          className={`${styles.actionLink} ${styles.primary}`}
                          onClick={() => copyExample(row)}
                        >
                          {t('business.example.copy')}
                        </span>
                        <span
                          className={`${styles.actionLink} ${styles.primary}`}
                          onClick={() => handleEditExample(row)}
                        >
                          {t('business.example.edit')}
                        </span>
                        <span
                          className={`${styles.actionLink} ${styles.danger}`}
                          onClick={() => handleDeleteExample(row)}
                        >
                          {t('business.example.delete')}
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* 分页 */}
            {pagination.total > 0 && searchResults.length === 0 && (
              <div className={styles.paginationWrapper}>
                <Group gap="sm" wrap="wrap" justify={isMobile ? 'flex-start' : 'center'}>
                  <Text size="sm" c="dimmed">
                    {t('common.total', '共')} {pagination.total}
                  </Text>
                  {!isMobile && (
                    <Select
                      size="xs"
                      w={110}
                      data={['10', '20', '50', '100'].map((v) => ({
                        value: v,
                        label: `${v} / page`,
                      }))}
                      value={String(pagination.pageSize)}
                      onChange={(val) => val && handlePageSizeChange(Number(val))}
                      allowDeselect={false}
                    />
                  )}
                  <Pagination
                    total={pagination.totalPages}
                    value={pagination.page}
                    onChange={handlePageChange}
                    size="sm"
                  />
                </Group>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 添加样例对话框 */}
      <Modal
        opened={showAddDialog}
        onClose={handleDialogClose}
        title={t('business.example.addExampleData')}
        size="85%"
        closeOnClickOutside={false}
      >
        <div className={styles.addExamplesContainer}>
          {/* 顶部操作栏 */}
          <div className={styles.dialogTopActions}>
            {/* 模式切换 */}
            <div className={styles.modeSwitch}>
              <SegmentedControl
                value={inputMode}
                onChange={(val) => setInputMode(val as 'form' | 'json')}
                data={[
                  { value: 'form', label: t('business.example.formMode') },
                  { value: 'json', label: t('business.example.bulkImport') },
                ]}
              />
            </div>

            {/* 上传按钮 */}
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                style={{ display: 'none' }}
                onChange={onFileInputChange}
              />
              <Button
                variant="default"
                leftSection={<ElSvgIcon name="Upload" size={16} />}
                onClick={() => fileInputRef.current?.click()}
              >
                {t('business.example.uploadJson')}
              </Button>
            </div>
          </div>

          {/* 表单模式 */}
          {inputMode === 'form' ? (
            <div className={styles.formMode}>
              <div className={styles.examplesList}>
                {exampleItems.map((item, index) => (
                  <div key={index} className={styles.exampleItemCard}>
                    <div className={styles.cardHeader}>
                      <span className={styles.itemIndex}>
                        {t('business.example.exampleIndex', { index: index + 1 })}
                      </span>
                      <Button
                        variant="subtle"
                        color="gray"
                        size="compact-sm"
                        onClick={() => removeExampleItem(index)}
                        disabled={exampleItems.length === 1}
                        leftSection={<ElSvgIcon name="Delete" size={14} color="#f56c6c" />}
                      >
                        {t('business.example.delete')}
                      </Button>
                    </div>
                    <div className={styles.cardBody}>
                      <div className={styles.formItem}>
                        <label className={styles.formLabel}>{t('business.example.question')}</label>
                        <Textarea
                          value={item.question}
                          onChange={(e) => updateExampleItem(index, 'question', e.currentTarget.value)}
                          autosize
                          minRows={1}
                          placeholder={t('business.example.questionPlaceholder')}
                        />
                      </div>
                      <div className={styles.formItem}>
                        <label className={styles.formLabel}>{t('business.example.answer')}</label>
                        <Textarea
                          value={item.content}
                          onChange={(e) => updateExampleItem(index, 'content', e.currentTarget.value)}
                          autosize
                          minRows={3}
                          placeholder={t('business.example.answerPlaceholder')}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <Button
                variant="default"
                onClick={addExampleItem}
                style={{ width: '100%', marginTop: 12 }}
                leftSection={<ElSvgIcon name="Plus" size={16} />}
              >
                {t('business.example.addMore')}
              </Button>
            </div>
          ) : (
            /* JSON模式 */
            <div className={styles.jsonMode}>
              <Textarea
                value={jsonInput}
                onChange={(e) => setJsonInput(e.currentTarget.value)}
                autosize
                minRows={15}
                maxRows={15}
                placeholder={t('business.example.jsonPlaceholder')}
              />
              {jsonInput && (
                <div className={styles.jsonPreview}>
                  <h4>{t('business.example.jsonPreview')}</h4>
                  <pre className={styles.jsonCode}>{formattedJsonInput}</pre>
                </div>
              )}
            </div>
          )}

          {/* 使用说明 */}
          <div
            style={{
              marginTop: 16,
              padding: '12px 16px',
              borderRadius: 8,
              background: 'var(--el-color-info-light-9, #f4f4f5)',
              border: '1px solid var(--el-color-info-light-7, #dedfe0)',
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 8, color: '#303133' }}>
              {t('business.example.usageGuideTitle')}
            </div>
            <ul className={styles.usageGuide} style={{ margin: 0, paddingLeft: 20 }}>
              <li>{t('business.example.usageGuide1')}</li>
              <li>{t('business.example.usageGuide2')}</li>
              <li>{t('business.example.usageGuide3')}</li>
              <li>{t('business.example.usageGuide4')}</li>
            </ul>
          </div>
        </div>

        {/* footer */}
        <div className={styles.dialogFooter} style={{ marginTop: 16 }}>
          <Button variant="default" onClick={handleDialogClose}>
            {t('business.example.cancel')}
          </Button>
          <Button onClick={handleAddExamples} loading={adding}>
            {adding ? t('business.example.adding') : t('business.example.confirmAdd')}
          </Button>
        </div>
      </Modal>

      {/* 编辑样例对话框 */}
      <Modal
        opened={showEditDialog}
        onClose={() => setShowEditDialog(false)}
        title={t('business.example.editExample')}
        size="80%"
      >
        <div className={styles.editForm}>
          <div className={styles.formItem}>
            <label className={styles.formLabel}>{t('business.example.question')}</label>
            <Textarea
              value={editForm.question}
              onChange={(e) => setEditForm((prev) => ({ ...prev, question: e.currentTarget.value }))}
              autosize
              minRows={3}
              maxRows={3}
              placeholder={t('business.example.inputQuestion')}
            />
          </div>
          <div className={styles.formItem}>
            <label className={styles.formLabel}>{t('business.example.answer')}</label>
            <Textarea
              value={editForm.content}
              onChange={(e) => setEditForm((prev) => ({ ...prev, content: e.currentTarget.value }))}
              autosize
              minRows={26}
              maxRows={26}
              placeholder={t('business.example.inputAnswer')}
            />
          </div>
        </div>
        <div className={styles.dialogFooter} style={{ marginTop: 16 }}>
          <Button variant="default" onClick={() => setShowEditDialog(false)}>
            {t('business.example.cancel')}
          </Button>
          <Button onClick={handleSaveEdit} loading={editing}>
            {editing ? t('business.example.saving') : t('business.example.save')}
          </Button>
        </div>
      </Modal>

      {/* 搜索样例对话框 */}
      <Modal
        opened={showSearchDialog}
        onClose={() => setShowSearchDialog(false)}
        title={t('business.example.searchExample')}
        size="70%"
      >
        <div className={styles.searchDialogContent}>
          <TextInput
            className={styles.searchInput}
            size="lg"
            value={searchQuestion}
            onChange={(e) => setSearchQuestion(e.currentTarget.value)}
            placeholder={t('business.example.searchPlaceholder')}
            onKeyUp={(e) => {
              if (e.key === 'Enter') handleTestSearch()
            }}
            rightSection={
              <span
                className={`${styles.searchIconBtn} ${searching ? styles.searching : ''}`}
                onClick={handleTestSearch}
              >
                {!searching ? <ElSvgIcon name="Search" size={18} /> : <Loader size={18} />}
              </span>
            }
          />

          {/* 搜索结果 */}
          {searchResults.length > 0 ? (
            <div className={styles.searchResultsList}>
              <div className={styles.resultsHeader}>
                <h4>
                  {t('business.example.recallResults')} ({searchResults.length})
                </h4>
              </div>
              <div className={styles.resultsList}>
                {searchResults.map((result, index) => (
                  <div
                    key={index}
                    className={styles.resultItem}
                    onClick={() => handleEditExample(result)}
                  >
                    <div className={styles.resultHeader}>
                      <Badge size="sm" color="green">
                        {t('business.example.similarity')}: {(result.similarity * 100).toFixed(1)}%
                      </Badge>
                    </div>
                    <div className={styles.resultBody}>
                      <div className={styles.resultQuestion}>
                        <span className={styles.label}>{t('business.example.question')}:</span>
                        <span className={styles.content}>{result.question}</span>
                      </div>
                      <div className={styles.resultSql}>
                        <span className={styles.label}>{t('business.example.answer')}:</span>
                        <pre className={styles.content}>{result.content}</pre>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            hasSearched &&
            searchResults.length === 0 && (
              <div className={styles.noResults}>
                <Center>
                  <Text c="dimmed">{t('business.example.noSimilarExamples')}</Text>
                </Center>
              </div>
            )
          )}
        </div>
      </Modal>
    </div>
  )
}
