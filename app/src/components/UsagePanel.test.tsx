import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { mockInvoke } from '../test-utils/mockTauri';
import { UsagePanel } from './UsagePanel';

const emptySummary = {
  total_input_tokens: 0,
  total_output_tokens: 0,
  total_cache_read_tokens: 0,
  total_cache_write_tokens: 0,
  total_cost_usd: 0,
  call_count: 0,
};

describe('UsagePanel', () => {
  beforeEach(() => {
    mockInvoke({});
  });

  it('renders "加载中..." while summary pending', () => {
    mockInvoke({
      get_usage_summary: () => new Promise(() => {}),
      get_usage_by_session: () => Promise.resolve([]),
      get_usage_daily: () => new Promise(() => {}),
    });
    render(<UsagePanel />);
    expect(screen.getByText('加载中...')).toBeInTheDocument();
  });

  it('renders empty state when no usage', async () => {
    mockInvoke({
      get_usage_summary: vi.fn().mockResolvedValue(emptySummary),
      get_usage_by_session: vi.fn().mockResolvedValue([]),
      get_usage_daily: vi.fn().mockResolvedValue([]),
    });
    render(<UsagePanel />);
    expect(await screen.findByText('暂无用量数据')).toBeInTheDocument();
  });

  it('renders summary cards with token/cost values', async () => {
    mockInvoke({
      get_usage_summary: vi.fn().mockResolvedValue({
        total_input_tokens: 1500,
        total_output_tokens: 500,
        total_cache_read_tokens: 300,
        total_cache_write_tokens: 0,
        total_cost_usd: 0.25,
        call_count: 10,
      }),
      get_usage_by_session: vi.fn().mockResolvedValue([]),
      get_usage_daily: vi.fn().mockResolvedValue([]),
    });
    render(<UsagePanel />);
    expect(await screen.findByText('2.0K')).toBeInTheDocument();
    expect(screen.getByText('$0.25')).toBeInTheDocument();
    expect(screen.getByText('10 次调用')).toBeInTheDocument();
  });

  it('renders per-session breakdown when sessions exist', async () => {
    mockInvoke({
      get_usage_summary: vi.fn().mockResolvedValue(emptySummary),
      get_usage_by_session: vi.fn().mockResolvedValue([
        { session_id: 'abcdefghijk123456789zzz', summary: { ...emptySummary, call_count: 2, total_cost_usd: 0.01 } },
      ]),
      get_usage_daily: vi.fn().mockResolvedValue([]),
    });
    render(<UsagePanel />);
    expect(await screen.findByText('按会话')).toBeInTheDocument();
    expect(screen.getByText(/abcdefgh\.\.\./)).toBeInTheDocument();
    expect(screen.getByText('$0.01')).toBeInTheDocument();
  });

  it('renders daily trend bars when >1 days', async () => {
    mockInvoke({
      get_usage_summary: vi.fn().mockResolvedValue(emptySummary),
      get_usage_by_session: vi.fn().mockResolvedValue([]),
      get_usage_daily: vi.fn().mockResolvedValue([
        { date: '2026-04-20', summary: { ...emptySummary, total_cost_usd: 0.1 } },
        { date: '2026-04-21', summary: { ...emptySummary, total_cost_usd: 0.2 } },
      ]),
    });
    render(<UsagePanel />);
    expect(await screen.findByText('每日用量')).toBeInTheDocument();
    expect(screen.getByText('2026-04-20')).toBeInTheDocument();
    expect(screen.getByText('2026-04-21')).toBeInTheDocument();
  });

  it('changing range triggers a new summary fetch', async () => {
    const summary = vi.fn().mockResolvedValue(emptySummary);
    mockInvoke({
      get_usage_summary: summary,
      get_usage_by_session: vi.fn().mockResolvedValue([]),
      get_usage_daily: vi.fn().mockResolvedValue([]),
    });
    render(<UsagePanel />);
    await screen.findByText('暂无用量数据');
    const calls = summary.mock.calls.length;
    fireEvent.click(screen.getByText('7 天'));
    await waitFor(() => expect(summary.mock.calls.length).toBeGreaterThan(calls));
  });
});
