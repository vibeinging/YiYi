/**
 * Language Switcher Component
 * Apple-inspired
 */

import { useTranslation } from 'react-i18next';
import { Globe } from 'lucide-react';
import { Select } from './Select';

export function LanguageSwitcher() {
  const { i18n } = useTranslation();

  const changeLanguage = (lng: string) => {
    i18n.changeLanguage(lng);
    localStorage.setItem('language', lng);
  };

  const currentLanguage = i18n.language;

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-[var(--color-bg-elevated)] border border-[var(--color-border)] shadow-sm">
      <Globe size={16} className="text-[var(--color-text-tertiary)]" />
      <Select
        value={currentLanguage}
        onChange={changeLanguage}
        options={[
          { value: 'zh', label: '中文' },
          { value: 'en', label: 'English' },
        ]}
        variant="inline"
      />
    </div>
  );
}
