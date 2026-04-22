import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { mockInvoke } from "../test-utils/mockTauri";
import "../i18n";
import { ToastProvider } from "../components/Toast";
import { MCPPage } from "./MCP";

function renderPage(embedded?: boolean) {
  return render(
    <ToastProvider>
      <MCPPage embedded={embedded} />
    </ToastProvider>,
  );
}

describe("MCPPage embedded prop", () => {
  beforeEach(() => {
    mockInvoke({
      list_mcp_clients: () => [],
    });
  });

  it("renders its own PageHeader title when embedded is false (default)", () => {
    renderPage();
    // mcp.title → 'MCP 客户端'.
    expect(
      screen.getByRole("heading", { level: 1, name: "MCP 客户端" }),
    ).toBeInTheDocument();
  });

  it("does NOT render its own PageHeader title when embedded is true", () => {
    renderPage(true);
    expect(
      screen.queryByRole("heading", { level: 1, name: "MCP 客户端" }),
    ).not.toBeInTheDocument();
  });
});
