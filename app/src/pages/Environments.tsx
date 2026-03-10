/**
 * Environments Configuration Page
 * Swiss Minimalism · Clean · Precise
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Plus,
  Trash2,
  Save,
  Key,
  RefreshCw,
  Eye,
  EyeOff,
  Info,
} from 'lucide-react';
import { listEnvs, saveEnvs, deleteEnv, type EnvVar } from '../api/env';
import { PageHeader } from '../components/PageHeader';
import { toast, confirm } from '../components/Toast';

export function EnvironmentsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useTranslation();
  const [envs, setEnvs] = useState<EnvVar[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingKey, setEditingKey] = useState<number | null>(null);
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set());

  // Load data
  const loadEnvs = async () => {
    setLoading(true);
    try {
      const data = await listEnvs();
      setEnvs(data);
    } catch (error) {
      console.error('Failed to load envs:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadEnvs();
  }, []);

  // Add new row
  const handleAdd = () => {
    setEnvs([...envs, { key: '', value: '', description: '' }]);
    setEditingKey(envs.length);
  };

  // Delete row
  const handleDelete = async (index: number) => {
    const env = envs[index];
    if (!env.key) {
      setEnvs(envs.filter((_, i) => i !== index));
      return;
    }
    if (!(await confirm(`${t('common.delete')} ${env.key}?`))) return;

    try {
      await deleteEnv(env.key);
      await loadEnvs();
    } catch (error) {
      console.error('Failed to delete env:', error);
      toast.error(`${t('common.delete')}: ${String(error)}`);
    }
  };

  // Save all
  const handleSave = async () => {
    const validEnvs = envs.filter(e => e.key.trim());
    if (validEnvs.length === 0) {
      toast.info(t('environments.noEnvs') + ' - ' + t('environments.clickToAdd'));
      return;
    }

    // Check for duplicate keys
    const keys = validEnvs.map(e => e.key.trim());
    const uniqueKeys = new Set(keys);
    if (keys.length !== uniqueKeys.size) {
      toast.error('存在重复的环境变量名');
      return;
    }

    setSaving(true);
    try {
      await saveEnvs(validEnvs.map(e => ({
        ...e,
        key: e.key.trim(),
      })));
      await loadEnvs();
      setEditingKey(null);
    } catch (error) {
      console.error('Failed to save envs:', error);
      toast.error(`${t('environments.save')}: ${String(error)}`);
    } finally {
      setSaving(false);
    }
  };

  // Update row
  const handleUpdate = (index: number, field: keyof EnvVar, value: string) => {
    const newEnvs = [...envs];
    newEnvs[index] = { ...newEnvs[index], [field]: value };
    setEnvs(newEnvs);
  };

  // Toggle secret visibility
  const toggleVisibility = (key: string) => {
    const newVisible = new Set(visibleKeys);
    if (newVisible.has(key)) {
      newVisible.delete(key);
    } else {
      newVisible.add(key);
    }
    setVisibleKeys(newVisible);
  };

  // Detect secret keys (simple heuristic)
  const isSecretKey = (key: string): boolean => {
    const lowerKey = key.toLowerCase();
    return lowerKey.includes('key') ||
           lowerKey.includes('secret') ||
           lowerKey.includes('token') ||
           lowerKey.includes('password') ||
           lowerKey.includes('api');
  };

  // Mask display value
  const maskValue = (key: string, value: string): string => {
    if (!isSecretKey(key)) return value;
    return '*'.repeat(Math.min(value.length, 20));
  };

  const content = (
    <>
      {!embedded && (
        <PageHeader
          title={t('environments.title')}
          description={t('environments.description')}
          actions={<>
            <button onClick={loadEnvs} disabled={loading} className="w-9 h-9 flex items-center justify-center rounded-xl transition-colors disabled:opacity-50" style={{ color: 'var(--color-text-secondary)' }} onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-elevated)'; }} onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }} title={t('common.refresh')}>
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            </button>
            <button onClick={handleAdd} className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-[13px] font-medium transition-colors" style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-text)' }} onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }} onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-bg-elevated)'; }}>
              <Plus size={15} />
              {t('environments.add')}
            </button>
            <button onClick={handleSave} disabled={saving} className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-[13px] font-medium disabled:opacity-50 transition-colors" style={{ background: 'var(--color-primary)', color: '#FFFFFF' }}>
              {saving ? <RefreshCw size={15} className="animate-spin" /> : <Save size={15} />}
              {t('environments.save')}
            </button>
          </>}
        />
      )}
      {embedded && (
        <div className="flex items-center justify-end gap-2 mb-6">
          <button onClick={loadEnvs} disabled={loading} className="w-9 h-9 flex items-center justify-center rounded-xl transition-colors disabled:opacity-50" style={{ color: 'var(--color-text-secondary)' }} onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-elevated)'; }} onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }} title={t('common.refresh')}>
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
          <button onClick={handleAdd} className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-[13px] font-medium transition-colors" style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-text)' }} onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }} onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-bg-elevated)'; }}>
            <Plus size={15} />
            {t('environments.add')}
          </button>
          <button onClick={handleSave} disabled={saving} className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-[13px] font-medium disabled:opacity-50 transition-colors" style={{ background: 'var(--color-primary)', color: '#FFFFFF' }}>
            {saving ? <RefreshCw size={15} className="animate-spin" /> : <Save size={15} />}
            {t('environments.save')}
          </button>
        </div>
      )}

        {/* Environment variables table */}
        <div className="border border-[var(--color-border)] rounded-2xl overflow-hidden bg-[var(--color-bg-elevated)] shadow-sm">
          {/* Table header */}
          <div className="grid grid-cols-12 gap-4 px-5 py-3 bg-[var(--color-bg-muted)] border-b border-[var(--color-border)] text-[13px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wide">
            <div className="col-span-3">{t('environments.key')}</div>
            <div className="col-span-5">{t('environments.value')}</div>
            <div className="col-span-3">{t('environments.descLabel')}</div>
            <div className="col-span-1">{t('environments.actions')}</div>
          </div>

          {/* Table body */}
          {envs.length === 0 && !loading ? (
            <div className="px-5 py-16 text-center text-[var(--color-text-muted)]">
              <Key size={48} className="mx-auto mb-3 opacity-30" />
              <p className="font-medium">{t('environments.noEnvs')}</p>
              <button
                onClick={handleAdd}
                className="mt-3 text-[var(--color-primary)] hover:underline text-[13px] font-medium"
              >
                {t('environments.clickToAdd')}
              </button>
            </div>
          ) : (
            <div>
              {envs.map((env, index) => {
                const isVisible = visibleKeys.has(env.key);
                const displayValue = isVisible ? env.value : maskValue(env.key, env.value);
                const isSecret = isSecretKey(env.key);

                return (
                  <div
                    key={index}
                    className={`grid grid-cols-12 gap-4 px-5 py-4 border-b border-[var(--color-border)] items-center ${
                      editingKey === index ? 'bg-[var(--color-primary)]/5' : ''
                    }`}
                  >
                    {/* Key */}
                    <div className="col-span-3">
                      <input
                        type="text"
                        value={env.key}
                        onChange={(e) => handleUpdate(index, 'key', e.target.value)}
                        onFocus={() => setEditingKey(index)}
                        onBlur={() => setEditingKey(null)}
                        placeholder={t('environments.key')}
                        className="w-full px-3 py-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] focus:outline-none focus:ring-4 focus:ring-[var(--color-primary-subtle)] text-[13px] font-mono transition-shadow"
                      />
                    </div>

                    {/* Value */}
                    <div className="col-span-5 flex items-center gap-2">
                      <div className="flex-1 relative">
                        <input
                          type={isVisible ? 'text' : 'password'}
                          value={env.value}
                          onChange={(e) => handleUpdate(index, 'value', e.target.value)}
                          onFocus={() => setEditingKey(index)}
                          onBlur={() => setEditingKey(null)}
                          placeholder={t('environments.value')}
                          className="w-full px-3 py-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] focus:outline-none focus:ring-4 focus:ring-[var(--color-primary-subtle)] text-[13px] font-mono pr-10 transition-shadow"
                        />
                        {isSecret && env.value && (
                          <button
                            type="button"
                            onClick={() => toggleVisibility(env.key)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                          >
                            {isVisible ? <EyeOff size={16} /> : <Eye size={16} />}
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Description */}
                    <div className="col-span-3">
                      <input
                        type="text"
                        value={env.description || ''}
                        onChange={(e) => handleUpdate(index, 'description', e.target.value)}
                        onFocus={() => setEditingKey(index)}
                        onBlur={() => setEditingKey(null)}
                        placeholder={t('environments.descriptionPlaceholder')}
                        className="w-full px-3 py-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] focus:outline-none focus:ring-4 focus:ring-[var(--color-primary-subtle)] text-[13px] transition-shadow"
                      />
                    </div>

                    {/* Actions */}
                    <div className="col-span-1 flex justify-center">
                      <button
                        onClick={() => handleDelete(index)}
                        className="p-2 hover:bg-[var(--color-error)]/10 text-[var(--color-error)] rounded-xl transition-colors"
                        title={t('common.delete')}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Info section */}
        <div className="mt-6 flex items-start gap-3 p-4 rounded-xl bg-[var(--color-info)]/10 border border-[var(--color-info)]/20 shadow-sm">
          <Info size={18} className="mt-0.5 flex-shrink-0 text-[var(--color-info)]" />
          <div className="text-[13px] text-[var(--color-text-secondary)]">
            <p className="font-medium mb-1 text-[var(--color-info)]">{t('environments.tips')}</p>
            <ul className="text-xs space-y-1 opacity-80">
              <li>• {t('environments.tipsContent')}</li>
              <li>• Variables containing "key", "secret", "token", or "password" are automatically masked</li>
              <li>• Click {t('environments.save')} to persist changes</li>
            </ul>
          </div>
        </div>
    </>
  );

  if (embedded) return content;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 py-8">
        {content}
      </div>
    </div>
  );
}
