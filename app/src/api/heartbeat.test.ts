import { describe, it, expect } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import {
  getHeartbeatConfig,
  saveHeartbeatConfig,
  sendHeartbeat,
  getHeartbeatHistory,
  type HeartbeatConfig,
} from "./heartbeat";

const invokeMock = invoke as unknown as Mock;

describe("heartbeat api", () => {
  const sampleConfig: HeartbeatConfig = {
    enabled: true,
    every: "6h",
    target: "main",
  };

  describe("getHeartbeatConfig", () => {
    it("invokes get_heartbeat_config and returns the config", async () => {
      mockInvoke({ get_heartbeat_config: () => sampleConfig });
      const result = await getHeartbeatConfig();
      expect(result).toEqual(sampleConfig);
      expect(invokeMock).toHaveBeenCalledWith("get_heartbeat_config");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        get_heartbeat_config: () => {
          throw new Error("db offline");
        },
      });
      await expect(getHeartbeatConfig()).rejects.toThrow("db offline");
    });
  });

  describe("saveHeartbeatConfig", () => {
    it("invokes save_heartbeat_config with { config } and echoes the config", async () => {
      mockInvoke({ save_heartbeat_config: (args) => args?.config });
      const result = await saveHeartbeatConfig(sampleConfig);
      expect(result).toEqual(sampleConfig);
      expect(invokeMock).toHaveBeenCalledWith("save_heartbeat_config", {
        config: sampleConfig,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        save_heartbeat_config: () => {
          throw new Error("invalid cron");
        },
      });
      await expect(saveHeartbeatConfig(sampleConfig)).rejects.toThrow("invalid cron");
    });
  });

  describe("sendHeartbeat", () => {
    it("invokes send_heartbeat and returns { success, message }", async () => {
      mockInvoke({
        send_heartbeat: () => ({ success: true, message: "sent" }),
      });
      const result = await sendHeartbeat();
      expect(result).toEqual({ success: true, message: "sent" });
      expect(invokeMock).toHaveBeenCalledWith("send_heartbeat");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        send_heartbeat: () => {
          throw new Error("no llm");
        },
      });
      await expect(sendHeartbeat()).rejects.toThrow("no llm");
    });
  });

  describe("getHeartbeatHistory", () => {
    it("invokes get_heartbeat_history with { limit } and returns the rows", async () => {
      const rows = [
        { timestamp: 1, target: "main", success: true, message: "ok" },
      ];
      mockInvoke({ get_heartbeat_history: () => rows });
      const result = await getHeartbeatHistory(10);
      expect(result).toEqual(rows);
      expect(invokeMock).toHaveBeenCalledWith("get_heartbeat_history", {
        limit: 10,
      });
    });

    it("passes { limit: undefined } when called without argument", async () => {
      mockInvoke({ get_heartbeat_history: () => [] });
      await getHeartbeatHistory();
      expect(invokeMock).toHaveBeenCalledWith("get_heartbeat_history", {
        limit: undefined,
      });
    });
  });
});
