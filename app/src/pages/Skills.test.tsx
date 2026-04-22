import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { mockInvoke } from "../test-utils/mockTauri";
import "../i18n";
import { ToastProvider } from "../components/Toast";
import { SkillsPage } from "./Skills";

// Plugin-shell `open` is only called on click, so a mount-only test doesn't
// need to mock it. Event listen is already stubbed in setup.ts.

function renderPage(embedded?: boolean) {
  return render(
    <ToastProvider>
      <SkillsPage embedded={embedded} />
    </ToastProvider>,
  );
}

describe("SkillsPage embedded prop", () => {
  beforeEach(() => {
    mockInvoke({
      list_skills: () => [],
      get_hub_config: () => ({ url: "https://clawhub.ai" }),
    });
  });

  it("renders its own PageHeader title when embedded is false (default)", () => {
    renderPage();
    // Header h1 reads skills.title → 技能管理.
    expect(
      screen.getByRole("heading", { level: 1, name: "技能管理" }),
    ).toBeInTheDocument();
  });

  it("does NOT render its own PageHeader title when embedded is true", () => {
    renderPage(true);
    // Extensions.tsx provides the outer header, so the local one must be hidden.
    expect(
      screen.queryByRole("heading", { level: 1, name: "技能管理" }),
    ).not.toBeInTheDocument();
  });
});
