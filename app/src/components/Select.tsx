/**
 * Custom Select Component
 * Apple-inspired dropdown with keyboard navigation
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { ChevronDown, Check } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** Compact inline style (no border, transparent bg) */
  variant?: 'default' | 'inline';
  /** Full width */
  fullWidth?: boolean;
}

export function Select({
  value,
  onChange,
  options,
  placeholder,
  disabled = false,
  className = '',
  variant = 'default',
  fullWidth = false,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [focusedIdx, setFocusedIdx] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((o) => o.value === value);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Scroll focused item into view
  useEffect(() => {
    if (!open || focusedIdx < 0) return;
    const el = listRef.current?.children[focusedIdx] as HTMLElement;
    el?.scrollIntoView({ block: 'nearest' });
  }, [focusedIdx, open]);

  const toggle = useCallback(() => {
    if (disabled) return;
    setOpen((prev) => {
      if (!prev) {
        const idx = options.findIndex((o) => o.value === value);
        setFocusedIdx(idx >= 0 ? idx : 0);
      }
      return !prev;
    });
  }, [disabled, options, value]);

  const select = useCallback(
    (opt: SelectOption) => {
      if (opt.disabled) return;
      onChange(opt.value);
      setOpen(false);
    },
    [onChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (disabled) return;

      if (!open) {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
          e.preventDefault();
          toggle();
        }
        return;
      }

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setFocusedIdx((prev) => {
            let next = prev + 1;
            while (next < options.length && options[next].disabled) next++;
            return next < options.length ? next : prev;
          });
          break;
        case 'ArrowUp':
          e.preventDefault();
          setFocusedIdx((prev) => {
            let next = prev - 1;
            while (next >= 0 && options[next].disabled) next--;
            return next >= 0 ? next : prev;
          });
          break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          if (focusedIdx >= 0 && focusedIdx < options.length) {
            select(options[focusedIdx]);
          }
          break;
        case 'Escape':
          e.preventDefault();
          setOpen(false);
          break;
      }
    },
    [disabled, open, focusedIdx, options, toggle, select],
  );

  const isInline = variant === 'inline';

  return (
    <div
      ref={containerRef}
      className={`relative ${fullWidth ? 'w-full' : 'inline-block'} ${className}`}
      onKeyDown={handleKeyDown}
      tabIndex={disabled ? -1 : 0}
      role="combobox"
      aria-expanded={open}
      aria-haspopup="listbox"
    >
      {/* Trigger */}
      <button
        type="button"
        onClick={toggle}
        disabled={disabled}
        className={`
          flex items-center justify-between gap-2 transition-all text-[13px] font-medium
          ${isInline
            ? 'bg-transparent pr-1 py-0.5 text-[var(--color-text)] hover:text-[var(--color-primary)]'
            : `
              w-full px-3.5 py-2 rounded-xl
              border border-[var(--color-border)] bg-[var(--color-bg)]
              hover:border-[var(--color-border-strong)]
              focus:outline-none focus:ring-4 focus:ring-[var(--color-primary-subtle)] focus:border-[var(--color-primary)]
              ${open ? 'ring-4 ring-[var(--color-primary-subtle)] border-[var(--color-primary)]' : ''}
            `
          }
          disabled:opacity-40 disabled:cursor-not-allowed
        `}
      >
        <span className={`truncate ${!selectedOption && !isInline ? 'text-[var(--color-text-tertiary)]' : ''}`}>
          {selectedOption?.label || placeholder || ''}
        </span>
        <ChevronDown
          size={isInline ? 12 : 14}
          className={`shrink-0 text-[var(--color-text-tertiary)] transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Dropdown */}
      {open && (
        <div
          ref={listRef}
          role="listbox"
          className={`
            absolute z-[9999] mt-1.5 py-1 rounded-xl
            bg-[var(--color-bg-elevated)] border border-[var(--color-border)]
            shadow-lg overflow-y-auto
            animate-scale-in origin-top
            ${isInline ? 'min-w-[140px] left-0' : 'w-full'}
          `}
          style={{ maxHeight: '240px' }}
        >
          {options.map((opt, idx) => (
            <div
              key={opt.value}
              role="option"
              aria-selected={opt.value === value}
              onClick={() => select(opt)}
              onMouseEnter={() => setFocusedIdx(idx)}
              className={`
                flex items-center justify-between gap-2 px-3 py-2 text-[13px] cursor-pointer transition-colors
                ${opt.disabled ? 'opacity-40 cursor-not-allowed' : ''}
                ${focusedIdx === idx ? 'bg-[var(--color-primary-subtle)]' : ''}
                ${opt.value === value ? 'text-[var(--color-primary)] font-medium' : 'text-[var(--color-text)]'}
              `}
            >
              <span className="truncate">{opt.label}</span>
              {opt.value === value && (
                <Check size={14} className="shrink-0 text-[var(--color-primary)]" />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
