/**
 * meditationStore — Singleton state for the meditation runtime.
 *
 * Backend meditation is a singleton (one AtomicBool guards concurrent runs), so the
 * UI should also treat it as global: every component that cares about "is meditation
 * running?" subscribes to the same source of truth. Local React state cannot survive
 * page switches; this store does.
 */

import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'

type Listener = () => void

interface MeditationState {
  isRunning: boolean
  triggerMeditation: () => Promise<void>
  // Subscribe to the moment meditation transitions from running → not running.
  // Returns an unsubscribe function.
  onComplete: (fn: Listener) => () => void
  // Internal: start the polling loop if not already running
  _ensurePolling: () => void
}

let pollTimer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<Listener>()

export const useMeditationStore = create<MeditationState>((set, get) => ({
  isRunning: false,

  triggerMeditation: async () => {
    // Backend rejects concurrent runs; don't even try if we already know it's running.
    if (get().isRunning) return
    await invoke('trigger_meditation')
    set({ isRunning: true })
    get()._ensurePolling()
  },

  onComplete: (fn: Listener) => {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  },

  _ensurePolling: () => {
    if (pollTimer !== null) return
    const tick = async () => {
      try {
        const status: any = await invoke('get_meditation_status')
        const running = status === 'running'
        const wasRunning = get().isRunning
        if (running !== wasRunning) set({ isRunning: running })
        if (!running) {
          if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null }
          if (wasRunning) {
            listeners.forEach(l => { try { l() } catch {} })
          }
        }
      } catch {
        // Intentionally swallow: the bootstrap tick can race backend readiness.
        // Subsequent 2s ticks self-heal; surfacing the first-tick error would
        // only noise the console with a transient startup condition.
      }
    }
    tick() // immediate first check
    pollTimer = setInterval(tick, 2000)
  },
}))

// Kick off polling on module load so we pick up any pre-existing running meditation
// (e.g. if the user launched the app while a scheduled meditation is mid-run).
useMeditationStore.getState()._ensurePolling()
