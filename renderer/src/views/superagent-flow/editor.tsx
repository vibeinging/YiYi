// editor.tsx — SuperAgent Workflow 可视化编辑器(Vue Flow → @xyflow/react 迁移)
//
// 字段收敛(2026-06-01):删 description,描述统一进 trigger {summary, examples}。
// trigger 是 workflow 唯一描述源,既显示给人也喂 selection LLM。
//
// 迁移要点:
//  - <VueFlow> → <ReactFlow>;节点/边 state 用 useNodesState/useEdgesState
//  - useVueFlow().project → useReactFlow().screenToFlowPosition
//  - provide('workflowCatalog') → React Context(节点组件用 useContext 取实时 catalog)
//  - onBeforeRouteLeave → react-router useBlocker
import {
  useState,
  useMemo,
  useEffect,
  useRef,
  useCallback,
  createContext,
  type DragEvent as ReactDragEvent,
} from 'react'
import { useNavigate, useParams, useLocation, useBlocker } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Button,
  TextInput,
  Textarea,
  Select,
  MultiSelect,
  Autocomplete,
  TagsInput,
  NumberInput,
  Slider,
  Tooltip,
  Divider,
  Modal,
  Badge,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  useReactFlow,
  useNodesState,
  useEdgesState,
  addEdge,
  type Node,
  type Edge,
  type Connection,
  type NodeMouseHandler,
} from '@xyflow/react'
import {
  IconArrowRight,
  IconArrowBack,
  IconTarget,
  IconHelpCircleFilled,
  IconPlus,
  IconTrash,
  IconTool,
} from '@tabler/icons-react'

import ToolNode from './nodes/ToolNode'
import ConditionNode from './nodes/ConditionNode'
import OperatorNode from './nodes/OperatorNode'
import AgentConditionNode from './nodes/AgentConditionNode'
import NodePalette from './components/NodePalette'
import ExtractSchemaEditor from './components/ExtractSchemaEditor'
import PromptDialogField from './components/PromptDialogField'

import {
  NODE_CATALOG,
  ICON_MAP,
  CATEGORY_META,
  mergeCatalogWithBackend,
} from './nodeCatalog'

import { useProjectStore, projectGetters } from '@/store/project'
import {
  createWorkflowReq,
  updateWorkflowReq,
  getWorkflowReq,
  getOrchestrableToolsReq,
  triggerWorkflowRunReq,
} from '@/api/superagent-workflow'
import { getSessionList } from '@/api/session'
import request from '@/utils/axios-req'
import {
  isStatusSuccess,
  isStatusFailed,
  statusLabel,
  normalizeRunStatus,
} from '@/views/business/components/workflowListHelpers'
import { NODE_RUN_STATUS_KEY, NODE_RUN_META_KEY } from './nodes/useNodeRunStatus'
import styles from './editor.module.scss'

// 把 catalog 注入到画布节点(ToolNode 通过 useContext 拿到 editor 的实时数据,
// 而不是用本地 import 的 NODE_CATALOG —— 后端 business 字段就绪后画布也跟新)
// (对应 Vue 的 provide('workflowCatalog', catalog))
export const WorkflowCatalogContext = createContext<any[]>(NODE_CATALOG)

// reactflow nodeTypes(对应 Vue 的 markRaw 节点映射)
const nodeTypes = {
  tool: ToolNode,
  condition: ConditionNode,
  operator: OperatorNode,
  agent_condition: AgentConditionNode,
} as any

// ============== Condition 节点表单(P26)==============
// UI 下拉选监测节点 + 8 个判断维度,自动生成 condition.config.expression
// 表达式映射到后端 ctx 视图:
//   ctx.nodes['n1'].status / ctx.nodes['n1'].output.question 等
const CONDITION_CHECK_TEMPLATES: Record<string, (nid: string, key?: string) => string> = {
  status_ok: (nid, _key) => `ctx.nodes['${nid}'].status == 'success'`,
  status_fail: (nid, _key) => `ctx.nodes['${nid}'].status != 'success'`,
  has_question: (nid, _key) => `bool(ctx.nodes['${nid}'].output.get('question'))`,
  has_schema_hint: (nid, _key) => `bool(ctx.nodes['${nid}'].output.get('schema_hint'))`,
  has_entities: (nid, _key) => `bool(ctx.nodes['${nid}'].output.get('entities'))`,
  has_metrics: (nid, _key) => `bool(ctx.nodes['${nid}'].output.get('metrics'))`,
  has_failure_reason: (nid, _key) => `bool(ctx.nodes['${nid}'].output.get('failure_reason'))`,
  has_custom_key: (nid, key) => `bool(ctx.nodes['${nid}'].output.get('${(key || '').trim()}'))`,
}

// 跨名同义对(下游 input.name → 候选上游 output.name 列表)
// 设计依据:盘点 ORCHESTRABLE_TOOLS 的 IO 后,发现的语义对照
const PORT_SYNONYM_MAP: Record<string, string[]> = {
  table_name: ['table'], // semantic_filter / semantic_extract / grep_columns 的 table_name ← 上游 .table
  // join 双表(2026-06-11 端口更名 left_table→left_table_name):优先 string 的 table_name
  // 端口(裸表名,render_params 后可直接拼 SQL),opaque 的 table 仅兜底
  left_table_name: ['table_name', 'table'],
  right_table_name: ['table_name', 'table'],
}

// ===== Edge 视觉:condition 出边按 branch 着色,普通边灰 =====
// reactflow 的 edge.style 直接控制 svg <path> 的 stroke / strokeWidth
function edgeStyleForBranch(branch: string | null): any {
  if (branch === 'true') return { stroke: '#10b981', strokeWidth: 2 }
  if (branch === 'false') return { stroke: '#ef4444', strokeWidth: 2 }
  return { stroke: '#94a3b8', strokeWidth: 1.5 }
}

interface EditorInnerProps {
  /** 路由跳转(回列表 / 拦截离开) */
  navigate: ReturnType<typeof useNavigate>
}

function WorkflowEditorInner({ navigate }: EditorInnerProps) {
  const { t } = useTranslation()
  const params = useParams()
  const location = useLocation()

  // route.query.businessName → location 的 search 参数
  const queryBusinessName = useMemo(
    () => new URLSearchParams(location.search).get('businessName') || '',
    [location.search],
  )

  const currentProjectName = useProjectStore(projectGetters.currentProjectName)

  // reactflow API:screenToFlowPosition 把屏幕坐标转画布坐标(考虑缩放 / 平移)
  const { screenToFlowPosition } = useReactFlow()

  // ===== 路由 / 业务上下文 =====
  const [projectId, setProjectId] = useState('')
  const [businessId, setBusinessId] = useState('')
  const [businessName] = useState<string>(queryBusinessName)
  // 路由参数 workflowId(可选)
  const workflowId = (params.workflowId as string) || null

  // ===== workflow 数据 =====
  const [workflow, setWorkflow] = useState<any>({ name: '', trigger: { summary: '', examples: [] } })

  // 触发条件 dialog
  const [triggerDialogVisible, setTriggerDialogVisible] = useState(false)
  const [triggerForm, setTriggerForm] = useState<any>({ summary: '', examples: [] })

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [newEdgeTarget, setNewEdgeTarget] = useState('')

  // ===== 工具箱数据 =====
  const [catalog, setCatalog] = useState<any[]>([...NODE_CATALOG]) // 默认用本地 fallback
  const [capabilities, setCapabilities] = useState<any>(null) // 默认不灰显,等接口拉到再过滤
  const [, setHoveredCard] = useState<any>(null) // 用于将来弹 tooltip

  // ===== 拖拽状态 =====
  const draggingCardRef = useRef<any>(null)

  // ===== 工具箱刷新状态 =====
  const [refreshingPalette, setRefreshingPalette] = useState(false)

  // ===== 试运行 dialog =====
  const [runDialogVisible, setRunDialogVisible] = useState(false)
  const [runForm, setRunForm] = useState<any>({ origin_session_id: '', query: '' })
  const [runSubmitting, setRunSubmitting] = useState(false)
  const [sessions, setSessions] = useState<any[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)

  const [saving, setSaving] = useState(false)

  // ===== 节点 id 计数器 =====
  const nodeIdCounterRef = useRef(0)

  // 新建模式(workflowId=null)不能试运行,因为后端 /runs 路由要 workflow_id
  const canTriggerRun = Boolean(workflowId)

  // 新建时(无 workflowId)默认展开三组工具卡片;编辑既有时默认收起
  const paletteDefaultExpanded = !workflowId

  const projectName = currentProjectName || ''

  // ===== dirty 检测(未保存离开提示)=====
  const [initialSnapshot, setInitialSnapshot] = useState('')

  const currentSnapshot = useCallback(() => {
    return JSON.stringify({
      name: workflow.name,
      trigger: workflow.trigger,
      nodes: nodes.map((n: any) => ({
        id: n.id,
        type: n.type,
        data: {
          displayName: n.data?.displayName || '',
          config: n.data?.config || {},
        },
      })),
      edges: edges.map((e: any) => ({
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle || null,
      })),
    })
  }, [workflow, nodes, edges])

  const captureSnapshot = useCallback(() => {
    setInitialSnapshot(currentSnapshot())
  }, [currentSnapshot])

  const isDirty = useMemo(
    () => initialSnapshot !== '' && initialSnapshot !== currentSnapshot(),
    [initialSnapshot, currentSnapshot],
  )

  // ===== trigger computed =====
  const triggerConfigured = useMemo(() => {
    const tr = workflow.trigger || {}
    return Boolean((tr.summary || '').trim() || (Array.isArray(tr.examples) && tr.examples.length))
  }, [workflow.trigger])

  const triggerSummaryPreview = useMemo(() => {
    const s = (workflow.trigger?.summary || '').trim()
    return s ? (s.length > 60 ? s.slice(0, 60) + '…' : s) : ''
  }, [workflow.trigger])

  // ===== 选中节点 =====
  const selectedNode = useMemo(
    () => nodes.find((n: any) => n.id === selectedNodeId) || null,
    [nodes, selectedNodeId],
  )

  // 选中节点的 catalog entry
  const selectedCard = useMemo(() => {
    if (!selectedNode) return null
    const tn = (selectedNode.data as any)?.config?.tool_name
    if (tn) return catalog.find((c) => c.toolName === tn) || null
    if (selectedNode.type === 'condition') {
      return catalog.find((c) => c.toolName === 'condition') || null
    }
    if (selectedNode.type === 'agent_condition') {
      return catalog.find((c) => c.toolName === 'agent_condition') || null
    }
    return null
  }, [selectedNode, catalog])

  const selectedCardName = selectedCard?.business?.name || selectedNode?.type || ''
  const selectedCardAccent = CATEGORY_META[selectedCard?.business?.category]?.accent || '#909399'
  const SelectedCardIcon = useMemo(() => {
    const iconId = selectedCard?.business?.icon
    return (iconId && ICON_MAP[iconId]) || IconTool
  }, [selectedCard])

  // 选中工具的 inputs(从 spec 读)
  const selectedToolInputs = useMemo(() => {
    if (selectedNode?.type !== 'tool') return []
    return selectedCard?.spec?.inputs || []
  }, [selectedNode, selectedCard])

  // 属性面板可编辑表单只渲染用户该填的输入;auto_supplied 字段不展示
  const editableToolInputs = useMemo(
    () => selectedToolInputs.filter((i: any) => !i.auto_supplied),
    [selectedToolInputs],
  )

  // condition / agent_condition = 控制流节点
  const isConditionNode = useMemo(
    () => ['condition', 'agent_condition'].includes(selectedNode?.type || ''),
    [selectedNode],
  )

  // 控制流节点契约「输入」:可引用的链路上下文 + 上游节点输出端口
  const conditionContextRefs = useMemo(() => {
    if (!isConditionNode || !selectedNode) return []
    const items: any[] = [
      { name: 'user_query', type: 'string', from: t('workflow.editor.ctxFromUserQuery'), ref: '{{user_query}}', srcClass: 'source-ctx' },
      { name: 'ctx.question', type: 'string', from: t('workflow.editor.ctxFromPool'), ref: '{{ctx.question}}', srcClass: 'source-ctx' },
      { name: 'ctx.metrics', type: 'list', from: t('workflow.editor.ctxFromPool'), ref: '{{ctx.metrics}}', srcClass: 'source-ctx' },
      { name: 'ctx.entities', type: 'list', from: t('workflow.editor.ctxFromPool'), ref: '{{ctx.entities}}', srcClass: 'source-ctx' },
      { name: 'ctx.schema_hint', type: 'dict', from: t('workflow.editor.ctxFromPool'), ref: '{{ctx.schema_hint}}', srcClass: 'source-ctx' },
      { name: 'ctx.unaligned_entities', type: 'list', from: t('workflow.editor.ctxFromPool'), ref: '{{ctx.unaligned_entities}}', srcClass: 'source-ctx' },
      { name: 'ctx.guidance', type: 'string', from: t('workflow.editor.ctxFromPool'), ref: '{{ctx.guidance}}', srcClass: 'source-ctx' },
    ]
    for (const n of nodes) {
      if (n.id === selectedNode.id) continue
      const card = catalog.find((c) => c.toolName === (n.data as any)?.config?.tool_name)
      const bizName = card?.business?.name || n.type
      for (const o of card?.spec?.outputs || []) {
        items.push({
          name: `${n.id}.${o.name}`,
          type: o.type,
          from: bizName,
          ref: `{{${n.id}.output.${o.name}}}`,
          srcClass: 'source-upstream',
        })
      }
    }
    return items
  }, [isConditionNode, selectedNode, nodes, catalog, t])

  // 上游节点的 table 端口(给 source='upstream' 的参数选)
  const upstreamTableRefs = useMemo(() => {
    if (!selectedNode) return []
    const directIds = new Set(
      edges.filter((e: any) => e.target === selectedNode.id).map((e: any) => e.source),
    )
    const upstream = nodes.filter((n: any) => n.id !== selectedNode.id && n.type === 'tool')
    const refs: any[] = []
    for (const n of upstream) {
      const tn = (n.data as any)?.config?.tool_name
      const card = catalog.find((c) => c.toolName === tn)
      const outputs = card?.spec?.outputs || []
      const tableOut = outputs.find((o: any) => o.name === 'table_name')
        || outputs.find((o: any) => o.name === 'table' || o.type === 'table')
      if (tableOut) {
        const direct = directIds.has(n.id)
        refs.push({
          value: `{{${n.id}.output.${tableOut.name}}}`,
          label: `${direct ? '↑ ' : ''}${n.id} · ${tableOut.name}(${card?.business?.name || tn || '?'})`,
          direct,
        })
      }
    }
    refs.sort((a, b) => Number(b.direct) - Number(a.direct))
    return refs
  }, [selectedNode, edges, nodes, catalog])

  // *_columns 输入(join left_columns/right_columns)的候选列名
  const columnsCandidatesFor = useCallback(
    (input: any) => {
      if (!selectedNode || !input?.name?.endsWith('_columns')) return []
      const tableInputName = input.name.replace('_columns', '_table_name')
      const refVal = (selectedNode.data as any)?.config?.params?.[tableInputName]
      if (typeof refVal !== 'string') return []
      const m = refVal.match(/\{\{\s*([A-Za-z0-9_-]+)\.output\./)
      if (!m) return []
      const upNode = nodes.find((n: any) => n.id === m[1])
      const schema = (upNode?.data as any)?.config?.params?.extract_schema
      const names = Array.isArray(schema) ? schema.map((f: any) => f?.name).filter(Boolean) : []
      return [...names, 'embedding_content']
    },
    [selectedNode, nodes],
  )

  // 当前 graph 其他节点 id(给 fallback_skip_nodes 多选下拉用)
  const otherNodeOptions = useMemo(() => {
    if (!selectedNode) return []
    return nodes
      .filter((n: any) => n.id !== selectedNode.id)
      .map((n: any) => ({
        value: n.id,
        label: `${n.id} · ${n.data?.displayName || n.type}`,
      }))
  }, [selectedNode, nodes])

  // condition 节点候选监测节点:当前 graph 所有非自身节点
  const conditionUpstreamCandidates = useMemo(() => {
    if (!selectedNode) return []
    return nodes
      .filter((n: any) => n.id !== selectedNode.id)
      .map((n: any) => {
        const card = catalog.find((c) => c.toolName === (n.data as any)?.config?.tool_name)
        const bizName = card?.business?.name || n.type
        return {
          id: n.id,
          label: `${n.id} · ${n.data?.displayName || bizName}`,
        }
      })
  }, [selectedNode, nodes, catalog])

  // condition 节点表单状态:从 config 反解析(若已有 expression);否则空
  const conditionForm = useMemo(() => {
    if (!selectedNode || selectedNode.type !== 'condition') {
      return { upstreamNodeId: '', check: '', customKey: '' }
    }
    const config = (selectedNode.data as any).config || {}
    return {
      upstreamNodeId: config.upstream_node_id || '',
      check: config.check || '',
      customKey: config.custom_key || '',
    }
  }, [selectedNode])

  // ============== Agent Condition 节点辅助(P28 / P29)==============
  const ctxTemplateHint = '{{ctx.xxx}}'
  const nodeTemplateHint = '{{nX.output.yyy}}'

  // 当前 graph 所有非 selected 节点的可引用 outputs
  const availableNodeRefs = useMemo(() => {
    if (!selectedNode || !['condition', 'agent_condition'].includes(selectedNode.type || '')) {
      return []
    }
    const refs: any[] = []
    refs.push({ value: '{{user_query}}', label: 'user_query', title: t('workflow.editor.refTitle.userQuery') })
    refs.push({ value: '{{ctx.question}}', label: 'ctx.question', title: t('workflow.editor.refTitle.ctxQuestion') })
    refs.push({ value: '{{ctx.metrics}}', label: 'ctx.metrics', title: t('workflow.editor.refTitle.ctxMetrics') })
    refs.push({ value: '{{ctx.entities}}', label: 'ctx.entities', title: t('workflow.editor.refTitle.ctxEntities') })
    for (const n of nodes) {
      if (n.id === selectedNode.id) continue
      const card = catalog.find((c) => c.toolName === (n.data as any)?.config?.tool_name)
      const outputs = card?.spec?.outputs || []
      const bizName = card?.business?.name || n.type
      for (const o of outputs) {
        refs.push({
          value: `{{${n.id}.output.${o.name}}}`,
          label: `${n.id}.${o.name}`,
          title: t('workflow.editor.nodeOutputTitle', { biz: bizName, name: o.name, type: o.type }),
        })
      }
    }
    return refs
  }, [selectedNode, nodes, catalog, t])

  // agent_condition prompt 示例预设(P29)
  const agentConditionExamples = useMemo(
    () => [
      {
        label: t('workflow.editor.example.emptyMetricsLabel'),
        prompt: t('workflow.editor.example.emptyMetricsPrompt'),
      },
      {
        label: t('workflow.editor.example.nplLabel'),
        prompt: t('workflow.editor.example.nplPrompt'),
      },
      {
        label: t('workflow.editor.example.multiBranchLabel'),
        prompt: t('workflow.editor.example.multiBranchPrompt'),
      },
    ],
    [t],
  )

  // 当前选中节点的出边
  const nodeOutEdges = useMemo(
    () => (selectedNode ? edges.filter((e: any) => e.source === selectedNode.id) : []),
    [selectedNode, edges],
  )

  const availableTargets = useMemo(() => {
    if (!selectedNode) return []
    const taken = nodeOutEdges.map((e: any) => e.target)
    return nodes.filter((n: any) => n.id !== selectedNode.id && !taken.includes(n.id))
  }, [selectedNode, nodeOutEdges, nodes])

  // ============== 节点 data 写入 helpers(immutable 重建,触发 reactflow 重渲染)==============
  // 用 setNodes 更新指定节点的 data(取代 Vue 直接改 node.data)
  const patchNodeData = useCallback(
    (nodeId: string, updater: (data: any) => any) => {
      setNodes((nds) =>
        nds.map((n) => (n.id === nodeId ? { ...n, data: updater(n.data) } : n)),
      )
    },
    [setNodes],
  )

  function setParam(name: string, value: any) {
    if (!selectedNode) return
    const nid = selectedNode.id
    patchNodeData(nid, (data) => {
      const prevParams = data?.config?.params || {}
      return {
        ...data,
        config: {
          ...(data?.config || {}),
          params: { ...prevParams, [name]: value },
        },
      }
    })
  }

  // 通用 immutable 写入 selectedNode.data.config[field]
  function setNodeConfigField(field: string, value: any) {
    if (!selectedNode) return
    const nid = selectedNode.id
    patchNodeData(nid, (data) => ({
      ...data,
      config: {
        ...(data?.config || {}),
        [field]: value,
      },
    }))
  }

  // 通用 immutable 写入 selectedNode.data[field](displayName 等 data 顶级字段)
  function setNodeDataField(field: string, value: any) {
    if (!selectedNode) return
    const nid = selectedNode.id
    patchNodeData(nid, (data) => ({ ...data, [field]: value }))
  }

  function updateConditionForm(field: string, value: any) {
    if (!selectedNode) return
    const nid = selectedNode.id
    patchNodeData(nid, (data) => {
      const config = { ...(data.config || {}) }
      // 写到 first-class config 字段(便于反解析 + 后端日志可读)
      if (field === 'upstreamNodeId') config.upstream_node_id = value
      if (field === 'check') config.check = value
      if (field === 'customKey') config.custom_key = value
      // 重新生成 expression
      const cnid = field === 'upstreamNodeId' ? value : config.upstream_node_id
      const check = field === 'check' ? value : config.check
      const customKey = field === 'customKey' ? value : config.custom_key
      if (cnid && check && CONDITION_CHECK_TEMPLATES[check]) {
        config.expression = CONDITION_CHECK_TEMPLATES[check](cnid, customKey)
      } else {
        config.expression = ''
      }
      return { ...data, config }
    })
  }

  // ===== Run 完成后把 status + meta 同步到画布节点 =====
  const syncRunStatusToNodes = useCallback(
    (run: any) => {
      if (!run || !Array.isArray(run.node_runs)) return
      const statusMap = new Map(
        run.node_runs.map((nr: any) => [
          nr.node_id,
          { status: normalizeRunStatus(nr.status), meta: nr.meta || null },
        ]),
      )
      setNodes((nds) =>
        nds.map((n) => {
          const s: any = statusMap.get(n.id)
          return {
            ...n,
            data: {
              ...n.data,
              [NODE_RUN_STATUS_KEY]: s ? s.status : '',
              [NODE_RUN_META_KEY]: s ? s.meta : null,
            },
          }
        }),
      )
    },
    [setNodes],
  )

  // ===== 数据加载 =====
  const loadCatalogFromBackend = useCallback(async () => {
    try {
      const res = await getOrchestrableToolsReq()
      const items = res.data || []
      setCatalog(mergeCatalogWithBackend(items))
    } catch (e: any) {
      // 接口不可达 / 后端尚未扩展 business 字段 → 用本地 fallback
      console.warn('[Editor] 加载工具元信息失败,使用本地 fallback:', e?.message)
      setCatalog([...NODE_CATALOG])
    }
  }, [])

  const loadCapabilities = useCallback(async () => {
    try {
      const res = await request({
        url: `/api/projects/${projectId}/capabilities`,
        method: 'get',
      })
      setCapabilities(res.data || null)
    } catch (e: any) {
      // 后端 Phase C 未上线 → 暂时不灰显
      console.warn('[Editor] 加载 business capabilities 失败,所有卡片默认可用:', e?.message)
      setCapabilities(null)
    }
  }, [projectId, businessId])

  const loadWorkflow = useCallback(async () => {
    try {
      const res = await getWorkflowReq(projectId, workflowId)
      const wf = res.data
      // 兼容老数据:trigger 缺字段时补结构
      const rawTrigger = (wf.trigger && typeof wf.trigger === 'object') ? wf.trigger : {}
      setWorkflow({
        name: wf.name,
        trigger: {
          summary: rawTrigger.summary || '',
          examples: Array.isArray(rawTrigger.examples) ? rawTrigger.examples : [],
        },
      })
      const loadedNodes = (wf.graph?.nodes || []).map((n: any, i: number) => {
        // 优先读保存的 position(2026-06-01 修)
        const savedPos = n.config?.position
        const position = (savedPos && typeof savedPos.x === 'number' && typeof savedPos.y === 'number')
          ? { x: savedPos.x, y: savedPos.y }
          : { x: 80 + (i % 4) * 240, y: 80 + Math.floor(i / 4) * 160 }
        // 加载到画布的 config 不带 position
        const cleanConfig = { ...(n.config || {}) }
        delete cleanConfig.position
        return {
          id: n.id,
          type: n.type,
          position,
          data: {
            displayName: cleanConfig.display_name || '',
            config: cleanConfig,
          },
        }
      })
      const loadedEdges = (wf.graph?.edges || []).map((e: any, i: number) => ({
        id: `e-${i}-${Date.now()}`,
        source: e.source,
        target: e.target,
        sourceHandle: e.branch || null,
        label: e.branch || '',
        style: edgeStyleForBranch(e.branch || null),
      }))
      setNodes(loadedNodes)
      setEdges(loadedEdges)
      // 修正 nodeIdCounter 以避免新增节点 id 冲突
      for (const n of loadedNodes) {
        const m = n.id.match(/^n(\d+)$/)
        if (m) nodeIdCounterRef.current = Math.max(nodeIdCounterRef.current, parseInt(m[1], 10))
      }
    } catch (e: any) {
      notifications.show({ color: 'red', message: t('workflow.editor.loadWorkflowFailed') + (e.message || e) })
    }
  }, [projectId, businessId, workflowId, setNodes, setEdges, t])

  // ===== 生命周期:onMounted =====
  useEffect(() => {
    const pid = (params.projectId as string) || localStorage.getItem('currentProjectId') || ''
    // 去业务层:businessId 即 projectId(项目即业务,工作流直接挂项目)
    const bid = pid
    setProjectId(pid)
    setBusinessId(bid)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // 用本地变量驱动加载(state 在本次渲染未更新)
    ;(async () => {
      try {
        const [toolsRes] = await Promise.all([
          getOrchestrableToolsReq().catch(() => null),
          (async () => {
            try {
              const res = await request({
                url: `/api/projects/${pid}/capabilities`,
                method: 'get',
              })
              setCapabilities(res.data || null)
            } catch (e: any) {
              console.warn('[Editor] 加载 business capabilities 失败,所有卡片默认可用:', e?.message)
              setCapabilities(null)
            }
          })(),
        ])
        if (toolsRes) {
          setCatalog(mergeCatalogWithBackend(toolsRes.data || []))
        } else {
          setCatalog([...NODE_CATALOG])
        }
      } catch {
        setCatalog([...NODE_CATALOG])
      }
      if (workflowId) {
        try {
          const res = await getWorkflowReq(pid, workflowId)
          const wf = res.data
          const rawTrigger = (wf.trigger && typeof wf.trigger === 'object') ? wf.trigger : {}
          setWorkflow({
            name: wf.name,
            trigger: {
              summary: rawTrigger.summary || '',
              examples: Array.isArray(rawTrigger.examples) ? rawTrigger.examples : [],
            },
          })
          const loadedNodes = (wf.graph?.nodes || []).map((n: any, i: number) => {
            const savedPos = n.config?.position
            const position = (savedPos && typeof savedPos.x === 'number' && typeof savedPos.y === 'number')
              ? { x: savedPos.x, y: savedPos.y }
              : { x: 80 + (i % 4) * 240, y: 80 + Math.floor(i / 4) * 160 }
            const cleanConfig = { ...(n.config || {}) }
            delete cleanConfig.position
            return {
              id: n.id,
              type: n.type,
              position,
              data: { displayName: cleanConfig.display_name || '', config: cleanConfig },
            }
          })
          const loadedEdges = (wf.graph?.edges || []).map((e: any, i: number) => ({
            id: `e-${i}-${Date.now()}`,
            source: e.source,
            target: e.target,
            sourceHandle: e.branch || null,
            label: e.branch || '',
            style: edgeStyleForBranch(e.branch || null),
          }))
          setNodes(loadedNodes)
          setEdges(loadedEdges)
          for (const n of loadedNodes) {
            const m = n.id.match(/^n(\d+)$/)
            if (m) nodeIdCounterRef.current = Math.max(nodeIdCounterRef.current, parseInt(m[1], 10))
          }
        } catch (e: any) {
          notifications.show({ color: 'red', message: t('workflow.editor.loadWorkflowFailed') + (e.message || e) })
        }
      }
      // 等 react 状态更新完成再 capture,避免数据填充被认为"用户修改"
      requestAnimationFrame(() => {
        setInitialSnapshot(currentSnapshotRef.current())
      })
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 用 ref 持有最新的 currentSnapshot,供 mount 内异步闭包读取(避免依赖陈旧)
  const currentSnapshotRef = useRef(currentSnapshot)
  useEffect(() => {
    currentSnapshotRef.current = currentSnapshot
  }, [currentSnapshot])

  // 浏览器关闭 / 刷新 / 跳外链时拦截
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!isDirty) return
      e.preventDefault()
      // Chrome 需要 returnValue 才弹原生提示;文案浏览器不一定显示
      e.returnValue = t('workflow.editor.leaveNative')
      return e.returnValue
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [isDirty, t])

  // react-router 内部跳转拦截(点「返回」按钮、浏览器后退、跨页面 navigate)
  // 对应 Vue 的 onBeforeRouteLeave
  const blocker = useBlocker(
    useCallback(
      ({ currentLocation, nextLocation }: { currentLocation: any; nextLocation: any }) =>
        isDirty && currentLocation.pathname !== nextLocation.pathname,
      [isDirty],
    ),
  )

  useEffect(() => {
    if (blocker.state !== 'blocked') return
    modals.openConfirmModal({
      title: t('workflow.editor.leaveTitle'),
      children: t('workflow.editor.leaveConfirm'),
      labels: {
        confirm: t('workflow.editor.leaveConfirmBtn'),
        cancel: t('workflow.editor.leaveCancelBtn'),
      },
      confirmProps: { color: 'yellow' },
      onConfirm: () => blocker.proceed?.(),
      onCancel: () => blocker.reset?.(), // 用户点取消 → 留在编辑器
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocker.state])

  // ===== trigger dialog =====
  function openTriggerDialog() {
    // 深拷贝避免取消时污染本体
    const tr = workflow.trigger || { summary: '', examples: [] }
    setTriggerForm({
      summary: tr.summary || '',
      examples: Array.isArray(tr.examples) ? [...tr.examples] : [],
    })
    setTriggerDialogVisible(true)
  }
  function applyTriggerForm() {
    // 过滤掉空字符串 example
    setWorkflow((wf: any) => ({
      ...wf,
      trigger: {
        summary: (triggerForm.summary || '').trim(),
        examples: (triggerForm.examples || [])
          .map((e: string) => (e || '').trim())
          .filter(Boolean),
      },
    }))
    setTriggerDialogVisible(false)
  }
  function addExample() {
    setTriggerForm((f: any) => ({ ...f, examples: [...f.examples, ''] }))
  }
  function removeExample(idx: number) {
    setTriggerForm((f: any) => ({ ...f, examples: f.examples.filter((_: any, i: number) => i !== idx) }))
  }
  function setExample(idx: number, value: string) {
    setTriggerForm((f: any) => ({
      ...f,
      examples: f.examples.map((e: string, i: number) => (i === idx ? value : e)),
    }))
  }

  // 用户主动刷新:重新拉 catalog + capabilities
  async function refreshPalette() {
    setRefreshingPalette(true)
    try {
      await Promise.all([loadCatalogFromBackend(), loadCapabilities()])
      notifications.show({ color: 'green', message: t('workflow.editor.paletteRefreshed') })
    } finally {
      setRefreshingPalette(false)
    }
  }

  // ===== 拖拽 =====
  function onCardDragStart(card: any) {
    draggingCardRef.current = card
  }
  function onCardDragEnd() {
    draggingCardRef.current = null
  }
  function onCardHover(card: any) {
    setHoveredCard(card)
  }

  function onCanvasDragOver(e: ReactDragEvent) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  function onCanvasDrop(e: ReactDragEvent) {
    e.preventDefault()
    let payload: any = null
    try {
      payload = JSON.parse(e.dataTransfer.getData('application/x-workflow-card'))
    } catch {
      payload = draggingCardRef.current
        ? { toolName: draggingCardRef.current.toolName, nodeType: draggingCardRef.current.nodeType }
        : null
    }
    if (!payload) return

    const card = catalog.find((c) => c.toolName === payload.toolName)
    if (!card) {
      notifications.show({ color: 'yellow', message: t('workflow.editor.unknownCard', { name: payload.toolName }) })
      return
    }

    // 计算 drop 位置:用 reactflow screenToFlowPosition 转屏幕坐标 → 画布坐标
    const position = screenToFlowPosition({ x: e.clientX, y: e.clientY })

    nodeIdCounterRef.current += 1
    const newId = `n${nodeIdCounterRef.current}`

    // 根据卡片类型构造 config
    let config: any
    if (card.nodeType === 'condition') {
      config = { expression: '' }
    } else if (card.nodeType === 'agent_condition') {
      config = { prompt: '', model_id: null, temperature: 0.2 }
    } else if (card.nodeType === 'tool') {
      const defaults: any = {}
      for (const i of card.spec?.inputs || []) {
        if (i.required) defaults[i.name] = ''
        else if (i.default !== undefined && i.default !== null) defaults[i.name] = i.default
      }
      config = { tool_name: card.toolName, params: defaults }
    } else {
      config = {}
    }

    setNodes((nds) => [
      ...nds,
      {
        id: newId,
        type: card.nodeType,
        position,
        data: { displayName: '', config },
      } as Node,
    ])

    setSelectedNodeId(newId)
    draggingCardRef.current = null
  }

  // ===== 节点交互 =====
  const onNodeClick = useCallback<NodeMouseHandler>(
    (_event, node) => {
      const id = node?.id || null
      setSelectedNodeId(id)
      setNewEdgeTarget('')
      // 选中即按入边补一轮预填(只填空位,幂等)
      if (id) {
        for (const e of edges) {
          if (e.target === id) autoWireFromUpstream(e.source, e.target)
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [edges, nodes, catalog],
  )

  const onConnect = useCallback(
    (params: Connection) => {
      const branch = (params as any).sourceHandle || null
      setEdges((eds) =>
        addEdge(
          {
            id: `e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            source: params.source!,
            target: params.target!,
            sourceHandle: branch,
            label: branch || '',
            style: edgeStyleForBranch(branch),
          } as Edge,
          eds,
        ),
      )
      // 智能 default 联动
      autoWireFromUpstream(params.source!, params.target!)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setEdges, nodes, catalog],
  )

  // input.source 翻译人话
  function inputSourceLabel(source: string) {
    if (source === 'upstream') return t('workflow.editor.source.upstream')
    if (source === 'schema') return t('workflow.editor.source.schema')
    return t('workflow.editor.source.user')
  }

  // 把 {{node_id.output.port}} 渲染为字符串
  function outputRefSyntax(portName: string) {
    const nid = selectedNode?.id || 'nX'
    return '{{' + nid + '.output.' + portName + '}}'
  }
  function outputRefHint(portName: string) {
    return '{{' + t('workflow.editor.outputRefPlaceholder') + '.output.' + portName + '}}'
  }

  // 找哪些工具的 outputs 能 supply 当前 input(同名优先,跨名同义兜底)
  function upstreamSuppliersForInput(inputName: string) {
    const candidates: any[] = []
    const aliases = PORT_SYNONYM_MAP[inputName] || []
    const acceptable = new Set([inputName, ...aliases])
    for (const card of catalog) {
      if (!card?.spec?.outputs) continue
      if (card.toolName === selectedCard?.toolName) continue // 排除自己
      for (const o of card.spec.outputs) {
        if (acceptable.has(o.name)) {
          candidates.push({
            toolName: card.toolName,
            businessName: card.business?.name || card.toolName,
            outputName: o.name,
            outputType: o.type,
          })
          break // 一个工具有匹配就够,不重复列
        }
      }
    }
    return candidates
  }

  // 找哪些工具的 inputs 能 consume 当前 output
  function downstreamConsumersForOutput(outputName: string) {
    const strong: any[] = []
    const fallback: any[] = []
    for (const card of catalog) {
      if (!card?.spec?.inputs) continue
      if (card.toolName === selectedCard?.toolName) continue
      // 第 1 轮:找 strong 匹配
      let matched = false
      for (const i of card.spec.inputs) {
        if (i.source === 'schema') continue
        const synonymOuts = PORT_SYNONYM_MAP[i.name] || []
        if (i.name === outputName || synonymOuts.includes(outputName)) {
          strong.push({
            toolName: card.toolName,
            businessName: card.business?.name || card.toolName,
            inputName: i.name,
            inputType: i.type,
            matchKind: 'strong',
          })
          matched = true
          break
        }
      }
      if (matched) continue
      // 第 2 轮:fallback
      const requiredUserInputs = card.spec.inputs.filter(
        (i: any) => i.required && i.source !== 'schema' && i.source !== 'upstream',
      )
      const allHaveDefault = requiredUserInputs.length > 0
        && requiredUserInputs.every((i: any) => i.default !== null && i.default !== undefined && i.default !== '')
      if (allHaveDefault) {
        fallback.push({
          toolName: card.toolName,
          businessName: card.business?.name || card.toolName,
          inputName: requiredUserInputs[0].name,
          inputType: requiredUserInputs[0].type,
          matchKind: 'fallback',
        })
      }
    }
    return [...strong, ...fallback]
  }

  // onConnect(sourceId → targetId) 时按规则自动 wire target 的 input
  function autoWireFromUpstream(sourceId: string, targetId: string) {
    const target = nodes.find((n: any) => n.id === targetId)
    const source = nodes.find((n: any) => n.id === sourceId)
    if (!target || !source) return
    const targetCard = catalog.find((c) => c.toolName === (target.data as any)?.config?.tool_name)
    const sourceCard = catalog.find((c) => c.toolName === (source.data as any)?.config?.tool_name)
    if (!targetCard?.spec || !sourceCard?.spec) return
    const sourceOutputs = sourceCard.spec.outputs || []
    const params = { ...((target.data as any).config.params || {}) }
    let mutated = false
    // 每个上游 output 端口一次 connect 只分配给一个空位
    const usedOutputNames = new Set<string>()
    for (const input of targetCard.spec.inputs || []) {
      if (input.source === 'schema') continue
      const current = params[input.name]
      const isUntouched = current === undefined || current === null
        || current === '' || current === input.default
      if (!isUntouched) continue
      const directMatch = sourceOutputs.find(
        (o: any) => o.name === input.name && !usedOutputNames.has(o.name),
      )
      const synonymAliases = PORT_SYNONYM_MAP[input.name] || []
      const synonymMatch = !directMatch && sourceOutputs.find(
        (o: any) => synonymAliases.includes(o.name) && !usedOutputNames.has(o.name),
      )
      const matched = directMatch || synonymMatch
      if (matched) {
        params[input.name] = `{{${sourceId}.output.${matched.name}}}`
        usedOutputNames.add(matched.name)
        mutated = true
      }
    }
    if (mutated) {
      patchNodeData(targetId, (data) => ({
        ...data,
        config: { ...(data.config || {}), params },
      }))
    }
  }

  function deleteSelectedNode() {
    if (!selectedNode) return
    const nid = selectedNode.id
    setNodes((nds) => nds.filter((n) => n.id !== nid))
    setEdges((eds) => eds.filter((e) => e.source !== nid && e.target !== nid))
    setSelectedNodeId(null)
  }

  function addEdgeManual() {
    if (!selectedNode || !newEdgeTarget) return
    // condition + agent_condition 都用 true/false 分支端口,默认 true
    const isCondLike = ['condition', 'agent_condition'].includes(selectedNode.type || '')
    const branch = isCondLike ? 'true' : null
    const sourceId = selectedNode.id
    const targetId = newEdgeTarget
    setEdges((eds) => [
      ...eds,
      {
        id: `e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        source: sourceId,
        target: targetId,
        sourceHandle: branch,
        label: branch || '',
        style: edgeStyleForBranch(branch),
      } as Edge,
    ])
    setNewEdgeTarget('')
    autoWireFromUpstream(sourceId, targetId)
  }

  function removeEdge(edgeId: string) {
    setEdges((eds) => eds.filter((e) => e.id !== edgeId))
  }

  function syncEdgeBranch(edgeId: string, value: string) {
    setEdges((eds) =>
      eds.map((e) =>
        e.id === edgeId
          ? { ...e, sourceHandle: value, label: value, style: edgeStyleForBranch(value) }
          : e,
      ),
    )
  }

  function targetDisplayName(id: string) {
    const n = nodes.find((x: any) => x.id === id)
    if (!n) return id
    if ((n.data as any).displayName) return `${id} · ${(n.data as any).displayName}`
    const tn = (n.data as any).config?.tool_name
    const card = catalog.find((c) => c.toolName === tn)
    return card?.business?.name ? `${id} · ${card.business.name}` : id
  }

  // ===== 参数编辑 helpers =====
  function inputLabel(input: any) {
    return `${input.name}${input.required ? ' *' : ''}`
  }

  // string 输入框 placeholder:智能呈现 default
  function stringInputPlaceholder(input: any) {
    const def = input?.default
    if (def === null || def === undefined || def === '') {
      return input?.description || ''
    }
    const friendly = humanizeDefault(def)
    return t('workflow.editor.stringDefaultHint', { val: friendly })
  }

  // default 值翻译成人话(主要处理 {{user_query}} 等模板)
  function humanizeDefault(def: any): string {
    if (typeof def !== 'string') return String(def)
    const trimmed = def.trim()
    if (trimmed === '{{user_query}}') return t('workflow.editor.defaultUserQuery')
    const refMatch = trimmed.match(/^\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)(?:\.([^}\s]+))?\s*\}\}$/)
    if (refMatch) {
      return t('workflow.editor.upstreamRefOutput', { ref: `${refMatch[1]}${refMatch[2] ? '.' + refMatch[2] : ''}` })
    }
    return def
  }

  // hint-desc 区域显示完整 default
  function formatDefaultForHint(def: any): string {
    if (def === null || def === undefined) return ''
    return typeof def === 'string' ? def : JSON.stringify(def)
  }

  function paramAsJson(name: string): string {
    const v = (selectedNode?.data as any)?.config?.params?.[name]
    if (v === undefined || v === null) return ''
    try {
      return JSON.stringify(v, null, 2)
    } catch {
      return String(v)
    }
  }

  function setParamFromJson(name: string, jsonStr: string) {
    if (!selectedNode) return
    try {
      const v = jsonStr?.trim() ? JSON.parse(jsonStr) : null
      setParam(name, v)
    } catch {
      notifications.show({ color: 'yellow', message: t('workflow.editor.paramJsonInvalid', { name }) })
    }
  }

  // ===== 保存:清理 params 里的空 schema 行 =====
  function cleanedParams(config: any) {
    if (!config || !config.params) return { params: {} }
    const cleaned = { ...config.params }
    if (Array.isArray(cleaned.extract_schema)) {
      cleaned.extract_schema = cleaned.extract_schema.filter(
        (f: any) => (f?.name || '').trim() || (f?.description || '').trim(),
      )
      if (!cleaned.extract_schema.length) delete cleaned.extract_schema
    }
    return { params: cleaned }
  }

  // ===== 保存前 client 校验 =====
  function validateGraphBeforeSave() {
    const errors: string[] = []
    for (const n of nodes) {
      if (n.type === 'condition') {
        const expr = ((n.data as any)?.config?.expression || '').trim()
        if (!expr) {
          const label = (n.data as any)?.displayName || n.id
          errors.push(t('workflow.editor.condMissingExpr', { label }))
        }
      } else if (n.type === 'agent_condition') {
        const prompt = ((n.data as any)?.config?.prompt || '').trim()
        if (!prompt) {
          const label = (n.data as any)?.displayName || n.id
          errors.push(t('workflow.editor.agentMissingPrompt', { label }))
        }
      }
    }
    return errors
  }

  // ===== 保存 =====
  async function saveWorkflow() {
    // workflow 名校验:trim 非空 + 长度 ≤ 255
    const trimmedName = (workflow.name || '').trim()
    if (!trimmedName) {
      notifications.show({ color: 'yellow', message: t('workflow.editor.nameRequired') })
      return
    }
    if (trimmedName.length > 255) {
      notifications.show({ color: 'yellow', message: t('workflow.editor.nameTooLong', { len: trimmedName.length }) })
      return
    }
    // 写回 trimmed 值,保证保存到 DB 的名字干净
    const cleanWorkflow = { ...workflow, name: trimmedName }
    setWorkflow(cleanWorkflow)

    // client 校验:失败时自动选中第一个出错节点,引导用户去补
    const errs = validateGraphBeforeSave()
    if (errs.length) {
      notifications.show({
        color: 'yellow',
        message: t('workflow.editor.fixBeforeSave') + '\n' + errs.join('\n'),
        autoClose: 5000,
      })
      const firstBad = nodes.find((n: any) => {
        if (n.type === 'condition') {
          return !((n.data as any)?.config?.expression || '').trim()
        }
        if (n.type === 'agent_condition') {
          return !((n.data as any)?.config?.prompt || '').trim()
        }
        return false
      })
      if (firstBad) setSelectedNodeId(firstBad.id)
      return
    }
    const graph = {
      nodes: nodes.map((n: any) => ({
        id: n.id,
        type: n.type,
        config: {
          ...n.data.config,
          ...cleanedParams(n.data.config),
          ...(n.data.displayName ? { display_name: n.data.displayName } : {}),
          // 2026-06-01:存画布布局,避免重新打开时丢失用户摆位
          position: n.position
            ? { x: Math.round(n.position.x), y: Math.round(n.position.y) }
            : undefined,
        },
      })),
      edges: edges.map((e: any) => {
        const branch = e.sourceHandle || e.label
        return {
          source: e.source,
          target: e.target,
          ...(branch ? { branch } : {}),
        }
      }),
    }
    setSaving(true)
    try {
      if (workflowId) {
        await updateWorkflowReq(projectId, workflowId, {
          name: cleanWorkflow.name,
          trigger: cleanWorkflow.trigger,
          graph,
        })
        notifications.show({ color: 'green', message: t('workflow.editor.saveSuccess') })
      } else {
        await createWorkflowReq(projectId, {
          name: cleanWorkflow.name,
          trigger: cleanWorkflow.trigger,
          graph,
        })
        notifications.show({ color: 'green', message: t('workflow.editor.createSuccess') })
      }
      // 保存成功 → 让 isDirty 回到 false,避免 goBack 触发"未保存"提示
      setInitialSnapshot(currentSnapshotRef.current())
      // 成功后回到 workflow 列表
      goBack(true)
    } catch (e: any) {
      notifications.show({ color: 'red', message: t('workflow.editor.saveFailed') + (e.response?.data?.message || e.message || e) })
    } finally {
      setSaving(false)
    }
  }

  // 保存成功后 goBack 需要绕过 dirty 拦截(snapshot 刚 reset,但 isDirty 本帧可能未更新)
  function goBack(_skipBlock = false) {
    // 去业务层:工作流列表挂在项目设置(原 /business/:businessId/ 路径已移除)
    navigate('/agent#workflows')
  }

  // ===== 试运行 dialog =====
  async function openRunDialog() {
    if (!canTriggerRun) return
    setRunForm({ origin_session_id: '', query: '' })
    setRunDialogVisible(true)
    await loadSessionsForRun()
  }

  async function loadSessionsForRun() {
    setSessionsLoading(true)
    try {
      const res = await getSessionList(projectId, {
        page: 1,
        per_page: 50,
        order_by: 'updated_at',
        order_desc: true,
      })
      setSessions(res.data?.items || [])
    } catch (e: any) {
      notifications.show({ color: 'yellow', message: t('workflow.editor.loadSessionFailed') + (e.message || e) })
      setSessions([])
    } finally {
      setSessionsLoading(false)
    }
  }

  async function handleTriggerRun() {
    if (!runForm.origin_session_id || !runForm.query) {
      notifications.show({ color: 'yellow', message: t('workflow.editor.fillAll') })
      return
    }
    setRunSubmitting(true)
    try {
      const res = await triggerWorkflowRunReq(projectId, workflowId, runForm)
      const run = res.data || null
      setRunDialogVisible(false)
      if (!run) {
        notifications.show({ color: 'red', message: t('workflow.editor.triggerEmpty') })
        return
      }
      const shortId = (run.id || '').slice(0, 8)
      const nodeCount = Array.isArray(run.node_runs) ? run.node_runs.length : 0
      if (isStatusSuccess(run.status)) {
        notifications.show({
          color: 'green',
          message: t('workflow.editor.runSuccess', { id: shortId, count: nodeCount }),
          autoClose: 4000,
        })
      } else if (isStatusFailed(run.status)) {
        // 失败:多行展示 error 全文 + 节点数,持续显示
        // run.error 是后端文本,这里不用 HTML 渲染避免 XSS
        notifications.show({
          color: 'red',
          title: t('workflow.editor.runFailTitle', { id: shortId }),
          message: t('workflow.editor.runFailMsg', { count: nodeCount, error: run.error || t('workflow.list.unknownError') }),
          autoClose: false,
          className: 'workflow-run-notify',
        })
      } else {
        notifications.show({ color: 'blue', message: t('workflow.editor.runStatusMsg', { status: statusLabel(run.status), id: shortId }) })
      }
      // 同步每节点 status + meta 到画布
      syncRunStatusToNodes(run)
    } catch (e: any) {
      notifications.show({ color: 'red', message: t('workflow.editor.triggerFailed') + (e.response?.data?.message || e.message || e) })
    } finally {
      setRunSubmitting(false)
    }
  }

  function formatSessionTime(iso: string) {
    if (!iso) return '-'
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  // ===== 渲染 =====
  return (
    <WorkflowCatalogContext.Provider value={catalog}>
      <div className={styles.workflowEditor}>
        {/* 顶栏:面包屑 + workflow 名 + 保存 */}
        <div className={styles.toolbar}>
          <div className={styles.breadcrumb}>
            <span className={styles.bcItem}>{projectName}</span>
            <span className={styles.bcSep}><IconArrowRight size={12} /></span>
            <span className={styles.bcItem}>{businessName || t('workflow.editor.businessFallback')}</span>
            <span className={styles.bcSep}><IconArrowRight size={12} /></span>
            <span className={`${styles.bcItem} ${styles.bcCurrent}`}>{workflow.name || t('workflow.editor.untitledWorkflow')}</span>
          </div>
          <Divider orientation="vertical" />
          <TextInput
            value={workflow.name}
            onChange={(e) => setWorkflow((wf: any) => ({ ...wf, name: e.currentTarget.value }))}
            placeholder={t('workflow.editor.namePlaceholder')}
            style={{ width: 200 }}
          />
          <Tooltip label={triggerSummaryPreview || t('workflow.editor.triggerUnsetTip')} position="bottom">
            <Button
              variant="light"
              color={triggerConfigured ? 'green' : 'yellow'}
              onClick={openTriggerDialog}
              leftSection={<IconTarget size={16} />}
            >
              {triggerConfigured ? t('workflow.editor.triggerConfigured') : t('workflow.editor.triggerConfigure')}
              {workflow.trigger.examples.length ? (
                <span style={{ marginLeft: 4, opacity: 0.7 }}>
                  ({t('workflow.editor.exampleCount', { count: workflow.trigger.examples.length })})
                </span>
              ) : null}
            </Button>
          </Tooltip>
          <div className={styles.toolbarRight}>
            <Tooltip label={canTriggerRun ? t('workflow.editor.dryRunTip') : t('workflow.editor.dryRunNeedSave')} position="bottom">
              <Button variant="default" disabled={!canTriggerRun} onClick={openRunDialog}>
                {t('workflow.editor.dryRun')}
              </Button>
            </Tooltip>
            <Button color="blue" loading={saving} onClick={saveWorkflow}>{t('workflow.editor.save')}</Button>
            <Tooltip label={t('workflow.editor.backTip')} position="bottom">
              <Button variant="default" onClick={() => goBack()} leftSection={<IconArrowBack size={16} />}>
                {t('workflow.editor.back')}
              </Button>
            </Tooltip>
          </div>
        </div>

        {/* 触发 run dialog */}
        <Modal opened={runDialogVisible} onClose={() => setRunDialogVisible(false)} title={t('workflow.editor.runDialogTitle')} size={520}>
          <TextInput label="Workflow" value={workflow.name} disabled mb="sm" />
          <Select
            label={t('workflow.editor.sessionLabel')}
            withAsterisk
            searchable
            value={runForm.origin_session_id || null}
            onChange={(v) => setRunForm((f: any) => ({ ...f, origin_session_id: v || '' }))}
            placeholder={sessions.length ? t('workflow.editor.sessionPlaceholder') : t('workflow.editor.sessionEmptyPlaceholder')}
            disabled={sessionsLoading}
            nothingFoundMessage={t('workflow.editor.sessionNoData')}
            data={sessions.map((s: any) => ({
              value: s.id,
              label: `${s.title}  ·  ${formatSessionTime(s.updated_at)}`,
            }))}
            mb="sm"
          />
          <Textarea
            label="Query"
            withAsterisk
            value={runForm.query}
            onChange={(e) => setRunForm((f: any) => ({ ...f, query: e.currentTarget.value }))}
            minRows={3}
            autosize
            mb="md"
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="default" onClick={() => setRunDialogVisible(false)}>{t('workflow.editor.cancel')}</Button>
            <Button color="blue" loading={runSubmitting} onClick={handleTriggerRun}>{t('workflow.editor.trigger')}</Button>
          </div>
        </Modal>

        {/* 触发条件配置 dialog */}
        <Modal opened={triggerDialogVisible} onClose={() => setTriggerDialogVisible(false)} title={t('workflow.editor.triggerConfigure')} size={640}>
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
              <span>{t('workflow.editor.trigSummary')}</span>
              <Tooltip label={t('workflow.editor.trigSummaryTip')} position="top">
                <span style={{ marginLeft: 4, color: '#909399', display: 'inline-flex' }}>
                  <IconHelpCircleFilled size={14} />
                </span>
              </Tooltip>
            </div>
            <Textarea
              value={triggerForm.summary}
              onChange={(e) => setTriggerForm((f: any) => ({ ...f, summary: e.currentTarget.value }))}
              minRows={3}
              autosize
              placeholder={t('workflow.editor.trigSummaryPlaceholder')}
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
              <span>{t('workflow.editor.trigExamples')}</span>
              <Tooltip label={t('workflow.editor.trigExamplesTip')} position="top">
                <span style={{ marginLeft: 4, color: '#909399', display: 'inline-flex' }}>
                  <IconHelpCircleFilled size={14} />
                </span>
              </Tooltip>
            </div>
            <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {!triggerForm.examples.length && (
                <div style={{ color: '#c0c4cc', fontSize: 12 }}>{t('workflow.editor.trigNoExample')}</div>
              )}
              {triggerForm.examples.map((ex: string, idx: number) => (
                <div key={idx} style={{ display: 'flex', gap: 8, alignItems: 'center', width: '100%' }}>
                  <span style={{ color: '#909399', minWidth: 24 }}>{idx + 1}.</span>
                  <TextInput
                    value={ex}
                    onChange={(e) => setExample(idx, e.currentTarget.value)}
                    placeholder={t('workflow.editor.trigExamplePlaceholder')}
                    style={{ flex: 1 }}
                  />
                  <Button variant="light" color="red" size="compact-sm" px={8} onClick={() => removeExample(idx)}>
                    <IconTrash size={14} />
                  </Button>
                </div>
              ))}
              <div style={{ marginTop: 4 }}>
                <Button variant="light" color="blue" size="xs" leftSection={<IconPlus size={14} />} onClick={addExample}>
                  {t('workflow.editor.trigAddExample')}
                </Button>
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="default" onClick={() => setTriggerDialogVisible(false)}>{t('workflow.editor.cancel')}</Button>
            <Button color="blue" onClick={applyTriggerForm}>{t('workflow.editor.confirm')}</Button>
          </div>
        </Modal>

        <div className={styles.editorBody}>
          {/* 左侧:节点工具箱 */}
          <NodePalette
            catalog={catalog}
            capabilities={capabilities}
            defaultExpanded={paletteDefaultExpanded}
            refreshing={refreshingPalette}
            onCardDragstart={onCardDragStart}
            onCardDragend={onCardDragEnd}
            onCardHover={onCardHover}
            onRefresh={refreshPalette}
          />

          {/* 中间:画布 */}
          <div className={styles.canvas} onDragOver={onCanvasDragOver} onDrop={onCanvasDrop}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              nodeTypes={nodeTypes}
              deleteKeyCode={['Delete']}
              onNodeClick={onNodeClick}
              onPaneClick={() => setSelectedNodeId(null)}
              onConnect={onConnect}
              fitView
            >
              <Background />
            </ReactFlow>

            {!nodes.length && (
              <div className={styles.canvasEmpty}>{t('workflow.editor.canvasEmpty')}</div>
            )}
          </div>

          {/* 右侧:节点属性面板 */}
          <div className={styles.propertyPanel}>
            <h3>{t('workflow.editor.panelTitle')}</h3>
            {!selectedNode ? (
              <div className={styles.empty}>{t('workflow.editor.panelEmpty')}</div>
            ) : (
              <div>
                {/* 节点头部信息 */}
                <div className={styles.panelNodeHeader}>
                  <span className={styles.panelIcon} style={{ color: selectedCardAccent }}>
                    <SelectedCardIcon size={20} color={selectedCardAccent} />
                  </span>
                  <div className={styles.panelNodeMeta}>
                    <div className={styles.panelNodeName}>{selectedCardName}</div>
                    <div className={styles.panelNodeTech}>
                      {(selectedNode.data as any).config?.tool_name || selectedNode.type}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <TextInput label={t('workflow.panel.nodeId')} value={selectedNode.id} disabled />
                  <TextInput
                    label={t('workflow.editor.displayName')}
                    value={(selectedNode.data as any).displayName}
                    placeholder={t('workflow.editor.displayNamePlaceholder')}
                    onChange={(e) => setNodeDataField('displayName', e.currentTarget.value)}
                  />

                  {/* Tool 节点参数 */}
                  {selectedNode.type === 'tool' && (
                    <>
                      {editableToolInputs.map((input: any) => {
                        const paramVal = (selectedNode.data as any).config.params?.[input.name]
                        return (
                          <div key={input.name} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <div style={{ fontSize: 13, fontWeight: 500, color: '#606266' }}>{inputLabel(input)}</div>

                            {/* upstream 类型 → 下拉列上游 table 端口(filterable allow-create:
                                Mantine v7 用 Autocomplete 兼顾"选下拉项 + 手输自定义值") */}
                            {input.source === 'upstream' ? (
                              <Autocomplete
                                value={paramVal ?? ''}
                                placeholder={t('workflow.editor.upstreamPlaceholder')}
                                onChange={(v) => setParam(input.name, v)}
                                data={upstreamTableRefs.map((r: any) => ({ value: r.value, label: r.label }))}
                              />
                            ) : input.name === 'extract_schema' ? (
                              /* extract_schema:可视化字段编辑器 */
                              <ExtractSchemaEditor
                                modelValue={(selectedNode.data as any).config.params?.[input.name] || []}
                                question={(selectedNode.data as any).config.params?.question || ''}
                                onUpdateModelValue={(v: any) => setParam(input.name, v)}
                              />
                            ) : input.name === 'fallback_skip_nodes' ? (
                              /* fallback_skip_nodes:多选下拉 */
                              <MultiSelect
                                searchable
                                value={(selectedNode.data as any).config.params?.[input.name] || []}
                                placeholder={t('workflow.panel.fallbackSkipNodesPlaceholder', '选下游节点(失败时一并跳过)')}
                                onChange={(v) => setParam(input.name, v)}
                                data={otherNodeOptions}
                              />
                            ) : input.type === 'list' && input.name.endsWith('_columns') ? (
                              /* *_columns(join 左右列名):多选勾选 + 可手输
                                 (Mantine v7 用 TagsInput 兼顾"勾候选列 + allow-create 自定义列名") */
                              <TagsInput
                                value={(selectedNode.data as any).config.params?.[input.name] || []}
                                placeholder={t('workflow.panel.columnsPlaceholder', '勾选参与语义判断的列(可手输)')}
                                onChange={(v) => setParam(input.name, v)}
                                data={columnsCandidatesFor(input)}
                              />
                            ) : input.type === 'list' || input.type === 'dict' ? (
                              /* 其他 list / dict 类型 → 简单 JSON textarea(fallback) */
                              <Textarea
                                minRows={3}
                                autosize
                                defaultValue={paramAsJson(input.name)}
                                placeholder={input.description}
                                onBlur={(e) => setParamFromJson(input.name, e.currentTarget.value)}
                              />
                            ) : input.type === 'number' ? (
                              /* number */
                              <NumberInput
                                value={(selectedNode.data as any).config.params?.[input.name] ?? input.default}
                                onChange={(v) => setParam(input.name, v)}
                              />
                            ) : input.name === 'prompt_template' ? (
                              /* prompt_template:弹窗大编辑 */
                              <PromptDialogField
                                modelValue={(selectedNode.data as any).config.params?.[input.name] || ''}
                                label={input.name}
                                placeholder={input.description}
                                onUpdateModelValue={(v: any) => setParam(input.name, v)}
                              />
                            ) : (
                              /* 默认 string */
                              <Textarea
                                value={(selectedNode.data as any).config.params?.[input.name] || ''}
                                placeholder={stringInputPlaceholder(input)}
                                minRows={2}
                                autosize
                                onChange={(e) => setParam(input.name, e.currentTarget.value)}
                              />
                            )}

                            {input.default ? (
                              <div className={styles.hintDesc} style={{ color: '#67c23a' }}>
                                {t('workflow.editor.useDefault')}<code>{formatDefaultForHint(input.default)}</code>
                              </div>
                            ) : input.description ? (
                              <div className={styles.hintDesc}>{input.description}</div>
                            ) : null}
                          </div>
                        )
                      })}

                      {selectedCard?.business?.costNote && (
                        <div className={styles.costPanel}>
                          <strong>{t('workflow.editor.costEstimate')}</strong>{selectedCard.business.costNote}
                          {selectedCard.business.suggestion && (
                            <div className={styles.costSuggestion}>💡 {selectedCard.business.suggestion}</div>
                          )}
                        </div>
                      )}
                    </>
                  )}

                  {/* Condition 节点参数(P26)*/}
                  {selectedNode.type === 'condition' && (
                    <>
                      <div className={styles.condHint} dangerouslySetInnerHTML={{ __html: t('workflow.editor.condHint') }} />
                      <Select
                        label={t('workflow.editor.condWatchNode')}
                        value={conditionForm.upstreamNodeId || null}
                        placeholder={t('workflow.editor.condWatchNodePlaceholder')}
                        searchable
                        onChange={(v) => updateConditionForm('upstreamNodeId', v)}
                        data={conditionUpstreamCandidates.map((n: any) => ({ value: n.id, label: n.label }))}
                      />
                      <Select
                        label={t('workflow.editor.condCheck')}
                        value={conditionForm.check || null}
                        placeholder={t('workflow.editor.condCheckPlaceholder')}
                        onChange={(v) => updateConditionForm('check', v)}
                        data={[
                          { value: 'status_ok', label: t('workflow.editor.condOpt.statusOk') },
                          { value: 'status_fail', label: t('workflow.editor.condOpt.statusFail') },
                          { value: 'has_question', label: t('workflow.editor.condOpt.hasQuestion') },
                          { value: 'has_schema_hint', label: t('workflow.editor.condOpt.hasSchemaHint') },
                          { value: 'has_entities', label: t('workflow.editor.condOpt.hasEntities') },
                          { value: 'has_metrics', label: t('workflow.editor.condOpt.hasMetrics') },
                          { value: 'has_failure_reason', label: t('workflow.editor.condOpt.hasFailureReason') },
                          { value: 'has_custom_key', label: t('workflow.editor.condOpt.hasCustomKey') },
                        ]}
                      />
                      {conditionForm.check === 'has_custom_key' && (
                        <TextInput
                          label={t('workflow.editor.condCustomKey')}
                          value={conditionForm.customKey}
                          placeholder={t('workflow.editor.condCustomKeyPlaceholder')}
                          onChange={(e) => updateConditionForm('customKey', e.currentTarget.value)}
                        />
                      )}
                      <div>
                        <Textarea
                          label={t('workflow.editor.condExpression')}
                          value={(selectedNode.data as any).config.expression || ''}
                          minRows={2}
                          autosize
                          readOnly
                          styles={{ input: { fontFamily: 'monospace', color: '#475569' } }}
                        />
                        <div className={styles.hintDesc}>{t('workflow.editor.condExpressionHint')}</div>
                      </div>
                    </>
                  )}

                  {/* AgentCondition 节点参数 */}
                  {selectedNode.type === 'agent_condition' && (
                    <>
                      <div
                        className={styles.condHint}
                        style={{ background: '#fef3c7', borderLeftColor: '#f59e0b', color: '#92400e' }}
                        dangerouslySetInnerHTML={{ __html: t('workflow.editor.agentCondHint') }}
                      />
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 500, color: '#606266', marginBottom: 2 }}>Prompt *</div>
                        <PromptDialogField
                          modelValue={(selectedNode.data as any).config.prompt || ''}
                          label="Prompt"
                          placeholder={t('workflow.editor.promptPlaceholder')}
                          refs={availableNodeRefs}
                          examples={agentConditionExamples}
                          onUpdateModelValue={(v: any) => setNodeConfigField('prompt', v)}
                          hint={
                            <span
                              dangerouslySetInnerHTML={{
                                __html: t('workflow.editor.agentCondPromptHint', { ctxHint: ctxTemplateHint, nodeHint: nodeTemplateHint }),
                              }}
                            />
                          }
                        />
                      </div>
                      <TextInput
                        label={t('workflow.editor.model')}
                        value={(selectedNode.data as any).config.model_id || ''}
                        placeholder={t('workflow.editor.modelPlaceholder')}
                        onChange={(e) => setNodeConfigField('model_id', e.currentTarget.value || null)}
                      />
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 500, color: '#606266', marginBottom: 8 }}>Temperature</div>
                        <Slider
                          value={(selectedNode.data as any).config.temperature ?? 0.2}
                          min={0}
                          max={1}
                          step={0.1}
                          style={{ maxWidth: 280 }}
                          onChange={(v) => setNodeConfigField('temperature', v)}
                        />
                        <div className={styles.hintDesc}>{t('workflow.editor.tempHint')}</div>
                      </div>
                    </>
                  )}

                  {/* Operator 节点(老 workflow 兼容)*/}
                  {selectedNode.type === 'operator' && (
                    <div className={styles.operatorNote}>{t('workflow.editor.operatorNote')}</div>
                  )}

                  <div>
                    <Button color="red" size="xs" onClick={deleteSelectedNode}>
                      {t('workflow.panel.deleteNode')}
                    </Button>
                  </div>
                </div>

                {/* 出边管理 */}
                <h4 className={styles.sectionTitle}>{t('workflow.editor.outEdgesTitle')}</h4>
                {nodeOutEdges.map((edge: any) => (
                  <div key={edge.id} className={styles.edgeItem}>
                    {/* condition/agent_condition 出边加 ✓True/✗False 视觉标识(P27)*/}
                    {['condition', 'agent_condition'].includes(selectedNode.type || '') && (
                      <span
                        className={`${styles.edgeBranchBadge} ${
                          edge.sourceHandle === 'true'
                            ? styles.branchTrue
                            : edge.sourceHandle === 'false'
                              ? styles.branchFalse
                              : styles.branchNone
                        }`}
                      >
                        {edge.sourceHandle === 'true' ? '✓ True' : edge.sourceHandle === 'false' ? '✗ False' : '?'}
                      </span>
                    )}
                    <span>→ {targetDisplayName(edge.target)}</span>
                    {['condition', 'agent_condition'].includes(selectedNode.type || '') && (
                      <Select
                        value={edge.sourceHandle || null}
                        size="xs"
                        style={{ width: 100, marginLeft: 8 }}
                        onChange={(v) => v && syncEdgeBranch(edge.id, v)}
                        data={[
                          { value: 'true', label: t('workflow.editor.branchTrueOpt') },
                          { value: 'false', label: t('workflow.editor.branchFalseOpt') },
                        ]}
                      />
                    )}
                    <Button size="compact-xs" color="red" variant="subtle" onClick={() => removeEdge(edge.id)}>×</Button>
                  </div>
                ))}
                <div className={styles.addEdgeRow}>
                  <Select
                    value={newEdgeTarget || null}
                    placeholder={t('workflow.editor.selectTarget')}
                    size="xs"
                    style={{ width: 180 }}
                    onChange={(v) => setNewEdgeTarget(v || '')}
                    data={availableTargets.map((n: any) => ({ value: n.id, label: targetDisplayName(n.id) }))}
                  />
                  <Button size="xs" variant="default" onClick={addEdgeManual}>{t('workflow.editor.addEdge')}</Button>
                </div>
              </div>
            )}
          </div>

          {/* 最右侧:节点 IO 契约面板(只对 Tool 节点显示)*/}
          {selectedNode && selectedCard?.spec && (
            <div className={styles.ioContractPanel}>
              <h3>{t('workflow.editor.contractTitle')}</h3>
              <div className={styles.ioSection}>
                <div className={styles.ioSectionTitle}>{t('workflow.editor.contractInputs')}</div>
                {!selectedToolInputs.length && (
                  <div className={styles.ioEmpty}>{t('workflow.editor.contractNone')}</div>
                )}
                {selectedToolInputs.map((i: any) => (
                  <div key={`in-${i.name}`} className={styles.ioPort}>
                    <div className={styles.ioPortHead}>
                      <code className={styles.ioPortName}>{i.name}</code>
                      <span className={styles.ioPortType}>{i.type}</span>
                      {i.required && <span className={styles.ioPortRequired}>{t('workflow.panel.required')}</span>}
                      <span className={`${styles.ioPortSource} ${sourceClass(i.source)}`}>{inputSourceLabel(i.source)}</span>
                    </div>
                    {i.description && <div className={styles.ioPortDesc}>{i.description}</div>}
                    {i.default && (
                      <div className={styles.ioPortDefault}>
                        {t('workflow.editor.contractDefault')}<code>{formatDefaultForHint(i.default)}</code>
                      </div>
                    )}
                    {i.source !== 'schema' && (
                      <div className={styles.ioPortSuppliers}>
                        <div className={styles.ioPortSupliersLabel}>{t('workflow.editor.contractSuppliers')}</div>
                        <div className={styles.ioPortTags}>
                          {upstreamSuppliersForInput(i.name).length ? (
                            upstreamSuppliersForInput(i.name).map((s: any) => (
                              <Badge
                                key={s.toolName}
                                size="sm"
                                variant="outline"
                                className={styles.ioTag}
                                title={t('workflow.editor.supplyTitle', { name: s.outputName, type: s.outputType })}
                              >
                                {s.businessName}
                              </Badge>
                            ))
                          ) : (
                            <span className={styles.ioEmptyInline}>{t('workflow.editor.contractNoSupplier')}</span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div className={styles.ioSection}>
                <div className={styles.ioSectionTitle}>{t('workflow.editor.contractOutputs')}</div>
                {!(selectedCard.spec.outputs || []).length && (
                  <div className={styles.ioEmpty}>{t('workflow.editor.contractNone')}</div>
                )}
                {(selectedCard.spec.outputs || []).map((o: any) => (
                  <div key={`out-${o.name}`} className={styles.ioPort}>
                    <div className={styles.ioPortHead}>
                      <code className={styles.ioPortName}>{o.name}</code>
                      <span className={styles.ioPortType}>{o.type}</span>
                      {o.serializable === false && (
                        <span className={styles.ioPortNonserial} title={t('workflow.editor.contractInMemoryTip')}>
                          {t('workflow.editor.contractInMemory')}
                        </span>
                      )}
                    </div>
                    <div className={styles.ioPortRef}>
                      {t('workflow.editor.contractRefSyntax')}<code>{outputRefSyntax(o.name)}</code>
                    </div>
                    <div className={styles.ioPortConsumers}>
                      <div className={styles.ioPortSupliersLabel}>{t('workflow.editor.contractConsumers')}</div>
                      <div className={styles.ioPortTags}>
                        {downstreamConsumersForOutput(o.name).length ? (
                          downstreamConsumersForOutput(o.name).map((c: any) => (
                            <Badge
                              key={c.toolName}
                              size="sm"
                              color={c.matchKind === 'strong' ? 'green' : 'gray'}
                              variant="outline"
                              className={styles.ioTag}
                              title={c.matchKind === 'strong'
                                ? t('workflow.editor.consumeStrongTitle', { name: c.inputName, type: c.inputType })
                                : t('workflow.editor.consumeFallbackTitle', { name: c.inputName })}
                            >
                              {c.businessName}
                              {c.matchKind === 'fallback' && (
                                <span className={styles.ioTagHint}>{t('workflow.editor.contractFallback')}</span>
                              )}
                            </Badge>
                          ))
                        ) : (
                          <span className={styles.ioEmptyInline}>
                            {t('workflow.editor.contractNoConsumerPre')}<code>{outputRefHint(o.name)}</code>)
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* condition / agent_condition 控制流节点契约 */}
          {selectedNode && isConditionNode && (
            <div className={styles.ioContractPanel}>
              <h3>{t('workflow.editor.contractTitle')}</h3>
              <div className={styles.ioSection}>
                <div className={styles.ioSectionTitle}>{t('workflow.editor.condContractInputs')}</div>
                <div className={styles.ioFlowNote}>
                  {t('workflow.editor.condContractNote', {
                    mode: selectedNode.type === 'agent_condition'
                      ? t('workflow.editor.condContractModePrompt')
                      : t('workflow.editor.condContractModeExpr'),
                  })}
                </div>
                {conditionContextRefs.map((r: any) => (
                  <div key={`cc-${r.name}`} className={styles.ioPort}>
                    <div className={styles.ioPortHead}>
                      <code className={styles.ioPortName}>{r.name}</code>
                      <span className={styles.ioPortType}>{r.type}</span>
                      <span className={`${styles.ioPortSource} ${sourceClassRaw(r.srcClass)}`}>{r.from}</span>
                    </div>
                    <div className={styles.ioPortRef}>{t('workflow.editor.contractRefSyntax')}<code>{r.ref}</code></div>
                  </div>
                ))}
              </div>
              <div className={styles.ioSection}>
                <div className={styles.ioSectionTitle}>{t('workflow.editor.condContractOutputs')}</div>
                <div className={styles.ioPort}>
                  <div className={styles.ioPortHead}>
                    <code className={styles.ioPortName}>true</code>
                    <span className={styles.ioPortType}>branch</span>
                  </div>
                  <div className={styles.ioPortDesc} dangerouslySetInnerHTML={{ __html: t('workflow.editor.condContractTrue') }} />
                </div>
                <div className={styles.ioPort}>
                  <div className={styles.ioPortHead}>
                    <code className={styles.ioPortName}>false</code>
                    <span className={styles.ioPortType}>branch</span>
                  </div>
                  <div className={styles.ioPortDesc} dangerouslySetInnerHTML={{ __html: t('workflow.editor.condContractFalse') }} />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </WorkflowCatalogContext.Provider>
  )
}

// input.source → CSS module 类名(source-user / source-upstream / source-schema)
function sourceClass(source: string): string {
  if (source === 'upstream') return styles.sourceUpstream
  if (source === 'schema') return styles.sourceSchema
  if (source === 'ctx') return styles.sourceCtx
  return styles.sourceUser
}
// conditionContextRefs 里的 srcClass 是 'source-ctx' / 'source-upstream' 字面量
function sourceClassRaw(raw: string): string {
  if (raw === 'source-upstream') return styles.sourceUpstream
  if (raw === 'source-schema') return styles.sourceSchema
  if (raw === 'source-ctx') return styles.sourceCtx
  return styles.sourceUser
}

// 默认导出:用 ReactFlowProvider 包裹,使内部组件可用 useReactFlow()
// (对应 Vue 的 useVueFlow,需在 <VueFlow> 上下文内)
export default function WorkflowEditor() {
  const navigate = useNavigate()
  return (
    <ReactFlowProvider>
      <WorkflowEditorInner navigate={navigate} />
    </ReactFlowProvider>
  )
}
