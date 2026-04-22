import "../i18n";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import { GrowthPage } from "./Growth";
import type { GrowthData } from "../api/system";

const invokeMock = invoke as unknown as Mock;

function growthData(overrides: Partial<GrowthData> = {}): GrowthData {
  return {
    report: null,
    skill_suggestion: null,
    capabilities: [],
    timeline: [],
    ...overrides,
  };
}

describe("GrowthPage", () => {
  beforeEach(() => {
    // default: empty growth data
    mockInvoke({ get_growth_report: () => growthData() });
  });

  it("renders the empty state when report/capabilities/timeline are all empty", async () => {
    render(<GrowthPage />);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("get_growth_report"),
    );
    // Empty state copy from EmptyState() sub-component (zh translation).
    expect(
      await screen.findByText("YiYi 刚刚起步"),
    ).toBeInTheDocument();
  });

  it("renders stats cards, capability bars, lessons and timeline when data is populated", async () => {
    mockInvoke({
      get_growth_report: () =>
        growthData({
          report: {
            total_tasks: 12,
            success_count: 10,
            failure_count: 1,
            partial_count: 1,
            success_rate: 0.83,
            top_lessons: ["always double-check paths", "prefer small diffs"],
          },
          skill_suggestion: "try the design-review skill",
          capabilities: [
            { name: "Coding", success_rate: 0.9, sample_count: 20, confidence: "high" },
            { name: "Writing", success_rate: 0.5, sample_count: 2, confidence: "low" },
          ],
          timeline: [
            { date: "2026-04-10", event_type: "first_task", title: "t1", description: "Completed first real task" },
            { date: "2026-04-15", event_type: "lesson_learned", title: "t2", description: "Learned to validate input" },
          ],
        }),
    });

    render(<GrowthPage />);

    // Success rate stat card → 83%.
    expect(await screen.findByText("83%")).toBeInTheDocument();
    // Capability profile pill + bar.
    expect(screen.getByText("Capability Profile")).toBeInTheDocument();
    expect(screen.getByText("Coding")).toBeInTheDocument();
    // Low confidence footnote on the writing row.
    expect(screen.getByText(/Low confidence/)).toBeInTheDocument();
    // Lesson entries rendered.
    expect(screen.getByText("always double-check paths")).toBeInTheDocument();
    // Skill suggestion banner.
    expect(screen.getByText("try the design-review skill")).toBeInTheDocument();
    // Timeline.
    expect(screen.getByText("Growth Timeline")).toBeInTheDocument();
    expect(screen.getByText("Completed first real task")).toBeInTheDocument();
  });

  it("re-invokes get_growth_report when the refresh button is clicked", async () => {
    render(<GrowthPage />);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("get_growth_report"),
    );
    const callsAfterMount = invokeMock.mock.calls.filter(
      (c) => c[0] === "get_growth_report",
    ).length;

    const user = userEvent.setup();
    // Refresh button lives in the PageHeader actions slot; find by accessible name.
    // Header actions button has text "Refresh" (fallback i18n).
    const buttons = screen.getAllByRole("button");
    const refresh = buttons.find((b) => /Refresh|刷新/i.test(b.textContent || ""));
    expect(refresh).toBeDefined();
    await user.click(refresh!);

    await waitFor(() => {
      const callsNow = invokeMock.mock.calls.filter(
        (c) => c[0] === "get_growth_report",
      ).length;
      expect(callsNow).toBeGreaterThan(callsAfterMount);
    });
  });

  it("degrades gracefully when get_growth_report rejects (stays on empty state, no crash)", async () => {
    mockInvoke({
      get_growth_report: () => {
        throw new Error("backend boom");
      },
    });
    render(<GrowthPage />);
    // After the failed fetch, loading flips to false and the empty state renders.
    expect(
      await screen.findByText("YiYi 刚刚起步"),
    ).toBeInTheDocument();
  });
});
