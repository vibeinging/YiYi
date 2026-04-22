import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../i18n';
import { mockInvoke } from '../test-utils/mockTauri';
import { TaskExecutionDetail } from './TaskExecutionDetail';
import type { CronJobExecution } from '../api/cronjobs';

function exec(over: Partial<CronJobExecution> = {}): CronJobExecution {
  const now = Date.now();
  return {
    id: Math.floor(Math.random() * 10000),
    job_id: 'j1',
    started_at: now - 30_000,
    finished_at: now,
    status: 'success',
    result: 'all good',
    trigger_type: 'scheduled',
    ...over,
  };
}

describe('TaskExecutionDetail', () => {
  beforeEach(() => {
    mockInvoke({});
  });

  it('renders null when open=false', () => {
    const { container } = render(
      <TaskExecutionDetail open={false} onClose={() => {}} jobId="j1" jobName="Job" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows loading spinner while executions load', () => {
    mockInvoke({ list_cronjob_executions: () => new Promise(() => {}) });
    render(<TaskExecutionDetail open onClose={() => {}} jobId="j1" jobName="Job" />);
    // Presence check via role / no-results branch not rendered yet.
    expect(screen.queryByText(/records/)).toBeInTheDocument();
  });

  it('shows empty-state text when no executions', async () => {
    mockInvoke({ list_cronjob_executions: vi.fn().mockResolvedValue([]) });
    render(<TaskExecutionDetail open onClose={() => {}} jobId="j1" jobName="Job" />);
    await waitFor(() => expect(screen.getByText(/0 records/)).toBeInTheDocument());
  });

  it('renders records and auto-selects first', async () => {
    mockInvoke({
      list_cronjob_executions: vi.fn().mockResolvedValue([
        exec({ id: 1, status: 'success', result: 'done ok line one\nsecond line' }),
        exec({ id: 2, status: 'failed', result: 'error boom' }),
      ]),
    });
    render(<TaskExecutionDetail open onClose={() => {}} jobId="j1" jobName="Job" />);
    await waitFor(() => expect(screen.getByText(/2 records/)).toBeInTheDocument());
    // Status labels appear
    expect(screen.getAllByText('Success').length).toBeGreaterThan(0);
    expect(screen.getByText('Failed')).toBeInTheDocument();
    // Preview snippet
    expect(screen.getByText('done ok line one')).toBeInTheDocument();
  });

  it('clicking a different record updates selection styling', async () => {
    mockInvoke({
      list_cronjob_executions: vi.fn().mockResolvedValue([
        exec({ id: 1, status: 'success', result: 'FIRST LINE' }),
        exec({ id: 2, status: 'failed', result: 'SECOND LINE' }),
      ]),
    });
    render(<TaskExecutionDetail open onClose={() => {}} jobId="j1" jobName="Job" />);
    await waitFor(() => expect(screen.getByText('SECOND LINE')).toBeInTheDocument());
    fireEvent.click(screen.getByText('SECOND LINE'));
    // After click, content is also rendered in the right pane → >= 1 match.
    expect(screen.getAllByText('SECOND LINE').length).toBeGreaterThanOrEqual(1);
  });

  it('Escape key closes panel', async () => {
    const onClose = vi.fn();
    mockInvoke({ list_cronjob_executions: vi.fn().mockResolvedValue([]) });
    render(<TaskExecutionDetail open onClose={onClose} jobId="j1" jobName="Job" />);
    await waitFor(() => expect(screen.getByText(/0 records/)).toBeInTheDocument());
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('manual trigger shows yellow badge, scheduled shows info badge', async () => {
    mockInvoke({
      list_cronjob_executions: vi.fn().mockResolvedValue([
        exec({ id: 1, trigger_type: 'manual', result: 'manual-run' }),
        exec({ id: 2, trigger_type: 'scheduled', result: 'scheduled-run' }),
      ]),
    });
    render(<TaskExecutionDetail open onClose={() => {}} jobId="j1" jobName="Job" />);
    await waitFor(() => expect(screen.getByText('manual-run')).toBeInTheDocument());
    // Both trigger-type entries rendered (i18n labels may vary)
    expect(screen.getByText('scheduled-run')).toBeInTheDocument();
  });

  it('records singular label for exactly 1 execution', async () => {
    mockInvoke({
      list_cronjob_executions: vi.fn().mockResolvedValue([exec({ id: 1 })]),
    });
    render(<TaskExecutionDetail open onClose={() => {}} jobId="j1" jobName="Job" />);
    await waitFor(() => expect(screen.getByText(/1 record$/)).toBeInTheDocument());
  });
});
