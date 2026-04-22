import { describe, it, expect, beforeEach } from 'vitest';
import { useTaskSidebarStore } from './taskSidebarStore';

const PRISTINE = useTaskSidebarStore.getState();

function reset() {
  useTaskSidebarStore.setState(PRISTINE, true);
}

describe('taskSidebarStore', () => {
  beforeEach(reset);

  it('starts with sidebar expanded and no pending signals', () => {
    const s = useTaskSidebarStore.getState();
    expect(s.sidebarCollapsed).toBe(false);
    expect(s.pendingSessionId).toBeNull();
    expect(s.pendingNewTab).toBeNull();
    expect(s.pendingTabNotify).toBeNull();
  });

  it('navigateToSession + consumePendingSession roundtrip', () => {
    useTaskSidebarStore.getState().navigateToSession('s-42');
    expect(useTaskSidebarStore.getState().pendingSessionId).toBe('s-42');
    const consumed = useTaskSidebarStore.getState().consumePendingSession();
    expect(consumed).toBe('s-42');
    expect(useTaskSidebarStore.getState().pendingSessionId).toBeNull();
  });

  it('consumePendingSession returns null when none pending', () => {
    expect(useTaskSidebarStore.getState().consumePendingSession()).toBeNull();
  });

  it('addPendingNewTab + consumePendingNewTab roundtrip', () => {
    useTaskSidebarStore.getState().addPendingNewTab('t-1', 'My Task');
    expect(useTaskSidebarStore.getState().pendingNewTab).toEqual({ id: 't-1', name: 'My Task' });
    const consumed = useTaskSidebarStore.getState().consumePendingNewTab();
    expect(consumed).toEqual({ id: 't-1', name: 'My Task' });
    expect(useTaskSidebarStore.getState().pendingNewTab).toBeNull();
  });

  it('notifyTab + consumeTabNotify roundtrip', () => {
    useTaskSidebarStore.getState().notifyTab('s-9', 'complete');
    expect(useTaskSidebarStore.getState().pendingTabNotify).toEqual({ id: 's-9', type: 'complete' });
    expect(useTaskSidebarStore.getState().consumeTabNotify()).toEqual({ id: 's-9', type: 'complete' });
    expect(useTaskSidebarStore.getState().pendingTabNotify).toBeNull();
  });

  it('toggleSidebar flips without arg, sets explicitly with arg', () => {
    expect(useTaskSidebarStore.getState().sidebarCollapsed).toBe(false);
    useTaskSidebarStore.getState().toggleSidebar();
    expect(useTaskSidebarStore.getState().sidebarCollapsed).toBe(true);
    useTaskSidebarStore.getState().toggleSidebar(false);
    expect(useTaskSidebarStore.getState().sidebarCollapsed).toBe(false);
    useTaskSidebarStore.getState().toggleSidebar(true);
    expect(useTaskSidebarStore.getState().sidebarCollapsed).toBe(true);
  });
});
