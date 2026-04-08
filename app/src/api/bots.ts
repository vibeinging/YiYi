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

// === Bot Conversations ===

export type TriggerMode = 'mention' | 'all' | 'keyword' | 'muted';

export interface AgentRouteConfig {
  agent_id?: string;
  persona?: string;
  allowed_tools?: string[];
  blocked_tools?: string[];
  working_dir?: string;
  max_iterations?: number;
}

export interface BotConversationInfo {
  id: string;
  bot_id: string;
  bot_name: string;
  external_id: string;
  platform: string;
  display_name: string | null;
  session_id: string;
  linked_session_id: string | null;
  trigger_mode: TriggerMode;
  agent_config_json: string | null;
  last_message_at: number | null;
  message_count: number;
  created_at: number;
}

export async function listBotConversations(botId?: string): Promise<BotConversationInfo[]> {
  return await invoke<BotConversationInfo[]>('bot_conversations_list', { botId: botId ?? null });
}

export async function updateBotConversationTrigger(
  conversationId: string,
  triggerMode: TriggerMode,
): Promise<void> {
  return await invoke('bot_conversation_update_trigger', { conversationId, triggerMode });
}

export async function linkBotConversation(
  conversationId: string,
  linkedSessionId: string | null,
): Promise<void> {
  return await invoke('bot_conversation_link', { conversationId, linkedSessionId });
}

export async function setConversationAgent(
  conversationId: string,
  agentConfig: AgentRouteConfig | null,
): Promise<void> {
  const agentConfigStr = agentConfig ? JSON.stringify(agentConfig) : null;
  return await invoke('bot_conversation_set_agent', { conversationId, agentConfig: agentConfigStr });
}

export async function deleteBotConversation(conversationId: string): Promise<void> {
  return await invoke('bot_conversation_delete', { conversationId });
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
