import { describe, it, expect } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import {
  getBuddyConfig,
  saveBuddyConfig,
  hatchBuddy,
  toggleBuddyHosted,
  getBuddyHosted,
  getMemoryStats,
  listRecentMemories,
  searchMemories,
  deleteMemory,
  listRecentEpisodes,
  listCorrections,
  listBuddyDecisions,
  setDecisionFeedback,
  getTrustStats,
  listMeditationSessions,
  buddyObserve,
  type BuddyConfig,
  type MemoryEntry,
  type MemoryStats,
  type EpisodeEntry,
  type CorrectionEntry,
  type BuddyDecision,
  type TrustStats,
  type MeditationSession,
} from "./buddy";

const invokeMock = invoke as unknown as Mock;

describe("buddy api", () => {
  const sampleConfig: BuddyConfig = {
    name: "YiYi",
    personality: "curious",
    hatched_at: 1_700_000_000,
    muted: false,
    buddy_user_id: "buddy-1",
    stats_delta: {},
    interaction_count: 0,
    hosted_mode: false,
    pet_count: 0,
    delegation_count: 0,
    trust_scores: {},
    trust_overall: 0.5,
  };

  describe("getBuddyConfig", () => {
    it("invokes get_buddy_config and returns the config", async () => {
      mockInvoke({ get_buddy_config: () => sampleConfig });
      const result = await getBuddyConfig();
      expect(result).toEqual(sampleConfig);
      expect(invokeMock).toHaveBeenCalledWith("get_buddy_config");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        get_buddy_config: () => {
          throw new Error("not hatched");
        },
      });
      await expect(getBuddyConfig()).rejects.toThrow("not hatched");
    });
  });

  describe("saveBuddyConfig", () => {
    it("invokes save_buddy_config with { config } and echoes", async () => {
      mockInvoke({ save_buddy_config: (args) => args?.config });
      const result = await saveBuddyConfig(sampleConfig);
      expect(result).toEqual(sampleConfig);
      expect(invokeMock).toHaveBeenCalledWith("save_buddy_config", {
        config: sampleConfig,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        save_buddy_config: () => {
          throw new Error("db locked");
        },
      });
      await expect(saveBuddyConfig(sampleConfig)).rejects.toThrow("db locked");
    });
  });

  describe("hatchBuddy", () => {
    it("invokes hatch_buddy with { name, personality } and returns the config", async () => {
      mockInvoke({ hatch_buddy: () => sampleConfig });
      const result = await hatchBuddy("YiYi", "curious");
      expect(result).toEqual(sampleConfig);
      expect(invokeMock).toHaveBeenCalledWith("hatch_buddy", {
        name: "YiYi",
        personality: "curious",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        hatch_buddy: () => {
          throw new Error("already hatched");
        },
      });
      await expect(hatchBuddy("YiYi", "curious")).rejects.toThrow(
        "already hatched",
      );
    });
  });

  describe("toggleBuddyHosted", () => {
    it("invokes toggle_buddy_hosted with { enabled } and returns bool", async () => {
      mockInvoke({ toggle_buddy_hosted: () => true });
      const result = await toggleBuddyHosted(true);
      expect(result).toBe(true);
      expect(invokeMock).toHaveBeenCalledWith("toggle_buddy_hosted", {
        enabled: true,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        toggle_buddy_hosted: () => {
          throw new Error("no llm");
        },
      });
      await expect(toggleBuddyHosted(true)).rejects.toThrow("no llm");
    });
  });

  describe("getBuddyHosted", () => {
    it("invokes get_buddy_hosted and returns the bool", async () => {
      mockInvoke({ get_buddy_hosted: () => false });
      const result = await getBuddyHosted();
      expect(result).toBe(false);
      expect(invokeMock).toHaveBeenCalledWith("get_buddy_hosted");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        get_buddy_hosted: () => {
          throw new Error("config missing");
        },
      });
      await expect(getBuddyHosted()).rejects.toThrow("config missing");
    });
  });

  describe("getMemoryStats", () => {
    it("invokes get_memory_stats and returns stats", async () => {
      const stats: MemoryStats = { total: 10, by_category: { fact: 5, preference: 5 } };
      mockInvoke({ get_memory_stats: () => stats });
      const result = await getMemoryStats();
      expect(result).toEqual(stats);
      expect(invokeMock).toHaveBeenCalledWith("get_memory_stats");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        get_memory_stats: () => {
          throw new Error("memme offline");
        },
      });
      await expect(getMemoryStats()).rejects.toThrow("memme offline");
    });
  });

  describe("listRecentMemories", () => {
    const memories: MemoryEntry[] = [
      {
        id: "m1",
        content: "user likes coffee",
        categories: ["preference"],
        importance: 0.7,
        created_at: "2026-04-20",
      },
    ];

    it("invokes list_recent_memories with { limit } and returns memories", async () => {
      mockInvoke({ list_recent_memories: () => memories });
      const result = await listRecentMemories(20);
      expect(result).toEqual(memories);
      expect(invokeMock).toHaveBeenCalledWith("list_recent_memories", {
        limit: 20,
      });
    });

    it("passes { limit: undefined } when called without argument", async () => {
      mockInvoke({ list_recent_memories: () => [] });
      await listRecentMemories();
      expect(invokeMock).toHaveBeenCalledWith("list_recent_memories", {
        limit: undefined,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        list_recent_memories: () => {
          throw new Error("memme offline");
        },
      });
      await expect(listRecentMemories()).rejects.toThrow("memme offline");
    });
  });

  describe("searchMemories", () => {
    it("invokes search_memories with { query, limit } and returns memories", async () => {
      mockInvoke({ search_memories: () => [] });
      await searchMemories("coffee", 5);
      expect(invokeMock).toHaveBeenCalledWith("search_memories", {
        query: "coffee",
        limit: 5,
      });
    });

    it("passes { limit: undefined } when omitted", async () => {
      mockInvoke({ search_memories: () => [] });
      await searchMemories("coffee");
      expect(invokeMock).toHaveBeenCalledWith("search_memories", {
        query: "coffee",
        limit: undefined,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        search_memories: () => {
          throw new Error("embed failed");
        },
      });
      await expect(searchMemories("x")).rejects.toThrow("embed failed");
    });
  });

  describe("deleteMemory", () => {
    it("invokes delete_memory with { id }", async () => {
      mockInvoke({ delete_memory: () => undefined });
      await deleteMemory("m1");
      expect(invokeMock).toHaveBeenCalledWith("delete_memory", { id: "m1" });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        delete_memory: () => {
          throw new Error("not found");
        },
      });
      await expect(deleteMemory("ghost")).rejects.toThrow("not found");
    });
  });

  describe("listRecentEpisodes", () => {
    const episodes: EpisodeEntry[] = [
      {
        episode_id: "e1",
        title: "First chat",
        summary: "summary",
        started_at: "2026-04-20",
        ended_at: null,
        significance: 0.5,
        outcome: null,
      },
    ];

    it("invokes list_recent_episodes with { limit } and returns episodes", async () => {
      mockInvoke({ list_recent_episodes: () => episodes });
      const result = await listRecentEpisodes(10);
      expect(result).toEqual(episodes);
      expect(invokeMock).toHaveBeenCalledWith("list_recent_episodes", {
        limit: 10,
      });
    });

    it("passes { limit: undefined } when omitted", async () => {
      mockInvoke({ list_recent_episodes: () => [] });
      await listRecentEpisodes();
      expect(invokeMock).toHaveBeenCalledWith("list_recent_episodes", {
        limit: undefined,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        list_recent_episodes: () => {
          throw new Error("memme offline");
        },
      });
      await expect(listRecentEpisodes()).rejects.toThrow("memme offline");
    });
  });

  describe("listCorrections", () => {
    it("invokes list_corrections and returns entries", async () => {
      const corrections: CorrectionEntry[] = [
        {
          trigger: "user says hello",
          correct_behavior: "reply with wave",
          source: "user_feedback",
          confidence: 0.9,
        },
      ];
      mockInvoke({ list_corrections: () => corrections });
      const result = await listCorrections();
      expect(result).toEqual(corrections);
      expect(invokeMock).toHaveBeenCalledWith("list_corrections");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        list_corrections: () => {
          throw new Error("db offline");
        },
      });
      await expect(listCorrections()).rejects.toThrow("db offline");
    });
  });

  describe("listBuddyDecisions", () => {
    const decisions: BuddyDecision[] = [
      {
        id: "d1",
        question: "should I reply?",
        context: "chat",
        buddy_answer: "yes",
        buddy_confidence: 0.8,
        user_feedback: null,
        created_at: 1_700_000_000,
      },
    ];

    it("invokes list_buddy_decisions with { limit } and returns decisions", async () => {
      mockInvoke({ list_buddy_decisions: () => decisions });
      const result = await listBuddyDecisions(50);
      expect(result).toEqual(decisions);
      expect(invokeMock).toHaveBeenCalledWith("list_buddy_decisions", {
        limit: 50,
      });
    });

    it("passes { limit: undefined } when omitted", async () => {
      mockInvoke({ list_buddy_decisions: () => [] });
      await listBuddyDecisions();
      expect(invokeMock).toHaveBeenCalledWith("list_buddy_decisions", {
        limit: undefined,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        list_buddy_decisions: () => {
          throw new Error("db offline");
        },
      });
      await expect(listBuddyDecisions()).rejects.toThrow("db offline");
    });
  });

  describe("setDecisionFeedback", () => {
    it("invokes set_decision_feedback with { decisionId, feedback }", async () => {
      mockInvoke({ set_decision_feedback: () => undefined });
      await setDecisionFeedback("d1", "good");
      expect(invokeMock).toHaveBeenCalledWith("set_decision_feedback", {
        decisionId: "d1",
        feedback: "good",
      });
    });

    it("handles 'bad' feedback too", async () => {
      mockInvoke({ set_decision_feedback: () => undefined });
      await setDecisionFeedback("d1", "bad");
      expect(invokeMock).toHaveBeenCalledWith("set_decision_feedback", {
        decisionId: "d1",
        feedback: "bad",
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        set_decision_feedback: () => {
          throw new Error("not found");
        },
      });
      await expect(setDecisionFeedback("ghost", "good")).rejects.toThrow(
        "not found",
      );
    });
  });

  describe("getTrustStats", () => {
    it("invokes get_trust_stats and returns stats", async () => {
      const stats: TrustStats = {
        total: 10,
        good: 7,
        bad: 2,
        pending: 1,
        accuracy: 0.7,
        by_context: {
          chat: { total: 5, good: 4, bad: 1, accuracy: 0.8 },
        },
      };
      mockInvoke({ get_trust_stats: () => stats });
      const result = await getTrustStats();
      expect(result).toEqual(stats);
      expect(invokeMock).toHaveBeenCalledWith("get_trust_stats");
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        get_trust_stats: () => {
          throw new Error("db offline");
        },
      });
      await expect(getTrustStats()).rejects.toThrow("db offline");
    });
  });

  describe("listMeditationSessions", () => {
    const sessions: MeditationSession[] = [
      {
        id: "s1",
        started_at: 1_700_000_000,
        finished_at: 1_700_000_600,
        status: "done",
        sessions_reviewed: 3,
        memories_updated: 2,
        principles_changed: 0,
        memories_archived: 1,
        journal: "note",
        error: null,
        tomorrow_intentions: "be kind",
        growth_synthesis: "grew a little",
      },
    ];

    it("invokes list_meditation_sessions with { limit } and returns sessions", async () => {
      mockInvoke({ list_meditation_sessions: () => sessions });
      const result = await listMeditationSessions(5);
      expect(result).toEqual(sessions);
      expect(invokeMock).toHaveBeenCalledWith("list_meditation_sessions", {
        limit: 5,
      });
    });

    it("passes { limit: undefined } when omitted", async () => {
      mockInvoke({ list_meditation_sessions: () => [] });
      await listMeditationSessions();
      expect(invokeMock).toHaveBeenCalledWith("list_meditation_sessions", {
        limit: undefined,
      });
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        list_meditation_sessions: () => {
          throw new Error("db offline");
        },
      });
      await expect(listMeditationSessions()).rejects.toThrow("db offline");
    });
  });

  describe("buddyObserve", () => {
    it("invokes buddy_observe with { recentMessages, aiName, speciesLabel, reactionStyle, stats }", async () => {
      mockInvoke({ buddy_observe: () => "hello!" });
      const stats = { happiness: 0.8 };
      const result = await buddyObserve(
        ["hi", "there"],
        "YiYi",
        "cat",
        "playful",
        stats,
      );
      expect(result).toBe("hello!");
      expect(invokeMock).toHaveBeenCalledWith("buddy_observe", {
        recentMessages: ["hi", "there"],
        aiName: "YiYi",
        speciesLabel: "cat",
        reactionStyle: "playful",
        stats,
      });
    });

    it("returns null when buddy has nothing to say", async () => {
      mockInvoke({ buddy_observe: () => null });
      const result = await buddyObserve([], "YiYi", "cat", "playful", {});
      expect(result).toBeNull();
    });

    it("propagates backend errors", async () => {
      mockInvoke({
        buddy_observe: () => {
          throw new Error("no llm");
        },
      });
      await expect(
        buddyObserve([], "YiYi", "cat", "playful", {}),
      ).rejects.toThrow("no llm");
    });
  });
});
