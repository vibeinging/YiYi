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
  /** 每天定时冥想开关(C 期)。 */
  meditation_enabled: boolean
  /** 定时冥想时间 "HH:MM"(本地)。 */
  meditation_time: string
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

/** 伙伴增删改后广播 —— 常驻组件(如侧边栏好友列表)监听此事件重新拉列表,
 *  保证收养 / 改名 / 退休后 UI 即时同步,无需重启或重新挂载。 */
export const COMPANIONS_CHANGED_EVENT = 'companions:changed'
function notifyCompanionsChanged() {
  window.dispatchEvent(new CustomEvent(COMPANIONS_CHANGED_EVENT))
}

export async function adoptCompanion(input: AdoptCompanionInput): Promise<number> {
  const id = await invoke<number>('adopt_companion', { input })
  notifyCompanionsChanged()
  return id
}

/** 一键组建软件公司团队:批量收养 PM/UI/前端/后端/测试 5 个角色 + 建"软件公司"群,
 *  返回新群 group_id。收养后广播 companions:changed 让好友列表刷新。 */
export async function adoptSoftwareCompanyTeam(): Promise<number> {
  const groupId = await invoke<number>('adopt_software_company_team')
  notifyCompanionsChanged()
  return groupId
}

export async function updateCompanion(id: number, input: UpdateCompanionInput): Promise<void> {
  await invoke('update_companion', { id, input })
  notifyCompanionsChanged()
}

export async function retireCompanion(id: number): Promise<void> {
  await invoke('retire_companion', { id })
  notifyCompanionsChanged()
}

export async function listCompanions(includeRetired = false): Promise<Companion[]> {
  return await invoke<Companion[]>('list_companions', { includeRetired })
}

export async function getCompanion(id: number): Promise<Companion | null> {
  return await invoke<Companion | null>('get_companion', { id })
}

/** 读这个伙伴的人设/角色定义(persona.md 内容)。没写过则 null。 */
export async function getCompanionPersona(companionId: number): Promise<string | null> {
  return await invoke<string | null>('get_companion_persona', { companionId })
}

// ── 每天定时冥想配置(C 期)──

export interface CompanionMeditationConfig {
  enabled: boolean
  start_time: string
}

export async function getCompanionMeditationConfig(companionId: number): Promise<CompanionMeditationConfig> {
  return await invoke<CompanionMeditationConfig>('get_companion_meditation_config', { companionId })
}

export async function setCompanionMeditationConfig(
  companionId: number,
  enabled: boolean,
  startTime: string,
): Promise<void> {
  await invoke('set_companion_meditation_config', { companionId, enabled, startTime })
}

export async function previewPersonaTone(input: PreviewPersonaToneInput): Promise<string> {
  return await invoke<string>('preview_persona_tone', { input })
}

/** YiYi 据一句话描述生成的伙伴雏形 —— 回填收养向导,用户仍可逐项改。 */
export interface GeneratedCompanion {
  avatar_emoji: string
  name: string
  role_label: string
  harshness: number
  formality: number
  verbosity: number
}

/** 「YiYi 帮我想」:一句话描述 → LLM 生成 emoji / 名字 / 擅长 / 脾气,回填收养向导。 */
export async function generateCompanion(description: string): Promise<GeneratedCompanion> {
  return await invoke<GeneratedCompanion>('generate_companion', { description })
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
