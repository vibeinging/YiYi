import { describe, it, expect } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import {
  listChannels,
  getChannel,
  updateChannel,
  sendToChannel,
  sendToSession,
  startChannels,
  stopChannels,
  listActiveSessions,
  type ChannelInfo,
  type ChannelMessage,
} from "./channels";

const invokeMock = invoke as unknown as Mock;

describe("channels api", () => {
  const sampleChannel: ChannelInfo = {
    id: "telegram",
    name: "telegram",
    channel_type: "telegram",
    enabled: true,
    status: "running",
  };

  const sampleMessage: ChannelMessage = {
    channel_type: "telegram",
    session_id: "sess-1",
    user_id: "u1",
    username: "alice",
    content: "hello",
    timestamp: 1_700_000_000,
  };

  describe("listChannels", () => {
    it("invokes channels_list and returns the channel list", async () => {
      mockInvoke({ channels_list: () => [sampleChannel] });
      const result = await listChannels();
      expect(result).toEqual([sampleChannel]);
      expect(invokeMock).toHaveBeenCalledWith("channels_list");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        channels_list: () => {
          throw new Error("db offline");
        },
      });
      await expect(listChannels()).rejects.toThrow("db offline");
    });
  });

  describe("getChannel", () => {
    it("invokes channels_get with { channelName }", async () => {
      mockInvoke({ channels_get: () => sampleChannel });
      const result = await getChannel("telegram");
      expect(result).toEqual(sampleChannel);
      expect(invokeMock).toHaveBeenCalledWith("channels_get", {
        channelName: "telegram",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        channels_get: () => {
          throw new Error("not found");
        },
      });
      await expect(getChannel("missing")).rejects.toThrow("not found");
    });
  });

  describe("updateChannel", () => {
    it("invokes channels_update with { channelName, enabled, botPrefix }", async () => {
      mockInvoke({ channels_update: () => ({ status: "ok" }) });
      const result = await updateChannel("telegram", true, "/bot");
      expect(result).toEqual({ status: "ok" });
      expect(invokeMock).toHaveBeenCalledWith("channels_update", {
        channelName: "telegram",
        enabled: true,
        botPrefix: "/bot",
      });
    });

    it("passes undefined for omitted optional args", async () => {
      mockInvoke({ channels_update: () => ({ status: "ok" }) });
      await updateChannel("telegram");
      expect(invokeMock).toHaveBeenCalledWith("channels_update", {
        channelName: "telegram",
        enabled: undefined,
        botPrefix: undefined,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        channels_update: () => {
          throw new Error("invalid config");
        },
      });
      await expect(updateChannel("telegram", true)).rejects.toThrow(
        "invalid config",
      );
    });
  });

  describe("sendToChannel", () => {
    it("invokes channels_send with { channelType, target, content }", async () => {
      mockInvoke({ channels_send: () => ({ status: "ok" }) });
      const result = await sendToChannel("telegram", "@chat", "hello");
      expect(result).toEqual({ status: "ok" });
      expect(invokeMock).toHaveBeenCalledWith("channels_send", {
        channelType: "telegram",
        target: "@chat",
        content: "hello",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        channels_send: () => {
          throw new Error("send failed");
        },
      });
      await expect(
        sendToChannel("telegram", "@chat", "hi"),
      ).rejects.toThrow("send failed");
    });
  });

  describe("sendToSession", () => {
    it("invokes channels_send_to_session with { sessionId, content }", async () => {
      mockInvoke({
        channels_send_to_session: () => ({ status: "ok" }),
      });
      const result = await sendToSession("sess-1", "hi");
      expect(result).toEqual({ status: "ok" });
      expect(invokeMock).toHaveBeenCalledWith("channels_send_to_session", {
        sessionId: "sess-1",
        content: "hi",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        channels_send_to_session: () => {
          throw new Error("session closed");
        },
      });
      await expect(sendToSession("sess-1", "hi")).rejects.toThrow(
        "session closed",
      );
    });
  });

  describe("startChannels", () => {
    it("invokes channels_start and returns { status, channels }", async () => {
      mockInvoke({
        channels_start: () => ({ status: "ok", channels: ["telegram"] }),
      });
      const result = await startChannels();
      expect(result).toEqual({ status: "ok", channels: ["telegram"] });
      expect(invokeMock).toHaveBeenCalledWith("channels_start");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        channels_start: () => {
          throw new Error("already running");
        },
      });
      await expect(startChannels()).rejects.toThrow("already running");
    });
  });

  describe("stopChannels", () => {
    it("invokes channels_stop and returns { status }", async () => {
      mockInvoke({ channels_stop: () => ({ status: "ok" }) });
      const result = await stopChannels();
      expect(result).toEqual({ status: "ok" });
      expect(invokeMock).toHaveBeenCalledWith("channels_stop");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        channels_stop: () => {
          throw new Error("not running");
        },
      });
      await expect(stopChannels()).rejects.toThrow("not running");
    });
  });

  describe("listActiveSessions", () => {
    it("invokes channels_list_sessions and returns the session list", async () => {
      mockInvoke({ channels_list_sessions: () => [sampleMessage] });
      const result = await listActiveSessions();
      expect(result).toEqual([sampleMessage]);
      expect(invokeMock).toHaveBeenCalledWith("channels_list_sessions");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        channels_list_sessions: () => {
          throw new Error("db offline");
        },
      });
      await expect(listActiveSessions()).rejects.toThrow("db offline");
    });
  });
});
