import "../i18n";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToastProvider } from "../components/Toast";
import { BuddyPage } from "./Buddy";
import { useBuddyStore } from "../stores/buddyStore";

// BuddyPanel children may auto-scroll internally.
Element.prototype.scrollIntoView = vi.fn();

const BUDDY_PRISTINE = useBuddyStore.getState();

describe("BuddyPage", () => {
  it("renders the 'not hatched' placeholder when buddy store has no companion (smoke)", () => {
    // With companion=null BuddyPanel short-circuits and no invoke() fires on mount.
    useBuddyStore.setState({ ...BUDDY_PRISTINE, companion: null, bones: null });
    render(
      <ToastProvider>
        <BuddyPage />
      </ToastProvider>,
    );
    expect(screen.getByText("小精灵尚未孵化")).toBeInTheDocument();
  });

  it("applies the buddy-page wrapper class to its root container", () => {
    useBuddyStore.setState({ ...BUDDY_PRISTINE, companion: null, bones: null });
    const { container } = render(
      <ToastProvider>
        <BuddyPage />
      </ToastProvider>,
    );
    // Root element should carry 'buddy-page' so the global scoped CSS hooks apply.
    expect(container.querySelector(".buddy-page")).not.toBeNull();
  });
});
