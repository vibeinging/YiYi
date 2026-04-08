import { create } from 'zustand'
import type { VoiceStatus } from '../api/voice'

interface ActiveTool {
  name: string
  status: 'start' | 'end'
  preview?: string
}

interface VoiceState {
  status: VoiceStatus
  sessionId: string | null
  userTranscript: string
  assistantTranscript: string
  activeTools: ActiveTool[]
  error: string | null

  setStatus: (status: VoiceStatus) => void
  setSessionId: (id: string | null) => void
  appendUserTranscript: (text: string) => void
  setUserTranscript: (text: string) => void
  appendAssistantTranscript: (text: string) => void
  setAssistantTranscript: (text: string) => void
  addTool: (name: string, status: 'start' | 'end', preview?: string) => void
  setError: (error: string | null) => void
  reset: () => void
}

export const useVoiceStore = create<VoiceState>((set) => ({
  status: 'idle',
  sessionId: null,
  userTranscript: '',
  assistantTranscript: '',
  activeTools: [],
  error: null,

  setStatus: (status) => set({ status }),
  setSessionId: (sessionId) => set({ sessionId }),
  appendUserTranscript: (text) =>
    set((s) => ({ userTranscript: s.userTranscript + text })),
  setUserTranscript: (userTranscript) => set({ userTranscript }),
  appendAssistantTranscript: (text) =>
    set((s) => ({ assistantTranscript: s.assistantTranscript + text })),
  setAssistantTranscript: (assistantTranscript) => set({ assistantTranscript }),
  addTool: (name, status, preview) =>
    set((s) => {
      if (status === 'end') {
        const updated = s.activeTools.map((t) =>
          t.name === name && t.status === 'start' ? { ...t, status: 'end' as const, preview } : t,
        )
        // Keep only last 10 completed + all in-progress
        const inProgress = updated.filter((t) => t.status === 'start')
        const done = updated.filter((t) => t.status === 'end').slice(-10)
        return { activeTools: [...done, ...inProgress] }
      }
      return {
        activeTools: [...s.activeTools, { name, status, preview }],
      }
    }),
  setError: (error) => set({ error }),
  reset: () =>
    set({
      status: 'idle',
      sessionId: null,
      userTranscript: '',
      assistantTranscript: '',
      activeTools: [],
      error: null,
    }),
}))
