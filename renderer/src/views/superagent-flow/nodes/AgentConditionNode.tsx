/**
 * AgentConditionNode — LLM 语义判断的条件分支节点
 *
 * 设计跟 ConditionNode 一致(SVG polygon 真菱形 + 双输出端口 true/false),
 * 区别:
 * - 配色用暖红族(condition 是黄)体现"AI 特色"
 * - icon 用 ⚡(MagicStick),区分 Switch
 * - prompt 字段(textarea)替代 expression
 * - 后端节点 node.type = 'agent_condition'(跟 'condition' 严格区分)
 *
 * 端口/分支机制完全复用 condition:right 顶点 true / bottom 顶点 false。
 */
import { useMemo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { useTranslation } from 'react-i18next'
import ElSvgIcon from '@/components/ElSvgIcon'
import { useNodeRunStatus } from './useNodeRunStatus'
import styles from './AgentConditionNode.module.scss'

interface AgentConditionNodeProps {
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

export default function AgentConditionNode(props: NodeProps | AgentConditionNodeProps) {
  const { id, data, selected } = props as AgentConditionNodeProps
  const { t } = useTranslation()

  const title = useMemo(
    () => data?.displayName || t('workflow.node.agentTitle'),
    [data?.displayName, t],
  )

  const fullPrompt = useMemo<string>(() => data?.config?.prompt || '', [data?.config?.prompt])

  // 菱形内文本区有限,prompt 预览 < 32 字符
  const promptPreview = useMemo<string>(() => {
    const p = fullPrompt
    if (!p) return ''
    return p.length > 32 ? p.slice(0, 32) + '…' : p
  }, [fullPrompt])

  const hasError = useMemo<boolean>(() => !fullPrompt, [fullPrompt])

  // Run 状态色块 — useNodeRunStatus hook 统一(支持 ok/fail/skipped/paused 4 态)
  const { runStatus, runStatusClass, runTooltip, runStatusEmoji } = useNodeRunStatus(props)

  const rootClass = [
    styles.agentConditionDiamond,
    selected ? styles.selected : '',
    runStatusClass ? RUN_STATUS_CLASS_MAP[runStatusClass] || '' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={rootClass} title={runTooltip || undefined}>
      {/* SVG 菱形背景:暖红族 */}
      <svg
        className={styles.diamondSvg}
        viewBox="0 0 160 160"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <polygon
          points="80,4 156,80 80,156 4,80"
          fill={hasError ? '#fef2f2' : '#fdf4ff'}
          stroke={selected ? '#c65d3d' : '#d4743f'}
          strokeWidth={selected ? 3 : 2}
          strokeLinejoin="round"
        />
      </svg>

      {/* 文本内容 */}
      <div className={styles.diamondContent}>
        <span className={styles.diamondIcon}>
          <ElSvgIcon name="MagicStick" size={18} color="#c65d3d" />
        </span>
        <div className={styles.diamondTitle}>{title}</div>
        {promptPreview ? (
          <div className={styles.diamondPrompt} title={fullPrompt}>
            {promptPreview}
          </div>
        ) : (
          <div className={styles.diamondError}>{t('workflow.node.missingPrompt')}</div>
        )}
      </div>

      {/* reactflow Handles */}
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} id="true" className="wf-handle-true" />
      <Handle type="source" position={Position.Bottom} id="false" className="wf-handle-false" />

      {/* 端口标签 */}
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
