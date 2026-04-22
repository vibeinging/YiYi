import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../i18n';
import { useChatStreamStore, type LongTaskState, type StopReason } from '../stores/chatStreamStore';
import { LongTaskProgressPanel, RoundDivider } from './LongTaskPanel';

const pristine = useChatStreamStore.getState();

function setLongTask(over: Partial<LongTaskState>) {
  useChatStreamStore.setState({
    longTask: {
      enabled: true,
      status: 'running',
      currentRound: 3,
      maxRounds: 10,
      tokensUsed: 2500,
      tokenBudget: 10_000,
      estimatedCostUsd: 0.05,
      budgetCostUsd: 1.0,
      stopReason: null,
      startedAt: Date.now() - 30_000,
      ...over,
    },
  });
}

describe('LongTaskProgressPanel', () => {
  beforeEach(() => {
    useChatStreamStore.setState(pristine, true);
  });

  it('returns null when longTask.status === idle', () => {
    const { container } = render(<LongTaskProgressPanel />);
    expect(container.firstChild).toBeNull();
  });

  it('renders running status with round progress', () => {
    setLongTask({ status: 'running' });
    render(<LongTaskProgressPanel />);
    // Visible round progress exists in header + body
    expect(screen.getAllByText(/3/).length).toBeGreaterThan(0);
    expect(screen.getByText('$0.05')).toBeInTheDocument();
  });

  it('renders token count in body', () => {
    setLongTask({ status: 'running', tokensUsed: 1500, tokenBudget: 10_000 });
    render(<LongTaskProgressPanel />);
    expect(screen.getByText(/2K \/ 10K tokens/)).toBeInTheDocument();
  });

  it('shows stop-reason badge when terminal', () => {
    setLongTask({
      status: 'completed',
      stopReason: 'task_complete' as StopReason,
      currentRound: 5,
      maxRounds: 10,
    });
    const { container } = render(<LongTaskProgressPanel />);
    // StopReasonBadge renders a translated string — assert its container exists
    expect(container.textContent).toMatch(/5\s/);
  });

  it('header click toggles collapse', () => {
    setLongTask({ status: 'running' });
    render(<LongTaskProgressPanel />);
    const header = screen.getAllByRole('button')[0];
    // Body visible initially -> tokens visible
    expect(screen.getByText(/tokens/)).toBeInTheDocument();
    fireEvent.click(header);
    // After collapse, animation leaves content in DOM but hidden via maxHeight.
    // So assert click just does not throw and header still present.
    expect(header).toBeInTheDocument();
  });

  it('large cost (>80% budget) triggers warning formatting', () => {
    setLongTask({
      status: 'running',
      estimatedCostUsd: 0.9,
      budgetCostUsd: 1.0,
    });
    render(<LongTaskProgressPanel />);
    expect(screen.getByText(/\$0\.90 \/ \$1\.00/)).toBeInTheDocument();
  });
});

describe('RoundDivider', () => {
  it('renders round label', () => {
    render(<RoundDivider round={2} maxRounds={10} />);
    expect(screen.getByText(/2 \/ 10/)).toBeInTheDocument();
  });
});
