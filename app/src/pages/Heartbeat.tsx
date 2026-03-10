/**
 * Heartbeat Monitor Page
 * Apple-inspired Design
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Heart,
  Play,
  RefreshCw,
  Save,
  Clock,
  CheckCircle,
  XCircle,
  Info,
  Loader2,
} from 'lucide-react';
import { Select } from '../components/Select';
import {
  getHeartbeatConfig,
  saveHeartbeatConfig,
  sendHeartbeat,
  getHeartbeatHistory,
  type HeartbeatConfig,
  type ActiveHours,
  type HeartbeatHistoryItem,
} from '../api/heartbeat';
import { PageHeader } from '../components/PageHeader';
import { toast } from '../components/Toast';

export function HeartbeatPage() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<HeartbeatConfig>({
    enabled: false,
    every: '6h',
    target: 'last',
  });
  const [history, setHistory] = useState<HeartbeatHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);

  // Load config
  const loadConfig = async () => {
    setLoading(true);
    try {
      const data = await getHeartbeatConfig();
      setConfig(data);
      await loadHistory();
    } catch (error) {
      console.error('Failed to load heartbeat config:', error);
    } finally {
      setLoading(false);
    }
  };

  // Load history
  const loadHistory = async () => {
    try {
      const data = await getHeartbeatHistory(10);
      setHistory(data);
    } catch (error) {
      console.error('Failed to load heartbeat history:', error);
    }
  };

  useEffect(() => {
    loadConfig();
  }, []);

  // Save config
  const handleSave = async () => {
    setSaving(true);
    try {
      await saveHeartbeatConfig(config);
      await loadConfig();
    } catch (error) {
      console.error('Failed to save heartbeat config:', error);
      toast.error(`保存失败: ${String(error)}`);
    } finally {
      setSaving(false);
    }
  };

  // Send heartbeat now
  const handleSend = async () => {
    setSending(true);
    try {
      const result = await sendHeartbeat();
      toast.success(result.message);
      await loadHistory();
    } catch (error) {
      console.error('Failed to send heartbeat:', error);
      toast.error(`发送失败: ${String(error)}`);
    } finally {
      setSending(false);
    }
  };

  // Parse interval
  const parseInterval = (every: string) => {
    const match = every.match(/^(\d+)([mh])$/);
    if (match) {
      const value = parseInt(match[1]);
      const unit = match[2];
      return { value, unit };
    }
    return { value: 6, unit: 'h' };
  };

  // Format interval
  const formatInterval = (value: number, unit: string) => {
    const unitLabel = unit === 'm' ? t('heartbeat.minutes') : t('heartbeat.hours');
    return `${t('heartbeat.every')} ${value} ${unitLabel}`;
  };

  const { value: intervalValue, unit: intervalUnit } = parseInterval(config.every);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 py-8">
        <PageHeader
          title={t('heartbeat.title')}
          description={t('heartbeat.description')}
          actions={<>
            <button onClick={loadConfig} disabled={loading} className="w-9 h-9 flex items-center justify-center rounded-xl transition-colors disabled:opacity-50" style={{ color: 'var(--color-text-secondary)' }} onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-elevated)'; }} onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }} title={t('common.refresh')}>
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            </button>
            <button onClick={handleSend} disabled={sending || !config.enabled} className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-[13px] font-medium disabled:opacity-50 transition-colors" style={{ background: 'var(--color-success)', color: '#FFFFFF' }}>
              {sending ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
              {t('heartbeat.sendNow')}
            </button>
          </>}
        />

        {/* Status bar */}
        <div className="flex items-center gap-3 mb-8 p-4 rounded-xl shadow-sm" style={{ background: 'var(--color-bg-elevated)' }}>
          <div className={`w-2 h-2 rounded-full ${config.enabled ? 'bg-[var(--color-success)]' : 'bg-[var(--color-text-muted)]'}`} />
          <span className="text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>
            {config.enabled ? formatInterval(intervalValue, intervalUnit) : t('heartbeat.disabled')}
          </span>
          {config.activeHours && (
            <>
              <span className="text-[13px]" style={{ color: 'var(--color-text-muted)' }}>•</span>
              <span className="text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>
                {config.activeHours.start} – {config.activeHours.end}
              </span>
            </>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* Config card */}
          <div className="p-5 rounded-2xl shadow-sm" style={{ background: 'var(--color-bg-elevated)' }}>
            <h2 className="font-semibold text-[14px] flex items-center gap-2 mb-5" style={{ color: 'var(--color-text)' }}>
              <Clock size={16} style={{ color: 'var(--color-text-secondary)' }} />
              {t('heartbeat.configuration')}
            </h2>

            <div className="space-y-5">
              {/* Enable toggle */}
              <div className="flex items-center justify-between">
                <div>
                  <label className="font-medium text-[13px]" style={{ color: 'var(--color-text)' }}>{t('heartbeat.enableMonitoring')}</label>
                  <p className="text-[12px] mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
                    {t('heartbeat.enableDesc')}
                  </p>
                </div>
                <button
                  onClick={() => setConfig({ ...config, enabled: !config.enabled })}
                  className="relative w-11 h-6 rounded-full transition-colors"
                  style={{ background: config.enabled ? 'var(--color-primary)' : 'var(--color-bg-muted)' }}
                >
                  <span
                    className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full transition-transform ${
                      config.enabled ? 'translate-x-5' : ''
                    }`}
                  />
                </button>
              </div>

              {/* Send interval */}
              <div>
                <label className="block text-[13px] font-medium mb-2" style={{ color: 'var(--color-text)' }}>{t('heartbeat.sendInterval')}</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="1"
                    max="720"
                    value={intervalValue}
                    onChange={(e) => setConfig({
                      ...config,
                      every: `${e.target.value}${intervalUnit}`,
                    })}
                    disabled={!config.enabled}
                    className="w-16 px-2.5 py-2 rounded-xl text-center disabled:opacity-50 text-[13px] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50"
                    style={{ background: 'var(--color-bg)', color: 'var(--color-text)', border: 'none' }}
                  />
                  <Select
                    value={intervalUnit}
                    onChange={(v) => setConfig({
                      ...config,
                      every: `${intervalValue}${v}`,
                    })}
                    disabled={!config.enabled}
                    options={[
                      { value: 'm', label: t('heartbeat.minutes') },
                      { value: 'h', label: t('heartbeat.hours') },
                    ]}
                  />
                </div>
              </div>

              {/* Target selection */}
              <div>
                <label className="block text-[13px] font-medium mb-2" style={{ color: 'var(--color-text)' }}>{t('heartbeat.targetSession')}</label>
                <div className="grid grid-cols-2 gap-2">
                  {(['main', 'last'] as const).map((target) => (
                    <button
                      key={target}
                      onClick={() => setConfig({ ...config, target })}
                      className="p-2.5 rounded-xl text-[13px] font-medium transition-all"
                      style={{
                        background: config.target === target ? 'var(--color-primary)' : 'var(--color-bg-subtle)',
                        color: config.target === target ? '#FFFFFF' : 'var(--color-text-secondary)',
                        opacity: !config.enabled ? 0.5 : 1,
                      }}
                      disabled={!config.enabled}
                    >
                      {target === 'main' ? t('heartbeat.mainChannel') : t('heartbeat.lastActive')}
                    </button>
                  ))}
                </div>
                <p className="text-[12px] mt-1.5" style={{ color: 'var(--color-text-muted)' }}>
                  {config.target === 'main' ? t('heartbeat.mainChannelDesc') : t('heartbeat.lastActiveDesc')}
                </p>
              </div>

              {/* Active hours */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-[13px] font-medium" style={{ color: 'var(--color-text)' }}>{t('heartbeat.activeHours')}</label>
                  <button
                    onClick={() => {
                      if (config.activeHours) {
                        setConfig({ ...config, activeHours: undefined });
                      } else {
                        setConfig({
                          ...config,
                          activeHours: { start: '08:00', end: '22:00' },
                        });
                      }
                    }}
                    className="text-[13px] px-3 py-1 rounded-xl font-medium transition-colors"
                    style={{
                      background: config.activeHours ? 'var(--color-primary)' : 'var(--color-bg-subtle)',
                      color: config.activeHours ? '#FFFFFF' : 'var(--color-text-secondary)',
                      opacity: !config.enabled ? 0.5 : 1,
                    }}
                    disabled={!config.enabled}
                  >
                    {config.activeHours ? t('heartbeat.enabled') : t('heartbeat.disabled')}
                  </button>
                </div>
                {config.activeHours && (
                  <div className="flex items-center gap-2 mt-2">
                    <input
                      type="time"
                      value={config.activeHours.start}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          activeHours: { ...config.activeHours!, start: e.target.value },
                        })
                      }
                      disabled={!config.enabled}
                      className="px-2.5 py-2 rounded-xl disabled:opacity-50 text-[13px] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50"
                      style={{ background: 'var(--color-bg)', color: 'var(--color-text)', border: 'none' }}
                    />
                    <span className="text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>{t('heartbeat.to')}</span>
                    <input
                      type="time"
                      value={config.activeHours.end}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          activeHours: { ...config.activeHours!, end: e.target.value },
                        })
                      }
                      disabled={!config.enabled}
                      className="px-2.5 py-2 rounded-xl disabled:opacity-50 text-[13px] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50"
                      style={{ background: 'var(--color-bg)', color: 'var(--color-text)', border: 'none' }}
                    />
                  </div>
                )}
                <p className="text-[12px] mt-1.5" style={{ color: 'var(--color-text-muted)' }}>
                  {t('heartbeat.activeHoursDesc')}
                </p>
              </div>

              {/* Save button */}
              <div className="pt-4">
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl font-medium transition-colors disabled:opacity-50 text-[13px]"
                  style={{ background: 'var(--color-primary)', color: '#FFFFFF' }}
                >
                  {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                  {t('heartbeat.saveConfig')}
                </button>
              </div>
            </div>
          </div>

          {/* History card */}
          <div className="p-5 rounded-2xl shadow-sm" style={{ background: 'var(--color-bg-elevated)' }}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold text-[14px]" style={{ color: 'var(--color-text)' }}>{t('heartbeat.sendHistory')}</h2>
              <button
                onClick={loadHistory}
                className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors"
                style={{ color: 'var(--color-text-secondary)' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                title={t('common.refresh')}
              >
                <RefreshCw size={14} />
              </button>
            </div>

            {history.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16" style={{ color: 'var(--color-text-muted)' }}>
                <Clock size={36} className="mb-3 opacity-20" />
                <p className="text-[13px]">{t('heartbeat.noHistory')}</p>
              </div>
            ) : (
              <div className="space-y-2">
                {history.map((item, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between p-3 rounded-xl transition-colors"
                    style={{ background: 'var(--color-bg-subtle)' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
                  >
                    <div className="flex items-center gap-3">
                      {item.success ? (
                        <CheckCircle size={16} style={{ color: 'var(--color-success)' }} />
                      ) : (
                        <XCircle size={16} style={{ color: 'var(--color-error)' }} />
                      )}
                      <div>
                        <div className="text-[13px] font-medium" style={{ color: 'var(--color-text)' }}>
                          {item.target === 'main' ? t('heartbeat.main') : t('heartbeat.last')}
                        </div>
                        <div className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
                          {new Date(item.timestamp).toLocaleString()}
                        </div>
                      </div>
                    </div>
                    {item.message && (
                      <div className="text-[12px] max-w-[150px] truncate" style={{ color: 'var(--color-text-muted)' }}>
                        {item.message}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Info section */}
        <div className="mt-5 p-5 rounded-2xl shadow-sm" style={{ background: 'var(--color-bg-elevated)' }}>
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'var(--color-bg-subtle)' }}>
              <Info size={15} style={{ color: 'var(--color-text-secondary)' }} />
            </div>
            <div>
              <p className="font-medium text-[13px] mb-2" style={{ color: 'var(--color-text)' }}>{t('heartbeat.tips')}</p>
              <ul className="text-[12px] space-y-1" style={{ color: 'var(--color-text-secondary)' }}>
                <li className="flex items-start gap-2"><span style={{ color: 'var(--color-text-muted)' }}>•</span> {t('heartbeat.tip1')}</li>
                <li className="flex items-start gap-2"><span style={{ color: 'var(--color-text-muted)' }}>•</span> {t('heartbeat.tip2')}</li>
                <li className="flex items-start gap-2"><span style={{ color: 'var(--color-text-muted)' }}>•</span> {t('heartbeat.tip3')}</li>
                <li className="flex items-start gap-2"><span style={{ color: 'var(--color-text-muted)' }}>•</span> {t('heartbeat.tip4')}</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
