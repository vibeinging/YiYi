import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useChatStreamStore } from '../../stores/chatStreamStore';
import { RetryStatusBar } from './RetryStatusBar';

const pristine = useChatStreamStore.getState();

describe('RetryStatusBar', () => {
  beforeEach(() => {
    useChatStreamStore.setState(pristine, true);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null when no retryStatus', () => {
    const { container } = render(<RetryStatusBar />);
    expect(container.firstChild).toBeNull();
  });

  it('renders known error label + initial countdown from delay_ms', () => {
    useChatStreamStore.setState({
      retryStatus: {
        attempt: 2,
        max_retries: 5,
        delay_ms: 5000,
        error_type: 'rate_limited',
        provider: 'openai',
      },
    });
    render(<RetryStatusBar />);
    expect(screen.getByText(/请求过于频繁/)).toBeInTheDocument();
    expect(screen.getByText(/5秒后/)).toBeInTheDocument();
    expect(screen.getByText(/\(2\/5\)/)).toBeInTheDocument();
  });

  it('falls back to "网络波动" for unknown error type', () => {
    useChatStreamStore.setState({
      retryStatus: {
        attempt: 1,
        max_retries: 3,
        delay_ms: 1000,
        error_type: 'unknown' as any,
        provider: 'x',
      },
    });
    render(<RetryStatusBar />);
    expect(screen.getByText(/网络波动/)).toBeInTheDocument();
  });

  it('countdown decrements every second until 0', () => {
    useChatStreamStore.setState({
      retryStatus: {
        attempt: 1,
        max_retries: 3,
        delay_ms: 3000,
        error_type: 'transient',
        provider: 'x',
      },
    });
    render(<RetryStatusBar />);
    expect(screen.getByText(/3秒后/)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText(/2秒后/)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.getByText(/即将/)).toBeInTheDocument();
  });
});
