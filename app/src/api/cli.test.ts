import { describe, it, expect } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import {
  listCliProviders,
  saveCliProviderConfig,
  checkCliProvider,
  installCliProvider,
  deleteCliProvider,
  type CliProviderInfo,
  type CliProviderConfig,
} from "./cli";

const invokeMock = invoke as unknown as Mock;

describe("cli api", () => {
  const sampleInfo: CliProviderInfo = {
    key: "claude",
    enabled: true,
    binary: "claude",
    install_command: "npm i -g @anthropic-ai/claude-code",
    auth_command: "claude login",
    check_command: "claude --version",
    credentials: { token: "xxx" },
    auth_status: "ok",
    installed: true,
  };

  const sampleConfig: CliProviderConfig = {
    enabled: true,
    binary: "claude",
    install_command: "npm i -g @anthropic-ai/claude-code",
    auth_command: "claude login",
    check_command: "claude --version",
    credentials: { token: "xxx" },
    auth_status: "ok",
  };

  describe("listCliProviders", () => {
    it("invokes list_cli_providers and returns the provider array", async () => {
      mockInvoke({ list_cli_providers: () => [sampleInfo] });
      const result = await listCliProviders();
      expect(result).toEqual([sampleInfo]);
      expect(invokeMock).toHaveBeenCalledWith("list_cli_providers");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        list_cli_providers: () => {
          throw new Error("db offline");
        },
      });
      await expect(listCliProviders()).rejects.toThrow("db offline");
    });
  });

  describe("saveCliProviderConfig", () => {
    it("invokes save_cli_provider_config with { key, config } and returns CliProviderInfo", async () => {
      mockInvoke({ save_cli_provider_config: () => sampleInfo });
      const result = await saveCliProviderConfig("claude", sampleConfig);
      expect(result).toEqual(sampleInfo);
      expect(invokeMock).toHaveBeenCalledWith("save_cli_provider_config", {
        key: "claude",
        config: sampleConfig,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        save_cli_provider_config: () => {
          throw new Error("readonly");
        },
      });
      await expect(
        saveCliProviderConfig("claude", sampleConfig),
      ).rejects.toThrow("readonly");
    });
  });

  describe("checkCliProvider", () => {
    it("invokes check_cli_provider with { key } and returns CliProviderInfo", async () => {
      mockInvoke({ check_cli_provider: () => sampleInfo });
      const result = await checkCliProvider("claude");
      expect(result).toEqual(sampleInfo);
      expect(invokeMock).toHaveBeenCalledWith("check_cli_provider", {
        key: "claude",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        check_cli_provider: () => {
          throw new Error("not installed");
        },
      });
      await expect(checkCliProvider("claude")).rejects.toThrow(
        "not installed",
      );
    });
  });

  describe("installCliProvider", () => {
    it("invokes install_cli_provider with { key } and returns the install output", async () => {
      mockInvoke({ install_cli_provider: () => "installed" });
      const result = await installCliProvider("claude");
      expect(result).toBe("installed");
      expect(invokeMock).toHaveBeenCalledWith("install_cli_provider", {
        key: "claude",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        install_cli_provider: () => {
          throw new Error("network down");
        },
      });
      await expect(installCliProvider("claude")).rejects.toThrow(
        "network down",
      );
    });
  });

  describe("deleteCliProvider", () => {
    it("invokes delete_cli_provider with { key }", async () => {
      mockInvoke({ delete_cli_provider: () => undefined });
      await deleteCliProvider("claude");
      expect(invokeMock).toHaveBeenCalledWith("delete_cli_provider", {
        key: "claude",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        delete_cli_provider: () => {
          throw new Error("not found");
        },
      });
      await expect(deleteCliProvider("ghost")).rejects.toThrow("not found");
    });
  });
});
