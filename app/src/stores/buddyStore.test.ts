import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockInvoke, expectInvokedWith } from "../test-utils/mockTauri";
import { useBuddyStore } from "./buddyStore";
import type { BuddyConfig } from "../api/buddy";
import {
  roll,
  getCompanion,
  STAT_NAMES,
  type CompanionBones,
  type Companion,
} from "../utils/buddy";

// Snapshot the pristine initial state.
const PRISTINE = useBuddyStore.getState();

function resetStore() {
  useBuddyStore.setState({
    ...PRISTINE,
    config: null,
    bones: null,
    companion: null,
    bubbleText: null,
    bubbleVisible: false,
    petting: false,
    showStats: false,
    showHatchAnimation: false,
    hostedMode: false,
    hatching: false,
    loaded: false,
    loadError: null,
    lastObserveAt: 0,
    aiName: "YiYi",
    inspirationSeed: 0,
  });
}

function makeConfig(overrides: Partial<BuddyConfig> = {}): BuddyConfig {
  return {
    name: "",
    personality: "",
    hatched_at: 0,
    muted: false,
    buddy_user_id: "test-user-fixed",
    stats_delta: {},
    interaction_count: 0,
    hosted_mode: false,
    pet_count: 0,
    delegation_count: 0,
    trust_scores: {},
    trust_overall: 0,
    ...overrides,
  };
}

function makeBones(): CompanionBones {
  // Derived deterministically from the fixed userId so test assertions stay stable.
  return roll("test-user-fixed").bones;
}

function makeCompanion(
  config: BuddyConfig = makeConfig({ hatched_at: 1_000 }),
): Companion {
  return getCompanion(config.buddy_user_id, {
    name: config.name,
    personality: config.personality,
    hatchedAt: config.hatched_at,
  });
}

describe("buddyStore", () => {
  beforeEach(() => {
    resetStore();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("initial state", () => {
    it("starts unloaded with null config/bones/companion and default flags", () => {
      const s = useBuddyStore.getState();
      expect(s.config).toBeNull();
      expect(s.bones).toBeNull();
      expect(s.companion).toBeNull();
      expect(s.loaded).toBe(false);
      expect(s.loadError).toBeNull();
      expect(s.hatching).toBe(false);
      expect(s.aiName).toBe("YiYi");
      expect(s.bubbleText).toBeNull();
      expect(s.bubbleVisible).toBe(false);
      expect(s.petting).toBe(false);
      expect(s.showStats).toBe(false);
      expect(s.showHatchAnimation).toBe(false);
      expect(s.hostedMode).toBe(false);
      expect(s.lastObserveAt).toBe(0);
      expect(s.inspirationSeed).toBe(0);
    });

    it("exposes every documented action", () => {
      const s = useBuddyStore.getState();
      for (const k of [
        "loadBuddy",
        "setAiName",
        "hatch",
        "triggerObserve",
        "showBubble",
        "hideBubble",
        "pet",
        "setMuted",
        "setShowStats",
        "setHostedMode",
        "dismissHatch",
      ] as const) {
        expect(typeof s[k]).toBe("function");
      }
    });
  });

  describe("setAiName", () => {
    it("updates the aiName field in place", () => {
      useBuddyStore.getState().setAiName("Ada");
      expect(useBuddyStore.getState().aiName).toBe("Ada");
    });
  });

  describe("setShowStats / setHostedMode / dismissHatch", () => {
    it("setShowStats toggles the flag", () => {
      useBuddyStore.getState().setShowStats(true);
      expect(useBuddyStore.getState().showStats).toBe(true);
      useBuddyStore.getState().setShowStats(false);
      expect(useBuddyStore.getState().showStats).toBe(false);
    });

    it("setHostedMode toggles the flag", () => {
      useBuddyStore.getState().setHostedMode(true);
      expect(useBuddyStore.getState().hostedMode).toBe(true);
      useBuddyStore.getState().setHostedMode(false);
      expect(useBuddyStore.getState().hostedMode).toBe(false);
    });

    it("dismissHatch clears showHatchAnimation", () => {
      useBuddyStore.setState({ showHatchAnimation: true });
      useBuddyStore.getState().dismissHatch();
      expect(useBuddyStore.getState().showHatchAnimation).toBe(false);
    });
  });

  describe("loadBuddy", () => {
    it("loads unhatched config, rolls bones, sets companion=null and showHatchAnimation=true", async () => {
      const cfg = makeConfig({ buddy_user_id: "test-user-fixed" });
      mockInvoke({ get_buddy_config: () => cfg });

      await useBuddyStore.getState().loadBuddy();

      const s = useBuddyStore.getState();
      expect(s.loaded).toBe(true);
      expect(s.config).toEqual(cfg);
      expect(s.bones).not.toBeNull();
      expect(s.companion).toBeNull();
      expect(s.showHatchAnimation).toBe(true);
      expectInvokedWith("get_buddy_config");
    });

    it("builds a companion when the buddy has already hatched", async () => {
      const cfg = makeConfig({
        buddy_user_id: "test-user-fixed",
        hatched_at: 1_700_000_000,
        name: "Nova",
        personality: "活泼开朗，总是充满正能量",
      });
      mockInvoke({ get_buddy_config: () => cfg });

      await useBuddyStore.getState().loadBuddy();
      const s = useBuddyStore.getState();
      expect(s.loaded).toBe(true);
      expect(s.companion).not.toBeNull();
      expect(s.companion?.name).toBe("Nova");
      expect(s.showHatchAnimation).toBe(false);
    });

    it("applies stats_delta to companion stats when present", async () => {
      const cfg = makeConfig({
        buddy_user_id: "test-user-fixed",
        hatched_at: 100,
        name: "X",
        personality: "",
        stats_delta: { ENERGY: 10 },
      });
      mockInvoke({ get_buddy_config: () => cfg });

      await useBuddyStore.getState().loadBuddy();
      const base = getCompanion(cfg.buddy_user_id, {
        name: cfg.name,
        personality: cfg.personality,
        hatchedAt: cfg.hatched_at,
      });
      const got = useBuddyStore.getState().companion;
      expect(got?.stats.ENERGY).toBe(
        Math.max(1, Math.min(100, base.stats.ENERGY + 10)),
      );
    });

    it("auto-generates a user id + re-saves config when buddy_user_id is empty", async () => {
      const emptyCfg = makeConfig({ buddy_user_id: "" });
      // saveBuddyConfig returns the (modified) config back.
      let savedWith: BuddyConfig | undefined;
      mockInvoke({
        get_buddy_config: () => emptyCfg,
        save_buddy_config: (args) => {
          savedWith = args?.config as BuddyConfig;
          return savedWith;
        },
      });

      await useBuddyStore.getState().loadBuddy();
      const s = useBuddyStore.getState();
      expect(s.loaded).toBe(true);
      expect(savedWith?.buddy_user_id).toBeTruthy();
      expect(s.config?.buddy_user_id).toBe(savedWith?.buddy_user_id);
    });

    it("on backend error keeps loaded=false and records loadError for the UI", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockInvoke({
        get_buddy_config: () => {
          throw new Error("db offline");
        },
      });
      await useBuddyStore.getState().loadBuddy();
      const s = useBuddyStore.getState();
      // loaded stays false so UI can distinguish "load failed" from
      // "loaded successfully with empty config".
      expect(s.loaded).toBe(false);
      expect(s.config).toBeNull();
      expect(s.loadError).toBeTruthy();
      expect(s.loadError).toMatch(/db offline/);
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });
  });

  describe("hatch", () => {
    it("requires config + bones; is a no-op before loadBuddy", async () => {
      // config is null, so hatch should short-circuit.
      mockInvoke({}); // no invoke expected
      await useBuddyStore.getState().hatch();
      expect(useBuddyStore.getState().hatching).toBe(false);
      expect(useBuddyStore.getState().companion).toBeNull();
    });

    it("short-circuits if already hatched", async () => {
      const cfg = makeConfig({ hatched_at: 1234 });
      useBuddyStore.setState({
        config: cfg,
        bones: makeBones(),
      });
      mockInvoke({}); // hatch_buddy must NOT be called
      await useBuddyStore.getState().hatch();
      expect(useBuddyStore.getState().hatching).toBe(false);
    });

    it("invokes hatch_buddy with aiName and personalityHint, then builds companion", async () => {
      const initial = makeConfig({ hatched_at: 0 });
      useBuddyStore.setState({
        config: initial,
        bones: makeBones(),
        aiName: "Lumi",
      });
      const hatched = makeConfig({
        hatched_at: 2_000,
        name: "Lumi",
        personality: "活泼开朗，总是充满正能量",
      });
      mockInvoke({ hatch_buddy: () => hatched });

      await useBuddyStore.getState().hatch("活泼开朗，总是充满正能量");

      const s = useBuddyStore.getState();
      expect(s.hatching).toBe(false);
      expect(s.config?.hatched_at).toBe(2_000);
      expect(s.companion?.name).toBe("Lumi");
      expectInvokedWith("hatch_buddy", {
        name: "Lumi",
        personality: "活泼开朗，总是充满正能量",
      });
    });

    it("falls back to the default personality when no hint is provided", async () => {
      useBuddyStore.setState({
        config: makeConfig(),
        bones: makeBones(),
      });
      const hatched = makeConfig({
        hatched_at: 99,
        personality: "活泼开朗，总是充满正能量",
      });
      mockInvoke({ hatch_buddy: () => hatched });

      await useBuddyStore.getState().hatch();
      expectInvokedWith("hatch_buddy", {
        name: "YiYi",
        personality: "活泼开朗，总是充满正能量",
      });
    });

    it("clears hatching=false on backend error", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      useBuddyStore.setState({
        config: makeConfig(),
        bones: makeBones(),
      });
      mockInvoke({
        hatch_buddy: () => {
          throw new Error("network");
        },
      });
      await useBuddyStore.getState().hatch();
      expect(useBuddyStore.getState().hatching).toBe(false);
      expect(useBuddyStore.getState().config?.hatched_at).toBe(0);
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });
  });

  describe("showBubble / hideBubble", () => {
    it("showBubble sets text + visible, then auto-hides after BUBBLE_DURATION_MS (10s)", () => {
      vi.useFakeTimers();
      useBuddyStore.getState().showBubble("hello");
      expect(useBuddyStore.getState().bubbleText).toBe("hello");
      expect(useBuddyStore.getState().bubbleVisible).toBe(true);

      // Just before 10s: still visible
      vi.advanceTimersByTime(9_999);
      expect(useBuddyStore.getState().bubbleVisible).toBe(true);

      // At 10s: visible flips off, text still set briefly (500ms fade)
      vi.advanceTimersByTime(1);
      expect(useBuddyStore.getState().bubbleVisible).toBe(false);
      expect(useBuddyStore.getState().bubbleText).toBe("hello");

      // After +500ms: text cleared
      vi.advanceTimersByTime(500);
      expect(useBuddyStore.getState().bubbleText).toBeNull();
    });

    it("showBubble replaces the prior text and resets the timer", () => {
      vi.useFakeTimers();
      useBuddyStore.getState().showBubble("first");
      vi.advanceTimersByTime(5_000);
      useBuddyStore.getState().showBubble("second");
      expect(useBuddyStore.getState().bubbleText).toBe("second");
      vi.advanceTimersByTime(9_999);
      expect(useBuddyStore.getState().bubbleVisible).toBe(true);
      vi.advanceTimersByTime(2);
      expect(useBuddyStore.getState().bubbleVisible).toBe(false);
    });

    it("hideBubble clears text and visibility immediately", () => {
      vi.useFakeTimers();
      useBuddyStore.getState().showBubble("temporary");
      useBuddyStore.getState().hideBubble();
      const s = useBuddyStore.getState();
      expect(s.bubbleText).toBeNull();
      expect(s.bubbleVisible).toBe(false);
    });
  });

  describe("pet", () => {
    it("sets petting=true and clears it after 2500ms", () => {
      vi.useFakeTimers();
      useBuddyStore.setState({
        config: makeConfig({ hatched_at: 1 }),
        companion: makeCompanion(),
      });
      // mock save_buddy_config because pet persists pet_count
      mockInvoke({ save_buddy_config: (args) => args?.config });

      useBuddyStore.getState().pet();
      expect(useBuddyStore.getState().petting).toBe(true);
      vi.advanceTimersByTime(2_499);
      expect(useBuddyStore.getState().petting).toBe(true);
      vi.advanceTimersByTime(1);
      expect(useBuddyStore.getState().petting).toBe(false);
    });

    it("increments pet_count and fire-and-forget persists via save_buddy_config", () => {
      vi.useFakeTimers();
      useBuddyStore.setState({
        config: makeConfig({ hatched_at: 1, pet_count: 4 }),
        companion: makeCompanion(),
      });
      mockInvoke({ save_buddy_config: (args) => args?.config });
      useBuddyStore.getState().pet();
      expect(useBuddyStore.getState().config?.pet_count).toBe(5);
    });

    it("shows a bubble reaction drawn from the appropriate pool (stub Math.random)", () => {
      vi.useFakeTimers();
      const rnd = vi.spyOn(Math, "random").mockReturnValue(0);
      useBuddyStore.setState({
        config: makeConfig({ hatched_at: 1 }),
        companion: makeCompanion(),
      });
      mockInvoke({ save_buddy_config: (args) => args?.config });
      useBuddyStore.getState().pet();
      const bubble = useBuddyStore.getState().bubbleText;
      expect(bubble).not.toBeNull();
      expect(typeof bubble).toBe("string");
      rnd.mockRestore();
    });

    it("is safe with a null companion (no bubble, just petting flag)", () => {
      vi.useFakeTimers();
      useBuddyStore.setState({ config: null, companion: null });
      mockInvoke({});
      // Should not throw when config is null.
      expect(() => useBuddyStore.getState().pet()).not.toThrow();
      expect(useBuddyStore.getState().petting).toBe(true);
      expect(useBuddyStore.getState().bubbleText).toBeNull();
    });

    it("chooses sass pool when SASS is the dominant stat", () => {
      vi.useFakeTimers();
      const companion = {
        ...makeCompanion(),
        stats: { ENERGY: 10, WARMTH: 10, MISCHIEF: 10, WIT: 10, SASS: 80 },
      };
      useBuddyStore.setState({
        config: makeConfig({ hatched_at: 1 }),
        companion: companion as any,
      });
      mockInvoke({ save_buddy_config: (args) => args?.config });
      // Math.random=0 always picks index 0 of the pool.
      const rnd = vi.spyOn(Math, "random").mockReturnValue(0);
      useBuddyStore.getState().pet();
      expect(useBuddyStore.getState().bubbleText).toBe("够了够了！");
      rnd.mockRestore();
    });

    it("chooses energy pool when ENERGY is dominant", () => {
      vi.useFakeTimers();
      const companion = {
        ...makeCompanion(),
        stats: { ENERGY: 90, WARMTH: 10, MISCHIEF: 10, WIT: 10, SASS: 10 },
      };
      useBuddyStore.setState({
        config: makeConfig({ hatched_at: 1 }),
        companion: companion as any,
      });
      mockInvoke({ save_buddy_config: (args) => args?.config });
      const rnd = vi.spyOn(Math, "random").mockReturnValue(0);
      useBuddyStore.getState().pet();
      expect(useBuddyStore.getState().bubbleText).toBe("再摸摸！");
      rnd.mockRestore();
    });

    it("defaults to warm reactions when no stat exceeds 40", () => {
      vi.useFakeTimers();
      const companion = {
        ...makeCompanion(),
        stats: { ENERGY: 20, WARMTH: 30, MISCHIEF: 20, WIT: 20, SASS: 20 },
      };
      useBuddyStore.setState({
        config: makeConfig({ hatched_at: 1 }),
        companion: companion as any,
      });
      mockInvoke({ save_buddy_config: (args) => args?.config });
      const rnd = vi.spyOn(Math, "random").mockReturnValue(0);
      useBuddyStore.getState().pet();
      expect(useBuddyStore.getState().bubbleText).toBe("好舒服~");
      rnd.mockRestore();
    });
  });

  describe("setMuted", () => {
    it("short-circuits when config is null", async () => {
      useBuddyStore.setState({ config: null });
      mockInvoke({}); // no invoke expected
      await useBuddyStore.getState().setMuted(true);
      expect(useBuddyStore.getState().config).toBeNull();
    });

    it("invokes save_buddy_config with muted=true and updates state", async () => {
      const cfg = makeConfig({ muted: false });
      useBuddyStore.setState({ config: cfg });
      mockInvoke({ save_buddy_config: (args) => args?.config });

      await useBuddyStore.getState().setMuted(true);
      expect(useBuddyStore.getState().config?.muted).toBe(true);
      const call = (vi.mocked(await import("@tauri-apps/api/core")).invoke as any)
        .mock.calls.find((c: any[]) => c[0] === "save_buddy_config");
      expect(call).toBeTruthy();
      expect((call[1] as any).config.muted).toBe(true);
    });

    it("hides an active bubble when muting", async () => {
      const cfg = makeConfig({ muted: false });
      useBuddyStore.setState({
        config: cfg,
        bubbleText: "hi",
        bubbleVisible: true,
      });
      mockInvoke({ save_buddy_config: (args) => args?.config });

      await useBuddyStore.getState().setMuted(true);
      expect(useBuddyStore.getState().bubbleVisible).toBe(false);
      expect(useBuddyStore.getState().bubbleText).toBeNull();
    });

    it("leaves state untouched on backend error", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const cfg = makeConfig({ muted: false });
      useBuddyStore.setState({ config: cfg });
      mockInvoke({
        save_buddy_config: () => {
          throw new Error("disk full");
        },
      });
      await useBuddyStore.getState().setMuted(true);
      expect(useBuddyStore.getState().config?.muted).toBe(false);
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });
  });

  describe("triggerObserve", () => {
    it("short-circuits if companion/config/bones are missing", async () => {
      useBuddyStore.setState({
        companion: null,
        config: null,
        bones: null,
      });
      mockInvoke({}); // nothing should be called
      await useBuddyStore.getState().triggerObserve(["hi"]);
      expect(useBuddyStore.getState().lastObserveAt).toBe(0);
    });

    it("short-circuits when config.muted is true", async () => {
      const cfg = makeConfig({ hatched_at: 1, muted: true });
      useBuddyStore.setState({
        config: cfg,
        bones: makeBones(),
        companion: makeCompanion(cfg),
      });
      mockInvoke({}); // no downstream invoke
      await useBuddyStore.getState().triggerObserve(["太棒了"]);
      expect(useBuddyStore.getState().lastObserveAt).toBe(0);
    });

    it("short-circuits when a bubble is already visible", async () => {
      const cfg = makeConfig({ hatched_at: 1 });
      useBuddyStore.setState({
        config: cfg,
        bones: makeBones(),
        companion: makeCompanion(cfg),
        bubbleVisible: true,
      });
      mockInvoke({});
      await useBuddyStore.getState().triggerObserve(["太棒了"]);
      expect(useBuddyStore.getState().lastObserveAt).toBe(0);
    });

    it("respects the ENERGY-weighted cooldown and bails within the window", async () => {
      const cfg = makeConfig({ hatched_at: 1 });
      const companion = {
        ...makeCompanion(cfg),
        stats: { ENERGY: 50, WARMTH: 50, MISCHIEF: 50, WIT: 50, SASS: 50 },
      };
      const lastObserve = Date.now() - 1_000; // 1 second ago — well inside cooldown
      useBuddyStore.setState({
        config: cfg,
        bones: makeBones(),
        companion: companion as any,
        lastObserveAt: lastObserve,
      });
      mockInvoke({});
      await useBuddyStore.getState().triggerObserve(["太棒了"]);
      expect(useBuddyStore.getState().lastObserveAt).toBe(lastObserve);
    });

    it("persists growth and increments interaction_count on growth-yielding messages", async () => {
      const cfg = makeConfig({
        hatched_at: 1,
        stats_delta: {},
        interaction_count: 0,
      });
      const companion = {
        ...makeCompanion(cfg),
        // Keep stats under milestone thresholds so we exercise the LLM-observe path,
        // and set ENERGY high so recallChance is non-zero.
        stats: { ENERGY: 50, WARMTH: 10, MISCHIEF: 10, WIT: 10, SASS: 10 },
      };
      useBuddyStore.setState({
        config: cfg,
        bones: { ...makeBones(), stats: companion.stats },
        companion: companion as any,
        lastObserveAt: 0,
      });
      // Force Math.random to skip the recall branch (>= 0.1 = never recall).
      const rnd = vi.spyOn(Math, "random").mockReturnValue(0.99);
      mockInvoke({
        save_buddy_config: (args) => args?.config,
        buddy_observe: () => null,
      });
      await useBuddyStore
        .getState()
        .triggerObserve(["太棒了 太棒了 真不错"]);
      const s = useBuddyStore.getState();
      expect(s.config?.interaction_count).toBe(1);
      expect(Object.keys(s.config?.stats_delta || {}).length).toBeGreaterThan(0);
      rnd.mockRestore();
    });

    it("fires a milestone bubble when a stat crosses a threshold", async () => {
      const cfg = makeConfig({
        hatched_at: 1,
        stats_delta: {},
        interaction_count: 0,
      });
      const bones = makeBones();
      // Put ENERGY at 24 so any growth >=1 pushes it over the 25 milestone.
      const companion = {
        ...makeCompanion(cfg),
        stats: {
          ENERGY: 24,
          WARMTH: 10,
          MISCHIEF: 10,
          WIT: 10,
          SASS: 10,
        },
      };
      useBuddyStore.setState({
        config: cfg,
        bones: { ...bones, stats: companion.stats },
        companion: companion as any,
        lastObserveAt: 0,
      });
      // Disable recall/LLM; we only need the milestone branch.
      const rnd = vi.spyOn(Math, "random").mockReturnValue(0.99);
      mockInvoke({
        save_buddy_config: (args) => args?.config,
        buddy_observe: () => null,
      });
      await useBuddyStore
        .getState()
        .triggerObserve(["太棒了 太棒了 真不错"]);
      const s = useBuddyStore.getState();
      expect(s.bubbleText).toMatch(/达到25/);
      rnd.mockRestore();
    });

    // Removed: the memory-recall bubble branch (get_recall_candidates +
    // "还记得那天..." wrapping) was a Plan A buddyStore enhancement that never
    // landed on main. Current triggerObserve has only growth + LLM observe
    // branches, which are exercised by the adjacent tests.

    it("falls back to LLM observe when no growth & no recall triggers", async () => {
      const cfg = makeConfig({
        hatched_at: 1,
        stats_delta: {},
        interaction_count: 0,
      });
      const companion = {
        ...makeCompanion(cfg),
        stats: { ENERGY: 50, WARMTH: 10, MISCHIEF: 10, WIT: 10, SASS: 10 },
      };
      useBuddyStore.setState({
        config: cfg,
        bones: { ...makeBones(), stats: companion.stats },
        companion: companion as any,
        lastObserveAt: 0,
      });
      const rnd = vi.spyOn(Math, "random").mockReturnValue(0.99);
      mockInvoke({
        buddy_observe: () => "witty reply",
      });
      // Messages with no growth keywords.
      await useBuddyStore.getState().triggerObserve(["hmm okay then"]);
      expect(useBuddyStore.getState().bubbleText).toBe("witty reply");
      rnd.mockRestore();
    });

    it("swallows LLM observe errors silently", async () => {
      const cfg = makeConfig({ hatched_at: 1 });
      const companion = {
        ...makeCompanion(cfg),
        stats: { ENERGY: 50, WARMTH: 10, MISCHIEF: 10, WIT: 10, SASS: 10 },
      };
      useBuddyStore.setState({
        config: cfg,
        bones: { ...makeBones(), stats: companion.stats },
        companion: companion as any,
        lastObserveAt: 0,
      });
      const rnd = vi.spyOn(Math, "random").mockReturnValue(0.99);
      mockInvoke({
        buddy_observe: () => {
          throw new Error("llm down");
        },
      });
      await expect(
        useBuddyStore.getState().triggerObserve(["neutral"]),
      ).resolves.toBeUndefined();
      expect(useBuddyStore.getState().bubbleText).toBeNull();
      rnd.mockRestore();
    });

    it("swallows recall invoke errors and still attempts LLM observe", async () => {
      const cfg = makeConfig({ hatched_at: 1 });
      const companion = {
        ...makeCompanion(cfg),
        stats: { ENERGY: 100, WARMTH: 10, MISCHIEF: 10, WIT: 10, SASS: 10 },
      };
      useBuddyStore.setState({
        config: cfg,
        bones: { ...makeBones(), stats: companion.stats },
        companion: companion as any,
        lastObserveAt: 0,
      });
      // Random=0 → tries recall; recall throws → catch → continues to LLM.
      const rnd = vi.spyOn(Math, "random").mockReturnValue(0);
      mockInvoke({
        get_recall_candidates: () => {
          throw new Error("recall down");
        },
        buddy_observe: () => "fallback reaction",
      });
      await useBuddyStore.getState().triggerObserve(["neutral"]);
      expect(useBuddyStore.getState().bubbleText).toBe("fallback reaction");
      rnd.mockRestore();
    });
  });
});
