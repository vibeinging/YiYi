import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { mockInvoke } from '../test-utils/mockTauri';
import { ToastProvider } from './Toast';
import { AgentsPanel } from './AgentsPanel';
import type { AgentSummary, AgentDefinition } from '../api/agents';

const builtin = (over: Partial<AgentSummary> = {}): AgentSummary => ({
  name: 'explorer',
  description: 'Reads the repo',
  emoji: '🔭',
  color: '#123456',
  is_builtin: true,
  model: 'gpt-4o',
  tool_count: 4,
  ...over,
});

const custom = (over: Partial<AgentSummary> = {}): AgentSummary => ({
  name: 'my-agent',
  description: 'Custom thing',
  emoji: '🤖',
  color: null,
  is_builtin: false,
  model: null,
  tool_count: 0,
  ...over,
});

const def: AgentDefinition = {
  name: 'my-agent',
  description: 'Custom thing',
  emoji: '🤖',
  color: null,
  model: null,
  instructions: 'Do the thing.',
} as unknown as AgentDefinition;

function mount() {
  return render(
    <ToastProvider>
      <AgentsPanel />
    </ToastProvider>,
  );
}

describe('AgentsPanel', () => {
  let confirmSpy: any;

  beforeEach(() => {
    mockInvoke({});
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  });
  afterEach(() => {
    confirmSpy.mockRestore();
  });

  it('empty state shows 暂无 Agent', async () => {
    mockInvoke({ list_agents: vi.fn().mockResolvedValue([]) });
    mount();
    expect(await screen.findByText(/暂无 Agent/)).toBeInTheDocument();
  });

  it('renders agents with 内置 badge + model', async () => {
    mockInvoke({ list_agents: vi.fn().mockResolvedValue([builtin(), custom()]) });
    mount();
    expect(await screen.findByText('explorer')).toBeInTheDocument();
    expect(screen.getByText('my-agent')).toBeInTheDocument();
    expect(screen.getByText('内置')).toBeInTheDocument();
    expect(screen.getByText('gpt-4o')).toBeInTheDocument();
  });

  it('builtin agent has no edit/delete buttons', async () => {
    mockInvoke({ list_agents: vi.fn().mockResolvedValue([builtin()]) });
    mount();
    await screen.findByText('explorer');
    expect(screen.queryByTitle('编辑')).not.toBeInTheDocument();
    expect(screen.queryByTitle('删除')).not.toBeInTheDocument();
  });

  it('新建 Agent button opens the form', async () => {
    mockInvoke({ list_agents: vi.fn().mockResolvedValue([]) });
    mount();
    await screen.findByText(/暂无 Agent/);
    fireEvent.click(screen.getByRole('button', { name: /新建 Agent/ }));
    expect(screen.getByText('新建 Agent')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/code-reviewer/)).toBeInTheDocument();
  });

  it('save with empty name errors out', async () => {
    mockInvoke({ list_agents: vi.fn().mockResolvedValue([]) });
    mount();
    await screen.findByText(/暂无 Agent/);
    fireEvent.click(screen.getByRole('button', { name: /新建 Agent/ }));
    const saveBtn = screen.getByRole('button', { name: /保存/ });
    // Button is disabled when name empty — verify that, instead of clicking
    expect(saveBtn).toBeDisabled();
  });

  it('save new agent calls save_agent with AGENT.md payload', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([custom({ name: 'abc' })]);
    const save = vi.fn().mockResolvedValue(undefined);
    mockInvoke({ list_agents: list, save_agent: save });
    mount();
    await screen.findByText(/暂无 Agent/);
    fireEvent.click(screen.getByRole('button', { name: /新建 Agent/ }));

    fireEvent.change(screen.getByPlaceholderText(/code-reviewer/), { target: { value: 'abc' } });
    fireEvent.change(screen.getByPlaceholderText(/简要描述/), { target: { value: 'desc' } });
    fireEvent.click(screen.getByRole('button', { name: /保存/ }));

    await waitFor(() => expect(save).toHaveBeenCalled());
    const payload = save.mock.calls[0][0].content as string;
    expect(payload).toContain('name: "abc"');
    expect(payload).toContain('description: "desc"');
  });

  it('edit custom agent loads definition into form', async () => {
    mockInvoke({
      list_agents: vi.fn().mockResolvedValue([custom()]),
      get_agent: vi.fn().mockResolvedValue(def),
    });
    mount();
    await screen.findByText('my-agent');
    fireEvent.click(screen.getByTitle('编辑'));
    expect(await screen.findByText(/编辑 Agent: my-agent/)).toBeInTheDocument();
    expect((screen.getByPlaceholderText(/code-reviewer/) as HTMLInputElement).value).toBe('my-agent');
    expect(screen.getByPlaceholderText(/System Prompt/) as HTMLTextAreaElement)
      .toHaveValue('Do the thing.');
  });

  it('delete custom agent triggers confirm + invokes delete_agent', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce([custom()])
      .mockResolvedValueOnce([]);
    const del = vi.fn().mockResolvedValue(undefined);
    mockInvoke({ list_agents: list, delete_agent: del });
    mount();
    await screen.findByText('my-agent');
    fireEvent.click(screen.getByTitle('删除'));
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(del).toHaveBeenCalledWith({ name: 'my-agent' }));
  });

  it('delete canceled confirm does nothing', async () => {
    confirmSpy.mockReturnValue(false);
    const del = vi.fn();
    mockInvoke({
      list_agents: vi.fn().mockResolvedValue([custom()]),
      delete_agent: del,
    });
    mount();
    await screen.findByText('my-agent');
    fireEvent.click(screen.getByTitle('删除'));
    expect(del).not.toHaveBeenCalled();
  });
});
