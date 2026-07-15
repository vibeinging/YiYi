/**
 * useNodeRunStatus — 节点 Run 状态色块的共用 hook
 *
 * 2026-05-28 节点状态机:editor 的 `syncRunStatusToNodes(run)` 把后端 envelope
 * 的 `status` / `meta` 注入到 reactflow `node.data` 字段,3 个节点组件
 * (ToolNode / ConditionNode / AgentConditionNode)调用本 hook 显示统一的
 * 状态色块 + 角标 + tooltip。
 *
 * 字段协议(单一来源,跨 editor ↔ 节点组件):
 *   - `node.data.runStatus` ∈ {'', 'ok', 'fail', 'skipped', 'paused'}
 *   - `node.data.runMeta` = envelope.meta(对象 / null)
 *
 * Status 归一化由 editor 在注入前做(success→ok / failed→fail),节点组件
 * 只识别 4 个新枚举,无需关心旧值。
 *
 * 加新状态时只改本文件:RUN_STATUS_EMOJI + RUN_STATUS_TOOLTIP_FALLBACK
 * + CSS class 名约定(.run-${status} + .badge-${status})
 */

import { useMemo } from 'react'
import { t } from '@/lang'

// 字段协议常量 — editor 写入 / 节点组件读取的唯一来源
export const NODE_RUN_STATUS_KEY = 'runStatus'
export const NODE_RUN_META_KEY = 'runMeta'

// 角标 emoji(svg-friendly 单字符)
export const RUN_STATUS_EMOJI: Record<string, string> = {
  ok: '✓',
  fail: '✕',
  skipped: '⊘',
  paused: '⏸',
}

// tooltip 兜底文案 i18n key(后端 meta 没给具体原因时)
const RUN_STATUS_TOOLTIP_KEYS: Record<string, string> = {
  skipped: 'workflow.runStatus.tooltip.skipped',
  paused: 'workflow.runStatus.tooltip.paused',
  fail: 'workflow.runStatus.tooltip.fail',
}

// envelope.meta 里"解释为什么这个状态"的字段名(后端契约,2026-05-29 inbox L1389/1391)
// skipped → meta.skip_reason / paused → meta(整 dict 都是信息,这里不专门挑)
export const META_REASON_KEYS: Record<string, string> = {
  skipped: 'skip_reason',
}

/**
 * 节点组件 hook — 接 props 直接返 4 个派生值
 *
 * 用法:
 *   const { runStatus, runStatusClass, runTooltip, runStatusEmoji } = useNodeRunStatus(props)
 *
 * @param props — react 节点组件 props(必有 .data 字段)
 */
export function useNodeRunStatus(props: any) {
  const runStatus = useMemo<string>(
    () => props?.data?.[NODE_RUN_STATUS_KEY] || '',
    [props?.data?.[NODE_RUN_STATUS_KEY]],
  )

  const runStatusClass = useMemo<string>(() => {
    const s = runStatus
    return s ? `run-${s}` : ''
  }, [runStatus])

  const runTooltip = useMemo<string>(() => {
    const s = runStatus
    if (!s) return ''
    const meta = props?.data?.[NODE_RUN_META_KEY]
    // 优先取 meta 里跟当前状态对应的解释字段
    const reasonKey = META_REASON_KEYS[s]
    if (reasonKey && meta?.[reasonKey]) return String(meta[reasonKey])
    // 兜底 i18n 文案(zh/en 切换跟随)
    const tk = RUN_STATUS_TOOLTIP_KEYS[s]
    return tk ? t(tk) : ''
  }, [runStatus, props?.data?.[NODE_RUN_META_KEY]])

  const runStatusEmoji = useMemo<string>(() => RUN_STATUS_EMOJI[runStatus] || '', [runStatus])

  return { runStatus, runStatusClass, runTooltip, runStatusEmoji }
}
