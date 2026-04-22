import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
import { render, screen, fireEvent } from '@testing-library/react';
import '../i18n';
import i18n from '../i18n';
import { LanguageSwitcher } from './LanguageSwitcher';

describe('LanguageSwitcher', () => {
  beforeEach(() => {
    localStorage.clear();
    i18n.changeLanguage('zh');
  });

  it('renders current language label', () => {
    render(<LanguageSwitcher />);
    const trigger = screen.getByRole('button');
    expect(trigger).toHaveTextContent('中文');
  });

  it('switching to English updates i18n + localStorage', () => {
    render(<LanguageSwitcher />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByRole('option', { name: 'English' }));
    expect(i18n.language).toBe('en');
    expect(localStorage.getItem('language')).toBe('en');
  });
});
