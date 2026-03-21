/**
 * Setup Wizard - Persona configuration step
 */

import { TONE_STYLES, ROLE_PRESETS, buildSoulContent, type Lang } from './setupWizardData';

export interface StepPersonaProps {
  lang: Lang;
  currentStep: string;
  aiName: string;
  ownerName: string;
  toneStyle: string;
  selectedRole: string;
  customSoul: string;
  onAiNameChange: (name: string) => void;
  onOwnerNameChange: (name: string) => void;
  onToneStyleChange: (tone: string) => void;
  onSelectedRoleChange: (role: string) => void;
  onCustomSoulChange: (soul: string) => void;
}

export function StepPersona({
  lang,
  currentStep,
  aiName,
  ownerName,
  toneStyle,
  selectedRole,
  customSoul,
  onAiNameChange,
  onOwnerNameChange,
  onToneStyleChange,
  onSelectedRoleChange,
  onCustomSoulChange,
}: StepPersonaProps) {
  return (
    <div className="flex-1 overflow-y-auto min-h-0">
      <div className="text-center mb-10">
        <h1 className="text-4xl font-extrabold mb-4 tracking-tight" style={{ color: 'var(--color-text)' }}>
          {lang === 'zh' ? '设定你的 AI 助手' : 'Set Up Your AI Assistant'}
        </h1>
        <p className="text-[16px]" style={{ color: 'var(--color-text-secondary)' }}>
          {lang === 'zh' ? '给 AI 起个名字，告诉它你是谁' : 'Give your AI a name and introduce yourself'}
        </p>
      </div>

      {/* Names row */}
      <div className="grid grid-cols-2 gap-6 mb-8">
        <div className="p-6 rounded-2xl border sw-stagger-1" style={{ background: 'var(--color-bg-elevated)', borderColor: 'var(--color-border)' }}>
          <label className="text-[13px] font-semibold block mb-3" style={{ color: 'var(--color-text-muted)' }}>
            {lang === 'zh' ? 'AI 的名字' : 'AI Name'}
          </label>
          <input
            key={`ai-name-${currentStep}`}
            value={aiName}
            onChange={(e) => onAiNameChange(e.target.value)}
            placeholder="YiYi"
            className="w-full px-4 py-3 rounded-xl text-[15px] font-medium outline-none sw-input-hint"
            style={{
              background: 'var(--color-bg-subtle)',
              color: 'var(--color-text)',
              border: '1px solid var(--color-border)',
              transition: 'border-color 0.2s, box-shadow 0.2s',
            }}
          />
        </div>
        <div className="p-6 rounded-2xl border sw-stagger-2" style={{ background: 'var(--color-bg-elevated)', borderColor: 'var(--color-border)' }}>
          <label className="text-[13px] font-semibold block mb-3" style={{ color: 'var(--color-text-muted)' }}>
            {lang === 'zh' ? '你的称呼（主人名字）' : 'Your Name (Owner)'}
          </label>
          <input
            key={`owner-name-${currentStep}`}
            value={ownerName}
            onChange={(e) => onOwnerNameChange(e.target.value)}
            placeholder={lang === 'zh' ? '你的名字或昵称' : 'Your name or nickname'}
            className="w-full px-4 py-3 rounded-xl text-[15px] font-medium outline-none sw-input-hint"
            style={{
              background: 'var(--color-bg-subtle)',
              color: 'var(--color-text)',
              border: '1px solid var(--color-border)',
              transition: 'border-color 0.2s, box-shadow 0.2s',
            }}
          />
        </div>
      </div>

      {/* Tone style */}
      <div className="mb-8 sw-stagger-3">
        <div className="text-[13px] font-semibold mb-4" style={{ color: 'var(--color-text-muted)' }}>
          {lang === 'zh' ? '回复语气' : 'Response Tone'}
        </div>
        <div className="grid grid-cols-4 gap-3.5">
          {TONE_STYLES.map((t) => (
            <button
              key={t.id}
              onClick={() => onToneStyleChange(t.id)}
              className="p-4 rounded-2xl border-2 text-center transition-all"
              style={{
                background: toneStyle === t.id ? 'var(--color-primary)' : 'var(--color-bg-elevated)',
                borderColor: toneStyle === t.id ? 'var(--color-primary)' : 'var(--color-border)',
                boxShadow: toneStyle === t.id ? '0 2px 12px rgba(var(--color-primary-rgb), 0.25)' : 'none',
              }}
            >
              <div className="text-2xl mb-2">{t.emoji}</div>
              <div className="text-[12px] font-semibold" style={{ color: toneStyle === t.id ? '#fff' : 'var(--color-text)' }}>
                {t.name[lang]}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Role preset */}
      <div className="mb-8 sw-stagger-4">
        <div className="text-[13px] font-semibold mb-4" style={{ color: 'var(--color-text-muted)' }}>
          {lang === 'zh' ? '角色定位' : 'Role'}
        </div>
        <div className="grid grid-cols-4 gap-3.5">
          {ROLE_PRESETS.map((r) => (
            <button
              key={r.id}
              onClick={() => onSelectedRoleChange(r.id)}
              className="p-4 rounded-2xl border-2 text-center transition-all"
              style={{
                background: selectedRole === r.id ? 'var(--color-primary)' : 'var(--color-bg-elevated)',
                borderColor: selectedRole === r.id ? 'var(--color-primary)' : 'var(--color-border)',
                boxShadow: selectedRole === r.id ? '0 2px 12px rgba(var(--color-primary-rgb), 0.25)' : 'none',
              }}
            >
              <div className="text-2xl mb-2">{r.emoji}</div>
              <div className="text-[12px] font-semibold" style={{ color: selectedRole === r.id ? '#fff' : 'var(--color-text)' }}>
                {r.name[lang]}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Custom role description */}
      {selectedRole === 'custom' && (
        <div className="p-4 rounded-xl border mb-6" style={{ background: 'var(--color-bg-elevated)', borderColor: 'var(--color-border)' }}>
          <label className="text-[12px] font-medium block mb-2" style={{ color: 'var(--color-text-muted)' }}>
            {lang === 'zh' ? '自定义角色描述' : 'Custom Role Description'}
          </label>
          <textarea
            value={customSoul}
            onChange={(e) => onCustomSoulChange(e.target.value)}
            rows={3}
            placeholder={
              lang === 'zh'
                ? '例如：你是一个专业的数据分析师，擅长用简洁的方式解释复杂的数据...'
                : 'e.g.: You are a professional data analyst who excels at explaining complex data simply...'
            }
            className="w-full px-3 py-2.5 rounded-lg text-[13px] outline-none resize-none"
            style={{
              background: 'var(--color-bg-subtle)',
              color: 'var(--color-text)',
              border: '1px solid var(--color-border)',
            }}
          />
        </div>
      )}

      {/* Preview */}
      {(selectedRole !== 'custom' || customSoul.trim()) && (
        <div className="p-4 rounded-xl" style={{ background: 'var(--color-bg-subtle)' }}>
          <div className="text-[11px] font-medium mb-2" style={{ color: 'var(--color-text-muted)' }}>
            {lang === 'zh' ? '预览 SOUL.md' : 'Preview SOUL.md'}
          </div>
          <div className="text-[12px] leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--color-text-secondary)' }}>
            {buildSoulContent(aiName, ownerName, toneStyle, selectedRole, customSoul, lang)}
          </div>
        </div>
      )}
    </div>
  );
}
