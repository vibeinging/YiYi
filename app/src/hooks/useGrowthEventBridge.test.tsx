import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { mockEventBridge } from '../test-utils/mockEvent';
import { useGrowthSuggestionsStore } from '../stores/growthSuggestionsStore';
import { useGrowthEventBridge } from './useGrowthEventBridge';

describe('useGrowthEventBridge', () => {
  let bridge: ReturnType<typeof mockEventBridge>;

  beforeEach(() => {
    bridge = mockEventBridge();
    useGrowthSuggestionsStore.getState().clearAll();
    // wipe persisted lastSavedAt too
    useGrowthSuggestionsStore.setState({ lastSavedAt: {} });
  });

  it('subscribes to growth://persist_suggestion', async () => {
    renderHook(() => useGrowthEventBridge());
    await vi.waitFor(() =>
      expect(bridge.channels()).toContain('growth://persist_suggestion'),
    );
  });

  it('pushes a suggestion into the store on event', async () => {
    renderHook(() => useGrowthEventBridge());
    await vi.waitFor(() =>
      expect(bridge.channels()).toContain('growth://persist_suggestion'),
    );
    act(() => {
      bridge.dispatch('growth://persist_suggestion', {
        type: 'skill',
        name: '批量重命名',
        description: '按正则批量改名并生成报告',
        reason: '本会话 3 次类似操作',
        session_id: 'sess-1',
        task_id: 't-1',
      });
    });
    const pending = useGrowthSuggestionsStore.getState().pending;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      type: 'skill',
      name: '批量重命名',
      sessionId: 'sess-1',
      taskId: 't-1',
    });
  });

  it('skips payloads missing name or type', async () => {
    renderHook(() => useGrowthEventBridge());
    await vi.waitFor(() =>
      expect(bridge.channels()).toContain('growth://persist_suggestion'),
    );
    act(() => {
      bridge.dispatch('growth://persist_suggestion', { name: 'no type' });
      bridge.dispatch('growth://persist_suggestion', { type: 'skill' });
    });
    expect(useGrowthSuggestionsStore.getState().pending).toHaveLength(0);
  });
});
