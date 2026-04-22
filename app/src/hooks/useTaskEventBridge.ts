import { listen } from '@tauri-apps/api/event';
import { useEffect } from 'react';
import { useTaskStore } from '../stores/taskStore';
import { useTaskSidebarStore } from '../stores/taskSidebarStore';
import { useChatStreamStore } from '../stores/chatStreamStore';
import { toast } from '../components/Toast';

/**
 * App-level hook that bridges Tauri task events to the task store.
 * Must be called once in App.tsx.
 *
 * Design: task lifecycle is single-sourced in `taskStore`. Inline TaskCards
 * in the chat stream render from it; tasks do NOT appear in the left sidebar.
 * Tab-related signals (new-tab addition, completion flash) still go through
 * `taskSidebarStore` since they serve the chat session tab bar.
 *
 * Payload keys: tools.rs uses snake_case (task_id), commands/tasks.rs uses
 * camelCase (taskId). Getter handles both.
 */
export function useTaskEventBridge() {
  useEffect(() => {
    let cancelled = false;
    const store = () => useTaskStore.getState();
    const sidebar = () => useTaskSidebarStore.getState();
    const streamStore = () => useChatStreamStore.getState();
    const unlisteners: Promise<() => void>[] = [];

    const getTaskId = (p: any): string => p.task_id || p.taskId || '';

    unlisteners.push(
      listen('task://created', (event) => {
        if (cancelled) return;
        const p = event.payload as any;
        const taskId = getTaskId(p);
        if (taskId) {
          store().addOrRefreshTask(taskId);
          if (p.source === 'tool') {
            streamStore().taskStreamStart(taskId);
          }
          if (p.source === 'tool' || p.source === 'background') {
            const sessionId = p.session_id || p.sessionId;
            const title = p.title || p.task_title || '任务';
            if (sessionId) {
              sidebar().addPendingNewTab(sessionId, title);
            }
          }
        }
      }),

      listen('task://stream_chunk', (event) => {
        if (cancelled) return;
        const p = event.payload as any;
        const taskId = getTaskId(p);
        const text = p.text || '';
        if (taskId && text) {
          streamStore().taskStreamAppendChunk(taskId, text);
        }
      }),

      listen('task://tool_start', (event) => {
        if (cancelled) return;
        const p = event.payload as any;
        const taskId = getTaskId(p);
        if (taskId) {
          streamStore().taskStreamToolStart(taskId, p.name || '', p.preview || '');
        }
      }),

      listen('task://tool_end', (event) => {
        if (cancelled) return;
        const p = event.payload as any;
        const taskId = getTaskId(p);
        if (taskId) {
          streamStore().taskStreamToolEnd(taskId, p.name || '', p.preview || '');
        }
      }),

      listen('task://progress', (event) => {
        if (cancelled) return;
        const p = event.payload as any;
        const taskId = getTaskId(p);
        const currentStage = p.currentStage ?? p.current_stage ?? 0;
        const totalStages = p.totalStages ?? p.total_stages ?? 0;
        const progress = p.progress ?? 0;
        store().updateTaskProgress(taskId, currentStage, totalStages, progress);
      }),

      listen('task://completed', (event) => {
        if (cancelled) return;
        const p = event.payload as any;
        const taskId = getTaskId(p);
        const title = p.title || p.task_title || '';
        store().updateTaskStatus(taskId, 'completed');
        streamStore().taskStreamEnd(taskId);
        setTimeout(() => streamStore().taskStreamRemove(taskId), 5000);
        toast.success(title ? `任务完成：${title}` : '任务已完成');
        // Flash the tab on completion
        const completedTask = store().tasks.find(t => t.id === taskId);
        if (completedTask) sidebar().notifyTab(completedTask.sessionId, 'complete');
      }),

      listen('task://failed', (event) => {
        if (cancelled) return;
        const p = event.payload as any;
        const taskId = getTaskId(p);
        const title = p.title || p.task_title || '';
        const errorMsg = p.error_message || p.errorMessage || p.error || undefined;
        store().updateTaskStatus(taskId, 'failed', errorMsg);
        streamStore().taskStreamEnd(taskId);
        setTimeout(() => streamStore().taskStreamRemove(taskId), 5000);
        toast.error(title ? `任务失败：${title}` : '任务执行失败');
        const failedTask = store().tasks.find(t => t.id === taskId);
        if (failedTask) sidebar().notifyTab(failedTask.sessionId, 'fail');
      }),

      listen('task://cancelled', (event) => {
        if (cancelled) return;
        const p = event.payload as any;
        const taskId = getTaskId(p);
        store().updateTaskStatus(taskId, 'cancelled');
        streamStore().taskStreamEnd(taskId);
        setTimeout(() => streamStore().taskStreamRemove(taskId), 5000);
      }),

      listen('task://paused', (event) => {
        if (cancelled) return;
        const p = event.payload as any;
        const taskId = getTaskId(p);
        store().updateTaskStatus(taskId, 'paused');
      }),

      listen('task://deleted', (event) => {
        if (cancelled) return;
        const p = event.payload as any;
        const taskId = getTaskId(p);
        store().removeTask(taskId);
      }),

      listen('task://updated', (event) => {
        if (cancelled) return;
        const p = event.payload as any;
        const taskId = getTaskId(p);
        if (taskId) {
          store().addOrRefreshTask(taskId);
        }
      }),
    );

    store().loadTasks();

    return () => {
      cancelled = true;
      unlisteners.forEach((p) => p.then((fn) => fn()));
    };
  }, []);
}
