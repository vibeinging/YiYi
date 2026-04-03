import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useChatStreamStore, type StopReason, type RetryErrorType } from '../stores/chatStreamStore';
import type { CanvasEvent } from '../api/canvas';

/**
 * App-level hook that bridges Tauri streaming events to the Zustand store.
 * Must be called once in App.tsx. All events are filtered by session_id.
 */
export function useChatEventBridge() {
  useEffect(() => {
    // Guard against React StrictMode double-mount: old listeners may still
    // be active until their async unlisten resolves, so we use a flag to
    // prevent stale listeners from dispatching into the store.
    let cancelled = false;
    const store = useChatStreamStore.getState;

    const unlisteners = [
      // Bot streaming: start/end stream when bot agent processes a message
      listen<{ session_id: string }>('chat://bot_stream_start', (event) => {
        if (cancelled) return;
        if (event.payload.session_id !== store().sessionId) return;
        store().startStream();
      }),

      listen<{ session_id: string }>('chat://bot_stream_end', (event) => {
        if (cancelled) return;
        if (event.payload.session_id !== store().sessionId) return;
        store().endStream();
      }),

      listen<{ text: string; session_id: string }>('chat://chunk', (event) => {
        if (cancelled) return;
        if (event.payload.session_id !== store().sessionId) return;
        store().appendChunk(event.payload.text);
      }),

      listen<{ text: string; session_id: string }>('chat://thinking', (event) => {
        if (cancelled) return;
        if (event.payload.session_id !== store().sessionId) return;
        store().appendThinking(event.payload.text);
      }),

      listen<{ type: string; name: string; preview: string; session_id: string }>(
        'chat://tool_status',
        (event) => {
          if (cancelled) return;
          if (event.payload.session_id !== store().sessionId) return;
          const { type, name, preview } = event.payload;
          if (type === 'start') {
            store().toolStart(name, preview);
          } else {
            store().toolEnd(name, preview);
          }
        },
      ),

      listen<{ text: string; session_id: string }>('chat://complete', (event) => {
        if (cancelled) return;
        if (event.payload.session_id !== store().sessionId) return;
        store().endStream();
      }),

      listen<{ text: string; session_id: string }>('chat://error', (event) => {
        if (cancelled) return;
        if (event.payload.session_id !== store().sessionId) return;
        store().endStreamWithError(event.payload.text);
      }),

      // Stream reset (context overflow recovery — clear partial content before retry)
      listen<{ session_id: string; reason: string }>('chat://stream_reset', (event) => {
        if (cancelled) return;
        if (event.payload.session_id !== store().sessionId) return;
        store().resetStreamContent();
      }),

      // Retry status events (not session-scoped — they come from the HTTP layer)
      listen<{ attempt: number; max_retries: number; delay_ms: number; error_category: { type: string }; provider: string }>(
        'chat://retry',
        (event) => {
          if (cancelled) return;
          store().setRetryStatus({
            attempt: event.payload.attempt,
            max_retries: event.payload.max_retries,
            delay_ms: event.payload.delay_ms,
            error_type: (event.payload.error_category?.type || 'transient') as RetryErrorType,
            provider: event.payload.provider,
          });
        },
      ),

      listen('chat://retry-resolved', () => {
        if (cancelled) return;
        store().setRetryStatus(null);
      }),

      // Spawn agent events
      listen<{ agents: { name: string; task: string }[]; session_id: string }>(
        'chat://spawn_start',
        (event) => {
          if (cancelled) return;
          if (event.payload.session_id !== store().sessionId) return;
          store().spawnStart(event.payload.agents);
        },
      ),

      listen<{ agent_name: string; content: string; session_id: string }>(
        'chat://spawn_agent_chunk',
        (event) => {
          if (cancelled) return;
          if (event.payload.session_id !== store().sessionId) return;
          store().spawnAgentChunk(event.payload.agent_name, event.payload.content);
        },
      ),

      listen<{ agent_name: string; type: 'start' | 'end'; tool_name: string; preview: string; session_id: string }>(
        'chat://spawn_agent_tool',
        (event) => {
          if (cancelled) return;
          if (event.payload.session_id !== store().sessionId) return;
          store().spawnAgentTool(
            event.payload.agent_name,
            event.payload.type,
            event.payload.tool_name,
            event.payload.preview,
          );
        },
      ),

      listen<{ agent_name: string; session_id: string }>(
        'chat://spawn_agent_complete',
        (event) => {
          if (cancelled) return;
          if (event.payload.session_id !== store().sessionId) return;
          store().spawnAgentComplete(event.payload.agent_name);
        },
      ),

      listen<{ session_id: string }>(
        'chat://spawn_complete',
        (event) => {
          if (cancelled) return;
          if (event.payload.session_id !== store().sessionId) return;
          store().spawnComplete();
        },
      ),

      // Long task (auto-continue) events
      listen<{
        type: 'round_start' | 'round_complete' | 'finished';
        session_id: string;
        round: number;
        max_rounds?: number;
        total_tokens?: number;
        token_budget?: number;
        stop_reason?: string;
      }>(
        'chat://auto_continue',
        (event) => {
          if (cancelled) return;
          if (event.payload.session_id !== store().sessionId) return;
          const { type, round, max_rounds, total_tokens, stop_reason } = event.payload;
          switch (type) {
            case 'round_start':
              store().longTaskRoundStart(round, max_rounds || 10);
              break;
            case 'round_complete':
              store().longTaskRoundComplete(round, total_tokens || 0);
              break;
            case 'finished':
              store().longTaskFinished((stop_reason || 'task_complete') as StopReason);
              break;
          }
        },
      ),

      // Task streaming events (task://stream_chunk, task://tool_start, task://tool_end)
      // are handled exclusively by useTaskEventBridge to avoid duplicate subscriptions.

      // Claude Code streaming events
      listen<{ type: string; session_id: string; content?: string; tool_name?: string; working_dir?: string }>(
        'chat://claude_code_stream',
        (event) => {
          if (cancelled) return;
          if (event.payload.session_id !== store().sessionId) return;
          const { type, content, tool_name, working_dir } = event.payload;
          switch (type) {
            case 'start':
              store().claudeCodeStart(working_dir || '');
              // Show long task progress panel for Claude Code (inherently long-running)
              store().longTaskRoundStart(1, 1);
              break;
            case 'text_delta':
              if (content) store().claudeCodeTextDelta(content);
              break;
            case 'tool_start':
              if (tool_name) store().claudeCodeToolStart(tool_name);
              break;
            case 'tool_end':
              if (tool_name) store().claudeCodeToolEnd(tool_name);
              break;
            case 'done':
              store().claudeCodeDone();
              // Complete the long task panel when Claude Code finishes
              store().longTaskFinished('task_complete');
              break;
          }
        },
      ),

      // Canvas events (Live Canvas / A2UI)
      listen<CanvasEvent>('chat://canvas', (event) => {
        if (cancelled) return;
        if (event.payload.session_id !== store().sessionId) return;
        store().addCanvas(event.payload);
      }),
    ];

    return () => {
      cancelled = true;
      unlisteners.forEach((p) => p.then((fn) => fn()));
    };
  }, []);
}
