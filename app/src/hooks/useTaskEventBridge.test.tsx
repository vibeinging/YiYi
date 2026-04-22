import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { mockEventBridge } from '../test-utils/mockEvent';
import { mockInvoke } from '../test-utils/mockTauri';
import { ToastProvider } from '../components/Toast';
import { render } from '@testing-library/react';
import { useTaskStore } from '../stores/taskStore';
import { useTaskSidebarStore } from '../stores/taskSidebarStore';
import { useTaskEventBridge } from './useTaskEventBridge';

const taskStorePristine = useTaskStore.getState();
const sidebarPristine = useTaskSidebarStore.getState();

function Harness() {
  useTaskEventBridge();
  return null;
}

async function setup(invokeRoutes: Record<string, any> = {}) {
  const bridge = mockEventBridge();
  mockInvoke({
    list_tasks: vi.fn().mockResolvedValue([]),
    ...invokeRoutes,
  });
  useTaskStore.setState(taskStorePristine, true);
  useTaskSidebarStore.setState(sidebarPristine, true);
  render(
    <ToastProvider>
      <Harness />
    </ToastProvider>,
  );
  await vi.waitFor(() => expect(bridge.channels()).toContain('task://created'));
  return bridge;
}

describe('useTaskEventBridge', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('subscribes to task://* events and initial load_tasks', async () => {
    const list = vi.fn().mockResolvedValue([]);
    const bridge = await setup({ list_tasks: list });
    expect(bridge.channels()).toEqual(
      expect.arrayContaining([
        'task://created',
        'task://stream_chunk',
        'task://tool_start',
        'task://tool_end',
        'task://progress',
        'task://completed',
        'task://failed',
        'task://cancelled',
        'task://paused',
        'task://deleted',
        'task://updated',
      ]),
    );
    await waitFor(() => expect(list).toHaveBeenCalled());
  });

  it('task://progress updates both stores', async () => {
    const getTask = vi.fn().mockResolvedValue({
      id: 't1',
      title: 'T',
      description: null,
      status: 'running',
      session_id: 's1',
      parent_session_id: null,
      plan: null,
      current_stage: 0,
      total_stages: 3,
      progress: 0,
      error_message: null,
      created_at: 0,
      updated_at: 0,
      completed_at: null,
      task_type: 'inline',
      pinned: false,
      last_activity_at: 0,
    });
    const bridge = await setup({ get_task: getTask });

    // Seed both stores
    useTaskStore.setState({ tasks: [{ id: 't1', title: 'T', description: null, status: 'running', sessionId: 's1', parentSessionId: null, plan: null, currentStage: 0, totalStages: 3, progress: 0, errorMessage: null, createdAt: 0, updatedAt: 0, completedAt: null, taskType: 'inline', pinned: false, lastActivityAt: 0 }] });
    useTaskSidebarStore.setState({ tasks: [{ id: 't1', title: 'T', description: null, status: 'running', sessionId: 's1', parentSessionId: null, plan: null, currentStage: 0, totalStages: 3, progress: 0, errorMessage: null, createdAt: 0, updatedAt: 0, completedAt: null, taskType: 'inline', pinned: false, lastActivityAt: 0 }] });

    act(() => {
      bridge.dispatch('task://progress', { task_id: 't1', currentStage: 2, totalStages: 3, progress: 67 });
    });

    expect(useTaskStore.getState().tasks[0].progress).toBe(67);
    expect(useTaskSidebarStore.getState().tasks[0].progress).toBe(67);
  });

  it('task://completed flips status + surfaces success toast', async () => {
    const bridge = await setup();
    useTaskStore.setState({ tasks: [{ id: 't1', title: 'T', description: null, status: 'running', sessionId: 's1', parentSessionId: null, plan: null, currentStage: 0, totalStages: 1, progress: 50, errorMessage: null, createdAt: 0, updatedAt: 0, completedAt: null, taskType: 'inline', pinned: false, lastActivityAt: 0 }] });
    useTaskSidebarStore.setState({ tasks: [{ id: 't1', title: 'T', description: null, status: 'running', sessionId: 's1', parentSessionId: null, plan: null, currentStage: 0, totalStages: 1, progress: 50, errorMessage: null, createdAt: 0, updatedAt: 0, completedAt: null, taskType: 'inline', pinned: false, lastActivityAt: 0 }] });

    act(() => {
      bridge.dispatch('task://completed', { task_id: 't1', title: 'T' });
    });

    expect(useTaskStore.getState().tasks[0].status).toBe('completed');
    expect(useTaskSidebarStore.getState().tasks[0].status).toBe('completed');
  });

  it('task://failed flips status + records errorMessage', async () => {
    const bridge = await setup();
    useTaskStore.setState({ tasks: [{ id: 't1', title: 'T', description: null, status: 'running', sessionId: 's1', parentSessionId: null, plan: null, currentStage: 0, totalStages: 1, progress: 0, errorMessage: null, createdAt: 0, updatedAt: 0, completedAt: null, taskType: 'inline', pinned: false, lastActivityAt: 0 }] });
    useTaskSidebarStore.setState({ tasks: [{ id: 't1', title: 'T', description: null, status: 'running', sessionId: 's1', parentSessionId: null, plan: null, currentStage: 0, totalStages: 1, progress: 0, errorMessage: null, createdAt: 0, updatedAt: 0, completedAt: null, taskType: 'inline', pinned: false, lastActivityAt: 0 }] });

    act(() => {
      bridge.dispatch('task://failed', { task_id: 't1', error_message: 'boom' });
    });

    expect(useTaskStore.getState().tasks[0].status).toBe('failed');
    expect(useTaskStore.getState().tasks[0].errorMessage).toBe('boom');
  });

  it('task://deleted removes from both stores', async () => {
    const bridge = await setup();
    const t = { id: 't1', title: 'T', description: null, status: 'running' as const, sessionId: 's1', parentSessionId: null, plan: null, currentStage: 0, totalStages: 1, progress: 0, errorMessage: null, createdAt: 0, updatedAt: 0, completedAt: null, taskType: 'inline', pinned: false, lastActivityAt: 0 };
    useTaskStore.setState({ tasks: [t] });
    useTaskSidebarStore.setState({ tasks: [t] });

    act(() => {
      bridge.dispatch('task://deleted', { task_id: 't1' });
    });

    expect(useTaskStore.getState().tasks).toHaveLength(0);
    expect(useTaskSidebarStore.getState().tasks).toHaveLength(0);
  });
});
