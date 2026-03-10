/**
 * Channels Management Page
 * Per-channel config, doc links, enable/disable toggle
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { open } from '@tauri-apps/plugin-shell';
import {
  Hash,
  Send,
  RefreshCw,
  X,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Save,
  Users,
} from 'lucide-react';
import { Select } from '../components/Select';
import {
  listChannels,
  updateChannel,
  sendToChannel,
  type ChannelInfo,
  type ChannelType,
} from '../api/channels';
import { listEnvs, saveEnvs, type EnvVar } from '../api/env';
import { PageHeader } from '../components/PageHeader';
import { SessionsPanel } from './Sessions';

type ChannelsTab = 'channels' | 'sessions';

/* ─── Channel metadata ─── */
interface ChannelMeta {
  icon: string;
  color: string;
  docUrl: string;
  docLabel: string;
  envKeys: { key: string; label: string; placeholder: string; secret?: boolean }[];
}

const CHANNEL_META: Record<string, ChannelMeta> = {
  dingtalk: {
    icon: '🔔',
    color: '#0A6CFF',
    docUrl: 'https://open.dingtalk.com/document/orgapp/robot-overview',
    docLabel: 'DingTalk Bot Docs',
    envKeys: [
      { key: 'DINGTALK_WEBHOOK_URL', label: 'Webhook URL', placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=xxx' },
      { key: 'DINGTALK_SECRET', label: 'Secret (签名密钥)', placeholder: 'SECxxxxxxxx', secret: true },
    ],
  },
  feishu: {
    icon: '🚀',
    color: '#3370FF',
    docUrl: 'https://open.feishu.cn/document/client-docs/bot-v3/bot-overview',
    docLabel: 'Feishu Bot Docs',
    envKeys: [
      { key: 'FEISHU_APP_ID', label: 'App ID', placeholder: 'cli_xxxxx' },
      { key: 'FEISHU_APP_SECRET', label: 'App Secret', placeholder: 'xxxxx', secret: true },
      { key: 'FEISHU_WEBHOOK_URL', label: 'Webhook URL', placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxx' },
    ],
  },
  discord: {
    icon: '🎮',
    color: '#5865F2',
    docUrl: 'https://discord.com/developers/docs/intro',
    docLabel: 'Discord Developer Docs',
    envKeys: [
      { key: 'DISCORD_BOT_TOKEN', label: 'Bot Token', placeholder: 'MTxxxxxxxx.xxxxxx.xxxxxxxx', secret: true },
      { key: 'DISCORD_APPLICATION_ID', label: 'Application ID', placeholder: '123456789012345678' },
    ],
  },
  qq: {
    icon: '🐧',
    color: '#12B7F5',
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/',
    docLabel: 'QQ Bot Docs',
    envKeys: [
      { key: 'QQ_BOT_APP_ID', label: 'App ID', placeholder: '10xxxxxxx' },
      { key: 'QQ_BOT_TOKEN', label: 'Token', placeholder: 'xxxxx', secret: true },
    ],
  },
  telegram: {
    icon: '✈️',
    color: '#26A5E4',
    docUrl: 'https://core.telegram.org/bots/api',
    docLabel: 'Telegram Bot API Docs',
    envKeys: [
      { key: 'TELEGRAM_BOT_TOKEN', label: 'Bot Token', placeholder: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11', secret: true },
    ],
  },
  wecom: {
    icon: '🏢',
    color: '#07C160',
    docUrl: 'https://developer.work.weixin.qq.com/document/path/90664',
    docLabel: 'WeCom Docs',
    envKeys: [
      { key: 'WECOM_CORP_ID', label: 'Corp ID', placeholder: 'wwxxxxxxxx' },
      { key: 'WECOM_CORP_SECRET', label: 'Corp Secret', placeholder: 'xxxxx', secret: true },
      { key: 'WECOM_AGENT_ID', label: 'Agent ID', placeholder: '1000002' },
    ],
  },
  webhook: {
    icon: '🔗',
    color: '#6B7280',
    docUrl: '',
    docLabel: '',
    envKeys: [
      { key: 'WEBHOOK_URL', label: 'Webhook URL', placeholder: 'https://your-server.com/webhook' },
      { key: 'WEBHOOK_PORT', label: 'Listen Port', placeholder: '9090' },
    ],
  },
};

const ALL_CHANNEL_TYPES: ChannelType[] = ['dingtalk', 'feishu', 'discord', 'telegram', 'qq', 'wecom', 'webhook'];

export function ChannelsPage() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<ChannelsTab>('channels');

  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [envs, setEnvs] = useState<EnvVar[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedChannel, setExpandedChannel] = useState<string | null>(null);
  const [editingEnvs, setEditingEnvs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [showSendModal, setShowSendModal] = useState(false);
  const [sendForm, setSendForm] = useState({
    channelType: 'dingtalk' as ChannelType,
    target: '',
    content: '',
  });
  const [sending, setSending] = useState(false);

  const getChannelName = (type: string): string => {
    const key = `channels.${type}` as any;
    const translated = t(key);
    return translated === key ? type : translated;
  };

  const loadData = useCallback(async () => {
    try {
      const [channelData, envData] = await Promise.all([
        listChannels(),
        listEnvs(),
      ]);
      setChannels(channelData);
      setEnvs(envData);
    } catch (error) {
      console.error('Failed to load data:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const getEnvValue = (key: string): string => {
    if (editingEnvs[key] !== undefined) return editingEnvs[key];
    const found = envs.find((e) => e.key === key);
    return found?.value || '';
  };

  const setEnvValue = (key: string, value: string) => {
    setEditingEnvs((prev) => ({ ...prev, [key]: value }));
  };

  const handleToggleChannel = async (channelType: string, enabled: boolean) => {
    try {
      await updateChannel(channelType, enabled);
      await loadData();
    } catch (error) {
      console.error('Failed to toggle channel:', error);
    }
  };

  const handleSaveChannelEnvs = async (channelType: string) => {
    const meta = CHANNEL_META[channelType];
    if (!meta) return;

    setSaving(channelType);
    try {
      const updatedEnvs = [...envs];
      for (const envDef of meta.envKeys) {
        const newVal = editingEnvs[envDef.key];
        if (newVal === undefined) continue;

        const idx = updatedEnvs.findIndex((e) => e.key === envDef.key);
        if (idx >= 0) {
          updatedEnvs[idx] = { ...updatedEnvs[idx], value: newVal };
        } else if (newVal.trim()) {
          updatedEnvs.push({ key: envDef.key, value: newVal });
        }
      }
      await saveEnvs(updatedEnvs);
      setEnvs(updatedEnvs);

      // Clear editing state for this channel
      const keysToRemove = meta.envKeys.map((e) => e.key);
      setEditingEnvs((prev) => {
        const next = { ...prev };
        keysToRemove.forEach((k) => delete next[k]);
        return next;
      });
    } catch (error) {
      console.error('Failed to save envs:', error);
    } finally {
      setSaving(null);
    }
  };

  const hasUnsavedChanges = (channelType: string): boolean => {
    const meta = CHANNEL_META[channelType];
    if (!meta) return false;
    return meta.envKeys.some((envDef) => {
      const editing = editingEnvs[envDef.key];
      if (editing === undefined) return false;
      const current = envs.find((e) => e.key === envDef.key)?.value || '';
      return editing !== current;
    });
  };

  const isChannelConfigured = (channelType: string): boolean => {
    const meta = CHANNEL_META[channelType];
    if (!meta) return false;
    return meta.envKeys.some((envDef) => {
      const val = envs.find((e) => e.key === envDef.key)?.value;
      return val && val.trim().length > 0;
    });
  };

  const getChannelFromList = (type: string): ChannelInfo | undefined => {
    return channels.find((c) => c.id === type || c.channel_type === type);
  };

  const handleSend = async () => {
    if (!sendForm.target.trim() || !sendForm.content.trim()) return;
    setSending(true);
    try {
      await sendToChannel(sendForm.channelType, sendForm.target, sendForm.content);
      setSendForm({ channelType: 'dingtalk', target: '', content: '' });
      setShowSendModal(false);
    } catch (error) {
      console.error('Send failed:', error);
    } finally {
      setSending(false);
    }
  };

  const enabledCount = ALL_CHANNEL_TYPES.filter((type) => {
    const ch = getChannelFromList(type);
    return ch?.enabled;
  }).length;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="shrink-0 px-6 pt-8 pb-0 max-w-4xl mx-auto w-full">
        <PageHeader
          title={t('channels.title')}
          description={t('channels.description')}
          actions={activeTab === 'channels' ? (
            <>
              <button
                onClick={loadData}
                className="w-9 h-9 flex items-center justify-center rounded-xl transition-colors"
                style={{ color: 'var(--color-text-secondary)' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-elevated)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <RefreshCw size={16} />
              </button>
              <button
                onClick={() => setShowSendModal(true)}
                className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-[13px] font-medium transition-colors"
                style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-text)' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-bg-elevated)'; }}
              >
                <Send size={15} />
                {t('channels.sendMessage')}
              </button>
            </>
          ) : undefined}
        />

        {/* Tabs */}
        <div className="flex gap-1 mb-6 p-1 rounded-xl bg-[var(--color-bg-subtle)] w-fit">
          {([
            { id: 'channels' as ChannelsTab, labelKey: 'channels.tabChannels', icon: Hash },
            { id: 'sessions' as ChannelsTab, labelKey: 'channels.tabSessions', icon: Users },
          ]).map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`
                  flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-medium transition-all
                  ${isActive ? 'shadow-sm' : 'hover:text-[var(--color-text)]'}
                `}
                style={{
                  background: isActive ? 'var(--color-bg-elevated)' : 'transparent',
                  color: isActive ? 'var(--color-text)' : 'var(--color-text-muted)',
                }}
              >
                <Icon size={15} />
                {t(tab.labelKey)}
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab content */}
      {activeTab === 'sessions' && (
        <div className="flex-1 min-h-0">
          <SessionsPanel />
        </div>
      )}

      {activeTab === 'channels' && (
      <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 pb-8">
        {/* Status bar */}
        <div className="flex items-center gap-3 mb-6 px-4 py-3 rounded-xl border" style={{ background: 'var(--color-bg-elevated)', borderColor: 'var(--color-border)' }}>
          <div className={`w-2 h-2 rounded-full ${enabledCount > 0 ? 'bg-[var(--color-success)]' : 'bg-[var(--color-text-muted)]'}`} />
          <span className="text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>
            {enabledCount} / {ALL_CHANNEL_TYPES.length} {t('channels.enabled')}
          </span>
        </div>

        {/* Channel cards */}
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <RefreshCw size={28} className="animate-spin" style={{ color: 'var(--color-primary)' }} />
          </div>
        ) : (
          <div className="space-y-3">
            {ALL_CHANNEL_TYPES.map((type) => {
              const meta = CHANNEL_META[type];
              const ch = getChannelFromList(type);
              const isEnabled = ch?.enabled || false;
              const isExpanded = expandedChannel === type;
              const configured = isChannelConfigured(type);
              const unsaved = hasUnsavedChanges(type);

              return (
                <div
                  key={type}
                  className="rounded-2xl border transition-all"
                  style={{
                    background: 'var(--color-bg-elevated)',
                    borderColor: isExpanded ? meta.color + '40' : 'var(--color-border)',
                    boxShadow: isExpanded ? `0 0 0 1px ${meta.color}20` : 'none',
                  }}
                >
                  {/* Header row */}
                  <div
                    className="flex items-center gap-4 px-5 py-4 cursor-pointer select-none"
                    onClick={() => setExpandedChannel(isExpanded ? null : type)}
                  >
                    {/* Icon */}
                    <div
                      className="w-10 h-10 rounded-xl flex items-center justify-center text-lg shrink-0"
                      style={{ background: meta.color + '15' }}
                    >
                      {meta.icon}
                    </div>

                    {/* Name + status */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2.5">
                        <span className="font-semibold text-[15px]" style={{ color: 'var(--color-text)' }}>
                          {getChannelName(type)}
                        </span>
                        {configured ? (
                          <span
                            className="text-[11px] px-2 py-0.5 rounded-full font-medium"
                            style={{
                              background: isEnabled ? 'var(--color-success)' + '18' : 'var(--color-text-muted)' + '18',
                              color: isEnabled ? 'var(--color-success)' : 'var(--color-text-muted)',
                            }}
                          >
                            {isEnabled ? t('channels.enabled') : t('channels.notConfigured')}
                          </span>
                        ) : (
                          <span
                            className="text-[11px] px-2 py-0.5 rounded-full font-medium"
                            style={{ background: 'var(--color-warning)' + '18', color: 'var(--color-warning)' }}
                          >
                            {t('channels.notConfigured')}
                          </span>
                        )}
                      </div>
                      <div className="text-[12px] mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                        {type}
                      </div>
                    </div>

                    {/* Toggle */}
                    <label className="relative inline-flex items-center shrink-0" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isEnabled}
                        onChange={(e) => handleToggleChannel(type, e.target.checked)}
                        className="sr-only peer"
                      />
                      <div
                        className="w-10 h-[22px] rounded-full transition-colors duration-200 peer-checked:bg-[var(--color-success)] cursor-pointer"
                        style={{ background: isEnabled ? undefined : 'var(--color-bg-muted)' }}
                      >
                        <div
                          className="absolute top-[3px] left-[3px] w-4 h-4 bg-white rounded-full shadow-sm transition-transform duration-200"
                          style={{ transform: isEnabled ? 'translateX(18px)' : 'translateX(0)' }}
                        />
                      </div>
                    </label>

                    {/* Expand arrow */}
                    <div style={{ color: 'var(--color-text-muted)' }}>
                      {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    </div>
                  </div>

                  {/* Expanded settings panel */}
                  {isExpanded && (
                    <div className="px-5 pb-5 pt-0">
                      <div className="h-px mb-4" style={{ background: 'var(--color-border)' }} />

                      {/* Doc link */}
                      {meta.docUrl && (
                        <button
                          onClick={() => open(meta.docUrl!)}
                          className="inline-flex items-center gap-1.5 text-[13px] font-medium mb-4 transition-opacity hover:opacity-80"
                          style={{ color: meta.color }}
                        >
                          <ExternalLink size={14} />
                          {meta.docLabel}
                        </button>
                      )}

                      {/* Env fields */}
                      <div className="space-y-3">
                        {meta.envKeys.map((envDef) => (
                          <div key={envDef.key}>
                            <label className="flex items-center gap-2 text-[12px] font-medium mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
                              {envDef.label}
                              <code
                                className="text-[11px] px-1.5 py-0.5 rounded-md font-normal"
                                style={{ background: 'var(--color-bg-muted)', color: 'var(--color-text-muted)' }}
                              >
                                {envDef.key}
                              </code>
                            </label>
                            <input
                              type={envDef.secret ? 'password' : 'text'}
                              value={getEnvValue(envDef.key)}
                              onChange={(e) => setEnvValue(envDef.key, e.target.value)}
                              placeholder={envDef.placeholder}
                              className="w-full rounded-xl border px-3.5 py-2.5 text-[13px] focus:outline-none focus:ring-2 transition-all font-mono"
                              style={{
                                background: 'var(--color-bg)',
                                borderColor: 'var(--color-border)',
                                color: 'var(--color-text)',
                              }}
                              onFocus={(e) => { e.currentTarget.style.borderColor = meta.color; e.currentTarget.style.boxShadow = `0 0 0 3px ${meta.color}15`; }}
                              onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--color-border)'; e.currentTarget.style.boxShadow = 'none'; }}
                            />
                          </div>
                        ))}
                      </div>

                      {/* Save button */}
                      <div className="flex items-center justify-between mt-4">
                        <div className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
                          {configured && !unsaved && '✓ ' + t('channels.configSaved')}
                          {unsaved && '● ' + t('channels.unsavedChanges')}
                        </div>
                        <button
                          onClick={() => handleSaveChannelEnvs(type)}
                          disabled={!unsaved || saving === type}
                          className="flex items-center gap-2 px-4 py-2 rounded-xl text-[13px] font-medium disabled:opacity-40 transition-all text-white"
                          style={{ background: unsaved ? meta.color : 'var(--color-text-muted)' }}
                        >
                          <Save size={14} />
                          {saving === type ? t('channels.saving') : t('channels.saveConfig')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      </div>
      )}

      {/* Send message modal */}
      {showSendModal && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div
            className="rounded-3xl p-6 w-full max-w-md shadow-2xl border"
            style={{ background: 'var(--color-bg-elevated)', borderColor: 'var(--color-border)' }}
          >
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-semibold tracking-tight">{t('channels.sendTitle')}</h2>
              <button
                onClick={() => setShowSendModal(false)}
                className="p-2 rounded-xl transition-colors"
                style={{ color: 'var(--color-text-secondary)' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-[13px] font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>
                  {t('channels.channelType')}
                </label>
                <Select
                  value={sendForm.channelType}
                  onChange={(v) => setSendForm({ ...sendForm, channelType: v as ChannelType })}
                  options={ALL_CHANNEL_TYPES.map((type) => ({
                    value: type,
                    label: `${CHANNEL_META[type].icon} ${getChannelName(type)}`,
                  }))}
                  fullWidth
                />
              </div>

              <div>
                <label className="block text-[13px] font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>
                  {t('channels.targetId')}
                </label>
                <input
                  type="text"
                  value={sendForm.target}
                  onChange={(e) => setSendForm({ ...sendForm, target: e.target.value })}
                  placeholder={t('channels.targetIdPlaceholder')}
                  className="w-full rounded-xl border px-4 py-2.5 text-[13px] focus:outline-none focus:ring-2 transition-shadow"
                  style={{
                    background: 'var(--color-bg)',
                    borderColor: 'var(--color-border)',
                    color: 'var(--color-text)',
                  }}
                />
              </div>

              <div>
                <label className="block text-[13px] font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>
                  {t('channels.messageContent')}
                </label>
                <textarea
                  value={sendForm.content}
                  onChange={(e) => setSendForm({ ...sendForm, content: e.target.value })}
                  placeholder={t('channels.messagePlaceholder')}
                  rows={4}
                  className="w-full resize-none rounded-xl border px-4 py-2.5 text-[13px] focus:outline-none focus:ring-2 transition-shadow"
                  style={{
                    background: 'var(--color-bg)',
                    borderColor: 'var(--color-border)',
                    color: 'var(--color-text)',
                  }}
                />
              </div>
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setShowSendModal(false)}
                className="px-4 py-2.5 text-[13px] font-medium rounded-xl transition-colors"
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleSend}
                disabled={sending || !sendForm.target.trim() || !sendForm.content.trim()}
                className="px-4 py-2.5 text-[13px] font-medium text-white rounded-xl disabled:opacity-50 transition-colors shadow-sm"
                style={{ background: 'var(--color-primary)' }}
              >
                {sending ? t('channels.sending') : t('common.send')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
