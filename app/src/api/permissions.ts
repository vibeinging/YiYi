import { invoke } from '@tauri-apps/api/core'

export interface PermissionStatus {
  accessibility: boolean
  screen_recording: boolean
  microphone: boolean
}

export async function checkPermissions(): Promise<PermissionStatus> {
  return await invoke<PermissionStatus>('check_permissions')
}

export async function requestAccessibility(): Promise<boolean> {
  return await invoke<boolean>('request_accessibility')
}

export async function requestScreenRecording(): Promise<void> {
  return await invoke<void>('request_screen_recording')
}

export async function requestMicrophone(): Promise<void> {
  return await invoke<void>('request_microphone')
}
