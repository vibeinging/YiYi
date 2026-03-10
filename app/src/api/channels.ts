/**
 * Channels API
 */

import { invoke } from '@tauri-apps/api/core';

export type ChannelType = 'dingtalk' | 'feishu' | 'qq' | 'discord' | 'telegram' | 'wecom' | 'webhook';

export interface ChannelInfo {
  id: string;
  name: string;
  channel_type: string;
  enabled: boolean;
  status?: string;
}

export interface ChannelMessage {
  channel_type: ChannelType;
  session_id: string;
  user_id: string;
  username?: string;
  content: string;
  timestamp?: number;
}

/** 列出所有频道 */
export async function listChannels(): Promise<ChannelInfo[]> {
  return await invoke<ChannelInfo[]>('channels_list');
}

/** 获取单个频道配置 */
export async function getChannel(channelName: string): Promise<any> {
  return await invoke('channels_get', { channelName });
}

/** 更新频道配置 */
export async function updateChannel(
  channelName: string,
  enabled?: boolean,
  botPrefix?: string
): Promise<any> {
  return await invoke('channels_update', { channelName, enabled, botPrefix });
}

/** 发送消息到指定频道 */
export async function sendToChannel(
  channelType: ChannelType,
  target: string,
  content: string
): Promise<{ status: string; error?: string }> {
  return await invoke('channels_send', { channelType, target, content });
}

/** 发送消息到指定会话 */
export async function sendToSession(
  sessionId: string,
  content: string
): Promise<{ status: string; error?: string }> {
  return await invoke('channels_send_to_session', { sessionId, content });
}

/** 启动所有频道 */
export async function startChannels(): Promise<{
  status: string;
  channels?: string[];
  error?: string;
}> {
  return await invoke('channels_start');
}

/** 停止所有频道 */
export async function stopChannels(): Promise<{ status: string; error?: string }> {
  return await invoke('channels_stop');
}

/** 获取活跃会话列表 */
export async function listActiveSessions(): Promise<ChannelMessage[]> {
  return await invoke<ChannelMessage[]>('channels_list_sessions');
}
