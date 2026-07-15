// 业务配置总览（源：views/project/settings/components/BusinessOverview.vue）
// 列表视图 + 详情/创建视图（Tabs）。
// TODO(migration): 源用 el-tabs 的 .el-tabs__nav-scroll 自定义触摸滑动（setupBusinessTabSwipe）；
//   React 版改用 ScrollableTabs（Mantine Tabs + ScrollArea，原生横向滚动 + 滚动到中心），行为等价，移除手写 touch 逻辑。
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Card, LoadingOverlay, Tabs, TextInput, Textarea } from '@mantine/core'
import { useForm } from '@mantine/form'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import ElSvgIcon from '@/components/ElSvgIcon'
import ScrollableTabs from '@/components/ScrollableTabs'
import BusinessDataSources from '@/views/business/components/BusinessDataSources'
import MetricManager from '@/views/business/components/MetricManager'
import MetricViewManager from '@/views/business/components/MetricViewManager'
import ExampleManager from '@/views/business/components/ExampleManager'
import MemoryManager from '@/views/business/components/MemoryManager'
import WorkflowList from '@/views/business/components/WorkflowList'
import AgentSettings from '@/views/database/components/AgentSettings'
import PublishConfig from './PublishConfig'
import {
  getBusinessListReq,
  createBusinessReq,
  updateBusinessReq,
  deleteBusinessReq
} from '@/api/business'
import styles from './BusinessOverview.module.scss'

// defineProps
interface BusinessOverviewProps {
  projectId?: string
  /** 从路由传入的初始业务ID */
  initialBusinessId?: string
  /** 从路由传入的初始tab */
  initialTab?: string
  // defineEmits(['navigate-to-datasource', 'route-change']) → 回调 props
  onNavigateToDatasource?: (payload: any) => void
  onRouteChange?: (payload: { businessId: any; tab: any }) => void
}

export default function BusinessOverview({
  projectId = '',
  initialBusinessId = '',
  initialTab = 'datasources',
  onNavigateToDatasource,
  onRouteChange
}: BusinessOverviewProps) {
  const { t } = useTranslation()

  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [businesses, setBusinesses] = useState<any[]>([])

  // 编辑模式
  const [editMode, setEditMode] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [currentBusiness, setCurrentBusiness] = useState<any>(null)
  const [activeTab, setActiveTab] = useState('datasources')

  // 已渲染过的 lazy tab（对应 el-tab-pane lazy：首次激活后才挂载，之后保持）
  const [renderedTabs, setRenderedTabs] = useState<Record<string, boolean>>({})

  // 表单（name 必填，长度 1-100）
  const form = useForm({
    initialValues: {
      name: '',
      description: ''
    },
    validate: {
      name: (value: string) => {
        if (!value) return t('business.rules.nameRequired')
        if (value.length < 1 || value.length > 100) return t('business.rules.nameLength')
        return null
      }
    }
  })

  // 用 ref 持有最新状态，供 effect 内部读取，避免闭包过期
  const editModeRef = useRef(editMode)
  editModeRef.current = editMode
  const isCreatingRef = useRef(isCreating)
  isCreatingRef.current = isCreating
  const currentBusinessRef = useRef(currentBusiness)
  currentBusinessRef.current = currentBusiness
  const businessesRef = useRef(businesses)
  businessesRef.current = businesses
  const formRef = useRef(form)
  formRef.current = form

  // 标记 lazy tab 已激活
  const markTabRendered = (name: string) => {
    setRenderedTabs((prev) => (prev[name] ? prev : { ...prev, [name]: true }))
  }
  useEffect(() => {
    markTabRendered(activeTab)
  }, [activeTab])

  // 加载业务列表
  const loadBusinesses = async () => {
    if (!projectId) return

    setLoading(true)
    try {
      const res: any = await getBusinessListReq(projectId)
      // API 返回分页对象 {items: [...], total, page, ...}
      setBusinesses(res.data?.items || [])
    } catch (err) {
      console.error('加载业务列表失败:', err)
      notifications.show({ color: 'red', message: t('business.overview.loadFailed') })
    } finally {
      setLoading(false)
    }
  }

  // 创建业务
  const handleCreate = () => {
    setIsCreating(true)
    setCurrentBusiness(null)
    form.setValues({ name: '', description: '' })
    setEditMode(true)
  }

  // 编辑业务
  const handleEdit = (business: any, tab = 'datasources') => {
    setIsCreating(false)
    setCurrentBusiness(business)
    form.setValues({ name: business.name || '', description: business.description || '' })
    setActiveTab(tab)
    setEditMode(true)
    // 通知父组件更新路由
    onRouteChange?.({ businessId: business.id, tab })
  }

  // 返回列表
  const handleBack = () => {
    setEditMode(false)
    setCurrentBusiness(null)
    setIsCreating(false)
    // 通知父组件更新路由（返回业务列表）
    onRouteChange?.({ businessId: null, tab: null })
  }

  // 保存业务
  const handleSave = async () => {
    const validation = form.validate()
    if (validation.hasErrors) return

    setSaving(true)
    try {
      const data = {
        name: form.values.name.trim(),
        description: form.values.description?.trim() || ''
      }

      if (isCreating) {
        const res: any = await createBusinessReq(projectId, data)
        notifications.show({ color: 'green', message: t('business.overview.createSuccessMsg') })
        // 创建成功后进入编辑模式
        setCurrentBusiness(res.data)
        setIsCreating(false)
        setActiveTab('datasources')
        // 更新路由到新创建的业务
        onRouteChange?.({ businessId: res.data.id, tab: 'datasources' })
      } else {
        await updateBusinessReq(projectId, currentBusiness.id, data)
        notifications.show({ color: 'green', message: t('business.overview.saveSuccessMsg') })
        // 更新当前业务数据
        setCurrentBusiness({ ...currentBusiness, ...data })
      }

      await loadBusinesses()
    } catch (err: any) {
      console.error('保存失败:', err)
      notifications.show({
        color: 'red',
        message: err?.msg || t('business.overview.saveFailed')
      })
    } finally {
      setSaving(false)
    }
  }

  // 删除业务（从列表）
  const handleDelete = (business: any) => {
    // ElMessageBox.confirm → modals.openConfirmModal
    modals.openConfirmModal({
      title: t('business.overview.deleteConfirmTitle'),
      children: t('business.overview.deleteConfirmMsg', { name: business.name }),
      labels: { confirm: t('common.confirm'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await deleteBusinessReq(projectId, business.id)
          notifications.show({ color: 'green', message: t('business.message.deleteSuccess') })
          await loadBusinesses()
        } catch (err: any) {
          console.error('删除失败:', err)
          // 检查是否已经有错误消息（axios拦截器已经显示），如果有就不显示通用错误
          const errorMessage =
            err?.response?.data?.message || err?.response?.data?.msg || err?.message || err?.msg
          if (!errorMessage) {
            notifications.show({ color: 'red', message: t('business.overview.deleteFailed') })
          }
        }
      }
    })
  }

  // 删除当前业务（从详情页）
  const handleDeleteCurrent = () => {
    if (!currentBusiness) return

    // ElMessageBox.confirm → modals.openConfirmModal
    modals.openConfirmModal({
      title: t('business.overview.deleteConfirmTitle'),
      children: t('business.overview.deleteConfirmCurrentMsg', { name: currentBusiness.name }),
      labels: {
        confirm: t('business.overview.deleteConfirmBtn'),
        cancel: t('business.dataSources.cancel')
      },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await deleteBusinessReq(projectId, currentBusiness.id)
          notifications.show({ color: 'green', message: t('business.message.deleteSuccess') })
          handleBack()
          await loadBusinesses()
        } catch (err: any) {
          console.error('删除失败:', err)
          // 检查是否已经有错误消息（axios拦截器已经显示），如果有就不显示通用错误
          const errorMessage =
            err?.response?.data?.message || err?.response?.data?.msg || err?.message || err?.msg
          if (!errorMessage) {
            notifications.show({ color: 'red', message: t('business.overview.deleteFailed') })
          }
        }
      }
    })
  }

  // 跳转到数据源详情
  const handleNavigateToDataSource = (payload: any) => {
    onNavigateToDatasource?.(payload)
  }

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

  // 监听 projectId 变化（watch immediate）
  useEffect(() => {
    if (projectId) {
      loadBusinesses()
      // 切换项目时退出编辑模式
      setEditMode(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // 监听 activeTab 变化，更新路由
  useEffect(() => {
    // 仅在编辑模式且非创建模式时更新路由
    if (editModeRef.current && !isCreatingRef.current && currentBusinessRef.current) {
      onRouteChange?.({ businessId: currentBusinessRef.current.id, tab: activeTab })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab])

  // 监听业务列表加载完成，根据路由参数自动选择业务（watch businesses, immediate）
  useEffect(() => {
    if (businesses.length > 0 && initialBusinessId && !editModeRef.current) {
      const targetBusiness = businesses.find((b) => b.id === initialBusinessId)
      if (targetBusiness) {
        // 不触发 route-change，因为已经在正确的路由上
        setIsCreating(false)
        setCurrentBusiness(targetBusiness)
        form.setValues({
          name: targetBusiness.name || '',
          description: targetBusiness.description || ''
        })
        setActiveTab(initialTab || 'datasources')
        setEditMode(true)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businesses])

  // 监听路由参数变化（浏览器前进/后退）：initialBusinessId
  useEffect(() => {
    if (!initialBusinessId && editModeRef.current && !isCreatingRef.current) {
      // 路由变为业务列表，退出编辑模式
      setEditMode(false)
      setCurrentBusiness(null)
    } else if (initialBusinessId && businessesRef.current.length > 0) {
      // 路由变为某个业务，进入编辑模式
      const targetBusiness = businessesRef.current.find((b) => b.id === initialBusinessId)
      if (targetBusiness && currentBusinessRef.current?.id !== initialBusinessId) {
        setIsCreating(false)
        setCurrentBusiness(targetBusiness)
        form.setValues({
          name: targetBusiness.name || '',
          description: targetBusiness.description || ''
        })
        setActiveTab(initialTab || 'datasources')
        setEditMode(true)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialBusinessId])

  // 监听路由 tab 参数变化
  useEffect(() => {
    if (initialTab && editModeRef.current && !isCreatingRef.current) {
      setActiveTab(initialTab)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTab])

  // 业务列表数量提示
  const hasBusinesses = businesses.length > 0

  // 详情页标题
  const detailTitle = useMemo(() => {
    return isCreating ? t('business.overview.create') : currentBusiness?.name
  }, [isCreating, currentBusiness, t])

  // tab label 渲染辅助
  const renderTabLabel = (icon: string, label: string) => (
    <span className={styles.tabLabel}>
      <ElSvgIcon name={icon} size={16} />
      <span>{label}</span>
    </span>
  )

  return (
    <div className="ad-page-list">
      {/* 列表视图 */}
      {!editMode ? (
        <>
          <div className="ad-page-toolbar">
            {hasBusinesses && (
              <span className="toolbar-count">
                {t('business.overview.count', { count: businesses.length })}
              </span>
            )}
            {hasBusinesses && (
              <div className="toolbar-actions">
                <Button color="primary" onClick={handleCreate} leftSection={<ElSvgIcon name="Plus" size={16} />}>
                  {t('business.overview.create')}
                </Button>
              </div>
            )}
          </div>

          <div className="ad-page-content ad-card-grid" style={{ position: 'relative' }}>
            <LoadingOverlay visible={loading} />

            {/* 业务卡片 */}
            {businesses.map((business) => (
              <div key={business.id} className="ad-grid-card">
                <div className="grid-card-header">
                  <div className="grid-card-title">
                    <span className={styles.iconBusiness}>
                      <ElSvgIcon name="Briefcase" size={18} color="#17483e" />
                    </span>
                    <span>{business.name}</span>
                  </div>
                  <div className="grid-card-actions" onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="subtle"
                      color="primary"
                      size="compact-sm"
                      onClick={() => handleEdit(business)}
                      leftSection={<ElSvgIcon name="Edit" size={14} />}
                    >
                      {t('business.edit')}
                    </Button>
                    <Button
                      variant="subtle"
                      color="red"
                      size="compact-sm"
                      onClick={() => handleDelete(business)}
                      leftSection={<ElSvgIcon name="Delete" size={14} />}
                    >
                      {t('business.example.delete')}
                    </Button>
                  </div>
                </div>

                <div className="grid-card-body">
                  {business.description ? (
                    <div className={styles.gridCardDesc}>{business.description}</div>
                  ) : (
                    <div className={`${styles.gridCardDesc} ${styles.textMuted}`}>
                      {t('business.noDescription')}
                    </div>
                  )}

                  {/* 数据源统计 */}
                  <div className="grid-card-info">
                    {business.data_source_count > 0 ? (
                      <Badge size="sm" color="primary">
                        {t('business.overview.dataSourceCount', { count: business.data_source_count })}
                      </Badge>
                    ) : (
                      <span className={styles.textMuted}>{t('business.overview.noDataSource')}</span>
                    )}
                  </div>
                </div>

                <div className="grid-card-footer">
                  {t('business.overview.createdAt', { date: formatDate(business.created_at) })}
                </div>
              </div>
            ))}

            {/* 空状态 */}
            {!loading && businesses.length === 0 && (
              <div className={`ad-page-empty ${styles.businessEmpty}`}>
                <div className={styles.emptyIllustration}>
                  <div className={styles.illustrationContainer}>
                    <div className={`${styles.dataSource} ${styles.db}`}>
                      <ElSvgIcon name="Coin" size={20} />
                    </div>
                    <div className={`${styles.dataSource} ${styles.doc}`}>
                      <ElSvgIcon name="Document" size={20} />
                    </div>
                    <div className={`${styles.dataSource} ${styles.file}`}>
                      <ElSvgIcon name="Folder" size={20} />
                    </div>
                    <div className={styles.centerHub}>
                      <ElSvgIcon name="Briefcase" size={24} color="#fff" />
                    </div>
                    <svg className={styles.connectionLines} viewBox="0 0 200 120">
                      <path d="M40 30 Q100 30 100 60" stroke="#dce8e2" strokeWidth="2" fill="none" strokeDasharray="4,4" />
                      <path d="M160 30 Q100 30 100 60" stroke="#dce8e2" strokeWidth="2" fill="none" strokeDasharray="4,4" />
                      <path
                        d="M100 100 Q100 80 100 60"
                        stroke="#dce8e2"
                        strokeWidth="2"
                        fill="none"
                        strokeDasharray="4,4"
                      />
                    </svg>
                  </div>
                </div>
                <div className={styles.emptyContent}>
                  <h3 className={styles.emptyTitle}>{t('business.overview.createFirst')}</h3>
                  <p className={styles.emptyDesc}>{t('business.overview.emptyDesc')}</p>
                  <div className={styles.emptyFeatures}>
                    <div className={styles.featureItem}>
                      <ElSvgIcon name="Connection" size={16} color="#17483e" />
                      <span>{t('business.overview.feature1')}</span>
                    </div>
                    <div className={styles.featureItem}>
                      <ElSvgIcon name="ChatLineSquare" size={16} color="#17483e" />
                      <span>{t('business.overview.feature2')}</span>
                    </div>
                    <div className={styles.featureItem}>
                      <ElSvgIcon name="DataAnalysis" size={16} color="#17483e" />
                      <span>{t('business.overview.feature3')}</span>
                    </div>
                  </div>
                  <Button
                    color="primary"
                    size="lg"
                    onClick={handleCreate}
                    leftSection={<ElSvgIcon name="Plus" size={18} />}
                  >
                    {t('business.overview.create')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </>
      ) : (
        /* 详情视图 */
        <div className={styles.detailView}>
          {/* 顶部：返回 + 标题 */}
          <div className={styles.detailHeader}>
            <Button variant="subtle" color="gray" onClick={handleBack} px={6}>
              <ElSvgIcon name="ArrowLeft" size={18} />
            </Button>
            <span className={styles.headerTitle}>{detailTitle}</span>
          </div>

          {isCreating ? (
            /* 创建模式：直接显示表单 */
            <div className={styles.createContent}>
              <div className={styles.createFormCard}>
                <div className={styles.formIcon}>
                  <div className={styles.iconCircle}>
                    <ElSvgIcon name="Briefcase" size={30} color="#fff" />
                  </div>
                </div>
                <div className={styles.formHeader}>
                  <h3>{t('business.overview.createNew')}</h3>
                  <p>{t('business.overview.createSubtitle')}</p>
                </div>
                <form
                  className="business-form"
                  onSubmit={(e) => {
                    e.preventDefault()
                    handleSave()
                  }}
                >
                  <TextInput
                    label={t('business.form.name')}
                    placeholder={t('business.overview.namePlaceholder')}
                    maxLength={100}
                    mb="md"
                    {...form.getInputProps('name')}
                  />

                  <Textarea
                    label={t('business.form.description')}
                    placeholder={t('business.overview.descPlaceholder')}
                    rows={3}
                    maxLength={500}
                    mb="md"
                    {...form.getInputProps('description')}
                  />

                  <div className={styles.formActions}>
                    <Button
                      type="submit"
                      color="primary"
                      loading={saving}
                      size="lg"
                      leftSection={<ElSvgIcon name="Plus" size={16} />}
                    >
                      {t('business.overview.create')}
                    </Button>
                    <Button variant="default" size="lg" onClick={handleBack}>
                      {t('business.overview.cancel')}
                    </Button>
                  </div>
                </form>
              </div>
            </div>
          ) : (
            /* 编辑模式：Tabs 布局 */
            <div className={styles.detailContent}>
              {/* ScrollableTabs 自身渲染 Tabs 根节点；这里仅放 Tabs.List，
                  Tab 内容用 activeTab 条件渲染在 ScrollableTabs 之外（对齐 models/index.tsx 模式），
                  并配合 renderedTabs 实现 el-tab-pane lazy 语义 */}
              <ScrollableTabs
                modelValue={activeTab}
                type=""
                tabsClass={`${styles.businessTabs} ad-tabs-transparent`}
                onUpdateModelValue={(v) => setActiveTab(v)}
              >
                <Tabs.List>
                  <Tabs.Tab value="datasources">
                    {renderTabLabel('Connection', t('business.overview.tabDataSources'))}
                  </Tabs.Tab>
                  <Tabs.Tab value="metrics">
                    {renderTabLabel('TrendCharts', t('business.tabs.metrics'))}
                  </Tabs.Tab>
                  <Tabs.Tab value="metric-views">
                    {renderTabLabel('Grid', t('business.overview.tabMetricViews'))}
                  </Tabs.Tab>
                  <Tabs.Tab value="examples">
                    {renderTabLabel('Files', t('business.tabs.examples'))}
                  </Tabs.Tab>
                  <Tabs.Tab value="memory">
                    {renderTabLabel('Clock', t('business.overview.tabMemory', '记忆管理'))}
                  </Tabs.Tab>
                  <Tabs.Tab value="workflows">
                    {renderTabLabel('Connection', t('business.overview.tabWorkflows', '工作流'))}
                  </Tabs.Tab>
                  <Tabs.Tab value="agents">
                    {renderTabLabel('Tools', t('business.overview.tabAgents'))}
                  </Tabs.Tab>
                  <Tabs.Tab value="publish">
                    {renderTabLabel('Share', t('business.overview.tabPublish'))}
                  </Tabs.Tab>
                  <Tabs.Tab value="settings">
                    {renderTabLabel('Setting', t('business.overview.tabSettings'))}
                  </Tabs.Tab>
                </Tabs.List>
              </ScrollableTabs>

              {/* Tab 内容区 */}
              <div className="ad-detail-tab-content" style={{ flex: 1, minHeight: 0, minWidth: 0, overflowX: 'hidden', overflowY: 'auto', padding: '0 5px 10px' }}>
                {/* 数据源管理 */}
                <div style={{ display: activeTab === 'datasources' ? undefined : 'none', height: '100%' }}>
                  <BusinessDataSources
                    projectId={projectId}
                    businessId={currentBusiness?.id}
                    onUpdated={loadBusinesses}
                    onNavigateToDatasource={handleNavigateToDataSource}
                  />
                </div>

                {/* 业务指标（lazy） */}
                {renderedTabs['metrics'] && currentBusiness?.id && (
                  <div style={{ display: activeTab === 'metrics' ? undefined : 'none', height: '100%' }}>
                    <MetricManager projectId={projectId} businessId={currentBusiness.id} />
                  </div>
                )}

                {/* 业务视图（lazy） */}
                {renderedTabs['metric-views'] && currentBusiness?.id && (
                  <div style={{ display: activeTab === 'metric-views' ? undefined : 'none', height: '100%' }}>
                    <MetricViewManager projectId={projectId} businessId={currentBusiness.id} />
                  </div>
                )}

                {/* 样例数据（lazy） */}
                {renderedTabs['examples'] && currentBusiness?.id && (
                  <div style={{ display: activeTab === 'examples' ? undefined : 'none', height: '100%' }}>
                    <ExampleManager projectId={projectId} businessId={currentBusiness.id} />
                  </div>
                )}

                {/* 记忆管理（消歧偏好记忆）（lazy） */}
                {renderedTabs['memory'] && currentBusiness?.id && (
                  <div style={{ display: activeTab === 'memory' ? undefined : 'none', height: '100%' }}>
                    <MemoryManager projectId={projectId} businessId={currentBusiness.id} />
                  </div>
                )}

                {/* 工作流（lazy） */}
                {renderedTabs['workflows'] && currentBusiness?.id && (
                  <div style={{ display: activeTab === 'workflows' ? undefined : 'none', height: '100%' }}>
                    <WorkflowList
                      projectId={projectId}
                      businessId={currentBusiness.id}
                      businessName={currentBusiness?.name || ''}
                    />
                  </div>
                )}

                {/* Agent配置（lazy） */}
                {renderedTabs['agents'] && currentBusiness?.id && (
                  <div style={{ display: activeTab === 'agents' ? undefined : 'none', height: '100%' }}>
                    <AgentSettings projectId={projectId} businessId={currentBusiness.id} />
                  </div>
                )}

                {/* 发布配置（lazy） */}
                {renderedTabs['publish'] && currentBusiness?.id && (
                  <div style={{ display: activeTab === 'publish' ? undefined : 'none', height: '100%' }}>
                    <PublishConfig projectId={projectId} businessId={currentBusiness.id} />
                  </div>
                )}

                {/* 业务设置 */}
                <div style={{ display: activeTab === 'settings' ? undefined : 'none', height: '100%' }}>
                  <div className={styles.settingsContent}>
                    {/* 基本信息卡片 */}
                    <Card shadow="none" withBorder className={styles.settingsCard} padding={0}>
                      <div className={styles.cardHeader}>
                        <span>{t('business.overview.basicInfo')}</span>
                      </div>
                      <div className={styles.cardBody}>
                        <form
                          className="business-form"
                          onSubmit={(e) => {
                            e.preventDefault()
                            handleSave()
                          }}
                        >
                          <TextInput
                            label={t('business.form.name')}
                            placeholder={t('business.form.namePlaceholder')}
                            maxLength={100}
                            mb="md"
                            {...form.getInputProps('name')}
                          />

                          <Textarea
                            label={t('business.form.description')}
                            placeholder={t('business.form.descriptionPlaceholder')}
                            rows={4}
                            maxLength={500}
                            mb="md"
                            {...form.getInputProps('description')}
                          />

                          <Button type="submit" color="primary" loading={saving}>
                            {t('business.overview.saveChanges')}
                          </Button>
                        </form>
                      </div>
                    </Card>

                    {/* 危险操作卡片 */}
                    <Card
                      shadow="none"
                      withBorder
                      className={`${styles.settingsCard} ${styles.dangerCard}`}
                      padding={0}
                    >
                      <div className={styles.cardHeader}>
                        <span>{t('business.overview.dangerZone')}</span>
                      </div>
                      <div className={styles.cardBody}>
                        <div className={styles.dangerZoneContent}>
                          <div className={styles.dangerInfo}>
                            <div className={styles.dangerTitle}>
                              {t('business.overview.deleteThisBusiness')}
                            </div>
                            <div className={styles.dangerDesc}>
                              {t('business.overview.deleteDangerDesc')}
                            </div>
                          </div>
                          <Button variant="outline" color="red" onClick={handleDeleteCurrent}>
                            {t('business.overview.deleteBusiness')}
                          </Button>
                        </div>
                      </div>
                    </Card>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
