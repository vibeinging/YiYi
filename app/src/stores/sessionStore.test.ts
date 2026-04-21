import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockInvoke, expectInvokedWith } from "../test-utils/mockTauri";
import { useSessionStore } from "./sessionStore";
import type { ChatSession } from "../api/agent";

// Snapshot pristine state once so every test can reset cleanly.
const PRISTINE = useSessionStore.getState();

const STORAGE_KEY = "yiyi_last_active_session";

function resetStore() {
  useSessionStore.setState({
    ...PRISTINE,
    chatSessions: [],
    searchResults: null,
    // Clear any internal init-promise slot the initialize() action caches.
    _initPromise: null,
  } as any);
}

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "sess-1",
    name: "Session One",
    created_at: 1_000,
    updated_at: 2_000,
    source: "chat",
    source_meta: null,
    ...overrides,
  };
}

describe("sessionStore", () => {
  beforeEach(() => {
    resetStore();
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe("initial state", () => {
    it("starts with empty sessions, no active id, and pagination defaults", () => {
      const s = useSessionStore.getState();
      expect(s.chatSessions).toEqual([]);
      expect(s.activeSessionId).toBe("");
      expect(s.initialized).toBe(false);
      expect(s.hasMore).toBe(true);
      expect(s.loadingMore).toBe(false);
      expect(s.searchQuery).toBe("");
      expect(s.searchResults).toBeNull();
    });

    it("exposes all public actions", () => {
      const s = useSessionStore.getState();
      expect(typeof s.loadChatSessions).toBe("function");
      expect(typeof s.loadMoreSessions).toBe("function");
      expect(typeof s.searchSessions).toBe("function");
      expect(typeof s.clearSearch).toBe("function");
      expect(typeof s.createNewChat).toBe("function");
      expect(typeof s.switchToSession).toBe("function");
      expect(typeof s.deleteSession).toBe("function");
      expect(typeof s.renameSession).toBe("function");
      expect(typeof s.refreshSessions).toBe("function");
      expect(typeof s.initialize).toBe("function");
    });
  });

  describe("loadChatSessions", () => {
    it("invokes list_chat_sessions with page size + offset 0 and stores result", async () => {
      const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];
      mockInvoke({ list_chat_sessions: () => sessions });
      await useSessionStore.getState().loadChatSessions();
      expect(useSessionStore.getState().chatSessions).toEqual(sessions);
      expectInvokedWith("list_chat_sessions", { limit: 30, offset: 0 });
    });

    it("sets hasMore=true when backend returns a full page", async () => {
      const full = Array.from({ length: 30 }, (_, i) =>
        makeSession({ id: `s-${i}` }),
      );
      mockInvoke({ list_chat_sessions: () => full });
      await useSessionStore.getState().loadChatSessions();
      expect(useSessionStore.getState().hasMore).toBe(true);
    });

    it("sets hasMore=false when backend returns a partial page", async () => {
      const partial = [makeSession({ id: "a" })];
      mockInvoke({ list_chat_sessions: () => partial });
      await useSessionStore.getState().loadChatSessions();
      expect(useSessionStore.getState().hasMore).toBe(false);
    });

    it("swallows errors and leaves state unchanged", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      useSessionStore.setState({ chatSessions: [makeSession()] });
      mockInvoke({
        list_chat_sessions: () => {
          throw new Error("db locked");
        },
      });
      await useSessionStore.getState().loadChatSessions();
      expect(useSessionStore.getState().chatSessions).toHaveLength(1);
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });
  });

  describe("loadMoreSessions", () => {
    it("appends next page and toggles loadingMore off", async () => {
      const existing = [makeSession({ id: "a" })];
      useSessionStore.setState({ chatSessions: existing, hasMore: true });
      const more = [makeSession({ id: "b" }), makeSession({ id: "c" })];
      mockInvoke({ list_chat_sessions: () => more });

      await useSessionStore.getState().loadMoreSessions();

      const s = useSessionStore.getState();
      expect(s.chatSessions.map((x) => x.id)).toEqual(["a", "b", "c"]);
      expect(s.loadingMore).toBe(false);
      expect(s.hasMore).toBe(false); // 2 < 30
      expectInvokedWith("list_chat_sessions", { limit: 30, offset: 1 });
    });

    it("sets hasMore=true when a full page is returned", async () => {
      useSessionStore.setState({ chatSessions: [], hasMore: true });
      const page = Array.from({ length: 30 }, (_, i) =>
        makeSession({ id: `p-${i}` }),
      );
      mockInvoke({ list_chat_sessions: () => page });
      await useSessionStore.getState().loadMoreSessions();
      expect(useSessionStore.getState().hasMore).toBe(true);
    });

    it("is a no-op when loadingMore is already true", async () => {
      useSessionStore.setState({ loadingMore: true, hasMore: true });
      // No mock — invoke would throw if called.
      await useSessionStore.getState().loadMoreSessions();
      // Still true (the function returned early; no state change).
      expect(useSessionStore.getState().loadingMore).toBe(true);
    });

    it("is a no-op when hasMore is false", async () => {
      useSessionStore.setState({ hasMore: false });
      await useSessionStore.getState().loadMoreSessions();
      // Should not have invoked anything.
      expect(useSessionStore.getState().chatSessions).toEqual([]);
    });

    it("resets loadingMore to false when backend throws", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      useSessionStore.setState({ chatSessions: [], hasMore: true });
      mockInvoke({
        list_chat_sessions: () => {
          throw new Error("boom");
        },
      });
      await useSessionStore.getState().loadMoreSessions();
      expect(useSessionStore.getState().loadingMore).toBe(false);
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });
  });

  describe("searchSessions / clearSearch", () => {
    it("empty/whitespace query clears searchResults without invoking backend", async () => {
      useSessionStore.setState({ searchResults: [makeSession()] });
      mockInvoke({}); // No search call expected.
      await useSessionStore.getState().searchSessions("   ");
      expect(useSessionStore.getState().searchResults).toBeNull();
      expect(useSessionStore.getState().searchQuery).toBe("   ");
    });

    it("trims query and stores results", async () => {
      const results = [makeSession({ id: "hit" })];
      mockInvoke({ search_chat_sessions: () => results });
      await useSessionStore.getState().searchSessions("  hello  ");
      expectInvokedWith("search_chat_sessions", {
        query: "hello",
        limit: 20,
      });
      expect(useSessionStore.getState().searchResults).toEqual(results);
    });

    it("ignores stale results when a newer query has replaced the state", async () => {
      let resolveFirst: (v: unknown) => void = () => {};
      const firstPending = new Promise((r) => {
        resolveFirst = r;
      });
      mockInvoke({
        search_chat_sessions: (args) => {
          if (args?.query === "first") return firstPending;
          if (args?.query === "second") return [makeSession({ id: "second" })];
          return [];
        },
      });

      const p1 = useSessionStore.getState().searchSessions("first");
      // Immediately start a second search; this updates searchQuery to "second".
      await useSessionStore.getState().searchSessions("second");
      expect(useSessionStore.getState().searchResults).toEqual([
        makeSession({ id: "second" }),
      ]);

      // Now let the first one resolve — its results must NOT overwrite.
      resolveFirst([makeSession({ id: "first" })]);
      await p1;
      expect(useSessionStore.getState().searchResults).toEqual([
        makeSession({ id: "second" }),
      ]);
    });

    it("swallows search errors", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockInvoke({
        search_chat_sessions: () => {
          throw new Error("timeout");
        },
      });
      await useSessionStore.getState().searchSessions("anything");
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });

    it("clearSearch resets both query and results", () => {
      useSessionStore.setState({
        searchQuery: "prior",
        searchResults: [makeSession()],
      });
      useSessionStore.getState().clearSearch();
      const s = useSessionStore.getState();
      expect(s.searchQuery).toBe("");
      expect(s.searchResults).toBeNull();
    });
  });

  describe("createNewChat", () => {
    it("invokes create_session and prepends the new session", async () => {
      const fresh = makeSession({ id: "new", name: "New Chat" });
      mockInvoke({ create_session: () => fresh });

      const id = await useSessionStore.getState().createNewChat();

      expect(id).toBe("new");
      expect(useSessionStore.getState().chatSessions[0]).toEqual(fresh);
      expect(useSessionStore.getState().activeSessionId).toBe("new");
      expectInvokedWith("create_session", { name: "New Chat" });
    });

    it("persists the new active session id to localStorage", async () => {
      mockInvoke({ create_session: () => makeSession({ id: "persisted" }) });
      await useSessionStore.getState().createNewChat();
      expect(localStorage.getItem(STORAGE_KEY)).toBe("persisted");
    });

    it("reuses current session if it's still an empty 'New Chat'", async () => {
      const existing = makeSession({ id: "empty", name: "New Chat" });
      useSessionStore.setState({
        chatSessions: [existing],
        activeSessionId: "empty",
      });
      // No mock — create_session must NOT be invoked.
      mockInvoke({});
      const id = await useSessionStore.getState().createNewChat();
      expect(id).toBe("empty");
      expect(useSessionStore.getState().chatSessions).toHaveLength(1);
    });

    it("returns empty string and does not mutate on backend failure", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockInvoke({
        create_session: () => {
          throw new Error("db locked");
        },
      });
      const id = await useSessionStore.getState().createNewChat();
      expect(id).toBe("");
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });
  });

  describe("switchToSession", () => {
    it("updates activeSessionId and persists to localStorage", () => {
      useSessionStore.getState().switchToSession("target");
      expect(useSessionStore.getState().activeSessionId).toBe("target");
      expect(localStorage.getItem(STORAGE_KEY)).toBe("target");
    });

    it("is a no-op for the store when called with the same id (still writes storage)", () => {
      useSessionStore.getState().switchToSession("x");
      useSessionStore.getState().switchToSession("x");
      expect(useSessionStore.getState().activeSessionId).toBe("x");
      expect(localStorage.getItem(STORAGE_KEY)).toBe("x");
    });

    it("survives when localStorage.setItem throws (guarded by try/catch)", () => {
      const spy = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(() => {
          throw new Error("quota");
        });
      expect(() =>
        useSessionStore.getState().switchToSession("safe"),
      ).not.toThrow();
      expect(useSessionStore.getState().activeSessionId).toBe("safe");
      spy.mockRestore();
    });
  });

  describe("deleteSession", () => {
    it("removes a non-active session and preserves active id", async () => {
      const a = makeSession({ id: "a" });
      const b = makeSession({ id: "b" });
      useSessionStore.setState({
        chatSessions: [a, b],
        activeSessionId: "a",
      });
      mockInvoke({ delete_session: () => undefined });

      await useSessionStore.getState().deleteSession("b");
      const s = useSessionStore.getState();
      expect(s.chatSessions.map((x) => x.id)).toEqual(["a"]);
      expect(s.activeSessionId).toBe("a");
      expectInvokedWith("delete_session", { sessionId: "b" });
    });

    it("deleting the active session switches to the next available", async () => {
      const a = makeSession({ id: "a" });
      const b = makeSession({ id: "b" });
      useSessionStore.setState({
        chatSessions: [a, b],
        activeSessionId: "a",
      });
      mockInvoke({ delete_session: () => undefined });

      await useSessionStore.getState().deleteSession("a");
      const s = useSessionStore.getState();
      expect(s.chatSessions.map((x) => x.id)).toEqual(["b"]);
      expect(s.activeSessionId).toBe("b");
    });

    it("when the last session is deleted, creates a new one", async () => {
      const lone = makeSession({ id: "solo" });
      useSessionStore.setState({
        chatSessions: [lone],
        activeSessionId: "solo",
      });
      const fresh = makeSession({ id: "fresh" });
      mockInvoke({
        delete_session: () => undefined,
        create_session: () => fresh,
      });

      await useSessionStore.getState().deleteSession("solo");
      const s = useSessionStore.getState();
      expect(s.chatSessions).toEqual([fresh]);
      expect(s.activeSessionId).toBe("fresh");
    });

    it("alerts on backend failure and does not mutate sessions list", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
      const a = makeSession({ id: "a" });
      useSessionStore.setState({ chatSessions: [a], activeSessionId: "a" });
      mockInvoke({
        delete_session: () => {
          throw new Error("fk violation");
        },
      });
      await useSessionStore.getState().deleteSession("a");
      expect(useSessionStore.getState().chatSessions).toHaveLength(1);
      expect(alertSpy).toHaveBeenCalled();
      errSpy.mockRestore();
      alertSpy.mockRestore();
    });
  });

  describe("renameSession", () => {
    it("invokes rename_session and updates name in-place", async () => {
      const a = makeSession({ id: "a", name: "Old" });
      const b = makeSession({ id: "b", name: "Other" });
      useSessionStore.setState({ chatSessions: [a, b] });
      mockInvoke({ rename_session: () => undefined });

      await useSessionStore.getState().renameSession("a", "New Name");
      const s = useSessionStore.getState();
      expect(s.chatSessions.find((x) => x.id === "a")?.name).toBe("New Name");
      expect(s.chatSessions.find((x) => x.id === "b")?.name).toBe("Other");
      expectInvokedWith("rename_session", {
        sessionId: "a",
        name: "New Name",
      });
    });

    it("swallows errors and logs to console", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const a = makeSession({ id: "a", name: "Old" });
      useSessionStore.setState({ chatSessions: [a] });
      mockInvoke({
        rename_session: () => {
          throw new Error("fail");
        },
      });
      await useSessionStore.getState().renameSession("a", "Blocked");
      expect(useSessionStore.getState().chatSessions[0].name).toBe("Old");
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });
  });

  describe("refreshSessions", () => {
    it("delegates to loadChatSessions", async () => {
      const fresh = [makeSession({ id: "refreshed" })];
      mockInvoke({ list_chat_sessions: () => fresh });
      await useSessionStore.getState().refreshSessions();
      expect(useSessionStore.getState().chatSessions).toEqual(fresh);
    });
  });

  describe("initialize", () => {
    it("bootstraps: loads sessions, restores last active from localStorage", async () => {
      const a = makeSession({ id: "a" });
      const b = makeSession({ id: "b" });
      localStorage.setItem(STORAGE_KEY, "b");
      mockInvoke({ list_chat_sessions: () => [a, b] });

      await useSessionStore.getState().initialize();
      const s = useSessionStore.getState();
      expect(s.initialized).toBe(true);
      expect(s.activeSessionId).toBe("b");
      expect(s.chatSessions).toEqual([a, b]);
    });

    it("falls back to most recent session when stored id is missing", async () => {
      localStorage.setItem(STORAGE_KEY, "ghost");
      const a = makeSession({ id: "a" });
      const b = makeSession({ id: "b" });
      mockInvoke({ list_chat_sessions: () => [a, b] });

      await useSessionStore.getState().initialize();
      expect(useSessionStore.getState().activeSessionId).toBe("a");
    });

    it("creates a new chat when no sessions exist at all", async () => {
      const fresh = makeSession({ id: "new-id" });
      mockInvoke({
        list_chat_sessions: () => [],
        create_session: () => fresh,
      });
      await useSessionStore.getState().initialize();
      const s = useSessionStore.getState();
      expect(s.initialized).toBe(true);
      expect(s.chatSessions).toEqual([fresh]);
      expect(s.activeSessionId).toBe("new-id");
    });

    it("is idempotent: a second call short-circuits on initialized=true", async () => {
      const a = makeSession({ id: "a" });
      let listCallCount = 0;
      mockInvoke({
        list_chat_sessions: () => {
          listCallCount += 1;
          return [a];
        },
      });
      await useSessionStore.getState().initialize();
      await useSessionStore.getState().initialize();
      expect(listCallCount).toBe(1);
    });

    it("reuses the in-flight promise under concurrent invocation (StrictMode guard)", async () => {
      // Delay the invoke so both calls enter while the first is pending.
      let resolveList: (v: unknown) => void = () => {};
      const pending = new Promise<ChatSession[]>((r) => {
        resolveList = r as any;
      });
      let listCallCount = 0;
      mockInvoke({
        list_chat_sessions: () => {
          listCallCount += 1;
          return pending;
        },
      });

      const p1 = useSessionStore.getState().initialize();
      const p2 = useSessionStore.getState().initialize();

      resolveList([makeSession({ id: "shared" })]);
      await Promise.all([p1, p2]);
      // Only one backend fetch should have happened.
      expect(listCallCount).toBe(1);
      expect(useSessionStore.getState().activeSessionId).toBe("shared");
    });
  });

  describe("_persistActive", () => {
    it("writes the current activeSessionId to localStorage", () => {
      useSessionStore.setState({ activeSessionId: "persist-me" });
      useSessionStore.getState()._persistActive();
      expect(localStorage.getItem(STORAGE_KEY)).toBe("persist-me");
    });

    it("tolerates localStorage errors silently", () => {
      const spy = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(() => {
          throw new Error("quota");
        });
      useSessionStore.setState({ activeSessionId: "x" });
      expect(() =>
        useSessionStore.getState()._persistActive(),
      ).not.toThrow();
      spy.mockRestore();
    });
  });
});
