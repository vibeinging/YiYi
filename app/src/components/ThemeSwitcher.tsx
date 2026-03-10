/**
 * Theme Switcher Component
 * Apple-inspired
 */

import { useRef, useState, useEffect } from 'react';
import { Sun, Moon, Monitor, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTheme, ThemeMode } from '../hooks/useTheme';

interface ThemeOption {
  value: ThemeMode;
  labelKey: string;
  icon: typeof Sun;
}

const getThemeOptions = (t: any): ThemeOption[] => [
  { value: 'light', labelKey: 'theme.light', icon: Sun },
  { value: 'dark', labelKey: 'theme.dark', icon: Moon },
  { value: 'system', labelKey: 'theme.system', icon: Monitor },
];

export const ThemeSwitcher = () => {
  const { t } = useTranslation();
  const { themeMode, appliedTheme, setThemeMode } = useTheme();
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Get current display icon
  const getCurrentIcon = () => {
    if (themeMode === 'system') {
      return Monitor;
    }
    return appliedTheme === 'dark' ? Moon : Sun;
  };

  const CurrentIcon = getCurrentIcon();

  // Click outside to close
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        !buttonRef.current?.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  // ESC to close
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const handleSelect = (mode: ThemeMode) => {
    setThemeMode(mode);
    setIsOpen(false);
  };

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setIsOpen(!isOpen)}
        className="w-10 h-10 flex items-center justify-center rounded-xl hover:bg-[var(--color-bg-subtle)] transition-colors"
        aria-label="Toggle theme"
      >
        <CurrentIcon size={18} className="text-[var(--color-text-secondary)]" />
      </button>

      {isOpen && (
        <div
          ref={dropdownRef}
          className="absolute right-0 top-full mt-2 w-40 bg-[var(--color-bg-elevated)] rounded-2xl border border-[var(--color-border)] shadow-xl overflow-hidden animate-scale-in"
          role="listbox"
        >
          {getThemeOptions(t).map((option) => {
            const Icon = option.icon;
            const isActive = themeMode === option.value;

            return (
              <button
                key={option.value}
                onClick={() => handleSelect(option.value)}
                className="w-full flex items-center gap-3 px-4 py-3 text-[13px] text-[var(--color-text)] hover:bg-[var(--color-bg-subtle)] transition-colors"
                role="option"
              >
                <Icon size={16} className="text-[var(--color-text-secondary)]" />
                <span className="flex-1 text-left">{t(option.labelKey)}</span>
                {isActive && <Check size={14} className="text-[var(--color-primary)]" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
