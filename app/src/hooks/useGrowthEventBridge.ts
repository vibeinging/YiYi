import { listen } from '@tauri-apps/api/event';
import { useEffect } from 'react';
import { useInboxStore } from '../stores/inboxStore';

/**
 * Bridges Rust → frontend inbox refresh: any backend insert/update emits
 * `inbox://updated`; we refetch pending items so the Buddy badge and bubble
 * stay in sync without polling.
 *
 * Replaces the older `growth://persist_suggestion` localStorage path. The
 * single source of truth for growth proposals is now `inbox_items` (SQLite).
 */
export function useGrowthEventBridge() {
  useEffect(() => {
    let cancelled = false;
    // One-time cleanup of the pre-B legacy localStorage key (replaced by
    // inbox_items SQLite + useInboxStore). Stale entries had low quality and
    // we agreed to drop them rather than migrate. Safe to leave indefinitely.
    try { localStorage.removeItem('yiyi-growth-suggestions'); } catch { /* ignore */ }
    const refresh = useInboxStore.getState().refresh;
    refresh();

    const unlistener = listen('inbox://updated', () => {
      if (cancelled) return;
      refresh();
    });

    return () => {
      cancelled = true;
      unlistener.then((fn) => fn());
    };
  }, []);
}
