import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { mockEventBridge } from '../test-utils/mockEvent';
import { useChatStreamStore } from '../stores/chatStreamStore';
import { usePermissionBridge } from './usePermissionBridge';

const pristine = useChatStreamStore.getState();

describe('usePermissionBridge', () => {
  let bridge: ReturnType<typeof mockEventBridge>;

  beforeEach(() => {
    bridge = mockEventBridge();
    useChatStreamStore.setState(pristine, true);
  });

  it('subscribes to permission://request channel', async () => {
    renderHook(() => usePermissionBridge());
    await vi.waitFor(() => expect(bridge.channels()).toContain('permission://request'));
  });

  it('dispatches showPermission to store with translated payload', async () => {
    renderHook(() => usePermissionBridge());
    await vi.waitFor(() => expect(bridge.channels()).toContain('permission://request'));
    act(() => {
      bridge.dispatch('permission://request', {
        request_id: 'req-1',
        permission_type: 'folder_write',
        path: '/tmp/x',
        parent_folder: '/tmp',
        reason: 'want to write',
        risk_level: 'medium',
      });
    });
    const perm = useChatStreamStore.getState().activePermission;
    expect(perm?.requestId).toBe('req-1');
    expect(perm?.permissionType).toBe('folder_write');
    expect(perm?.parentFolder).toBe('/tmp');
    expect(perm?.riskLevel).toBe('medium');
    expect(perm?.status).toBe('pending');
  });
});
