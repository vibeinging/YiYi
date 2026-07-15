// App 内项目设置页。只能由 /agent 工作区嵌入打开。
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'
import { Center, Text } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { SettingsShell, SettingsNavItem, SettingsNavGroup } from '@/views/agent/SettingsShell'
import { useProjectStore } from '@/store/project'
import { getProjectDetailReq } from '@/api/project'
import { permissionManager } from '@/permission/index'

import BasicInfo from './components/BasicInfo'

import styles from './index.module.scss'

const MemberManagement = lazy(() => import('./components/MemberManagement'))
const ModelConfig = lazy(() => import('./components/ModelConfig'))
const DatabaseListView = lazy(() => import('./components/DatabaseListView'))
const StructuredDataSourceListView = lazy(() => import('./components/StructuredDataSourceListView'))
const UnstructuredDataSourceListView = lazy(() => import('./components/UnstructuredDataSourceListView'))
const WebSearchDataSourceListView = lazy(() => import('./components/WebSearchDataSourceListView'))
const McpProviderListView = lazy(() => import('./components/McpProviderListView'))
const UnifiedReportSettings = lazy(() => import('./components/UnifiedReportSettings'))
const TraceOptimizationSettings = lazy(() => import('./components/TraceOptimizationSettings'))
const SkillManagement = lazy(() => import('@/views/skills/index'))
const MetricManager = lazy(() => import('@/views/business/components/MetricManager'))
const MetricViewManager = lazy(() => import('@/views/business/components/MetricViewManager'))
const EntityManager = lazy(() => import('@/views/business/components/EntityManager'))
const ExampleManager = lazy(() => import('@/views/business/components/ExampleManager'))
const MemoryManager = lazy(() => import('@/views/business/components/MemoryManager'))
const AgentSettings = lazy(() => import('@/views/database/components/AgentSettings'))

const traceOptimizationTabs = {
  'trace-optimization': {
    tab: 'build'
  }
} as const

type TraceOptimizationTabName = keyof typeof traceOptimizationTabs
const traceOptimizationTabNames = Object.keys(traceOptimizationTabs) as TraceOptimizationTabName[]

const normalizeTraceOptimizationTab = (tabName: string) => {
  if (['trace-case-build', 'trace-case-run', 'trace-reviews', 'trace-drafts', 'trace-benchmark'].includes(tabName)) return 'trace-optimization'
  return tabName
}

// 有效的 tab 名称列表
const validTabs = [
  'basic',
  'members',
  'models',
  'skills',
  'database',
  'structured',
  'unstructured',
  'websearch',
  'metrics',
  'metric-views',
  'entities',
  'examples',
  'memory',
  'workflows',
  'agents',
  'trace-optimization',
  'reportTemplates',
  'mcp'
]

// Tab 权限映射（某些 tab 可能需要特定权限）
const tabPermissions: Record<string, string> = {
  members: 'member_manage',
  models: 'model_service_manage',
  skills: 'data_manage',
  metrics: 'data_manage',
  'metric-views': 'data_manage',
  entities: 'data_manage',
  examples: 'data_manage',
  memory: 'data_manage',
  workflows: 'data_manage',
  agents: 'data_manage',
  'trace-optimization': 'data_manage',
  reportTemplates: 'report_manage',
  database: 'data_manage',
  structured: 'data_manage',
  unstructured: 'data_manage',
  websearch: 'model_service_manage',
  mcp: 'model_service_manage'
}

// 各 tab 单独刷新 key 的初始结构
const initialTabRefreshKeys = (): Record<string, number> => ({
  basic: 0,
  members: 0,
  models: 0,
  skills: 0,
  database: 0,
  structured: 0,
  unstructured: 0,
  websearch: 0,
  mcp: 0,
  metrics: 0,
  'metric-views': 0,
  entities: 0,
  examples: 0,
  memory: 0,
  workflows: 0,
  agents: 0,
  'trace-optimization': 0,
  reportTemplates: 0
})

export default function ProjectSettings({
  hiddenTabs = [],
  onBack
}: { hiddenTabs?: string[]; onBack: () => void }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()

  // 当前项目（zustand selector，对齐 projectStore.currentProject）
  const currentProject = useProjectStore((s) => s.currentProject)
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject)
  const hasProject = !!currentProject?.id
  const tabLoading = (
    <Center style={{ minHeight: 160 }}>
      <Text c="dimmed">加载中...</Text>
    </Center>
  )

  // 从 URL hash 解析子级 ID（格式: #tabName:itemId）
  const hashItemId = useMemo(() => {
    const hash = location.hash?.replace('#', '') || ''
    const colonIndex = hash.indexOf(':')
    return colonIndex > -1 ? hash.slice(colonIndex + 1) : ''
  }, [location.hash])

  // 按 tab 名称获取对应的子级 ID
  const routeItemId = useCallback(
    (tabName: string) => {
      const hash = location.hash?.replace('#', '') || ''
      return hash.startsWith(`${tabName}:`) ? hashItemId : ''
    },
    [location.hash, hashItemId]
  )

  // 从 URL hash 获取初始 tab（支持 #database:id 格式）
  const getInitialTab = useCallback(() => {
    const hash = location.hash?.replace('#', '') || ''
    const tabName = hash.split(':')[0]
    const normalizedTabName = normalizeTraceOptimizationTab(tabName)
    return validTabs.includes(normalizedTabName) ? normalizedTabName : 'basic'
    // 仅初始化用，依赖刻意忽略
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 当前激活的 Tab
  const [activeTab, setActiveTab] = useState<string>(getInitialTab())

  // 每个 tab 单独的刷新 key
  const [tabRefreshKeys, setTabRefreshKeys] = useState<Record<string, number>>(initialTabRefreshKeys())

  // 权限判断（hasTabPerm）
  const hasTabPerm = useCallback((tabName: string) => {
    const perm = tabPermissions[tabName]
    if (!perm) return true
    return permissionManager.hasPermission(perm)
  }, [])

  // tab 是否展示 = 有权限 且 未被嵌入方隐藏
  const showTab = useCallback(
    (tabName: string) => hasTabPerm(tabName) && !hiddenTabs.includes(tabName),
    [hasTabPerm, hiddenTabs]
  )

  // 左栏分组折叠状态（groupKey → 是否收起）。可点分组标题切换。
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})
  const toggleGroup = useCallback(
    (g: string) => setCollapsedGroups((c) => ({ ...c, [g]: !c[g] })),
    []
  )

  // 跟踪已激活过的 tab（对齐 el-tab-pane 的 lazy：首次激活后挂载，之后保持）
  const [renderedTabs, setRenderedTabs] = useState<Set<string>>(() => new Set([getInitialTab()]))
  useEffect(() => {
    setRenderedTabs((prev) => {
      if (prev.has(activeTab)) return prev
      const next = new Set(prev)
      next.add(activeTab)
      return next
    })
  }, [activeTab])

  // ============ 工具：导航（保持 path/params，只换 hash） ============
  const replaceHash = useCallback(
    (hash: string) => {
      navigate({ pathname: location.pathname, search: location.search, hash }, { replace: true })
    },
    [navigate, location.pathname, location.search]
  )

  // ============ Tab 切换 ============
  const handleTabChange = useCallback(
    (tabName: string | null) => {
      if (!tabName) return

      // 只刷新点击的 tab
      setTabRefreshKeys((prev) => {
        if (!Object.prototype.hasOwnProperty.call(prev, tabName)) return prev
        return { ...prev, [tabName]: prev[tabName] + 1 }
      })

      setActiveTab(tabName)

      // 更新 URL hash，不触发页面刷新。
      replaceHash(`#${tabName}`)
    },
    [replaceHash]
  )

  // ============ 项目更新后的处理 ============
  const handleProjectUpdated = useCallback(
    (updatedProject: any) => {
      setCurrentProject(updatedProject)
    },
    [setCurrentProject]
  )

  // ============ 数据源选中状态变化 - 更新 URL hash ============
  const handleSelectionChange = useCallback(
    (tabName: string, itemId: any) => {
      const hash = itemId ? `#${tabName}:${itemId}` : `#${tabName}`
      replaceHash(hash)
    },
    [replaceHash]
  )

  // ============ 监听 URL hash 变化（浏览器前进/后退） ============
  useEffect(() => {
    const hash = location.hash?.replace('#', '') || ''
    const tabName = hash.split(':')[0]
    const normalizedTabName = normalizeTraceOptimizationTab(tabName)
    if (validTabs.includes(normalizedTabName) && normalizedTabName !== activeTab) {
      setActiveTab(normalizedTabName)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.hash])

  // ============ 监听项目切换，刷新所有 tab ============
  const prevProjectIdRef = useRef<string | undefined>(currentProject?.id)
  useEffect(() => {
    const newProjectId = currentProject?.id
    const oldProjectId = prevProjectIdRef.current
    prevProjectIdRef.current = newProjectId

    // 项目切换时刷新所有 tab 的 key，强制重新加载组件
    if (newProjectId && newProjectId !== oldProjectId) {
      // 刷新所有 tab 的 key
      setTabRefreshKeys((prev) => {
        const next = { ...prev }
        Object.keys(next).forEach((key) => {
          next[key] += 1
        })
        return next
      })

      // 检查当前 tab 是否需要特定权限，如果新项目没有权限，跳转到基本信息 tab
      const currentTab = activeTab
      const requiredPerm = tabPermissions[currentTab]

      if (requiredPerm && !permissionManager.hasPermission(requiredPerm)) {
        // 没有权限，跳转到基本信息 tab（基本信息不需要特殊权限）
        setActiveTab('basic')
        replaceHash('#basic')
        // 不显示提示，因为路由级别的权限检查已经在 SidebarNavbar 中处理
      } else {
        // 有权限，强制刷新当前路由以确保数据正确加载
        // 保持当前路由和 hash，但会触发路由守卫重新检查权限
        navigate(
          {
            pathname: location.pathname,
            search: location.search,
            hash: location.hash || `#${activeTab}`
          },
          { replace: true }
        )
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.id])

  // ============ 初始化（onMounted） ============
  useEffect(() => {
    let cancelled = false
    const init = async () => {
      const project = useProjectStore.getState().currentProject
      if (!project?.id) {
        notifications.show({ color: 'yellow', message: t('project.settings.selectProjectFirst') })
        onBack()
        return
      }

      // 刷新项目详情（跳过 5 秒内刚获取过的数据，避免 admin 跳转后重复请求）
      const staleThreshold = 5000
      if (Date.now() - useProjectStore.getState().lastDetailFetchedAt > staleThreshold) {
        try {
          const res: any = await getProjectDetailReq(project.id)
          if (!cancelled && res.data) {
            setCurrentProject(res.data)
          }
        } catch {
          // 获取失败时使用缓存数据
        }
      }

      // 主设置页若没 hash，补一个。
      if (!location.hash) {
        replaceHash(`#${activeTab}`)
      }
    }
    init()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ============ 渲染各 tab 内容（lazy：仅在激活过后挂载） ============
  // 对齐 el-tab-pane lazy：首次激活后挂载并保持。Mantine 默认渲染所有 Panel；
  // 这里仅在 tab 进入 renderedTabs 后才渲染其内容。
  const isRendered = (name: string) => renderedTabs.has(name)
  const renderSuspendedTab = (name: string) => (
    <Suspense fallback={tabLoading}>{renderTabComponent(name)}</Suspense>
  )

  // 各 tab 的内容组件(lazy 门控 + 刷新 key)。供设置壳渲染当前 tab。
  const renderTabComponent = (name: string): ReactNode => {
    const pid = currentProject?.id
    switch (name) {
      case 'basic':
        return isRendered('basic') ? (
          <BasicInfo key={tabRefreshKeys.basic} project={currentProject} onUpdated={handleProjectUpdated} />
        ) : null
      case 'members':
        return isRendered('members') ? (
          <MemberManagement key={tabRefreshKeys.members} projectId={pid} />
        ) : null
      case 'models':
        return isRendered('models') ? (
          <ModelConfig key={tabRefreshKeys.models} projectId={pid} />
        ) : null
      case 'skills':
        return isRendered('skills') ? <SkillManagement key={tabRefreshKeys.skills} /> : null
      case 'metrics':
        return isRendered('metrics') && pid ? (
          <MetricManager key={tabRefreshKeys.metrics} projectId={pid} businessId={pid} />
        ) : null
      case 'metric-views':
        return isRendered('metric-views') && pid ? (
          <MetricViewManager key={tabRefreshKeys['metric-views']} projectId={pid} businessId={pid} />
        ) : null
      case 'entities':
        return isRendered('entities') && pid ? (
          <EntityManager key={tabRefreshKeys.entities} projectId={pid} businessId={pid} />
        ) : null
      case 'examples':
        return isRendered('examples') && pid ? (
          <ExampleManager key={tabRefreshKeys.examples} projectId={pid} businessId={pid} />
        ) : null
      case 'memory':
        return isRendered('memory') && pid ? (
          <MemoryManager key={tabRefreshKeys.memory} projectId={pid} businessId={pid} />
        ) : null
      case 'workflows':
        return isRendered('workflows') ? (
          <div className={styles.comingSoonPanel}>
            <div className={styles.comingSoonBadge}>{t('project.settings.comingSoon.badge')}</div>
            <h2>{t('project.settings.comingSoon.workflowsTitle')}</h2>
            <p>{t('project.settings.comingSoon.workflowsDesc')}</p>
          </div>
        ) : null
      case 'agents':
        return isRendered('agents') && pid ? (
          <AgentSettings key={tabRefreshKeys.agents} projectId={pid} businessId={pid} />
        ) : null
      case 'trace-optimization':
        return isRendered('trace-optimization') && pid ? (
          <TraceOptimizationSettings key={tabRefreshKeys['trace-optimization']} projectId={pid} />
        ) : null
      case 'reportTemplates':
        return isRendered('reportTemplates') ? <UnifiedReportSettings key={tabRefreshKeys.reportTemplates} /> : null
      case 'database':
        return isRendered('database') ? (
          <DatabaseListView
            key={tabRefreshKeys.database}
            projectId={pid}
            initialItemId={routeItemId('database')}
            onSelectionChange={(id) => handleSelectionChange('database', id)}
          />
        ) : null
      case 'structured':
        return isRendered('structured') ? (
          <StructuredDataSourceListView
            key={tabRefreshKeys.structured}
            projectId={pid}
            initialItemId={routeItemId('structured')}
            onSelectionChange={(id: any) => handleSelectionChange('structured', id)}
          />
        ) : null
      case 'unstructured':
        return isRendered('unstructured') ? (
          <UnstructuredDataSourceListView
            key={tabRefreshKeys.unstructured}
            projectId={pid}
            initialItemId={routeItemId('unstructured')}
            onSelectionChange={(id: any) => handleSelectionChange('unstructured', id)}
          />
        ) : null
      case 'websearch':
        return isRendered('websearch') && pid ? (
          <WebSearchDataSourceListView
            key={tabRefreshKeys.websearch}
            projectId={pid}
            initialItemId={routeItemId('websearch')}
            onSelectionChange={(id: any) => handleSelectionChange('websearch', id)}
          />
        ) : null
      case 'mcp':
        return isRendered('mcp') && pid ? (
          <McpProviderListView
            key={tabRefreshKeys.mcp}
            scope="project"
            projectId={pid}
            initialItemId={routeItemId('mcp')}
            onSelectionChange={(id: any) => handleSelectionChange('mcp', id)}
          />
        ) : null
      default:
        return null
    }
  }

  const navItem = (name: string, label: ReactNode, id?: string) => (
    <SettingsNavItem key={name} id={id} active={activeTab === name} onClick={() => handleTabChange(name)}>
      {label}
    </SettingsNavItem>
  )
  const isTraceOptimizationTab =
    traceOptimizationTabNames.includes(activeTab as TraceOptimizationTabName) || activeTab === 'trace-optimization'
  const isFixedHeightTab = isTraceOptimizationTab || activeTab === 'unstructured'

  return (
    <SettingsShell
      onBack={onBack}
      mainFixed={isFixedHeightTab}
      nav={
        <>
          {navItem('basic', t('project.settings.tabs.basic'))}

          {showTab('database') && (
            <SettingsNavGroup
              label={t('project.settings.dividerDatasource')}
              collapsed={!!collapsedGroups.datasource}
              onToggle={() => toggleGroup('datasource')}
              id="onboarding-project-settings-datasource-anchor"
            >
              {navItem('database', t('project.settings.tabs.database'))}
              {showTab('structured') && navItem('structured', t('project.settings.tabs.structured'))}
              {showTab('unstructured') && navItem('unstructured', t('project.settings.tabs.unstructured'))}
              {showTab('websearch') && navItem('websearch', t('project.settings.tabs.websearch'))}
            </SettingsNavGroup>
          )}

          {['metrics', 'metric-views', 'entities', 'examples', 'memory'].some(showTab) && (
            <SettingsNavGroup
              label={t('project.settings.dividerSemantic')}
              collapsed={!!collapsedGroups.semantic}
              onToggle={() => toggleGroup('semantic')}
            >
              {showTab('metrics') && navItem('metrics', t('project.settings.tabs.metrics'))}
              {showTab('metric-views') && navItem('metric-views', t('project.settings.tabs.metricViews'))}
              {showTab('entities') && navItem('entities', t('project.settings.tabs.entities'))}
              {showTab('examples') && navItem('examples', t('project.settings.tabs.examples'))}
              {showTab('memory') && navItem('memory', t('project.settings.tabs.memory'))}
            </SettingsNavGroup>
          )}

          {['agents', 'workflows', 'skills'].some(showTab) && (
            <SettingsNavGroup
              label={t('project.settings.dividerAgent')}
              collapsed={!!collapsedGroups.agent}
              onToggle={() => toggleGroup('agent')}
            >
              {showTab('agents') && navItem('agents', t('project.settings.tabs.agents'))}
              {showTab('workflows') &&
                navItem(
                  'workflows',
                  <span className={styles.navComingSoonLabel}>
                    <span>{t('project.settings.tabs.workflows')}</span>
                    <span className={styles.navSoonBadge}>{t('project.settings.comingSoon.badge')}</span>
                  </span>
                )}
              {showTab('skills') && navItem('skills', t('project.settings.tabs.skills'))}
            </SettingsNavGroup>
          )}

          {traceOptimizationTabNames.some(showTab) && (
            <SettingsNavGroup
              label="自优化"
              collapsed={!!collapsedGroups.selfOptimization}
              onToggle={() => toggleGroup('selfOptimization')}
            >
              {showTab('trace-optimization') && navItem('trace-optimization', '优化工作台')}
            </SettingsNavGroup>
          )}

          {showTab('reportTemplates') && (
            <SettingsNavGroup
              label={t('project.settings.dividerReport')}
              collapsed={!!collapsedGroups.report}
              onToggle={() => toggleGroup('report')}
            >
              {navItem('reportTemplates', t('project.settings.tabs.reportTemplates'))}
            </SettingsNavGroup>
          )}

          {showTab('mcp') && (
            <SettingsNavGroup
              label={t('project.settings.dividerIntegration')}
              collapsed={!!collapsedGroups.integration}
              onToggle={() => toggleGroup('integration')}
            >
              {navItem('mcp', t('project.settings.tabs.mcpProviders'))}
            </SettingsNavGroup>
          )}
        </>
      }
    >
      <div className={`${styles.shellContent} ${activeTab === 'skills' || activeTab === 'unstructured' ? styles.shellContentFixed : ''}`}>
        {hasProject ? renderSuspendedTab(activeTab) : <Text c="dimmed">{t('project.settings.noProject')}</Text>}
      </div>
    </SettingsShell>
  )
}
