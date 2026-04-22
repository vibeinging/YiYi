import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../i18n';
import { ThemeSwitcher } from './ThemeSwitcher';

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

describe('ThemeSwitcher', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('light', 'dark');
    mockMatchMedia(false);
  });

  it('renders trigger button with aria-label', () => {
    render(<ThemeSwitcher />);
    expect(screen.getByLabelText('Toggle theme')).toBeInTheDocument();
  });

  it('opens dropdown on click and shows all three modes', () => {
    render(<ThemeSwitcher />);
    fireEvent.click(screen.getByLabelText('Toggle theme'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('selecting light applies the light class', () => {
    render(<ThemeSwitcher />);
    fireEvent.click(screen.getByLabelText('Toggle theme'));
    const lightOption = screen.getAllByRole('option')[0];
    fireEvent.click(lightOption);
    expect(localStorage.getItem('theme')).toBe('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });

  it('closes on Escape key', () => {
    render(<ThemeSwitcher />);
    fireEvent.click(screen.getByLabelText('Toggle theme'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
