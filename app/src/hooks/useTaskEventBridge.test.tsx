import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { act, waitFor, render } from '@testing-library/react';
import { mockEventBridge } from '../test-utils/mockEvent';
import { mockInvoke } from '../test-utils/mockTauri';
import { ToastProvider } from '../components/Toast';
import { useTaskStore } from '../stores/taskStore';
import { useTaskSidebarStore } from '../stores/taskSidebarStore';
import { useTaskEventBridge } from './useTaskEventBridge';
import type { TaskInfo } from '../api/tasks';

const taskStorePristine = useTaskStore.getState();
const sidebarPristine = useTaskSidebarStore.getState();

function Harness() {
  useTaskEventBridge();
  return null;
}

function makeTask(over: Partial<TaskInfo> = {}): TaskInfo {
  return {
    id: 't1',
    title: 'T',
    description: null,
    status: 'running',
    sessionId: 's1',
    parentSessionId: null,
    plan: null,
    currentStage: 0,
    totalStages: 1,
    progress: 0,
    errorMessage: null,
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    taskType: 'inline',
    pinned: false,
    lastActivityAt: 0,
    ...over,
  };
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

  it('task://progress updates taskStore', async () => {
    const bridge = await setup();
    useTaskStore.setState({ tasks: [makeTask()] });

    act(() => {
      bridge.dispatch('task://progress', { task_id: 't1', currentStage: 2, totalStages: 3, progress: 67 });
    });

    expect(useTaskStore.getState().tasks[0].progress).toBe(67);
  });

  it('task://completed flips status + fires notifyTab on sidebar', async () => {
    const bridge = await setup();
    useTaskStore.setState({ tasks: [makeTask()] });

    act(() => {
      bridge.dispatch('task://completed', { task_id: 't1', title: 'T' });
    });

    expect(useTaskStore.getState().tasks[0].status).toBe('completed');
    expect(useTaskSidebarStore.getState().pendingTabNotify).toEqual({ id: 's1', type: 'complete' });
  });

  it('task://failed records errorMessage and notifies tab', async () => {
    const bridge = await setup();
    useTaskStore.setState({ tasks: [makeTask()] });

    act(() => {
      bridge.dispatch('task://failed', { task_id: 't1', error_message: 'boom' });
    });

    expect(useTaskStore.getState().tasks[0].status).toBe('failed');
    expect(useTaskStore.getState().tasks[0].errorMessage).toBe('boom');
    expect(useTaskSidebarStore.getState().pendingTabNotify).toEqual({ id: 's1', type: 'fail' });
  });

  it('task://deleted removes from taskStore', async () => {
    const bridge = await setup();
    useTaskStore.setState({ tasks: [makeTask()] });

    act(() => {
      bridge.dispatch('task://deleted', { task_id: 't1' });
    });

    expect(useTaskStore.getState().tasks).toHaveLength(0);
  });

  it('task://created with source=tool queues pending new tab', async () => {
    const bridge = await setup({
      get_task: vi.fn().mockResolvedValue(makeTask()),
    });
    act(() => {
      bridge.dispatch('task://created', {
        task_id: 't1',
        session_id: 's1',
        title: '我的任务',
        source: 'tool',
      });
    });
    expect(useTaskSidebarStore.getState().pendingNewTab).toEqual({ id: 's1', name: '我的任务' });
  });
});
