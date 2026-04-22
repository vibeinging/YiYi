import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TaskCard } from './TaskCard';
import { useTaskSidebarStore } from '../stores/taskSidebarStore';
import type { TaskInfo } from '../api/tasks';

function makeTask(over: Partial<TaskInfo> = {}): TaskInfo {
  const now = Date.now();
  return {
    id: 'task-123',
    title: 'Build feature',
    description: null,
    status: 'running',
    sessionId: 'sess-1',
    parentSessionId: null,
    plan: null,
    currentStage: 1,
    totalStages: 3,
    progress: 33,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    taskType: 'background',
    pinned: false,
    lastActivityAt: now,
    ...over,
  };
}

const pristine = useTaskSidebarStore.getState();

describe('TaskCard', () => {
  beforeEach(() => {
    useTaskSidebarStore.setState({ ...pristine, tasks: [] }, true);
  });

  it('renders fallback when task missing', () => {
    render(<TaskCard taskId="abcdefgh-unknown" />);
    expect(screen.getByText(/Task abcdefgh/)).toBeInTheDocument();
  });

  it('renders running task with title + progress', () => {
    useTaskSidebarStore.setState({ tasks: [makeTask()] });
    render(<TaskCard taskId="task-123" />);
    expect(screen.getByText('Build feature')).toBeInTheDocument();
    expect(screen.getByText('33%')).toBeInTheDocument();
    expect(screen.getByText('进行中')).toBeInTheDocument();
  });

  it('renders error message for failed task', () => {
    useTaskSidebarStore.setState({
      tasks: [makeTask({ status: 'failed', errorMessage: 'Boom', progress: 0, totalStages: 0 })],
    });
    render(<TaskCard taskId="task-123" />);
    expect(screen.getByText('Boom')).toBeInTheDocument();
    expect(screen.getByText('失败')).toBeInTheDocument();
  });

  it('click navigates to session via store', () => {
    useTaskSidebarStore.setState({ tasks: [makeTask()] });
    render(<TaskCard taskId="task-123" />);
    fireEvent.click(screen.getByText('Build feature'));
    expect(useTaskSidebarStore.getState().pendingSessionId).toBe('sess-1');
  });

  it('truncates long error messages to 120 chars', () => {
    const longErr = 'x'.repeat(150);
    useTaskSidebarStore.setState({
      tasks: [makeTask({ status: 'failed', errorMessage: longErr })],
    });
    render(<TaskCard taskId="task-123" />);
    const el = screen.getByText((content) => content.includes('xxx') && content.endsWith('...'));
    expect(el).toBeInTheDocument();
  });
});
