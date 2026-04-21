import { describe, it, expect } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import { listEnvs, saveEnvs, deleteEnv, type EnvVar } from "./env";

const invokeMock = invoke as unknown as Mock;

describe("env api", () => {
  const sampleEnvs: EnvVar[] = [
    { key: "OPENAI_KEY", value: "sk-xxx", description: "LLM" },
    { key: "DEBUG", value: "1" },
  ];

  describe("listEnvs", () => {
    it("invokes list_envs and returns the EnvVar array", async () => {
      mockInvoke({ list_envs: () => sampleEnvs });
      const result = await listEnvs();
      expect(result).toEqual(sampleEnvs);
      expect(invokeMock).toHaveBeenCalledWith("list_envs");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        list_envs: () => {
          throw new Error("db offline");
        },
      });
      await expect(listEnvs()).rejects.toThrow("db offline");
    });
  });

  describe("saveEnvs", () => {
    it("invokes save_envs with { envs }", async () => {
      mockInvoke({ save_envs: () => undefined });
      await saveEnvs(sampleEnvs);
      expect(invokeMock).toHaveBeenCalledWith("save_envs", {
        envs: sampleEnvs,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        save_envs: () => {
          throw new Error("readonly");
        },
      });
      await expect(saveEnvs(sampleEnvs)).rejects.toThrow("readonly");
    });
  });

  describe("deleteEnv", () => {
    it("invokes delete_env with { key }", async () => {
      mockInvoke({ delete_env: () => undefined });
      await deleteEnv("OPENAI_KEY");
      expect(invokeMock).toHaveBeenCalledWith("delete_env", {
        key: "OPENAI_KEY",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        delete_env: () => {
          throw new Error("not found");
        },
      });
      await expect(deleteEnv("MISSING")).rejects.toThrow("not found");
    });
  });
});
