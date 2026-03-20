/**
 * Bots API
 */

import { invoke } from '@tauri-apps/api/core';

export type PlatformType = 'discord' | 'telegram' | 'qq' | 'dingtalk' | 'feishu' | 'wecom' | 'webhook';

export interface BotInfo {
  id: string;
  name: string;
  platform: PlatformType;
  enabled: boolean;
  config: Record<string, unknown>;
  persona?: string;
  access?: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}

export interface PlatformInfo {
  id: string;
  name: string;
}

export interface BotSession {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  source: string;
  source_meta?: string;
}

export async function listBots(): Promise<BotInfo[]> {
  return await invoke<BotInfo[]>('bots_list');
}

export async function listPlatforms(): Promise<PlatformInfo[]> {
  return await invoke<PlatformInfo[]>('bots_list_platforms');
}

export async function getBot(botId: string): Promise<BotInfo> {
  return await invoke<BotInfo>('bots_get', { botId });
}

export async function createBot(
  name: string,
  platform: PlatformType,
  config: Record<string, unknown>,
  persona?: string,
  access?: Record<string, unknown>
): Promise<BotInfo> {
  return await invoke<BotInfo>('bots_create', { name, platform, config, persona, access });
}

export async function updateBot(
  botId: string,
  updates: {
    name?: string;
    enabled?: boolean;
    config?: Record<string, unknown>;
    persona?: string;
    access?: Record<string, unknown>;
  }
): Promise<BotInfo> {
  return await invoke<BotInfo>('bots_update', { botId, ...updates });
}

export async function deleteBot(botId: string): Promise<void> {
  return await invoke('bots_delete', { botId });
}

export async function sendToBot(
  botId: string,
  target: string,
  content: string
): Promise<{ status: string }> {
  return await invoke('bots_send', { botId, target, content });
}

export async function startBots(): Promise<{ status: string; bots: string[] }> {
  return await invoke('bots_start');
}

export async function stopBots(): Promise<{ status: string }> {
  return await invoke('bots_stop');
}

export async function startOneBot(botId: string): Promise<{ status: string; bot_id: string }> {
  return await invoke('bots_start_one', { botId });
}

export async function stopOneBot(botId: string): Promise<{ status: string }> {
  return await invoke('bots_stop_one', { botId });
}

export async function listBotSessions(): Promise<BotSession[]> {
  return await invoke<BotSession[]>('bots_list_sessions');
}

// === Session-Bot Binding ===

/** Bind a bot to a session. Returns the previous session ID if the bot was moved. */
export async function sessionBindBot(sessionId: string, botId: string): Promise<string | null> {
  return await invoke<string | null>('session_bind_bot', { sessionId, botId });
}

export async function sessionUnbindBot(sessionId: string, botId: string): Promise<void> {
  return await invoke('session_unbind_bot', { sessionId, botId });
}

export async function sessionListBots(sessionId: string): Promise<BotInfo[]> {
  return await invoke<BotInfo[]>('session_list_bots', { sessionId });
}

// === Bot Connection Status ===

export type BotConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface BotStatusInfo {
  bot_id: string;
  state: BotConnectionState;
  message: string | null;
  connected_at: number | null;
  last_error: string | null;
}

export async function getBotStatuses(): Promise<BotStatusInfo[]> {
  return await invoke<BotStatusInfo[]>('bots_get_status');
}
