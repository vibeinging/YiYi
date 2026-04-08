/**
 * sessionStore — Centralized chat session state management.
 * Supports pagination (lazy loading) and search.
 * Tab bar removed — all navigation via sidebar.
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
const PAGE_SIZE = 30;

interface SessionState {
  chatSessions: ChatSession[];
  activeSessionId: string;
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
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, name: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
  initialize: () => Promise<void>;

  // Internal
  _persistActive: () => void;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  chatSessions: [],
  activeSessionId: '',
  initialized: false,
  hasMore: true,
  loadingMore: false,
  searchQuery: '',
  searchResults: null,

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

    // Restore last active session
    let lastActive = '';
    try {
      lastActive = localStorage.getItem(STORAGE_KEY) || '';
    } catch {}

    const sessionIds = new Set(chatSessions.map(s => s.id));

    // If last active session still exists, use it
    if (lastActive && sessionIds.has(lastActive)) {
      set({ activeSessionId: lastActive, initialized: true });
    } else if (chatSessions.length > 0) {
      // Use most recent session
      set({ activeSessionId: chatSessions[0].id, initialized: true });
    } else {
      // No sessions exist — create one
      await get().createNewChat();
      set({ initialized: true });
      return;
    }

    get()._persistActive();
  },

  createNewChat: async () => {
    try {
      const session = await createSession('New Chat');
      set({
        chatSessions: [session, ...get().chatSessions],
        activeSessionId: session.id,
      });
      get()._persistActive();
      return session.id;
    } catch (err) {
      console.error('Failed to create new chat:', err);
      return '';
    }
  },

  switchToSession: (id: string) => {
    set({ activeSessionId: id });
    get()._persistActive();
  },

  deleteSession: async (id: string) => {
    try {
      await apiDeleteSession(id);
      const { chatSessions, activeSessionId } = get();
      const newSessions = chatSessions.filter(s => s.id !== id);

      if (activeSessionId === id) {
        if (newSessions.length > 0) {
          // Switch to most recent remaining session
          set({ chatSessions: newSessions, activeSessionId: newSessions[0].id });
        } else {
          // No sessions left — create a new one
          set({ chatSessions: [], activeSessionId: '' });
          await get().createNewChat();
          return;
        }
      } else {
        set({ chatSessions: newSessions });
      }
      get()._persistActive();
    } catch (err) {
      console.error('Failed to delete session:', err);
      // Surface error so user knows something went wrong
      alert(`删除失败: ${err}`);
    }
  },

  renameSession: async (id: string, name: string) => {
    try {
      await apiRenameSession(id, name);
      set({
        chatSessions: get().chatSessions.map(s =>
          s.id === id ? { ...s, name } : s
        ),
      });
    } catch (err) {
      console.error('Failed to rename session:', err);
    }
  },

  refreshSessions: async () => {
    await get().loadChatSessions();
  },
}));
