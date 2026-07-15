// 从 Vue 迁移：views/database/components/RelationshipERDiagram.vue
// Vue Flow ER 图 → @xyflow/react；dagre 布局；节点是表、边是外键关系
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Handle,
  Position,
  MarkerType,
  useReactFlow,
  type NodeTypes,
} from '@xyflow/react'
import dagre from 'dagre'
import {
  Modal,
  Drawer,
  Button,
  TextInput,
  Textarea,
  Select,
  Checkbox,
  Tooltip,
  Accordion,
  LoadingOverlay,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import {
  IconPlus,
  IconWand,
  IconTable,
  IconEdit,
  IconTrash,
  IconChevronLeft,
  IconChevronRight,
  IconChevronDown,
  IconChevronUp,
  IconRefresh,
  IconPencil,
  IconSearch,
  IconSettings,
} from '@tabler/icons-react'
import {
  getRelationshipsReq,
  createRelationshipReq,
  updateRelationshipReq,
  deleteRelationshipReq,
  discoverRelationshipsReq,
  batchCreateRelationshipsReq,
  aiSuggestRelationshipsReq,
  getTableColumnsReq,
  getCachedTablesReq,
} from '@/api/database'
import { useProjectStore } from '@/store/project'
import RelationManualForm from './RelationManualForm'
import styles from './RelationshipERDiagram.module.scss'

// 当前项目 id（非响应式读取，等价 Pinia projectStore.currentProjectId）
const getCurrentProjectId = () => useProjectStore.getState().currentProject?.id || null

const COLLAPSED_LIMIT = 8

export interface RelationshipERDiagramProps {
  databaseId: string
  selectedTableId?: string
  // defineEmits(['table-click'])
  onTableClick?: (payload: any) => void
}

export interface RelationshipERDiagramHandle {
  loadRelationships: () => Promise<void>
}

// 格式化关系类型
const formatRelType = (type: string) => {
  const map: Record<string, string> = {
    many_to_one: 'N:1',
    one_to_one: '1:1',
    many_to_many: 'N:N',
    one_to_many: '1:N',
  }
  return map[type] || type
}

const scoreClass = (score: number) => {
  if (score >= 0.8) return styles.scoreHigh
  if (score >= 0.6) return styles.scoreMedium
  return styles.scoreLow
}

// ─────────────────────────────────────────────
// 自定义表节点（对应 VueFlow #node-table 插槽）
// 由于 xyflow 节点组件只接收 data，因此把交互所需的回调/状态全部放进 data
// ─────────────────────────────────────────────
function TableNode({ id, data }: { id: string; data: any }) {
  const {
    label,
    columns = [],
    totalColumns = 0,
    highlighted,
    searchMatch,
    selectedTableId,
    searchQuery,
    expanded,
    onToggleExpand,
  } = data

  const visibleColumns = expanded ? columns : columns.slice(0, COLLAPSED_LIMIT)

  const nodeCls = [
    styles.tableNode,
    highlighted ? styles.highlighted : '',
    selectedTableId === id ? styles.selected : '',
    searchQuery && !searchMatch ? styles.dimmed : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={nodeCls}>
      <div className={styles.tableNodeHeader}>
        <IconTable size={14} />
        <span className={styles.tableNodeTitle}>{label}</span>
        <span className={styles.tableNodeCount}>{totalColumns}</span>
      </div>
      <div className={styles.tableNodeColumns}>
        {visibleColumns.map((col: any) => {
          const colCls = [
            styles.columnRow,
            col.is_primary_key ? styles.pkColumn : '',
            col.is_foreign_key || col.is_relation_source || col.is_relation_target
              ? styles.fkColumn
              : '',
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <div key={col.column_name} className={colCls}>
              <Handle
                type="source"
                position={Position.Right}
                id={`${col.column_name}-source`}
                className={`${styles.columnHandle} ${styles.columnHandleRight}`}
              />
              <Handle
                type="target"
                position={Position.Left}
                id={`${col.column_name}-target`}
                className={`${styles.columnHandle} ${styles.columnHandleLeft}`}
              />
              <span className={styles.columnIcon}>
                {col.is_primary_key
                  ? '🔑'
                  : col.is_foreign_key || col.is_relation_source
                    ? '🔗'
                    : '·'}
              </span>
              <span className={styles.columnName}>{col.column_name}</span>
              <span className={styles.columnType}>{col.data_type}</span>
            </div>
          )
        })}
        {totalColumns > COLLAPSED_LIMIT && !expanded && (
          <div
            className={`${styles.columnRow} ${styles.toggleBtn}`}
            onClick={(e) => {
              e.stopPropagation()
              onToggleExpand?.(id)
            }}
          >
            <span className={styles.columnIcon}>
              <IconChevronDown size={12} />
            </span>
            <span className={styles.columnName}>{data.expandLabel}</span>
          </div>
        )}
        {expanded && totalColumns > COLLAPSED_LIMIT && (
          <div
            className={`${styles.columnRow} ${styles.toggleBtn}`}
            onClick={(e) => {
              e.stopPropagation()
              onToggleExpand?.(id)
            }}
          >
            <span className={styles.columnIcon}>
              <IconChevronUp size={12} />
            </span>
            <span className={styles.columnName}>{data.collapseLabel}</span>
          </div>
        )}
      </div>
    </div>
  )
}

// 内部实现：依赖 useReactFlow（fitView），需放在 ReactFlowProvider 内
const InnerERDiagram = forwardRef<RelationshipERDiagramHandle, RelationshipERDiagramProps>(
  function InnerERDiagram(props, ref) {
    const { databaseId, selectedTableId = '', onTableClick } = props
    const { t } = useTranslation()
    const { fitView } = useReactFlow()

    const canvasRef = useRef<HTMLDivElement>(null)

    const [tables, setTables] = useState<any[]>([])
    const [graphLoading, setGraphLoading] = useState(false)
    const [relationships, setRelationships] = useState<any[]>([])
    const [nodes, setNodes] = useState<any[]>([])
    const [edges, setEdges] = useState<any[]>([])
    const [listCollapsed, setListCollapsed] = useState(false)
    const [discovering, setDiscovering] = useState(false)
    const [discoverCandidates, setDiscoverCandidates] = useState<any[]>([])
    const [discoverStats, setDiscoverStats] = useState<any>(null)
    const [discoverSkipped, setDiscoverSkipped] = useState<any[]>([])
    const [saving, setSaving] = useState(false)
    const [dialogVisible, setDialogVisible] = useState(false)
    const [editingRelationship, setEditingRelationship] = useState<any>(null)

    // 连线确认
    const [pendingConnection, setPendingConnection] = useState<any>(null)
    const [connectDialogVisible, setConnectDialogVisible] = useState(false)

    // 管理抽屉
    const [manageDrawerVisible, setManageDrawerVisible] = useState(false)
    const [manageSearchQuery, setManageSearchQuery] = useState('')

    // 搜索状态
    const [searchQuery, setSearchQuery] = useState('')

    // 添加关系对话框模式
    const [addMode, setAddMode] = useState('ai')
    const [aiHint, setAiHint] = useState('')
    const [aiLoading, setAiLoading] = useState(false)
    const [aiSuggestions, setAiSuggestions] = useState<any[]>([])
    const [aiSuggestDone, setAiSuggestDone] = useState(false)

    // 列展开/收起
    const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({})

    const [relationForm, setRelationForm] = useState<any>({
      source_table_id: '',
      target_table_id: '',
      source_column: '',
      target_column: '',
      relationship_type: 'many_to_one',
      description: '',
    })

    // 列缓存（用 ref 持久化，避免重复请求；同时用 state 触发渲染）
    const columnsCacheRef = useRef<Record<string, any[]>>({})
    const [columnsCacheVersion, setColumnsCacheVersion] = useState(0)

    // 用 ref 持有最新的 nodes/edges/relationships，供布局等回调读取
    const nodesRef = useRef<any[]>([])
    const edgesRef = useRef<any[]>([])
    nodesRef.current = nodes
    edgesRef.current = edges

    // ── 计算属性 ──
    const filteredRelationships = useMemo(() => {
      const q = manageSearchQuery.trim().toLowerCase()
      if (!q) return relationships
      return relationships.filter(
        (rel) =>
          rel.source_table_name?.toLowerCase().includes(q) ||
          rel.target_table_name?.toLowerCase().includes(q) ||
          rel.source_column?.toLowerCase().includes(q) ||
          rel.target_column?.toLowerCase().includes(q),
      )
    }, [manageSearchQuery, relationships])

    const selectedSuggestionCount = useMemo(
      () => aiSuggestions.filter((s) => s._selected).length,
      [aiSuggestions],
    )

    const discoverSelectedCount = useMemo(
      () => discoverCandidates.filter((c) => c._selected).length,
      [discoverCandidates],
    )
    const discoverSelectAll = useMemo(
      () => discoverCandidates.length > 0 && discoverCandidates.every((c) => c._selected),
      [discoverCandidates],
    )
    const discoverSelectIndeterminate = useMemo(() => {
      const selected = discoverSelectedCount
      return selected > 0 && selected < discoverCandidates.length
    }, [discoverSelectedCount, discoverCandidates])

    const dialogTabItems = useMemo(
      () => [
        {
          key: 'ai',
          label: t('database.relation.aiAssist'),
          desc: t('database.relation.aiAssistDesc'),
          icon: IconWand,
        },
        {
          key: 'manual',
          label: t('database.relation.manualAdd'),
          desc: t('database.relation.manualAddDesc'),
          icon: IconPencil,
        },
        {
          key: 'discover',
          label: t('database.relation.autoDiscover'),
          desc: t('database.relation.autoDiscoverDesc'),
          icon: IconSearch,
        },
      ],
      [t],
    )

    // 动态加载选中表的列（依赖列缓存版本）
    const sourceColumns = useMemo(
      () => columnsCacheRef.current[relationForm.source_table_id] || [],
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [relationForm.source_table_id, columnsCacheVersion],
    )
    const targetColumns = useMemo(
      () => columnsCacheRef.current[relationForm.target_table_id] || [],
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [relationForm.target_table_id, columnsCacheVersion],
    )

    // ── 搜索输入 ──
    const handleSearchInput = (val: string) => {
      const q = val.trim().toLowerCase()
      setNodes((prev) =>
        prev.map((n) => ({
          ...n,
          data: {
            ...n.data,
            searchMatch: !q || n.data.label?.toLowerCase().includes(q),
          },
        })),
      )
    }

    // ── 节点点击 ──
    const handleNodeClick = (_e: any, node: any) => {
      const table = tables.find((tb) => tb.id === node.id)
      if (table) {
        onTableClick?.({ ...table, columns: node.data.columns || [] })
      }
    }

    // ── 列加载 ──
    const loadColumnsForTable = useCallback(
      async (tableId: string) => {
        if (!tableId || columnsCacheRef.current[tableId]) return
        try {
          const res: any = await getTableColumnsReq(getCurrentProjectId(), databaseId, tableId)
          if (res?.success) {
            columnsCacheRef.current[tableId] = res.data?.items || []
            setColumnsCacheVersion((v) => v + 1)
          }
        } catch (e) {
          console.error('加载列信息失败:', e)
        }
      },
      [databaseId],
    )

    const handleSourceTableChange = async (tableId: string) => {
      setRelationForm((prev: any) => ({ ...prev, source_table_id: tableId, source_column: '' }))
      await loadColumnsForTable(tableId)
    }

    const handleTargetTableChange = async (tableId: string) => {
      setRelationForm((prev: any) => ({ ...prev, target_table_id: tableId, target_column: '' }))
      await loadColumnsForTable(tableId)
    }

    // 加载所有要显示的表的列信息（最多 10 并发）
    const loadAllColumns = useCallback(
      async (tableIds: string[]) => {
        const toLoad = tableIds.filter((id) => !columnsCacheRef.current[id])
        if (toLoad.length === 0) return
        const batchSize = 10
        for (let i = 0; i < toLoad.length; i += batchSize) {
          const batch = toLoad.slice(i, i + batchSize)
          await Promise.all(batch.map((id) => loadColumnsForTable(id)))
        }
      },
      [loadColumnsForTable],
    )

    // ── 获取节点的实际 DOM 尺寸 ──
    const getNodeDOMSizes = useCallback(() => {
      const sizes: Record<string, { width: number; height: number }> = {}
      const container = canvasRef.current
      if (!container) return sizes
      const nodeEls = container.querySelectorAll<HTMLElement>('.react-flow__node')
      nodeEls.forEach((el) => {
        const id = el.dataset?.id || el.getAttribute('data-id')
        if (id) {
          sizes[id] = { width: el.offsetWidth || 230, height: el.offsetHeight || 200 }
        }
      })
      return sizes
    }, [])

    // ── Dagre 自动布局 ──
    const autoLayout = useCallback(() => {
      const curNodes = nodesRef.current
      const curEdges = edgesRef.current
      if (curNodes.length === 0) return

      const domSizes = getNodeDOMSizes()
      const nodeWidth = Math.max(230, ...Object.values(domSizes).map((s) => s.width))

      // 分离有关系的节点和孤立节点
      const connectedIds = new Set<string>()
      for (const edge of curEdges) {
        connectedIds.add(edge.source)
        connectedIds.add(edge.target)
      }

      const connectedNodes = curNodes.filter((n) => connectedIds.has(n.id))
      const isolatedNodes = curNodes.filter((n) => !connectedIds.has(n.id))

      const positions: Record<string, { x: number; y: number }> = {}
      let maxY = 0

      // 有关系的节点用 dagre 布局
      if (connectedNodes.length > 0) {
        const g = new dagre.graphlib.Graph()
        g.setDefaultEdgeLabel(() => ({}))
        g.setGraph({ rankdir: 'LR', nodesep: 80, ranksep: 200, marginx: 60, marginy: 60 })

        for (const node of connectedNodes) {
          const s = domSizes[node.id] || { width: 230, height: 200 }
          g.setNode(node.id, { width: s.width + 40, height: s.height + 40 })
        }

        for (const edge of curEdges) {
          g.setEdge(edge.source, edge.target)
        }

        dagre.layout(g)

        for (const node of connectedNodes) {
          const pos = g.node(node.id)
          const s = domSizes[node.id] || { width: 230, height: 200 }
          positions[node.id] = { x: pos.x - s.width / 2, y: pos.y - pos.height / 2 }
          const bottom = positions[node.id].y + pos.height
          if (bottom > maxY) maxY = bottom
        }
      }

      // 孤立节点用自适应网格布局
      if (isolatedNodes.length > 0) {
        const startY = maxY > 0 ? maxY + 80 : 40
        const colGap = 50
        const rowGap = 40
        const cellWidth = nodeWidth + colGap

        const canvasWidth = canvasRef.current?.offsetWidth || 1200
        const cols = Math.max(Math.floor(canvasWidth / cellWidth), 2)

        const rows: any[][] = []
        for (let i = 0; i < isolatedNodes.length; i += cols) {
          rows.push(isolatedNodes.slice(i, i + cols))
        }

        let currentY = startY
        rows.forEach((row) => {
          let rowMaxH = 0
          row.forEach((node, colIdx) => {
            const s = domSizes[node.id] || { width: 230, height: 200 }
            if (s.height > rowMaxH) rowMaxH = s.height
            positions[node.id] = { x: 40 + colIdx * cellWidth, y: currentY }
          })
          currentY += rowMaxH + rowGap
        })
      }

      // 触发更新（写回 position）
      setNodes((prev) =>
        prev.map((n) => (positions[n.id] ? { ...n, position: positions[n.id] } : n)),
      )

      // 布局完成后适配视图
      requestAnimationFrame(() => {
        fitView({ padding: 0.12, duration: 300 })
      })
    }, [getNodeDOMSizes, fitView])

    const handleAutoLayout = () => {
      autoLayout()
    }

    // ── 列展开/收起 ──
    const toggleExpand = useCallback(
      (nodeId: string) => {
        setExpandedNodes((prev) => ({ ...prev, [nodeId]: !prev[nodeId] }))
        // 等待 DOM 更新后重新布局
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            autoLayout()
          })
        })
      },
      [autoLayout],
    )

    // ── 构建图 ──
    const buildGraph = useCallback(
      async (rels: any[], tableList: any[]) => {
        // 构建关系索引（用于标记列）
        const sourceColSet = new Set<string>()
        const targetColSet = new Set<string>()
        for (const rel of rels) {
          sourceColSet.add(`${rel.source_table_id}:${rel.source_column}`)
          targetColSet.add(`${rel.target_table_id}:${rel.target_column}`)
        }

        // 显示所有表（xyflow 自带视口裁剪）
        const tablesToShow = tableList

        // 加载所有要显示的表的列信息
        await loadAllColumns(tablesToShow.map((tb) => tb.id))

        // 创建节点
        const newNodes = tablesToShow.map((tb) => {
          const allColumns = columnsCacheRef.current[tb.id] || []
          const totalColumns = allColumns.length
          const displayColumns = allColumns.map((c) => ({
            ...c,
            is_relation_source: sourceColSet.has(`${tb.id}:${c.column_name}`),
            is_relation_target: targetColSet.has(`${tb.id}:${c.column_name}`),
          }))

          return {
            id: tb.id,
            type: 'table',
            position: { x: 0, y: 0 },
            data: {
              label: tb.table_name,
              columns: displayColumns,
              totalColumns,
              highlighted: false,
              searchMatch: true,
            },
          }
        })

        // 创建边 - 连接到具体列的 handle
        const newEdges = rels.map((rel) => ({
          id: rel.id,
          source: rel.source_table_id,
          target: rel.target_table_id,
          sourceHandle: `${rel.source_column}-source`,
          targetHandle: `${rel.target_column}-target`,
          label: `${rel.source_column} → ${rel.target_column}`,
          type: 'default',
          animated: false,
          style: { stroke: '#17483e', strokeWidth: 2 },
          labelStyle: { fontSize: '11px', fill: '#606266' },
          labelBgStyle: { fill: '#fff', fillOpacity: 0.9 },
          markerEnd: { type: MarkerType.ArrowClosed, color: '#17483e' },
          data: rel,
        }))

        nodesRef.current = newNodes
        edgesRef.current = newEdges
        setNodes(newNodes)
        setEdges(newEdges)

        // 先渲染节点让 DOM 生成，再读取实际高度做布局
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            autoLayout()
          })
        })
      },
      [loadAllColumns, autoLayout],
    )

    // ── 加载表列表 ──
    const loadTables = useCallback(async () => {
      if (!databaseId) return [] as any[]
      try {
        const res: any = await getCachedTablesReq(getCurrentProjectId(), databaseId, { limit: 1000 })
        if (res?.success) {
          const items = res.data?.items || []
          setTables(items)
          return items
        }
      } catch (e) {
        console.error('加载表列表失败:', e)
      }
      return [] as any[]
    }, [databaseId])

    // ── 加载关系 ──
    const loadRelationships = useCallback(async () => {
      if (!databaseId) return
      try {
        const res: any = await getRelationshipsReq(getCurrentProjectId(), databaseId)
        if (res?.success) {
          const items = res.data?.items || []
          setRelationships(items)
          // buildGraph 需要最新 tables：用 setTables 之后的引用，这里直接从 state 读取
          await buildGraph(items, tablesRef.current)
        }
      } catch (e) {
        console.error('加载关系失败:', e)
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [databaseId, buildGraph])

    // tables 的 ref，供 loadRelationships 读取最新值
    const tablesRef = useRef<any[]>([])
    tablesRef.current = tables

    // ── 监听 databaseId 变化（immediate watch） ──
    useEffect(() => {
      if (!databaseId) return
      let cancelled = false
      ;(async () => {
        setGraphLoading(true)
        try {
          const tbs = await loadTables()
          if (cancelled) return
          tablesRef.current = tbs
          // 直接传 tbs 给 buildGraph，避免依赖异步 state
          if (!databaseId) return
          const res: any = await getRelationshipsReq(getCurrentProjectId(), databaseId)
          if (cancelled) return
          if (res?.success) {
            const items = res.data?.items || []
            setRelationships(items)
            await buildGraph(items, tbs)
          }
        } finally {
          if (!cancelled) setGraphLoading(false)
        }
      })()
      return () => {
        cancelled = true
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [databaseId])

    // ── 自动发现 ──
    const handleAutoDiscover = async () => {
      setDiscovering(true)
      setDiscoverCandidates([])
      setDiscoverStats(null)
      setDiscoverSkipped([])
      try {
        const res: any = await discoverRelationshipsReq(getCurrentProjectId(), databaseId)
        if (res?.success) {
          const data = res.data || {}
          const candidates = data.candidates || []
          setDiscoverStats(data.stats || null)
          const skipped = [...(data.skipped_existing || []), ...(data.skipped_low_score || [])]
          setDiscoverSkipped(skipped)
          // score >= 0.6 默认勾选
          setDiscoverCandidates(
            candidates.map((c: any) => ({ ...c, _selected: (c.score || 0) >= 0.6 })),
          )
          if (candidates.length === 0 && skipped.length === 0) {
            notifications.show({ message: t('database.relation.noCandidates') })
          }
        } else {
          notifications.show({
            color: 'red',
            message: res?.msg || t('database.relation.discoverFailed'),
          })
        }
      } catch (e) {
        console.error('自动发现失败:', e)
        notifications.show({ color: 'red', message: t('database.relation.discoverFailed') })
      } finally {
        setDiscovering(false)
      }
    }

    // 保存自动发现的选中候选
    const handleSaveDiscoverCandidates = async () => {
      const selected = discoverCandidates.filter((c) => c._selected)
      if (selected.length === 0) return

      setSaving(true)
      try {
        const res: any = await batchCreateRelationshipsReq(
          getCurrentProjectId(),
          databaseId,
          selected.map(({ _selected, ...rest }) => rest),
        )
        if (res?.success) {
          notifications.show({
            color: 'green',
            message: t('database.relation.addedRelations', {
              count: res.data?.created || selected.length,
            }),
          })
          setDialogVisible(false)
          setDiscoverCandidates([])
          await loadRelationships()
        } else {
          notifications.show({
            color: 'red',
            message: res?.msg || t('database.relation.saveRelationFailed'),
          })
        }
      } catch (e) {
        console.error('保存失败:', e)
        notifications.show({ color: 'red', message: t('database.relation.saveRelationFailed') })
      } finally {
        setSaving(false)
      }
    }

    const handleDiscoverSelectAll = (val: boolean) => {
      setDiscoverCandidates((prev) => prev.map((c) => ({ ...c, _selected: val })))
    }

    // ── AI辅助建议 ──
    const handleAISuggest = async () => {
      if (!aiHint.trim()) return
      setAiLoading(true)
      setAiSuggestDone(false)
      setAiSuggestions([])
      try {
        const res: any = await aiSuggestRelationshipsReq(
          getCurrentProjectId(),
          databaseId,
          aiHint.trim(),
        )
        if (res?.success) {
          setAiSuggestions((res.data?.suggestions || []).map((s: any) => ({ ...s, _selected: true })))
          setAiSuggestDone(true)
        } else {
          notifications.show({
            color: 'red',
            message: res?.msg || t('database.relation.aiAnalysisFailed'),
          })
        }
      } catch (e) {
        console.error('AI建议失败:', e)
        notifications.show({ color: 'red', message: t('database.relation.aiAnalysisFailed') })
      } finally {
        setAiLoading(false)
      }
    }

    // 保存选中的AI建议
    const handleSaveSelectedSuggestions = async () => {
      const selected = aiSuggestions.filter((s) => s._selected)
      if (selected.length === 0) return

      setSaving(true)
      try {
        let count = 0
        for (const sug of selected) {
          await createRelationshipReq(getCurrentProjectId(), databaseId, {
            source_table_id: sug.source_table_id,
            target_table_id: sug.target_table_id,
            source_column: sug.source_column,
            target_column: sug.target_column,
            relationship_type: sug.relationship_type,
          })
          count++
        }
        notifications.show({
          color: 'green',
          message: t('database.relation.addedRelations', { count }),
        })
        setDialogVisible(false)
        await loadRelationships()
      } catch (e) {
        console.error('保存失败:', e)
        notifications.show({ color: 'red', message: t('database.relation.saveRelationFailed') })
      } finally {
        setSaving(false)
      }
    }

    // 全部添加
    const handleSaveAllSuggestions = () => {
      const all = aiSuggestions.map((s) => ({ ...s, _selected: true }))
      setAiSuggestions(all)
      // 直接用 all 立即保存（避免等待 state 更新）
      ;(async () => {
        if (all.length === 0) return
        setSaving(true)
        try {
          let count = 0
          for (const sug of all) {
            await createRelationshipReq(getCurrentProjectId(), databaseId, {
              source_table_id: sug.source_table_id,
              target_table_id: sug.target_table_id,
              source_column: sug.source_column,
              target_column: sug.target_column,
              relationship_type: sug.relationship_type,
            })
            count++
          }
          notifications.show({
            color: 'green',
            message: t('database.relation.addedRelations', { count }),
          })
          setDialogVisible(false)
          await loadRelationships()
        } catch (e) {
          console.error('保存失败:', e)
          notifications.show({ color: 'red', message: t('database.relation.saveRelationFailed') })
        } finally {
          setSaving(false)
        }
      })()
    }

    // ── 添加关系 ──
    const handleAddRelationship = () => {
      setEditingRelationship(null)
      setAddMode('ai')
      setAiHint('')
      setAiSuggestions([])
      setAiSuggestDone(false)
      setDiscoverCandidates([])
      setDiscoverStats(null)
      setDiscoverSkipped([])
      setRelationForm({
        source_table_id: '',
        target_table_id: '',
        source_column: '',
        target_column: '',
        relationship_type: 'many_to_one',
        description: '',
      })
      setDialogVisible(true)
    }

    // ── 编辑关系 ──
    const handleEditRelationship = async (rel: any) => {
      setEditingRelationship(rel)
      setRelationForm({
        source_table_id: rel.source_table_id,
        target_table_id: rel.target_table_id,
        source_column: rel.source_column,
        target_column: rel.target_column,
        relationship_type: rel.relationship_type,
        description: rel.description || '',
      })
      // 加载列信息
      await Promise.all([
        loadColumnsForTable(rel.source_table_id),
        loadColumnsForTable(rel.target_table_id),
      ])
      setDialogVisible(true)
    }

    // ── 保存关系 ──
    const handleSaveRelationship = async () => {
      const form = relationForm
      if (
        !form.source_table_id ||
        !form.target_table_id ||
        !form.source_column ||
        !form.target_column
      ) {
        notifications.show({ color: 'yellow', message: t('database.relation.fillComplete') })
        return
      }

      setSaving(true)
      try {
        if (editingRelationship) {
          await updateRelationshipReq(
            getCurrentProjectId(),
            databaseId,
            editingRelationship.id,
            form,
          )
          notifications.show({ color: 'green', message: t('database.relation.updateSuccess') })
        } else {
          await createRelationshipReq(getCurrentProjectId(), databaseId, form)
          notifications.show({ color: 'green', message: t('database.relation.createSuccess') })
        }
        setDialogVisible(false)
        await loadRelationships()
      } catch (e) {
        console.error('保存关系失败:', e)
        notifications.show({ color: 'red', message: t('database.relation.saveRelationFailed') })
      } finally {
        setSaving(false)
      }
    }

    // ── 删除关系 ──
    const handleDeleteRelationship = (rel: any) => {
      modals.openConfirmModal({
        title: t('database.relation.deleteRelation'),
        children: t('database.relation.deleteConfirm', {
          source: `${rel.source_table_name}.${rel.source_column}`,
          target: `${rel.target_table_name}.${rel.target_column}`,
        }),
        labels: { confirm: t('database.action.delete'), cancel: t('database.action.cancel') },
        confirmProps: { color: 'red' },
        onConfirm: async () => {
          try {
            await deleteRelationshipReq(getCurrentProjectId(), databaseId, rel.id)
            notifications.show({ color: 'green', message: t('database.relation.deleteSuccess') })
            await loadRelationships()
          } catch (e) {
            console.error('删除关系失败:', e)
            notifications.show({ color: 'red', message: t('database.relation.deleteFailed') })
          }
        },
      })
    }

    // ── 点击边 ──
    const handleEdgeClick = (_e: any, edge: any) => {
      if (edge?.data) {
        handleEditRelationship(edge.data)
      }
    }

    // ── 处理连线创建 ──
    const handleConnect = (connection: any) => {
      const sourceHandle = connection.sourceHandle || ''
      const targetHandle = connection.targetHandle || ''

      const sourceColumn = sourceHandle.replace('-source', '')
      const targetColumn = targetHandle.replace('-target', '')

      const sourceNode = nodesRef.current.find((n) => n.id === connection.source)
      const targetNode = nodesRef.current.find((n) => n.id === connection.target)

      if (!sourceNode || !targetNode) return

      setPendingConnection({
        source_table_id: connection.source,
        source_table_name: sourceNode.data.label,
        source_column: sourceColumn,
        target_table_id: connection.target,
        target_table_name: targetNode.data.label,
        target_column: targetColumn,
        relationship_type: 'many_to_one',
        description: '',
      })

      setConnectDialogVisible(true)
    }

    // 确认创建连接关系
    const handleSaveConnection = async () => {
      if (!pendingConnection) return

      setSaving(true)
      try {
        const res: any = await createRelationshipReq(
          getCurrentProjectId(),
          databaseId,
          pendingConnection,
        )
        if (res?.success) {
          notifications.show({ color: 'green', message: t('database.relation.createSuccess') })
          setConnectDialogVisible(false)
          setPendingConnection(null)
          await loadRelationships()
        } else {
          notifications.show({
            color: 'red',
            message: res?.message || t('database.relation.createFailed'),
          })
        }
      } catch (e) {
        console.error('创建关系失败:', e)
        notifications.show({ color: 'red', message: t('database.relation.createFailed') })
      } finally {
        setSaving(false)
      }
    }

    // ── 高亮关系 ──
    const highlightRelation = (rel: any) => {
      setEdges((prev) =>
        prev.map((e) => ({
          ...e,
          animated: e.id === rel.id,
          style:
            e.id === rel.id
              ? { stroke: '#e6a23c', strokeWidth: 3 }
              : { stroke: '#17483e', strokeWidth: 2 },
        })),
      )
      setNodes((prev) =>
        prev.map((n) => ({
          ...n,
          data: {
            ...n.data,
            highlighted: n.id === rel.source_table_id || n.id === rel.target_table_id,
          },
        })),
      )
    }

    const clearHighlight = () => {
      setEdges((prev) =>
        prev.map((e) => ({ ...e, animated: false, style: { stroke: '#17483e', strokeWidth: 2 } })),
      )
      setNodes((prev) => prev.map((n) => ({ ...n, data: { ...n.data, highlighted: false } })))
    }

    // 暴露给父组件
    useImperativeHandle(ref, () => ({ loadRelationships }), [loadRelationships])

    // 节点类型
    const nodeTypes = useMemo<NodeTypes>(() => ({ table: TableNode }), [])

    // 注入交互所需的回调/状态到每个节点的 data（对应 Vue 的插槽闭包变量）
    const renderNodes = useMemo(
      () =>
        nodes.map((n) => ({
          ...n,
          data: {
            ...n.data,
            selectedTableId,
            searchQuery,
            expanded: !!expandedNodes[n.id],
            onToggleExpand: toggleExpand,
            expandLabel: t('database.relation.expandRemaining', {
              count: (n.data.totalColumns || 0) - COLLAPSED_LIMIT,
            }),
            collapseLabel: t('database.relation.collapse'),
          },
        })),
      [nodes, selectedTableId, searchQuery, expandedNodes, toggleExpand, t],
    )

    const relTypeOptions = [
      { value: 'many_to_one', label: t('database.relation.manyToOne') },
      { value: 'one_to_one', label: t('database.relation.oneToOne') },
      { value: 'one_to_many', label: t('database.relation.oneToMany') },
      { value: 'many_to_many', label: t('database.relation.manyToMany') },
    ]

    return (
      <div className={styles.erDiagramContainer}>
        {/* ER图 */}
        <div className={styles.erCanvas} ref={canvasRef}>
          <LoadingOverlay
            visible={graphLoading}
            loaderProps={{ children: t('database.relation.loadingStructure') }}
          />
          {/* 搜索框 */}
          <div className={styles.canvasSearch}>
            <TextInput
              value={searchQuery}
              placeholder={t('database.relation.searchTable')}
              leftSection={<IconSearch size={14} />}
              size="xs"
              onChange={(e) => {
                const v = e.currentTarget.value
                setSearchQuery(v)
                handleSearchInput(v)
              }}
            />
          </div>
          {/* 左下角工具栏 */}
          <div className={styles.canvasBottomActions}>
            <Tooltip label={t('database.relation.autoLayout')} position="top">
              <div className={styles.floatBtn} onClick={handleAutoLayout}>
                <IconRefresh size={18} />
              </div>
            </Tooltip>
          </div>
          <ReactFlow
            nodes={renderNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            defaultViewport={{ zoom: 0.8, x: 50, y: 50 }}
            minZoom={0.2}
            maxZoom={2}
            onlyRenderVisibleElements
            connectOnClick={false}
            onEdgeClick={handleEdgeClick}
            onConnect={handleConnect}
            onNodeClick={handleNodeClick}
          >
            <Background />
          </ReactFlow>
        </div>

        {/* 关系列表面板（可折叠） */}
        <div className={`${styles.relPanel} ${listCollapsed ? styles.collapsed : ''}`}>
          {listCollapsed ? (
            // 折叠态：竖排标签
            <div className={styles.relPanelCollapsed} onClick={() => setListCollapsed(false)}>
              <div className={styles.collapsedIndicator}>
                <IconChevronLeft size={14} />
              </div>
              <span className={styles.collapsedLabel}>{t('database.relation.relations')}</span>
              <span className={styles.collapsedCount}>{relationships.length}</span>
            </div>
          ) : (
            // 展开态
            <>
              <div className={styles.relPanelHeader}>
                <div className={styles.headerLeft}>
                  <span className={styles.headerTitle}>{t('database.relation.relations')}</span>
                  <span className={styles.headerBadge}>{relationships.length}</span>
                </div>
                <div className={styles.headerActions}>
                  <div
                    className={styles.actionBtn}
                    onClick={() => setManageDrawerVisible(true)}
                    title={t('database.relation.manage')}
                  >
                    <IconSettings size={14} />
                  </div>
                  <div
                    className={`${styles.actionBtn} ${styles.addBtn}`}
                    onClick={handleAddRelationship}
                  >
                    <IconPlus size={14} />
                  </div>
                  <div className={styles.actionBtn} onClick={() => setListCollapsed(true)}>
                    <IconChevronRight size={14} />
                  </div>
                </div>
              </div>

              <div className={styles.relPanelBody}>
                {relationships.length === 0 ? (
                  <div className={styles.relEmpty}>
                    <div className={styles.emptyIcon}>
                      <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
                        <circle
                          cx="20"
                          cy="20"
                          r="18"
                          stroke="#e0e0e6"
                          strokeWidth="2"
                          strokeDasharray="4 3"
                        />
                        <path
                          d="M14 20h12M26 20l-3-3M26 20l-3 3"
                          stroke="#c0c4cc"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </div>
                    <span className={styles.emptyText}>{t('database.relation.noRelations')}</span>
                    <span className={styles.emptyHint}>{t('database.relation.clickToAdd')}</span>
                  </div>
                ) : (
                  <div className={styles.relList}>
                    {relationships.map((rel) => (
                      <div
                        key={rel.id}
                        className={styles.relCard}
                        onMouseEnter={() => highlightRelation(rel)}
                        onMouseLeave={clearHighlight}
                      >
                        <div className={styles.relCardContent}>
                          <div className={`${styles.relEndpoint} ${styles.source}`}>
                            <span className={styles.endpointTable}>{rel.source_table_name}</span>
                            <span className={styles.endpointCol}>.{rel.source_column}</span>
                          </div>
                          <div className={styles.relConnector}>
                            <span className={styles.connectorLine} />
                            <span className={styles.connectorType}>
                              {formatRelType(rel.relationship_type)}
                            </span>
                            <span className={styles.connectorLine} />
                          </div>
                          <div className={`${styles.relEndpoint} ${styles.target}`}>
                            <span className={styles.endpointTable}>{rel.target_table_name}</span>
                            <span className={styles.endpointCol}>.{rel.target_column}</span>
                          </div>
                        </div>
                        <div className={styles.relCardActions}>
                          <div
                            className={styles.cardAction}
                            onClick={(e) => {
                              e.stopPropagation()
                              handleEditRelationship(rel)
                            }}
                          >
                            <IconEdit size={12} />
                            <span>{t('database.action.edit')}</span>
                          </div>
                          <div
                            className={`${styles.cardAction} ${styles.danger}`}
                            onClick={(e) => {
                              e.stopPropagation()
                              handleDeleteRelationship(rel)
                            }}
                          >
                            <IconTrash size={12} />
                            <span>{t('database.action.delete')}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* 添加/编辑关系对话框 */}
        <Modal
          opened={dialogVisible}
          onClose={() => setDialogVisible(false)}
          size="80%"
          withCloseButton={false}
          closeOnClickOutside={false}
          padding={0}
          radius={12}
          styles={{ body: { padding: 0 } }}
        >
          <div className={`${styles.rdLayout} ${editingRelationship ? styles.rdEditMode : ''}`}>
            {/* 左侧导航（仅新增模式） */}
            {!editingRelationship && (
              <div className={styles.rdSidebar}>
                <div className={styles.rdSidebarTitle}>{t('database.relation.addRelation')}</div>
                <nav className={styles.rdNav}>
                  {dialogTabItems.map((tab) => {
                    const TabIcon = tab.icon
                    return (
                      <div
                        key={tab.key}
                        className={`${styles.rdNavItem} ${addMode === tab.key ? styles.active : ''}`}
                        onClick={() => setAddMode(tab.key)}
                      >
                        <div className={styles.navIconWrap}>
                          <TabIcon size={16} />
                        </div>
                        <div className={styles.navText}>
                          <span className={styles.navLabel}>{tab.label}</span>
                          <span className={styles.navDesc}>{tab.desc}</span>
                        </div>
                      </div>
                    )
                  })}
                </nav>
              </div>
            )}

            {/* 右侧内容区 */}
            <div className={styles.rdMain}>
              {/* 编辑模式 header */}
              {editingRelationship && (
                <div className={styles.rdMainHeader}>
                  <span className={styles.rdMainTitle}>{t('database.relation.editRelation')}</span>
                </div>
              )}

              <div className={styles.rdMainBody}>
                {/* 编辑模式 / 手动添加 共用表单 */}
                {editingRelationship || addMode === 'manual' ? (
                  <RelationManualForm
                    relationForm={relationForm}
                    tables={tables}
                    sourceColumns={sourceColumns}
                    targetColumns={targetColumns}
                    onSourceTableChange={handleSourceTableChange}
                    onTargetTableChange={handleTargetTableChange}
                  />
                ) : addMode === 'ai' ? (
                  // AI 辅助
                  <div className={styles.aiSection}>
                    <div className={styles.aiPromptArea}>
                      <label className={styles.fieldLabel}>
                        {t('database.relation.describeRelation')}
                      </label>
                      <div className={styles.aiInputWrap}>
                        <Textarea
                          className={styles.aiTextarea}
                          value={aiHint}
                          minRows={4}
                          autosize
                          placeholder={t('database.relation.aiPlaceholder')}
                          disabled={aiLoading}
                          onChange={(e) => setAiHint(e.currentTarget.value)}
                        />
                      </div>
                      <div className={styles.aiActionRow}>
                        <div className={styles.aiTips}>
                          <span className={styles.tipDot} />
                          {t('database.relation.aiTip')}
                        </div>
                        <Button
                          className={styles.aiRunBtn}
                          onClick={handleAISuggest}
                          loading={aiLoading}
                          disabled={!aiHint.trim()}
                          leftSection={!aiLoading ? <IconWand size={16} /> : undefined}
                        >
                          {aiLoading
                            ? t('database.relation.analyzing')
                            : t('database.relation.startAnalysis')}
                        </Button>
                      </div>
                    </div>

                    {/* AI Loading */}
                    {aiLoading ? (
                      <div className={styles.aiLoading}>
                        <div className={styles.aiLoadingBar}>
                          <div className={styles.aiLoadingProgress} />
                        </div>
                        <span className={styles.aiLoadingText}>
                          {t('database.relation.analyzingStructure')}
                        </span>
                      </div>
                    ) : aiSuggestions.length > 0 ? (
                      // AI 结果
                      <div className={styles.aiResults}>
                        <div className={styles.resultsHeader}>
                          <div className={styles.resultsLeft}>
                            <span className={styles.resultsTitle}>
                              {t('database.relation.foundRelations', {
                                count: aiSuggestions.length,
                              })}
                            </span>
                            <span className={styles.resultsSub}>
                              {t('database.relation.allSelectedHint')}
                            </span>
                          </div>
                          <span
                            className={styles.resultsSelectAll}
                            onClick={handleSaveAllSuggestions}
                          >
                            {t('database.relation.selectAll')}
                          </span>
                        </div>
                        <div className={styles.sugGrid}>
                          {aiSuggestions.map((sug, idx) => (
                            <div
                              key={idx}
                              className={`${styles.sugItem} ${sug._selected ? styles.selected : ''}`}
                              onClick={() =>
                                setAiSuggestions((prev) =>
                                  prev.map((s, i) =>
                                    i === idx ? { ...s, _selected: !s._selected } : s,
                                  ),
                                )
                              }
                            >
                              <div className={styles.sugItemCheck}>
                                <div
                                  className={`${styles.sugCheckbox} ${sug._selected ? styles.on : ''}`}
                                >
                                  {sug._selected && (
                                    <svg width="10" height="8" viewBox="0 0 10 8">
                                      <path
                                        d="M1 4l2.8 2.8L9 1.2"
                                        stroke="#fff"
                                        strokeWidth="1.6"
                                        fill="none"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                      />
                                    </svg>
                                  )}
                                </div>
                              </div>
                              <div className={styles.sugItemBody}>
                                <div className={`${styles.sugRow} ${styles.sourceRow}`}>
                                  <span className={styles.sugLabel}>
                                    {t('database.relation.source')}
                                  </span>
                                  <span className={styles.sugTableName}>
                                    {sug.source_table_name}
                                  </span>
                                  <span className={styles.sugColName}>.{sug.source_column}</span>
                                </div>
                                <div className={styles.sugRowDivider}>
                                  <svg width="12" height="12" viewBox="0 0 12 12">
                                    <path
                                      d="M6 2v8M6 10l-2-2M6 10l2-2"
                                      stroke="#c0c4cc"
                                      strokeWidth="1.2"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                    />
                                  </svg>
                                </div>
                                <div className={`${styles.sugRow} ${styles.targetRow}`}>
                                  <span className={styles.sugLabel}>
                                    {t('database.relation.target')}
                                  </span>
                                  <span className={styles.sugTableName}>
                                    {sug.target_table_name}
                                  </span>
                                  <span className={styles.sugColName}>.{sug.target_column}</span>
                                </div>
                              </div>
                              <div className={styles.sugItemType}>
                                {formatRelType(sug.relationship_type)}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : aiSuggestDone ? (
                      <div className={styles.aiEmptyState}>
                        <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                          <circle cx="24" cy="24" r="20" stroke="#e0e0e6" strokeWidth="1.5" />
                          <path d="M18 24h12" stroke="#c0c4cc" strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                        <span>{t('database.relation.noMatchRelation')}</span>
                        <span className={styles.emptySub}>
                          {t('database.relation.tryMoreSpecific')}
                        </span>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  // 自动发现
                  <div className={styles.discoverContent}>
                    {/* 发现前：引导界面 */}
                    {!discoverStats && !discovering && (
                      <>
                        <div className={styles.discoverHero}>
                          <div className={styles.discoverIconGroup}>
                            <div className={`${styles.discoverRing} ${styles.ring1}`} />
                            <div className={`${styles.discoverRing} ${styles.ring2}`} />
                            <div className={`${styles.discoverRing} ${styles.ring3}`} />
                            <div className={styles.discoverCenterDot} />
                            <div className={`${styles.discoverNode} ${styles.n1}`} />
                            <div className={`${styles.discoverNode} ${styles.n2}`} />
                            <div className={`${styles.discoverNode} ${styles.n3}`} />
                            <div className={`${styles.discoverNode} ${styles.n4}`} />
                          </div>
                        </div>
                        <div className={styles.discoverInfo}>
                          <h4>{t('database.relation.smartDiscovery')}</h4>
                          <p>{t('database.relation.smartDiscoveryDesc')}</p>
                          <div className={styles.discoverSteps}>
                            <div className={styles.stepItem}>
                              <span className={styles.stepNum}>1</span>
                              <span className={styles.stepText}>{t('database.relation.step1')}</span>
                            </div>
                            <div className={styles.stepItem}>
                              <span className={styles.stepNum}>2</span>
                              <span className={styles.stepText}>{t('database.relation.step2')}</span>
                            </div>
                            <div className={styles.stepItem}>
                              <span className={styles.stepNum}>3</span>
                              <span className={styles.stepText}>{t('database.relation.step3')}</span>
                            </div>
                            <div className={styles.stepItem}>
                              <span className={styles.stepNum}>4</span>
                              <span className={styles.stepText}>{t('database.relation.step4')}</span>
                            </div>
                          </div>
                        </div>
                        <Button
                          size="lg"
                          onClick={handleAutoDiscover}
                          className={styles.discoverStartBtn}
                          leftSection={<IconSearch size={16} />}
                        >
                          {t('database.relation.startAutoDiscover')}
                        </Button>
                      </>
                    )}

                    {/* 发现中：loading */}
                    {discovering && (
                      <div className={styles.discoverLoading}>
                        <IconRefresh size={32} color="#17483e" className={styles.spin} />
                        <p>{t('database.relation.analyzingStructure')}</p>
                        <span className={styles.discoverLoadingSub}>
                          {t('database.relation.analyzingHint')}
                        </span>
                      </div>
                    )}

                    {/* 发现后：统计 + 候选列表 */}
                    {discoverStats && !discovering && (
                      <div className={styles.discoverCandidates}>
                        {/* 统计摘要 */}
                        <div className={styles.discoverStats}>
                          <div className={styles.statItem}>
                            <span className={styles.statNum}>{discoverStats.total_analyzed}</span>
                            <span className={styles.statLabel}>
                              {t('database.relation.analyzedPairs')}
                            </span>
                          </div>
                          <div className={`${styles.statItem} ${styles.statNew}`}>
                            <span className={styles.statNum}>{discoverStats.new_candidates}</span>
                            <span className={styles.statLabel}>
                              {t('database.relation.newDiscovered')}
                            </span>
                          </div>
                          {discoverStats.already_existing ? (
                            <div className={`${styles.statItem} ${styles.statExist}`}>
                              <span className={styles.statNum}>
                                {discoverStats.already_existing}
                              </span>
                              <span className={styles.statLabel}>
                                {t('database.relation.alreadyExists')}
                              </span>
                            </div>
                          ) : null}
                          {discoverStats.low_score_filtered ? (
                            <div className={`${styles.statItem} ${styles.statLow}`}>
                              <span className={styles.statNum}>
                                {discoverStats.low_score_filtered}
                              </span>
                              <span className={styles.statLabel}>
                                {t('database.relation.lowScoreFiltered')}
                              </span>
                            </div>
                          ) : null}
                        </div>

                        {/* 新候选列表 */}
                        {discoverCandidates.length > 0 ? (
                          <>
                            <div className={styles.candidatesHeader}>
                              <span>
                                {t('database.relation.newFound')}{' '}
                                <strong>{discoverCandidates.length}</strong>{' '}
                                {t('database.relation.relationsCount')}
                              </span>
                              <Checkbox
                                checked={discoverSelectAll}
                                indeterminate={discoverSelectIndeterminate}
                                onChange={(e) => handleDiscoverSelectAll(e.currentTarget.checked)}
                                label={t('database.relation.selectAll')}
                              />
                            </div>
                            <div className={styles.candidatesList}>
                              {discoverCandidates.map((cand, idx) => (
                                <div
                                  key={'new-' + idx}
                                  className={`${styles.candidateCard} ${cand._selected ? styles.selected : ''}`}
                                >
                                  <div className={styles.candidateCheck}>
                                    <Checkbox
                                      checked={!!cand._selected}
                                      onChange={(e) =>
                                        setDiscoverCandidates((prev) =>
                                          prev.map((c, i) =>
                                            i === idx
                                              ? { ...c, _selected: e.currentTarget.checked }
                                              : c,
                                          ),
                                        )
                                      }
                                    />
                                  </div>
                                  <div className={styles.candidateBody}>
                                    <div className={styles.candidatePath}>
                                      <span className={styles.candTable}>
                                        {cand.source_table_name}
                                      </span>
                                      <span className={styles.candDot}>.</span>
                                      <span className={styles.candCol}>{cand.source_column}</span>
                                      <span className={styles.candArrow}>→</span>
                                      <span className={styles.candTable}>
                                        {cand.target_table_name}
                                      </span>
                                      <span className={styles.candDot}>.</span>
                                      <span className={styles.candCol}>{cand.target_column}</span>
                                    </div>
                                    <div className={styles.candidateMeta}>
                                      <span className={`${styles.candScore} ${scoreClass(cand.score)}`}>
                                        {(cand.score * 100).toFixed(0)}%
                                      </span>
                                      <span className={styles.candType}>
                                        {cand.relationship_type}
                                      </span>
                                      {cand.signals && (
                                        <>
                                          {cand.signals.name_pattern && (
                                            <span
                                              className={`${styles.candSignal} ${styles.sName}`}
                                              title={
                                                t('database.relation.signalName') +
                                                ': ' +
                                                cand.signals.name_pattern
                                              }
                                            >
                                              name
                                            </span>
                                          )}
                                          {cand.signals.ind_overlap && (
                                            <span
                                              className={`${styles.candSignal} ${styles.sInd}`}
                                              title={
                                                t('database.relation.signalInd') +
                                                ': ' +
                                                cand.signals.ind_overlap
                                              }
                                            >
                                              ind
                                            </span>
                                          )}
                                          {cand.signals.llm_semantic && (
                                            <span
                                              className={`${styles.candSignal} ${styles.sLlm}`}
                                              title={
                                                t('database.relation.signalLlm') +
                                                ': ' +
                                                cand.signals.llm_semantic
                                              }
                                            >
                                              llm
                                            </span>
                                          )}
                                          {cand.signals.description_hint && (
                                            <span
                                              className={`${styles.candSignal} ${styles.sDesc}`}
                                              title={
                                                t('database.relation.signalDesc') +
                                                ': ' +
                                                cand.signals.description_hint
                                              }
                                            >
                                              desc
                                            </span>
                                          )}
                                          {cand.signals.cardinality && (
                                            <span
                                              className={`${styles.candSignal} ${styles.sCard}`}
                                              title={
                                                t('database.relation.signalCard') +
                                                ': ' +
                                                cand.signals.cardinality
                                              }
                                            >
                                              card
                                            </span>
                                          )}
                                        </>
                                      )}
                                    </div>
                                    {cand.reasoning && (
                                      <div className={styles.candidateReason}>{cand.reasoning}</div>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </>
                        ) : (
                          // 无新候选时提示
                          <div className={styles.discoverEmptyHint}>
                            {discoverStats.already_existing ? (
                              <span>{t('database.relation.allExist')}</span>
                            ) : discoverStats.low_score_filtered ? (
                              <span>{t('database.relation.lowConfidence')}</span>
                            ) : (
                              <span>{t('database.relation.noCandidates')}</span>
                            )}
                          </div>
                        )}

                        {/* 折叠显示跳过的关系 */}
                        {discoverSkipped.length > 0 && (
                          <Accordion className={styles.skippedCollapse} chevronPosition="left">
                            <Accordion.Item value="skipped">
                              <Accordion.Control>
                                <span className={styles.skippedTitle}>
                                  {t('database.relation.viewSkipped', {
                                    count: discoverSkipped.length,
                                  })}
                                </span>
                              </Accordion.Control>
                              <Accordion.Panel>
                                <div className={styles.skippedList}>
                                  {discoverSkipped.map((s, idx) => (
                                    <div key={'skip-' + idx} className={styles.skippedItem}>
                                      <span className={styles.skippedPath}>
                                        {s.source_table_name}.{s.source_column} →{' '}
                                        {s.target_table_name}.{s.target_column}
                                      </span>
                                      <span className={styles.skippedScore}>
                                        {(s.score * 100).toFixed(0)}%
                                      </span>
                                      <span className={styles.skippedReason}>
                                        {s.reject_reason === 'already_exists'
                                          ? t('database.relation.alreadyExists')
                                          : t('database.relation.lowScore')}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </Accordion.Panel>
                            </Accordion.Item>
                          </Accordion>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* 底部操作栏 */}
              <div className={styles.rdMainFooter}>
                {editingRelationship ? (
                  <>
                    <Button variant="default" onClick={() => setDialogVisible(false)}>
                      {t('database.action.cancel')}
                    </Button>
                    <Button
                      color="red"
                      onClick={() => {
                        handleDeleteRelationship(editingRelationship)
                        setDialogVisible(false)
                      }}
                    >
                      {t('database.action.delete')}
                    </Button>
                    <Button onClick={handleSaveRelationship} loading={saving}>
                      {t('database.relation.saveChanges')}
                    </Button>
                  </>
                ) : addMode === 'ai' ? (
                  <>
                    <Button variant="default" onClick={() => setDialogVisible(false)}>
                      {t('database.action.close')}
                    </Button>
                    <Button
                      onClick={handleSaveSelectedSuggestions}
                      loading={saving}
                      disabled={selectedSuggestionCount === 0}
                    >
                      {t('database.relation.addSelected', { count: selectedSuggestionCount })}
                    </Button>
                  </>
                ) : addMode === 'manual' ? (
                  <>
                    <Button variant="default" onClick={() => setDialogVisible(false)}>
                      {t('database.action.cancel')}
                    </Button>
                    <Button onClick={handleSaveRelationship} loading={saving}>
                      {t('database.relation.createRelation')}
                    </Button>
                  </>
                ) : addMode === 'discover' &&
                  discoverStats &&
                  discoverCandidates.length > 0 ? (
                  <Button
                    onClick={handleSaveDiscoverCandidates}
                    loading={saving}
                    disabled={discoverSelectedCount === 0}
                  >
                    {t('database.relation.addSelectedCount', { count: discoverSelectedCount })}
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        </Modal>

        {/* 关系管理抽屉 */}
        <Drawer
          opened={manageDrawerVisible}
          onClose={() => setManageDrawerVisible(false)}
          title={t('database.relation.manageRelations')}
          position="right"
          size={480}
        >
          <div className={styles.manageDrawerContent}>
            {/* 搜索 + 操作栏 */}
            <div className={styles.manageToolbar}>
              <TextInput
                style={{ flex: 1 }}
                value={manageSearchQuery}
                placeholder={t('database.relation.searchTableOrColumn')}
                leftSection={<IconSearch size={14} />}
                onChange={(e) => setManageSearchQuery(e.currentTarget.value)}
              />
              <Button
                leftSection={<IconPlus size={14} />}
                onClick={() => {
                  setManageDrawerVisible(false)
                  handleAddRelationship()
                }}
              >
                {t('database.relation.add')}
              </Button>
            </div>

            {/* 统计 */}
            <div className={styles.manageStats}>
              <span>
                {t('database.relation.totalRelations', { count: filteredRelationships.length })}
              </span>
              {manageSearchQuery && (
                <span className={styles.manageStatsFilter}>
                  ({t('database.relation.filteredFrom', { count: relationships.length })})
                </span>
              )}
            </div>

            {/* 关系列表 */}
            <div className={styles.manageList}>
              {filteredRelationships.length === 0 ? (
                <div className={styles.manageEmpty}>
                  {manageSearchQuery ? (
                    <span>{t('database.relation.noMatchRelation')}</span>
                  ) : (
                    <span>{t('database.relation.noRelations')}</span>
                  )}
                </div>
              ) : (
                filteredRelationships.map((rel) => (
                  <div key={rel.id} className={styles.manageCard}>
                    <div className={styles.manageCardBody}>
                      <div className={`${styles.manageRelEndpoint} ${styles.source}`}>
                        <span className={styles.mTable}>{rel.source_table_name}</span>
                        <span className={styles.mCol}>.{rel.source_column}</span>
                      </div>
                      <div className={styles.manageRelConnector}>
                        <span className={styles.connectorLine} />
                        <span className={styles.connectorType}>
                          {formatRelType(rel.relationship_type)}
                        </span>
                        <span className={styles.connectorLine} />
                      </div>
                      <div className={`${styles.manageRelEndpoint} ${styles.target}`}>
                        <span className={styles.mTable}>{rel.target_table_name}</span>
                        <span className={styles.mCol}>.{rel.target_column}</span>
                      </div>
                      {rel.description && (
                        <div className={styles.manageRelDesc}>{rel.description}</div>
                      )}
                    </div>
                    <div className={styles.manageCardActions}>
                      <Button
                        variant="subtle"
                        size="compact-sm"
                        onClick={() => {
                          setManageDrawerVisible(false)
                          handleEditRelationship(rel)
                        }}
                      >
                        <IconEdit size={14} />
                      </Button>
                      <Button
                        variant="subtle"
                        size="compact-sm"
                        color="red"
                        onClick={() => handleDeleteRelationship(rel)}
                      >
                        <IconTrash size={14} />
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </Drawer>

        {/* 连线确认对话框 */}
        <Modal
          opened={connectDialogVisible}
          onClose={() => setConnectDialogVisible(false)}
          title={t('database.relation.confirmRelation')}
          size={800}
          closeOnClickOutside={false}
        >
          {pendingConnection && (
            <div className={styles.connectConfirm}>
              <div className={styles.connectPreview}>
                <div className={styles.connectEndpoint}>
                  <span className={styles.endpointTable}>
                    {pendingConnection.source_table_name}
                  </span>
                  <span className={styles.endpointCol}>.{pendingConnection.source_column}</span>
                </div>
                <div className={styles.connectArrow}>
                  <svg width="24" height="16" viewBox="0 0 24 16" fill="none">
                    <path
                      d="M0 8h20M20 8l-4-4M20 8l-4 4"
                      stroke="#17483e"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
                <div className={styles.connectEndpoint}>
                  <span className={styles.endpointTable}>
                    {pendingConnection.target_table_name}
                  </span>
                  <span className={styles.endpointCol}>.{pendingConnection.target_column}</span>
                </div>
              </div>
              <div className={styles.connectForm}>
                <Select
                  label={t('database.relation.relationType')}
                  value={pendingConnection.relationship_type}
                  data={relTypeOptions}
                  onChange={(val) =>
                    setPendingConnection((prev: any) => ({
                      ...prev,
                      relationship_type: val || prev.relationship_type,
                    }))
                  }
                />
                <Textarea
                  label={t('database.relation.description')}
                  value={pendingConnection.description}
                  minRows={3}
                  autosize
                  placeholder={t('database.relation.descriptionPlaceholder')}
                  onChange={(e) =>
                    setPendingConnection((prev: any) => ({
                      ...prev,
                      description: e.currentTarget.value,
                    }))
                  }
                />
              </div>
            </div>
          )}
          <div className={styles.rdMainFooter} style={{ border: 'none', background: 'transparent' }}>
            <Button size="md" variant="default" onClick={() => setConnectDialogVisible(false)}>
              {t('database.action.cancel')}
            </Button>
            <Button size="md" onClick={handleSaveConnection} loading={saving}>
              {t('database.relation.createRelation')}
            </Button>
          </div>
        </Modal>
      </div>
    )
  },
)

// 对外组件：包一层 ReactFlowProvider（useReactFlow 需要 Provider 上下文）
const RelationshipERDiagram = forwardRef<RelationshipERDiagramHandle, RelationshipERDiagramProps>(
  function RelationshipERDiagram(props, ref) {
    return (
      <ReactFlowProvider>
        <InnerERDiagram ref={ref} {...props} />
      </ReactFlowProvider>
    )
  },
)

export default RelationshipERDiagram
