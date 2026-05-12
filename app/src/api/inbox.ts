import { invoke } from '@tauri-apps/api/core'

// Growth V3 — White-box co-construction inbox.
// 设计文档：docs/design/2026-05-11_growth-v3-白盒共建.md

export type InboxKind = 'skill_create' | 'skill_merge' | 'skill_archive' | 'principle_add'
export type InboxStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'edited'
export type InboxSource = 'meditation' | 'user_request'
export type InboxUserAction = 'approve' | 'reject' | 'edit_approve' | 'withdraw'

export interface InboxItem {
  id: string
  kind: InboxKind
  status: InboxStatus
  draft_json: string
  source: InboxSource
  reason: string
  confidence: number
  evidence_json: string | null
  created_at: number
  reviewed_at: number | null
  applied_at: number | null
  user_action: InboxUserAction | null
  user_edited_json: string | null
  user_note: string | null
}

/** Draft body parsed from `inbox_items.draft_json` for kind='skill_create'. */
export interface SkillDraft {
  name: string
  description: string
  content: string
  confidence: number
  reason: string
}

export interface NgramEvidence {
  tools: string[]
  occurrence_count: number
  session_ids: string[]
}

export interface ProposeResult {
  created_count: number
  item_ids: string[]
}

export async function proposeSkillsNow(): Promise<ProposeResult> {
  return await invoke<ProposeResult>('propose_skills_now')
}

export async function listInboxItems(
  status?: InboxStatus,
  limit = 50,
): Promise<InboxItem[]> {
  return await invoke<InboxItem[]>('list_inbox_items', { status, limit })
}

export async function countPendingInbox(): Promise<number> {
  return await invoke<number>('count_pending_inbox')
}

export async function getInboxItem(id: string): Promise<InboxItem | null> {
  return await invoke<InboxItem | null>('get_inbox_item', { id })
}

export async function approveInboxItem(
  id: string,
  editedContent?: string,
  note?: string,
): Promise<void> {
  return await invoke<void>('approve_inbox_item', {
    id,
    editedContent: editedContent ?? null,
    note: note ?? null,
  })
}

export async function rejectInboxItem(id: string, note?: string): Promise<void> {
  return await invoke<void>('reject_inbox_item', { id, note: note ?? null })
}

export async function withdrawInboxItem(id: string): Promise<void> {
  return await invoke<void>('withdraw_inbox_item', { id })
}

/** Safe parse helper — drafts come down as JSON strings inside the row. */
export function parseSkillDraft(item: InboxItem): SkillDraft | null {
  if (item.kind !== 'skill_create') return null
  try {
    return JSON.parse(item.draft_json) as SkillDraft
  } catch {
    return null
  }
}

export function parseEvidence(item: InboxItem): NgramEvidence | null {
  if (!item.evidence_json) return null
  try {
    return JSON.parse(item.evidence_json) as NgramEvidence
  } catch {
    return null
  }
}
