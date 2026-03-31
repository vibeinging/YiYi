/**
 * sessionStore — Centralized chat session state management.
 * Supports pagination (lazy loading) and search.
 */

import { create } from 'zustand';
import {
  listChatSessions,
  searchChatSessions,
  createSession,
  renameSession as apiRenameSession,
  deleteSession as apiDeleteSession,
  type ChatSession,
} from '../api/agent';

const STORAGE_KEY = 'yiyi_last_active_session';
const TABS_STORAGE_KEY = 'yiyi_open_tabs';
const PAGE_SIZE = 30;

interface SessionState {
  chatSessions: ChatSession[];
  activeSessionId: string;
  openTabIds: string[];
  initialized: boolean;

  // Pagination
  hasMore: boolean;
  loadingMore: boolean;

  // Search
  searchQuery: string;
  searchResults: ChatSession[] | null; // null = not searching

  // Actions
  loadChatSessions: () => Promise<void>;
  loadMoreSessions: () => Promise<void>;
  searchSessions: (query: string) => Promise<void>;
  clearSearch: () => void;
  createNewChat: () => Promise<string>;
  switchToSession: (id: string) => void;
  closeTab: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, name: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
  initialize: () => Promise<void>;

  // Tab management for task/cron sessions (non-chat tabs)
  addTab: (id: string) => void;
  hasTab: (id: string) => boolean;

  // Internal
  _persistTabs: () => void;
  _persistActive: () => void;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  chatSessions: [],
  activeSessionId: '',
  openTabIds: [],
  initialized: false,
  hasMore: true,
  loadingMore: false,
  searchQuery: '',
  searchResults: null,

  _persistTabs: () => {
    const { openTabIds } = get();
    try { localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(openTabIds)); } catch {}
  },

  _persistActive: () => {
    const { activeSessionId } = get();
    try { localStorage.setItem(STORAGE_KEY, activeSessionId); } catch {}
  },

  loadChatSessions: async () => {
    try {
      const sessions = await listChatSessions(PAGE_SIZE, 0);
      set({ chatSessions: sessions, hasMore: sessions.length >= PAGE_SIZE });
    } catch (err) {
      console.error('Failed to load chat sessions:', err);
    }
  },

  loadMoreSessions: async () => {
    const { loadingMore, hasMore, chatSessions } = get();
    if (loadingMore || !hasMore) return;
    set({ loadingMore: true });
    try {
      const more = await listChatSessions(PAGE_SIZE, chatSessions.length);
      set({
        chatSessions: [...chatSessions, ...more],
        hasMore: more.length >= PAGE_SIZE,
        loadingMore: false,
      });
    } catch (err) {
      console.error('Failed to load more sessions:', err);
      set({ loadingMore: false });
    }
  },

  searchSessions: async (query: string) => {
    set({ searchQuery: query });
    if (!query.trim()) {
      set({ searchResults: null });
      return;
    }
    try {
      const results = await searchChatSessions(query.trim(), 20);
      // Only update if query hasn't changed since request started
      if (get().searchQuery === query) {
        set({ searchResults: results });
      }
    } catch (err) {
      console.error('Failed to search sessions:', err);
    }
  },

  clearSearch: () => {
    set({ searchQuery: '', searchResults: null });
  },

  initialize: async () => {
    const state = get();
    if (state.initialized) return;

    // Load first page of sessions
    await state.loadChatSessions();
    const { chatSessions } = get();

    // Restore tabs from localStorage
    let restoredTabs: string[] = [];
    try {
      const raw = localStorage.getItem(TABS_STORAGE_KEY);
      if (raw) restoredTabs = JSON.parse(raw);
    } catch {}

    // Restore last active session
    let lastActive = '';
    try {
      lastActive = localStorage.getItem(STORAGE_KEY) || '';
    } catch {}

    // Validate restored tabs — only keep those that exist in loaded sessions
    // Note: task/cron tabs won't be in chatSessions, so we keep them unconditionally
    const sessionIds = new Set(chatSessions.map(s => s.id));
    const validTabs = restoredTabs.filter(id =>
      sessionIds.has(id) || id.startsWith('task:') || id.startsWith('cron:'),
    );

    // If last active session still exists, use it
    if (lastActive && (sessionIds.has(lastActive) || lastActive.startsWith('task:') || lastActive.startsWith('cron:'))) {
      if (!validTabs.includes(lastActive)) validTabs.push(lastActive);
      set({ activeSessionId: lastActive, openTabIds: validTabs, initialized: true });
    } else if (chatSessions.length > 0) {
      // Use most recent session
      const mostRecent = chatSessions[0].id;
      if (!validTabs.includes(mostRecent)) validTabs.push(mostRecent);
      set({ activeSessionId: mostRecent, openTabIds: validTabs, initialized: true });
    } else {
      // No sessions exist — create one
      await get().createNewChat();
      set({ initialized: true });
      return;
    }

    get()._persistActive();
    get()._persistTabs();
  },

  createNewChat: async () => {
    try {
      const session = await createSession('New Chat');
      const { openTabIds } = get();
      set({
        chatSessions: [session, ...get().chatSessions],
        activeSessionId: session.id,
        openTabIds: [...openTabIds, session.id],
      });
      get()._persistActive();
      get()._persistTabs();
      return session.id;
    } catch (err) {
      console.error('Failed to create new chat:', err);
      return '';
    }
  },

  switchToSession: (id: string) => {
    const { openTabIds } = get();
    const newTabs = openTabIds.includes(id) ? openTabIds : [...openTabIds, id];
    set({ activeSessionId: id, openTabIds: newTabs });
    get()._persistActive();
    get()._persistTabs();
  },

  closeTab: async (id: string) => {
    const { openTabIds, activeSessionId } = get();
    const newTabs = openTabIds.filter(t => t !== id);

    if (newTabs.length === 0) {
      // Last tab closed — create new session
      await get().createNewChat();
      return;
    }

    if (activeSessionId === id) {
      // Switch to adjacent tab
      const idx = openTabIds.indexOf(id);
      const nextIdx = Math.min(idx, newTabs.length - 1);
      set({ openTabIds: newTabs, activeSessionId: newTabs[nextIdx] });
    } else {
      set({ openTabIds: newTabs });
    }
    get()._persistActive();
    get()._persistTabs();
  },

  deleteSession: async (id: string) => {
    try {
      await apiDeleteSession(id);
      const { chatSessions, openTabIds, activeSessionId } = get();
      const newSessions = chatSessions.filter(s => s.id !== id);
      const newTabs = openTabIds.filter(t => t !== id);

      if (activeSessionId === id) {
        if (newTabs.length === 0) {
          set({ chatSessions: newSessions, openTabIds: [], activeSessionId: '' });
          await get().createNewChat();
        } else {
          const idx = openTabIds.indexOf(id);
          const nextIdx = Math.min(idx, newTabs.length - 1);
          set({ chatSessions: newSessions, openTabIds: newTabs, activeSessionId: newTabs[nextIdx] });
        }
      } else {
        set({ chatSessions: newSessions, openTabIds: newTabs });
      }
      get()._persistActive();
      get()._persistTabs();
    } catch (err) {
      console.error('Failed to delete session:', err);
    }
  },

  renameSession: async (id: string, name: string) => {
    try {
      await apiRenameSession(id, name);
      set({
        chatSessions: get().chatSessions.map(s =>
          s.id === id ? { ...s, name } : s,
        ),
      });
    } catch (err) {
      console.error('Failed to rename session:', err);
    }
  },

  refreshSessions: async () => {
    await get().loadChatSessions();
  },

  addTab: (id: string) => {
    const { openTabIds } = get();
    if (!openTabIds.includes(id)) {
      set({ openTabIds: [...openTabIds, id] });
      get()._persistTabs();
    }
  },

  hasTab: (id: string) => {
    return get().openTabIds.includes(id);
  },
}));
