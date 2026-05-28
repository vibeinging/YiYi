/**
 * Live state for in-flight and recently-completed collaborations.
 *
 * Two responsibilities:
 *   1. Hydrate from `collaboration_get` on first interest in an id.
 *   2. Subscribe to the global `collaboration://event` Tauri stream and
 *      demux events back into the right collaboration / step buffers.
 *
 * Single subscription, global handler — Tauri's `listen` returns one
 * channel per call so we share one subscription across the app and let
 * the store dispatch by id. Components select what they need with
 * Zustand selectors and re-render only when their slice changes.
 */

import { create } from 'zustand'
import { type UnlistenFn } from '@tauri-apps/api/event'
import {
  getCollaboration,
  getCollaborationAudit,
  isTerminalStatus,
  subscribeCollaborationEvents,
  type AuditEvent,
  type Collaboration,
  type CollaborationEventWire,
  type CollaborationId,
  type CollaborationStatus,
  type Step,
  type StepId,
} from '../api/collaboration'

/** Concatenated token deltas for one (step, companion) pair. */
export interface ParticipantStream {
  companion_id: number
  text: string
}

export interface CollaborationState {
  /** Full snapshot from the backend, refreshed on terminal events. */
  collaboration: Collaboration
  /**
   * Live audit feed in arrival order. The backend also persists these;
   * we keep an in-memory copy so UI can render without an extra `get`.
   */
  audit: {
    timestamp: number
    actor: unknown
    kind: string
    payload: unknown
  }[]
  /**
   * Live token streams keyed by `step_id:companion_id`. Cleared when the
   * step transitions to a terminal status (the backend's `output.summary`
   * is the durable record from then on).
   */
  streams: Map<string, ParticipantStream>
}

interface StoreState {
  collaborations: Map<CollaborationId, CollaborationState>
  /** Active subscription handle for unsubscribe at app teardown. */
  unlisten: UnlistenFn | null
  /** Have we wired up the global listener yet? */
  subscribed: boolean
}

interface StoreActions {
  /**
   * Set up the global event listener. Idempotent — calling twice is a
   * no-op. Call once near app boot (e.g. from a top-level effect).
   */
  ensureSubscribed: () => Promise<void>
  /** Tear down the global listener (test / app shutdown). */
  unsubscribe: () => void

  /**
   * Pull the current snapshot for `id` and seed our store with it.
   * Subsequent events apply on top. Returns the snapshot or `null` if
   * the backend doesn't know this id.
   */
  hydrate: (id: CollaborationId) => Promise<Collaboration | null>

  /** Selector helpers. Cheap re-render-friendly. */
  get: (id: CollaborationId) => CollaborationState | undefined

  /** Drop a single collaboration's tracked state (after user dismisses). */
  forget: (id: CollaborationId) => void

  /** Internal — apply one wire event from the Tauri stream. */
  _applyEvent: (event: CollaborationEventWire) => void
}

export const useCollaborationStore = create<StoreState & StoreActions>((set, get) => ({
  collaborations: new Map(),
  unlisten: null,
  subscribed: false,

  ensureSubscribed: async () => {
    if (get().subscribed) return
    // Mark subscribed up front so concurrent callers don't double-listen.
    set({ subscribed: true })
    try {
      const unlisten = await subscribeCollaborationEvents(event => {
        get()._applyEvent(event)
      })
      set({ unlisten })
    } catch (e) {
      console.error('collaborationStore: subscribe failed', e)
      set({ subscribed: false })
    }
  },

  unsubscribe: () => {
    const { unlisten } = get()
    if (unlisten) {
      unlisten()
    }
    set({ unlisten: null, subscribed: false })
  },

  hydrate: async (id: CollaborationId) => {
    // 并行拉 snapshot 与 audit。audit 失败容忍（不阻断卡片渲染）—— 旧 collaboration
    // 的事件列可能缺失，但 plan + status 仍可用。
    const [snapshot, audit] = await Promise.all([
      getCollaboration(id),
      getCollaborationAudit(id).catch(() => [] as AuditEvent[]),
    ])
    if (!snapshot) return null
    set(prev => {
      const next = new Map(prev.collaborations)
      const existing = next.get(id)
      next.set(id, {
        collaboration: snapshot,
        // 持久 audit 是权威源（emit 先落库再广播，所以至少不少于 live 累积）。
        // 后续 live 事件继续 append 到这里。
        audit: audit.map(e => ({
          timestamp: e.timestamp,
          actor: e.actor,
          kind: e.kind,
          payload: e.payload,
        })),
        streams: existing?.streams ?? new Map(),
      })
      return { collaborations: next }
    })
    return snapshot
  },

  get: (id: CollaborationId) => get().collaborations.get(id),

  forget: (id: CollaborationId) => {
    set(prev => {
      if (!prev.collaborations.has(id)) return prev
      const next = new Map(prev.collaborations)
      next.delete(id)
      return { collaborations: next }
    })
  },

  _applyEvent: (event: CollaborationEventWire) => {
    const id = event.kind === 'token' ? event.collaboration_id : event.event.collaboration_id
    set(prev => {
      const existing = prev.collaborations.get(id)
      if (!existing) {
        // Event arrived before hydration. Drop it; consumers pick up
        // current state via `hydrate` when they care.
        return prev
      }
      const next = new Map(prev.collaborations)
      if (event.kind === 'token') {
        const key = `${event.step_id}:${event.companion_id}`
        const newStreams = new Map(existing.streams)
        const cur = newStreams.get(key)
        newStreams.set(key, {
          companion_id: event.companion_id,
          text: (cur?.text ?? '') + event.delta,
        })
        next.set(id, { ...existing, streams: newStreams })
      } else {
        const audit = event.event
        const newAudit = [
          ...existing.audit,
          {
            timestamp: audit.timestamp,
            actor: audit.actor,
            kind: audit.kind,
            payload: audit.payload,
          },
        ]
        next.set(id, { ...existing, audit: newAudit })
      }
      return { collaborations: next }
    })

    // Out-of-band re-hydrate on state-changing audit events so the
    // snapshot stays authoritative without bloating the synchronous
    // handler.
    if (event.kind === 'audit') {
      const transition = event.event.kind
      if (
        transition === 'step_completed' ||
        transition === 'step_failed' ||
        transition === 'collaboration_completed' ||
        transition === 'aborted' ||
        transition === 'failed' ||
        transition === 'confirmed'
      ) {
        void get().hydrate(id)
      }
    }
  },
}))

/** Convenience selectors — kept here so consumers don't reimplement. */
export const selectCollaboration = (id: CollaborationId) => (state: StoreState) =>
  state.collaborations.get(id)?.collaboration

export const selectStatus = (id: CollaborationId) => (state: StoreState): CollaborationStatus | undefined =>
  state.collaborations.get(id)?.collaboration.status

export const selectIsTerminal = (id: CollaborationId) => (state: StoreState): boolean => {
  const s = state.collaborations.get(id)?.collaboration.status
  return s ? isTerminalStatus(s) : false
}

export const selectSteps = (id: CollaborationId) => (state: StoreState): Step[] =>
  state.collaborations.get(id)?.collaboration.plan.steps ?? []

/** Streaming buffer for one (step, companion). Undefined if the step has
 *  already finished and the buffer was cleared. */
export const selectStream =
  (id: CollaborationId, stepId: StepId, companionId: number) =>
  (state: StoreState): string | undefined => {
    const key = `${stepId}:${companionId}`
    return state.collaborations.get(id)?.streams.get(key)?.text
  }

