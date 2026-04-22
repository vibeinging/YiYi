import "../i18n";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import { ToastProvider } from "./Toast";
import { BuddyPanel } from "./BuddyPanel";
import { useBuddyStore } from "../stores/buddyStore";
import { useMeditationStore } from "../stores/meditationStore";
import type { BuddyConfig } from "../api/buddy";
import type { Companion, CompanionBones } from "../utils/buddy";

// BuddyPanel scrolls memory/meditation lists internally; polyfill just in case.
Element.prototype.scrollIntoView = vi.fn();

const invokeMock = invoke as unknown as Mock;

// Snapshot store pristine state so each test resets cleanly.
const BUDDY_PRISTINE = useBuddyStore.getState();
const MEDITATION_PRISTINE = useMeditationStore.getState();

function makeBones(): CompanionBones {
  return {
    species: "circle",
    palette: { name: "极光", from: "#6EE7B7", to: "#3B82F6" },
    particle: "stars",
    idleStyle: "breathe",
    sizeScale: 1,
    shiny: false,
    stats: { ENERGY: 60, WARMTH: 50, MISCHIEF: 40, WIT: 55, SASS: 45 },
  };
}

function makeCompanion(): Companion {
  const bones = makeBones();
  return {
    ...bones,
    name: "YiYi",
    personality: "活泼开朗",
    hatchedAt: Date.now() - 7 * 86_400_000, // 7 days ago
  };
}

function makeBuddyConfig(overrides: Partial<BuddyConfig> = {}): BuddyConfig {
  return {
    name: "YiYi",
    personality: "活泼开朗",
    hatched_at: Date.now() - 7 * 86_400_000,
    muted: false,
    buddy_user_id: "test-user-id",
    stats_delta: {},
    interaction_count: 12,
    hosted_mode: false,
    pet_count: 0,
    delegation_count: 0,
    trust_scores: {},
    trust_overall: 0,
    ...overrides,
  };
}

/**
 * Seed buddyStore so `notHatched` is false and the main UI renders.
 * Without a companion + bones, BuddyPanel short-circuits to the
 * "尚未孵化" placeholder and none of the bootstrap commands matter.
 */
function seedBuddyStore(overrides: Partial<ReturnType<typeof useBuddyStore.getState>> = {}) {
  useBuddyStore.setState({
    ...BUDDY_PRISTINE,
    config: makeBuddyConfig(),
    loaded: true,
    bones: makeBones(),
    companion: makeCompanion(),
    aiName: "YiYi",
    ...overrides,
  });
}

function resetMeditationStore(overrides: Partial<ReturnType<typeof useMeditationStore.getState>> = {}) {
  useMeditationStore.setState({
    ...MEDITATION_PRISTINE,
    isRunning: false,
    ...overrides,
  });
}

// Realistic happy-path response shapes for every mount-time command.
function bootstrapRoutes(overrides: Record<string, (args?: any) => unknown> = {}) {
  return {
    // api/buddy wrappers
    get_memory_stats: () => ({
      total: 42,
      by_category: { fact: 10, preference: 8, experience: 12, decision: 7, principle: 5 },
    }),
    list_recent_memories: () => [],
    list_recent_episodes: () => [],
    list_corrections: () => [],
    list_meditation_sessions: () => [],
    list_buddy_decisions: () => [],
    get_trust_stats: () => ({
      total: 5,
      good: 4,
      bad: 1,
      pending: 0,
      accuracy: 0.8,
      by_context: {},
    }),
    // inline invoke() calls in BuddyPanel
    get_meditation_config: () => ({
      enabled: false,
      start_time: "02:00",
      notify_on_complete: true,
    }),
    get_latest_meditation: () => null,
    get_personality_stats: () => [],
    get_personality_timeline: () => [],
    list_sparkling_memories: () => [],
    get_identity_traits: () => [],
    // Called by meditationStore polling tick on module-load + trigger.
    get_meditation_status: () => "idle",
    // May be called by user interactions (triggerMeditation / search / delete).
    trigger_meditation: () => undefined,
    search_memories: () => [],
    save_meditation_config: () => undefined,
    toggle_sparkling_memory: () => undefined,
    delete_memory: () => undefined,
    set_decision_feedback: () => undefined,
    toggle_buddy_hosted: () => true,
    ...overrides,
  };
}

function renderPanel(
  routeOverrides: Record<string, (args?: any) => unknown> = {},
  storeOverrides: Partial<ReturnType<typeof useBuddyStore.getState>> = {},
) {
  mockInvoke(bootstrapRoutes(routeOverrides));
  seedBuddyStore(storeOverrides);
  return render(
    <ToastProvider>
      <BuddyPanel />
    </ToastProvider>,
  );
}

describe("BuddyPanel", () => {
  beforeEach(() => {
    resetMeditationStore();
  });

  it("renders the 'not hatched' placeholder when companion/bones are missing", () => {
    // Explicitly clear companion + bones so the short-circuit branch triggers.
    useBuddyStore.setState({ ...BUDDY_PRISTINE, companion: null, bones: null, aiName: "YiYi" });
    // Even in the short-circuit path no invoke() fires (the useEffect is below
    // the early return), so leaving invoke un-mocked is safe here.
    render(
      <ToastProvider>
        <BuddyPanel />
      </ToastProvider>,
    );
    expect(screen.getByText("小精灵尚未孵化")).toBeInTheDocument();
  });

  it("fires bootstrap commands on mount and renders the memory total", async () => {
    renderPanel();
    // Every happy-path command should be invoked (matching the actual source useEffect).
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_memory_stats");
      expect(invokeMock).toHaveBeenCalledWith("list_recent_memories", { limit: 15 });
      expect(invokeMock).toHaveBeenCalledWith("list_corrections");
      expect(invokeMock).toHaveBeenCalledWith("list_meditation_sessions", { limit: 10 });
      expect(invokeMock).toHaveBeenCalledWith("list_buddy_decisions", { limit: 20 });
      expect(invokeMock).toHaveBeenCalledWith("get_trust_stats");
      expect(invokeMock).toHaveBeenCalledWith("get_meditation_config");
      expect(invokeMock).toHaveBeenCalledWith("get_latest_meditation");
    });
    // Memory total ("42 条") renders in the SectionTitle pill.
    expect(await screen.findByText("42 条")).toBeInTheDocument();
  });

  it("renders the trust accuracy info when trust stats are present", async () => {
    renderPanel();
    // trustStats.accuracy = 0.8 → rounded to 80%. Source renders "信任度 80%" as a single span.
    expect(await screen.findByText(/信任度 80%/)).toBeInTheDocument();
    expect(await screen.findByText("信任与决策")).toBeInTheDocument();
  });

  it("invokes search_memories with the typed query when the search button is clicked", async () => {
    const user = userEvent.setup();
    renderPanel();
    // Wait for the memory section to render (needs memoryStats.total > 0 to show the input).
    const input = await screen.findByPlaceholderText("搜索记忆...");
    await user.type(input, "cookies");
    // The search button only appears once there's text in the input.
    const searchBtn = await screen.findByRole("button", { name: "搜索" });
    await user.click(searchBtn);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("search_memories", { query: "cookies", limit: 10 });
    });
  });

  it("invokes trigger_meditation when '开始冥想' button is clicked", async () => {
    const user = userEvent.setup();
    renderPanel();
    const btn = await screen.findByRole("button", { name: /开始冥想/ });
    await user.click(btn);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("trigger_meditation");
    });
  });

  it("routes meditation click through useMeditationStore.triggerMeditation (not a bare invoke)", async () => {
    // Regression guard for the refactor that moved trigger_meditation from a
    // direct invoke() in BuddyPanel to the store action. If a future change
    // reverts to calling invoke directly, the store's isRunning would never
    // flip and onComplete listeners would go stale.
    const user = userEvent.setup();
    const spy = vi.spyOn(useMeditationStore.getState(), "triggerMeditation");
    renderPanel();
    const btn = await screen.findByRole("button", { name: /开始冥想/ });
    await user.click(btn);
    await waitFor(() => {
      expect(spy).toHaveBeenCalled();
    });
    // Store action synchronously flips isRunning=true after the await invoke().
    await waitFor(() => {
      expect(useMeditationStore.getState().isRunning).toBe(true);
    });
  });

  it("renders correction rows with 'correct_behavior' text from list_corrections", async () => {
    renderPanel({
      list_corrections: () => [
        {
          trigger: "被问到敏感信息",
          correct_behavior: "礼貌拒绝并说明原因",
          source: "user",
          confidence: 0.9,
        },
      ],
    });
    expect(await screen.findByText(/礼貌拒绝并说明原因/)).toBeInTheDocument();
    expect(await screen.findByText(/被问到敏感信息/)).toBeInTheDocument();
    expect(await screen.findByText("学到的规矩")).toBeInTheDocument();
  });

  it("renders the empty memory placeholder when get_memory_stats returns total=0", async () => {
    renderPanel({
      get_memory_stats: () => ({ total: 0, by_category: {} }),
      list_recent_memories: () => [],
      get_trust_stats: () => ({ total: 0, good: 0, bad: 0, pending: 0, accuracy: 0, by_context: {} }),
    });
    // Source renders "暂无记忆" in the memory list when both recent + search are empty.
    expect(await screen.findByText("暂无记忆")).toBeInTheDocument();
    // The "0 条" counter pill proves the bootstrap data arrived.
    expect(await screen.findByText("0 条")).toBeInTheDocument();
  });
});
