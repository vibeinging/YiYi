import { useEffect, useState } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';

export const useTheme = () => {
  const [themeMode, setThemeModeState] = useState<ThemeMode>('dark');
  const [appliedTheme, setAppliedTheme] = useState<'light' | 'dark'>('dark');

  const setThemeMode = (mode: ThemeMode) => {
    setThemeModeState(mode);
    localStorage.setItem('theme', mode);
    applyTheme(mode);
  };

  const applyTheme = (mode: ThemeMode) => {
    const root = document.documentElement;
    const resolvedTheme = mode === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : mode;

    if (resolvedTheme === 'dark') {
      root.classList.remove('light');
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
      root.classList.add('light');
    }
    setAppliedTheme(resolvedTheme);
  };

  useEffect(() => {
    const savedTheme = (localStorage.getItem('theme') as ThemeMode) || 'dark';
    setThemeModeState(savedTheme);
    applyTheme(savedTheme);
  }, []);

  return {
    themeMode,
    appliedTheme,
    setThemeMode,
  };
};
