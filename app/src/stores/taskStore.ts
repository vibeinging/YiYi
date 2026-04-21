import { create } from 'zustand';
import { TaskInfo } from '../api/tasks';
import { listTasks, getTaskStatus } from '../api/tasks';

interface TaskStore {
  tasks: TaskInfo[];
  selectedTaskId: string | null;
  drawerOpen: boolean;
  panelCollapsed: boolean;
  /** Whether the right sidebar is manually collapsed by user */
  sidebarCollapsed: boolean;

  loadTasks: () => Promise<void>;
  addTask: (task: TaskInfo) => void;
  addOrRefreshTask: (taskId: string) => Promise<void>;
  updateTaskProgress: (taskId: string, currentStage: number, totalStages: number, progress: number) => void;
  updateTaskStatus: (taskId: string, status: string, errorMessage?: string) => void;
  removeTask: (taskId: string) => void;
  selectTask: (taskId: string | null) => void;
  toggleDrawer: (open?: boolean) => void;
  togglePanel: (collapsed?: boolean) => void;
  toggleSidebar: (collapsed?: boolean) => void;
}

export const useTaskStore = create<TaskStore>((set, get) => ({
  tasks: [],
  selectedTaskId: null,
  drawerOpen: false,
  panelCollapsed: false,
  sidebarCollapsed: false,

  loadTasks: async () => {
    try {
      const tasks = await listTasks();
      set({ tasks });
    } catch (err) {
      console.error('Failed to load tasks:', err);
    }
  },

  addTask: (task) => set((state) => ({
    tasks: [task, ...state.tasks.filter((t) => t.id !== task.id)],
  })),

  // Fetch full TaskInfo from backend and add/update in store
  addOrRefreshTask: async (taskId: string) => {
    try {
      const task = await getTaskStatus(taskId);
      set((state) => ({
        tasks: [task, ...state.tasks.filter((t) => t.id !== taskId)],
      }));
    } catch (err) {
      console.error('Failed to refresh task:', err);
    }
  },

  updateTaskProgress: (taskId, currentStage, totalStages, progress) => set((state) => ({
    tasks: state.tasks.map((t) =>
      t.id === taskId
        ? {
            ...t,
            currentStage,
            totalStages,
            progress,
            status: 'running' as const,
            updatedAt: Date.now(),
          }
        : t
    ),
  })),

  updateTaskStatus: (taskId, status, errorMessage) => set((state) => ({
    tasks: state.tasks.map((t) =>
      t.id === taskId
        ? {
            ...t,
            status: status as TaskInfo['status'],
            // Distinguish "omitted" (undefined — keep prior) from "explicit clear"
            // (empty string — overwrite). The previous `errorMessage || t.errorMessage`
            // couldn't clear because '' is falsy.
            errorMessage: errorMessage === undefined ? t.errorMessage : errorMessage,
            updatedAt: Date.now(),
            completedAt: ['completed', 'failed', 'cancelled'].includes(status) ? Date.now() : t.completedAt,
          }
        : t
    ),
  })),

  removeTask: (taskId) => set((state) => ({
    tasks: state.tasks.filter((t) => t.id !== taskId),
    selectedTaskId: state.selectedTaskId === taskId ? null : state.selectedTaskId,
    drawerOpen: state.selectedTaskId === taskId ? false : state.drawerOpen,
  })),

  selectTask: (taskId) => set({
    selectedTaskId: taskId,
    drawerOpen: taskId !== null,
  }),

  toggleDrawer: (open) => set((state) => ({
    drawerOpen: open !== undefined ? open : !state.drawerOpen,
    selectedTaskId: (open === false || (!open && state.drawerOpen)) ? null : state.selectedTaskId,
  })),

  togglePanel: (collapsed) => set((state) => ({
    panelCollapsed: collapsed !== undefined ? collapsed : !state.panelCollapsed,
  })),

  toggleSidebar: (collapsed) => set((state) => ({
    sidebarCollapsed: collapsed !== undefined ? collapsed : !state.sidebarCollapsed,
  })),
}));
