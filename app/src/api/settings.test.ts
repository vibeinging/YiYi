import { describe, it, expect } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import {
  listModels,
  setModel,
  getCurrentModel,
  type ModelInfo,
} from "./settings";

const invokeMock = invoke as unknown as Mock;

describe("settings api", () => {
  const sampleModels: ModelInfo[] = [
    { id: "gpt-4", name: "GPT-4", provider: "openai", type: "chat" },
    { id: "claude-4.7", name: "Claude 4.7", provider: "anthropic" },
  ];

  describe("listModels", () => {
    it("invokes list_models and returns the ModelInfo array", async () => {
      mockInvoke({ list_models: () => sampleModels });
      const result = await listModels();
      expect(result).toEqual(sampleModels);
      expect(invokeMock).toHaveBeenCalledWith("list_models");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        list_models: () => {
          throw new Error("db offline");
        },
      });
      await expect(listModels()).rejects.toThrow("db offline");
    });
  });

  describe("setModel", () => {
    it("invokes set_model with { modelName } and returns the status payload", async () => {
      const payload = { status: "ok", model: "gpt-4" };
      mockInvoke({ set_model: () => payload });
      const result = await setModel("gpt-4");
      expect(result).toEqual(payload);
      expect(invokeMock).toHaveBeenCalledWith("set_model", {
        modelName: "gpt-4",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        set_model: () => {
          throw new Error("unknown model");
        },
      });
      await expect(setModel("nope")).rejects.toThrow("unknown model");
    });
  });

  describe("getCurrentModel", () => {
    it("invokes get_current_model and returns the model string", async () => {
      mockInvoke({
        get_current_model: () => ({ status: "ok", model: "gpt-4" }),
      });
      const result = await getCurrentModel();
      expect(result).toBe("gpt-4");
      expect(invokeMock).toHaveBeenCalledWith("get_current_model");
    });

    it("returns empty string when model field is missing", async () => {
      mockInvoke({ get_current_model: () => ({ status: "ok" }) });
      const result = await getCurrentModel();
      expect(result).toBe("");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        get_current_model: () => {
          throw new Error("not configured");
        },
      });
      await expect(getCurrentModel()).rejects.toThrow("not configured");
    });
  });
});
