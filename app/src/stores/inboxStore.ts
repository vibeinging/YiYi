/**
 * Client-side cache for the white-box growth Inbox.
 *
 * SQLite (`inbox_items`) is the source of truth — this store just holds the
 * latest pending snapshot and a per-item snooze map (UI-only, lives in
 * localStorage). The Rust backend emits `inbox://updated` whenever an item
 * is inserted/approved/rejected; the event bridge calls `refresh()`.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { listInboxItems, type InboxItem } from '../api/inbox';

interface InboxState {
  pending: InboxItem[];
  loading: boolean;
  /** id → epoch ms until which the item is hidden in this client. */
  snoozedUntil: Record<string, number>;

  refresh: () => Promise<void>;
  removeLocal: (id: string) => void;
  snooze: (id: string, hours: number) => void;
  visibleCount: () => number;
}

export const useInboxStore = create<InboxState>()(
  persist(
    (set, get) => ({
      pending: [],
      loading: false,
      snoozedUntil: {},

      refresh: async () => {
        set({ loading: true });
        try {
          const items = await listInboxItems('pending', 50);
          set({ pending: items, loading: false });
          // Prune expired snooze entries for items that no longer exist.
          set((state) => {
            const ids = new Set(items.map((i) => i.id));
            const next: Record<string, number> = {};
            for (const [k, v] of Object.entries(state.snoozedUntil)) {
              if (ids.has(k)) next[k] = v;
            }
            return { snoozedUntil: next };
          });
        } catch (e) {
          console.error('inbox refresh failed', e);
          set({ loading: false });
        }
      },

      removeLocal: (id) =>
        set((state) => ({
          pending: state.pending.filter((i) => i.id !== id),
          snoozedUntil: Object.fromEntries(
            Object.entries(state.snoozedUntil).filter(([k]) => k !== id),
          ),
        })),

      snooze: (id, hours) =>
        set((state) => ({
          snoozedUntil: { ...state.snoozedUntil, [id]: Date.now() + hours * 3600_000 },
        })),

      visibleCount: () => {
        const now = Date.now();
        const { pending, snoozedUntil } = get();
        return pending.filter((i) => {
          const until = snoozedUntil[i.id];
          return !until || until <= now;
        }).length;
      },
    }),
    {
      name: 'yiyi-inbox-ui',
      storage: createJSONStorage(() => localStorage),
      // Only snooze metadata is local; pending list always refetched from DB.
      partialize: (state) => ({ snoozedUntil: state.snoozedUntil }),
    },
  ),
);
