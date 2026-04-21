import { describe, it, expect } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import {
  listProviders,
  configureProvider,
  testProvider,
  createCustomProvider,
  deleteCustomProvider,
  addModel,
  removeModel,
  getActiveLlm,
  setActiveLlm,
  listProviderTemplates,
  importProviderPlugin,
  exportProviderConfig,
  scanProviderPlugins,
  importProviderFromTemplate,
  type ProviderInfo,
  type ProviderPlugin,
  type ProviderTemplate,
  type ActiveModelsInfo,
  type ModelInfo,
  type TestConnectionResponse,
} from "./models";

const invokeMock = invoke as unknown as Mock;

describe("models api", () => {
  const rawProvider: ProviderInfo = {
    id: "openai",
    name: "OpenAI",
    default_base_url: "https://api.openai.com/v1",
    api_key_prefix: "sk-",
    models: [{ id: "gpt-5", name: "GPT-5" }],
    extra_models: [],
    is_custom: false,
    is_local: false,
    configured: true,
    base_url: "https://api.openai.com/v1",
    api_key_saved: "sk-***",
  };

  const expectedDisplay = {
    ...rawProvider,
    has_api_key: true,
    needs_base_url: false,
    current_api_key: "",
    current_base_url: "https://api.openai.com/v1",
  };

  describe("listProviders", () => {
    it("invokes list_providers and adapts each ProviderInfo", async () => {
      mockInvoke({ list_providers: () => [rawProvider] });
      const result = await listProviders();
      expect(result).toEqual([expectedDisplay]);
      expect(invokeMock).toHaveBeenCalledWith("list_providers");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        list_providers: () => {
          throw new Error("db offline");
        },
      });
      await expect(listProviders()).rejects.toThrow("db offline");
    });
  });

  describe("configureProvider", () => {
    it("invokes configure_provider with { providerId, apiKey, baseUrl } and returns adapted", async () => {
      mockInvoke({ configure_provider: () => rawProvider });
      const result = await configureProvider("openai", "sk-123", "https://api.openai.com/v1");
      expect(result).toEqual(expectedDisplay);
      expect(invokeMock).toHaveBeenCalledWith("configure_provider", {
        providerId: "openai",
        apiKey: "sk-123",
        baseUrl: "https://api.openai.com/v1",
      });
    });

    it("passes undefined for optional apiKey/baseUrl when omitted", async () => {
      mockInvoke({ configure_provider: () => rawProvider });
      await configureProvider("openai");
      expect(invokeMock).toHaveBeenCalledWith("configure_provider", {
        providerId: "openai",
        apiKey: undefined,
        baseUrl: undefined,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        configure_provider: () => {
          throw new Error("invalid key");
        },
      });
      await expect(configureProvider("openai", "sk-bad")).rejects.toThrow("invalid key");
    });
  });

  describe("testProvider", () => {
    const resp: TestConnectionResponse = { success: true, message: "ok", latency_ms: 42, reply: "hi" };

    it("invokes test_provider with { providerId, apiKey, baseUrl, modelId }", async () => {
      mockInvoke({ test_provider: () => resp });
      const result = await testProvider("openai", "sk-123", "https://x", "gpt-5");
      expect(result).toEqual(resp);
      expect(invokeMock).toHaveBeenCalledWith("test_provider", {
        providerId: "openai",
        apiKey: "sk-123",
        baseUrl: "https://x",
        modelId: "gpt-5",
      });
    });

    it("passes undefined for all optional args when omitted", async () => {
      mockInvoke({ test_provider: () => resp });
      await testProvider("openai");
      expect(invokeMock).toHaveBeenCalledWith("test_provider", {
        providerId: "openai",
        apiKey: undefined,
        baseUrl: undefined,
        modelId: undefined,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        test_provider: () => {
          throw new Error("401");
        },
      });
      await expect(testProvider("openai")).rejects.toThrow("401");
    });
  });

  describe("createCustomProvider", () => {
    it("invokes create_custom_provider with { id, name, defaultBaseUrl, apiKeyPrefix, models } and adapts", async () => {
      mockInvoke({ create_custom_provider: () => rawProvider });
      const models: ModelInfo[] = [{ id: "gpt-5", name: "GPT-5" }];
      const result = await createCustomProvider(
        "my-custom",
        "My Custom",
        "https://api.custom.com",
        "mc-",
        models,
      );
      expect(result).toEqual(expectedDisplay);
      expect(invokeMock).toHaveBeenCalledWith("create_custom_provider", {
        id: "my-custom",
        name: "My Custom",
        defaultBaseUrl: "https://api.custom.com",
        apiKeyPrefix: "mc-",
        models,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        create_custom_provider: () => {
          throw new Error("duplicate id");
        },
      });
      await expect(
        createCustomProvider("x", "X", "https://x", "x-", []),
      ).rejects.toThrow("duplicate id");
    });
  });

  describe("deleteCustomProvider", () => {
    it("invokes delete_custom_provider with { providerId } and adapts array", async () => {
      mockInvoke({ delete_custom_provider: () => [rawProvider] });
      const result = await deleteCustomProvider("my-custom");
      expect(result).toEqual([expectedDisplay]);
      expect(invokeMock).toHaveBeenCalledWith("delete_custom_provider", {
        providerId: "my-custom",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        delete_custom_provider: () => {
          throw new Error("not found");
        },
      });
      await expect(deleteCustomProvider("ghost")).rejects.toThrow("not found");
    });
  });

  describe("addModel", () => {
    it("invokes add_model with { providerId, modelId, modelName } and adapts", async () => {
      mockInvoke({ add_model: () => rawProvider });
      const result = await addModel("openai", "gpt-5-mini", "GPT-5 Mini");
      expect(result).toEqual(expectedDisplay);
      expect(invokeMock).toHaveBeenCalledWith("add_model", {
        providerId: "openai",
        modelId: "gpt-5-mini",
        modelName: "GPT-5 Mini",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        add_model: () => {
          throw new Error("already exists");
        },
      });
      await expect(addModel("openai", "x", "X")).rejects.toThrow("already exists");
    });
  });

  describe("removeModel", () => {
    it("invokes remove_model with { providerId, modelId } and adapts", async () => {
      mockInvoke({ remove_model: () => rawProvider });
      const result = await removeModel("openai", "gpt-5-mini");
      expect(result).toEqual(expectedDisplay);
      expect(invokeMock).toHaveBeenCalledWith("remove_model", {
        providerId: "openai",
        modelId: "gpt-5-mini",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        remove_model: () => {
          throw new Error("not found");
        },
      });
      await expect(removeModel("openai", "ghost")).rejects.toThrow("not found");
    });
  });

  describe("getActiveLlm", () => {
    it("invokes get_active_llm and returns the active info", async () => {
      const active: ActiveModelsInfo = { provider_id: "openai", model: "gpt-5" };
      mockInvoke({ get_active_llm: () => active });
      const result = await getActiveLlm();
      expect(result).toEqual(active);
      expect(invokeMock).toHaveBeenCalledWith("get_active_llm");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        get_active_llm: () => {
          throw new Error("config missing");
        },
      });
      await expect(getActiveLlm()).rejects.toThrow("config missing");
    });
  });

  describe("setActiveLlm", () => {
    it("invokes set_active_llm with { providerId, model } and returns the active info", async () => {
      const active: ActiveModelsInfo = { provider_id: "openai", model: "gpt-5" };
      mockInvoke({ set_active_llm: () => active });
      const result = await setActiveLlm("openai", "gpt-5");
      expect(result).toEqual(active);
      expect(invokeMock).toHaveBeenCalledWith("set_active_llm", {
        providerId: "openai",
        model: "gpt-5",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        set_active_llm: () => {
          throw new Error("provider not configured");
        },
      });
      await expect(setActiveLlm("ghost", "x")).rejects.toThrow("provider not configured");
    });
  });

  describe("listProviderTemplates", () => {
    it("invokes list_provider_templates and returns templates", async () => {
      const templates: ProviderTemplate[] = [
        {
          id: "tpl-1",
          name: "Template One",
          description: "desc",
          plugin: {
            id: "p1",
            name: "P1",
            default_base_url: "https://p1",
            api_key_env: "P1_KEY",
            api_compat: "openai",
            is_local: false,
            models: [],
          },
        },
      ];
      mockInvoke({ list_provider_templates: () => templates });
      const result = await listProviderTemplates();
      expect(result).toEqual(templates);
      expect(invokeMock).toHaveBeenCalledWith("list_provider_templates");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        list_provider_templates: () => {
          throw new Error("io error");
        },
      });
      await expect(listProviderTemplates()).rejects.toThrow("io error");
    });
  });

  describe("importProviderPlugin", () => {
    const plugin: ProviderPlugin = {
      id: "p1",
      name: "P1",
      default_base_url: "https://p1",
      api_key_env: "P1_KEY",
      api_compat: "openai",
      is_local: false,
      models: [{ id: "m1", name: "M1" }],
    };

    it("invokes import_provider_plugin with { plugin } and adapts", async () => {
      mockInvoke({ import_provider_plugin: () => rawProvider });
      const result = await importProviderPlugin(plugin);
      expect(result).toEqual(expectedDisplay);
      expect(invokeMock).toHaveBeenCalledWith("import_provider_plugin", { plugin });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        import_provider_plugin: () => {
          throw new Error("invalid plugin");
        },
      });
      await expect(importProviderPlugin(plugin)).rejects.toThrow("invalid plugin");
    });
  });

  describe("exportProviderConfig", () => {
    it("invokes export_provider_config with { providerId } and returns the plugin", async () => {
      const plugin: ProviderPlugin = {
        id: "p1",
        name: "P1",
        default_base_url: "https://p1",
        api_key_env: "P1_KEY",
        api_compat: "openai",
        is_local: false,
        models: [],
      };
      mockInvoke({ export_provider_config: () => plugin });
      const result = await exportProviderConfig("p1");
      expect(result).toEqual(plugin);
      expect(invokeMock).toHaveBeenCalledWith("export_provider_config", {
        providerId: "p1",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        export_provider_config: () => {
          throw new Error("not found");
        },
      });
      await expect(exportProviderConfig("ghost")).rejects.toThrow("not found");
    });
  });

  describe("scanProviderPlugins", () => {
    it("invokes scan_provider_plugins and adapts the array", async () => {
      mockInvoke({ scan_provider_plugins: () => [rawProvider] });
      const result = await scanProviderPlugins();
      expect(result).toEqual([expectedDisplay]);
      expect(invokeMock).toHaveBeenCalledWith("scan_provider_plugins");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        scan_provider_plugins: () => {
          throw new Error("io error");
        },
      });
      await expect(scanProviderPlugins()).rejects.toThrow("io error");
    });
  });

  describe("importProviderFromTemplate", () => {
    it("invokes import_provider_from_template with { templateId } and adapts", async () => {
      mockInvoke({ import_provider_from_template: () => rawProvider });
      const result = await importProviderFromTemplate("tpl-1");
      expect(result).toEqual(expectedDisplay);
      expect(invokeMock).toHaveBeenCalledWith("import_provider_from_template", {
        templateId: "tpl-1",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        import_provider_from_template: () => {
          throw new Error("unknown template");
        },
      });
      await expect(importProviderFromTemplate("ghost")).rejects.toThrow("unknown template");
    });
  });
});
