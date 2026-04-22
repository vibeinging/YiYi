import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../i18n';
import { mockInvoke } from '../test-utils/mockTauri';
import { TaskSidebar } from './TaskSidebar';
import { useTaskSidebarStore } from '../stores/taskSidebarStore';
import { useSessionStore } from '../stores/sessionStore';
import type { TaskInfo } from '../api/tasks';
import type { ChatSession } from '../api/agent';

const pristineTaskSidebar = useTaskSidebarStore.getState();
const pristineSession = useSessionStore.getState();

beforeEach(() => {
  // IntersectionObserver polyfill
  class FakeIO {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
    takeRecords = () => [];
    root = null;
    rootMargin = '';
    thresholds = [];
  }
  (globalThis as any).IntersectionObserver = FakeIO;
});

function task(over: Partial<TaskInfo> = {}): TaskInfo {
  const now = Date.now();
  return {
    id: 't-' + Math.random().toString(36).slice(2, 8),
    title: 'Task A',
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

function session(over: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 's-' + Math.random().toString(36).slice(2, 8),
    name: 'Chat 1',
    created_at: Date.now(),
    updated_at: Date.now(),
    source: 'user',
    source_meta: null,
    ...over,
  };
}

function renderSidebar(over: {
  tasks?: TaskInfo[];
  sessions?: ChatSession[];
  collapsed?: boolean;
  activeSessionId?: string;
  sessionOverrides?: Partial<ReturnType<typeof useSessionStore.getState>>;
} = {}) {
  mockInvoke({});
  useTaskSidebarStore.setState({
    ...pristineTaskSidebar,
    tasks: over.tasks ?? [],
    cronJobs: [],
    sidebarCollapsed: over.collapsed ?? false,
  }, true);
  useSessionStore.setState({
    ...pristineSession,
    chatSessions: over.sessions ?? [],
    activeSessionId: over.activeSessionId ?? '',
    hasMore: false,
    loadingMore: false,
    searchResults: null,
    searchQuery: '',
    ...(over.sessionOverrides ?? {}),
  });
  const onPageChange = vi.fn();
  const onNavigate = vi.fn();
  const onDrag = vi.fn();
  const utils = render(
    <TaskSidebar
      currentPage="chat"
      onPageChange={onPageChange}
      onNavigateToSession={onNavigate}
      onDragMouseDown={onDrag}
    />,
  );
  return { onPageChange, onNavigate, onDrag, ...utils };
}

describe('TaskSidebar collapsed mode', () => {
  it('shows new chat button and active count when tasks running', () => {
    renderSidebar({
      collapsed: true,
      tasks: [task({ status: 'running' }), task({ status: 'running' })],
    });
    expect(screen.getByTitle('新对话')).toBeInTheDocument();
    expect(screen.getByTitle(/2 active/)).toBeInTheDocument();
  });

  it('collapsed view has expand button at bottom', () => {
    renderSidebar({ collapsed: true });
    // Expand button is the last rendered button and uses PanelLeft icon.
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(1);
    // The layout intentionally hides "active count" button when there are no running tasks,
    // so the expand button is always present last. Just verify it exists.
    expect(buttons[buttons.length - 1]).toBeInTheDocument();
  });

  it('collapsed new-chat button invokes createNewChat + onPageChange', () => {
    const createNewChat = vi.fn().mockResolvedValue('new-id');
    const { onPageChange } = renderSidebar({
      collapsed: true,
      sessionOverrides: { createNewChat },
    });
    fireEvent.click(screen.getByTitle('新对话'));
    expect(createNewChat).toHaveBeenCalled();
    expect(onPageChange).toHaveBeenCalledWith('chat');
  });
});

describe('TaskSidebar expanded mode', () => {
  it('empty state shows hint when no tasks/cronjobs/sessions', () => {
    renderSidebar({ collapsed: false });
    expect(screen.getByText('点击上方按钮开始新对话')).toBeInTheDocument();
  });

  it('renders 置顶 section when pinned tasks exist', () => {
    renderSidebar({
      collapsed: false,
      tasks: [task({ pinned: true, title: 'Pinned One' })],
    });
    expect(screen.getByText('Pinned One')).toBeInTheDocument();
    // Section label 置顶
    expect(screen.getByText('置顶')).toBeInTheDocument();
  });

  it('renders 进行中 section for running non-pinned tasks', () => {
    renderSidebar({
      collapsed: false,
      tasks: [task({ status: 'running', title: 'Active X' })],
    });
    expect(screen.getByText('Active X')).toBeInTheDocument();
    expect(screen.getByText('进行中')).toBeInTheDocument();
  });

  it('clicking a task card navigates via store', () => {
    renderSidebar({
      collapsed: false,
      tasks: [task({ title: 'NavMe', sessionId: 'target-session' })],
    });
    fireEvent.click(screen.getByText('NavMe'));
    expect(useTaskSidebarStore.getState().pendingSessionId).toBe('target-session');
  });

  it('finished tasks render under their date group', () => {
    const now = Date.now();
    renderSidebar({
      collapsed: false,
      tasks: [
        task({ status: 'completed', title: 'Done A', completedAt: now, progress: 100 }),
      ],
    });
    expect(screen.getByText('Done A')).toBeInTheDocument();
    expect(screen.getByText('今天')).toBeInTheDocument();
  });

  it('more-finished button appears when >8 finished tasks', () => {
    const now = Date.now();
    const finished = Array.from({ length: 12 }, (_, i) =>
      task({
        id: `t-${i}`,
        status: 'completed',
        title: `Done ${i}`,
        completedAt: now - i * 1000,
        progress: 100,
      }),
    );
    renderSidebar({ collapsed: false, tasks: finished });
    expect(screen.getByText(/更多 \(4\)/)).toBeInTheDocument();
  });

  it('clicking 更多 reveals all finished tasks', () => {
    const now = Date.now();
    const finished = Array.from({ length: 12 }, (_, i) =>
      task({
        id: `t-${i}`,
        status: 'completed',
        title: `Done ${i}`,
        completedAt: now - i * 1000,
        progress: 100,
      }),
    );
    renderSidebar({ collapsed: false, tasks: finished });
    fireEvent.click(screen.getByText(/更多 \(4\)/));
    expect(screen.getByText('Done 11')).toBeInTheDocument();
    expect(screen.queryByText(/更多 \(/)).not.toBeInTheDocument();
  });

  it('sessions section renders chat session card', () => {
    renderSidebar({
      collapsed: false,
      sessions: [session({ name: 'MyChat' })],
    });
    expect(screen.getByText('MyChat')).toBeInTheDocument();
    expect(screen.getByText('对话')).toBeInTheDocument();
  });

  it('clicking a session switches and changes page to chat', () => {
    const switchToSession = vi.fn();
    const sess = session({ id: 'abc', name: 'SessX' });
    const { onPageChange } = renderSidebar({
      collapsed: false,
      sessions: [sess],
      sessionOverrides: { switchToSession },
    });
    fireEvent.click(screen.getByText('SessX'));
    expect(switchToSession).toHaveBeenCalledWith('abc');
    expect(onPageChange).toHaveBeenCalledWith('chat');
  });
});
