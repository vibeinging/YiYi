import "@testing-library/jest-dom";
import { vi, beforeEach } from "vitest";

// Default: any invoke() call that isn't explicitly mocked throws loudly so
// tests can't silently get `undefined` and miss assertion gaps. Tests opt in
// with mockInvoke({ command: handler }).
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    throw new Error(
      `invoke("${cmd}") called but not mocked. Use mockInvoke() in your test.`,
    );
  }),
}));

// Event listeners: listen returns a no-op unsubscribe, emit is a silent spy.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
  once: vi.fn(() => Promise.resolve(() => {})),
}));

// Reset all mocks between tests so state doesn't bleed.
beforeEach(() => {
  vi.clearAllMocks();
});
