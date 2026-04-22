import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { mockInvoke } from '../test-utils/mockTauri';
import { ToastProvider } from './Toast';
import { PluginsPanel } from './PluginsPanel';
import type { PluginInfo } from '../api/plugins';

const p = (over: Partial<PluginInfo> = {}): PluginInfo => ({
  id: 'p1',
  name: 'Foo',
  version: '1.0.0',
  description: 'A plugin',
  enabled: true,
  tool_count: 3,
  has_hooks: false,
  ...over,
});

function renderPanel() {
  return render(
    <ToastProvider>
      <PluginsPanel />
    </ToastProvider>,
  );
}

describe('PluginsPanel', () => {
  beforeEach(() => {
    mockInvoke({});
  });

  it('shows empty state when no plugins', async () => {
    mockInvoke({ list_plugins: vi.fn().mockResolvedValue([]) });
    renderPanel();
    expect(await screen.findByText(/暂无已安装的插件/)).toBeInTheDocument();
  });

  it('renders plugin list with version and tool badge', async () => {
    mockInvoke({
      list_plugins: vi.fn().mockResolvedValue([p(), p({ id: 'p2', name: 'Bar', has_hooks: true, tool_count: 0, enabled: false })]),
    });
    renderPanel();
    expect(await screen.findByText('Foo')).toBeInTheDocument();
    expect(screen.getByText('Bar')).toBeInTheDocument();
    expect(screen.getAllByText('v1.0.0')).toHaveLength(2);
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Hooks')).toBeInTheDocument();
  });

  it('toggles enabled plugin -> calls disable + reloads', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce([p({ enabled: true })])
      .mockResolvedValueOnce([p({ enabled: false })]);
    const disable = vi.fn().mockResolvedValue(undefined);
    mockInvoke({
      list_plugins: list,
      disable_plugin: disable,
    });
    renderPanel();
    const toggle = (await screen.findByText('Foo')).closest('.group')!.querySelector('button')!;
    fireEvent.click(toggle);
    await waitFor(() => expect(disable).toHaveBeenCalledWith({ id: 'p1' }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it('reload button invokes reload_plugins and shows toast', async () => {
    const reload = vi.fn().mockResolvedValue(5);
    mockInvoke({
      list_plugins: vi.fn().mockResolvedValue([]),
      reload_plugins: reload,
    });
    renderPanel();
    const btn = await screen.findByRole('button', { name: /重新加载/ });
    fireEvent.click(btn);
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(await screen.findByText(/已重新加载 5 个插件/)).toBeInTheDocument();
  });

  it('reload failure surfaces toast.error', async () => {
    mockInvoke({
      list_plugins: vi.fn().mockResolvedValue([]),
      reload_plugins: vi.fn().mockRejectedValue(new Error('boom')),
    });
    renderPanel();
    const btn = await screen.findByRole('button', { name: /重新加载/ });
    fireEvent.click(btn);
    expect(await screen.findByText(/boom/)).toBeInTheDocument();
  });
});
