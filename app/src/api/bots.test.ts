import { describe, it, expect } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import {
  listBots,
  listPlatforms,
  getBot,
  createBot,
  updateBot,
  deleteBot,
  sendToBot,
  startBots,
  stopBots,
  startOneBot,
  stopOneBot,
  listBotSessions,
  listBotConversations,
  updateBotConversationTrigger,
  linkBotConversation,
  setConversationAgent,
  deleteBotConversation,
  getBotStatuses,
  type BotInfo,
  type PlatformInfo,
  type BotSession,
  type BotConversationInfo,
  type BotStatusInfo,
  type AgentRouteConfig,
} from "./bots";

const invokeMock = invoke as unknown as Mock;

describe("bots api", () => {
  const sampleBot: BotInfo = {
    id: "bot-1",
    name: "MyBot",
    platform: "discord",
    enabled: true,
    config: { token: "xyz" },
    persona: "helper",
    access: { roles: ["admin"] },
    created_at: 1_700_000_000,
    updated_at: 1_700_000_100,
  };

  const samplePlatform: PlatformInfo = {
    id: "discord",
    name: "Discord",
  };

  const sampleSession: BotSession = {
    id: "sess-1",
    name: "Session",
    created_at: 1_700_000_000,
    updated_at: 1_700_000_100,
    source: "bot:discord",
    source_meta: "{}",
  };

  const sampleConversation: BotConversationInfo = {
    id: "conv-1",
    bot_id: "bot-1",
    bot_name: "MyBot",
    external_id: "ext-1",
    platform: "discord",
    display_name: "chan",
    session_id: "sess-1",
    linked_session_id: null,
    trigger_mode: "mention",
    agent_config_json: null,
    last_message_at: 1_700_000_000,
    message_count: 3,
    created_at: 1_699_000_000,
  };

  const sampleStatus: BotStatusInfo = {
    bot_id: "bot-1",
    state: "connected",
    message: null,
    connected_at: 1_700_000_000,
    last_error: null,
  };

  describe("listBots", () => {
    it("invokes bots_list and returns the bot list", async () => {
      mockInvoke({ bots_list: () => [sampleBot] });
      const result = await listBots();
      expect(result).toEqual([sampleBot]);
      expect(invokeMock).toHaveBeenCalledWith("bots_list");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        bots_list: () => {
          throw new Error("db offline");
        },
      });
      await expect(listBots()).rejects.toThrow("db offline");
    });
  });

  describe("listPlatforms", () => {
    it("invokes bots_list_platforms and returns the platform list", async () => {
      mockInvoke({ bots_list_platforms: () => [samplePlatform] });
      const result = await listPlatforms();
      expect(result).toEqual([samplePlatform]);
      expect(invokeMock).toHaveBeenCalledWith("bots_list_platforms");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        bots_list_platforms: () => {
          throw new Error("registry missing");
        },
      });
      await expect(listPlatforms()).rejects.toThrow("registry missing");
    });
  });

  describe("getBot", () => {
    it("invokes bots_get with { botId } and returns the bot", async () => {
      mockInvoke({ bots_get: () => sampleBot });
      const result = await getBot("bot-1");
      expect(result).toEqual(sampleBot);
      expect(invokeMock).toHaveBeenCalledWith("bots_get", { botId: "bot-1" });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        bots_get: () => {
          throw new Error("not found");
        },
      });
      await expect(getBot("missing")).rejects.toThrow("not found");
    });
  });

  describe("createBot", () => {
    it("invokes bots_create with { name, platform, config, persona, access }", async () => {
      mockInvoke({ bots_create: () => sampleBot });
      const result = await createBot(
        "MyBot",
        "discord",
        { token: "xyz" },
        "helper",
        { roles: ["admin"] },
      );
      expect(result).toEqual(sampleBot);
      expect(invokeMock).toHaveBeenCalledWith("bots_create", {
        name: "MyBot",
        platform: "discord",
        config: { token: "xyz" },
        persona: "helper",
        access: { roles: ["admin"] },
      });
    });

    it("passes undefined for omitted optional persona/access", async () => {
      mockInvoke({ bots_create: () => sampleBot });
      await createBot("MyBot", "telegram", { token: "abc" });
      expect(invokeMock).toHaveBeenCalledWith("bots_create", {
        name: "MyBot",
        platform: "telegram",
        config: { token: "abc" },
        persona: undefined,
        access: undefined,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        bots_create: () => {
          throw new Error("duplicate name");
        },
      });
      await expect(
        createBot("MyBot", "discord", {}),
      ).rejects.toThrow("duplicate name");
    });
  });

  describe("updateBot", () => {
    it("invokes bots_update with { botId, ...updates }", async () => {
      mockInvoke({ bots_update: () => sampleBot });
      const result = await updateBot("bot-1", {
        name: "Renamed",
        enabled: false,
        config: { token: "new" },
        persona: "friendly",
        access: { roles: ["user"] },
      });
      expect(result).toEqual(sampleBot);
      expect(invokeMock).toHaveBeenCalledWith("bots_update", {
        botId: "bot-1",
        name: "Renamed",
        enabled: false,
        config: { token: "new" },
        persona: "friendly",
        access: { roles: ["user"] },
      });
    });

    it("omits missing update fields entirely", async () => {
      mockInvoke({ bots_update: () => sampleBot });
      await updateBot("bot-1", { enabled: true });
      expect(invokeMock).toHaveBeenCalledWith("bots_update", {
        botId: "bot-1",
        enabled: true,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        bots_update: () => {
          throw new Error("invalid config");
        },
      });
      await expect(
        updateBot("bot-1", { enabled: false }),
      ).rejects.toThrow("invalid config");
    });
  });

  describe("deleteBot", () => {
    it("invokes bots_delete with { botId }", async () => {
      mockInvoke({ bots_delete: () => undefined });
      await deleteBot("bot-1");
      expect(invokeMock).toHaveBeenCalledWith("bots_delete", {
        botId: "bot-1",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        bots_delete: () => {
          throw new Error("not found");
        },
      });
      await expect(deleteBot("missing")).rejects.toThrow("not found");
    });
  });

  describe("sendToBot", () => {
    it("invokes bots_send with { botId, target, content }", async () => {
      mockInvoke({ bots_send: () => ({ status: "ok" }) });
      const result = await sendToBot("bot-1", "@chat", "hello");
      expect(result).toEqual({ status: "ok" });
      expect(invokeMock).toHaveBeenCalledWith("bots_send", {
        botId: "bot-1",
        target: "@chat",
        content: "hello",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        bots_send: () => {
          throw new Error("send failed");
        },
      });
      await expect(sendToBot("bot-1", "@chat", "hi")).rejects.toThrow(
        "send failed",
      );
    });
  });

  describe("startBots", () => {
    it("invokes bots_start and returns { status, bots }", async () => {
      mockInvoke({
        bots_start: () => ({ status: "ok", bots: ["bot-1"] }),
      });
      const result = await startBots();
      expect(result).toEqual({ status: "ok", bots: ["bot-1"] });
      expect(invokeMock).toHaveBeenCalledWith("bots_start");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        bots_start: () => {
          throw new Error("already running");
        },
      });
      await expect(startBots()).rejects.toThrow("already running");
    });
  });

  describe("stopBots", () => {
    it("invokes bots_stop and returns { status }", async () => {
      mockInvoke({ bots_stop: () => ({ status: "ok" }) });
      const result = await stopBots();
      expect(result).toEqual({ status: "ok" });
      expect(invokeMock).toHaveBeenCalledWith("bots_stop");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        bots_stop: () => {
          throw new Error("not running");
        },
      });
      await expect(stopBots()).rejects.toThrow("not running");
    });
  });

  describe("startOneBot", () => {
    it("invokes bots_start_one with { botId } and returns { status, bot_id }", async () => {
      mockInvoke({
        bots_start_one: () => ({ status: "ok", bot_id: "bot-1" }),
      });
      const result = await startOneBot("bot-1");
      expect(result).toEqual({ status: "ok", bot_id: "bot-1" });
      expect(invokeMock).toHaveBeenCalledWith("bots_start_one", {
        botId: "bot-1",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        bots_start_one: () => {
          throw new Error("bot disabled");
        },
      });
      await expect(startOneBot("bot-1")).rejects.toThrow("bot disabled");
    });
  });

  describe("stopOneBot", () => {
    it("invokes bots_stop_one with { botId } and returns { status }", async () => {
      mockInvoke({ bots_stop_one: () => ({ status: "ok" }) });
      const result = await stopOneBot("bot-1");
      expect(result).toEqual({ status: "ok" });
      expect(invokeMock).toHaveBeenCalledWith("bots_stop_one", {
        botId: "bot-1",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        bots_stop_one: () => {
          throw new Error("not running");
        },
      });
      await expect(stopOneBot("bot-1")).rejects.toThrow("not running");
    });
  });

  describe("listBotSessions", () => {
    it("invokes bots_list_sessions and returns the session list", async () => {
      mockInvoke({ bots_list_sessions: () => [sampleSession] });
      const result = await listBotSessions();
      expect(result).toEqual([sampleSession]);
      expect(invokeMock).toHaveBeenCalledWith("bots_list_sessions");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        bots_list_sessions: () => {
          throw new Error("db offline");
        },
      });
      await expect(listBotSessions()).rejects.toThrow("db offline");
    });
  });

  describe("listBotConversations", () => {
    it("invokes bot_conversations_list with { botId } when botId provided", async () => {
      mockInvoke({ bot_conversations_list: () => [sampleConversation] });
      const result = await listBotConversations("bot-1");
      expect(result).toEqual([sampleConversation]);
      expect(invokeMock).toHaveBeenCalledWith("bot_conversations_list", {
        botId: "bot-1",
      });
    });

    it("passes { botId: null } when called without argument", async () => {
      mockInvoke({ bot_conversations_list: () => [] });
      await listBotConversations();
      expect(invokeMock).toHaveBeenCalledWith("bot_conversations_list", {
        botId: null,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        bot_conversations_list: () => {
          throw new Error("db offline");
        },
      });
      await expect(listBotConversations()).rejects.toThrow("db offline");
    });
  });

  describe("updateBotConversationTrigger", () => {
    it("invokes bot_conversation_update_trigger with { conversationId, triggerMode }", async () => {
      mockInvoke({ bot_conversation_update_trigger: () => undefined });
      await updateBotConversationTrigger("conv-1", "all");
      expect(invokeMock).toHaveBeenCalledWith(
        "bot_conversation_update_trigger",
        { conversationId: "conv-1", triggerMode: "all" },
      );
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        bot_conversation_update_trigger: () => {
          throw new Error("not found");
        },
      });
      await expect(
        updateBotConversationTrigger("conv-1", "mention"),
      ).rejects.toThrow("not found");
    });
  });

  describe("linkBotConversation", () => {
    it("invokes bot_conversation_link with { conversationId, linkedSessionId }", async () => {
      mockInvoke({ bot_conversation_link: () => undefined });
      await linkBotConversation("conv-1", "sess-99");
      expect(invokeMock).toHaveBeenCalledWith("bot_conversation_link", {
        conversationId: "conv-1",
        linkedSessionId: "sess-99",
      });
    });

    it("allows null linkedSessionId to unlink", async () => {
      mockInvoke({ bot_conversation_link: () => undefined });
      await linkBotConversation("conv-1", null);
      expect(invokeMock).toHaveBeenCalledWith("bot_conversation_link", {
        conversationId: "conv-1",
        linkedSessionId: null,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        bot_conversation_link: () => {
          throw new Error("not found");
        },
      });
      await expect(
        linkBotConversation("conv-1", "sess-99"),
      ).rejects.toThrow("not found");
    });
  });

  describe("setConversationAgent", () => {
    it("invokes bot_conversation_set_agent with JSON-stringified agentConfig", async () => {
      mockInvoke({ bot_conversation_set_agent: () => undefined });
      const cfg: AgentRouteConfig = {
        agent_id: "agent-1",
        persona: "helpful",
        allowed_tools: ["Read"],
        blocked_tools: [],
        working_dir: "/tmp",
        max_iterations: 5,
      };
      await setConversationAgent("conv-1", cfg);
      expect(invokeMock).toHaveBeenCalledWith(
        "bot_conversation_set_agent",
        {
          conversationId: "conv-1",
          agentConfig: JSON.stringify(cfg),
        },
      );
    });

    it("passes null agentConfig when argument is null", async () => {
      mockInvoke({ bot_conversation_set_agent: () => undefined });
      await setConversationAgent("conv-1", null);
      expect(invokeMock).toHaveBeenCalledWith(
        "bot_conversation_set_agent",
        { conversationId: "conv-1", agentConfig: null },
      );
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        bot_conversation_set_agent: () => {
          throw new Error("invalid config");
        },
      });
      await expect(setConversationAgent("conv-1", null)).rejects.toThrow(
        "invalid config",
      );
    });
  });

  describe("deleteBotConversation", () => {
    it("invokes bot_conversation_delete with { conversationId }", async () => {
      mockInvoke({ bot_conversation_delete: () => undefined });
      await deleteBotConversation("conv-1");
      expect(invokeMock).toHaveBeenCalledWith("bot_conversation_delete", {
        conversationId: "conv-1",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        bot_conversation_delete: () => {
          throw new Error("not found");
        },
      });
      await expect(deleteBotConversation("conv-1")).rejects.toThrow(
        "not found",
      );
    });
  });

  describe("getBotStatuses", () => {
    it("invokes bots_get_status and returns the status list", async () => {
      mockInvoke({ bots_get_status: () => [sampleStatus] });
      const result = await getBotStatuses();
      expect(result).toEqual([sampleStatus]);
      expect(invokeMock).toHaveBeenCalledWith("bots_get_status");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        bots_get_status: () => {
          throw new Error("db offline");
        },
      });
      await expect(getBotStatuses()).rejects.toThrow("db offline");
    });
  });
});
