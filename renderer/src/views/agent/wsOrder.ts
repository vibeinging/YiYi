// 工作区自定义排序 —— 纯前端持久化到 localStorage。
// 仅记录「被用户拖动过的」顺序;未在表中的工作区(新建/未拖过)回落到自然序(= 创建时间)。
// 纯聊天(__chat__)恒在最前,不参与排序。
import { CHAT_WS } from './folders'
import type { Workspace } from './YiWNav'

const KEY = 'yiw-ws-order'

export function loadWsOrder(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function saveWsOrder(order: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(order))
  } catch {
    /* ignore */
  }
}

// 按保存的顺序重排:纯聊天置顶 → 已记录顺序的工作区 → 其余按自然序(创建时间)追加在后。
export function applyWsOrder(workspaces: Workspace[], order: string[]): Workspace[] {
  const chat = workspaces.filter((w) => w.id === CHAT_WS.id)
  const rest = workspaces.filter((w) => w.id !== CHAT_WS.id)
  const byId = new Map(rest.map((w) => [w.id, w]))
  const known = order.map((id) => byId.get(id)).filter((w): w is Workspace => !!w)
  const knownIds = new Set(known.map((w) => w.id))
  const unknown = rest.filter((w) => !knownIds.has(w.id)) // 未拖过的(含新建)→ 留自然序,排在后
  return [...chat, ...known, ...unknown]
}

// 把 srcId 移动到 dstId 之前,返回新的顺序数组(只含非纯聊天工作区)。
export function moveBefore(orderedIds: string[], srcId: string, dstId: string): string[] {
  if (srcId === dstId) return orderedIds
  const ids = orderedIds.filter((id) => id !== srcId)
  const at = ids.indexOf(dstId)
  if (at < 0) ids.push(srcId)
  else ids.splice(at, 0, srcId)
  return ids
}
