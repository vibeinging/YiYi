import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { mockEventBridge } from '../test-utils/mockEvent';
import { ToastProvider } from '../components/Toast';
import { useGrowthEventBridge } from './useGrowthEventBridge';

function Harness() {
  useGrowthEventBridge();
  return null;
}

describe('useGrowthEventBridge', () => {
  let bridge: ReturnType<typeof mockEventBridge>;

  beforeEach(() => {
    bridge = mockEventBridge();
  });

  it('renders localized toast when persist suggestion arrives', async () => {
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );
    await vi.waitFor(() => expect(bridge.channels()).toContain('growth://persist_suggestion'));
    act(() => {
      bridge.dispatch('growth://persist_suggestion', {
        type: 'skill',
        name: 'summarize',
        description: 'Summarize long documents',
      });
    });
    expect(await screen.findByText(/可以保存为技能/)).toBeInTheDocument();
    expect(screen.getByText(/summarize/)).toBeInTheDocument();
  });

  it('truncates long descriptions to 60 chars + ...', async () => {
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );
    await vi.waitFor(() => expect(bridge.channels()).toContain('growth://persist_suggestion'));
    const longDesc = 'x'.repeat(200);
    act(() => {
      bridge.dispatch('growth://persist_suggestion', {
        type: 'workflow',
        name: 'n',
        description: longDesc,
      });
    });
    const msg = await screen.findByText(/可以保存为工作流/);
    expect(msg.textContent).toContain('...');
    expect(msg.textContent).not.toContain('x'.repeat(61));
  });

  it('falls back to raw type for unknown categories', async () => {
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );
    await vi.waitFor(() => expect(bridge.channels()).toContain('growth://persist_suggestion'));
    act(() => {
      bridge.dispatch('growth://persist_suggestion', {
        type: 'mystery',
        name: 'x',
        description: 'y',
      });
    });
    expect(await screen.findByText(/可以保存为mystery/)).toBeInTheDocument();
  });
});
