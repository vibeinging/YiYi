import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { ToastProvider, useToast, toast, confirm } from './Toast';

function Harness() {
  const { showToast } = useToast();
  return (
    <button onClick={() => showToast('success', 'hello')}>trigger-hook</button>
  );
}

describe('Toast', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('useToast outside provider throws', () => {
    const orig = console.error;
    console.error = () => {};
    expect(() => render(<Harness />)).toThrow(/ToastProvider/);
    console.error = orig;
  });

  it('showToast via hook renders and auto-dismisses after 3.5s', async () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('trigger-hook'));
    expect(screen.getByText('hello')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3600);
    });
    expect(screen.queryByText('hello')).not.toBeInTheDocument();
  });

  it('imperative toast.success works once provider mounted', async () => {
    render(
      <ToastProvider>
        <div />
      </ToastProvider>,
    );
    act(() => {
      toast.success('imperative-ok');
    });
    expect(await screen.findByText('imperative-ok')).toBeInTheDocument();
  });

  it('imperative toast.error / warning / info dispatch distinct messages', async () => {
    render(
      <ToastProvider>
        <div />
      </ToastProvider>,
    );
    act(() => {
      toast.error('err-msg');
      toast.warning('warn-msg');
      toast.info('info-msg');
    });
    expect(await screen.findByText('err-msg')).toBeInTheDocument();
    expect(screen.getByText('warn-msg')).toBeInTheDocument();
    expect(screen.getByText('info-msg')).toBeInTheDocument();
  });

  it('confirm resolves true when user clicks 确认', async () => {
    render(
      <ToastProvider>
        <div />
      </ToastProvider>,
    );
    let result: boolean | null = null;
    act(() => {
      confirm('delete?').then((v) => (result = v));
    });
    expect(await screen.findByText('delete?')).toBeInTheDocument();
    fireEvent.click(screen.getByText('确认'));
    await waitFor(() => expect(result).toBe(true));
    expect(screen.queryByText('delete?')).not.toBeInTheDocument();
  });

  it('confirm resolves false when user clicks 取消', async () => {
    render(
      <ToastProvider>
        <div />
      </ToastProvider>,
    );
    let result: boolean | null = null;
    act(() => {
      confirm('wipe?').then((v) => (result = v));
    });
    await screen.findByText('wipe?');
    fireEvent.click(screen.getByText('取消'));
    await waitFor(() => expect(result).toBe(false));
  });

  it('dismiss button removes a toast immediately', async () => {
    render(
      <ToastProvider>
        <div />
      </ToastProvider>,
    );
    act(() => toast.info('pin-me'));
    const msg = await screen.findByText('pin-me');
    const btn = msg.parentElement?.querySelector('button');
    expect(btn).toBeTruthy();
    fireEvent.click(btn!);
    expect(screen.queryByText('pin-me')).not.toBeInTheDocument();
  });
});
