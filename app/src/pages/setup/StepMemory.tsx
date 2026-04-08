/**
 * Setup Wizard - Memory engine (Embedding) configuration step
 */

import React from 'react';
import { Database, Zap, Globe, Key, Hash, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import type { Lang } from './setupWizardData';
import type { MemmeConfig } from '../../api/system';

export interface StepMemoryProps {
  lang: Lang;
  config: MemmeConfig;
  onChange: (config: MemmeConfig) => void;
  llmProviderName?: string;
}

type EmbeddingMode = 'auto' | 'custom' | 'mock';

const PRESETS: { id: EmbeddingMode; name: { zh: string; en: string }; desc: { zh: string; en: string }; icon: typeof Zap; color: string }[] = [
  {
    id: 'auto',
    name: { zh: '自动（使用 LLM Provider 的 Key）', en: 'Auto (use LLM provider key)' },
    desc: { zh: '无需额外配置，直接使用你配好的 AI 服务商', en: 'No extra config — uses your existing AI provider' },
    icon: Zap,
    color: '#22c55e',
  },
  {
    id: 'custom',
    name: { zh: '自定义 Embedding 服务', en: 'Custom Embedding Service' },
    desc: { zh: 'Ollama 本地模型 / 硅基流动 / 智谱 / 其他 OpenAI 兼容服务', en: 'Ollama local / SiliconFlow / Zhipu / any OpenAI-compatible' },
    icon: Globe,
    color: '#6366f1',
  },
  {
    id: 'mock',
    name: { zh: '暂不开启（无语义搜索）', en: 'Skip (no semantic search)' },
    desc: { zh: '记忆功能仍可用，但没有向量语义搜索能力', en: 'Memory still works, but without vector semantic search' },
    icon: Database,
    color: '#94a3b8',
  },
];

export function StepMemory({ lang, config, onChange, llmProviderName }: StepMemoryProps) {
  // Derive mode from config on every render to stay in sync
  const mode: EmbeddingMode =
    config.embedding_provider === 'mock' ? 'mock' :
    config.embedding_base_url ? 'custom' : 'auto';

  const handleModeChange = (newMode: EmbeddingMode) => {
    if (newMode === 'mock') {
      onChange({ ...config, embedding_provider: 'mock', embedding_base_url: '', embedding_api_key: '' });
    } else if (newMode === 'auto') {
      onChange({ ...config, embedding_provider: 'openai', embedding_base_url: '', embedding_api_key: '', embedding_model: 'text-embedding-3-small', embedding_dims: 1536 });
    } else {
      onChange({ ...config, embedding_provider: 'openai' });
    }
  };

  return (
    <div className="pt-10">
      <div className="text-center mb-10">
        <div className="w-20 h-20 rounded-3xl bg-[var(--color-primary-subtle)] flex items-center justify-center mx-auto mb-8">
          <Database size={36} className="text-[var(--color-primary)]" />
        </div>
        <h1 className="text-4xl font-extrabold mb-4 tracking-tight" style={{ color: 'var(--color-text)' }}>
          {lang === 'zh' ? '记忆引擎' : 'Memory Engine'}
        </h1>
        <p className="text-[16px]" style={{ color: 'var(--color-text-secondary)' }}>
          {lang === 'zh'
            ? 'YiYi 通过向量记忆来记住你的偏好、习惯和对话历史'
            : 'YiYi uses vector memory to remember your preferences, habits, and conversations'}
        </p>
      </div>

      {/* Mode selection */}
      <div className="grid gap-3 mb-8">
        {PRESETS.map((preset, i) => {
          const Icon = preset.icon;
          const selected = mode === preset.id;
          return (
            <button
              key={preset.id}
              onClick={() => handleModeChange(preset.id)}
              className={`sw-stagger-${i + 1} flex items-start gap-4 p-4 rounded-xl text-left transition-all`}
              style={{
                background: selected ? `${preset.color}10` : 'var(--color-bg-muted)',
                border: `2px solid ${selected ? preset.color : 'transparent'}`,
                cursor: 'pointer',
              }}
            >
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                style={{ background: `${preset.color}20` }}
              >
                <Icon size={20} style={{ color: preset.color }} />
              </div>
              <div>
                <div className="text-[14px] font-semibold" style={{ color: 'var(--color-text)' }}>
                  {preset.name[lang]}
                </div>
                <div className="text-[12px] mt-1" style={{ color: 'var(--color-text-secondary)' }}>
                  {preset.desc[lang]}
                  {preset.id === 'auto' && llmProviderName && (
                    <span style={{ color: 'var(--color-primary)' }}> ({llmProviderName})</span>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Custom configuration */}
      {mode === 'custom' && (
        <div className="space-y-4 sw-stagger-4" style={{ padding: '0 4px' }}>
          <div className="text-[13px] font-semibold mb-2" style={{ color: 'var(--color-text-secondary)' }}>
            {lang === 'zh' ? '自定义配置' : 'Custom Configuration'}
          </div>

          {/* Base URL */}
          <div className="flex items-center gap-3">
            <Globe size={16} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
            <input
              type="text"
              placeholder={lang === 'zh' ? 'API 地址，如 http://localhost:11434/v1' : 'API URL, e.g. http://localhost:11434/v1'}
              value={config.embedding_base_url}
              onChange={(e) => onChange({ ...config, embedding_base_url: e.target.value })}
              className="flex-1 text-[13px] px-3 py-2.5 rounded-lg"
              style={{ background: 'var(--color-bg-muted)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
            />
          </div>

          {/* API Key */}
          <div className="flex items-center gap-3">
            <Key size={16} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
            <input
              type="password"
              placeholder={lang === 'zh' ? 'API Key（本地服务可留空）' : 'API Key (leave empty for local)'}
              value={config.embedding_api_key}
              onChange={(e) => onChange({ ...config, embedding_api_key: e.target.value })}
              className="flex-1 text-[13px] px-3 py-2.5 rounded-lg"
              style={{ background: 'var(--color-bg-muted)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
            />
          </div>

          {/* Model */}
          <div className="flex items-center gap-3">
            <Database size={16} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
            <input
              type="text"
              placeholder={lang === 'zh' ? '模型名，如 nomic-embed-text' : 'Model name, e.g. nomic-embed-text'}
              value={config.embedding_model}
              onChange={(e) => onChange({ ...config, embedding_model: e.target.value })}
              className="flex-1 text-[13px] px-3 py-2.5 rounded-lg"
              style={{ background: 'var(--color-bg-muted)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
            />
          </div>

          {/* Dimensions */}
          <div className="flex items-center gap-3">
            <Hash size={16} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
            <input
              type="number"
              placeholder="1536"
              value={config.embedding_dims}
              onChange={(e) => onChange({ ...config, embedding_dims: parseInt(e.target.value) || 1536 })}
              className="w-[120px] text-[13px] px-3 py-2.5 rounded-lg"
              style={{ background: 'var(--color-bg-muted)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
            />
            <span className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
              {lang === 'zh' ? '向量维度' : 'Dimensions'}
            </span>
          </div>
        </div>
      )}

      {/* Info box */}
      {mode === 'auto' && (
        <div
          className="sw-stagger-4 flex items-start gap-3 p-4 rounded-xl"
          style={{ background: 'rgba(34, 197, 94, 0.06)', border: '1px solid rgba(34, 197, 94, 0.2)' }}
        >
          <CheckCircle2 size={18} style={{ color: '#22c55e', flexShrink: 0, marginTop: 1 }} />
          <div className="text-[13px]" style={{ color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
            {lang === 'zh'
              ? '将使用你已配置的 AI 服务商的 API Key 来生成向量。如果你使用的是 OpenAI 兼容服务（如硅基流动、智谱），Embedding 会自动使用相同的 Key 和地址。'
              : 'Will use your configured AI provider\'s API key for embeddings. If using an OpenAI-compatible service, embedding will automatically use the same key and URL.'}
          </div>
        </div>
      )}

      {mode === 'mock' && (
        <div
          className="sw-stagger-4 flex items-start gap-3 p-4 rounded-xl"
          style={{ background: 'var(--color-bg-muted)', border: '1px solid var(--color-border)' }}
        >
          <XCircle size={18} style={{ color: 'var(--color-text-muted)', flexShrink: 0, marginTop: 1 }} />
          <div className="text-[13px]" style={{ color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
            {lang === 'zh'
              ? 'YiYi 仍会记录对话和记忆，但无法通过语义搜索检索相关记忆。你可以稍后在设置中开启。'
              : 'YiYi will still record conversations and memories, but cannot retrieve them via semantic search. You can enable this later in Settings.'}
          </div>
        </div>
      )}
    </div>
  );
}
