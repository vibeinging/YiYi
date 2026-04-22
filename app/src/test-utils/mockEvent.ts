/**
 * Helper to dispatch fake Tauri events to hooks that use `listen()`.
 *
 * Usage:
 *   const { dispatch } = mockEventBridge();
 *   renderHook(() => useMyBridge());
 *   dispatch('task://created', { task_id: 'abc' });
 */
import { listen } from "@tauri-apps/api/event";
import type { Mock } from "vitest";

type Handler = (event: { event: string; payload: any; id: number }) => void;

export function mockEventBridge() {
  const listeners = new Map<string, Set<Handler>>();
  const mocked = listen as unknown as Mock;
  let nextId = 1;

  mocked.mockImplementation(async (channel: string, handler: Handler) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel)!.add(handler);
    return () => {
      listeners.get(channel)?.delete(handler);
    };
  });

  return {
    dispatch(channel: string, payload: any) {
      const set = listeners.get(channel);
      if (!set) return;
      for (const h of set) {
        h({ event: channel, payload, id: nextId++ });
      }
    },
    channels() {
      return Array.from(listeners.keys());
    },
    clear() {
      listeners.clear();
    },
  };
}
