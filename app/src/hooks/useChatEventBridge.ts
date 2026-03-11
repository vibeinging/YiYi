import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useChatStreamStore } from '../stores/chatStreamStore';

/**
 * App-level hook that bridges Tauri streaming events to the Zustand store.
 * Must be called once in App.tsx. All events are filtered by session_id.
 */
export function useChatEventBridge() {
  useEffect(() => {
    const store = useChatStreamStore.getState;

    const unlisteners = [
      listen<{ text: string; session_id: string }>('chat://chunk', (event) => {
        if (event.payload.session_id !== store().sessionId) return;
        store().appendChunk(event.payload.text);
      }),

      listen<{ type: string; name: string; preview: string; session_id: string }>(
        'chat://tool_status',
        (event) => {
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
        if (event.payload.session_id !== store().sessionId) return;
        store().endStream();
      }),

      listen<{ text: string; session_id: string }>('chat://error', (event) => {
        if (event.payload.session_id !== store().sessionId) return;
        store().endStream();
      }),

      // Spawn agent events
      listen<{ agents: { name: string; task: string }[]; session_id: string }>(
        'chat://spawn_start',
        (event) => {
          if (event.payload.session_id !== store().sessionId) return;
          store().spawnStart(event.payload.agents);
        },
      ),

      listen<{ agent_name: string; content: string; session_id: string }>(
        'chat://spawn_agent_chunk',
        (event) => {
          if (event.payload.session_id !== store().sessionId) return;
          store().spawnAgentChunk(event.payload.agent_name, event.payload.content);
        },
      ),

      listen<{ agent_name: string; type: 'start' | 'end'; tool_name: string; preview: string; session_id: string }>(
        'chat://spawn_agent_tool',
        (event) => {
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
          if (event.payload.session_id !== store().sessionId) return;
          store().spawnAgentComplete(event.payload.agent_name);
        },
      ),

      listen<{ session_id: string }>(
        'chat://spawn_complete',
        (event) => {
          if (event.payload.session_id !== store().sessionId) return;
          store().spawnComplete();
        },
      ),
    ];

    return () => {
      unlisteners.forEach((p) => p.then((fn) => fn()));
    };
  }, []);
}
