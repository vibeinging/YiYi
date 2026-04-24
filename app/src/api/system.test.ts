import { describe, it, expect } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import {
  healthCheck,
  listModels,
  setModel,
  executeShell,
  isSetupComplete,
  completeSetup,
  getUserWorkspace,
  setUserWorkspace,
  checkClaudeCodeStatus,
  installClaudeCode,
  checkToolAvailable,
  installTool,
  checkGitAvailable,
  installGit,
  getAppFlag,
  setAppFlag,
  getGrowthReport,
  getMorningGreeting,
  saveMeditationConfig,
  listQuickActions,
  addQuickAction,
  updateQuickAction,
  deleteQuickAction,
  getMemmeConfig,
  saveMemmeConfig,
  getIdentityTraits,
  type ClaudeCodeStatus,
  type InstallClaudeCodeResult,
  type GrowthData,
  type CustomQuickAction,
  type MemmeConfig,
  type IdentityTrait,
} from "./system";
import type { ModelInfo, ShellResult } from "./types";

const invokeMock = invoke as unknown as Mock;

describe("system api", () => {
  const sampleHealth = {
    status: "ok",
    version: "1.0.0",
    methods: ["chat", "list_models"],
  };

  const sampleModel: ModelInfo = {
    id: "gpt-4",
    name: "GPT-4",
    provider: "openai",
  };

  const sampleShell: ShellResult = {
    stdout: "hello\n",
    stderr: "",
    code: 0,
  };

  const sampleClaudeStatus: ClaudeCodeStatus = {
    installed: true,
    has_api_key: true,
    available_provider: {
      id: "anthropic",
      name: "Anthropic",
      base_url: "https://api.anthropic.com",
    },
  };

  const sampleInstallResult: InstallClaudeCodeResult = {
    success: true,
    message: "installed",
    already_installed: false,
    needs_node: false,
    output: "ok",
  };

  const sampleGrowth: GrowthData = {
    report: {
      total_tasks: 10,
      success_count: 8,
      failure_count: 1,
      partial_count: 1,
      success_rate: 0.8,
      top_lessons: ["lesson 1"],
    },
    skill_suggestion: "try X",
    capabilities: [
      {
        name: "coding",
        success_rate: 0.9,
        sample_count: 20,
        confidence: "high",
      },
    ],
    timeline: [
      {
        date: "2026-01-01",
        event_type: "milestone",
        title: "first task",
        description: "did a thing",
      },
    ],
  };

  const sampleAction: CustomQuickAction = {
    id: "qa-1",
    label: "Summarize",
    description: "Summarize this",
    prompt: "Summarize: ",
    icon: "Zap",
    color: "#6366F1",
    sortOrder: 0,
  };

  const sampleMemmeConfig: MemmeConfig = {
    embedding_provider: "local-bge-zh",
    embedding_model: "bge-small-zh-v1.5",
    embedding_api_key: "",
    embedding_base_url: "",
    embedding_dims: 512,
    enable_graph: true,
    enable_forgetting_curve: false,
    extraction_depth: "standard",
    memory_llm_base_url: "",
    memory_llm_api_key: "",
    memory_llm_model: "",
  };

  const sampleTrait: IdentityTrait = {
    trait_id: "t-1",
    trait_type: "Role",
    content: "engineer",
    confidence: 0.9,
    evidence_ids: ["e1"],
  };

  describe("healthCheck", () => {
    it("invokes health_check and returns the status payload", async () => {
      mockInvoke({ health_check: () => sampleHealth });
      const result = await healthCheck();
      expect(result).toEqual(sampleHealth);
      expect(invokeMock).toHaveBeenCalledWith("health_check");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        health_check: () => {
          throw new Error("service down");
        },
      });
      await expect(healthCheck()).rejects.toThrow("service down");
    });
  });

  describe("listModels", () => {
    it("invokes list_models and returns the model list", async () => {
      mockInvoke({ list_models: () => [sampleModel] });
      const result = await listModels();
      expect(result).toEqual([sampleModel]);
      expect(invokeMock).toHaveBeenCalledWith("list_models");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        list_models: () => {
          throw new Error("no provider");
        },
      });
      await expect(listModels()).rejects.toThrow("no provider");
    });
  });

  describe("setModel", () => {
    it("invokes set_model with { modelName }", async () => {
      mockInvoke({ set_model: () => undefined });
      await setModel("gpt-4");
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
      await expect(setModel("bogus")).rejects.toThrow("unknown model");
    });
  });

  describe("executeShell", () => {
    it("invokes execute_shell with { command, args, cwd }", async () => {
      mockInvoke({ execute_shell: () => sampleShell });
      const result = await executeShell("ls", ["-la"], "/tmp");
      expect(result).toEqual(sampleShell);
      expect(invokeMock).toHaveBeenCalledWith("execute_shell", {
        command: "ls",
        args: ["-la"],
        cwd: "/tmp",
      });
    });

    it("passes undefined for omitted args and cwd", async () => {
      mockInvoke({ execute_shell: () => sampleShell });
      await executeShell("ls");
      expect(invokeMock).toHaveBeenCalledWith("execute_shell", {
        command: "ls",
        args: undefined,
        cwd: undefined,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        execute_shell: () => {
          throw new Error("permission denied");
        },
      });
      await expect(executeShell("ls")).rejects.toThrow("permission denied");
    });
  });

  describe("isSetupComplete", () => {
    it("invokes is_setup_complete and returns a boolean", async () => {
      mockInvoke({ is_setup_complete: () => true });
      const result = await isSetupComplete();
      expect(result).toBe(true);
      expect(invokeMock).toHaveBeenCalledWith("is_setup_complete");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        is_setup_complete: () => {
          throw new Error("db offline");
        },
      });
      await expect(isSetupComplete()).rejects.toThrow("db offline");
    });
  });

  describe("completeSetup", () => {
    it("invokes complete_setup", async () => {
      mockInvoke({ complete_setup: () => undefined });
      await completeSetup();
      expect(invokeMock).toHaveBeenCalledWith("complete_setup");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        complete_setup: () => {
          throw new Error("already set up");
        },
      });
      await expect(completeSetup()).rejects.toThrow("already set up");
    });
  });

  describe("getUserWorkspace", () => {
    it("invokes get_user_workspace and returns the path", async () => {
      mockInvoke({ get_user_workspace: () => "/home/me/YiYi" });
      const result = await getUserWorkspace();
      expect(result).toBe("/home/me/YiYi");
      expect(invokeMock).toHaveBeenCalledWith("get_user_workspace");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        get_user_workspace: () => {
          throw new Error("no workspace");
        },
      });
      await expect(getUserWorkspace()).rejects.toThrow("no workspace");
    });
  });

  describe("setUserWorkspace", () => {
    it("invokes set_user_workspace with { path }", async () => {
      mockInvoke({ set_user_workspace: () => undefined });
      await setUserWorkspace("/tmp/ws");
      expect(invokeMock).toHaveBeenCalledWith("set_user_workspace", {
        path: "/tmp/ws",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        set_user_workspace: () => {
          throw new Error("invalid path");
        },
      });
      await expect(setUserWorkspace("/bad")).rejects.toThrow("invalid path");
    });
  });

  describe("checkClaudeCodeStatus", () => {
    it("invokes check_claude_code_status and returns the status", async () => {
      mockInvoke({ check_claude_code_status: () => sampleClaudeStatus });
      const result = await checkClaudeCodeStatus();
      expect(result).toEqual(sampleClaudeStatus);
      expect(invokeMock).toHaveBeenCalledWith("check_claude_code_status");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        check_claude_code_status: () => {
          throw new Error("probe failed");
        },
      });
      await expect(checkClaudeCodeStatus()).rejects.toThrow("probe failed");
    });
  });

  describe("installClaudeCode", () => {
    it("invokes install_claude_code and returns the result", async () => {
      mockInvoke({ install_claude_code: () => sampleInstallResult });
      const result = await installClaudeCode();
      expect(result).toEqual(sampleInstallResult);
      expect(invokeMock).toHaveBeenCalledWith("install_claude_code");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        install_claude_code: () => {
          throw new Error("network error");
        },
      });
      await expect(installClaudeCode()).rejects.toThrow("network error");
    });
  });

  describe("checkToolAvailable", () => {
    it("invokes check_tool_available with { tool } and returns boolean", async () => {
      mockInvoke({ check_tool_available: () => true });
      const result = await checkToolAvailable("node");
      expect(result).toBe(true);
      expect(invokeMock).toHaveBeenCalledWith("check_tool_available", {
        tool: "node",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        check_tool_available: () => {
          throw new Error("probe failed");
        },
      });
      await expect(checkToolAvailable("node")).rejects.toThrow("probe failed");
    });
  });

  describe("installTool", () => {
    it("invokes install_tool with { tool } and returns install log", async () => {
      mockInvoke({ install_tool: () => "installed" });
      const result = await installTool("git");
      expect(result).toBe("installed");
      expect(invokeMock).toHaveBeenCalledWith("install_tool", { tool: "git" });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        install_tool: () => {
          throw new Error("install failed");
        },
      });
      await expect(installTool("git")).rejects.toThrow("install failed");
    });
  });

  describe("checkGitAvailable (deprecated)", () => {
    it("delegates to check_tool_available with { tool: 'git' }", async () => {
      mockInvoke({ check_tool_available: () => true });
      const result = await checkGitAvailable();
      expect(result).toBe(true);
      expect(invokeMock).toHaveBeenCalledWith("check_tool_available", {
        tool: "git",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        check_tool_available: () => {
          throw new Error("probe failed");
        },
      });
      await expect(checkGitAvailable()).rejects.toThrow("probe failed");
    });
  });

  describe("installGit (deprecated)", () => {
    it("delegates to install_tool with { tool: 'git' }", async () => {
      mockInvoke({ install_tool: () => "git installed" });
      const result = await installGit();
      expect(result).toBe("git installed");
      expect(invokeMock).toHaveBeenCalledWith("install_tool", { tool: "git" });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        install_tool: () => {
          throw new Error("install failed");
        },
      });
      await expect(installGit()).rejects.toThrow("install failed");
    });
  });

  describe("getAppFlag", () => {
    it("invokes get_app_flag with { key } and returns string", async () => {
      mockInvoke({ get_app_flag: () => "value" });
      const result = await getAppFlag("flag.x");
      expect(result).toBe("value");
      expect(invokeMock).toHaveBeenCalledWith("get_app_flag", {
        key: "flag.x",
      });
    });

    it("returns null when backend returns null", async () => {
      mockInvoke({ get_app_flag: () => null });
      const result = await getAppFlag("missing");
      expect(result).toBeNull();
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        get_app_flag: () => {
          throw new Error("db offline");
        },
      });
      await expect(getAppFlag("k")).rejects.toThrow("db offline");
    });
  });

  describe("setAppFlag", () => {
    it("invokes set_app_flag with { key, value }", async () => {
      mockInvoke({ set_app_flag: () => undefined });
      await setAppFlag("flag.x", "v1");
      expect(invokeMock).toHaveBeenCalledWith("set_app_flag", {
        key: "flag.x",
        value: "v1",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        set_app_flag: () => {
          throw new Error("db offline");
        },
      });
      await expect(setAppFlag("k", "v")).rejects.toThrow("db offline");
    });
  });

  describe("getGrowthReport", () => {
    it("invokes get_growth_report and returns the growth data", async () => {
      mockInvoke({ get_growth_report: () => sampleGrowth });
      const result = await getGrowthReport();
      expect(result).toEqual(sampleGrowth);
      expect(invokeMock).toHaveBeenCalledWith("get_growth_report");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        get_growth_report: () => {
          throw new Error("db offline");
        },
      });
      await expect(getGrowthReport()).rejects.toThrow("db offline");
    });
  });

  describe("getMorningGreeting", () => {
    it("invokes get_morning_greeting and returns the greeting string", async () => {
      mockInvoke({ get_morning_greeting: () => "Good morning!" });
      const result = await getMorningGreeting();
      expect(result).toBe("Good morning!");
      expect(invokeMock).toHaveBeenCalledWith("get_morning_greeting");
    });

    it("returns null when backend returns null", async () => {
      mockInvoke({ get_morning_greeting: () => null });
      const result = await getMorningGreeting();
      expect(result).toBeNull();
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        get_morning_greeting: () => {
          throw new Error("no llm");
        },
      });
      await expect(getMorningGreeting()).rejects.toThrow("no llm");
    });
  });

  describe("saveMeditationConfig", () => {
    it("invokes save_meditation_config with { enabled, startTime, notifyOnComplete }", async () => {
      mockInvoke({ save_meditation_config: () => undefined });
      await saveMeditationConfig(true, "02:00", false);
      expect(invokeMock).toHaveBeenCalledWith("save_meditation_config", {
        enabled: true,
        startTime: "02:00",
        notifyOnComplete: false,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        save_meditation_config: () => {
          throw new Error("invalid time");
        },
      });
      await expect(
        saveMeditationConfig(false, "xx", true),
      ).rejects.toThrow("invalid time");
    });
  });

  describe("listQuickActions", () => {
    it("invokes list_quick_actions and returns the action list", async () => {
      mockInvoke({ list_quick_actions: () => [sampleAction] });
      const result = await listQuickActions();
      expect(result).toEqual([sampleAction]);
      expect(invokeMock).toHaveBeenCalledWith("list_quick_actions");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        list_quick_actions: () => {
          throw new Error("db offline");
        },
      });
      await expect(listQuickActions()).rejects.toThrow("db offline");
    });
  });

  describe("addQuickAction", () => {
    it("invokes add_quick_action with all provided fields", async () => {
      mockInvoke({ add_quick_action: () => "qa-new" });
      const result = await addQuickAction(
        "Label",
        "Desc",
        "Prompt text",
        "Star",
        "#ff0000",
      );
      expect(result).toBe("qa-new");
      expect(invokeMock).toHaveBeenCalledWith("add_quick_action", {
        label: "Label",
        description: "Desc",
        prompt: "Prompt text",
        icon: "Star",
        color: "#ff0000",
      });
    });

    it("uses defaults for icon and color when omitted", async () => {
      mockInvoke({ add_quick_action: () => "qa-new" });
      await addQuickAction("Label", "Desc", "Prompt text");
      expect(invokeMock).toHaveBeenCalledWith("add_quick_action", {
        label: "Label",
        description: "Desc",
        prompt: "Prompt text",
        icon: "Zap",
        color: "#6366F1",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        add_quick_action: () => {
          throw new Error("db offline");
        },
      });
      await expect(addQuickAction("a", "b", "c")).rejects.toThrow(
        "db offline",
      );
    });
  });

  describe("updateQuickAction", () => {
    it("invokes update_quick_action with all provided fields", async () => {
      mockInvoke({ update_quick_action: () => undefined });
      await updateQuickAction(
        "qa-1",
        "Label",
        "Desc",
        "Prompt text",
        "Star",
        "#ff0000",
      );
      expect(invokeMock).toHaveBeenCalledWith("update_quick_action", {
        id: "qa-1",
        label: "Label",
        description: "Desc",
        prompt: "Prompt text",
        icon: "Star",
        color: "#ff0000",
      });
    });

    it("uses defaults for icon and color when omitted", async () => {
      mockInvoke({ update_quick_action: () => undefined });
      await updateQuickAction("qa-1", "L", "D", "P");
      expect(invokeMock).toHaveBeenCalledWith("update_quick_action", {
        id: "qa-1",
        label: "L",
        description: "D",
        prompt: "P",
        icon: "Zap",
        color: "#6366F1",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        update_quick_action: () => {
          throw new Error("not found");
        },
      });
      await expect(
        updateQuickAction("qa-1", "a", "b", "c"),
      ).rejects.toThrow("not found");
    });
  });

  describe("deleteQuickAction", () => {
    it("invokes delete_quick_action with { id }", async () => {
      mockInvoke({ delete_quick_action: () => undefined });
      await deleteQuickAction("qa-1");
      expect(invokeMock).toHaveBeenCalledWith("delete_quick_action", {
        id: "qa-1",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        delete_quick_action: () => {
          throw new Error("not found");
        },
      });
      await expect(deleteQuickAction("qa-1")).rejects.toThrow("not found");
    });
  });

  describe("getMemmeConfig", () => {
    it("invokes get_memme_config and returns the config", async () => {
      mockInvoke({ get_memme_config: () => sampleMemmeConfig });
      const result = await getMemmeConfig();
      expect(result).toEqual(sampleMemmeConfig);
      expect(invokeMock).toHaveBeenCalledWith("get_memme_config");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        get_memme_config: () => {
          throw new Error("db offline");
        },
      });
      await expect(getMemmeConfig()).rejects.toThrow("db offline");
    });
  });

  describe("saveMemmeConfig", () => {
    it("invokes save_memme_config with { config }", async () => {
      mockInvoke({ save_memme_config: () => undefined });
      await saveMemmeConfig(sampleMemmeConfig);
      expect(invokeMock).toHaveBeenCalledWith("save_memme_config", {
        config: sampleMemmeConfig,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        save_memme_config: () => {
          throw new Error("invalid config");
        },
      });
      await expect(saveMemmeConfig(sampleMemmeConfig)).rejects.toThrow(
        "invalid config",
      );
    });
  });

  describe("getIdentityTraits", () => {
    it("invokes get_identity_traits and returns the trait list", async () => {
      mockInvoke({ get_identity_traits: () => [sampleTrait] });
      const result = await getIdentityTraits();
      expect(result).toEqual([sampleTrait]);
      expect(invokeMock).toHaveBeenCalledWith("get_identity_traits");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        get_identity_traits: () => {
          throw new Error("db offline");
        },
      });
      await expect(getIdentityTraits()).rejects.toThrow("db offline");
    });
  });
});
