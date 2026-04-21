import { describe, it, expect } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import {
  exportConversations,
  exportMemories,
  exportSettings,
} from "./export";

const invokeMock = invoke as unknown as Mock;

describe("export api", () => {
  describe("exportConversations", () => {
    it("invokes export_conversations with { format, sessionIds } and returns the string", async () => {
      mockInvoke({ export_conversations: () => "# conversation" });
      const result = await exportConversations("markdown", ["s1", "s2"]);
      expect(result).toBe("# conversation");
      expect(invokeMock).toHaveBeenCalledWith("export_conversations", {
        format: "markdown",
        sessionIds: ["s1", "s2"],
      });
    });

    it("passes sessionIds as null when omitted", async () => {
      mockInvoke({ export_conversations: () => "[]" });
      await exportConversations("json");
      expect(invokeMock).toHaveBeenCalledWith("export_conversations", {
        format: "json",
        sessionIds: null,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        export_conversations: () => {
          throw new Error("no sessions");
        },
      });
      await expect(exportConversations("json")).rejects.toThrow("no sessions");
    });
  });

  describe("exportMemories", () => {
    it("invokes export_memories and returns the JSON string", async () => {
      mockInvoke({ export_memories: () => "{\"memories\":[]}" });
      const result = await exportMemories();
      expect(result).toBe("{\"memories\":[]}");
      expect(invokeMock).toHaveBeenCalledWith("export_memories");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        export_memories: () => {
          throw new Error("memme offline");
        },
      });
      await expect(exportMemories()).rejects.toThrow("memme offline");
    });
  });

  describe("exportSettings", () => {
    it("invokes export_settings and returns the JSON string", async () => {
      mockInvoke({ export_settings: () => "{\"theme\":\"dark\"}" });
      const result = await exportSettings();
      expect(result).toBe("{\"theme\":\"dark\"}");
      expect(invokeMock).toHaveBeenCalledWith("export_settings");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        export_settings: () => {
          throw new Error("config missing");
        },
      });
      await expect(exportSettings()).rejects.toThrow("config missing");
    });
  });
});
