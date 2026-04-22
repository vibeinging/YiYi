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
  bot_name?: string;
  sender_id?: string;
  sender_name?: string;
}

export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: string;
}

export interface SpawnAgentResult {
  name: string;
  /// Legacy: preview/summary text (first ~3000 chars of full_output for new rows,
  /// or the full truncated legacy string for pre-batch-2 rows).
  result: string;
  is_error?: boolean;
  /// Full, uncapped agent output. Only present on rows written after the
  /// structured-result migration.
  full_output?: string;
  /// Full, uncapped error text when is_error is true.
  error?: string;
  /// "complete" | "failed" | "timeout" | "cancelled"
  status?: 'complete' | 'failed' | 'timeout' | 'cancelled';
  duration_ms?: number;
  success?: boolean;
  summary?: string;
}

export interface ChatMessage {
  id?: number;
  role: 'user' | 'assistant' | 'system' | 'tool' | 'context_reset';
  content: string;
  timestamp?: number;
  toolName?: string;
  toolStatus?: 'running' | 'done';
  attachments?: Attachment[];
  source?: MessageSource;
  tool_calls?: ToolCallInfo[];
  tool_call_id?: string;
  tool_name?: string;
  spawn_agents?: SpawnAgentResult[];
  thinking?: string;
}

export interface ChatSession {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  source: string;
  source_meta: string | null;
}

export async function listSessions(): Promise<ChatSession[]> {
  return await invoke('list_sessions');
}

export async function listChatSessions(limit?: number, offset?: number): Promise<ChatSession[]> {
  return await invoke('list_chat_sessions', { limit, offset });
}

export async function searchChatSessions(query: string, limit?: number): Promise<ChatSession[]> {
  return await invoke('search_chat_sessions', { query, limit });
}

export async function createSession(name: string): Promise<ChatSession> {
  return await invoke('create_session', { name });
}

export async function ensureSession(
  id: string,
  name: string,
  source: string,
  sourceMeta?: string,
): Promise<ChatSession> {
  return await invoke('ensure_session', { id, name, source, sourceMeta });
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
  return listen<{ text: string; session_id: string }>('chat://chunk', (event) => callback(event.payload.text));
}

export function onChatComplete(callback: (reply: string) => void): Promise<UnlistenFn> {
  return listen<{ text: string; session_id: string }>('chat://complete', (event) => callback(event.payload.text));
}

export function onChatError(callback: (error: string) => void): Promise<UnlistenFn> {
  return listen<{ text: string; session_id: string }>('chat://error', (event) => callback(event.payload.text));
}

export interface ToolStatusEvent {
  type: 'start' | 'end';
  name: string;
  preview?: string;
  result_preview?: string;
  session_id?: string;
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

// --- Spawn agents (sub-agent) streaming events ---

export interface SpawnStartEvent {
  agents: { name: string; task: string }[];
}

export interface SpawnAgentChunkEvent {
  agent_name: string;
  content: string;
}

export interface SpawnAgentToolEvent {
  agent_name: string;
  type: 'start' | 'end';
  tool_name: string;
  preview: string;
}

export interface SpawnAgentCompleteEvent {
  agent_name: string;
  result: string;
  success?: boolean;
  status?: 'complete' | 'failed' | 'timeout' | 'cancelled';
  duration_ms?: number;
}

export interface SpawnAgentErrorEvent {
  agent_name: string;
  reason: 'timeout' | 'runtime_error' | 'llm_error' | 'tool_error' | 'cancelled';
  /// First ~200 chars for quick display.
  preview: string;
  /// Full uncapped error text — use this for debug views / "show more".
  full: string;
  /// Legacy alias of `full`, kept so existing listeners keep working.
  message?: string;
  session_id?: string;
}

export interface SpawnCompleteEvent {
  results: SpawnAgentResult[];
}

