import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TASK_STATUS_CONFIG, formatDuration, timeAgo } from './taskStatus';

describe('TASK_STATUS_CONFIG', () => {
  it('covers every known status with the expected shape', () => {
    const statuses = ['running', 'completed', 'failed', 'paused', 'pending', 'cancelled'];
    for (const s of statuses) {
      const cfg = TASK_STATUS_CONFIG[s];
      expect(cfg).toBeDefined();
      expect(typeof cfg.color).toBe('string');
      expect(typeof cfg.label).toBe('string');
      expect(cfg.Icon).toBeDefined();
      expect(typeof cfg.spin).toBe('boolean');
    }
  });

  it('only marks the running status as spinning', () => {
    expect(TASK_STATUS_CONFIG.running.spin).toBe(true);
    expect(TASK_STATUS_CONFIG.completed.spin).toBe(false);
    expect(TASK_STATUS_CONFIG.failed.spin).toBe(false);
  });
});

describe('formatDuration', () => {
  it('formats milliseconds when < 1s', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('formats seconds with one decimal when < 60s', () => {
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(59_900)).toBe('59.9s');
  });

  it('formats minutes + seconds when < 1h', () => {
    expect(formatDuration(60_000)).toBe('1m 0s');
    expect(formatDuration(90_500)).toBe('1m 30s');
  });

  it('formats hours + minutes when >= 1h', () => {
    expect(formatDuration(3_600_000)).toBe('1h 0m');
    expect(formatDuration(3_600_000 + 30 * 60_000)).toBe('1h 30m');
    expect(formatDuration(2 * 3_600_000 + 5 * 60_000)).toBe('2h 5m');
  });
});

describe('timeAgo', () => {
  const now = new Date('2026-04-21T12:00:00Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  it('returns seconds when < 1 minute', () => {
    expect(timeAgo(now - 10_000)).toBe('10s');
    expect(timeAgo(now - 59_000)).toBe('59s');
  });

  it('returns minutes when < 1 hour', () => {
    expect(timeAgo(now - 60_000)).toBe('1m');
    expect(timeAgo(now - 30 * 60_000)).toBe('30m');
  });

  it('returns hours when < 1 day', () => {
    expect(timeAgo(now - 3_600_000)).toBe('1h');
    expect(timeAgo(now - 23 * 3_600_000)).toBe('23h');
  });

  it('returns days when >= 1 day', () => {
    expect(timeAgo(now - 86_400_000)).toBe('1d');
    expect(timeAgo(now - 30 * 86_400_000)).toBe('30d');
  });
});
