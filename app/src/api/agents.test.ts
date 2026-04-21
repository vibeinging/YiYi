import { describe, it, expect } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import {
  listAgents,
  getAgent,
  saveAgent,
  deleteAgent,
  type AgentSummary,
  type AgentDefinition,
} from "./agents";

const invokeMock = invoke as unknown as Mock;

describe("agents api", () => {
  const sampleSummary: AgentSummary = {
    name: "planner",
    description: "plans tasks",
    emoji: "🗺️",
    color: "#f00",
    is_builtin: true,
    model: "claude-4.7",
    tool_count: 5,
  };

  const sampleDefinition: AgentDefinition = {
    name: "planner",
    description: "plans tasks",
    model: "claude-4.7",
    max_iterations: 10,
    tools: ["shell", "read"],
    disallowed_tools: null,
    skills: ["brainstorm"],
    metadata: { version: 1 },
    instructions: "You plan.",
  };

  describe("listAgents", () => {
    it("invokes list_agents and returns the summary array", async () => {
      mockInvoke({ list_agents: () => [sampleSummary] });
      const result = await listAgents();
      expect(result).toEqual([sampleSummary]);
      expect(invokeMock).toHaveBeenCalledWith("list_agents");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        list_agents: () => {
          throw new Error("db offline");
        },
      });
      await expect(listAgents()).rejects.toThrow("db offline");
    });
  });

  describe("getAgent", () => {
    it("invokes get_agent with { name } and returns the AgentDefinition", async () => {
      mockInvoke({ get_agent: () => sampleDefinition });
      const result = await getAgent("planner");
      expect(result).toEqual(sampleDefinition);
      expect(invokeMock).toHaveBeenCalledWith("get_agent", { name: "planner" });
    });

    it("returns null when agent is missing", async () => {
      mockInvoke({ get_agent: () => null });
      const result = await getAgent("ghost");
      expect(result).toBeNull();
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        get_agent: () => {
          throw new Error("parse error");
        },
      });
      await expect(getAgent("planner")).rejects.toThrow("parse error");
    });
  });

  describe("saveAgent", () => {
    it("invokes save_agent with { content }", async () => {
      mockInvoke({ save_agent: () => undefined });
      await saveAgent("---\nname: planner\n---\nYou plan.");
      expect(invokeMock).toHaveBeenCalledWith("save_agent", {
        content: "---\nname: planner\n---\nYou plan.",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        save_agent: () => {
          throw new Error("invalid frontmatter");
        },
      });
      await expect(saveAgent("bad")).rejects.toThrow("invalid frontmatter");
    });
  });

  describe("deleteAgent", () => {
    it("invokes delete_agent with { name }", async () => {
      mockInvoke({ delete_agent: () => undefined });
      await deleteAgent("planner");
      expect(invokeMock).toHaveBeenCalledWith("delete_agent", {
        name: "planner",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        delete_agent: () => {
          throw new Error("not found");
        },
      });
      await expect(deleteAgent("ghost")).rejects.toThrow("not found");
    });
  });
});
