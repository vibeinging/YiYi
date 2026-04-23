/**
 * Growth suggestion inbox.
 *
 * Rust's react_agent/growth reflection path emits `growth://persist_suggestion`
 * events when it believes a skill / code / workflow is worth saving. These
 * are DECISION events (user must choose save / edit / discard / snooze),
 * not notifications — so they go into a persisted inbox instead of a toast.
 *
 * Storage: mirrored to localStorage so suggestions survive HMR / reload /
 * accidental nav. Kept intentionally tiny — each suggestion is at most
 * a few hundred bytes, capped at MAX_PENDING.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export type SuggestionType = 'skill' | 'code' | 'workflow';

export interface GrowthSuggestion {
  id: string;                // client-side uuid
  type: SuggestionType;
  name: string;
  description: string;
  reason?: string;
  sessionId?: string;
  taskId?: string;
  createdAt: number;         // epoch ms, for daily-cap and sort
}

interface GrowthSuggestionsState {
  pending: GrowthSuggestion[];
  // Last-snoozed map so the Buddy badge can hide items briefly on request.
  snoozedUntil: Record<string, number>;
  // Track when this user made their last "skill save" — 7-day undo window.
  lastSavedAt: Record<string, { name: string; content: string; ts: number }>;

  add: (incoming: Omit<GrowthSuggestion, 'id' | 'createdAt'>) => void;
  remove: (id: string) => void;
  snooze: (id: string, hours: number) => void;
  clearAll: () => void;
  recordSave: (name: string, content: string) => void;
  consumeLastSaved: (name: string) => { name: string; content: string; ts: number } | null;
  visiblePending: () => GrowthSuggestion[];
}

const MAX_PENDING = 30;
const MAX_PER_DAY = 5;
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

function today(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function uuid(): string {
  return `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useGrowthSuggestionsStore = create<GrowthSuggestionsState>()(
  persist(
    (set, get) => ({
      pending: [],
      snoozedUntil: {},
      lastSavedAt: {},

      add: (incoming) => {
        const now = Date.now();
        const existing = get().pending;

        // Daily cap: silently drop if >= MAX_PER_DAY already queued today
        const t = today(now);
        const todayCount = existing.filter((s) => today(s.createdAt) === t).length;
        if (todayCount >= MAX_PER_DAY) {
          return;
        }

        // Dedup: same (type, name) within 24h is treated as the same suggestion
        const dupIdx = existing.findIndex(
          (s) =>
            s.type === incoming.type &&
            s.name.trim() === incoming.name.trim() &&
            now - s.createdAt < DEDUP_WINDOW_MS,
        );
        if (dupIdx >= 0) {
          // Refresh timestamp + reason / description if the new one is richer
          const refreshed: GrowthSuggestion = {
            ...existing[dupIdx],
            description: incoming.description || existing[dupIdx].description,
            reason: incoming.reason || existing[dupIdx].reason,
            createdAt: now,
          };
          set({
            pending: [refreshed, ...existing.filter((_, i) => i !== dupIdx)].slice(0, MAX_PENDING),
          });
          return;
        }

        const next: GrowthSuggestion = {
          ...incoming,
          id: uuid(),
          createdAt: now,
        };
        set({ pending: [next, ...existing].slice(0, MAX_PENDING) });
      },

      remove: (id) =>
        set((state) => ({
          pending: state.pending.filter((s) => s.id !== id),
          snoozedUntil: Object.fromEntries(
            Object.entries(state.snoozedUntil).filter(([k]) => k !== id),
          ),
        })),

      snooze: (id, hours) =>
        set((state) => ({
          snoozedUntil: { ...state.snoozedUntil, [id]: Date.now() + hours * 3600_000 },
        })),

      clearAll: () => set({ pending: [], snoozedUntil: {} }),

      recordSave: (name, content) =>
        set((state) => ({
          lastSavedAt: {
            ...state.lastSavedAt,
            [name]: { name, content, ts: Date.now() },
          },
        })),

      // Consume = pop if within 7-day undo window.
      consumeLastSaved: (name) => {
        const entry = get().lastSavedAt[name];
        if (!entry) return null;
        if (Date.now() - entry.ts > 7 * 86400_000) return null;
        set((state) => {
          const next = { ...state.lastSavedAt };
          delete next[name];
          return { lastSavedAt: next };
        });
        return entry;
      },

      visiblePending: () => {
        const now = Date.now();
        const { pending, snoozedUntil } = get();
        return pending.filter((s) => {
          const until = snoozedUntil[s.id];
          return !until || until <= now;
        });
      },
    }),
    {
      name: 'yiyi-growth-suggestions',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        pending: state.pending,
        snoozedUntil: state.snoozedUntil,
        lastSavedAt: state.lastSavedAt,
      }),
    },
  ),
);
