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
import { toast } from '../components/Toast';

const STORAGE_KEY = 'yiyi_last_active_session';
const PAGE_SIZE = 30;

interface SessionState {
  chatSessions: ChatSession[];
  activeSessionId: string;
  /** 草稿私聊好友:点好友落到空会话「草稿台」时标记,发首条消息才落库归属。null = 无草稿。 */
  draftCompanionId: number | null;
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
  /** 进「纯草稿态」:无会话(activeSessionId='')+ 标记草稿好友。点好友未发消息时用。 */
  enterDraftCompanion: (companionId: number) => void;
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
  draftCompanionId: null,
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
    // Guard against React StrictMode double-invocation: reuse the in-flight promise
    if ((state as any)._initPromise) return (state as any)._initPromise;
    const promise = (async () => {

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
      // 没有任何会话 → 停在空草稿态(activeSessionId=''=YiYi 欢迎页),不预建 New Chat。
      // 发首条消息时(Chat.handleSend)才建会话 —— 列表只留真正聊过的。
      set({ activeSessionId: '', initialized: true });
      return;
    }

    get()._persistActive();
    })();
    set({ _initPromise: promise } as any);
    try { await promise; } finally { set({ _initPromise: null } as any); }
  },

  createNewChat: async () => {
    try {
      // If the current active session is still an empty "New Chat", reuse it instead of creating another.
      const { activeSessionId, chatSessions } = get();
      const current = chatSessions.find(s => s.id === activeSessionId);
      if (current && current.name === 'New Chat') {
        // Persist on the reused path too so localStorage stays symmetric with
        // the create-fresh branch below. 清草稿:复用空会话即"开始新对话"语义。
        set({ draftCompanionId: null });
        get()._persistActive();
        return current.id;
      }
      const session = await createSession('New Chat');
      set({
        chatSessions: [session, ...get().chatSessions],
        activeSessionId: session.id,
        draftCompanionId: null,
      });
      get()._persistActive();
      return session.id;
    } catch (err) {
      console.error('Failed to create new chat:', err);
      return '';
    }
  },

  switchToSession: (id: string) => {
    // R5(防幽灵会话):work 会话(id 以 work- 开头)不属于 chat 表面 —— 任何入口
    // (通知跳转/搜索/Work 页选中)切到它,都同步 Work 页选中态并把导航指到工作页。
    // chat 列表(只含 source='chat')里没有它,留在 chat 页会进「我在哪」精神分裂态。
    if (id.startsWith('work-')) {
      import('../stores/workStore').then(({ useWorkStore }) => {
        useWorkStore.getState().setSelectedSessionId(id);
      });
      window.dispatchEvent(new CustomEvent('navigate', { detail: 'work' }));
      // activeSessionId 仍要设:Work 页右栏的嵌入会话当前由它驱动。
      // 不持久化(localStorage 留给 chat 会话,重启回到 chat 侧)。
      set({ activeSessionId: id, draftCompanionId: null });
      return;
    }
    // 切到真会话 → 草稿作废(草稿好友只对空草稿台有效)。
    set({ activeSessionId: id, draftCompanionId: null });
    get()._persistActive();
  },

  enterDraftCompanion: (companionId: number) =>
    set({ activeSessionId: '', draftCompanionId: companionId }),

  deleteSession: async (id: string) => {
    try {
      await apiDeleteSession(id);
      const { chatSessions, activeSessionId, searchResults } = get();
      const newSessions = chatSessions.filter(s => s.id !== id);
      // 搜索态同步剔除:侧边栏在搜索时渲染 searchResults —— 只过滤 chatSessions 的话,
      // 删除明明成功了,搜索列表里它还杵着,看起来就是「点删除没反应」。
      const newSearch = searchResults ? searchResults.filter(s => s.id !== id) : null;

      if (activeSessionId === id) {
        if (newSessions.length > 0) {
          // Switch to most recent remaining session
          set({ chatSessions: newSessions, searchResults: newSearch, activeSessionId: newSessions[0].id });
        } else {
          // 删光了 → 落到空草稿态(不自动补 New Chat)。发消息才建,列表保持空。
          set({ chatSessions: [], searchResults: newSearch, activeSessionId: '', draftCompanionId: null });
        }
      } else {
        set({ chatSessions: newSessions, searchResults: newSearch });
      }
      get()._persistActive();
    } catch (err) {
      console.error('Failed to delete session:', err);
      // Surface error via the global toast (imperative API, safe outside React).
      // Falls back to a no-op if the ToastProvider hasn't mounted yet.
      toast.error(`删除失败: ${err}`);
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
