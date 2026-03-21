/**
 * Bots Management Page
 * Create, edit, delete bot instances per platform
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  Plus,
  RefreshCw,
  Send,
  Power,
  PowerOff,
  Users,
} from 'lucide-react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  listBots,
  listPlatforms,
  createBot,
  updateBot,
  deleteBot,
  sendToBot,
  startBots,
  stopBots,
  getBotStatuses,
  type BotInfo,
  type PlatformType,
  type PlatformInfo,
  type BotStatusInfo,
} from '../api/bots';
import { PageHeader } from '../components/PageHeader';
import { SessionsPanel } from './Sessions';
import { toast, confirm } from '../components/Toast';
import { PLATFORM_META } from '../components/bots/platformMeta';
import { BotCard } from '../components/bots/BotCard';
import { BotFormDialog, emptyDialog, type BotDialog } from '../components/bots/BotFormDialog';
import { SendMessageModal } from '../components/bots/SendMessageModal';

type BotsTab = 'bots' | 'sessions';

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

  // Bot connection status
  const [botStatuses, setBotStatuses] = useState<Record<string, BotStatusInfo>>({});

  // Send message state
  const [showSendModal, setShowSendModal] = useState(false);
  const [sendForm, setSendForm] = useState({ botId: '', target: '', content: '' });
  const [sending, setSending] = useState(false);

  // Listen for bot status events from backend
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;

    // Fetch initial statuses
    getBotStatuses().then((statuses) => {
      const map: Record<string, BotStatusInfo> = {};
      for (const s of statuses) {
        map[s.bot_id] = s;
      }
      setBotStatuses(map);
    }).catch(() => {});

    // Subscribe to live updates
    listen<BotStatusInfo>('bot://status', (event) => {
      setBotStatuses((prev) => ({
        ...prev,
        [event.payload.bot_id]: event.payload,
      }));
    }).then((fn) => { unlisten = fn; });

    return () => { unlisten?.(); };
  }, []);

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
                {bots.map((bot) => (
                  <BotCard
                    key={bot.id}
                    bot={bot}
                    isExpanded={expandedBot === bot.id}
                    onToggleExpand={() => setExpandedBot(expandedBot === bot.id ? null : bot.id)}
                    onEdit={() => openEditDialog(bot)}
                    onDelete={() => handleDelete(bot)}
                    onToggleEnabled={() => handleToggleEnabled(bot)}
                    status={botStatuses[bot.id]}
                    getPlatformName={getPlatformName}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Create/Edit dialog */}
      {dialog.open && (
        <BotFormDialog
          dialog={dialog}
          saving={saving}
          onDialogChange={setDialog}
          onClose={() => setDialog({ ...emptyDialog })}
          onSave={handleSave}
          getPlatformName={getPlatformName}
        />
      )}

      {/* Send message modal */}
      {showSendModal && (
        <SendMessageModal
          bots={bots}
          sendForm={sendForm}
          sending={sending}
          onSendFormChange={setSendForm}
          onClose={() => setShowSendModal(false)}
          onSend={handleSend}
        />
      )}
    </div>
  );
}
