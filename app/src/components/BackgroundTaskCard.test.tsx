import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { mockInvoke } from '../test-utils/mockTauri';
import { BackgroundTaskCard } from './BackgroundTaskCard';

const proposal = {
  task_name: 'Compile report',
  task_description: 'Do a thing that takes time',
  context_summary: 'ctx',
  workspace_path: '/tmp/x',
};

describe('BackgroundTaskCard', () => {
  beforeEach(() => {
    mockInvoke({});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders proposal with both action buttons', () => {
    render(
      <BackgroundTaskCard
        proposal={proposal}
        sessionId="s-1"
        originalMessage="please"
      />,
    );
    expect(screen.getByText('Compile report')).toBeInTheDocument();
    expect(screen.getByText('Do a thing that takes time')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /后台执行/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /在这里继续/ })).toBeInTheDocument();
  });

  it('后台执行 invokes confirm_background_task and shows success card', async () => {
    const confirmSpy = vi.fn().mockResolvedValue({ task_id: 't-1' });
    mockInvoke({ confirm_background_task: confirmSpy });
    const onConfirmed = vi.fn();

    render(
      <BackgroundTaskCard
        proposal={proposal}
        sessionId="s-1"
        originalMessage="please"
        onConfirmed={onConfirmed}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /后台执行/ }));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    await waitFor(() => expect(onConfirmed).toHaveBeenCalled());
    expect(screen.getByText(/任务已在后台开始/)).toBeInTheDocument();
  });

  it('在这里继续 triggers onInline and unmounts self', () => {
    const onInline = vi.fn();
    const { container } = render(
      <BackgroundTaskCard
        proposal={proposal}
        sessionId="s-1"
        originalMessage="please"
        onInline={onInline}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /在这里继续/ }));
    expect(onInline).toHaveBeenCalled();
    expect(container.textContent).toBe('');
  });

  it('后台执行 failure rolls back chosen state', async () => {
    const confirmSpy = vi.fn().mockRejectedValue(new Error('nope'));
    mockInvoke({ confirm_background_task: confirmSpy });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <BackgroundTaskCard
        proposal={proposal}
        sessionId="s-1"
        originalMessage="please"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /后台执行/ }));
    await waitFor(() => expect(err).toHaveBeenCalled());
    // Buttons are back since chosen reset to null
    expect(screen.getByRole('button', { name: /后台执行/ })).toBeInTheDocument();
  });
});
