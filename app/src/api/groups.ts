/**
 * 家族(companion groups)API —— 持久化的"群聊式"分身分组(IM 心智)。
 *
 * 多对多关系:一个 companion 可同时在多个组(类比微信群)。每组对应一个
 * `family_shared_<id>` 记忆桶,通过 `MemoryScope::FamilyGroup(id)` 路由。
 * session 1:1 绑 group:group_id=null → 单聊主精灵;group_id=N → 群聊家族 N。
 *
 * 设计:docs/design/2026-05-28_im 心智对齐.md。
 */

import { invoke } from '@tauri-apps/api/core'
import type { Companion } from './companions'

export interface CompanionGroup {
  id: number
  name: string
  emoji: string | null
  color_hex: string | null
  created_at: number
  updated_at: number
}

// ── group CRUD ────────────────────────────────────────────────────────

export async function createCompanionGroup(
  name: string,
  emoji?: string | null,
  colorHex?: string | null,
): Promise<number> {
  return await invoke<number>('create_companion_group', {
    name,
    emoji: emoji ?? null,
    colorHex: colorHex ?? null,
  })
}

export async function listCompanionGroups(): Promise<CompanionGroup[]> {
  return await invoke<CompanionGroup[]>('list_companion_groups')
}

export async function getCompanionGroup(id: number): Promise<CompanionGroup | null> {
  return await invoke<CompanionGroup | null>('get_companion_group', { id })
}

export async function updateCompanionGroup(
  id: number,
  name: string,
  emoji?: string | null,
  colorHex?: string | null,
): Promise<void> {
  await invoke('update_companion_group', {
    id,
    name,
    emoji: emoji ?? null,
    colorHex: colorHex ?? null,
  })
}

/** 删组:成员关系通过 FK 级联清除;sessions.group_id 引用此组的会被置 NULL
 *  (那些 session 退化为单聊);**不删** family_shared_<id> 记忆桶(留作孤儿桶,
 *  在 BuddyPanel 里手动清,避免误删带来惊讶)。 */
export async function deleteCompanionGroup(id: number): Promise<void> {
  await invoke('delete_companion_group', { id })
}

// ── membership ────────────────────────────────────────────────────────

export async function addCompanionToGroup(groupId: number, companionId: number): Promise<void> {
  await invoke('add_companion_to_group', { groupId, companionId })
}

export async function removeCompanionFromGroup(
  groupId: number,
  companionId: number,
): Promise<void> {
  await invoke('remove_companion_from_group', { groupId, companionId })
}

export async function listGroupMembers(groupId: number): Promise<Companion[]> {
  return await invoke<Companion[]>('list_group_members', { groupId })
}

export async function listGroupsForCompanion(companionId: number): Promise<CompanionGroup[]> {
  return await invoke<CompanionGroup[]>('list_groups_for_companion', { companionId })
}

/** 建群 + 加成员的原子封装:加成员中途失败则回滚删组,不留半成品群。
 *  返回新组 id。两个建群入口(BuddyPanel / 聊天里邀请)共用,避免回滚逻辑双份维护。
 *  各入口的差异(绑当前会话 vs 开新会话)留在调用方处理。 */
export async function createGroupWithMembers(
  name: string,
  emoji: string | null,
  memberIds: Iterable<number>,
): Promise<number> {
  const gid = await createCompanionGroup(name, emoji, null)
  try {
    for (const cid of memberIds) {
      await addCompanionToGroup(gid, cid)
    }
  } catch (e) {
    await deleteCompanionGroup(gid).catch(() => {})
    throw e
  }
  return gid
}

// ── session ↔ group binding ───────────────────────────────────────────

/** 绑定会话到指定家族(null = 解绑变回单聊)。 */
export async function setSessionGroup(sessionId: string, groupId: number | null): Promise<void> {
  await invoke('set_session_group', { sessionId, groupId })
}

export async function getSessionGroup(sessionId: string): Promise<number | null> {
  return await invoke<number | null>('get_session_group', { sessionId })
}

/** 桶命名约定(与后端 `family_group_bucket` 同步):每个家族独占
 *  `family_shared_<group_id>` 桶。BuddyPanel 浏览各家族记忆时按这个算 user_id。 */
export function familyGroupBucket(groupId: number): string {
  return `family_shared_${groupId}`
}
