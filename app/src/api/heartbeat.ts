// Heartbeat API
import { invoke } from '@tauri-apps/api/core';

export interface ActiveHours {
  start: string; // HH:mm
  end: string;   // HH:mm
}

export interface HeartbeatConfig {
  enabled: boolean;
  every: string; // e.g., "6h", "30m"
  target: 'main' | 'last';
  activeHours?: ActiveHours;
}

export interface HeartbeatHistoryItem {
  timestamp: number;
  target: string;
  success: boolean;
  message?: string;
}

export async function getHeartbeatConfig(): Promise<HeartbeatConfig> {
  return await invoke('get_heartbeat_config');
}

export async function saveHeartbeatConfig(config: HeartbeatConfig): Promise<HeartbeatConfig> {
  return await invoke('save_heartbeat_config', { config });
}

export async function sendHeartbeat(): Promise<{ success: boolean; message: string }> {
  return await invoke('send_heartbeat');
}

export async function getHeartbeatHistory(limit?: number): Promise<HeartbeatHistoryItem[]> {
  return await invoke('get_heartbeat_history', { limit });
}
