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

      listen<{ session_id: string }>('chat://bot_stream_end', () => {
        if (cancelled) return;
        // 终态事件**始终**释放全局 loading —— 不按 session 过滤(见下方 chat://complete 注释)。
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

      listen<{ text: string; session_id: string; collaboration_id?: number }>('chat://complete', (event) => {
        if (cancelled) return;
        // 终态事件**始终**释放全局 loading(解锁输入框),不按 session 过滤。
        // 一次只会有一条 chat 流置 loading(loading 时输入框禁用、发不出第二条),所以无论用户
        // 是否已切走会话,这条流的完成都该解锁;否则切走再回来会发现输入框永久点不动、发送键卡成
        // 红色停止方块(2026-06-15 实测 bug:store().sessionId 随活动会话变,完成事件被 guard 拦掉)。
        store().endStream();
        // 下面是**当前会话**的 UI 更新(重载出协作卡),只对活动会话做。
        if (event.payload.session_id !== store().sessionId) return;
        // work followup:后端已起 intake 协作(载荷带 collaboration_id),立即重载消息
        // 把牵头者接手的协作卡拉出来 —— 消「发出去没下文」的零反馈空窗(R6)。
        if (event.payload.collaboration_id != null) {
          window.dispatchEvent(new CustomEvent('yiyi:reload-messages'));
        }
      }),

      listen<{ text: string; session_id: string }>('chat://error', (event) => {
        if (cancelled) return;
        // 非活动会话:**只释放锁**,不在当前会话弹它的错误(避免错配会话弹错误)。
        if (event.payload.session_id !== store().sessionId) {
          store().endStream();
          return;
        }
        store().endStreamWithError(event.payload.text);
      }),

      listen<{
        session_id: string;
        tool_call_id: string;
        artifacts: { mime_type: string; path: string; name: string }[];
      }>('chat://tool_artifact', (event) => {
        if (cancelled) return;
        if (event.payload.session_id !== store().sessionId) return;
        store().appendArtifacts(event.payload.artifacts);
      }),

      listen<{
        session_id: string;
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        estimated_cost_usd?: number;
      }>('chat://usage', (event) => {
        if (cancelled) return;
        if (event.payload.session_id !== store().sessionId) return;
        store().setUsage({
          inputTokens: event.payload.input_tokens,
          outputTokens: event.payload.output_tokens,
          cacheReadTokens: event.payload.cache_read_tokens,
          estimatedCostUsd: event.payload.estimated_cost_usd ?? 0,
        });
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

      listen<{
        agent_name: string;
        session_id: string;
        success?: boolean;
        status?: 'complete' | 'failed' | 'timeout' | 'cancelled';
        duration_ms?: number;
      }>(
        'chat://spawn_agent_complete',
        (event) => {
          if (cancelled) return;
          if (event.payload.session_id !== store().sessionId) return;
          store().spawnAgentComplete(event.payload.agent_name, {
            status: event.payload.status,
            durationMs: event.payload.duration_ms,
          });
        },
      ),

      listen<{
        agent_name: string;
        reason: 'timeout' | 'runtime_error' | 'cancelled' | 'llm_error' | 'tool_error';
        preview: string;
        full: string;
        session_id: string;
      }>(
        'chat://spawn_agent_error',
        (event) => {
          if (cancelled) return;
          if (event.payload.session_id !== store().sessionId) return;
          const status =
            event.payload.reason === 'timeout' ? 'timeout'
            : event.payload.reason === 'cancelled' ? 'cancelled'
            : 'failed';
          store().spawnAgentError(event.payload.agent_name, status, event.payload.full);
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
