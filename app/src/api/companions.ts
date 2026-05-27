import { invoke } from '@tauri-apps/api/core'

/// 一只伙伴（用户收养的 agent 实例）。后端 schema 参见
/// `docs/design/2026-05-15_companions-system.md` 的 companions 表定义。
export interface Companion {
  id: number
  name: string
  /** 工具权限模板（code_reviewer / blank / ...）— 不展示。 */
  agent_definition_name: string
  avatar_emoji: string
  color_hex: string
  persona_md_path: string | null
  memory_user_id: string
  adopted_at: number          // 毫秒时间戳
  retired_at: number | null
  personality_stats_json: string | null
  invocation_count: number
  last_used_at: number | null
  metadata_json: string | null
  /** UI 显示的「擅长」短句，自由文本。老数据可能为 null。 */
  role_label: string | null
}

export interface AdoptCompanionInput {
  name: string
  agent_definition_name: string
  avatar_emoji: string
  color_hex: string
  /** 用户编辑的人格 Markdown。空 / 缺省 = 不设置自定义人格。 */
  persona_md?: string
  metadata_json?: string
  /** 自由文本「擅长」标签。 */
  role_label?: string
}

export interface UpdateCompanionInput {
  name?: string
  avatar_emoji?: string
  color_hex?: string
  /** `undefined` = 不动；`""` = 清空；非空 = 替换。 */
  persona_md?: string
  /** 双层 Option：外层不动；内层 null = 清空，非空 = 替换。 */
  metadata_json?: string | null
  /** 双层 Option：`undefined` = 不动；`null` = 清空；非空 = 替换。 */
  role_label?: string | null
}

export interface PreviewPersonaToneInput {
  /** 角色描述，例如「代码评审员」。 */
  role: string
  /** 0..=10: 0 = 毒舌，10 = 温和 */
  harshness: number
  /** 0..=10: 0 = 严谨，10 = 随性 */
  formality: number
  /** 0..=10: 0 = 话痨，10 = 惜字 */
  verbosity: number
}

export async function adoptCompanion(input: AdoptCompanionInput): Promise<number> {
  return await invoke<number>('adopt_companion', { input })
}

export async function updateCompanion(id: number, input: UpdateCompanionInput): Promise<void> {
  await invoke('update_companion', { id, input })
}

export async function retireCompanion(id: number): Promise<void> {
  await invoke('retire_companion', { id })
}

export async function listCompanions(includeRetired = false): Promise<Companion[]> {
  return await invoke<Companion[]>('list_companions', { includeRetired })
}

export async function getCompanion(id: number): Promise<Companion | null> {
  return await invoke<Companion | null>('get_companion', { id })
}

export async function previewPersonaTone(input: PreviewPersonaToneInput): Promise<string> {
  return await invoke<string>('preview_persona_tone', { input })
}

export async function updateCompanionDraftState(
  messageId: number,
  newState: 'pending' | 'adopted' | 'dismissed',
  adoptedCompanionId?: number,
): Promise<void> {
  await invoke('update_companion_draft_state', {
    messageId,
    newState,
    adoptedCompanionId,
  })
}
