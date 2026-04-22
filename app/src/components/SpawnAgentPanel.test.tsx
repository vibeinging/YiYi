import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SpawnAgentPanel, type SpawnAgent } from './SpawnAgentPanel';

const agent = (over: Partial<SpawnAgent> = {}): SpawnAgent => ({
  name: 'explorer',
  task: 'Find X',
  status: 'running',
  content: '',
  tools: [],
  ...over,
});

function renderPanel(agents: SpawnAgent[], collapsed: string[] = [], onToggle = vi.fn()) {
  return {
    onToggle,
    ...render(
      <SpawnAgentPanel
        agents={agents}
        collapsedAgents={new Set(collapsed)}
        onToggleCollapse={onToggle}
      />,
    ),
  };
}

describe('SpawnAgentPanel', () => {
  it('header shows "Agent Team" label when not panel-collapsed', () => {
    renderPanel([agent()]);
    expect(screen.getByText('Agent Team')).toBeInTheDocument();
  });

  it('shows completed count badge', () => {
    renderPanel([agent({ status: 'complete' }), agent({ name: 'x', status: 'running' })]);
    expect(screen.getByText('1/2')).toBeInTheDocument();
  });

  it('clicking panel header collapses and shows "Running N agents..."', () => {
    renderPanel([agent(), agent({ name: 'y' })]);
    const header = screen.getByText('Agent Team');
    fireEvent.click(header);
    expect(screen.getByText(/Running 2 agents/)).toBeInTheDocument();
  });

  it('collapsed panel shows "N agents completed" when all done', () => {
    renderPanel([agent({ status: 'complete' }), agent({ name: 'y', status: 'complete' })]);
    fireEvent.click(screen.getByText('Agent Team'));
    expect(screen.getByText(/2 agents completed/)).toBeInTheDocument();
  });

  it('agent card header click fires onToggleCollapse(name)', () => {
    const onToggle = vi.fn();
    renderPanel([agent()], [], onToggle);
    fireEvent.click(screen.getByText('explorer'));
    expect(onToggle).toHaveBeenCalledWith('explorer');
  });

  it('collapsed agent shows task preview on header', () => {
    renderPanel([agent({ task: 'Do a thing' })], ['explorer']);
    expect(screen.getByText('Do a thing')).toBeInTheDocument();
  });

  it('renders tool progress count like 1/2', () => {
    renderPanel([agent({
      tools: [
        { name: 'read_file', status: 'done' },
        { name: 'write_file', status: 'running' },
      ],
    })]);
    expect(screen.getByText('1/2')).toBeInTheDocument();
    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.getByText('Writing')).toBeInTheDocument();
  });
});
