import { Database, CheckCircle2, Download, Globe2, Shield } from 'lucide-react';
import type { Lang } from './setupWizardData';

export function StepMemory({ lang }: { lang: Lang }) {
  const features: { icon: typeof Shield; color: string; title: { zh: string; en: string }; desc: { zh: string; en: string } }[] = [
    {
      icon: Shield,
      color: '#22c55e',
      title: { zh: '完全本地', en: 'Fully Local' },
      desc: { zh: '记忆向量化在你的电脑上完成，不上传任何内容', en: 'Embeddings run on your device. Nothing leaves it.' },
    },
    {
      icon: Globe2,
      color: '#6366f1',
      title: { zh: '中文友好', en: 'Chinese-Optimized' },
      desc: { zh: 'BAAI 发布的中文 BGE 模型，对中文语义理解更好', en: 'BAAI\'s Chinese BGE model, tuned for Chinese semantics.' },
    },
    {
      icon: Download,
      color: '#f59e0b',
      title: { zh: '首次下载约 100MB', en: 'First Download ≈ 100MB' },
      desc: { zh: '首次启动自动下载到 ~/.yiyi/models/，之后完全离线', en: 'Auto-downloads to ~/.yiyi/models/ on first launch, then runs offline.' },
    },
  ];

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

      {/* Model card */}
      <div
        className="sw-stagger-1 p-5 rounded-2xl mb-6"
        style={{ background: 'var(--color-bg-muted)', border: '1px solid var(--color-border)' }}
      >
        <div className="flex items-center gap-3 mb-2">
          <CheckCircle2 size={18} style={{ color: '#22c55e' }} />
          <div className="text-[14px] font-semibold" style={{ color: 'var(--color-text)' }}>
            {lang === 'zh' ? '已内置：bge-small-zh-v1.5' : 'Built-in: bge-small-zh-v1.5'}
          </div>
        </div>
        <div className="text-[12px] font-mono ml-[30px]" style={{ color: 'var(--color-text-muted)' }}>
          BAAI · 512 dims · ONNX · Apache-2.0
        </div>
      </div>

      {/* Feature list */}
      <div className="grid gap-3">
        {features.map((f, i) => {
          const Icon = f.icon;
          return (
            <div
              key={f.title.en}
              className={`sw-stagger-${i + 2} flex items-start gap-4 p-4 rounded-xl`}
              style={{ background: 'var(--color-bg-muted)', border: '1px solid var(--color-border)' }}
            >
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                style={{ background: `${f.color}20` }}
              >
                <Icon size={20} style={{ color: f.color }} />
              </div>
              <div>
                <div className="text-[14px] font-semibold" style={{ color: 'var(--color-text)' }}>
                  {f.title[lang]}
                </div>
                <div className="text-[12px] mt-1" style={{ color: 'var(--color-text-secondary)' }}>
                  {f.desc[lang]}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
