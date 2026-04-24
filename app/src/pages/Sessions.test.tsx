import "../i18n";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import { ToastProvider } from "../components/Toast";
import { SessionsPanel } from "./Sessions";
import type { BotSession } from "../api/bots";

const invokeMock = invoke as unknown as Mock;

function makeSession(overrides: Partial<BotSession> = {}): BotSession {
  return {
    id: "sess-1",
    name: "Alice",
    source: "discord",
    source_meta: "#general",
    created_at: Date.now() - 86_400_000,
    updated_at: Date.now() - 3_600_000,
    ...overrides,
  } as BotSession;
}

function renderPanel(routes: Record<string, (args?: any) => unknown> = {}) {
  mockInvoke({
    bots_list_sessions: () => [],
    get_history: () => [],
    clear_history: () => undefined,
    ...routes,
  });
  return render(
    <ToastProvider>
      <SessionsPanel />
    </ToastProvider>,
  );
}

describe("SessionsPanel", () => {
  beforeEach(() => {
    // Reset handled per-test via mockInvoke.
  });

  it("invokes bots_list_sessions on mount and renders the empty state when none exist", async () => {
    renderPanel({ bots_list_sessions: () => [] });
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("bots_list_sessions");
    });
    // Empty state uses sessions.noSessions + sessions.emptyDesc.
    expect(await screen.findByText("暂无会话记录")).toBeInTheDocument();
    expect(
      screen.getByText(/当分身连接并有用户互动后/),
    ).toBeInTheDocument();
  });

  it("renders loaded sessions with name + source pill", async () => {
    renderPanel({
      bots_list_sessions: () => [
        makeSession({ id: "sess-1", name: "Alice", source: "discord" }),
        makeSession({ id: "sess-2", name: "Bob", source: "telegram", source_meta: "@bob" }),
      ],
    });
    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(await screen.findByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("discord")).toBeInTheDocument();
    expect(screen.getByText("telegram")).toBeInTheDocument();
  });

  it("loads messages via get_history when a session row is clicked", async () => {
    const user = userEvent.setup();
    renderPanel({
      bots_list_sessions: () => [makeSession({ id: "sess-1", name: "Alice" })],
      get_history: () => [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ],
    });
    const row = await screen.findByText("Alice");
    await user.click(row);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_history", {
        sessionId: "sess-1",
        limit: 50,
      });
    });
    expect(await screen.findByText("hello")).toBeInTheDocument();
    expect(await screen.findByText("hi there")).toBeInTheDocument();
  });

  it("filters sessions by search query", async () => {
    const user = userEvent.setup();
    renderPanel({
      bots_list_sessions: () => [
        makeSession({ id: "sess-1", name: "Alice" }),
        makeSession({ id: "sess-2", name: "Bob" }),
      ],
    });
    await screen.findByText("Alice");
    const search = screen.getByPlaceholderText("搜索会话...");
    await user.type(search, "ali");
    // Only Alice matches; Bob should be filtered out.
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.queryByText("Bob")).not.toBeInTheDocument();
  });

  it("clears history after user confirms, invoking clear_history with the session id", async () => {
    const user = userEvent.setup();
    renderPanel({
      bots_list_sessions: () => [makeSession({ id: "sess-1", name: "Alice" })],
      get_history: () => [{ role: "user", content: "msg" }],
      clear_history: () => undefined,
    });
    await user.click(await screen.findByText("Alice"));
    await screen.findByText("msg");
    // Click "清除历史" → opens confirm dialog.
    await user.click(screen.getByRole("button", { name: /清除历史/ }));
    // Confirm dialog renders "确定" button.
    const confirmBtn = await screen.findByRole("button", { name: "确认" });
    await user.click(confirmBtn);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("clear_history", {
        sessionId: "sess-1",
      });
    });
  });

  it("degrades gracefully when bots_list_sessions fails (renders empty state, no crash)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    renderPanel({
      bots_list_sessions: () => {
        throw new Error("db offline");
      },
    });
    // Should still end in the empty state (sessions stays []), not throw.
    expect(await screen.findByText("暂无会话记录")).toBeInTheDocument();
    errorSpy.mockRestore();
  });
});
