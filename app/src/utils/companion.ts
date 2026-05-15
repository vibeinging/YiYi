/** Shared helpers for the companion ("伙伴 / 家族") subsystem. */

/** Slug → Chinese role label. Source of truth for `agent_definition_name`
 *  presentation across CompanionCard / AdoptModal / ChatInput. Keep in sync
 *  with the AGENT.md description lines under `app/src-tauri/agents/`. */
export const COMPANION_ROLE_LABELS: Record<string, string> = {
  code_reviewer: '代码评审员',
  product_strategist: '产品军师',
  life_coach: '人生教练',
}

export function companionRoleLabel(agentDefinitionName: string): string {
  return COMPANION_ROLE_LABELS[agentDefinitionName] || agentDefinitionName
}

const MS_PER_DAY = 86_400_000

/** Days between `ts` (millis) and now, floored at 0. */
export function daysSinceMs(ts: number): number {
  return Math.max(0, Math.floor((Date.now() - ts) / MS_PER_DAY))
}

/** ISO-style `YYYY-MM-DD` for a millis timestamp. */
export function formatYmd(ts: number): string {
  const d = new Date(ts)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}
