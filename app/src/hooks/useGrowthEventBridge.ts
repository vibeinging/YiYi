import { listen } from '@tauri-apps/api/event';
import { useEffect } from 'react';
import { useGrowthSuggestionsStore, type SuggestionType } from '../stores/growthSuggestionsStore';

interface PersistSuggestionPayload {
  type: SuggestionType;
  name: string;
  description: string;
  reason?: string;
  session_id?: string;
  task_id?: string;
}

/**
 * Bridge `growth://persist_suggestion` events from Rust into the growth
 * suggestions inbox (persisted store). UI is rendered by
 * `<GrowthSuggestionsBubble />` near the Buddy sprite.
 *
 * This intentionally does NOT toast — the event is a decision request,
 * not a notification. See stores/growthSuggestionsStore.ts for the
 * dedup + daily-cap rules that guard against notification fatigue.
 */
export function useGrowthEventBridge() {
  useEffect(() => {
    let cancelled = false;
    const add = useGrowthSuggestionsStore.getState().add;

    const unlisteners = [
      listen<PersistSuggestionPayload>('growth://persist_suggestion', (event) => {
        if (cancelled) return;
        const p = event.payload;
        if (!p?.name || !p?.type) return;
        add({
          type: p.type,
          name: p.name,
          description: p.description || '',
          reason: p.reason,
          sessionId: p.session_id,
          taskId: p.task_id,
        });
      }),
    ];
    return () => {
      cancelled = true;
      unlisteners.forEach((pr) => pr.then((fn) => fn()));
    };
  }, []);
}
