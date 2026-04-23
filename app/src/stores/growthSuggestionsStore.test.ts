import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useGrowthSuggestionsStore } from './growthSuggestionsStore';

function add(
  type: 'skill' | 'code' | 'workflow',
  name: string,
  description: string = 'desc',
) {
  useGrowthSuggestionsStore.getState().add({ type, name, description });
}

describe('growthSuggestionsStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useGrowthSuggestionsStore.getState().clearAll();
    useGrowthSuggestionsStore.setState({ lastSavedAt: {} });
  });

  it('adds new suggestions to the front', () => {
    add('skill', 'A');
    add('skill', 'B');
    const pending = useGrowthSuggestionsStore.getState().pending;
    expect(pending.map((p) => p.name)).toEqual(['B', 'A']);
  });

  it('deduplicates same (type, name) within 24h by refreshing timestamp', () => {
    add('skill', 'Rename', 'first');
    const firstId = useGrowthSuggestionsStore.getState().pending[0].id;
    add('skill', 'Rename', 'second');
    const pending = useGrowthSuggestionsStore.getState().pending;
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(firstId);
    expect(pending[0].description).toBe('second');
  });

  it('does NOT dedup across types', () => {
    add('skill', 'SameName');
    add('code', 'SameName');
    expect(useGrowthSuggestionsStore.getState().pending).toHaveLength(2);
  });

  it('enforces daily cap (max 5 per day)', () => {
    for (let i = 0; i < 10; i++) add('skill', `S-${i}`);
    expect(useGrowthSuggestionsStore.getState().pending).toHaveLength(5);
  });

  it('remove() drops an entry by id', () => {
    add('skill', 'A');
    const id = useGrowthSuggestionsStore.getState().pending[0].id;
    useGrowthSuggestionsStore.getState().remove(id);
    expect(useGrowthSuggestionsStore.getState().pending).toHaveLength(0);
  });

  it('snooze() hides from visiblePending() but keeps in pending', () => {
    add('skill', 'A');
    const id = useGrowthSuggestionsStore.getState().pending[0].id;
    useGrowthSuggestionsStore.getState().snooze(id, 1);
    expect(useGrowthSuggestionsStore.getState().pending).toHaveLength(1);
    expect(useGrowthSuggestionsStore.getState().visiblePending()).toHaveLength(0);
  });

  it('recordSave + consumeLastSaved roundtrip within 7d', () => {
    useGrowthSuggestionsStore.getState().recordSave('X', 'body');
    const entry = useGrowthSuggestionsStore.getState().consumeLastSaved('X');
    expect(entry?.content).toBe('body');
    expect(useGrowthSuggestionsStore.getState().consumeLastSaved('X')).toBeNull();
  });

  it('consumeLastSaved returns null after 7d', () => {
    useGrowthSuggestionsStore.getState().recordSave('X', 'body');
    useGrowthSuggestionsStore.setState({
      lastSavedAt: {
        X: { name: 'X', content: 'body', ts: Date.now() - 8 * 86400_000 },
      },
    });
    expect(useGrowthSuggestionsStore.getState().consumeLastSaved('X')).toBeNull();
  });
});
