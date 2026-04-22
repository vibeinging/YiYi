import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTheme } from './useTheme';

function mockMatchMedia(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches,
      media: '',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe('useTheme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('light', 'dark');
    mockMatchMedia(false);
  });
  afterEach(() => {
    document.documentElement.classList.remove('light', 'dark');
  });

  it('defaults to dark when no saved theme', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.themeMode).toBe('dark');
    expect(result.current.appliedTheme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('loads saved light theme from localStorage', () => {
    localStorage.setItem('theme', 'light');
    const { result } = renderHook(() => useTheme());
    expect(result.current.themeMode).toBe('light');
    expect(result.current.appliedTheme).toBe('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('setThemeMode persists to localStorage and toggles class', () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setThemeMode('light'));
    expect(localStorage.getItem('theme')).toBe('light');
    expect(result.current.themeMode).toBe('light');
    expect(result.current.appliedTheme).toBe('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);

    act(() => result.current.setThemeMode('dark'));
    expect(localStorage.getItem('theme')).toBe('dark');
    expect(result.current.appliedTheme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('resolves system mode using prefers-color-scheme', () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setThemeMode('system'));
    expect(result.current.themeMode).toBe('system');
    expect(result.current.appliedTheme).toBe('dark');

    mockMatchMedia(false);
    act(() => result.current.setThemeMode('system'));
    expect(result.current.appliedTheme).toBe('light');
  });
});
