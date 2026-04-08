import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export type VoiceStatus =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'error'

export async function startVoiceSession(): Promise<string> {
  return await invoke<string>('start_voice_session')
}

export async function stopVoiceSession(): Promise<void> {
  await invoke('stop_voice_session')
}

export async function getVoiceStatus(): Promise<VoiceStatus> {
  const s = await invoke<string>('get_voice_status')
  return s as VoiceStatus
}

export interface VoiceStatusEvent {
  status: VoiceStatus
  error?: string
}

export interface VoiceTranscriptEvent {
  type: 'user' | 'assistant'
  text: string
  final: boolean
}

export interface VoiceToolCallEvent {
  name: string
  status: 'start' | 'end'
  preview?: string
}

export function onVoiceStatus(
  cb: (e: VoiceStatusEvent) => void,
): Promise<UnlistenFn> {
  return listen<VoiceStatusEvent>('voice://status', (e) => cb(e.payload))
}

export function onVoiceTranscript(
  cb: (e: VoiceTranscriptEvent) => void,
): Promise<UnlistenFn> {
  return listen<VoiceTranscriptEvent>('voice://transcript', (e) => cb(e.payload))
}

export function onVoiceToolCall(
  cb: (e: VoiceToolCallEvent) => void,
): Promise<UnlistenFn> {
  return listen<VoiceToolCallEvent>('voice://tool_call', (e) => cb(e.payload))
}
