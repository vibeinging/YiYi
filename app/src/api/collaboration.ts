/**
 * TypeScript surface for the collaboration subsystem.
 *
 * All types mirror the Rust serde tags exactly — when the backend uses
 * `#[serde(rename_all = "snake_case", tag = "...")]`, the same string
 * literal types appear here. Don't paraphrase — drift will silently
 * break parsing at runtime.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

// ── Identifiers ──────────────────────────────────────────────────────

export type CollaborationId = number
export type StepId = number
export type CompanionId = number

// ── Plan & Step ──────────────────────────────────────────────────────

/** Mirrors Rust `MemoryScope` enum. */
export type MemoryScope = 'private' | 'shared' | 'family'

/** Mirrors Rust `StepKind`. */
export type StepKind = 'single_agent' | 'parallel_agents' | 'host_summarize' | 'user_confirmation'

/** Mirrors Rust `StepStatus`. */
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

export interface Participant {
  companion_id: CompanionId
  name: string
  avatar_emoji: string
  color_hex: string
  memory_scope: MemoryScope
}

export interface TokenUsage {
  input: number
  output: number
}

export interface StepInput {
  prompt: string
  metadata: unknown
}

export interface StepOutput {
  summary: string
  full_output: string
  tokens_used: TokenUsage
  duration_ms: number
}

export interface Step {
  id: StepId
  kind: StepKind
  participants: Participant[]
  depends_on: StepId[]
  input: StepInput
  output: StepOutput | null
  status: StepStatus
  started_at: number | null
  finished_at: number | null
}

export interface CollaborationPlan {
  steps: Step[]
}

// ── Collaboration ────────────────────────────────────────────────────

/** Mirrors Rust `CollaborationMode` — adjacently tagged. */
export type CollaborationMode =
  | { kind: 'manual' }
  | { kind: 'dispatched'; by: CompanionId }

/** Mirrors Rust `CollaborationStatus` — adjacently tagged (state / reason). */
export type CollaborationStatus =
  | { state: 'planning' }
  | { state: 'awaiting_confirm' }
  | { state: 'running' }
  | { state: 'done' }
  | { state: 'aborted' }
  | { state: 'failed'; reason: string }

export interface Collaboration {
  id: CollaborationId
  chat_session_id: string
  intent: string
  mode: CollaborationMode
  status: CollaborationStatus
  plan: CollaborationPlan
  parent_id: CollaborationId | null
  created_at: number
  completed_at: number | null
}

export function isTerminalStatus(s: CollaborationStatus): boolean {
  return s.state === 'done' || s.state === 'aborted' || s.state === 'failed'
}

// ── Audit & Events ───────────────────────────────────────────────────

export type Actor =
  | { kind: 'system' }
  | { kind: 'user' }
  | { kind: 'companion'; id: CompanionId }

export type AuditKind =
  | 'submitted'
  | 'confirmed'
  | 'collaboration_completed'
  | 'aborted'
  | 'failed'
  | 'step_started'
  | 'step_completed'
  | 'step_failed'
  | 'step_skipped'
  | 'step_added'
  | 'step_retried'
  | 'dispatch_judged'
  | 'user_recalled'
  | 'user_corrected'
  | 'user_verdict_reaction'

export interface AuditEvent {
  collaboration_id: CollaborationId
  timestamp: number
  actor: Actor
  kind: AuditKind
  payload: unknown
}

/** Mirrors Rust `CollaborationEvent` — externally tagged with a named
 *  inner field for `Audit` (avoids the discriminator name colliding with
 *  `AuditEvent.kind`). The Rust definition uses
 *  `Audit { event: AuditEvent }` rather than a newtype variant. */
export type CollaborationEventWire =
  | { kind: 'audit'; event: AuditEvent }
  | {
      kind: 'token'
      collaboration_id: CollaborationId
      step_id: StepId
      companion_id: CompanionId
      delta: string
      // 正文 vs 思考(reasoning/thinking)分流 —— 子 agent 思考块据此累积。
      reasoning: boolean
    }
  // 群事件循环:某成员开始发言 → 让它的气泡错时冒出(变速参差)。
  | {
      kind: 'member_thinking'
      collaboration_id: CollaborationId
      step_id: StepId
      companion_id: CompanionId
    }

// ── Mutations ────────────────────────────────────────────────────────

export type Mutation =
  | { kind: 'add_step'; step: Step }
  | { kind: 'retry_step'; step_id: StepId }
  | { kind: 'skip_step'; step_id: StepId }
  | { kind: 'change_participant'; step_id: StepId; participant: Participant }

// ── Tauri commands ───────────────────────────────────────────────────

export async function submitCollaboration(
  chatSessionId: string,
  intent: string,
  plan: CollaborationPlan,
  mode: CollaborationMode,
  parentId?: CollaborationId,
): Promise<CollaborationId> {
  return await invoke<CollaborationId>('collaboration_submit', {
    chatSessionId,
    intent,
    plan,
    mode,
    parentId: parentId ?? null,
  })
}

export async function confirmCollaboration(
  id: CollaborationId,
  editedPlan?: CollaborationPlan,
): Promise<void> {
  await invoke('collaboration_confirm', { id, editedPlan: editedPlan ?? null })
}

export async function abortCollaboration(id: CollaborationId): Promise<void> {
  await invoke('collaboration_abort', { id })
}

export async function mutateCollaboration(id: CollaborationId, mutation: Mutation): Promise<void> {
  await invoke('collaboration_mutate', { id, mutation })
}

export async function getCollaboration(id: CollaborationId): Promise<Collaboration | null> {
  return await invoke<Collaboration | null>('collaboration_get', { id })
}

/** 拉一个 collaboration 的全部 audit 事件(最早→最新)。前端 hydrate 后调,
 *  让刷新 / 重放也能看到诸如 `dispatch_judged` 的路由理由。 */
export async function getCollaborationAudit(id: CollaborationId): Promise<AuditEvent[]> {
  return await invoke<AuditEvent[]>('collaboration_audit', { id })
}

export async function listRecentCollaborations(
  chatSessionId: string,
  limit?: number,
): Promise<Collaboration[]> {
  return await invoke<Collaboration[]>('collaboration_list_recent', {
    chatSessionId,
    limit: limit ?? null,
  })
}

// ── Event subscription ───────────────────────────────────────────────

/** Subscribe to the global collaboration event stream emitted by the
 *  Rust-side broadcast bridge (lib.rs setup). Caller filters by id —
 *  consistent with `Orchestrator::subscribe_all`. Returns an unlisten
 *  fn; call it on cleanup. */
export async function subscribeCollaborationEvents(
  handler: (event: CollaborationEventWire) => void,
): Promise<UnlistenFn> {
  return await listen<CollaborationEventWire>('collaboration://event', evt => {
    handler(evt.payload)
  })
}

// ── Plan factories ───────────────────────────────────────────────────

/** Construct a plan with one `SingleAgent` step targeting one companion.
 *  The most common Phase 2B pattern: user "@阿狸 ..." → this. */
export function planSingleCompanion(participant: Participant, prompt: string): CollaborationPlan {
  return {
    steps: [
      {
        id: 1,
        kind: 'single_agent',
        participants: [participant],
        depends_on: [],
        input: { prompt, metadata: null },
        output: null,
        status: 'pending',
        started_at: null,
        finished_at: null,
      },
    ],
  }
}
