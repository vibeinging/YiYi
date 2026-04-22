import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { formatRelativeTime } from './time';

describe('formatRelativeTime', () => {
  const now = new Date('2026-04-21T12:00:00Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  it('returns "-" for null / undefined / 0', () => {
    expect(formatRelativeTime(null)).toBe('-');
    expect(formatRelativeTime(undefined)).toBe('-');
    expect(formatRelativeTime(0)).toBe('-');
  });

  it('returns "Just now" when diff < 1 minute', () => {
    expect(formatRelativeTime(now - 10_000)).toBe('Just now');
    expect(formatRelativeTime(now - 59_999)).toBe('Just now');
  });

  it('returns minutes when diff < 1 hour', () => {
    expect(formatRelativeTime(now - 60_000)).toBe('1m ago');
    expect(formatRelativeTime(now - 30 * 60_000)).toBe('30m ago');
  });

  it('returns hours when diff < 1 day', () => {
    expect(formatRelativeTime(now - 3_600_000)).toBe('1h ago');
    expect(formatRelativeTime(now - 23 * 3_600_000)).toBe('23h ago');
  });

  it('returns days when diff < 1 week', () => {
    expect(formatRelativeTime(now - 86_400_000)).toBe('1d ago');
    expect(formatRelativeTime(now - 6 * 86_400_000)).toBe('6d ago');
  });

  it('returns locale date when diff >= 1 week', () => {
    const old = now - 30 * 86_400_000;
    const result = formatRelativeTime(old);
    expect(result).toBe(new Date(old).toLocaleDateString());
  });
});
