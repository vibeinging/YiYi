/**
 * Condition 节点(真菱形 / SVG polygon)
 *
 * 设计:
 * - 160×160 正方形 wrapper,SVG polygon 画菱形(顶点 = 上中/右中/下中/左中)
 * - reactflow Handle 默认 Position.Left/Right/Bottom 落在 wrapper 边中点,
 *   正好 = 菱形顶点 → 端口位置自然对齐,无需手动偏移
 * - 文本内容在 .diamondContent 居中,菱形内接正方形约 113×113,padding 28 → 文本安全区 ~80×80
 * - true 分支走右顶点(主路径)、false 走下顶点(替代路径),符合常见 flowchart 习惯
 */
import { useMemo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { useTranslation } from 'react-i18next'
import ElSvgIcon from '@/components/ElSvgIcon'
import { useNodeRunStatus } from './useNodeRunStatus'
import styles from './ConditionNode.module.scss'

interface ConditionNodeProps {
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

export default function ConditionNode(props: NodeProps | ConditionNodeProps) {
  const { id, data, selected } = props as ConditionNodeProps
  const { t } = useTranslation()

  const title = useMemo(
    () => data?.displayName || t('workflow.node.condTitle'),
    [data?.displayName, t],
  )

  const fullExpression = useMemo<string>(
    () => data?.config?.expression || '',
    [data?.config?.expression],
  )

  // 菱形内文本区有限,预览 truncate 短一些(< 28 字符)
  const exprPreview = useMemo<string>(() => {
    const e = fullExpression
    if (!e) return ''
    return e.length > 28 ? e.slice(0, 28) + '…' : e
  }, [fullExpression])

  const hasError = useMemo<boolean>(() => !fullExpression, [fullExpression])

  // Run 状态色块 — useNodeRunStatus hook 统一(支持 ok/fail/skipped/paused 4 态)
  const { runStatus, runStatusClass, runTooltip, runStatusEmoji } = useNodeRunStatus(props)

  const rootClass = [
    styles.conditionDiamond,
    selected ? styles.selected : '',
    runStatusClass ? RUN_STATUS_CLASS_MAP[runStatusClass] || '' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={rootClass} title={runTooltip || undefined}>
      {/* SVG 菱形背景:fill + stroke 真实菱形,自带边框 */}
      <svg
        className={styles.diamondSvg}
        viewBox="0 0 160 160"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <polygon
          points="80,4 156,80 80,156 4,80"
          fill={hasError ? '#fef2f2' : '#fffbeb'}
          stroke={selected ? '#d97706' : '#f59e0b'}
          strokeWidth={selected ? 3 : 2}
          strokeLinejoin="round"
        />
      </svg>

      {/* 文本内容(覆盖在 SVG 上方,pointer-events: none 避免拦 handle 点击)*/}
      <div className={styles.diamondContent}>
        <span className={styles.diamondIcon}>
          <ElSvgIcon name="Switch" size={18} color="#d97706" />
        </span>
        <div className={styles.diamondTitle}>{title}</div>
        {exprPreview ? (
          <div className={styles.diamondExpr} title={fullExpression}>
            {exprPreview}
          </div>
        ) : (
          <div className={styles.diamondError}>{t('workflow.node.missingExpr')}</div>
        )}
      </div>

      {/* reactflow Handles(位置默认对齐 wrapper 边中点 = 菱形顶点)*/}
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} id="true" className="wf-handle-true" />
      <Handle type="source" position={Position.Bottom} id="false" className="wf-handle-false" />

      {/* 端口标签(true 右侧 / false 下方)*/}
      <span className={`${styles.branchLabel} ${styles.branchLabelTrue}`}>true</span>
      <span className={`${styles.branchLabel} ${styles.branchLabelFalse}`}>false</span>

      <div className={styles.nodeId}>{id}</div>

      {/* Run 状态角标(2026-05-28 节点状态机)*/}
      {runStatus && (
        <div className={`${styles.runStatusBadge} ${BADGE_CLASS_MAP[runStatus] || ''}`}>
          {runStatusEmoji}
        </div>
      )}
    </div>
  )
}
