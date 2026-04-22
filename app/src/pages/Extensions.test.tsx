import "../i18n";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import type { Mock } from "vitest";
import { mockInvoke } from "../test-utils/mockTauri";
import { ToastProvider } from "../components/Toast";
import { ExtensionsPage } from "./Extensions";

const invokeMock = invoke as unknown as Mock;

function renderPage() {
  return render(
    <ToastProvider>
      <ExtensionsPage />
    </ToastProvider>,
  );
}

describe("ExtensionsPage", () => {
  beforeEach(() => {
    // Covers the mount-time invokes of SkillsPage (default tab) + PluginsPanel + MCPPage.
    mockInvoke({
      list_skills: () => [],
      get_hub_config: () => ({ url: "https://clawhub.ai" }),
      list_plugins: () => [],
      list_mcp_clients: () => [],
    });
  });

  it("renders the Extensions page header + three tab pills", () => {
    renderPage();
    // Page header from PageHeader wrapper.
    expect(
      screen.getByRole("heading", { level: 1, name: "扩展市场" }),
    ).toBeInTheDocument();
    // Three tab buttons.
    expect(screen.getByRole("button", { name: /技能/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /插件/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /MCP/ })).toBeInTheDocument();
  });

  it("defaults to the Skills tab and passes embedded=true (no inner h1)", () => {
    renderPage();
    // Skills fires list_skills on mount → proves Skills tab is rendered by default.
    expect(invokeMock).toHaveBeenCalledWith(
      "list_skills",
      expect.objectContaining({ enabledOnly: false }),
    );
    // embedded=true means SkillsPage should NOT render its own h1 ("技能管理").
    expect(
      screen.queryByRole("heading", { level: 1, name: "技能管理" }),
    ).not.toBeInTheDocument();
  });

  it("switches to the MCP tab on click and renders MCPPage embedded", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: /MCP/ }));
    // MCP tab firing its mount-time invoke proves it rendered after the switch.
    expect(invokeMock).toHaveBeenCalledWith("list_mcp_clients");
    // embedded=true → no inner "MCP 客户端" h1.
    expect(
      screen.queryByRole("heading", { level: 1, name: "MCP 客户端" }),
    ).not.toBeInTheDocument();
  });

  it("switches to the Plugins tab on click and mounts PluginsPanel", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: /插件/ }));
    expect(invokeMock).toHaveBeenCalledWith("list_plugins");
  });
});
