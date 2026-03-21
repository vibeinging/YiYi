import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ProviderDisplay } from '../../api/models';

interface ActiveModelCardProps {
  activeLlm: { provider_id: string; model: string };
  providers: ProviderDisplay[];
  expandedProvider: string | null;
  setExpandedProvider: (id: string | null) => void;
}

export function ActiveModelCard({ activeLlm, providers, expandedProvider, setExpandedProvider }: ActiveModelCardProps) {
  const { t } = useTranslation();

  return (
    <div
      className="mb-8 p-5 rounded-2xl cursor-pointer transition-all hover:ring-2 hover:ring-[var(--color-primary)] hover:ring-opacity-30"
      style={{ background: 'var(--color-bg-elevated)' }}
      onClick={() => setExpandedProvider(expandedProvider === activeLlm.provider_id ? null : activeLlm.provider_id)}
    >
      <p className="text-[11px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--color-text-tertiary)' }}>
        {t('models.currentModel')}
      </p>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-[15px] font-semibold" style={{ color: 'var(--color-text)' }}>{activeLlm.model}</span>
          <span
            className="text-[12px] px-2.5 py-1 rounded-lg font-medium"
            style={{ background: 'var(--color-primary-subtle)', color: 'var(--color-primary)' }}
          >
            {providers.find(p => p.id === activeLlm.provider_id)?.name || activeLlm.provider_id}
          </span>
        </div>
        <ChevronDown size={16} style={{ color: 'var(--color-text-muted)' }} />
      </div>
    </div>
  );
}
