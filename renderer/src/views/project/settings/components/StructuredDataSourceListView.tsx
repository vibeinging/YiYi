import { useEffect, useRef, useState } from 'react'
import { Badge, Button, LoadingOverlay, Select, Textarea, TextInput } from '@mantine/core'
import { useForm } from '@mantine/form'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import { useTranslation } from 'react-i18next'
import ElSvgIcon from '@/components/ElSvgIcon'
import {
  listDataSourcesReq,
  createDataSourceReq,
  deleteDataSourceReq
} from '@/api/structured_data_source'
import { embeddingModelsReq } from '@/api/models'
import StructuredDataSourceDetail from './StructuredDataSourceDetail'
import styles from './StructuredDataSourceListView.module.scss'

interface StructuredDataSourceListViewProps {
  projectId?: string
  initialSelectedItem?: any
  initialItemId?: string
  // defineEmits(['item-selected', 'selection-change']) → 回调 props
  onItemSelected?: () => void
  onSelectionChange?: (id: string | null) => void
}

export default function StructuredDataSourceListView({
  projectId = '',
  initialSelectedItem = null,
  initialItemId = '',
  onItemSelected,
  onSelectionChange
}: StructuredDataSourceListViewProps) {
  const { t } = useTranslation()

  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [dataList, setDataList] = useState<any[]>([])
  const [selectedItem, setSelectedItem] = useState<any>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [embeddingModelList, setEmbeddingModelList] = useState<any[]>([])

  // dataList 最新值用 ref 暴露给异步闭包(loadList 后立即查找)
  const dataListRef = useRef<any[]>([])
  dataListRef.current = dataList

  // 格式化日期
  const formatDate = (dateStr: any) => {
    if (!dateStr) return '-'
    const date = new Date(dateStr)
    return date.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    })
  }

  // 表单 + 校验规则
  const form = useForm({
    initialValues: {
      name: '',
      description: '',
      embedding_model_name: ''
    },
    validate: {
      name: (value: string) => {
        if (!value) return t('project.dataSource.rules.nameRequired')
        if (value.length < 2 || value.length > 50) return t('project.dataSource.rules.nameLength')
        return null
      },
      embedding_model_name: (value: string) =>
        !value ? t('project.dataSource.rules.embeddingRequired') : null
    }
  })

  // 加载列表
  const loadList = async (autoSelectId: any = null) => {
    if (!projectId) return

    setLoading(true)
    try {
      const res: any = await listDataSourcesReq(projectId)
      const data = res?.data
      const items = (Array.isArray(data) ? data : data?.items || []).map((item: any) => ({
        ...item,
        embedding_model_name:
          item?.embedding_model_name ||
          item?.embedding_model?.display_name ||
          item?.embedding_model?.name ||
          ''
      }))
      setDataList(items)
      dataListRef.current = items

      if (autoSelectId) {
        const found = items.find((item: any) => item.id === autoSelectId)
        if (found) {
          setSelectedItem(found)
        }
      }
    } catch (err) {
      console.error('Load list failed:', err)
      notifications.show({ color: 'red', message: t('project.dataSource.loadListFailed') })
    } finally {
      setLoading(false)
    }
  }

  // 加载向量模型
  const loadEmbeddingModels = async () => {
    try {
      const res: any = await embeddingModelsReq()
      const payload = res?.data
      const list = Array.isArray(payload) ? payload : payload?.items || payload?.data || []
      const models = Array.isArray(list) ? list : []
      setEmbeddingModelList(models)

      // 单槽下向量模型唯一，取第一个
      const defaultModel = models[0]
      if (defaultModel && !form.values.embedding_model_name) {
        form.setFieldValue('embedding_model_name', defaultModel.name || defaultModel.model_name)
      }
    } catch (error) {
      console.error('获取嵌入模型失败:', error)
    }
  }

  // 格式化模型标签
  const formatModelLabel = (m: any) => {
    const name = m.name || m.model_name || '-'
    const dim = m.dimension || '-'
    return `${name} / ${dim} ${t('project.dataSource.dimensions')}`
  }

  // 选择项目
  const selectItem = (item: any) => {
    setSelectedItem(item)
    onSelectionChange?.(item?.id || null)
  }

  // 返回列表
  const backToList = () => {
    setSelectedItem(null)
    onSelectionChange?.(null)
    loadList()
  }

  // 开始创建
  const startCreate = () => {
    setIsCreating(true)
    form.setFieldValue('name', '')
    form.setFieldValue('description', '')
    loadEmbeddingModels()
  }

  // 取消创建
  const cancelCreate = () => {
    setIsCreating(false)
    form.reset()
  }

  // 创建
  const handleCreate = async () => {
    const validation = form.validate()
    if (validation.hasErrors) return

    setSubmitting(true)
    try {
      const res: any = await createDataSourceReq(
        projectId,
        form.values.name,
        form.values.description,
        form.values.embedding_model_name
      )
      if (res?.success) {
        notifications.show({ color: 'green', message: t('project.dataSource.createSuccess') })
        setIsCreating(false)
        await loadList()

        const newItem = dataListRef.current.find((ds: any) => ds.id === res.data?.id)
        if (newItem) {
          setSelectedItem(newItem)
        }

        form.reset()
      } else {
        notifications.show({
          color: 'red',
          message: res?.message || t('project.dataSource.createFailed')
        })
      }
    } catch (error) {
      console.error('Create failed:', error)
      notifications.show({ color: 'red', message: t('project.dataSource.createFailed') })
    } finally {
      setSubmitting(false)
    }
  }

  // 删除
  const handleDelete = (item: any) => {
    modals.openConfirmModal({
      title: t('project.database.deleteConfirm'),
      children: t('project.database.deleteConfirmMsg', { name: item.name }),
      labels: { confirm: t('common.confirm'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await deleteDataSourceReq(projectId, item.id)
          notifications.show({ color: 'green', message: t('project.database.deleteSuccess') })
          await loadList()
        } catch (err: any) {
          console.error('删除失败:', err)
          // 只有当错误没有消息时才显示通用错误
          const errorMessage =
            err?.response?.data?.message || err?.response?.data?.msg || err?.message || err?.msg
          if (!errorMessage) {
            notifications.show({ color: 'red', message: t('project.database.deleteFailed') })
          }
        }
      }
    })
  }

  // 更新
  const handleItemUpdated = async (updatedItem: any) => {
    await loadList()
    const found = dataListRef.current.find((item: any) => item.id === updatedItem.id)
    if (found) {
      setSelectedItem(found)
    }
  }

  // 删除后
  const handleItemDeleted = async () => {
    setSelectedItem(null)
    onSelectionChange?.(null)
    await loadList()
  }

  // 监听 projectId 变化（含首次加载，对应原 watch immediate）
  const prevProjectIdRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const newId = projectId
    const oldId = prevProjectIdRef.current
    prevProjectIdRef.current = newId
    if (newId) {
      const autoSelectId = !oldId && initialItemId ? initialItemId : null
      if (!autoSelectId) {
        setSelectedItem(null)
      }
      loadList(autoSelectId)
      setIsCreating(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // 监听 initialSelectedItem 变化（从业务配置跳转过来）
  useEffect(() => {
    if (initialSelectedItem) {
      setSelectedItem(initialSelectedItem)
      onItemSelected?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSelectedItem])

  return (
    <div className="ad-page-list">
      {/* 列表视图 */}
      {!selectedItem && !isCreating ? (
        <>
          {dataList.length > 0 && (
            <div className="ad-page-toolbar">
              <span className="toolbar-count">
                {t('project.dataSource.totalCount', { count: dataList.length })}
              </span>
              <div className="toolbar-actions">
                <Button onClick={startCreate} leftSection={<ElSvgIcon name="Plus" size={16} />}>
                  {t('project.dataSource.createDataSource')}
                </Button>
              </div>
            </div>
          )}

          <div className="ad-page-content ad-card-grid" style={{ position: 'relative' }}>
            <LoadingOverlay visible={loading} />
            {dataList.map((item) => (
              <div key={item.id} className="ad-grid-card" onClick={() => selectItem(item)}>
                <div className="grid-card-header">
                  <div className="grid-card-title">
                    <ElSvgIcon name="Grid" size={18} color="#10b981" />
                    <span>{item.name}</span>
                  </div>
                  <div className="grid-card-actions" onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="subtle"
                      size="compact-sm"
                      onClick={() => selectItem(item)}
                      leftSection={<ElSvgIcon name="Edit" size={14} />}
                    >
                      {t('common.manage')}
                    </Button>
                    <Button
                      variant="subtle"
                      color="red"
                      size="compact-sm"
                      onClick={() => handleDelete(item)}
                      leftSection={<ElSvgIcon name="Delete" size={14} />}
                    >
                      {t('common.delete')}
                    </Button>
                  </div>
                </div>
                <div className="grid-card-body">
                  {item.embedding_model_name && (
                    <div className="grid-card-info">
                      <Badge size="sm" color="gray">
                        {item.embedding_model_name}
                      </Badge>
                    </div>
                  )}
                  {item.description ? (
                    <div className="grid-card-desc">{item.description}</div>
                  ) : (
                    <div className={`grid-card-desc ${styles.textMuted}`}>
                      {t('project.dataSource.noDescription')}
                    </div>
                  )}
                </div>
                <div className="grid-card-footer">
                  {t('project.database.createdAt', { date: formatDate(item.created_at) })}
                </div>
              </div>
            ))}

            {/* 空状态 */}
            {!loading && dataList.length === 0 && (
              <div className={`ad-page-empty ${styles.structuredEmpty}`}>
                <div className={styles.emptyIllustration}>
                  <div className={styles.illustrationContainer}>
                    <div className={`${styles.fileIcon} ${styles.xlsx}`}>
                      <ElSvgIcon name="Grid" size={22} />
                    </div>
                    <div className={`${styles.fileIcon} ${styles.csv}`}>
                      <ElSvgIcon name="Document" size={22} />
                    </div>
                    <div className={styles.centerHub}>
                      <ElSvgIcon name="FolderOpened" size={26} color="#fff" />
                    </div>
                  </div>
                </div>
                <div className={styles.emptyContent}>
                  <h3 className={styles.emptyTitle}>
                    {t('project.structured.createFirstData')}
                  </h3>
                  <p className={styles.emptyDesc}>{t('project.structured.emptyDescription')}</p>
                  <div className={styles.emptyFeatures}>
                    <div className={styles.featureItem}>
                      <ElSvgIcon name="Upload" size={16} color="#10b981" />
                      <span>{t('project.structured.featureFileSupport')}</span>
                    </div>
                    <div className={styles.featureItem}>
                      <ElSvgIcon name="Search" size={16} color="#10b981" />
                      <span>{t('project.structured.featureSemanticSearch')}</span>
                    </div>
                    <div className={styles.featureItem}>
                      <ElSvgIcon name="DataAnalysis" size={16} color="#10b981" />
                      <span>{t('project.structured.featureDataVisualization')}</span>
                    </div>
                  </div>
                  <Button
                    size="lg"
                    onClick={startCreate}
                    leftSection={<ElSvgIcon name="Plus" size={18} />}
                  >
                    {t('project.structured.createData')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </>
      ) : isCreating ? (
        /* 创建视图 */
        <div className={styles.createContent}>
          <div className={styles.createFormCard}>
            <div className={styles.formIcon}>
              <div className={styles.iconCircle}>
                <ElSvgIcon name="Grid" size={30} color="#fff" />
              </div>
            </div>
            <div className={styles.formHeader}>
              <h3>{t('project.structured.createData')}</h3>
              <p>{t('project.structured.createDataDesc')}</p>
            </div>
            <form
              className={styles.businessForm}
              onSubmit={form.onSubmit(() => handleCreate())}
            >
              <TextInput
                label={t('project.dataSource.name')}
                placeholder={t('project.dataSource.namePlaceholder')}
                size="lg"
                mb="md"
                {...form.getInputProps('name')}
              />

              <Textarea
                label={t('project.dataSource.descriptionLabel')}
                placeholder={t('project.dataSource.descriptionPlaceholder')}
                rows={3}
                mb="md"
                {...form.getInputProps('description')}
              />

              <Select
                label={t('project.dataSource.embeddingModel')}
                placeholder={t('project.dataSource.selectEmbeddingModel')}
                size="lg"
                mb="md"
                style={{ width: '100%' }}
                data={embeddingModelList.map((m) => ({
                  value: m.name || m.model_name,
                  label: formatModelLabel(m)
                }))}
                {...form.getInputProps('embedding_model_name')}
              />

              <div className={styles.formActions}>
                <Button type="submit" loading={submitting} size="lg" leftSection={<ElSvgIcon name="Plus" size={16} />}>
                  {t('project.structured.createData')}
                </Button>
                <Button variant="default" type="button" size="lg" onClick={cancelCreate}>
                  {t('common.cancel')}
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : (
        /* 详情视图 */
        <StructuredDataSourceDetail
          dataSource={selectedItem}
          onBack={backToList}
          onUpdated={handleItemUpdated}
          onDeleted={handleItemDeleted}
        />
      )}
    </div>
  )
}
