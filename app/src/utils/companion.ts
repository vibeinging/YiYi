/** Shared helpers for the companion ("伙伴 / 家族") subsystem. */

import type { Companion } from '../api/companions'

/** Fallback labels for the tool-permission template slug, used only when
 *  a companion has no `role_label`. The slug is *not* the role — it's the
 *  underlying AgentDefinition that controls baseline tool access. */
const TEMPLATE_FALLBACK_LABELS: Record<string, string> = {
  code_reviewer: '代码评审员',
  product_strategist: '产品军师',
  life_coach: '人生教练',
  blank: '自定义',
}

/** Display label for the companion's "擅长" / role. Prefers the free-text
 *  `role_label`; falls back to a slug-derived label so legacy rows
 *  (created before the column existed) still show something readable. */
export function companionRoleLabel(c: Pick<Companion, 'role_label' | 'agent_definition_name'>): string {
  const trimmed = c.role_label?.trim()
  if (trimmed) return trimmed
  return TEMPLATE_FALLBACK_LABELS[c.agent_definition_name] ?? c.agent_definition_name
}

/** Legacy form: takes just the slug. Used by AdoptModal preset previews
 *  where the user hasn't typed a free-text role yet. */
export function companionTemplateLabel(slug: string): string {
  return TEMPLATE_FALLBACK_LABELS[slug] ?? slug
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
