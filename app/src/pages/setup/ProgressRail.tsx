/**
 * Setup Wizard - Left sidebar progress rail
 */

import {
  Globe,
  Cpu,
  User,
  Check,
  FolderOpen,
  Brain,
  Database,
} from 'lucide-react';
import yiyiLogo from '../../assets/yiyi-logo.png';
import type { Lang, Step } from './setupWizardData';
import { STEPS } from './setupWizardData';

// Step metadata with icons
const STEP_META = [
  { id: 'language' as const, icon: Globe, labelKey: { zh: '语言', en: 'Language' } },
  { id: 'model' as const, icon: Cpu, labelKey: { zh: '模型', en: 'Model' } },
  { id: 'workspace' as const, icon: FolderOpen, labelKey: { zh: '工作空间', en: 'Workspace' } },
  { id: 'persona' as const, icon: User, labelKey: { zh: '人格', en: 'Persona' } },
  { id: 'memory' as const, icon: Database, labelKey: { zh: '记忆', en: 'Memory' } },
  { id: 'meditation' as const, icon: Brain, labelKey: { zh: '冥想', en: 'Meditation' } },
];

export interface ProgressRailProps {
  lang: Lang;
  currentStep: Step;
}

export function ProgressRail({ lang, currentStep }: ProgressRailProps) {
  const stepIndex = STEPS.indexOf(currentStep);

  return (
    <div
      className="w-[260px] shrink-0 flex flex-col items-center pt-20 pb-10 px-6"
      style={{
        background: 'var(--color-bg-elevated)',
        borderRight: '1px solid var(--color-border)',
      }}
    >
      {/* Brand */}
      <div className="mb-16 text-center">
        <img src={yiyiLogo} alt="YiYi" className="w-14 h-14 rounded-2xl mx-auto mb-3 sw-sidebar-logo" />
        <div className="text-[20px] font-extrabold tracking-tight" style={{ color: 'var(--color-text)' }}>
          YiYi
        </div>
        <div className="text-[12px] mt-1 font-medium tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
          {lang === 'zh' ? '初始设置' : 'Setup'}
        </div>
      </div>

      {/* Steps */}
      <div className="flex flex-col items-start gap-0 w-full pl-6">
        {STEP_META.map((step, i) => {
          const Icon = step.icon;
          const isActive = i === stepIndex;
          const isDone = i < stepIndex;

          return (
            <div key={step.id} className="flex items-start gap-0">
              {/* Dot + Line column */}
              <div className="flex flex-col items-center">
                <div
                  className={`w-11 h-11 rounded-full flex items-center justify-center sw-step-dot ${
                    isDone ? 'bg-[var(--color-success)]' :
                    isActive ? 'bg-[var(--color-primary)] active' :
                    'bg-[var(--color-bg-subtle)]'
                  }`}
                  style={{
                    boxShadow: isActive ? '0 0 0 5px var(--color-primary-subtle)' : 'none',
                  }}
                >
                  {isDone ? (
                    <Check size={18} className="text-white sw-check-enter" />
                  ) : (
                    <Icon size={18} className={isActive ? 'text-white' : ''} style={{ color: isActive ? undefined : 'var(--color-text-muted)' }} />
                  )}
                </div>
                {/* Connecting line */}
                {i < STEP_META.length - 1 && (
                  <div
                    className="w-0.5 h-14 transition-colors duration-300"
                    style={{
                      background: isDone ? 'var(--color-success)' : 'var(--color-border)',
                    }}
                  />
                )}
              </div>

              {/* Label */}
              <div className="ml-4 pt-2.5">
                <div
                  className={`text-[14px] font-semibold transition-colors duration-300`}
                  style={{
                    color: isActive ? 'var(--color-text)' : isDone ? 'var(--color-success)' : 'var(--color-text-muted)',
                  }}
                >
                  {step.labelKey[lang]}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Version */}
      <div className="text-[11px] font-medium" style={{ color: 'var(--color-text-tertiary)' }}>
        v0.0.1
      </div>
    </div>
  );
}
