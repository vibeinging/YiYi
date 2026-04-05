import { create } from 'zustand';
import { TaskInfo, listTasks, getTaskStatus, cancelTask, pauseTask } from '../api/tasks';
import { invoke } from '@tauri-apps/api/core';

interface CronJobBrief {
  id: string;
  name: string;
  schedule_display: string;
  enabled: boolean;
  last_run_at: number | null;
  last_run_status: string | null;
  next_run_at: number | null;
}

interface TaskSidebarState {
  // Task list
  tasks: TaskInfo[];
  // Currently selected task for overlay
  selectedTaskId: string | null;
  // Cron jobs for "Scheduled" section
  cronJobs: CronJobBrief[];
  // Sidebar collapsed state
  sidebarCollapsed: boolean;
  // Pending session navigation (set by sidebar, consumed by ChatPage)
  pendingSessionId: string | null;
  // Pending tab addition (adds tab without switching)
  pendingNewTab: { id: string; name: string } | null;
  // Tab notification (flash on complete/fail)
  pendingTabNotify: { id: string; type: 'complete' | 'fail' } | null;
  // IDs of tasks that were just created (for birth animation)
  newlyCreatedTaskIds: Set<string>;

  // Actions
  loadTasks: () => Promise<void>;
  loadCronJobs: () => Promise<void>;
  navigateToSession: (sessionId: string) => void;
  consumePendingSession: () => string | null;
  addPendingNewTab: (id: string, name: string) => void;
  consumePendingNewTab: () => { id: string; name: string } | null;
  notifyTab: (id: string, type: 'complete' | 'fail') => void;
  consumeTabNotify: () => { id: string; type: 'complete' | 'fail' } | null;
  addOrRefreshTask: (taskId: string) => Promise<void>;
  updateTaskProgress: (taskId: string, currentStage: number, totalStages: number, progress: number) => void;
  updateTaskStatus: (taskId: string, status: string, errorMessage?: string) => void;
  removeTask: (taskId: string) => void;
  selectTask: (taskId: string | null) => void;
  toggleSidebar: (collapsed?: boolean) => void;
  pinTask: (taskId: string) => Promise<void>;
  unpinTask: (taskId: string) => Promise<void>;
  deleteTask: (taskId: string) => Promise<void>;
  markNewTask: (taskId: string) => void;
  clearNewTask: (taskId: string) => void;
}

// Sort by lastActivityAt descending (grouping/pinned handled by component)
function sortTasks(tasks: TaskInfo[]): TaskInfo[] {
  return [...tasks].sort((a, b) => {
    const aTime = a.lastActivityAt || a.updatedAt || a.createdAt;
    const bTime = b.lastActivityAt || b.updatedAt || b.createdAt;
    return bTime - aTime;
  });
}

export const useTaskSidebarStore = create<TaskSidebarState>((set, get) => ({
  tasks: [],
  selectedTaskId: null,
  cronJobs: [],
  sidebarCollapsed: false,
  pendingSessionId: null,
  pendingNewTab: null,
  pendingTabNotify: null,
  newlyCreatedTaskIds: new Set(),

  loadTasks: async () => {
    try {
      const tasks = await listTasks();
      set({ tasks: sortTasks(tasks) });
    } catch (err) {
      console.error('Failed to load tasks:', err);
    }
  },

  loadCronJobs: async () => {
    try {
      const jobs = await invoke<any[]>('list_cronjobs');
      const briefs: CronJobBrief[] = (jobs || []).map((j: any) => ({
        id: j.id,
        name: j.name,
        schedule_display: j.schedule?.cron
          ? j.schedule.cron
          : j.schedule?.delay_minutes
            ? `${j.schedule.delay_minutes}min`
            : j.schedule?.once || '',
        enabled: j.enabled,
        last_run_at: j.last_run_at || null,
        last_run_status: j.last_run_status || null,
        next_run_at: j.next_run_at || null,
      }));
      set({ cronJobs: briefs.filter(j => j.enabled) });
    } catch (err) {
      console.error('Failed to load cron jobs:', err);
    }
  },

  addOrRefreshTask: async (taskId: string) => {
    try {
      const task = await getTaskStatus(taskId);
      set((state) => ({
        tasks: sortTasks([task, ...state.tasks.filter((t) => t.id !== taskId)]),
      }));
    } catch (err) {
      console.error('Failed to refresh task:', err);
    }
  },

  updateTaskProgress: (taskId, currentStage, totalStages, progress) => set((state) => ({
    tasks: sortTasks(state.tasks.map((t) =>
      t.id === taskId
        ? { ...t, currentStage, totalStages, progress, status: 'running' as const, updatedAt: Date.now() }
        : t
    )),
  })),

  updateTaskStatus: (taskId, status, errorMessage) => set((state) => ({
    tasks: sortTasks(state.tasks.map((t) =>
      t.id === taskId
        ? {
            ...t,
            status: status as TaskInfo['status'],
            errorMessage: errorMessage || t.errorMessage,
            updatedAt: Date.now(),
            completedAt: ['completed', 'failed', 'cancelled'].includes(status) ? Date.now() : t.completedAt,
          }
        : t
    )),
  })),

  removeTask: (taskId) => set((state) => ({
    tasks: state.tasks.filter((t) => t.id !== taskId),
    selectedTaskId: state.selectedTaskId === taskId ? null : state.selectedTaskId,
  })),

  selectTask: (taskId) => set({ selectedTaskId: taskId }),

  navigateToSession: (sessionId) => set({ pendingSessionId: sessionId }),
  consumePendingSession: () => {
    const id = get().pendingSessionId;
    if (id) set({ pendingSessionId: null });
    return id;
  },

  addPendingNewTab: (id, name) => set({ pendingNewTab: { id, name } }),
  consumePendingNewTab: () => {
    const tab = get().pendingNewTab;
    if (tab) set({ pendingNewTab: null });
    return tab;
  },

  notifyTab: (id, type) => set({ pendingTabNotify: { id, type } }),
  consumeTabNotify: () => {
    const n = get().pendingTabNotify;
    if (n) set({ pendingTabNotify: null });
    return n;
  },

  toggleSidebar: (collapsed) => set((state) => ({
    sidebarCollapsed: collapsed !== undefined ? collapsed : !state.sidebarCollapsed,
  })),

  pinTask: async (taskId) => {
    try {
      await invoke('pin_task', { taskId, pinned: true });
      set((state) => ({
        tasks: sortTasks(state.tasks.map((t) =>
          t.id === taskId ? { ...t, pinned: true } : t
        )),
      }));
    } catch (err) {
      console.error('Failed to pin task:', err);
    }
  },

  unpinTask: async (taskId) => {
    try {
      await invoke('pin_task', { taskId, pinned: false });
      set((state) => ({
        tasks: sortTasks(state.tasks.map((t) =>
          t.id === taskId ? { ...t, pinned: false } : t
        )),
      }));
    } catch (err) {
      console.error('Failed to unpin task:', err);
    }
  },

  deleteTask: async (taskId) => {
    try {
      await invoke('delete_task', { taskId });
      set((state) => ({
        tasks: state.tasks.filter((t) => t.id !== taskId),
        selectedTaskId: state.selectedTaskId === taskId ? null : state.selectedTaskId,
      }));
    } catch (err) {
      console.error('Failed to delete task:', err);
    }
  },

  markNewTask: (taskId) => set((state) => {
    const next = new Set(state.newlyCreatedTaskIds);
    next.add(taskId);
    return { newlyCreatedTaskIds: next };
  }),

  clearNewTask: (taskId) => set((state) => {
    const next = new Set(state.newlyCreatedTaskIds);
    next.delete(taskId);
    return { newlyCreatedTaskIds: next };
  }),
}));
