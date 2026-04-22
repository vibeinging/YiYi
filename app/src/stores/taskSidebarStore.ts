/**
 * Session tab notification + sidebar collapse state.
 *
 * Task data lives in `taskStore` — this store handles only the chat session
 * tab bar's cross-component signals (pending navigation, new-tab addition,
 * flash notification on task completion) and the sidebar collapsed flag.
 */
import { create } from 'zustand';

interface TaskSidebarState {
  sidebarCollapsed: boolean;
  pendingSessionId: string | null;
  pendingNewTab: { id: string; name: string } | null;
  pendingTabNotify: { id: string; type: 'complete' | 'fail' } | null;

  navigateToSession: (sessionId: string) => void;
  consumePendingSession: () => string | null;
  addPendingNewTab: (id: string, name: string) => void;
  consumePendingNewTab: () => { id: string; name: string } | null;
  notifyTab: (id: string, type: 'complete' | 'fail') => void;
  consumeTabNotify: () => { id: string; type: 'complete' | 'fail' } | null;
  toggleSidebar: (collapsed?: boolean) => void;
}

export const useTaskSidebarStore = create<TaskSidebarState>((set, get) => ({
  sidebarCollapsed: false,
  pendingSessionId: null,
  pendingNewTab: null,
  pendingTabNotify: null,

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
}));
