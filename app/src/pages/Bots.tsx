/**
 * Bots Management Page
 * Create, edit, delete bot instances per platform
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  Plus,
  Trash2,
  Edit,
  RefreshCw,
  Send,
  X,
  Power,
  PowerOff,
  Users,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  ExternalLink,
} from 'lucide-react';
import { open } from '@tauri-apps/plugin-shell';
import { Select } from '../components/Select';
import {
  listBots,
  listPlatforms,
  createBot,
  updateBot,
  deleteBot,
  sendToBot,
  startBots,
  stopBots,
  type BotInfo,
  type PlatformType,
  type PlatformInfo,
} from '../api/bots';
import { PageHeader } from '../components/PageHeader';
import { SessionsPanel } from './Sessions';
import { toast, confirm } from '../components/Toast';

type BotsTab = 'bots' | 'sessions';

/* Platform metadata */
interface PlatformMeta {
  icon: string;
  color: string;
  docUrl: string;
  docLabel: string;
  configFields: { key: string; label: string; placeholder: string; secret?: boolean }[];
}

const PLATFORM_META: Record<string, PlatformMeta> = {
  discord: {
    icon: '🎮',
    color: '#5865F2',
    docUrl: 'https://discord.com/developers/docs/intro',
    docLabel: 'Discord Developer Docs',
    configFields: [
      { key: 'bot_token', label: 'Bot Token', placeholder: 'MTxxxxxxxx.xxxxxx.xxxxxxxx', secret: true },
    ],
  },
  telegram: {
    icon: '✈️',
    color: '#26A5E4',
    docUrl: 'https://core.telegram.org/bots/api',
    docLabel: 'Telegram Bot API Docs',
    configFields: [
      { key: 'bot_token', label: 'Bot Token', placeholder: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11', secret: true },
    ],
  },
  qq: {
    icon: '🐧',
    color: '#12B7F5',
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/',
    docLabel: 'QQ Bot Docs',
    configFields: [
      { key: 'app_id', label: 'App ID', placeholder: '10xxxxxxx' },
      { key: 'client_secret', label: 'Client Secret (AppSecret)', placeholder: 'xxxxx', secret: true },
    ],
  },
  dingtalk: {
    icon: '🔔',
    color: '#0A6CFF',
    docUrl: 'https://open.dingtalk.com/document/orgapp/robot-overview',
    docLabel: 'DingTalk Bot Docs',
    configFields: [
      { key: 'webhook_url', label: 'Webhook URL', placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=xxx' },
      { key: 'secret', label: 'Secret', placeholder: 'SECxxxxxxxx', secret: true },
    ],
  },
  feishu: {
    icon: '🚀',
    color: '#3370FF',
    docUrl: 'https://open.feishu.cn/document/client-docs/bot-v3/bot-overview',
    docLabel: 'Feishu Bot Docs',
    configFields: [
      { key: 'app_id', label: 'App ID', placeholder: 'cli_xxxxx' },
      { key: 'app_secret', label: 'App Secret', placeholder: 'xxxxx', secret: true },
      { key: 'webhook_url', label: 'Webhook URL', placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxx' },
    ],
  },
  wecom: {
    icon: '🏢',
    color: '#07C160',
    docUrl: 'https://developer.work.weixin.qq.com/document/path/90664',
    docLabel: 'WeCom Docs',
    configFields: [
      { key: 'corp_id', label: 'Corp ID', placeholder: 'wwxxxxxxxx' },
      { key: 'corp_secret', label: 'Corp Secret', placeholder: 'xxxxx', secret: true },
      { key: 'agent_id', label: 'Agent ID', placeholder: '1000002' },
    ],
  },
  webhook: {
    icon: '🔗',
    color: '#6B7280',
    docUrl: '',
    docLabel: '',
    configFields: [
      { key: 'webhook_url', label: 'Webhook URL', placeholder: 'https://your-server.com/webhook' },
      { key: 'port', label: 'Listen Port', placeholder: '9090' },
    ],
  },
};

interface BotDialog {
  open: boolean;
  mode: 'create' | 'edit';
  id: string;
  name: string;
  platform: PlatformType;
  config: Record<string, string>;
  enabled: boolean;
}

const emptyDialog: BotDialog = {
  open: false,
  mode: 'create',
  id: '',
  name: '',
  platform: 'discord',
  config: {},
  enabled: true,
};

interface BotsPageProps {
  consumeNotifContext?: () => Record<string, unknown> | null;
}

export function BotsPage({ consumeNotifContext }: BotsPageProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<BotsTab>('bots');
  const [bots, setBots] = useState<BotInfo[]>([]);
  const [platforms, setPlatforms] = useState<PlatformInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<BotDialog>({ ...emptyDialog });
  const [saving, setSaving] = useState(false);
  const [botsRunning, setBotsRunning] = useState(false);
  const [expandedBot, setExpandedBot] = useState<string | null>(null);

  // Send message state
  const [showSendModal, setShowSendModal] = useState(false);
  const [sendForm, setSendForm] = useState({ botId: '', target: '', content: '' });
  const [sending, setSending] = useState(false);

  const getPlatformName = (platform: string): string => {
    const key = `bots.${platform}` as any;
    const translated = t(key);
    return translated === key ? platform : translated;
  };

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [botData, platformData] = await Promise.all([
        listBots(),
        listPlatforms(),
      ]);
      setBots(botData);
      setPlatforms(platformData);
    } catch (error) {
      console.error('Failed to load bots:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData().then(() => {
      const ctx = consumeNotifContext?.();
      if (ctx?.page === 'bots' && ctx?.bot_id) {
        setExpandedBot(ctx.bot_id as string);
      }
    });
  }, [loadData]);

  const openCreateDialog = () => {
    setDialog({
      open: true,
      mode: 'create',
      id: '',
      name: '',
      platform: 'discord',
      config: {},
      enabled: true,
    });
  };

  const openEditDialog = (bot: BotInfo) => {
    const config: Record<string, string> = {};
    if (bot.config && typeof bot.config === 'object') {
      for (const [k, v] of Object.entries(bot.config)) {
        config[k] = String(v ?? '');
      }
    }
    setDialog({
      open: true,
      mode: 'edit',
      id: bot.id,
      name: bot.name,
      platform: bot.platform as PlatformType,
      config,
      enabled: bot.enabled,
    });
  };

  const handleSave = async () => {
    if (!dialog.name.trim()) {
      toast.info(t('bots.botName'));
      return;
    }
    setSaving(true);
    try {
      if (dialog.mode === 'create') {
        await createBot(
          dialog.name,
          dialog.platform,
          dialog.config as Record<string, unknown>,
        );
      } else {
        await updateBot(dialog.id, {
          name: dialog.name,
          enabled: dialog.enabled,
          config: dialog.config as Record<string, unknown>,
        });
      }
      await loadData();
      setDialog({ ...emptyDialog });
    } catch (error) {
      console.error('Failed to save bot:', error);
      toast.error(String(error));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (bot: BotInfo) => {
    if (!(await confirm(t('bots.deleteConfirm')))) return;
    try {
      await deleteBot(bot.id);
      await loadData();
    } catch (error) {
      console.error('Failed to delete bot:', error);
      toast.error(String(error));
    }
  };

  const handleToggleEnabled = async (bot: BotInfo) => {
    try {
      await updateBot(bot.id, { enabled: !bot.enabled });
      await loadData();
    } catch (error) {
      console.error('Failed to toggle bot:', error);
    }
  };

  const handleStartAll = async () => {
    setBotsRunning(true);
    try {
      const result = await startBots();
      toast.success(`${t('bots.started')}: ${result.bots.length} bots`);
    } catch (error) {
      console.error('Failed to start bots:', error);
      toast.error(String(error));
      setBotsRunning(false);
    }
  };

  const handleStopAll = async () => {
    try {
      await stopBots();
      setBotsRunning(false);
      toast.success(t('bots.stopped'));
    } catch (error) {
      console.error('Failed to stop bots:', error);
      toast.error(String(error));
    }
  };

  const handleSend = async () => {
    if (!sendForm.botId || !sendForm.target.trim() || !sendForm.content.trim()) return;
    setSending(true);
    try {
      await sendToBot(sendForm.botId, sendForm.target, sendForm.content);
      toast.success(t('bots.sent'));
      setSendForm({ botId: '', target: '', content: '' });
      setShowSendModal(false);
    } catch (error) {
      console.error('Send failed:', error);
      toast.error(`${t('bots.sendFailed')}: ${String(error)}`);
    } finally {
      setSending(false);
    }
  };

  const enabledCount = bots.filter((b) => b.enabled).length;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="shrink-0 px-6 pt-8 pb-0 w-full">
        <PageHeader
          title={t('bots.title')}
          description={t('bots.description')}
          actions={activeTab === 'bots' ? (
            <>
              <button
                onClick={loadData}
                className="w-9 h-9 flex items-center justify-center rounded-xl transition-colors"
                style={{ color: 'var(--color-text-secondary)' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-elevated)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
              </button>
              {bots.length > 0 && (
                <button
                  onClick={() => setShowSendModal(true)}
                  className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-[13px] font-medium transition-colors"
                  style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-text)' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-bg-elevated)'; }}
                >
                  <Send size={15} />
                  {t('bots.sendMessage')}
                </button>
              )}
              {botsRunning ? (
                <button
                  onClick={handleStopAll}
                  className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-[13px] font-medium transition-colors"
                  style={{ background: 'var(--color-error)', color: '#FFFFFF' }}
                >
                  <PowerOff size={15} />
                  {t('bots.stopAll')}
                </button>
              ) : (
                <button
                  onClick={handleStartAll}
                  disabled={enabledCount === 0}
                  className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-[13px] font-medium transition-colors disabled:opacity-40"
                  style={{ background: 'var(--color-success)', color: '#FFFFFF' }}
                >
                  <Power size={15} />
                  {t('bots.startAll')}
                </button>
              )}
              <button
                onClick={openCreateDialog}
                className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-[13px] font-medium transition-colors"
                style={{ background: 'var(--color-primary)', color: '#FFFFFF' }}
              >
                <Plus size={15} />
                {t('bots.create')}
              </button>
            </>
          ) : undefined}
        />

        {/* Tabs */}
        <div className="flex gap-1 mb-6 p-1 rounded-xl bg-[var(--color-bg-subtle)] w-fit">
          {([
            { id: 'bots' as BotsTab, labelKey: 'bots.tabBots', icon: Bot },
            { id: 'sessions' as BotsTab, labelKey: 'bots.tabSessions', icon: Users },
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

      {/* Sessions tab */}
      {activeTab === 'sessions' && (
        <div className="flex-1 min-h-0">
          <SessionsPanel />
        </div>
      )}

      {/* Bots tab */}
      {activeTab === 'bots' && (
        <div className="flex-1 overflow-y-auto">
          <div className="w-full px-8 pb-8">
            {/* Status bar */}
            <div className="flex items-center gap-3 mb-6 px-4 py-3 rounded-xl border" style={{ background: 'var(--color-bg-elevated)', borderColor: 'var(--color-border)' }}>
              <div className={`w-2 h-2 rounded-full ${enabledCount > 0 ? 'bg-[var(--color-success)]' : 'bg-[var(--color-text-muted)]'}`} />
              <span className="text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>
                {enabledCount} / {bots.length} {t('bots.enabled')}
              </span>
              {botsRunning && (
                <span className="text-[11px] px-2 py-0.5 rounded-full font-medium bg-[var(--color-success)]/15 text-[var(--color-success)]">
                  Running
                </span>
              )}
            </div>

            {/* Bot cards */}
            {loading ? (
              <div className="flex items-center justify-center h-64">
                <RefreshCw size={28} className="animate-spin" style={{ color: 'var(--color-primary)' }} />
              </div>
            ) : bots.length === 0 ? (
              <div className="text-center py-16 px-8 border border-dashed rounded-2xl" style={{ borderColor: 'var(--color-border)' }}>
                {/* Icon cluster */}
                <div className="flex items-center justify-center gap-3 mb-5">
                  {['discord', 'telegram', 'feishu', 'dingtalk', 'qq'].map((p) => (
                    <div
                      key={p}
                      className="w-10 h-10 rounded-xl flex items-center justify-center text-lg"
                      style={{ background: (PLATFORM_META[p]?.color || '#888') + '12' }}
                    >
                      {PLATFORM_META[p]?.icon || '🤖'}
                    </div>
                  ))}
                </div>

                <p className="text-[16px] font-semibold mb-3" style={{ color: 'var(--color-text)' }}>
                  {t('bots.noBots')}
                </p>
                <p
                  className="text-[13px] max-w-md mx-auto mb-6 whitespace-pre-line leading-relaxed text-left"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  {t('bots.noBotsDesc')}
                </p>
                <button
                  onClick={openCreateDialog}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-[14px] font-medium text-white transition-opacity hover:opacity-90"
                  style={{ background: 'var(--color-primary)' }}
                >
                  <Plus size={16} />
                  {t('bots.clickToCreate')}
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                {bots.map((bot) => {
                  const meta = PLATFORM_META[bot.platform] || PLATFORM_META.webhook;
                  const isExpanded = expandedBot === bot.id;

                  return (
                    <div
                      key={bot.id}
                      className="rounded-2xl border transition-all"
                      style={{
                        background: 'var(--color-bg-elevated)',
                        borderColor: isExpanded ? meta.color + '40' : 'var(--color-border)',
                        boxShadow: isExpanded ? `0 0 0 1px ${meta.color}20` : 'none',
                        opacity: bot.enabled ? 1 : 0.6,
                      }}
                    >
                      {/* Header row */}
                      <div
                        className="flex items-center gap-4 px-5 py-4 cursor-pointer select-none"
                        onClick={() => setExpandedBot(isExpanded ? null : bot.id)}
                      >
                        {/* Icon */}
                        <div
                          className="w-10 h-10 rounded-xl flex items-center justify-center text-lg shrink-0"
                          style={{ background: meta.color + '15' }}
                        >
                          {meta.icon}
                        </div>

                        {/* Name + platform */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2.5">
                            <span className="font-semibold text-[15px]" style={{ color: 'var(--color-text)' }}>
                              {bot.name}
                            </span>
                            <span
                              className="text-[11px] px-2 py-0.5 rounded-full font-medium"
                              style={{
                                background: bot.enabled ? 'var(--color-success)' + '18' : 'var(--color-text-muted)' + '18',
                                color: bot.enabled ? 'var(--color-success)' : 'var(--color-text-muted)',
                              }}
                            >
                              {bot.enabled ? t('bots.enabled') : t('bots.disabled')}
                            </span>
                          </div>
                          <div className="text-[12px] mt-0.5 flex items-center gap-2" style={{ color: 'var(--color-text-muted)' }}>
                            <span>{getPlatformName(bot.platform)}</span>
                            <span className="opacity-50">·</span>
                            <span className="font-mono text-[11px]">{bot.id.slice(0, 8)}...</span>
                          </div>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                          {/* Toggle */}
                          <label className="relative inline-flex items-center shrink-0">
                            <input
                              type="checkbox"
                              checked={bot.enabled}
                              onChange={() => handleToggleEnabled(bot)}
                              className="sr-only peer"
                            />
                            <div
                              className="w-10 h-[22px] rounded-full transition-colors duration-200 peer-checked:bg-[var(--color-success)] cursor-pointer"
                              style={{ background: bot.enabled ? undefined : 'var(--color-bg-muted)' }}
                            >
                              <div
                                className="absolute top-[3px] left-[3px] w-4 h-4 bg-white rounded-full shadow-sm transition-transform duration-200"
                                style={{ transform: bot.enabled ? 'translateX(18px)' : 'translateX(0)' }}
                              />
                            </div>
                          </label>

                          <button
                            onClick={() => openEditDialog(bot)}
                            className="p-2 rounded-lg transition-colors"
                            style={{ color: 'var(--color-text-secondary)' }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                          >
                            <Edit size={15} />
                          </button>
                          <button
                            onClick={() => handleDelete(bot)}
                            className="p-2 rounded-lg transition-colors"
                            style={{ color: 'var(--color-error)' }}
                            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-error)' + '10'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>

                        {/* Expand arrow */}
                        <div style={{ color: 'var(--color-text-muted)' }}>
                          {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                        </div>
                      </div>

                      {/* Expanded details */}
                      {isExpanded && (
                        <div className="px-5 pb-5 pt-0">
                          <div className="h-px mb-4" style={{ background: 'var(--color-border)' }} />

                          {/* Doc link */}
                          {meta.docUrl && (
                            <button
                              onClick={() => open(meta.docUrl)}
                              className="inline-flex items-center gap-1.5 text-[13px] font-medium mb-4 transition-opacity hover:opacity-80"
                              style={{ color: meta.color }}
                            >
                              <ExternalLink size={14} />
                              {meta.docLabel}
                            </button>
                          )}

                          {/* Config fields (read-only display) */}
                          <div className="space-y-2">
                            {meta.configFields.map((field) => {
                              const val = (bot.config as any)?.[field.key];
                              return (
                                <div key={field.key} className="flex items-center gap-3">
                                  <span className="text-[12px] font-medium w-28 shrink-0" style={{ color: 'var(--color-text-secondary)' }}>
                                    {field.label}
                                  </span>
                                  <span className="text-[13px] font-mono truncate" style={{ color: val ? 'var(--color-text)' : 'var(--color-text-muted)' }}>
                                    {val ? (field.secret ? '••••••••' : String(val)) : '(not set)'}
                                  </span>
                                </div>
                              );
                            })}
                          </div>

                          {/* Edit button */}
                          <div className="mt-4 flex justify-end">
                            <button
                              onClick={() => openEditDialog(bot)}
                              className="flex items-center gap-2 px-4 py-2 rounded-xl text-[13px] font-medium transition-colors text-white"
                              style={{ background: meta.color }}
                            >
                              <Edit size={14} />
                              {t('common.edit')}
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

      {/* Create/Edit dialog */}
      {dialog.open && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div
            className="rounded-3xl p-6 w-full max-w-md shadow-2xl border max-h-[85vh] overflow-y-auto"
            style={{ background: 'var(--color-bg-elevated)', borderColor: 'var(--color-border)' }}
          >
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-semibold text-[15px]">
                {dialog.mode === 'create' ? t('bots.createTitle') : t('bots.editTitle')}
              </h2>
              <button
                onClick={() => setDialog({ ...emptyDialog })}
                className="p-2 rounded-xl transition-colors"
                style={{ color: 'var(--color-text-secondary)' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-4">
              {/* Name */}
              <div>
                <label className="block text-[13px] font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>
                  {t('bots.botName')} *
                </label>
                <input
                  type="text"
                  value={dialog.name}
                  onChange={(e) => setDialog({ ...dialog, name: e.target.value })}
                  placeholder={t('bots.botNamePlaceholder')}
                  className="w-full rounded-xl border px-4 py-2.5 text-[13px] focus:outline-none focus:ring-2 transition-shadow"
                  style={{ background: 'var(--color-bg)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
                />
              </div>

              {/* Platform */}
              <div>
                <label className="block text-[13px] font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>
                  {t('bots.platform')} *
                </label>
                <Select
                  value={dialog.platform}
                  onChange={(v) => setDialog({ ...dialog, platform: v as PlatformType, config: {} })}
                  options={Object.keys(PLATFORM_META).map((p) => ({
                    value: p,
                    label: `${PLATFORM_META[p].icon} ${getPlatformName(p)}`,
                  }))}
                  fullWidth
                  disabled={dialog.mode === 'edit'}
                />
              </div>

              {/* Platform doc link */}
              {PLATFORM_META[dialog.platform]?.docUrl && (
                <div
                  className="flex items-center gap-3 px-4 py-3 rounded-xl"
                  style={{ background: PLATFORM_META[dialog.platform].color + '08', border: `1px solid ${PLATFORM_META[dialog.platform].color}20` }}
                >
                  <div
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-base shrink-0"
                    style={{ background: PLATFORM_META[dialog.platform].color + '15' }}
                  >
                    {PLATFORM_META[dialog.platform].icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
                      {t('bots.platformDocHint')}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => open(PLATFORM_META[dialog.platform].docUrl)}
                    className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-opacity hover:opacity-80 text-white"
                    style={{ background: PLATFORM_META[dialog.platform].color }}
                  >
                    <ExternalLink size={12} />
                    {t('bots.platformDoc')}
                  </button>
                </div>
              )}

              {/* Platform config fields */}
              <div>
                <label className="block text-[13px] font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>
                  {t('bots.config')}
                </label>
                <div className="space-y-3">
                  {(PLATFORM_META[dialog.platform]?.configFields || []).map((field) => (
                    <div key={field.key}>
                      <label className="block text-[12px] mb-1" style={{ color: 'var(--color-text-muted)' }}>
                        {field.label}
                      </label>
                      <input
                        type={field.secret ? 'password' : 'text'}
                        value={dialog.config[field.key] || ''}
                        onChange={(e) => setDialog({
                          ...dialog,
                          config: { ...dialog.config, [field.key]: e.target.value },
                        })}
                        placeholder={field.placeholder}
                        className="w-full rounded-xl border px-3.5 py-2.5 text-[13px] font-mono focus:outline-none focus:ring-2 transition-shadow"
                        style={{ background: 'var(--color-bg)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* Enable toggle */}
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="bot-enabled"
                  checked={dialog.enabled}
                  onChange={(e) => setDialog({ ...dialog, enabled: e.target.checked })}
                  className="accent-[var(--color-primary)]"
                />
                <label htmlFor="bot-enabled" className="text-[13px]">
                  {t('bots.enabled')}
                </label>
              </div>
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setDialog({ ...emptyDialog })}
                className="px-4 py-2.5 text-[13px] font-medium rounded-xl transition-colors"
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !dialog.name.trim()}
                className="px-4 py-2.5 text-[13px] font-medium text-white rounded-xl disabled:opacity-50 transition-colors shadow-sm"
                style={{ background: 'var(--color-primary)' }}
              >
                {saving ? t('common.saving') : (dialog.mode === 'create' ? t('common.create') : t('common.save'))}
              </button>
            </div>
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
              <h2 className="font-semibold tracking-tight">{t('bots.sendTitle')}</h2>
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
                  {t('bots.selectBot')}
                </label>
                <Select
                  value={sendForm.botId}
                  onChange={(v) => setSendForm({ ...sendForm, botId: v })}
                  options={bots.filter(b => b.enabled).map((b) => ({
                    value: b.id,
                    label: `${PLATFORM_META[b.platform]?.icon || '🤖'} ${b.name}`,
                  }))}
                  fullWidth
                />
              </div>

              <div>
                <label className="block text-[13px] font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>
                  {t('bots.targetId')}
                </label>
                <input
                  type="text"
                  value={sendForm.target}
                  onChange={(e) => setSendForm({ ...sendForm, target: e.target.value })}
                  placeholder={t('bots.targetIdPlaceholder')}
                  className="w-full rounded-xl border px-4 py-2.5 text-[13px] focus:outline-none focus:ring-2 transition-shadow"
                  style={{ background: 'var(--color-bg)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
                />
              </div>

              <div>
                <label className="block text-[13px] font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>
                  {t('bots.messageContent')}
                </label>
                <textarea
                  value={sendForm.content}
                  onChange={(e) => setSendForm({ ...sendForm, content: e.target.value })}
                  placeholder={t('bots.messagePlaceholder')}
                  rows={4}
                  className="w-full resize-none rounded-xl border px-4 py-2.5 text-[13px] focus:outline-none focus:ring-2 transition-shadow"
                  style={{ background: 'var(--color-bg)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
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
                disabled={sending || !sendForm.botId || !sendForm.target.trim() || !sendForm.content.trim()}
                className="px-4 py-2.5 text-[13px] font-medium text-white rounded-xl disabled:opacity-50 transition-colors shadow-sm"
                style={{ background: 'var(--color-primary)' }}
              >
                {sending ? t('bots.sending') : t('common.send')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
