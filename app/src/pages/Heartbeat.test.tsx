import "../i18n";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import { ToastProvider } from "../components/Toast";
import { HeartbeatPage } from "./Heartbeat";
import type { HeartbeatConfig, HeartbeatHistoryItem } from "../api/heartbeat";

const invokeMock = invoke as unknown as Mock;

function renderPage() {
  return render(
    <ToastProvider>
      <HeartbeatPage />
    </ToastProvider>,
  );
}

describe("HeartbeatPage", () => {
  const defaultConfig: HeartbeatConfig = {
    enabled: true,
    every: "30m",
    target: "main",
  };

  beforeEach(() => {
    mockInvoke({
      get_heartbeat_config: () => defaultConfig,
      get_heartbeat_history: () => [] as HeartbeatHistoryItem[],
    });
  });

  it("renders the form prefilled from get_heartbeat_config and fires both mount invokes", async () => {
    renderPage();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("get_heartbeat_config"),
    );
    expect(invokeMock).toHaveBeenCalledWith("get_heartbeat_history", {
      limit: 10,
    });
    // Interval number input should reflect 30 (parsed from "30m").
    const numberInput = await screen.findByDisplayValue("30");
    expect(numberInput).toBeInTheDocument();
    // Page title.
    expect(
      screen.getByRole("heading", { level: 1, name: "心跳监控" }),
    ).toBeInTheDocument();
    // Empty history placeholder.
    expect(screen.getByText("暂无心跳记录")).toBeInTheDocument();
  });

  it("saves updated config when the save button is clicked", async () => {
    mockInvoke({
      get_heartbeat_config: () => defaultConfig,
      get_heartbeat_history: () => [],
      save_heartbeat_config: (args) => args?.config ?? defaultConfig,
    });
    renderPage();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("get_heartbeat_config"),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /保存配置/ }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "save_heartbeat_config",
        expect.objectContaining({
          config: expect.objectContaining({
            enabled: true,
            every: "30m",
            target: "main",
          }),
        }),
      );
    });
  });

  it("renders history rows when get_heartbeat_history returns entries", async () => {
    const history: HeartbeatHistoryItem[] = [
      {
        timestamp: Date.UTC(2026, 3, 20, 10, 0, 0),
        target: "main",
        success: true,
        message: "ok-msg",
      },
      {
        timestamp: Date.UTC(2026, 3, 20, 11, 0, 0),
        target: "last",
        success: false,
        message: "fail-msg",
      },
    ];
    mockInvoke({
      get_heartbeat_config: () => defaultConfig,
      get_heartbeat_history: () => history,
    });
    renderPage();

    expect(await screen.findByText("ok-msg")).toBeInTheDocument();
    expect(screen.getByText("fail-msg")).toBeInTheDocument();
    // Both target labels resolved via i18n ("主频道" / "最后活跃").
    expect(screen.getAllByText("主频道").length).toBeGreaterThan(0);
    expect(screen.getAllByText("最后活跃").length).toBeGreaterThan(0);
  });

  it("invokes send_heartbeat and refreshes history when 'send now' is clicked", async () => {
    mockInvoke({
      get_heartbeat_config: () => defaultConfig,
      get_heartbeat_history: () => [],
      send_heartbeat: () => ({ success: true, message: "sent" }),
    });
    renderPage();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("get_heartbeat_config"),
    );

    const historyCallsBefore = invokeMock.mock.calls.filter(
      (c) => c[0] === "get_heartbeat_history",
    ).length;

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /立即发送/ }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("send_heartbeat"),
    );
    await waitFor(() => {
      const historyCallsNow = invokeMock.mock.calls.filter(
        (c) => c[0] === "get_heartbeat_history",
      ).length;
      expect(historyCallsNow).toBeGreaterThan(historyCallsBefore);
    });
  });

  it("degrades gracefully when mount-time config fetch rejects (renders with defaults)", async () => {
    mockInvoke({
      get_heartbeat_config: () => {
        throw new Error("boom");
      },
      get_heartbeat_history: () => [],
    });
    renderPage();
    // Default in-component config is { enabled: false, every: '6h', target: 'last' }.
    // After the failed fetch, loading flips to false and the form still renders;
    // there should be multiple "未启用" labels (status bar + active-hours toggle).
    await waitFor(() => {
      expect(screen.getAllByText("未启用").length).toBeGreaterThanOrEqual(1);
    });
    // Interval input reflects the default "6h".
    expect(screen.getByDisplayValue("6")).toBeInTheDocument();
  });
});
