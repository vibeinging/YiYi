import { listen } from '@tauri-apps/api/event';
import { useEffect } from 'react';
import { useTaskStore } from '../stores/taskStore';
import { useTaskSidebarStore } from '../stores/taskSidebarStore';
import { useChatStreamStore } from '../stores/chatStreamStore';
import { toast } from '../components/Toast';

/**
 * App-level hook that bridges Tauri task events to both task stores.
 * Must be called once in App.tsx.
 *
 * Note: Events from tools.rs use snake_case keys (task_id),
 * while events from commands/tasks.rs use camelCase keys (taskId).
 * We handle both conventions with helper getters.
 */
export function useTaskEventBridge() {
  useEffect(() => {
    let cancelled = false;
    const store = () => useTaskStore.getState();
    const sidebar = () => useTaskSidebarStore.getState();
    const streamStore = () => useChatStreamStore.getState();
    const unlisteners: Promise<() => void>[] = [];

    // Helper: get task_id from payload (handles both snake_case and camelCase)
    const getTaskId = (p: any): string => p.task_id || p.taskId || '';

    unlisteners.push(
      // On task created: fetch full TaskInfo from backend
      listen('task://created', (event) => {
        if (cancelled) return;
        const p = event.payload as any;
        const taskId = getTaskId(p);
        if (taskId) {
          store().addOrRefreshTask(taskId);
          sidebar().addOrRefreshTask(taskId);
          if (p.source === 'tool') {
            streamStore().taskStreamStart(taskId);
          }
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
        sidebar().updateTaskProgress(taskId, currentStage, totalStages, progress);
      }),

      listen('task://completed', (event) => {
        if (cancelled) return;
        const p = event.payload as any;
        const taskId = getTaskId(p);
        const title = p.title || p.task_title || '';
        store().updateTaskStatus(taskId, 'completed');
        sidebar().updateTaskStatus(taskId, 'completed');
        streamStore().taskStreamEnd(taskId);
        setTimeout(() => streamStore().taskStreamRemove(taskId), 5000);
        toast.success(title ? `任务完成：${title}` : '任务已完成');
      }),

      listen('task://failed', (event) => {
        if (cancelled) return;
        const p = event.payload as any;
        const taskId = getTaskId(p);
        const title = p.title || p.task_title || '';
        const errorMsg = p.error_message || p.errorMessage || p.error || undefined;
        store().updateTaskStatus(taskId, 'failed', errorMsg);
        sidebar().updateTaskStatus(taskId, 'failed', errorMsg);
        streamStore().taskStreamEnd(taskId);
        setTimeout(() => streamStore().taskStreamRemove(taskId), 5000);
        toast.error(title ? `任务失败：${title}` : '任务执行失败');
      }),

      listen('task://cancelled', (event) => {
        if (cancelled) return;
        const p = event.payload as any;
        const taskId = getTaskId(p);
        store().updateTaskStatus(taskId, 'cancelled');
        sidebar().updateTaskStatus(taskId, 'cancelled');
        streamStore().taskStreamEnd(taskId);
        setTimeout(() => streamStore().taskStreamRemove(taskId), 5000);
      }),

      listen('task://paused', (event) => {
        if (cancelled) return;
        const p = event.payload as any;
        const taskId = getTaskId(p);
        store().updateTaskStatus(taskId, 'paused');
        sidebar().updateTaskStatus(taskId, 'paused');
      }),

      listen('task://deleted', (event) => {
        if (cancelled) return;
        const p = event.payload as any;
        const taskId = getTaskId(p);
        store().removeTask(taskId);
        sidebar().removeTask(taskId);
      }),

      listen('task://updated', (event) => {
        if (cancelled) return;
        const p = event.payload as any;
        const taskId = getTaskId(p);
        if (taskId) {
          sidebar().addOrRefreshTask(taskId);
          store().addOrRefreshTask(taskId);
        }
      }),
    );

    // Initial load
    store().loadTasks();

    return () => {
      cancelled = true;
      unlisteners.forEach((p) => p.then((fn) => fn()));
    };
  }, []);
}
