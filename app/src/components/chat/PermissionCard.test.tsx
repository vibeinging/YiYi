import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { mockInvoke } from '../../test-utils/mockTauri';
import { useChatStreamStore, type PermissionRequestState } from '../../stores/chatStreamStore';
import { PermissionCard } from './PermissionCard';

const pristine = useChatStreamStore.getState();

function request(over: Partial<PermissionRequestState> = {}): PermissionRequestState {
  return {
    requestId: 'req-1',
    permissionType: 'folder_access',
    path: '/Users/me/secret.txt',
    parentFolder: '/Users/me',
    reason: 'need to read',
    riskLevel: 'low',
    status: 'pending',
    ...over,
  };
}

describe('PermissionCard', () => {
  beforeEach(() => {
    useChatStreamStore.setState(pristine, true);
    mockInvoke({});
  });

  it('renders type-specific label + path + reason', () => {
    render(<PermissionCard request={request()} />);
    expect(screen.getByText('文件夹访问')).toBeInTheDocument();
    expect(screen.getByText('/Users/me/secret.txt')).toBeInTheDocument();
    expect(screen.getByText('need to read')).toBeInTheDocument();
    expect(screen.getByText(/将授权文件夹/)).toBeInTheDocument();
  });

  it('uses fallback label for unknown permission type', () => {
    render(<PermissionCard request={request({ permissionType: 'exotic-thing' as any })} />);
    expect(screen.getByText('权限请求')).toBeInTheDocument();
  });

  it('允许 button invokes respond_permission_request with approved=true', async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    mockInvoke({ respond_permission_request: respond });
    render(<PermissionCard request={request()} />);
    fireEvent.click(screen.getByRole('button', { name: /允许/ }));
    await waitFor(() => expect(respond).toHaveBeenCalled());
    expect(respond.mock.calls[0][0]).toMatchObject({
      requestId: 'req-1',
      approved: true,
      addFolder: '/Users/me',
    });
  });

  it('拒绝 button invokes respond_permission_request with approved=false', async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    mockInvoke({ respond_permission_request: respond });
    render(<PermissionCard request={request()} />);
    fireEvent.click(screen.getByRole('button', { name: /拒绝/ }));
    await waitFor(() => expect(respond).toHaveBeenCalled());
    expect(respond.mock.calls[0][0].approved).toBe(false);
    expect(respond.mock.calls[0][0].addFolder).toBeNull();
  });

  it('folder_write approval sends upgradePermission instead of addFolder', async () => {
    const respond = vi.fn().mockResolvedValue(undefined);
    mockInvoke({ respond_permission_request: respond });
    render(
      <PermissionCard request={request({ permissionType: 'folder_write' })} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /允许/ }));
    await waitFor(() => expect(respond).toHaveBeenCalled());
    expect(respond.mock.calls[0][0].upgradePermission).toBe('/Users/me');
    expect(respond.mock.calls[0][0].addFolder).toBeNull();
  });

  it('resolved request hides action buttons and shows status badge', () => {
    render(<PermissionCard request={request({ status: 'approved' })} />);
    expect(screen.getByText('已授权')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /允许/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /拒绝/ })).not.toBeInTheDocument();
  });

  it('denied status shows 已拒绝 indicator', () => {
    render(<PermissionCard request={request({ status: 'denied' })} />);
    expect(screen.getByText('已拒绝')).toBeInTheDocument();
  });
});
