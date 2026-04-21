import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockInvoke, expectInvokedWith } from "../test-utils/mockTauri";

/**
 * meditationStore kicks off a setInterval(2000) polling loop at module load
 * that calls `invoke('get_meditation_status')`. To keep each test deterministic
 * we use `vi.resetModules()` + dynamic import so every test gets a FRESH module
 * scope — including a fresh `pollTimer` and a fresh internal `listeners` Set.
 * That lets us test `_ensurePolling` behaviour (which bails when pollTimer is
 * non-null) under controlled conditions.
 */

type Store = typeof import("./meditationStore")["useMeditationStore"];

async function freshStore(
  routes: Record<string, (args?: Record<string, unknown>) => unknown>,
): Promise<Store> {
  vi.resetModules();
  mockInvoke(routes);
  // Dynamic import so the module-level `useMeditationStore.getState()._ensurePolling()`
  // line runs with our mocks already wired.
  const mod = await import("./meditationStore");
  // Give the bootstrap tick's awaited invoke() a microtask to resolve.
  await Promise.resolve();
  await Promise.resolve();
  return mod.useMeditationStore;
}

describe("meditationStore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("initial state (fresh module load with idle backend)", () => {
    it("starts with isRunning=false after bootstrap sees an idle backend", async () => {
      const store = await freshStore({ get_meditation_status: () => "idle" });
      expect(store.getState().isRunning).toBe(false);
    });

    it("bootstrap flips isRunning to true when module loads mid-running meditation", async () => {
      const store = await freshStore({
        get_meditation_status: () => "running",
      });
      // The bootstrap tick fires synchronously at import — give its awaited
      // invoke one more microtask.
      await new Promise((r) => setTimeout(r, 0));
      expect(store.getState().isRunning).toBe(true);
    });

    it("exposes triggerMeditation, onComplete, and _ensurePolling actions", async () => {
      const store = await freshStore({ get_meditation_status: () => "idle" });
      const s = store.getState();
      expect(typeof s.triggerMeditation).toBe("function");
      expect(typeof s.onComplete).toBe("function");
      expect(typeof s._ensurePolling).toBe("function");
    });
  });

  describe("triggerMeditation", () => {
    it("invokes trigger_meditation and flips isRunning=true", async () => {
      // Bootstrap sees idle, then the caller triggers a new meditation and the
      // post-trigger poll still shows 'running' so the flag stays true.
      const store = await freshStore({
        get_meditation_status: () => "running",
        trigger_meditation: () => null,
      });
      await Promise.resolve(); // let bootstrap tick resolve
      // Reset isRunning because bootstrap (under 'running') would have flipped it.
      store.setState({ isRunning: false });
      await store.getState().triggerMeditation();
      expect(store.getState().isRunning).toBe(true);
      expectInvokedWith("trigger_meditation");
    });

    it("is a no-op when isRunning is already true (backend singleton guard)", async () => {
      const triggerSpy = vi.fn();
      const store = await freshStore({
        get_meditation_status: () => "running",
        trigger_meditation: () => {
          triggerSpy();
          return null;
        },
      });
      // Force isRunning=true (mimicking an already-running session picked up by bootstrap).
      store.setState({ isRunning: true });
      await store.getState().triggerMeditation();
      expect(triggerSpy).not.toHaveBeenCalled();
      expect(store.getState().isRunning).toBe(true);
    });

    it("propagates backend errors and does not flip isRunning=true", async () => {
      const store = await freshStore({
        get_meditation_status: () => "idle",
        trigger_meditation: () => {
          throw new Error("already running");
        },
      });
      await expect(store.getState().triggerMeditation()).rejects.toThrow(
        "already running",
      );
      expect(store.getState().isRunning).toBe(false);
    });
  });

  describe("onComplete listener registration", () => {
    it("returns a function that removes the listener when invoked", async () => {
      const store = await freshStore({ get_meditation_status: () => "idle" });
      const fn = vi.fn();
      const unsub = store.getState().onComplete(fn);
      expect(typeof unsub).toBe("function");
      expect(() => unsub()).not.toThrow();
      // Calling again is idempotent (Set.delete on absent key is a no-op).
      expect(() => unsub()).not.toThrow();
    });

    it("registered listeners fire when polling detects the running -> idle transition", async () => {
      // Bootstrap runs with 'running', flipping isRunning=true + scheduling the interval.
      // Then we swap the mock to 'idle' so the NEXT interval tick transitions false
      // and fires listeners.
      vi.useFakeTimers();
      const store = await freshStore({
        get_meditation_status: () => "running",
      });
      // Let bootstrap tick resolve.
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getState().isRunning).toBe(true);

      const listener = vi.fn();
      store.getState().onComplete(listener);

      // Swap mock to idle.
      mockInvoke({ get_meditation_status: () => "idle" });
      // Advance past the 2s interval.
      await vi.advanceTimersByTimeAsync(2001);

      expect(store.getState().isRunning).toBe(false);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("unsubscribed listeners do not fire on the transition", async () => {
      vi.useFakeTimers();
      const store = await freshStore({
        get_meditation_status: () => "running",
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getState().isRunning).toBe(true);

      const listener = vi.fn();
      const unsub = store.getState().onComplete(listener);
      unsub(); // unsubscribe BEFORE the transition happens

      mockInvoke({ get_meditation_status: () => "idle" });
      await vi.advanceTimersByTimeAsync(2001);

      expect(store.getState().isRunning).toBe(false);
      expect(listener).not.toHaveBeenCalled();
    });

    it("tolerates a listener that throws and still calls the rest", async () => {
      vi.useFakeTimers();
      const store = await freshStore({
        get_meditation_status: () => "running",
      });
      await vi.advanceTimersByTimeAsync(0);

      const bad = vi.fn(() => {
        throw new Error("listener exploded");
      });
      const good = vi.fn();
      store.getState().onComplete(bad);
      store.getState().onComplete(good);

      mockInvoke({ get_meditation_status: () => "idle" });
      await vi.advanceTimersByTimeAsync(2001);

      expect(bad).toHaveBeenCalled();
      expect(good).toHaveBeenCalled();
      expect(store.getState().isRunning).toBe(false);
    });

    it("does not fire listeners on an idle -> idle tick (no transition)", async () => {
      vi.useFakeTimers();
      const store = await freshStore({ get_meditation_status: () => "idle" });
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getState().isRunning).toBe(false);

      const listener = vi.fn();
      store.getState().onComplete(listener);

      // Another idle tick should not fire the listener.
      await vi.advanceTimersByTimeAsync(2001);
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("polling loop", () => {
    it("flips isRunning to true when a poll sees status='running'", async () => {
      // Bootstrap sees idle so we stay false; then swap and poll once more.
      vi.useFakeTimers();
      const store = await freshStore({ get_meditation_status: () => "idle" });
      await vi.advanceTimersByTimeAsync(0);
      // Bootstrap's tick also clears pollTimer on idle, so polling stopped.
      // Restart it by calling _ensurePolling after swapping the mock.
      mockInvoke({ get_meditation_status: () => "running" });
      store.getState()._ensurePolling();
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getState().isRunning).toBe(true);
    });

    it("swallows invoke errors and leaves state untouched", async () => {
      vi.useFakeTimers();
      const store = await freshStore({
        get_meditation_status: () => {
          throw new Error("backend crashed");
        },
      });
      // Bootstrap tick's rejection is swallowed by try/catch.
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getState().isRunning).toBe(false);
      // Subsequent interval tick should also be silently ignored.
      await vi.advanceTimersByTimeAsync(2001);
      expect(store.getState().isRunning).toBe(false);
    });

    it("_ensurePolling is a no-op when a poll timer is already active", async () => {
      vi.useFakeTimers();
      const store = await freshStore({
        get_meditation_status: () => "running",
      });
      await vi.advanceTimersByTimeAsync(0);
      // Bootstrap set up a timer because status=running (pollTimer is only cleared
      // on idle). Calling _ensurePolling again must NOT kick off a second
      // immediate tick — verify by swapping the mock to a spy and checking it
      // isn't hit synchronously.
      const spy = vi.fn(() => "running");
      mockInvoke({ get_meditation_status: spy });
      store.getState()._ensurePolling();
      // Should NOT have called invoke in this microtask.
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
