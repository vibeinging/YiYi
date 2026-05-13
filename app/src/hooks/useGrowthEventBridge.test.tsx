import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { mockEventBridge } from '../test-utils/mockEvent';
import { useInboxStore } from '../stores/inboxStore';
import { useGrowthEventBridge } from './useGrowthEventBridge';

vi.mock('../api/inbox', async () => {
  const actual = await vi.importActual<typeof import('../api/inbox')>('../api/inbox');
  return {
    ...actual,
    listInboxItems: vi.fn().mockResolvedValue([]),
  };
});

import { listInboxItems } from '../api/inbox';

describe('useGrowthEventBridge', () => {
  let bridge: ReturnType<typeof mockEventBridge>;

  beforeEach(() => {
    bridge = mockEventBridge();
    useInboxStore.setState({ pending: [], snoozedUntil: {}, loading: false });
    vi.mocked(listInboxItems).mockClear();
  });

  it('subscribes to inbox://updated and triggers initial refresh', async () => {
    renderHook(() => useGrowthEventBridge());
    await vi.waitFor(() =>
      expect(bridge.channels()).toContain('inbox://updated'),
    );
    // Initial mount fires one refresh.
    await vi.waitFor(() => expect(listInboxItems).toHaveBeenCalledTimes(1));
  });

  it('refetches on inbox://updated event', async () => {
    renderHook(() => useGrowthEventBridge());
    await vi.waitFor(() =>
      expect(bridge.channels()).toContain('inbox://updated'),
    );
    vi.mocked(listInboxItems).mockClear();
    act(() => {
      bridge.dispatch('inbox://updated', { id: 'x', kind: 'skill_create' });
    });
    await vi.waitFor(() => expect(listInboxItems).toHaveBeenCalledTimes(1));
  });
});
