/**
 * 家族(companion groups)的轻量全局缓存 —— 让 TaskSidebar(session 列表前缀)、
 * ChatInput(家族下拉)、BuddyPanel(家族共享记忆 chips)等多组件读同一份数据。
 *
 * 用法:在创建/删除/重命名家族的地方调 `useGroupsStore.getState().load()`,
 * 所有订阅方自动重渲染。
 */

import { create } from 'zustand'
import { listCompanionGroups, type CompanionGroup } from '../api/groups'

interface GroupsStore {
  groups: CompanionGroup[]
  /** id → group 的快速查表(渲染 session 前缀、聊天 header 等用)。 */
  byId: Map<number, CompanionGroup>
  loaded: boolean
  /** 拉一次全量,刷新缓存。失败不抛(空缓存退化为"没有家族")。 */
  load: () => Promise<void>
}

export const useGroupsStore = create<GroupsStore>((set) => ({
  groups: [],
  byId: new Map(),
  loaded: false,
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
}))
