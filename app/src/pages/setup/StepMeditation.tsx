/**
 * Setup Wizard - Meditation configuration step
 */

import { Brain } from 'lucide-react';
import type { Lang } from './setupWizardData';

export interface StepMeditationProps {
  lang: Lang;
  meditationEnabled: boolean;
  meditationStart: string;
  meditationNotify: boolean;
  onMeditationEnabledChange: (enabled: boolean) => void;
  onMeditationStartChange: (time: string) => void;
  onMeditationNotifyChange: (notify: boolean) => void;
}

export function StepMeditation({
  lang,
  meditationEnabled,
  meditationStart,
  meditationNotify,
  onMeditationEnabledChange,
  onMeditationStartChange,
  onMeditationNotifyChange,
}: StepMeditationProps) {
  return (
    <div className="pt-10">
      <div className="text-center mb-10">
        <div className="w-20 h-20 rounded-3xl bg-[var(--color-primary-subtle)] flex items-center justify-center mx-auto mb-8">
          <Brain size={36} className="text-[var(--color-primary)]" />
        </div>
        <h1 className="text-4xl font-extrabold mb-4 tracking-tight" style={{ color: 'var(--color-text)' }}>
          {lang === 'zh' ? '冥想时间' : 'Meditation Time'}
        </h1>
        <p className="text-[16px]" style={{ color: 'var(--color-text-secondary)' }}>
          {lang === 'zh'
            ? 'YiYi 也需要时间来沉淀和思考'
            : 'YiYi needs time to reflect and grow'}
        </p>
      </div>

      {/* Enable toggle */}
      <div className="mb-8 sw-stagger-1">
        <label
          className="flex items-center gap-3 cursor-pointer select-none"
          style={{ color: 'var(--color-text)' }}
        >
          <input
            type="checkbox"
            checked={meditationEnabled}
            onChange={(e) => onMeditationEnabledChange(e.target.checked)}
            className="w-5 h-5 rounded accent-[var(--color-primary)]"
          />
          <span className="text-[15px] font-semibold">
            {lang === 'zh' ? '启用每日冥想' : 'Enable daily meditation'}
          </span>
        </label>
      </div>

      {/* Time selection (only when enabled) */}
      {meditationEnabled && (
        <>
          <div className="mb-6 sw-stagger-2">
            <label className="text-[13px] font-semibold block mb-3" style={{ color: 'var(--color-text-muted)' }}>
              {lang === 'zh' ? '冥想开始时间' : 'Meditation start time'}
            </label>
            <input
              type="time"
              value={meditationStart}
              onChange={(e) => onMeditationStartChange(e.target.value)}
              className="px-5 py-3.5 rounded-xl text-[14px] outline-none sw-input-hint"
              style={{
                background: 'var(--color-bg-subtle)',
                color: 'var(--color-text)',
                border: '1px solid var(--color-border)',
              }}
            />
          </div>

          {/* Quick presets */}
          <div className="mb-8 sw-stagger-3">
            <div className="flex gap-3">
              {[
                { time: '00:00', emoji: '\uD83C\uDF03', label: { zh: '夜猫子', en: 'Night Owl' } },
                { time: '23:00', emoji: '\uD83E\uDDD8', label: { zh: '标准', en: 'Standard' }, recommended: true },
                { time: '22:00', emoji: '\uD83C\uDF05', label: { zh: '早鸟', en: 'Early Bird' } },
              ].map((preset) => (
                <button
                  key={preset.time}
                  onClick={() => onMeditationStartChange(preset.time)}
                  className="flex-1 p-4 rounded-2xl border-2 text-center transition-all"
                  style={{
                    background: meditationStart === preset.time ? 'var(--color-primary)' : 'var(--color-bg-elevated)',
                    borderColor: meditationStart === preset.time ? 'var(--color-primary)' : 'var(--color-border)',
                    boxShadow: meditationStart === preset.time ? '0 2px 12px rgba(var(--color-primary-rgb), 0.25)' : 'none',
                  }}
                >
                  <div className="text-2xl mb-2">{preset.emoji}</div>
                  <div className="text-[13px] font-semibold" style={{ color: meditationStart === preset.time ? '#fff' : 'var(--color-text)' }}>
                    {preset.label[lang]}
                  </div>
                  <div className="text-[12px] mt-0.5" style={{ color: meditationStart === preset.time ? 'rgba(255,255,255,0.7)' : 'var(--color-text-tertiary)' }}>
                    {preset.time}
                    {preset.recommended && (
                      <span className="ml-1.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full" style={{
                        background: meditationStart === preset.time ? 'rgba(255,255,255,0.2)' : 'var(--color-primary-subtle)',
                        color: meditationStart === preset.time ? '#fff' : 'var(--color-primary)',
                      }}>
                        {lang === 'zh' ? '推荐' : 'Recommended'}
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Info box */}
          <div
            className="p-5 rounded-2xl mb-8"
            style={{ background: 'var(--color-bg-subtle)', border: '1px solid var(--color-border)' }}
          >
            <div className="text-[13px] leading-[1.9]" style={{ color: 'var(--color-text-secondary)' }}>
              {lang === 'zh' ? (
                <>
                  <div className="font-semibold mb-2" style={{ color: 'var(--color-text)' }}>冥想期间 YiYi 会：</div>
                  <div>· 回顾今天的聊天记录</div>
                  <div>· 整理学到的知识和行为准则</div>
                  <div>· 更新记忆，淘汰过时信息</div>
                  <div>· 写一篇冥想日志记录成长</div>
                  <div className="mt-3">
                    <span>⚡ 资源占用：约等于一次普通对话</span>
                  </div>
                  <div>
                    <span>⏱️ 持续时间：约 15-30 分钟</span>
                  </div>
                </>
              ) : (
                <>
                  <div className="font-semibold mb-2" style={{ color: 'var(--color-text)' }}>During meditation, YiYi will:</div>
                  <div>· Review today's chat history</div>
                  <div>· Consolidate learned knowledge and behavioral guidelines</div>
                  <div>· Update memory, retire outdated information</div>
                  <div>· Write a meditation journal to track growth</div>
                  <div className="mt-3">
                    <span>⚡ Resource usage: roughly one normal conversation</span>
                  </div>
                  <div>
                    <span>⏱️ Duration: approx. 15-30 minutes</span>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Notification toggle */}
          <div className="sw-stagger-4">
            <label
              className="flex items-center gap-3 cursor-pointer select-none"
              style={{ color: 'var(--color-text)' }}
            >
              <input
                type="checkbox"
                checked={meditationNotify}
                onChange={(e) => onMeditationNotifyChange(e.target.checked)}
                className="w-5 h-5 rounded accent-[var(--color-primary)]"
              />
              <span className="text-[14px] font-medium">
                {lang === 'zh' ? '冥想结束后通知我' : 'Notify me when meditation ends'}
              </span>
            </label>
          </div>
        </>
      )}
    </div>
  );
}
