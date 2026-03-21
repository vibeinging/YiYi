/**
 * Setup Wizard - Language selection step
 */

import { Check } from 'lucide-react';
import yiyiLogo from '../../assets/yiyi-logo.png';
import type { Lang } from './setupWizardData';

export interface StepLanguageProps {
  lang: Lang;
  selectedLang: string;
  onLangSelect: (lng: string) => void;
}

export function StepLanguage({ lang, selectedLang, onLangSelect }: StepLanguageProps) {
  return (
    <div className="text-center pt-20">
      <img src={yiyiLogo} alt="YiYi" className="w-24 h-24 rounded-3xl mx-auto mb-8 sw-hero-logo sw-float" style={{ boxShadow: '0 8px 32px rgba(0,0,0,0.12)' }} />
      <h1 className="text-4xl font-extrabold mb-4 tracking-tight sw-hero-title" style={{ color: 'var(--color-text)' }}>
        {lang === 'zh' ? '欢迎使用 YiYi' : 'Welcome to YiYi'}
      </h1>
      <p className="text-[16px] mb-12 sw-hero-sub" style={{ color: 'var(--color-text-secondary)' }}>
        {lang === 'zh' ? '选择你偏好的语言' : 'Choose your preferred language'}
      </p>

      <div className="flex gap-6 justify-center sw-hero-cards">
        {[
          { id: 'zh', label: '中文', sub: 'Chinese' },
          { id: 'en', label: 'English', sub: '英语' },
        ].map((l) => (
          <button
            key={l.id}
            onClick={() => onLangSelect(l.id)}
            className="w-52 p-7 rounded-2xl border-2 text-center relative sw-card"
            style={{
              background: selectedLang === l.id ? 'var(--color-primary)' : 'var(--color-bg-elevated)',
              borderColor: selectedLang === l.id ? 'var(--color-primary)' : 'var(--color-border)',
              color: selectedLang === l.id ? '#fff' : 'var(--color-text)',
              boxShadow: selectedLang === l.id ? '0 8px 32px rgba(var(--color-primary-rgb), 0.3)' : 'var(--shadow-sm)',
            }}
          >
            {selectedLang === l.id && (
              <div className="absolute top-3 right-3">
                <Check size={16} />
              </div>
            )}
            <div className="text-xl font-bold mb-1.5">{l.label}</div>
            <div className="text-[13px]" style={{ color: selectedLang === l.id ? 'rgba(255,255,255,0.8)' : 'var(--color-text-muted)' }}>{l.sub}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
