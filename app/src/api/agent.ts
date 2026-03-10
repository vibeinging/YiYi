// Agent API
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

export interface Attachment {
  mimeType: string;
  data: string; // base64
  name?: string;
}

export interface MessageSource {
  via?: 'bot';
  platform?: string;
  bot_id?: string;
  sender_id?: string;
  sender_name?: string;
}

export interface ChatMessage {
  id?: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp?: number;
  toolName?: string;
  toolStatus?: 'running' | 'done';
  attachments?: Attachment[];
  source?: MessageSource;
}

export interface ChatSession {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
}

export async function listSessions(): Promise<ChatSession[]> {
  return await invoke('list_sessions');
}

export async function createSession(name: string): Promise<ChatSession> {
  return await invoke('create_session', { name });
}

export async function renameSession(sessionId: string, name: string): Promise<void> {
  await invoke('rename_session', { sessionId, name });
}

export async function deleteSession(sessionId: string): Promise<void> {
  await invoke('delete_session', { sessionId });
}

export async function chat(
  message: string,
  sessionId?: string,
  attachments?: Attachment[],
): Promise<string> {
  return await invoke('chat', {
    message,
    sessionId,
    attachments: attachments?.length ? attachments : undefined,
  });
}

export async function chatStreamStart(
  message: string,
  sessionId?: string,
  attachments?: Attachment[],
): Promise<void> {
  await invoke('chat_stream_start', {
    message,
    sessionId,
    attachments: attachments?.length ? attachments : undefined,
  });
}

export async function chatStreamStop(): Promise<void> {
  await invoke('chat_stream_stop');
}

export function onChatChunk(callback: (chunk: string) => void): Promise<UnlistenFn> {
  return listen<string>('chat://chunk', (event) => callback(event.payload));
}

export function onChatComplete(callback: (reply: string) => void): Promise<UnlistenFn> {
  return listen<string>('chat://complete', (event) => callback(event.payload));
}

export function onChatError(callback: (error: string) => void): Promise<UnlistenFn> {
  return listen<string>('chat://error', (event) => callback(event.payload));
}

export interface ToolStatusEvent {
  type: 'start' | 'end';
  name: string;
  preview?: string;
  result_preview?: string;
}

export function onToolStatus(callback: (event: ToolStatusEvent) => void): Promise<UnlistenFn> {
  return listen<ToolStatusEvent>('chat://tool_status', (event) => callback(event.payload));
}

export async function getHistory(
  sessionId?: string,
  limit?: number,
): Promise<ChatMessage[]> {
  return await invoke('get_history', {
    sessionId,
    limit,
  });
}

export async function clearHistory(sessionId?: string): Promise<void> {
  await invoke('clear_history', {
    sessionId,
  });
}

export async function deleteMessage(messageId: number): Promise<void> {
  await invoke('delete_message', { messageId });
}
