import { describe, it, expect } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import {
  listSessions,
  listChatSessions,
  searchChatSessions,
  createSession,
  ensureSession,
  renameSession,
  deleteSession,
  chat,
  chatStreamStart,
  chatStreamStop,
  onChatChunk,
  onChatComplete,
  onChatError,
  onToolStatus,
  getHistory,
  clearHistory,
  deleteMessage,
  type ChatSession,
  type ChatMessage,
  type Attachment,
} from "./agent";

const invokeMock = invoke as unknown as Mock;
const listenMock = listen as unknown as Mock;

describe("agent api", () => {
  const sampleSession: ChatSession = {
    id: "sess-1",
    name: "My Session",
    created_at: 1_700_000_000,
    updated_at: 1_700_000_100,
    source: "chat",
    source_meta: null,
  };

  const sampleMessage: ChatMessage = {
    id: 42,
    role: "assistant",
    content: "hello",
    timestamp: 1_700_000_000,
  };

  const sampleAttachment: Attachment = {
    mimeType: "image/png",
    data: "base64data",
    name: "pic.png",
  };

  describe("listSessions", () => {
    it("invokes list_sessions and returns the session list", async () => {
      mockInvoke({ list_sessions: () => [sampleSession] });
      const result = await listSessions();
      expect(result).toEqual([sampleSession]);
      expect(invokeMock).toHaveBeenCalledWith("list_sessions");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        list_sessions: () => {
          throw new Error("db offline");
        },
      });
      await expect(listSessions()).rejects.toThrow("db offline");
    });
  });

  describe("listChatSessions", () => {
    it("invokes list_chat_sessions with { limit, offset }", async () => {
      mockInvoke({ list_chat_sessions: () => [sampleSession] });
      const result = await listChatSessions(20, 10);
      expect(result).toEqual([sampleSession]);
      expect(invokeMock).toHaveBeenCalledWith("list_chat_sessions", {
        limit: 20,
        offset: 10,
      });
    });

    it("passes undefined for omitted limit/offset", async () => {
      mockInvoke({ list_chat_sessions: () => [] });
      await listChatSessions();
      expect(invokeMock).toHaveBeenCalledWith("list_chat_sessions", {
        limit: undefined,
        offset: undefined,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        list_chat_sessions: () => {
          throw new Error("db offline");
        },
      });
      await expect(listChatSessions()).rejects.toThrow("db offline");
    });
  });

  describe("searchChatSessions", () => {
    it("invokes search_chat_sessions with { query, limit }", async () => {
      mockInvoke({ search_chat_sessions: () => [sampleSession] });
      const result = await searchChatSessions("hello", 5);
      expect(result).toEqual([sampleSession]);
      expect(invokeMock).toHaveBeenCalledWith("search_chat_sessions", {
        query: "hello",
        limit: 5,
      });
    });

    it("passes undefined for omitted limit", async () => {
      mockInvoke({ search_chat_sessions: () => [] });
      await searchChatSessions("query");
      expect(invokeMock).toHaveBeenCalledWith("search_chat_sessions", {
        query: "query",
        limit: undefined,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        search_chat_sessions: () => {
          throw new Error("fts failure");
        },
      });
      await expect(searchChatSessions("q")).rejects.toThrow("fts failure");
    });
  });

  describe("createSession", () => {
    it("invokes create_session with { name } and returns the session", async () => {
      mockInvoke({ create_session: () => sampleSession });
      const result = await createSession("My Session");
      expect(result).toEqual(sampleSession);
      expect(invokeMock).toHaveBeenCalledWith("create_session", {
        name: "My Session",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        create_session: () => {
          throw new Error("duplicate");
        },
      });
      await expect(createSession("Dup")).rejects.toThrow("duplicate");
    });
  });

  describe("ensureSession", () => {
    it("invokes ensure_session with { id, name, source, sourceMeta }", async () => {
      mockInvoke({ ensure_session: () => sampleSession });
      const result = await ensureSession(
        "sess-1",
        "My Session",
        "chat",
        '{"foo":"bar"}',
      );
      expect(result).toEqual(sampleSession);
      expect(invokeMock).toHaveBeenCalledWith("ensure_session", {
        id: "sess-1",
        name: "My Session",
        source: "chat",
        sourceMeta: '{"foo":"bar"}',
      });
    });

    it("passes undefined for omitted sourceMeta", async () => {
      mockInvoke({ ensure_session: () => sampleSession });
      await ensureSession("sess-1", "n", "chat");
      expect(invokeMock).toHaveBeenCalledWith("ensure_session", {
        id: "sess-1",
        name: "n",
        source: "chat",
        sourceMeta: undefined,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        ensure_session: () => {
          throw new Error("invalid source");
        },
      });
      await expect(ensureSession("x", "y", "z")).rejects.toThrow(
        "invalid source",
      );
    });
  });

  describe("renameSession", () => {
    it("invokes rename_session with { sessionId, name }", async () => {
      mockInvoke({ rename_session: () => undefined });
      await renameSession("sess-1", "New Name");
      expect(invokeMock).toHaveBeenCalledWith("rename_session", {
        sessionId: "sess-1",
        name: "New Name",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        rename_session: () => {
          throw new Error("not found");
        },
      });
      await expect(renameSession("sess-1", "n")).rejects.toThrow("not found");
    });
  });

  describe("deleteSession", () => {
    it("invokes delete_session with { sessionId }", async () => {
      mockInvoke({ delete_session: () => undefined });
      await deleteSession("sess-1");
      expect(invokeMock).toHaveBeenCalledWith("delete_session", {
        sessionId: "sess-1",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        delete_session: () => {
          throw new Error("not found");
        },
      });
      await expect(deleteSession("sess-1")).rejects.toThrow("not found");
    });
  });

  describe("chat", () => {
    it("invokes chat with { message, sessionId, attachments }", async () => {
      mockInvoke({ chat: () => "reply" });
      const result = await chat("hello", "sess-1", [sampleAttachment]);
      expect(result).toBe("reply");
      expect(invokeMock).toHaveBeenCalledWith("chat", {
        message: "hello",
        sessionId: "sess-1",
        attachments: [sampleAttachment],
      });
    });

    it("passes attachments as undefined when array is empty", async () => {
      mockInvoke({ chat: () => "reply" });
      await chat("hello", "sess-1", []);
      expect(invokeMock).toHaveBeenCalledWith("chat", {
        message: "hello",
        sessionId: "sess-1",
        attachments: undefined,
      });
    });

    it("passes undefined for omitted sessionId and attachments", async () => {
      mockInvoke({ chat: () => "reply" });
      await chat("hello");
      expect(invokeMock).toHaveBeenCalledWith("chat", {
        message: "hello",
        sessionId: undefined,
        attachments: undefined,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        chat: () => {
          throw new Error("model offline");
        },
      });
      await expect(chat("hi")).rejects.toThrow("model offline");
    });
  });

  describe("chatStreamStart", () => {
    it("invokes chat_stream_start with { message, sessionId, attachments }", async () => {
      mockInvoke({ chat_stream_start: () => undefined });
      await chatStreamStart("hello", "sess-1", [sampleAttachment]);
      expect(invokeMock).toHaveBeenCalledWith("chat_stream_start", {
        message: "hello",
        sessionId: "sess-1",
        attachments: [sampleAttachment],
      });
    });

    it("passes attachments as undefined when array is empty", async () => {
      mockInvoke({ chat_stream_start: () => undefined });
      await chatStreamStart("hello", "sess-1", []);
      expect(invokeMock).toHaveBeenCalledWith("chat_stream_start", {
        message: "hello",
        sessionId: "sess-1",
        attachments: undefined,
      });
    });

    it("passes undefined for omitted args", async () => {
      mockInvoke({ chat_stream_start: () => undefined });
      await chatStreamStart("hello");
      expect(invokeMock).toHaveBeenCalledWith("chat_stream_start", {
        message: "hello",
        sessionId: undefined,
        attachments: undefined,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        chat_stream_start: () => {
          throw new Error("busy");
        },
      });
      await expect(chatStreamStart("hi")).rejects.toThrow("busy");
    });
  });

  describe("chatStreamStop", () => {
    it("invokes chat_stream_stop", async () => {
      mockInvoke({ chat_stream_stop: () => undefined });
      await chatStreamStop();
      expect(invokeMock).toHaveBeenCalledWith("chat_stream_stop");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        chat_stream_stop: () => {
          throw new Error("not streaming");
        },
      });
      await expect(chatStreamStop()).rejects.toThrow("not streaming");
    });
  });

  describe("onChatChunk", () => {
    it("subscribes to the chat://chunk event channel", async () => {
      await onChatChunk(() => {});
      expect(listenMock).toHaveBeenCalledWith(
        "chat://chunk",
        expect.any(Function),
      );
    });

    it("resolves to an unsubscribe function", async () => {
      const unlisten = await onChatChunk(() => {});
      expect(typeof unlisten).toBe("function");
      expect(() => unlisten()).not.toThrow();
    });
  });

  describe("onChatComplete", () => {
    it("subscribes to the chat://complete event channel", async () => {
      await onChatComplete(() => {});
      expect(listenMock).toHaveBeenCalledWith(
        "chat://complete",
        expect.any(Function),
      );
    });

    it("resolves to an unsubscribe function", async () => {
      const unlisten = await onChatComplete(() => {});
      expect(typeof unlisten).toBe("function");
      expect(() => unlisten()).not.toThrow();
    });
  });

  describe("onChatError", () => {
    it("subscribes to the chat://error event channel", async () => {
      await onChatError(() => {});
      expect(listenMock).toHaveBeenCalledWith(
        "chat://error",
        expect.any(Function),
      );
    });

    it("resolves to an unsubscribe function", async () => {
      const unlisten = await onChatError(() => {});
      expect(typeof unlisten).toBe("function");
      expect(() => unlisten()).not.toThrow();
    });
  });

  describe("onToolStatus", () => {
    it("subscribes to the chat://tool_status event channel", async () => {
      await onToolStatus(() => {});
      expect(listenMock).toHaveBeenCalledWith(
        "chat://tool_status",
        expect.any(Function),
      );
    });

    it("resolves to an unsubscribe function", async () => {
      const unlisten = await onToolStatus(() => {});
      expect(typeof unlisten).toBe("function");
      expect(() => unlisten()).not.toThrow();
    });
  });

  describe("getHistory", () => {
    it("invokes get_history with { sessionId, limit }", async () => {
      mockInvoke({ get_history: () => [sampleMessage] });
      const result = await getHistory("sess-1", 50);
      expect(result).toEqual([sampleMessage]);
      expect(invokeMock).toHaveBeenCalledWith("get_history", {
        sessionId: "sess-1",
        limit: 50,
      });
    });

    it("passes undefined for omitted sessionId and limit", async () => {
      mockInvoke({ get_history: () => [] });
      await getHistory();
      expect(invokeMock).toHaveBeenCalledWith("get_history", {
        sessionId: undefined,
        limit: undefined,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        get_history: () => {
          throw new Error("db offline");
        },
      });
      await expect(getHistory()).rejects.toThrow("db offline");
    });
  });

  describe("clearHistory", () => {
    it("invokes clear_history with { sessionId }", async () => {
      mockInvoke({ clear_history: () => undefined });
      await clearHistory("sess-1");
      expect(invokeMock).toHaveBeenCalledWith("clear_history", {
        sessionId: "sess-1",
      });
    });

    it("passes { sessionId: undefined } when called without argument", async () => {
      mockInvoke({ clear_history: () => undefined });
      await clearHistory();
      expect(invokeMock).toHaveBeenCalledWith("clear_history", {
        sessionId: undefined,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        clear_history: () => {
          throw new Error("db offline");
        },
      });
      await expect(clearHistory()).rejects.toThrow("db offline");
    });
  });

  describe("deleteMessage", () => {
    it("invokes delete_message with { messageId }", async () => {
      mockInvoke({ delete_message: () => undefined });
      await deleteMessage(42);
      expect(invokeMock).toHaveBeenCalledWith("delete_message", {
        messageId: 42,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        delete_message: () => {
          throw new Error("not found");
        },
      });
      await expect(deleteMessage(42)).rejects.toThrow("not found");
    });
  });
});
