import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import "../i18n";
import { ToastProvider } from "../components/Toast";
import { ChannelsPage } from "./Channels";
import type { ChannelInfo } from "../api/channels";

// plugin-shell `open` is imported at module top; stub so tests don't blow up
// when the user clicks an "External docs" link.
vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn(() => Promise.resolve()),
}));

const invokeMock = invoke as unknown as Mock;

function renderPage() {
  return render(
    <ToastProvider>
      <ChannelsPage />
    </ToastProvider>,
  );
}

function makeChannel(overrides: Partial<ChannelInfo> = {}): ChannelInfo {
  return {
    id: "dingtalk",
    name: "DingTalk",
    channel_type: "dingtalk",
    enabled: false,
    ...overrides,
  };
}

describe("ChannelsPage", () => {
  beforeEach(() => {
    // Default mount-time mocks: empty channel list + empty envs.
    mockInvoke({
      channels_list: () => [],
      list_envs: () => [],
    });
  });

  it("renders header and all 7 built-in channel rows with default status bar", async () => {
    renderPage();
    // PageHeader h1.
    expect(
      screen.getByRole("heading", { name: /频道管理/ }),
    ).toBeInTheDocument();
    // Status bar: "0 / 7 已启用".
    expect(await screen.findByText(/0 \/ 7/)).toBeInTheDocument();
    // Each channel row renders its type string as sub-label.
    for (const type of [
      "dingtalk",
      "feishu",
      "discord",
      "telegram",
      "qq",
      "wecom",
      "webhook",
    ]) {
      expect(screen.getByText(type)).toBeInTheDocument();
    }
    expect(invokeMock).toHaveBeenCalledWith("channels_list");
    expect(invokeMock).toHaveBeenCalledWith("list_envs");
  });

  it("shows enabled count when channels are enabled in the backend", async () => {
    mockInvoke({
      channels_list: () => [
        makeChannel({ id: "dingtalk", enabled: true }),
        makeChannel({ id: "discord", channel_type: "discord", enabled: true }),
      ],
      list_envs: () => [
        { key: "DINGTALK_WEBHOOK_URL", value: "https://example.com" },
      ],
    });
    renderPage();
    // 2 / 7 enabled.
    expect(await screen.findByText(/2 \/ 7/)).toBeInTheDocument();
  });

  it("calls channels_update when toggling a channel via its switch", async () => {
    const user = userEvent.setup();
    mockInvoke({
      channels_list: () => [],
      list_envs: () => [],
      channels_update: () => null,
    });
    const { container } = renderPage();
    await screen.findByText(/0 \/ 7/);

    // Each channel row renders a checkbox inside a label. Grab the first
    // (dingtalk is the first in ALL_CHANNEL_TYPES) and click it.
    const checkboxes = container.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(checkboxes.length).toBe(7);
    await user.click(checkboxes[0]);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "channels_update",
        expect.objectContaining({ channelName: "dingtalk", enabled: true }),
      );
    });
  });

  it("expands a channel row on click and saves its env config via save_envs", async () => {
    const user = userEvent.setup();
    mockInvoke({
      channels_list: () => [],
      list_envs: () => [],
      save_envs: () => null,
    });
    renderPage();
    await screen.findByText(/0 \/ 7/);

    // Click the Telegram header row to expand (contains the text 'telegram').
    await user.click(screen.getByText("telegram"));

    // The only env key for Telegram is TELEGRAM_BOT_TOKEN. Confirm the
    // password input surfaces by filling it in.
    const tokenLabel = await screen.findByText("TELEGRAM_BOT_TOKEN");
    const tokenInput = tokenLabel
      .closest("label")!
      .parentElement!.querySelector("input")!;
    await user.type(tokenInput, "abc123:secret");

    // Save button uses the 'channels.saveConfig' key, which is not defined in
    // the 'channels' namespace — i18next falls back to rendering the raw key.
    const saveBtn = screen.getByRole("button", { name: /channels\.saveConfig/ });
    await user.click(saveBtn);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "save_envs",
        expect.objectContaining({
          envs: expect.arrayContaining([
            expect.objectContaining({
              key: "TELEGRAM_BOT_TOKEN",
              value: "abc123:secret",
            }),
          ]),
        }),
      );
    });
  });

  it("opens the send-message modal and sends a message via channels_send", async () => {
    const user = userEvent.setup();
    mockInvoke({
      channels_list: () => [],
      list_envs: () => [],
      channels_send: () => ({ status: "ok" }),
    });
    renderPage();
    await screen.findByText(/0 \/ 7/);

    // Open send modal via the header 'channels.sendMessage' button (i18n key
    // is missing in the zh 'channels' namespace so the raw key is rendered).
    await user.click(screen.getByRole("button", { name: /channels\.sendMessage/ }));
    // Modal heading exists.
    expect(
      await screen.findByRole("heading", { name: /channels\.sendTitle/ }),
    ).toBeInTheDocument();

    // Fill target + content.
    const targetInput = screen.getByPlaceholderText("channels.targetIdPlaceholder");
    await user.type(targetInput, "user-42");
    const contentBox = screen
      .getByText(/channels\.messageContent/)
      .parentElement!.querySelector("textarea")!;
    await user.type(contentBox, "hello world");

    // Click the primary send button (common.send -> '发送'). The header button
    // we clicked earlier renders 'channels.sendMessage' (raw key), so the
    // only '发送' button in the DOM is the footer submit.
    await user.click(screen.getByRole("button", { name: /^发送$/ }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "channels_send",
        expect.objectContaining({
          channelType: "dingtalk",
          target: "user-42",
          content: "hello world",
        }),
      );
    });
  });

  it("swallows mount-time backend errors without crashing", async () => {
    // channels_list rejects — loadData's catch sets loading=false and leaves
    // the channels list empty, so the status bar still renders '0 / 7'.
    mockInvoke({
      channels_list: () => {
        throw new Error("backend exploded");
      },
      list_envs: () => [],
    });
    renderPage();
    expect(await screen.findByText(/0 \/ 7/)).toBeInTheDocument();
  });
});
