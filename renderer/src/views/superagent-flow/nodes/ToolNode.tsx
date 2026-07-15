/**
 * ToolNode — 工具节点 / 算子节点共用渲染器(底层 node.type='tool')
 *
 * 视觉规则(跟 ConditionNode 菱形同 SVG 风格):
 * - category='tool'      → ⬭ 椭圆(柔和蓝,起点 / 检索 / 输出)
 * - category='operator'  → ⊏⊐ 圆角矩形(柔和绿,中间表语义加工)
 * - 其他 / 无 catalog 命中 → 灰色虚框 fallback
 *
 * 端口:Left = target / Right = source(跟矩形版一致)
 */
import { createContext, useContext, useMemo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { useTranslation } from 'react-i18next'
import { IconTool } from '@tabler/icons-react'
import { ICON_MAP, NODE_CATALOG } from '../nodeCatalog'
import { useNodeRunStatus } from './useNodeRunStatus'
import styles from './ToolNode.module.scss'

/**
 * workflowCatalog Context — 对应原 Vue 的 provide/inject('workflowCatalog')。
 * editor 优先注入后端 business + spec 的 catalog;组件被独立使用 / 未注入时
 * fallback 到本地静态 NODE_CATALOG。
 */
export const WorkflowCatalogContext = createContext<any[] | null>(null)

interface ToolNodeProps {
  id?: string
  data: any
  selected?: boolean
}

// run-${status} → CSS module 类名映射(scoped 类名经过 hash,需手动映射)
const RUN_STATUS_CLASS_MAP: Record<string, string> = {
  'run-ok': styles.runOk,
  'run-fail': styles.runFail,
  'run-skipped': styles.runSkipped,
  'run-paused': styles.runPaused,
}
const BADGE_CLASS_MAP: Record<string, string> = {
  ok: styles.badgeOk,
  fail: styles.badgeFail,
  skipped: styles.badgeSkipped,
  paused: styles.badgePaused,
}

// 配色(跟 ConditionNode 菱形同语言:fill 柔和族色 + stroke 主色)
const COLOR_MAP: Record<string, { fill: string; stroke: string; icon: string }> = {
  tool: { fill: '#eff6ff', stroke: '#3b82f6', icon: '#1d4ed8' },
  operator: { fill: '#fcfaf5', stroke: '#ffc943', icon: '#276354' },
  unknown: { fill: '#f9fafb', stroke: '#9ca3af', icon: '#6b7280' },
}

function truncate(s: any, n: number): string {
  s = String(s)
  return s.length > n ? s.slice(0, n) + '…' : s
}

export default function ToolNode(props: NodeProps | ToolNodeProps) {
  const { id, data, selected } = props as ToolNodeProps
  const { t } = useTranslation()

  // 优先用 editor 注入的 catalog(含后端 business + spec);组件被独立使用时
  // fallback 到本地静态 NODE_CATALOG
  const injectedCatalog = useContext(WorkflowCatalogContext)

  const catalog = useMemo<any[]>(() => {
    return Array.isArray(injectedCatalog) && injectedCatalog.length ? injectedCatalog : NODE_CATALOG
  }, [injectedCatalog])

  // 从 catalog 查这个 tool_name 对应的卡片元信息
  const catalogEntry = useMemo<any>(() => {
    const tn = data?.config?.tool_name
    if (!tn) return null
    return catalog.find((c) => c.toolName === tn) || null
  }, [catalog, data?.config?.tool_name])

  const category = useMemo<string>(
    () => catalogEntry?.business?.category || 'unknown',
    [catalogEntry],
  )

  const fillColor = useMemo<string>(
    () => COLOR_MAP[category]?.fill || COLOR_MAP.unknown.fill,
    [category],
  )
  const strokeColor = useMemo<string>(
    () => COLOR_MAP[category]?.stroke || COLOR_MAP.unknown.stroke,
    [category],
  )
  const iconColor = useMemo<string>(
    () => COLOR_MAP[category]?.icon || COLOR_MAP.unknown.icon,
    [category],
  )

  // icon ID → Tabler 组件;无命中 fallback 到 IconTool(对应原 EP Tools)
  const IconComponent = useMemo(() => {
    const iconId = catalogEntry?.business?.icon
    return (iconId && ICON_MAP[iconId]) || IconTool
  }, [catalogEntry])

  const title = useMemo<string>(() => {
    if (data?.displayName) return data.displayName
    if (catalogEntry?.business?.name) return catalogEntry.business.name
    return id || t('workflow.node.untitled')
  }, [data?.displayName, catalogEntry, id, t])

  const toolName = useMemo<string>(() => data?.config?.tool_name || '', [data?.config?.tool_name])

  const costLevel = useMemo<number>(() => catalogEntry?.business?.costLevel || 0, [catalogEntry])
  const costNote = useMemo<string>(() => catalogEntry?.business?.costNote || '', [catalogEntry])

  // 参数摘要(显示主要的 question / table_name 等)
  const paramsSummary = useMemo<string>(() => {
    const params = data?.config?.params || {}
    const pieces: string[] = []
    if (params.question) pieces.push(`q: ${truncate(params.question, 26)}`)
    if (params.table_name) pieces.push(`tbl: ${params.table_name}`)
    if (params.left_table) pieces.push(`L: ${params.left_table}`)
    if (params.right_table) pieces.push(`R: ${params.right_table}`)
    return pieces.join(' · ')
  }, [data?.config?.params])

  // 缺失的必填参数(根据 catalog spec)
  // 2026-06-01:有 spec.default(无论模板还是字面量)的 input 不算"缺"
  //   - 后端 node_executors.execute 在 params[name] 为空时自动用 spec.default 兜底
  //   - source=schema 的 input 由运行时系统注入,不需要用户填
  const missingRequiredParams = useMemo<string[]>(() => {
    const spec = catalogEntry?.spec
    if (!spec) return []
    const params = data?.config?.params || {}
    return spec.inputs
      .filter((i: any) => {
        if (!i.required) return false
        if (params[i.name]) return false
        // schema 类:系统注入,不需用户填
        if (i.source === 'schema') return false
        // 有 default(包括模板如 {{user_query}}):运行时兜底,不算缺
        if (i.default !== null && i.default !== undefined && i.default !== '') return false
        return true
      })
      .map((i: any) => i.name)
  }, [catalogEntry, data?.config?.params])

  const hasError = useMemo<boolean>(
    () => missingRequiredParams.length > 0,
    [missingRequiredParams],
  )

  // Run 状态色块 — useNodeRunStatus hook 统一(支持 ok/fail/skipped/paused 4 态)
  const { runStatus, runStatusClass, runTooltip, runStatusEmoji } = useNodeRunStatus(props)

  const rootClass = [
    styles.wfShapeNode,
    category === 'operator' ? styles.shapeOperator : '',
    selected ? styles.selected : '',
    hasError ? styles.hasError : '',
    runStatusClass ? RUN_STATUS_CLASS_MAP[runStatusClass] || '' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={rootClass} title={runTooltip || undefined}>
      {/* SVG 形状层(fill + stroke 真实图形,drop-shadow 做阴影)*/}
      <svg
        className={styles.shapeSvg}
        viewBox="0 0 220 110"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {/* 工具:椭圆 */}
        {category === 'tool' ? (
          <ellipse
            cx="110"
            cy="55"
            rx="106"
            ry="50"
            fill={fillColor}
            stroke={strokeColor}
            strokeWidth={selected ? 3 : 2}
          />
        ) : (
          /* 算子 / 其他:圆角矩形(算子族 = 大圆角,unknown = 直角)*/
          <rect
            x="3"
            y="3"
            width="214"
            height="104"
            rx={category === 'operator' ? 24 : 6}
            ry={category === 'operator' ? 24 : 6}
            fill={fillColor}
            stroke={strokeColor}
            strokeWidth={selected ? 3 : 2}
            strokeDasharray={category === 'unknown' ? '5,4' : 'none'}
          />
        )}
      </svg>

      {/* 文本内容(覆盖在 SVG 上,pointer-events: none 不拦 Handle)*/}
      <div className={styles.shapeContent}>
        <div className={styles.shapeHeader}>
          <span className={styles.shapeIcon} style={{ color: iconColor }}>
            <IconComponent size={16} color={iconColor} stroke={1.6} />
          </span>
          <span className={styles.shapeTitle}>{title}</span>
          {costLevel >= 3 && (
            <span className={styles.shapeCost} title={costNote}>
              {'⭐'.repeat(Math.min(costLevel, 6))}
            </span>
          )}
        </div>

        <div className={styles.shapeTech}>{toolName || t('workflow.node.noTool')}</div>

        {paramsSummary && (
          <div className={styles.shapeParams} title={paramsSummary}>
            {paramsSummary}
          </div>
        )}

        {missingRequiredParams.length > 0 && (
          <div className={styles.shapeError}>
            {t('workflow.node.missingPrefix')}
            {missingRequiredParams.join(', ')}
          </div>
        )}
      </div>

      <div className={styles.shapeId}>{id}</div>

      {/* Run 状态角标(2026-05-28 节点状态机)*/}
      {runStatus && (
        <div className={`${styles.runStatusBadge} ${BADGE_CLASS_MAP[runStatus] || ''}`}>
          {runStatusEmoji}
        </div>
      )}

      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
