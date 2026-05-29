/**
 * 群(companion group)表单校验 —— 两个建群入口共用同一套规则,
 * 避免 BuddyPanel 的 FamilyGroupsSection 和聊天里的 FamilyMembersModal
 * 校验不一致(一处可建 0/1 人群、一处要求 ≥2 人)。见 P2 修复。
 */

/** 建群最少成员数:1 个人直接在输入框 @ 那位即可,不需要建群。 */
export const MIN_GROUP_MEMBERS = 2

/**
 * 校验群表单。返回错误文案(应 toast.error 出来),null 表示通过。
 * @param isCreate 新建时强制 ≥ MIN_GROUP_MEMBERS;编辑时只校验群名非空
 *   (允许临时把成员调整到更少,但仍至少 1 人,空群无意义)。
 */
export function validateGroupForm(
  name: string,
  memberIds: Set<number>,
  isCreate: boolean,
): string | null {
  if (!name.trim()) return '群名不能为空'
  if (isCreate && memberIds.size < MIN_GROUP_MEMBERS) {
    return `群需要至少 ${MIN_GROUP_MEMBERS} 位成员(单聊一位直接在输入框 @)`
  }
  if (!isCreate && memberIds.size < 1) {
    return '群至少保留 1 位成员(想退回单聊请用"解散群")'
  }
  return null
}
