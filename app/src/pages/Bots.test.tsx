import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import "../i18n";
import { ToastProvider } from "../components/Toast";
import { BotsPage } from "./Bots";
import type { BotInfo } from "../api/bots";

const invokeMock = invoke as unknown as Mock;

function renderPage() {
  return render(
    <ToastProvider>
      <BotsPage />
    </ToastProvider>,
  );
}

function makeBot(overrides: Partial<BotInfo> = {}): BotInfo {
  return {
    id: "bot-1",
    name: "My Discord",
    platform: "discord",
    enabled: true,
    config: { token: "xxx" },
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
}

const PLATFORM_LIST = [
  { id: "discord", name: "Discord" },
  { id: "telegram", name: "Telegram" },
  { id: "feishu", name: "飞书" },
];

describe("BotsPage", () => {
  beforeEach(() => {
    // Default mount-time mocks: empty bot list + platforms + statuses.
    mockInvoke({
      bots_list: () => [],
      bots_list_platforms: () => PLATFORM_LIST,
      bots_get_status: () => [],
    });
  });

  it("renders the empty state and header when no bots exist", async () => {
    renderPage();
    expect(screen.getByRole("heading", { name: /分身/ })).toBeInTheDocument();
    // Empty state message appears after the async loadData() settles.
    expect(await screen.findByText("还没有分身")).toBeInTheDocument();
    expect(screen.getByText("创建第一个分身")).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("bots_list");
    expect(invokeMock).toHaveBeenCalledWith("bots_list_platforms");
  });

  it("renders a list of bots returned from the backend", async () => {
    const bots = [
      makeBot(),
      makeBot({
        id: "bot-2",
        name: "Telegram Relay",
        platform: "telegram",
        enabled: false,
      }),
    ];
    mockInvoke({
      bots_list: () => bots,
      bots_list_platforms: () => PLATFORM_LIST,
      bots_get_status: () => [],
    });
    renderPage();
    expect(await screen.findByText("My Discord")).toBeInTheDocument();
    expect(screen.getByText("Telegram Relay")).toBeInTheDocument();
    // Status bar reflects "1 / 2 enabled".
    expect(screen.getByText(/1 \/ 2/)).toBeInTheDocument();
  });

  it("opens the create dialog when clicking '创建分身' and invokes bots_create on save", async () => {
    const user = userEvent.setup();
    let createdName = "";
    mockInvoke({
      bots_list: () => [],
      bots_list_platforms: () => PLATFORM_LIST,
      bots_get_status: () => [],
      bots_create: (args: any) => {
        createdName = args.name;
        return makeBot({ name: args.name });
      },
    });
    renderPage();
    await screen.findByText("还没有分身");

    // Header '创建分身' button.
    await user.click(screen.getByRole("button", { name: /^创建分身$/ }));

    // Dialog — name input placeholder.
    const nameInput = await screen.findByPlaceholderText("例如: 我的 Discord 分身");
    await user.type(nameInput, "New Bot");

    // Click the primary '创建' in the dialog footer (last occurrence).
    const createButtons = screen.getAllByRole("button", { name: /^创建$/ });
    await user.click(createButtons[createButtons.length - 1]);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "bots_create",
        expect.objectContaining({ name: "New Bot", platform: expect.any(String) }),
      );
    });
    expect(createdName).toBe("New Bot");
  });

  it("calls bots_start when clicking '启动全部' with at least one enabled bot", async () => {
    const user = userEvent.setup();
    mockInvoke({
      bots_list: () => [makeBot()],
      bots_list_platforms: () => PLATFORM_LIST,
      bots_get_status: () => [],
      bots_start: () => ({ status: "ok", bots: ["bot-1"] }),
    });
    renderPage();
    await screen.findByText("My Discord");

    await user.click(screen.getByRole("button", { name: /启动全部/ }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("bots_start");
    });
  });

  it("deletes a bot after confirming the dialog", async () => {
    const user = userEvent.setup();
    const bot = makeBot();
    mockInvoke({
      bots_list: () => [bot],
      bots_list_platforms: () => PLATFORM_LIST,
      bots_get_status: () => [],
      bots_delete: () => null,
    });
    const { container } = renderPage();
    await screen.findByText("My Discord");

    // BotCard header has an action row [toggle, edit, delete]. The delete
    // button is the one containing a lucide-trash2 SVG — grab it via CSS.
    const trashSvg = container.querySelector(".lucide-trash2");
    expect(trashSvg).not.toBeNull();
    const deleteBtn = trashSvg!.closest("button")!;
    await user.click(deleteBtn);

    // Confirm dialog.
    await user.click(await screen.findByRole("button", { name: /^确认$/ }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("bots_delete", { botId: bot.id });
    });
  });
});
