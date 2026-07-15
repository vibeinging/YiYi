// yiw-agent 壳:左 = 工作区树(纯聊天 / 项目 / 打开的文件夹 → 多个对话)/ 中 = 对话 或 项目配置 / 右 = 工作台(仅对话态)。
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  IconFileText,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconLayoutSidebarRightCollapse,
  IconLayoutSidebarRightExpand,
  IconPlus,
  IconTerminal2
} from '@tabler/icons-react'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import { useLocation, useNavigate } from 'react-router-dom'
import Workstation, { type PlanStep, type ToolCall } from '@/layout/workstation/Workstation'
import { useProjectStore } from '@/store/project'
import { eventBus, EVENT_TYPES } from '@/utils/eventBus'
import { createProjectReq, deleteProjectReq, getMyProjectsReq, getProjectDetailReq } from '@/api/project'
import { deleteAgentSession, listAgentSessions, moveAgentSession, renameAgentSession, updateAgentSessionStatus } from '@/api/yiw'
import YiWNav, { type Workspace } from './YiWNav'
import YiWConversation from './YiWConversation'
import YiWSettings, { loadAgentDisplaySettings, loadYiWSettings, stepYiWZoom } from './YiWSettings'
import SearchPalette from './SearchPalette'
import AppOnboarding from './onboarding/AppOnboarding'
import { isAppOnboardingCompleted, markAppOnboardingCompleted } from './onboarding/storage'
import PlanStatusFloat from './PlanStatusFloat'
import WorkspaceFilesSection from './WorkspaceFilesSection'
import { isPinned, loadPins } from './pins'
import {
  CHAT_WS,
  folderToWs,
  loadFolders,
  pickFolder,
  revealInFinder,
  saveFolders,
  workspacePath,
  type FolderWs
} from './folders'
import styles from './yiw.module.scss'
import type { DataWorkspaceEvent } from './YiWConversation'

// 项目配置页 = 复用原「项目设置」页；启动后空闲预加载，避免首次点齿轮时整包等待。
const loadProjectSettings = () => import('@/views/project/settings')
const ProjectSettings = lazy(loadProjectSettings)

type Conv = { id: string; title: string; status?: string; updated_at?: string; latest_run_status?: string | null }

const NAV_STORAGE_KEY = 'yiw-layout-nav-width'
const NAV_DEFAULT_WIDTH = 248
const NAV_MIN_WIDTH = 190
const AUTO_ARCHIVE_LAST_SCAN_KEY = 'yiw-auto-archive-last-scan-at'
const AUTO_ARCHIVE_SCAN_WINDOW_MS = 24 * 60 * 60 * 1000
const AUTO_ARCHIVE_BLOCKED_RUN_STATUS = new Set(['pending', 'running', 'suspended'])
const EDGE_EXPAND_THRESHOLD = 64
const WORKSPACE_MIN_WIDTH = 300
const PROJECT_SETTINGS_HASHES = new Set([
  'basic',
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
  'skills',
  'trace-case-build',
  'trace-case-run',
  'trace-reviews',
  'trace-drafts',
  'trace-benchmark',
  'trace-optimization',
  'reportTemplates',
  'mcp'
])

export default function YiWShell() {
  const navigate = useNavigate()
  const location = useLocation()
  const currentProject = useProjectStore((s) => s.currentProject)
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]) // 项目
  const [folders, setFolders] = useState<FolderWs[]>(() => loadFolders()) // 已打开文件夹
  const [convByWs, setConvByWs] = useState<Record<string, Conv[]>>({})
  const [archivedConvByWs, setArchivedConvByWs] = useState<Record<string, Conv[]>>({})
  const [activeWs, setActiveWs] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [configWsId, setConfigWsId] = useState<string | null>(null) // 非空 = 整窗接管显示该项目的设置页(早返回)

  const [running, setRunning] = useState(false)
  const [wsTools, setWsTools] = useState<ToolCall[]>([])
  const [wsPlan, setWsPlan] = useState<PlanStep[]>([])
  const [hasContent, setHasContent] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [settingsInitialActive, setSettingsInitialActive] = useState('general')
  const [agentDisplaySettings, setAgentDisplaySettings] = useState(loadAgentDisplaySettings)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [initializing, setInitializing] = useState(true)
  const [settingsRevision, setSettingsRevision] = useState(0)
  const [showSearch, setShowSearch] = useState(false)
  const [wsCollapsed, setWsCollapsed] = useState(true) // 右栏工作台是否折叠
  const [wsPeeking, setWsPeeking] = useState(false)
  const [wsClosing, setWsClosing] = useState(false)
  const [rightTab, setRightTab] = useState<'review' | 'files'>('review')
  const stopRef = useRef<(() => void) | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const asideRef = useRef<HTMLElement>(null)
  const wsCloseTimerRef = useRef<number | null>(null)
  const navPeekGuardRef = useRef(false) // 收起后短窗口内屏蔽边缘 hover peek,避免立刻回弹卡残留
  const navPeekGuardTimerRef = useRef<number | null>(null)
  // 清除 peek guard:取消未触发的定时器并复位标志。定义在最前(紧跟 refs),
  // 因为多个 useEffect/handler 都会调用它 —— 必须先于所有调用点初始化,否则 TDZ。
  const clearNavPeekGuard = () => {
    if (navPeekGuardTimerRef.current !== null) {
      window.clearTimeout(navPeekGuardTimerRef.current)
      navPeekGuardTimerRef.current = null
    }
    navPeekGuardRef.current = false
  }
  const savedNavWidthRaw = localStorage.getItem(NAV_STORAGE_KEY)
  const savedNavWidth = Number(savedNavWidthRaw)
  const [navCollapsed, setNavCollapsed] = useState(() => savedNavWidthRaw === '0')
  const [navPeeking, setNavPeeking] = useState(false)
  // 指针是否悬停在收起后的「展开按钮」上 —— 用于抑制该区域的边缘 hover peek,
  // 否则按钮被 peek 卸载会让 hover 焦点丢失、光标变回普通箭头。
  const [navHoveringToggle, setNavHoveringToggle] = useState(false)
  const [wsHoveringToggle, setWsHoveringToggle] = useState(false)
  const [navWidth, setNavWidth] = useState(() => {
    const saved = savedNavWidth
    return Number.isFinite(saved) && saved >= NAV_MIN_WIDTH ? saved : NAV_DEFAULT_WIDTH
  })
  const [workspaceWidth, setWorkspaceWidth] = useState<number | null>(null)

  // 工作区总表:纯聊天 + 项目 + 打开的文件夹(供左栏树 + 输入框选择器)
  const allWorkspaces = useMemo<Workspace[]>(() => [CHAT_WS, ...workspaces, ...folders], [workspaces, folders])
  const closeProjectSettings = useCallback(() => {
    setConfigWsId(null)
    const hashTab = (location.hash || '').replace('#', '').split(':')[0]
    if (PROJECT_SETTINGS_HASHES.has(hashTab)) navigate('/agent', { replace: true })
  }, [location.hash, navigate])

  useEffect(() => {
    return () => {
      if (wsCloseTimerRef.current !== null) window.clearTimeout(wsCloseTimerRef.current)
      if (navPeekGuardTimerRef.current !== null) window.clearTimeout(navPeekGuardTimerRef.current)
    }
  }, [])

  useEffect(() => {
    document.body.dataset.yiwNavCollapsed = navCollapsed ? 'true' : 'false'
    return () => {
      document.body.removeAttribute('data-yiw-nav-collapsed')
    }
  }, [navCollapsed])

  useEffect(() => {
    if (!isAppOnboardingCompleted()) setShowOnboarding(true)
  }, [])

  const openSettings = useCallback((initialActive = 'general') => {
    setSettingsInitialActive(initialActive)
    setShowSettings(true)
  }, [])

  const closeSettings = useCallback(() => {
    setAgentDisplaySettings(loadAgentDisplaySettings())
    setSettingsRevision((v) => v + 1)
    setShowSettings(false)
    setSettingsInitialActive('general')
  }, [])

  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

  const dismissOnboarding = useCallback((meta?: { primaryModelReady?: boolean }) => {
    markAppOnboardingCompleted()
    setShowOnboarding(false)
    if (meta && meta.primaryModelReady === false) {
      notifications.show({
        color: 'yellow',
        className: 'yiw-model-warning-notify',
        title: '主模型尚未配置',
        message: '需要对话、处理文件或运行任务时，请到设置页的“模型设置”配置主模型。'
      })
    }
  }, [])

  useEffect(() => {
    const preload = () => {
      loadProjectSettings().catch(() => undefined)
    }
    if ('requestIdleCallback' in window) {
      const id = window.requestIdleCallback(preload, { timeout: 2000 })
      return () => window.cancelIdleCallback?.(id)
    }
    const id = globalThis.setTimeout(preload, 1200)
    return () => globalThis.clearTimeout(id)
  }, [])

  const toConvs = (res: any): Conv[] => {
    // axios 响应拦截器已 unwrap res.data(success 时返回 res.data),
    // 所以 res 可能是 {items:[...]} 或 {data:{items:[...]}}(兼容两种)
    const items = res?.items || res?.data?.items || res?.data || []
    return (Array.isArray(items) ? items : []).map((c: any) => ({
      id: c.id,
      title: c.title || '新对话',
      status: c.status || 'active',
      updated_at: c.updated_at,
      latest_run_status: c.latest_run_status || null
    }))
  }

  const loadConvs = useCallback(async (ids: string[]) => {
    const map: Record<string, Conv[]> = {}
    const archivedMap: Record<string, Conv[]> = {}
    await Promise.all(
      ids.map(async (id) => {
        try {
          const [activeRes, archivedRes] = await Promise.all([
            listAgentSessions(id),
            listAgentSessions(id, { archived: true })
          ])
          let active = toConvs(activeRes)
          let archived = toConvs(archivedRes)
          const settings = loadYiWSettings()
          if (settings.autoArchiveTasks) {
            const cutoff = Date.now() - (parseInt(settings.archiveRetention, 10) || 7) * 24 * 60 * 60 * 1000
            const pins = loadPins()
            const toArchive = active.filter((conv) => {
              const updated = conv.updated_at ? new Date(conv.updated_at).getTime() : NaN
              const runStatus = String(conv.latest_run_status || '').toLowerCase()
              return (
                Number.isFinite(updated) &&
                updated < cutoff &&
                conv.id !== activeIdRef.current &&
                !AUTO_ARCHIVE_BLOCKED_RUN_STATUS.has(runStatus) &&
                !isPinned(pins, 'conv', conv.id)
              )
            })
            if (toArchive.length) {
              await Promise.allSettled(toArchive.map((conv) => updateAgentSessionStatus(id, conv.id, 'archived')))
              const archivedIds = new Set(toArchive.map((conv) => conv.id))
              active = active.filter((conv) => !archivedIds.has(conv.id))
              archived = [
                ...toArchive.map((conv) => ({ ...conv, status: 'archived' })),
                ...archived.filter((conv) => !archivedIds.has(conv.id))
              ]
            }
          }
          map[id] = active
          archivedMap[id] = archived
        } catch {
          map[id] = []
          archivedMap[id] = []
        }
      })
    )
    setConvByWs((prev) => ({ ...prev, ...map }))
    setArchivedConvByWs((prev) => ({ ...prev, ...archivedMap }))
  }, [])

  // 加载项目 + 纯聊天/项目的会话
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res: any = await getMyProjectsReq()
        const items: Workspace[] = (res?.data?.items || res?.data || []).map((p: any) => ({
          id: p.id,
          name: p.name || p.project_name || '工作区'
        }))
        if (!alive) return
        setWorkspaces(items)
        const initial =
          currentProject?.id && items.some((i) => i.id === currentProject.id)
            ? currentProject.id
            : items[0]?.id || CHAT_WS.id
        setActiveWs(initial)
        await loadConvs([CHAT_WS.id, ...items.map((i) => i.id)])
      } catch {
        /* ignore */
      } finally {
        if (alive) setInitializing(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [currentProject?.id, loadConvs])

  // 打开的文件夹会话(初次从 localStorage、之后随 folders 变化)
  useEffect(() => {
    if (folders.length) loadConvs(folders.map((f) => f.id))
  }, [folders, loadConvs])

  useEffect(() => {
    if (initializing) return undefined
    const ids = [CHAT_WS.id, ...workspaces.map((w) => w.id), ...folders.map((f) => f.id)]
    if (!ids.length) return undefined
    if (!loadYiWSettings().autoArchiveTasks) return undefined
    const now = Date.now()
    const last = Number(localStorage.getItem(AUTO_ARCHIVE_LAST_SCAN_KEY) || '0')
    const due = !Number.isFinite(last) || last <= 0 || now - last >= AUTO_ARCHIVE_SCAN_WINDOW_MS
    if (!due) return undefined
    loadConvs(ids)
      .then(() => localStorage.setItem(AUTO_ARCHIVE_LAST_SCAN_KEY, String(now)))
      .catch(() => undefined)
    return undefined
  }, [folders, initializing, loadConvs, settingsRevision, workspaces])

  // 刷新当前工作区的对话
  const refresh = useCallback(async (workspaceId = activeWs) => {
    if (!workspaceId) return
    try {
      await loadConvs([workspaceId])
      if (workspaceId === activeWs && activeId) {
        const list = toConvs(await listAgentSessions(workspaceId))
        const archivedList = toConvs(await listAgentSessions(workspaceId, { archived: true }))
        if (![...list, ...archivedList].some((conv) => conv.id === activeId)) setActiveId(null)
      }
    } catch {
      /* ignore */
    }
  }, [activeId, activeWs, loadConvs])

  useEffect(() => {
    const onRefreshHistory = (payload?: { workspaceId?: string; projectId?: string }) => {
      const workspaceId = String(payload?.workspaceId || payload?.projectId || activeWs || '').trim()
      refresh(workspaceId)
    }
    const onNewSessionCreated = (payload?: { sessionId?: string; workspaceId?: string; projectId?: string }) => {
      const workspaceId = String(payload?.workspaceId || payload?.projectId || activeWs || '').trim()
      const sessionId = String(payload?.sessionId || '').trim()
      if (workspaceId) {
        setActiveWs(workspaceId)
        setConfigWsId(null)
        refresh(workspaceId)
      }
      if (sessionId) setActiveId(sessionId)
    }
    eventBus.on(EVENT_TYPES.REFRESH_HISTORY, onRefreshHistory)
    eventBus.on(EVENT_TYPES.NEW_session_CREATED, onNewSessionCreated)
    return () => {
      eventBus.off(EVENT_TYPES.REFRESH_HISTORY, onRefreshHistory)
      eventBus.off(EVENT_TYPES.NEW_session_CREATED, onNewSessionCreated)
    }
  }, [activeWs, refresh])

  // 右键:重命名对话
  const renameConv = useCallback(async (wsId: string, convId: string, title: string) => {
    const t = title.trim()
    if (!t) return
    setConvByWs((m) => ({ ...m, [wsId]: (m[wsId] || []).map((c) => (c.id === convId ? { ...c, title: t } : c)) }))
    try {
      await renameAgentSession(wsId, convId, t)
    } catch {
      /* ignore */
    }
  }, [])

  // 右键:删除对话
  const removeConv = useCallback(
    async (wsId: string, convId: string) => {
      setConvByWs((m) => ({ ...m, [wsId]: (m[wsId] || []).filter((c) => c.id !== convId) }))
      setArchivedConvByWs((m) => ({ ...m, [wsId]: (m[wsId] || []).filter((c) => c.id !== convId) }))
      if (activeId === convId) setActiveId(null)
      try {
        await deleteAgentSession(wsId, convId)
      } catch {
        /* ignore */
      }
    },
    [activeId]
  )

  const archiveConv = useCallback(
    async (wsId: string, convId: string) => {
      const conv = (convByWs[wsId] || []).find((item) => item.id === convId)
      setConvByWs((m) => ({ ...m, [wsId]: (m[wsId] || []).filter((item) => item.id !== convId) }))
      if (conv) {
        setArchivedConvByWs((m) => ({
          ...m,
          [wsId]: [{ ...conv, status: 'archived' }, ...(m[wsId] || []).filter((item) => item.id !== convId)]
        }))
      }
      if (activeId === convId) setActiveId(null)
      try {
        await updateAgentSessionStatus(wsId, convId, 'archived')
      } catch (err: any) {
        notifications.show({ color: 'red', message: err?.msg || '归档对话失败' })
        refresh(wsId)
      }
    },
    [activeId, convByWs, refresh]
  )

  const restoreConv = useCallback(
    async (wsId: string, convId: string) => {
      const conv = (archivedConvByWs[wsId] || []).find((item) => item.id === convId)
      setArchivedConvByWs((m) => ({ ...m, [wsId]: (m[wsId] || []).filter((item) => item.id !== convId) }))
      if (conv) {
        setConvByWs((m) => ({
          ...m,
          [wsId]: [{ ...conv, status: 'active' }, ...(m[wsId] || []).filter((item) => item.id !== convId)]
        }))
      }
      try {
        await updateAgentSessionStatus(wsId, convId, 'active')
      } catch (err: any) {
        notifications.show({ color: 'red', message: err?.msg || '恢复对话失败' })
        refresh(wsId)
      }
    },
    [archivedConvByWs, refresh]
  )

  // 右键:移除工作区(打开的文件夹 = 仅从列表移除;问数项目 = 二次确认后软删后端项目;纯聊天不可移除)
  const dropWorkspaceState = useCallback(
    (wsId: string) => {
      if (activeWs === wsId) {
        setActiveWs(workspaces[0]?.id || CHAT_WS.id)
        setActiveId(null)
      }
      if (configWsId === wsId) setConfigWsId(null)
    },
    [activeWs, workspaces, configWsId]
  )
  const removeWorkspace = useCallback(
    (wsId: string) => {
      // 打开的文件夹:仅从本地列表移除(不动磁盘)
      if (wsId.startsWith('folder:')) {
        setFolders((prev) => {
          const next = prev.filter((f) => f.id !== wsId)
          saveFolders(next)
          return next
        })
        dropWorkspaceState(wsId)
        return
      }
      // 问数项目:软删后端项目,二次确认
      const ws = workspaces.find((w) => w.id === wsId)
      modals.openConfirmModal({
        title: '删除问数项目',
        children: `确定删除问数项目「${ws?.name || ''}」?项目下的数据源、知识与对话将一并移除,且不可恢复。`,
        labels: { confirm: '删除', cancel: '取消' },
        confirmProps: { color: 'red' },
        onConfirm: async () => {
          try {
            await deleteProjectReq(wsId)
            setWorkspaces((prev) => prev.filter((w) => w.id !== wsId))
            setConvByWs((m) => {
              const next = { ...m }
              delete next[wsId]
              return next
            })
            setArchivedConvByWs((m) => {
              const next = { ...m }
              delete next[wsId]
              return next
            })
            dropWorkspaceState(wsId)
            notifications.show({ color: 'green', message: `已删除问数项目「${ws?.name || ''}」` })
          } catch (err: any) {
            notifications.show({ color: 'red', message: err?.msg || '删除问数项目失败' })
          }
        }
      })
    },
    [workspaces, dropWorkspaceState]
  )

  // 右键:在 Finder 中显示工作区目录
  const showInFinder = useCallback(
    async (wsId: string) => {
      const folder = folders.find((f) => f.id === wsId)
      const path = await workspacePath(wsId, folder?.path)
      if (path) revealInFinder(path)
    },
    [folders]
  )

  // 创建问数项目 → 新建项目(后端建 ~/.yiw/projects/<id> 工作区)→ 入列表并切到它开新对话
  const createProject = useCallback(async (name: string) => {
    const t = name.trim()
    if (!t) return
    try {
      const res: any = await createProjectReq({ name: t })
      const p = res?.data || {}
      const id = p.id || p.project_id
      if (!id) {
        notifications.show({ color: 'red', message: '创建问数项目失败' })
        return
      }
      const ws: Workspace = { id, name: p.name || p.project_name || t }
      setWorkspaces((prev) => (prev.some((w) => w.id === id) ? prev : [...prev, ws]))
      setConvByWs((m) => ({ ...m, [id]: [] }))
      setCurrentProject(p) // 新建返回的项目带 is_owner/权限,配置页直接可用
      setActiveWs(id)
      setActiveId(null)
      setConfigWsId(id) // 创建后:左侧选中 + 右侧进入项目配置页
      notifications.show({ color: 'green', message: `已创建问数项目「${ws.name}」` })
    } catch (err: any) {
      notifications.show({ color: 'red', message: err?.msg || '创建问数项目失败' })
    }
  }, [setCurrentProject])

  const handleWorkspaceEvent = useCallback(
    async (event: DataWorkspaceEvent) => {
      const project = event.project || {}
      const id = String(event.project_id || project.id || project.project_id || '').trim()
      if (!id || id === CHAT_WS.id || id.startsWith('folder:')) return false
      const existing = workspaces.find((w) => w.id === id)
      const eventName = project.name || project.project_name || ''
      const name = eventName || existing?.name || '问数项目'
      const shouldSwitch = event.origin_project_id === CHAT_WS.id || activeWs !== id
      const eventSessionId = String(event.session_id || activeId || '').trim()
      const shouldMigrateCurrentChat =
        event.event === 'project_created' &&
        event.origin_project_id === CHAT_WS.id &&
        activeWs === CHAT_WS.id &&
        !!eventSessionId
      const movedSessionId =
        event.event === 'session_moved' && eventSessionId ? eventSessionId : null
      let migratedSessionId: string | null = null
      setWorkspaces((prev) => {
        const prevWs = prev.find((w) => w.id === id)
        const nextName = eventName || prevWs?.name || existing?.name || name
        return prevWs ? prev.map((w) => (w.id === id ? { ...w, name: nextName } : w)) : [...prev, { id, name: nextName }]
      })
      setConvByWs((m) => ({ ...m, [id]: m[id] || [] }))
      if (shouldMigrateCurrentChat && eventSessionId) {
        try {
          await moveAgentSession(CHAT_WS.id, eventSessionId, id)
          migratedSessionId = eventSessionId
        } catch (err: any) {
          notifications.show({ color: 'red', message: err?.msg || '问数项目已创建,但当前会话迁移失败' })
          await loadConvs([CHAT_WS.id, id])
          return false
        }
      }
      if (movedSessionId) {
        migratedSessionId = movedSessionId
      }
      if (shouldSwitch) {
        setCurrentProject({ ...project, id, project_id: id, name })
        setActiveWs(id)
        setActiveId(migratedSessionId)
        setConfigWsId(null)
      }
      await loadConvs(migratedSessionId ? [CHAT_WS.id, id] : [id])
      try {
        const detail: any = await getProjectDetailReq(id)
        const detailedProject = detail?.data
        const detailName = detailedProject?.name || detailedProject?.project_name || ''
        if (detailName) {
          setWorkspaces((prev) => prev.map((w) => (w.id === id ? { ...w, name: detailName } : w)))
        }
        if (detailedProject && (shouldSwitch || activeWs === id)) setCurrentProject(detailedProject)
      } catch {
        /* 保留工具返回的项目信息 */
      }
      const message =
        event.event === 'session_moved'
          ? shouldSwitch
            ? `已将当前会话迁移到问数工作区「${name}」`
            : `当前会话已在问数工作区「${name}」`
          : event.event === 'project_ready_for_query'
          ? shouldSwitch
            ? `已切换到可问数工作区「${name}」`
            : `当前工作区「${name}」已可继续问数`
          : event.event === 'project_data_preparing'
            ? shouldSwitch
              ? `已切换到问数工作区「${name}」,数据正在准备`
              : `当前工作区「${name}」的数据正在准备`
            : migratedSessionId
              ? `已创建问数工作区「${name}」,并迁移当前会话`
              : shouldSwitch
                ? `已创建并切换到问数工作区「${name}」`
                : `已创建问数工作区「${name}」`
      notifications.show({ color: 'green', message })
      return shouldSwitch
    },
    [activeId, activeWs, loadConvs, setCurrentProject, workspaces]
  )

  // 打开某个问数项目的配置页(齿轮按钮 / 右键菜单):左侧选中该项目 + 中区显示配置页
  const openConfig = useCallback(
    async (wsId: string) => {
      const ws = allWorkspaces.find((w) => w.id === wsId)
      setCurrentProject({ id: wsId, name: ws?.name || '项目' }) // 先置最小信息,避免闪到上一个项目
      setActiveWs(wsId)
      setActiveId(null)
      setConfigWsId(wsId)
      try {
        const res: any = await getProjectDetailReq(wsId)
        if (res?.data) setCurrentProject(res.data) // 补全权限/owner,配置页 tab 门控生效
      } catch {
        /* 拉详情失败:保留最小信息,配置页内部会再兜底 */
      }
    },
    [allWorkspaces, setCurrentProject]
  )

  useEffect(() => {
    const hashTab = (location.hash || '').replace('#', '').split(':')[0]
    if (!PROJECT_SETTINGS_HASHES.has(hashTab)) return
    const projectId =
      currentProject?.id && currentProject.id !== CHAT_WS.id
        ? currentProject.id
        : activeWs && activeWs !== CHAT_WS.id && !activeWs.startsWith('folder:')
          ? activeWs
          : workspaces[0]?.id
    if (!projectId || configWsId === projectId) return
    openConfig(projectId)
  }, [activeWs, configWsId, currentProject?.id, location.hash, openConfig, workspaces])

  // 打开文件夹 → 原生目录对话框 → 作为工作区开新对话
  const openFolder = useCallback(async () => {
    const path = await pickFolder()
    if (!path) return
    const ws = folderToWs(path)
    setFolders((prev) => {
      const next = prev.some((f) => f.id === ws.id) ? prev : [...prev, ws]
      saveFolders(next)
      return next
    })
    setActiveWs(ws.id)
    setActiveId(null)
    setConfigWsId(null)
  }, [])

  // 全局快捷键:⌘N 新建对话;⌘K 搜索;⌘= 放大 / ⌘- 缩小 / ⌘0 复位 界面缩放
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod || e.altKey) return
      if (!e.shiftKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault()
        setShowSettings(false)
        setConfigWsId(null)
        setActiveId(null)
      } else if (!e.shiftKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setShowSettings(false)
        setConfigWsId(null)
        setShowSearch(true)
      } else if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        stepYiWZoom(1)
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault()
        stepYiWZoom(-1)
      } else if (e.key === '0') {
        e.preventDefault()
        stepYiWZoom(0)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!navCollapsed) {
      setNavPeeking(false)
      clearNavPeekGuard()
    }
    if (!wsCollapsed || wsClosing) setWsPeeking(false)
    if (!navCollapsed && (!wsCollapsed || wsClosing || !hasContent)) return

    const onMove = (event: PointerEvent) => {
      const rect = shellRef.current?.getBoundingClientRect()
      if (!rect) return
      const inY = event.clientY >= rect.top && event.clientY <= rect.bottom
      if (!inY) {
        if (navCollapsed) setNavPeeking(false)
        if (wsCollapsed) setWsPeeking(false)
        return
      }

      // 收起瞬间边缘热区会立刻把指针判为「靠左」从而重新 peek,导致收起后面板卡成残留浮层。
      // guard:收起后置 true,直到指针离开过 shell 才清 false —— 不依赖时间基准,
      // 避免 event.timeStamp / performance.now() 基准不一致导致 peek 被永久屏蔽。
      // 另:指针悬停在收起后的「展开按钮」上时,peek 维持现状(既不开启也不关闭)——
      //   非 peek 态:不触发 peek,按钮保持可点、hover 焦点不丢;
      //   peek 态:不因碰到按钮区域而收起,浏览 nav 内容时不闪烁。
      const navGuarded = navPeekGuardRef.current
      if (navCollapsed && navHoveringToggle) {
        // 按钮区域:peek 状态完全交由按钮自身 hover 决定,pointermove 不干预
      } else if (navCollapsed && navGuarded) {
        setNavPeeking(false)
      } else if (navCollapsed) {
        const peekWidth = Math.max(220, navWidth) + 18
        const show = event.clientX <= rect.left + 14 || (navPeeking && event.clientX <= rect.left + peekWidth)
        setNavPeeking((prev) => (prev === show ? prev : show))
      }

      if (hasContent && wsCollapsed && !wsClosing) {
        if (wsHoveringToggle) {
          // 工作台展开按钮同理:peek 维持现状
        } else {
          const width = workspaceWidth ?? rect.width * 0.4
          const show = event.clientX >= rect.right - 14 || (wsPeeking && event.clientX >= rect.right - width - 18)
          setWsPeeking((prev) => (prev === show ? prev : show))
        }
      }
    }

    window.addEventListener('pointermove', onMove)
    return () => window.removeEventListener('pointermove', onMove)
  }, [
    hasContent,
    navCollapsed,
    navHoveringToggle,
    navPeeking,
    navWidth,
    workspaceWidth,
    wsCollapsed,
    wsClosing,
    wsHoveringToggle,
    wsPeeking
  ])

  if (showSettings) {
    return <YiWSettings onBack={closeSettings} initialActive={settingsInitialActive} />
  }

  // 项目设置:整窗接管的全新页面(与 App 设置一致,左上角「返回工作区」)
  if (configWsId) {
    return (
      <Suspense fallback={<div className={styles.cfgLoadingFull}>加载项目配置…</div>}>
        <ProjectSettings onBack={closeProjectSettings} hiddenTabs={['members', 'models']} />
      </Suspense>
    )
  }

  const showWsInGrid = hasContent && (!wsCollapsed || wsClosing)
  const showWsOverlay = hasContent && wsCollapsed && !wsClosing && wsPeeking
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
  const navColumn = navCollapsed ? '0px' : `${navWidth}px`
  const navHandleColumn = navCollapsed ? '8px' : '5px'
  const workspaceColumn = showWsInGrid ? (workspaceWidth == null ? '40%' : `${workspaceWidth}px`) : '0px'
  const workspaceHandleColumn = showWsInGrid ? '5px' : '0px'
  const gridTemplateColumns = hasContent
    ? `${navColumn} ${navHandleColumn} minmax(360px, 1fr) ${workspaceHandleColumn} ${workspaceColumn}`
    : `${navColumn} ${navHandleColumn} minmax(360px, 1fr)`
  const showPlanFloat = agentDisplaySettings.showTodo && hasContent && (running || wsPlan.some((step) => step.state !== 'done'))
  const shellStyle = {
    gridTemplateColumns,
    '--yiw-nav-width': `${navWidth}px`,
    '--yiw-workspace-width': workspaceWidth == null ? '40%' : `${workspaceWidth}px`
  } as React.CSSProperties
  const showNavEdgeToggle = !showOnboarding && !showSearch && !initializing

  const clearWorkspaceCloseTimer = () => {
    if (wsCloseTimerRef.current === null) return
    window.clearTimeout(wsCloseTimerRef.current)
    wsCloseTimerRef.current = null
  }

  const startResize = (kind: 'nav' | 'workspace', event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const shell = shellRef.current
    if (!shell) return
    const rect = shell.getBoundingClientRect()
    const startX = event.clientX
    const startNav = navCollapsed ? 0 : navWidth
    const startWorkspace = wsCollapsed ? 0 : workspaceWidth ?? asideRef.current?.getBoundingClientRect().width ?? rect.width * 0.4
    const startedNavCollapsed = navCollapsed
    const startedWorkspaceCollapsed = wsCollapsed
    let latestNavIntent = startNav
    let latestNavWidth = navWidth
    let latestWorkspaceIntent = startWorkspace
    let latestWorkspaceWidth = startWorkspace || WORKSPACE_MIN_WIDTH

    let navCollapseTriggered = false
    let wsCollapseTriggered = false

    document.body.dataset.yiwResizing = kind

    const onMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX
      if (kind === 'nav') {
        const raw = Math.max(0, startNav + delta)
        latestNavIntent = raw
        // 收起态起始:小拖动(raw > 64)就实时展开,不需要拖满整条 nav 宽度。
        if (startedNavCollapsed) {
          if (raw <= EDGE_EXPAND_THRESHOLD) {
            setNavCollapsed(true)
            setNavPeeking(false)
            return
          }
          const maxNav = Math.max(NAV_MIN_WIDTH, Math.min(380, rect.width - 520))
          const next = clamp(raw, NAV_MIN_WIDTH, maxNav)
          latestNavWidth = next
          setNavCollapsed(false)
          setNavPeeking(false)
          clearNavPeekGuard()
          setNavWidth(next)
          return
        }
        // 展开态起始:拖到最小宽度以下触发收起。
        if (raw < NAV_MIN_WIDTH) {
          latestNavWidth = NAV_MIN_WIDTH
          // 触发一次带过渡的收起动画:移除 data-yiw-resizing 让 .shell 的 grid 过渡生效,
          // 之后这条 nav 列不再跟手(已收起),避免瞬间消失。
          if (!navCollapseTriggered) {
            navCollapseTriggered = true
            document.body.removeAttribute('data-yiw-resizing')
            collapseNav()
            localStorage.setItem(NAV_STORAGE_KEY, '0')
          }
          return
        }

        const maxNav = Math.max(NAV_MIN_WIDTH, Math.min(380, rect.width - 520))
        const next = clamp(raw, NAV_MIN_WIDTH, maxNav)
        latestNavWidth = next
        setNavCollapsed(false)
        setNavPeeking(false)
        clearNavPeekGuard()
        setNavWidth(next)
        return
      }

      const raw = Math.max(0, startWorkspace - delta)
      latestWorkspaceIntent = raw
      // 收起态起始:小拖动就实时展开。
      if (startedWorkspaceCollapsed) {
        if (raw <= EDGE_EXPAND_THRESHOLD) {
          setWsCollapsed(true)
          setWsPeeking(false)
          setWsClosing(false)
          return
        }
        const effectiveNavWidth = navCollapsed ? 0 : navWidth
        const maxWorkspace = Math.max(WORKSPACE_MIN_WIDTH, rect.width - effectiveNavWidth - 430)
        const next = clamp(raw, WORKSPACE_MIN_WIDTH, maxWorkspace)
        latestWorkspaceWidth = next
        clearWorkspaceCloseTimer()
        setWsClosing(false)
        setWsCollapsed(false)
        setWsPeeking(false)
        setWorkspaceWidth(next)
        return
      }
      // 展开态起始:拖过最小宽度触发收起。
      if (raw < WORKSPACE_MIN_WIDTH) {
        latestWorkspaceWidth = WORKSPACE_MIN_WIDTH
        if (!wsCollapseTriggered) {
          wsCollapseTriggered = true
          document.body.removeAttribute('data-yiw-resizing')
          collapseWorkspace()
        }
        return
      }

      const effectiveNavWidth = navCollapsed ? 0 : navWidth
      const maxWorkspace = Math.max(WORKSPACE_MIN_WIDTH, rect.width - effectiveNavWidth - 430)
      const next = clamp(raw, WORKSPACE_MIN_WIDTH, maxWorkspace)
      latestWorkspaceWidth = next
      clearWorkspaceCloseTimer()
      setWsClosing(false)
      setWsCollapsed(false)
      setWsPeeking(false)
      setWorkspaceWidth(next)
    }

    const onUp = () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.body.removeAttribute('data-yiw-resizing')
      if (kind === 'nav') {
        // 拖拽过程中已触发带过渡的收起,onUp 只需收尾(持久化已在触发时完成)。
        if (navCollapseTriggered) return
        const shouldCollapse = latestNavIntent < (startedNavCollapsed ? EDGE_EXPAND_THRESHOLD : NAV_MIN_WIDTH)
        if (shouldCollapse) {
          collapseNav()
          localStorage.setItem(NAV_STORAGE_KEY, '0')
        } else {
          setNavCollapsed(false)
          setNavPeeking(false)
          clearNavPeekGuard()
          setNavWidth(latestNavWidth)
          localStorage.setItem(NAV_STORAGE_KEY, String(Math.round(latestNavWidth)))
        }
        return
      }

      if (wsCollapseTriggered) return
      const shouldCollapse = latestWorkspaceIntent < (startedWorkspaceCollapsed ? EDGE_EXPAND_THRESHOLD : WORKSPACE_MIN_WIDTH)
      if (shouldCollapse) {
        collapseWorkspace()
      } else {
        setWsCollapsed(false)
        setWsPeeking(false)
        setWorkspaceWidth(latestWorkspaceWidth)
      }
    }

    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }

  const collapseNav = () => {
    setNavPeeking(false)
    if (navCollapsed) return
    // 直接置 collapsed:grid 列宽由 .shell 的 grid-template-columns 过渡平滑收窄到 0,
    // .rail 内容配合 opacity 快速淡出 + overflow:hidden 裁剪,单一动作不抖。
    setNavCollapsed(true)
    // 收起后屏蔽边缘 hover peek 一个短窗口:避免拖拽/点击收起后指针还停在左缘,
    // 立刻被边缘热区判为「靠左」把面板 peek 回来卡成残留。用 setTimeout 自动解除,
    // 不依赖 event.timeStamp / performance.now() 的时间基准比较。
    clearNavPeekGuard()
    navPeekGuardRef.current = true
    navPeekGuardTimerRef.current = window.setTimeout(() => {
      navPeekGuardRef.current = false
      navPeekGuardTimerRef.current = null
    }, 320)
  }

  const expandNav = () => {
    setNavCollapsed(false)
    setNavPeeking(false)
    clearNavPeekGuard()
  }

  const toggleNav = () => {
    const next = !navCollapsed
    localStorage.setItem(NAV_STORAGE_KEY, next ? '0' : String(Math.round(navWidth)))
    if (next) {
      collapseNav()
    } else {
      expandNav()
    }
  }

  const collapseWorkspace = () => {
    setWsPeeking(false)
    if (wsCollapsed) {
      clearWorkspaceCloseTimer()
      setWsClosing(false)
      return
    }

    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    clearWorkspaceCloseTimer()
    if (reducedMotion) {
      setWsCollapsed(true)
      setWsClosing(false)
      return
    }

    setWsClosing(true)
    wsCloseTimerRef.current = window.setTimeout(() => {
      setWsCollapsed(true)
      setWsClosing(false)
      wsCloseTimerRef.current = null
    }, 170)
  }

  const expandWorkspace = () => {
    clearWorkspaceCloseTimer()
    setWsClosing(false)
    setWorkspaceWidth(null)
    setRightTab('review')
    setWsCollapsed(false)
    setWsPeeking(false)
  }

  const workspacePanel = (
    <div className={styles.workbenchFrame}>
      <div className={styles.workbenchTabs} role="tablist" aria-label="工作区右侧面板">
        <button
          type="button"
          role="tab"
          aria-selected={rightTab === 'review'}
          className={styles.workbenchTab}
          data-active={rightTab === 'review' ? 'true' : undefined}
          onClick={() => setRightTab('review')}
        >
          <IconTerminal2 size={14} stroke={1.8} />
          <span>审查</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={rightTab === 'files'}
          className={styles.workbenchTab}
          data-active={rightTab === 'files' ? 'true' : undefined}
          onClick={() => setRightTab('files')}
        >
          <IconFileText size={14} stroke={1.8} />
          <span>文件</span>
        </button>
        <button type="button" className={styles.workbenchTabAdd} title="新建标签" aria-label="新建标签" disabled>
          <IconPlus size={14} stroke={1.8} />
        </button>
      </div>
      <div className={styles.workbenchTabPanel} role="tabpanel">
        {rightTab === 'review' ? (
          <Workstation
            projectId={activeWs}
            sessionId={activeId}
            running={running}
            showDataTools={false}
            tools={wsTools}
            onCollapse={collapseWorkspace}
            hideHeader
          />
        ) : (
          <WorkspaceFilesSection projectId={activeWs} sessionId={activeId} />
        )}
      </div>
    </div>
  )

  return (
    <div
      ref={shellRef}
      className={`${styles.shell} ${showWsInGrid ? '' : styles.shellHome} ${navCollapsed ? styles.shellNavCollapsed : ''}`}
      style={shellStyle}
      onPointerLeave={() => {
        if (navCollapsed) setNavPeeking(false)
        // 指针离开 shell:解除收起后的 peek guard —— 下次回到边缘可以正常 peek 预览。
        clearNavPeekGuard()
        if (wsCollapsed && !wsClosing) setWsPeeking(false)
      }}
    >
      <aside
        className={styles.rail}
        data-collapsed={navCollapsed ? 'true' : undefined}
        data-peeking={navCollapsed && navPeeking ? 'true' : undefined}
      >
        <YiWNav
          workspaces={allWorkspaces}
          convByWs={convByWs}
          archivedConvByWs={archivedConvByWs}
          activeWs={activeWs}
          activeId={activeId || undefined}
          onNewConv={(wsId) => {
            setActiveWs(wsId)
            setActiveId(null)
            setConfigWsId(null)
          }}
          onSelectConv={(wsId, convId) => {
            setActiveWs(wsId)
            setActiveId(convId)
            setConfigWsId(null)
          }}
          onRenameConv={renameConv}
          onArchiveConv={archiveConv}
          onRestoreConv={restoreConv}
          onRemoveConv={removeConv}
          onRemoveWorkspace={removeWorkspace}
          onShowInFinder={showInFinder}
          onConfigureWorkspace={openConfig}
          onOpenSettings={() => openSettings('general')}
          onOpenSearch={() => setShowSearch(true)}
          onOpenSkills={() => openSettings('skills')}
        />
      </aside>
      <div
        className={styles.resizeHandle}
        data-side="nav"
        data-collapsed={navCollapsed ? 'true' : undefined}
        role="separator"
        aria-orientation="vertical"
        aria-label="调整左侧导航宽度"
        onPointerDown={(event) => startResize('nav', event)}
      />
      {showNavEdgeToggle && createPortal(
        <button
          className={`${styles.edgePanelToggle} ${styles.navEdgeToggle}`}
          data-edge-toggle="nav"
          title="切换侧边栏"
          aria-label="切换侧边栏"
          onPointerEnter={() => setNavHoveringToggle(true)}
          onPointerLeave={() => setNavHoveringToggle(false)}
          onClick={toggleNav}
        >
          {navCollapsed ? (
            <IconLayoutSidebarLeftExpand size={18} stroke={1.8} />
          ) : (
            <IconLayoutSidebarLeftCollapse size={18} stroke={1.8} />
          )}
        </button>,
        document.body
      )}
      <main className={styles.center}>
        {showPlanFloat && <PlanStatusFloat plan={wsPlan} running={running} />}
        <YiWConversation
          projectId={activeWs}
          selectedId={activeId}
          showThinking={agentDisplaySettings.showThinking}
          interactionMode={agentDisplaySettings.interaction}
          workspaces={allWorkspaces}
          conversations={convByWs[activeWs] || []}
          onSelectWorkspace={(id) => {
            setActiveWs(id)
            setActiveId(null)
            setConfigWsId(null)
          }}
          onOpenFolder={openFolder}
          onCreateProject={createProject}
          onWorkspaceEvent={handleWorkspaceEvent}
          onRunningChange={setRunning}
          onSessionCreated={(id) => setActiveId(id)}
          onAfterComplete={() => {
            refresh()
          }}
          stopRef={stopRef}
          onHasContent={setHasContent}
          onWorkstation={({ tools, plan }) => {
            setWsTools(tools)
            setWsPlan(plan)
          }}
        />
      </main>
      {showWsInGrid && (
        <>
          <div
            className={styles.resizeHandle}
            data-side="workspace"
            data-inert={wsClosing ? 'true' : undefined}
            role="separator"
            aria-orientation="vertical"
            aria-label="调整工作台宽度"
            onPointerDown={wsClosing ? undefined : (event) => startResize('workspace', event)}
          />
          <aside className={styles.aside} data-closing={wsClosing ? 'true' : undefined} ref={asideRef}>
            {workspacePanel}
          </aside>
        </>
      )}
      {showWsOverlay && (
        <aside className={`${styles.aside} ${styles.asidePeek}`} ref={asideRef}>
          {workspacePanel}
        </aside>
      )}
      {hasContent && (
        <>
          {wsCollapsed && !wsClosing && (
            <div
              className={styles.workspaceEdgeResize}
              role="separator"
              aria-orientation="vertical"
              aria-label="调整工作台宽度"
              onPointerDown={(event) => startResize('workspace', event)}
            />
          )}
          <button
            className={`${styles.edgePanelToggle} ${styles.wsEdgeToggle}`}
            data-edge-toggle="workspace"
            title="切换面板"
            aria-label="切换面板"
            onPointerEnter={() => setWsHoveringToggle(true)}
            onPointerLeave={() => setWsHoveringToggle(false)}
            onClick={wsCollapsed ? expandWorkspace : collapseWorkspace}
          >
            {wsCollapsed ? (
              <IconLayoutSidebarRightExpand size={18} stroke={1.8} />
            ) : (
              <IconLayoutSidebarRightCollapse size={18} stroke={1.8} />
            )}
          </button>
        </>
      )}
      {showOnboarding && (
        <AppOnboarding
          mode="dialog"
          onClose={dismissOnboarding}
          onFinish={dismissOnboarding}
        />
      )}
      {showSearch && (
        <SearchPalette
          workspaces={allWorkspaces}
          convByWs={convByWs}
          onClose={() => setShowSearch(false)}
          onSelect={(wsId, convId) => {
            setActiveWs(wsId)
            setActiveId(convId ?? null)
            setConfigWsId(null)
            setShowSearch(false)
          }}
        />
      )}
    </div>
  )
}
