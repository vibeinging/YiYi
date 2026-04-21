import { describe, it, expect } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import {
  listPlugins,
  enablePlugin,
  disablePlugin,
  reloadPlugins,
  type PluginInfo,
} from "./plugins";

const invokeMock = invoke as unknown as Mock;

describe("plugins api", () => {
  const samplePlugins: PluginInfo[] = [
    {
      id: "p1",
      name: "Plugin One",
      version: "1.0.0",
      description: "first",
      enabled: true,
      tool_count: 3,
      has_hooks: false,
    },
  ];

  describe("listPlugins", () => {
    it("invokes list_plugins and returns the plugin array", async () => {
      mockInvoke({ list_plugins: () => samplePlugins });
      const result = await listPlugins();
      expect(result).toEqual(samplePlugins);
      expect(invokeMock).toHaveBeenCalledWith("list_plugins");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        list_plugins: () => {
          throw new Error("plugin dir missing");
        },
      });
      await expect(listPlugins()).rejects.toThrow("plugin dir missing");
    });
  });

  describe("enablePlugin", () => {
    it("invokes enable_plugin with { id }", async () => {
      mockInvoke({ enable_plugin: () => undefined });
      await enablePlugin("p1");
      expect(invokeMock).toHaveBeenCalledWith("enable_plugin", { id: "p1" });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        enable_plugin: () => {
          throw new Error("not found");
        },
      });
      await expect(enablePlugin("missing")).rejects.toThrow("not found");
    });
  });

  describe("disablePlugin", () => {
    it("invokes disable_plugin with { id }", async () => {
      mockInvoke({ disable_plugin: () => undefined });
      await disablePlugin("p1");
      expect(invokeMock).toHaveBeenCalledWith("disable_plugin", { id: "p1" });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        disable_plugin: () => {
          throw new Error("locked");
        },
      });
      await expect(disablePlugin("p1")).rejects.toThrow("locked");
    });
  });

  describe("reloadPlugins", () => {
    it("invokes reload_plugins and returns the reloaded count", async () => {
      mockInvoke({ reload_plugins: () => 5 });
      const result = await reloadPlugins();
      expect(result).toBe(5);
      expect(invokeMock).toHaveBeenCalledWith("reload_plugins");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        reload_plugins: () => {
          throw new Error("io error");
        },
      });
      await expect(reloadPlugins()).rejects.toThrow("io error");
    });
  });
});
