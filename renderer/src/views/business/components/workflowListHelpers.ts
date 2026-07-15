/**
 * WorkflowList 的纯函数 helpers — 抽出便于单测,组件内 import 复用。
 *
 * statusLabel 用 @/lang 的 t(非组件环境)。其他纯函数不依赖 i18n。
 */
import { t } from '@/lang'

export interface FilterAndSortOpts {
  /** 搜索关键词(name + description 大小写不敏感) */
  keyword?: string
  /** 状态过滤 */
  status?: 'all' | 'enabled' | 'disabled'
  /** true=updated_at 最新在前 / false=最旧在前 */
  sortDesc?: boolean
}

/**
 * 客户端过滤 + 排序 workflow 列表(不重发 API)。
 *
 * @param workflows  — 后端返回的原始列表
 * @param opts       — 过滤/排序选项
 * @returns          — 过滤排序后的新数组(不修改原数组)
 */
export function filterAndSortWorkflows(workflows: any[], opts: FilterAndSortOpts = {}): any[] {
  const { keyword = '', status = 'all', sortDesc = true } = opts
  let arr = Array.isArray(workflows) ? workflows : []

  // 1. 状态过滤
  if (status === 'enabled') arr = arr.filter((w) => w.is_enabled)
  else if (status === 'disabled') arr = arr.filter((w) => !w.is_enabled)

  // 2. 关键词搜索(name + description 大小写不敏感)
  const kw = (keyword || '').trim().toLowerCase()
  if (kw) {
    arr = arr.filter((w) => {
      const name = (w.name || '').toLowerCase()
      const desc = (w.description || '').toLowerCase()
      return name.includes(kw) || desc.includes(kw)
    })
  }

  // 3. 按 updated_at 排序(新数组,不 mutate)
  return [...arr].sort((a, b) => {
    const av = new Date(a.updated_at).getTime() || 0
    const bv = new Date(b.updated_at).getTime() || 0
    return sortDesc ? bv - av : av - bv
  })
}

/**
 * Run 状态 → ElTag type
 *
 * 2026-05-28 节点状态机升级 + 2026-05-29 paused 第 4 态:
 *   - 新枚举: 'ok' / 'fail' / 'skipped' / 'paused'(envelope shape)
 *   - 旧枚举: 'success' / 'failed'(向后兼容,旧 run 数据仍能正确显示)
 */
export function statusTagType(status: string): string {
  if (status === 'ok' || status === 'success') return 'success'
  if (status === 'fail' || status === 'failed') return 'danger'
  if (status === 'paused') return 'warning'
  if (status === 'skipped') return 'info'
  return 'info'
}

/**
 * Run / 节点是否成功(success-class 状态)— 兼容新旧枚举
 */
export function isStatusSuccess(status: string): boolean {
  return status === 'ok' || status === 'success'
}

/**
 * Run / 节点是否失败(fail-class 状态)— 兼容新旧枚举
 */
export function isStatusFailed(status: string): boolean {
  return status === 'fail' || status === 'failed'
}

/**
 * Run / 节点是否被短路跳过(skipped 灰色态,只有新枚举有)
 */
export function isStatusSkipped(status: string): boolean {
  return status === 'skipped'
}

/**
 * Run / 节点是否处于等待用户答复(paused 态,Phase B disambiguation)
 */
export function isStatusPaused(status: string): boolean {
  return status === 'paused'
}

/**
 * 把旧枚举归一化到新枚举:'success' → 'ok' / 'failed' → 'fail';其他原样返回
 * (前端 sync 节点 status 到画布时用,让节点组件只识别新枚举)
 */
export function normalizeRunStatus(status: string): string {
  if (status === 'success') return 'ok'
  if (status === 'failed') return 'fail'
  return status
}

/**
 * 状态文案 — 用于 tag 显示
 * skipped/paused 走 i18n(zh/en 切换跟随);其他状态直接显原值。
 */
export function statusLabel(status: string): string {
  if (status === 'skipped') return t('workflow.runStatus.label.skipped')
  if (status === 'paused') return t('workflow.runStatus.label.paused')
  return status
}

/**
 * ISO 时间 → "YYYY-MM-DD HH:MM" 本地时间字符串
 */
export function formatTime(iso?: string): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '-'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * node_runs 装饰:prefer 后端新字段(nr.type / nr.tool_name),
 * fallback 从 graph_snapshot.nodes 合并(老 run 兼容)。
 */
export function decorateNodeRuns(runDetail: any): any[] {
  if (!runDetail) return []
  const nodeRuns = runDetail.node_runs || []
  const graphNodes = runDetail.graph_snapshot?.nodes || []
  const graphMap = new Map<any, any>(graphNodes.map((n: any) => [n.id, n]))
  return nodeRuns.map((nr: any) => {
    const fromGraph = graphMap.get(nr.node_id) || {}
    return {
      ...nr,
      type: nr.type ?? fromGraph.type,
      tool_name: nr.tool_name ?? fromGraph.config?.tool_name,
    }
  })
}
