import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import "../i18n";
import { SetupWizard } from "./SetupWizard";

const invokeMock = invoke as unknown as Mock;

// SetupWizard calls `transitionTo` with two staggered setTimeouts (250ms +
// 30ms) per step change — we use fake timers in the navigation tests so we
// don't actually have to wait 280ms wall-clock each hop. Wrap the timer
// flush in act() so the resulting state updates don't trigger warnings.
async function flushAllTimers() {
  await act(async () => {
    await vi.runAllTimersAsync();
  });
}

describe("SetupWizard", () => {
  beforeEach(() => {
    // The wizard does not invoke any Tauri command on initial mount (it only
    // reads `localStorage.language`). Commands are fired when the user clicks
    // through to later steps. The default is therefore an empty mock set —
    // each test installs what it needs.
    mockInvoke({});
  });

  it("renders the language step with both language options visible initially", () => {
    render(<SetupWizard onComplete={() => {}} />);
    // The StepLanguage component renders a "选择你偏好的语言" subtitle when
    // language is Chinese. localStorage default is empty → falls back to "zh".
    expect(
      screen.getByRole("heading", { name: /欢迎使用 YiYi/ }),
    ).toBeInTheDocument();
    // Two language option buttons.
    expect(
      screen.getByRole("button", { name: /中文/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /English/ }),
    ).toBeInTheDocument();
    // Next button uses i18n common.next = "下一步".
    expect(
      screen.getByRole("button", { name: /下一步/ }),
    ).toBeInTheDocument();
  });

  it("advances from language step to model step when Next is clicked", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    try {
      render(<SetupWizard onComplete={() => {}} />);
      const nextBtn = screen.getByRole("button", { name: /下一步/ });
      await user.click(nextBtn);
      // Let the step-transition timeouts (250ms + 30ms) run.
      await flushAllTimers();
      // Model step heading (Chinese): "选择你的 AI 引擎".
      await waitFor(() => {
        expect(
          screen.getByRole("heading", { name: /选择你的 AI 引擎/ }),
        ).toBeInTheDocument();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders the memory step info card with the built-in BGE model", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    // The wizard loads the workspace path when entering the workspace step —
    // install the mock routes up front so we never hit the "not mocked" error.
    mockInvoke({
      get_user_workspace: () => "/Users/test/Documents/YiYi",
      list_authorized_folders: () => [],
    });
    try {
      render(<SetupWizard onComplete={() => {}} />);
      // Hop: language → model → workspace → persona → memory.
      // Each hop is a Next click + timer flush. StepModel requires provider +
      // API key before Next is enabled, so we use the optional "跳过" (Skip)
      // button that's rendered on the model and workspace steps instead.

      // language → model
      await user.click(screen.getByRole("button", { name: /^下一步$/ }));
      await flushAllTimers();

      // model → workspace (via Skip)
      await user.click(screen.getByRole("button", { name: /^跳过$/ }));
      await flushAllTimers();

      // workspace → persona (via Skip)
      await user.click(screen.getByRole("button", { name: /^跳过$/ }));
      await flushAllTimers();

      // persona → memory (default role is "assistant", so canProceed=true)
      await user.click(screen.getByRole("button", { name: /^下一步$/ }));
      await flushAllTimers();

      // The memory step renders the Memory Engine heading (Plan A BGE-only
      // info card never landed; the current StepMemory renders the full
      // preset-based embedding config UI).
      await waitFor(() => {
        expect(
          screen.getByRole("heading", { name: /记忆引擎/ }),
        ).toBeInTheDocument();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("goBack transitions from model step back to language step", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    try {
      render(<SetupWizard onComplete={() => {}} />);
      // Move to step 2 (model).
      await user.click(screen.getByRole("button", { name: /^下一步$/ }));
      await flushAllTimers();
      await waitFor(() => {
        expect(
          screen.getByRole("heading", { name: /选择你的 AI 引擎/ }),
        ).toBeInTheDocument();
      });
      // Now the Back button appears (stepIndex > 0).
      const backBtn = screen.getByRole("button", { name: /^返回$/ });
      await user.click(backBtn);
      await flushAllTimers();
      await waitFor(() => {
        expect(
          screen.getByRole("heading", { name: /欢迎使用 YiYi/ }),
        ).toBeInTheDocument();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("invokes save_meditation_config, save_workspace_file, save_agents_config and complete_setup on Finish", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onComplete = vi.fn();
    mockInvoke({
      get_user_workspace: () => "/Users/test/Documents/YiYi",
      list_authorized_folders: () => [],
      save_memme_config: () => null,
      save_meditation_config: () => null,
      save_workspace_file: () => null,
      save_agents_config: () => null,
      complete_setup: () => null,
    });
    try {
      render(<SetupWizard onComplete={onComplete} />);

      // Navigate: language → model → workspace → persona → memory → meditation.
      await user.click(screen.getByRole("button", { name: /^下一步$/ })); // language → model
      await flushAllTimers();
      await user.click(screen.getByRole("button", { name: /^跳过$/ })); // model → workspace
      await flushAllTimers();
      await user.click(screen.getByRole("button", { name: /^跳过$/ })); // workspace → persona
      await flushAllTimers();
      await user.click(screen.getByRole("button", { name: /^下一步$/ })); // persona → memory
      await flushAllTimers();
      await user.click(screen.getByRole("button", { name: /^下一步$/ })); // memory → meditation
      await flushAllTimers();

      // Now we are on the meditation step — the next button text changes.
      const finishBtn = await screen.findByRole("button", {
        name: /开始使用/,
      });
      await user.click(finishBtn);
      // Allow the async handleFinish promise chain to flush.
      await flushAllTimers();

      await waitFor(() => {
        expect(invokeMock).toHaveBeenCalledWith(
          "save_meditation_config",
          expect.objectContaining({
            enabled: true,
            startTime: "23:00",
            notifyOnComplete: true,
          }),
        );
      });
      expect(invokeMock).toHaveBeenCalledWith(
        "save_workspace_file",
        expect.objectContaining({ filename: "SOUL.md" }),
      );
      expect(invokeMock).toHaveBeenCalledWith(
        "save_agents_config",
        expect.objectContaining({ language: expect.any(String) }),
      );
      expect(invokeMock).toHaveBeenCalledWith("complete_setup");
      expect(onComplete).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
