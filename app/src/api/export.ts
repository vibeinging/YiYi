// Export API
import { invoke } from '@tauri-apps/api/core';

export type ExportFormat = 'markdown' | 'json';

/**
 * Export conversations as markdown or JSON string.
 * If sessionIds is not provided, all sessions are exported.
 */
export async function exportConversations(
  format: ExportFormat,
  sessionIds?: string[],
): Promise<string> {
  return await invoke<string>('export_conversations', {
    format,
    sessionIds: sessionIds ?? null,
  });
}

/**
 * Export all memories from MemMe store as JSON string.
 */
export async function exportMemories(): Promise<string> {
  return await invoke<string>('export_memories');
}

/**
 * Export app settings (without API keys) as JSON string.
 */
export async function exportSettings(): Promise<string> {
  return await invoke<string>('export_settings');
}
