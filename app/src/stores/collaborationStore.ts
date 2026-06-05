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
import type { ToolStatus } from './chatStreamStore'

/** Concatenated token deltas for one (step, companion) pair. */
export interface ParticipantStream {
  companion_id: number
  /** 正文(content)累积。 */
  text: string
  /** 思考(reasoning/thinking)累积 —— 子 agent 思考块用,与主 agent 一致。 */
  reasoning: string
  /** 工具调用流(实时)—— 该成员本轮动手痕迹,渲染成工具卡(与主精灵复用 ToolCallPanel)。 */
  tools: ToolStatus[]
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

// 放养群聊一场会堆几十上百 step,每条发言(member_thinking)/每步完成都全量 hydrate 会
// O(n²) 卡顿。高频事件合并节流;终态(完成 / 中止 / 失败)仍立即 hydrate 求最终状态准确。
const HYDRATE_THROTTLE_MS = 500
const pendingHydrate = new Map<CollaborationId, ReturnType<typeof setTimeout>>()

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
    const id = event.kind === 'audit' ? event.event.collaboration_id : event.collaboration_id
    set(prev => {
      const existing = prev.collaborations.get(id)
      if (!existing) {
        // Event arrived before hydration. Drop it; consumers pick up
        // current state via `hydrate` when they care.
        return prev
      }
      const next = new Map(prev.collaborations)
      if (event.kind === 'token') {
        // 幽灵气泡守卫:协作已终态(被抢占/完成/失败)后晚到的 token 一律丢弃,
        // 否则旧群循环被新消息打断后,在途流仍会把半截话蹦进已结束的对话。
        if (isTerminalStatus(existing.collaboration.status)) return prev
        const key = `${event.step_id}:${event.companion_id}`
        const newStreams = new Map(existing.streams)
        const cur = newStreams.get(key)
        // reasoning 标志分流:思考增量进 reasoning,正文进 text。
        newStreams.set(key, {
          companion_id: event.companion_id,
          text: (cur?.text ?? '') + (event.reasoning ? '' : event.delta),
          reasoning: (cur?.reasoning ?? '') + (event.reasoning ? event.delta : ''),
          tools: cur?.tools ?? [],
        })
        next.set(id, { ...existing, streams: newStreams })
      } else if (event.kind === 'tool_start') {
        // 工具开始:在该成员流里 push 一条 running 工具(与 token 同终态守卫)。
        if (isTerminalStatus(existing.collaboration.status)) return prev
        const key = `${event.step_id}:${event.companion_id}`
        const newStreams = new Map(existing.streams)
        const cur = newStreams.get(key)
        const tools: ToolStatus[] = [
          ...(cur?.tools ?? []),
          {
            id: cur?.tools.length ?? 0,
            name: event.name,
            status: 'running' as const,
            preview: event.args_preview,
          },
        ]
        newStreams.set(key, {
          companion_id: event.companion_id,
          text: cur?.text ?? '',
          reasoning: cur?.reasoning ?? '',
          tools,
        })
        next.set(id, { ...existing, streams: newStreams })
      } else if (event.kind === 'tool_end') {
        // 工具结束:把最近一条同名 running 标记 done + 存 resultPreview(error 由 panel 据前缀判)。
        if (isTerminalStatus(existing.collaboration.status)) return prev
        const key = `${event.step_id}:${event.companion_id}`
        const newStreams = new Map(existing.streams)
        const cur = newStreams.get(key)
        if (!cur) return prev
        const tools = [...cur.tools]
        for (let i = tools.length - 1; i >= 0; i--) {
          if (tools[i].name === event.name && tools[i].status === 'running') {
            tools[i] = { ...tools[i], status: 'done' as const, resultPreview: event.result_preview }
            break
          }
        }
        newStreams.set(key, { ...cur, tools })
        next.set(id, { ...existing, streams: newStreams })
      } else if (event.kind === 'audit') {
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
      // member_thinking:不改同步态,靠下面 hydrate 让新 step 错时冒出。
      // 其余(token / tool_start / tool_end / audit)都已更新 next。
      return event.kind === 'member_thinking' ? prev : { collaborations: next }
    })

    // Out-of-band re-hydrate so the snapshot stays authoritative. 放养群聊会高频触发,
    // 故:终态立即 hydrate(求准),中间的高频事件(发言 / 步完成)节流合并(防 O(n²) 卡顿)。
    const scheduleHydrate = () => {
      if (pendingHydrate.has(id)) return // 已有 pending → 合并,不重排
      const t = setTimeout(() => {
        pendingHydrate.delete(id)
        void get().hydrate(id)
      }, HYDRATE_THROTTLE_MS)
      pendingHydrate.set(id, t)
    }
    if (event.kind === 'audit') {
      const transition = event.event.kind
      if (
        transition === 'collaboration_completed' ||
        transition === 'aborted' ||
        transition === 'failed' ||
        transition === 'confirmed'
      ) {
        // 终态:取消任何待执行的节流 hydrate,立即拉一次最终快照。
        const t = pendingHydrate.get(id)
        if (t) {
          clearTimeout(t)
          pendingHydrate.delete(id)
        }
        void get().hydrate(id)
      } else if (transition === 'step_completed' || transition === 'step_failed') {
        scheduleHydrate()
      }
    } else if (event.kind === 'member_thinking') {
      // 群循环:某成员延迟到点开始发言 → 拉快照让气泡错时出现(变速参差)。高频,故节流。
      scheduleHydrate()
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

/** 子 agent 的思考(reasoning)累积。与 selectStream 对称,供思考块渲染。 */
export const selectReasoning =
  (id: CollaborationId, stepId: StepId, companionId: number) =>
  (state: StoreState): string | undefined => {
    const key = `${stepId}:${companionId}`
    return state.collaborations.get(id)?.streams.get(key)?.reasoning
  }

/** 子 agent 的工具调用流。与 selectStream 对称,供工具卡渲染。 */
export const selectTools =
  (id: CollaborationId, stepId: StepId, companionId: number) =>
  (state: StoreState): ToolStatus[] | undefined => {
    const key = `${stepId}:${companionId}`
    return state.collaborations.get(id)?.streams.get(key)?.tools
  }

