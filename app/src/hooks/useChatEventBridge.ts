import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useChatStreamStore, type StopReason } from '../stores/chatStreamStore';

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

      // Task streaming events (per-task parallel streaming)
      listen<{ taskId: string; text: string }>('task://stream_chunk', (event) => {
        if (cancelled) return;
        const taskId = event.payload.taskId;
        if (taskId) store().taskStreamAppendChunk(taskId, event.payload.text || '');
      }),

      listen<{ taskId: string; name: string; preview: string }>('task://tool_start', (event) => {
        if (cancelled) return;
        const { taskId, name, preview } = event.payload;
        if (taskId) store().taskStreamToolStart(taskId, name || '', preview || '');
      }),

      listen<{ taskId: string; name: string; preview: string }>('task://tool_end', (event) => {
        if (cancelled) return;
        const { taskId, name, preview } = event.payload;
        if (taskId) store().taskStreamToolEnd(taskId, name || '', preview || '');
      }),

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
    ];

    return () => {
      cancelled = true;
      unlisteners.forEach((p) => p.then((fn) => fn()));
    };
  }, []);
}
