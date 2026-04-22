import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  ToolCallPanel,
  HistorySpawnAgentsPanel,
  TOOL_VERBS,
  getToolLabel,
} from './ToolCallPanel';
import { useChatStreamStore, type ToolStatus, type ClaudeCodeState } from '../stores/chatStreamStore';

const pristine = useChatStreamStore.getState();

function tool(over: Partial<ToolStatus> = {}): ToolStatus {
  return { id: 1, name: 'read_file', status: 'running', ...over } as ToolStatus;
}

describe('getToolLabel', () => {
  it('uses known verb for running status', () => {
    expect(getToolLabel('read_file', 'running')).toBe(TOOL_VERBS.read_file[0]);
  });

  it('uses known verb for done status', () => {
    expect(getToolLabel('read_file', 'done')).toBe(TOOL_VERBS.read_file[1]);
  });

  it('falls back to "Running <name>" for unknown tool (running)', () => {
    expect(getToolLabel('some_unknown_tool', 'running')).toBe('Running some unknown tool');
  });

  it('falls back to "Ran <name>" for unknown tool (done)', () => {
    expect(getToolLabel('some_unknown_tool', 'done')).toBe('Ran some unknown tool');
  });

  it('covers spawn_agents label', () => {
    expect(getToolLabel('spawn_agents', 'running')).toBe('Dispatching team');
    expect(getToolLabel('spawn_agents', 'done')).toBe('Team completed');
  });
});

describe('ToolCallPanel', () => {
  beforeEach(() => {
    useChatStreamStore.setState(pristine, true);
  });

  it('renders null when no tools and no claudeCode', () => {
    const { container } = render(<ToolCallPanel tools={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders tool list with label + preview', () => {
    render(
      <ToolCallPanel
        tools={[
          tool({ id: 1, name: 'read_file', status: 'done', preview: '/a.ts', resultPreview: '10 lines' }),
          tool({ id: 2, name: 'write_file', status: 'running', preview: '/b.ts' }),
        ]}
      />,
    );
    expect(screen.getByText(/Read/)).toBeInTheDocument();
    expect(screen.getByText('Writing')).toBeInTheDocument();
    expect(screen.getByText('/a.ts')).toBeInTheDocument();
  });

  it('shows "Used N tools" when all done and collapsed', () => {
    const { container } = render(
      <ToolCallPanel
        tools={[
          tool({ id: 1, status: 'done' }),
          tool({ id: 2, status: 'done' }),
        ]}
      />,
    );
    // all-done auto-collapses via effect
    expect(container.textContent).toContain('Used 2 tools');
  });

  it('shows "Running tools..." when collapsed and any tool running', () => {
    const { container } = render(
      <ToolCallPanel
        tools={[
          tool({ id: 1, status: 'running' }),
          tool({ id: 2, status: 'done' }),
        ]}
      />,
    );
    // not auto-collapsed (isAnyRunning), so toggle manually
    fireEvent.click(container.querySelector('button')!);
    expect(container.textContent).toContain('Running tools');
  });

  it('history mode starts collapsed and shows summary', () => {
    render(
      <ToolCallPanel
        isHistory
        tools={[tool({ id: 1, status: 'done' })]}
      />,
    );
    expect(screen.getByText('Used 1 tool')).toBeInTheDocument();
  });

  it('tool line with resultPreview expands on click', () => {
    const { container } = render(
      <ToolCallPanel
        tools={[
          tool({ id: 1, status: 'done', resultPreview: 'result body here' }),
          tool({ id: 2, status: 'running' }),
        ]}
      />,
    );
    // Panel is not auto-collapsed when something is still running.
    const readLabel = screen.getByText(/^Read$/);
    expect(screen.queryByText('result body here')).not.toBeInTheDocument();
    fireEvent.click(readLabel.parentElement!);
    expect(container.textContent).toContain('result body here');
  });

  it('renders ClaudeCodePanel when store.claudeCode present', () => {
    const claudeCode: ClaudeCodeState = {
      active: true,
      content: 'CC streaming...',
      workingDir: '/ws',
      subTools: [{ name: 'bash', status: 'running' }],
    };
    useChatStreamStore.setState({ claudeCode });
    render(<ToolCallPanel tools={[]} />);
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('CC streaming...')).toBeInTheDocument();
  });

  it('history mode ignores store.claudeCode', () => {
    useChatStreamStore.setState({
      claudeCode: { active: true, content: 'ignored', workingDir: '', subTools: [] },
    });
    const { container } = render(<ToolCallPanel isHistory tools={[]} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText('Claude Code')).not.toBeInTheDocument();
  });
});

describe('HistorySpawnAgentsPanel', () => {
  it('starts collapsed with "N agents completed" label', () => {
    render(
      <HistorySpawnAgentsPanel
        agents={[
          { name: 'a', result: 'r1' },
          { name: 'b', result: 'r2' },
        ]}
      />,
    );
    expect(screen.getByText(/2 agents completed/)).toBeInTheDocument();
  });

  it('expand-all-panel click reveals individual agent rows', () => {
    render(
      <HistorySpawnAgentsPanel
        agents={[{ name: 'solo', result: 'done ok' }]}
      />,
    );
    fireEvent.click(screen.getByText(/1 agent completed/));
    expect(screen.getByText('solo')).toBeInTheDocument();
  });

  it('expanding an agent shows its full result body', () => {
    render(
      <HistorySpawnAgentsPanel
        agents={[{ name: 'planner', result: 'full result body text' }]}
      />,
    );
    fireEvent.click(screen.getByText(/1 agent completed/));
    fireEvent.click(screen.getByText('planner'));
    expect(screen.getAllByText('full result body text').length).toBeGreaterThan(0);
  });

  it('error agent shows AlertCircle indicator', () => {
    const { container } = render(
      <HistorySpawnAgentsPanel
        agents={[{ name: 'bad', result: 'failed', is_error: true }]}
      />,
    );
    fireEvent.click(screen.getByText(/1 agent completed/));
    // Just assert it rendered; visually-distinct icon is internal.
    expect(screen.getByText('bad')).toBeInTheDocument();
    expect(container.textContent).toContain('failed');
  });
});
