/**
 * 家族(companion groups)的轻量全局缓存 —— 让 TaskSidebar(session 列表头像)、
 * ChatHeader(群名 + 成员头像)、BuddyPanel(家族共享记忆 chips)等多组件读同一份。
 *
 * 两层缓存:
 * - 组元数据(`groups` / `byId`):一次性全量拉。
 * - 组成员(`membersByGroup`):按需拉,每个组一次,后续命中缓存。
 *   `ensureMembers(gid)` 是 AvatarGrid / ChatHeader 等的入口。
 *
 * 用法:CRUD 后调 `useGroupsStore.getState().load()` 刷新元数据;成员变化时
 * 调 `invalidateMembers(gid)` 清缓存,组件下次再渲会重拉。
 */

import { create } from 'zustand'
import { listCompanionGroups, listGroupMembers, type CompanionGroup } from '../api/groups'
import type { Companion } from '../api/companions'

interface GroupsStore {
  groups: CompanionGroup[]
  /** id → group 的快速查表(渲染 session header / list 等用)。 */
  byId: Map<number, CompanionGroup>
  loaded: boolean
  /** id → group members 的懒加载缓存。undefined = 没拉过;[] = 拉过但空。 */
  membersByGroup: Map<number, Companion[]>
  /** 正在拉的 group → 共享 Promise(并发调用方 await 同一个,而非靠 setTimeout 猜时间)。 */
  pendingMembers: Map<number, Promise<Companion[]>>

  /** 拉一次全量元数据,刷新缓存。失败不抛(空缓存退化为"没有家族")。 */
  load: () => Promise<void>
  /** 按需拉 group 成员;命中缓存就立即返回。失败回退空数组。 */
  ensureMembers: (groupId: number) => Promise<Companion[]>
  /** 清单个 group 的成员缓存(成员变化后调,触发下次重拉)。 */
  invalidateMembers: (groupId: number) => void
}

export const useGroupsStore = create<GroupsStore>((set, get) => ({
  groups: [],
  byId: new Map(),
  loaded: false,
  membersByGroup: new Map(),
  pendingMembers: new Map(),

  load: async () => {
    try {
      const groups = await listCompanionGroups()
      const byId = new Map(groups.map(g => [g.id, g]))
      set({ groups, byId, loaded: true })
    } catch (e) {
      console.error('groupsStore.load failed', e)
      // 保留旧缓存,下次再试。
      set({ loaded: true })
    }
  },

  ensureMembers: async (groupId: number) => {
    const cached = get().membersByGroup.get(groupId)
    if (cached) return cached
    // 已经在拉 → 并发调用方共享同一个 Promise(而非靠 setTimeout(0) 猜时间,
    // 那样会在真正拉好前返回空数组,把组件钉死在空成员)。
    const inflight = get().pendingMembers.get(groupId)
    if (inflight) return inflight

    const clearPending = () =>
      set(prev => {
        const nextPending = new Map(prev.pendingMembers)
        nextPending.delete(groupId)
        return { pendingMembers: nextPending }
      })
    const promise = listGroupMembers(groupId)
      .then(members => {
        set(prev => {
          const nextMembers = new Map(prev.membersByGroup)
          nextMembers.set(groupId, members)
          return { membersByGroup: nextMembers }
        })
        return members
      })
      .catch(e => {
        console.error(`groupsStore.ensureMembers(${groupId}) failed`, e)
        return [] as Companion[]
      })
      .finally(clearPending)
    set(prev => {
      const nextPending = new Map(prev.pendingMembers)
      nextPending.set(groupId, promise)
      return { pendingMembers: nextPending }
    })
    return promise
  },

  invalidateMembers: (groupId: number) => {
    set(prev => {
      if (!prev.membersByGroup.has(groupId)) return prev
      const next = new Map(prev.membersByGroup)
      next.delete(groupId)
      return { membersByGroup: next }
    })
  },
}))
