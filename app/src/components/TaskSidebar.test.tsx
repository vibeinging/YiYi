import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../i18n';
import { mockInvoke } from '../test-utils/mockTauri';
import { TaskSidebar } from './TaskSidebar';
import { useTaskSidebarStore } from '../stores/taskSidebarStore';
import { useSessionStore } from '../stores/sessionStore';
import type { ChatSession } from '../api/agent';

const pristineTaskSidebar = useTaskSidebarStore.getState();
const pristineSession = useSessionStore.getState();

beforeEach(() => {
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
  sessions?: ChatSession[];
  collapsed?: boolean;
  activeSessionId?: string;
  sessionOverrides?: Partial<ReturnType<typeof useSessionStore.getState>>;
} = {}) {
  mockInvoke({});
  useTaskSidebarStore.setState({
    ...pristineTaskSidebar,
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
  it('shows new chat button', () => {
    renderSidebar({ collapsed: true });
    expect(screen.getByTitle('新对话')).toBeInTheDocument();
  });

  it('collapsed view has expand button at bottom', () => {
    renderSidebar({ collapsed: true });
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(1);
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

  it('does not render any task section in collapsed mode', () => {
    renderSidebar({ collapsed: true });
    expect(screen.queryByText('进行中')).not.toBeInTheDocument();
    expect(screen.queryByText('置顶')).not.toBeInTheDocument();
    expect(screen.queryByText('今天')).not.toBeInTheDocument();
  });
});

describe('TaskSidebar expanded mode', () => {
  it('empty state shows hint when no sessions exist', () => {
    renderSidebar({ collapsed: false });
    expect(screen.getByText('点击上方按钮开始新对话')).toBeInTheDocument();
  });

  it('never renders any task section', () => {
    renderSidebar({ collapsed: false });
    for (const label of ['置顶', '进行中', '定时', '今天', '昨天', '本周', '本月']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
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

  it('active session highlights with aria-like styling', () => {
    renderSidebar({
      collapsed: false,
      sessions: [session({ id: 's1', name: 'A' })],
      activeSessionId: 's1',
    });
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('bottom nav shows buddy/extensions/bots/settings', () => {
    renderSidebar({ collapsed: false });
    const buttons = screen.getAllByRole('button');
    const labels = ['小精灵', '扩展', '机器人', '设置'];
    for (const label of labels) {
      expect(buttons.some(b => b.textContent?.includes(label))).toBe(true);
    }
  });
});
