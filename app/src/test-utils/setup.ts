import "@testing-library/jest-dom";
import { vi, beforeEach } from "vitest";

// jsdom lacks ResizeObserver; CollapsibleContent (and anything using it
// transitively) crashes without a polyfill. Stub with a no-op.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as any;
}

// Node 26 + jsdom 25 组合下 window 在而 window.localStorage 缺失(2026-06-11 npm
// 重装后出现,致 sessionStore 等用 localStorage 的测试整批 TypeError)。内存实现
// 兜底 —— 业务代码只用 get/set/remove/clear,语义等价。
if (typeof globalThis.localStorage === "undefined") {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(String(k), String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

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
