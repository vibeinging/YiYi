import { invoke } from '@tauri-apps/api/core';

// Backend serializes with camelCase (serde rename_all = "camelCase")
export interface TaskInfo {
  id: string;
  title: string;
  description: string | null;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  sessionId: string;
  parentSessionId: string | null;
  plan: string | null;  // JSON string of TaskStage[]
  currentStage: number;
  totalStages: number;
  progress: number;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  taskType: string;
  pinned: boolean;
  lastActivityAt: number;
  workspacePath?: string;
}

export interface TaskStage {
  title: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

export const createTask = (title: string, description?: string, parentSessionId?: string, plan?: string[]) =>
  invoke<TaskInfo>('create_task', { title, description, parentSessionId, plan });

export const listTasks = (parentSessionId?: string, status?: string) =>
  invoke<TaskInfo[]>('list_tasks', { parentSessionId, status });

export const getTaskStatus = (taskId: string) =>
  invoke<TaskInfo>('get_task_status', { taskId });

export const cancelTask = (taskId: string) =>
  invoke<void>('cancel_task', { taskId });

export const pauseTask = (taskId: string) =>
  invoke<void>('pause_task', { taskId });

export const sendTaskMessage = (taskId: string, message: string) =>
  invoke<void>('send_task_message', { taskId, message });

export const deleteTask = (taskId: string) =>
  invoke<void>('delete_task', { taskId });

export const pinTask = (taskId: string, pinned: boolean) =>
  invoke<void>('pin_task', { taskId, pinned });

export const confirmBackgroundTask = (
  parentSessionId: string,
  taskName: string,
  originalMessage: string,
  contextSummary: string,
  workspacePath?: string,
) => invoke<TaskInfo>('confirm_background_task', {
  parentSessionId,
  taskName,
  originalMessage,
  contextSummary,
  workspacePath,
});

// Convert mid-conversation to a long task
export const convertToLongTask = (
  parentSessionId: string,
  taskName: string,
  contextSummary: string,
  workspacePath?: string,
) => invoke<TaskInfo>('convert_to_long_task', {
  parentSessionId,
  taskName,
  contextSummary,
  workspacePath,
});

// Search task by name
export const getTaskByName = (name: string) =>
  invoke<TaskInfo | null>('get_task_by_name', { name });

// List all tasks brief info
export const listAllTasksBrief = () =>
  invoke<TaskInfo[]>('list_all_tasks_brief');
