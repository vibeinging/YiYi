/**
 * Settings Page
 * Apple-inspired Design with Tabs
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Palette,
  Cpu,
  Key,
  SlidersHorizontal,
  FolderOpen,
  Check,
  Shield,
  Plus,
  Trash2,
  Lock,
  Unlock,
  Download,
  RefreshCw,
  CheckCircle,
  AlertCircle,
  Loader2,
  Brain,
  Play,
  FileText,
  Eye,
  EyeOff,
  Info,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { PageHeader } from '../components/PageHeader';
import { ModelsPage } from './Models';
import { EnvironmentsPage } from './Environments';
import { getUserWorkspace, setUserWorkspace, getMemmeConfig, saveMemmeConfig, type MemmeConfig } from '../api/system';
import {
  listAuthorizedFolders,
  addAuthorizedFolder,
  updateAuthorizedFolder,
  removeAuthorizedFolder,
  pickFolder,
  listSensitivePatterns,
  addSensitivePattern,
  toggleSensitivePattern,
  removeSensitivePattern,
  type AuthorizedFolder,
  type SensitivePattern,
} from '../api/workspace';
import { toast } from '../components/Toast';
import { listCliProviders, saveCliProviderConfig, installCliProvider, deleteCliProvider, type CliProviderInfo } from '../api/cli';

type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'installing' | 'up-to-date' | 'error';

function UpdateChecker() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<UpdateStatus>('idle');
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');

  const handleCheck = useCallback(async () => {
    setStatus('checking');
    setError('');
    try {
      const result = await check();
      if (result) {
        setUpdate(result);
        setStatus('available');
      } else {
        setStatus('up-to-date');
      }
    } catch (e) {
      setError(String(e));
      setStatus('error');
    }
  }, []);

  const handleInstall = useCallback(async () => {
    if (!update) return;
    setStatus('downloading');
    try {
      let totalBytes = 0;
      let downloadedBytes = 0;
      await update.downloadAndInstall((event) => {
        if ('contentLength' in event) {
          totalBytes = (event as any).contentLength ?? 0;
        }
        if ('chunkLength' in event) {
          downloadedBytes += (event as any).chunkLength ?? 0;
          if (totalBytes > 0) {
            setProgress(Math.round((downloadedBytes / totalBytes) * 100));
          }
        }
      });
      setStatus('installing');
      await relaunch();
    } catch (e) {
      setError(String(e));
      setStatus('error');
    }
  }, [update]);

  return (
    <div className="pt-3 border-t border-[var(--color-border)]">
      <div className="flex items-center gap-3">
        {status === 'idle' && (
          <button
            onClick={handleCheck}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-[13px] font-medium transition-colors"
            style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-primary)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
          >
            <RefreshCw size={14} />
            {t('settings.checkUpdate')}
          </button>
        )}

        {status === 'checking' && (
          <div className="flex items-center gap-2 px-4 py-2 text-[13px] text-[var(--color-text-muted)]">
            <Loader2 size={14} className="animate-spin" />
            {t('settings.checking')}
          </div>
        )}

        {status === 'up-to-date' && (
          <div className="flex items-center gap-2 px-4 py-2">
            <CheckCircle size={14} style={{ color: 'var(--color-success)' }} />
            <span className="text-[13px]" style={{ color: 'var(--color-success)' }}>
              {t('settings.upToDate')}
            </span>
            <button
              onClick={() => setStatus('idle')}
              className="ml-2 text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            >
              {t('settings.checkUpdate')}
            </button>
          </div>
        )}

        {status === 'available' && update && (
          <div className="flex-1 space-y-2">
            <div className="flex items-center gap-2">
              <Download size={14} style={{ color: 'var(--color-primary)' }} />
              <span className="text-[13px] font-medium" style={{ color: 'var(--color-primary)' }}>
                {t('settings.updateVersion', { version: update.version })}
              </span>
            </div>
            {update.body && (
              <div
                className="p-3 rounded-xl text-[12px] leading-relaxed max-h-32 overflow-y-auto"
                style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-secondary)' }}
              >
                <div className="text-[11px] font-medium mb-1" style={{ color: 'var(--color-text-muted)' }}>
                  {t('settings.releaseNotes')}
                </div>
                {update.body}
              </div>
            )}
            <button
              onClick={handleInstall}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-[13px] font-medium transition-colors"
              style={{ background: 'var(--color-primary)', color: '#FFFFFF' }}
            >
              <Download size={14} />
              {t('settings.installAndRestart')}
            </button>
          </div>
        )}

        {status === 'downloading' && (
          <div className="flex-1 space-y-2">
            <div className="flex items-center gap-2 text-[13px] text-[var(--color-text-muted)]">
              <Loader2 size={14} className="animate-spin" />
              {progress > 0
                ? t('settings.downloadProgress', { percent: progress })
                : t('settings.downloading')}
            </div>
            {progress > 0 && (
              <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--color-bg-subtle)' }}>
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{ width: `${progress}%`, background: 'var(--color-primary)' }}
                />
              </div>
            )}
          </div>
        )}

        {status === 'installing' && (
          <div className="flex items-center gap-2 text-[13px] text-[var(--color-text-muted)]">
            <Loader2 size={14} className="animate-spin" />
            {t('settings.installing')}
          </div>
        )}

        {status === 'error' && (
          <div className="flex items-center gap-2">
            <AlertCircle size={14} style={{ color: 'var(--color-error)' }} />
            <span className="text-[13px]" style={{ color: 'var(--color-error)' }}>
              {t('settings.updateFailed')}
            </span>
            <button
              onClick={handleCheck}
              className="ml-2 text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            >
              {t('settings.checkUpdate')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

type SettingsTab = 'general' | 'models' | 'environments' | 'workspace' | 'cli';

export function SettingsPage() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [workspacePath, setWorkspacePath] = useState('');
  const [editingPath, setEditingPath] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [workspaceSaved, setWorkspaceSaved] = useState(false);

  // Meditation state
  const [meditationEnabled, setMeditationEnabled] = useState(false);
  const [meditationStart, setMeditationStart] = useState('02:00');
  const [meditationNotify, setMeditationNotify] = useState(true);
  const [meditationLast, setMeditationLast] = useState<{
    date: string;
    duration_minutes: number;
    summary: string;
    journal_path?: string;
  } | null>(null);
  const [meditationTriggering, setMeditationTriggering] = useState(false);

  // MemMe memory engine state
  const [memmeConfig, setMemmeConfig] = useState<MemmeConfig | null>(null);

  const saveMemmeConfigFull = async (config: MemmeConfig | null) => {
    if (!config) return;
    try {
      await saveMemmeConfig(config);
    } catch (e) { console.error('Failed to save MemMe config:', e); }
  };

  // Workspace authorization state
  const [folders, setFolders] = useState<AuthorizedFolder[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [patterns, setPatterns] = useState<SensitivePattern[]>([]);
  const [patternsLoading, setPatternsLoading] = useState(false);
  const [newPattern, setNewPattern] = useState('');

  useEffect(() => {
    getUserWorkspace().then((p) => {
      setWorkspacePath(p);
      setEditingPath(p);
    }).catch(() => {});

    // Load meditation config
    invoke('get_meditation_config').then((config: any) => {
      if (config) {
        setMeditationEnabled(config.enabled ?? false);
        setMeditationStart(config.start_time ?? '02:00');
        setMeditationNotify(config.notify_on_complete ?? true);
      }
    }).catch((e) => console.error('Failed to load meditation config:', e));

    // Load latest meditation session
    invoke('get_latest_meditation').then((session: any) => {
      if (session) setMeditationLast(session);
    }).catch(() => {});

    // Load MemMe config
    getMemmeConfig().then((config) => {
      if (config) setMemmeConfig(config);
    }).catch(() => {});
  }, []);

  const saveMeditationConfig = async (
    enabled = meditationEnabled,
    startTime = meditationStart,
    notifyOnComplete = meditationNotify,
  ) => {
    try {
      await invoke('save_meditation_config', {
        enabled,
        startTime,
        notifyOnComplete,
      });
    } catch (e) {
      console.error('Failed to save meditation config:', e);
    }
  };

  const handleTriggerMeditation = async () => {
    setMeditationTriggering(true);
    try {
      await invoke('trigger_meditation');
      toast.success(t('settings.meditationComplete'));
      // Refresh latest session
      const session: any = await invoke('get_latest_meditation');
      if (session) setMeditationLast(session);
    } catch (e) {
      console.error('Failed to trigger meditation:', e);
      toast.error(String(e));
    } finally {
      setMeditationTriggering(false);
    }
  };

  const loadFolders = () => {
    setFoldersLoading(true);
    listAuthorizedFolders()
      .then(setFolders)
      .catch(() => {})
      .finally(() => setFoldersLoading(false));
  };

  const loadPatterns = () => {
    setPatternsLoading(true);
    listSensitivePatterns()
      .then(setPatterns)
      .catch(() => {})
      .finally(() => setPatternsLoading(false));
  };

  useEffect(() => {
    if (activeTab === 'workspace') {
      loadFolders();
      loadPatterns();
    }
  }, [activeTab]);

  const handleAddFolder = async () => {
    try {
      const path = await pickFolder();
      if (!path) return;
      await addAuthorizedFolder(path);
      loadFolders();
    } catch (error) {
      toast.error(String(error));
    }
  };

  const handleTogglePermission = async (folder: AuthorizedFolder) => {
    const newPerm = folder.permission === 'read_write' ? 'read_only' : 'read_write';
    try {
      await updateAuthorizedFolder(folder.id, undefined, newPerm);
      loadFolders();
    } catch (error) {
      toast.error(String(error));
    }
  };

  const handleRemoveFolder = async (id: string) => {
    if (!confirm(t('settings.removeFolderConfirm'))) return;
    try {
      await removeAuthorizedFolder(id);
      loadFolders();
    } catch (error) {
      toast.error(String(error));
    }
  };

  const handleAddPattern = async () => {
    const trimmed = newPattern.trim();
    if (!trimmed) return;
    try {
      await addSensitivePattern(trimmed);
      setNewPattern('');
      loadPatterns();
    } catch (error) {
      toast.error(String(error));
    }
  };

  const handleTogglePattern = async (id: string, enabled: boolean) => {
    try {
      await toggleSensitivePattern(id, enabled);
      loadPatterns();
    } catch (error) {
      toast.error(String(error));
    }
  };

  const handleRemovePattern = async (id: string) => {
    try {
      await removeSensitivePattern(id);
      loadPatterns();
    } catch (error) {
      toast.error(String(error));
    }
  };

  const handleSaveWorkspace = async () => {
    const trimmed = editingPath.trim();
    if (!trimmed) return;
    try {
      await setUserWorkspace(trimmed);
      setWorkspacePath(trimmed);
      setIsEditing(false);
      setWorkspaceSaved(true);
      setTimeout(() => setWorkspaceSaved(false), 2000);
    } catch (error) {
      toast.error(String(error));
    }
  };

  const tabs: { id: SettingsTab; labelKey: string; icon: React.ComponentType<any> }[] = [
    { id: 'general', labelKey: 'settings.tabGeneral', icon: SlidersHorizontal },
    { id: 'models', labelKey: 'settings.tabModels', icon: Cpu },
    { id: 'environments', labelKey: 'settings.tabEnvs', icon: Key },
    { id: 'workspace', labelKey: 'settings.tabWorkspace', icon: Shield },
    { id: 'cli', labelKey: 'settings.tabCli', icon: FileText },
  ];

  return (
    <div className="h-full overflow-y-auto">
      <div className="w-full px-8 py-8">
        <PageHeader
          title={t('settings.title')}
          description={t('settings.description')}
        />

        {/* Tabs */}
        <div className="flex gap-1 mb-6 p-1 rounded-xl bg-[var(--color-bg-subtle)] w-fit">
          {tabs.map((tab) => {
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

        {/* Tab content */}
        {activeTab === 'general' && (
          <div className="space-y-4">
            {/* Workspace */}
            <div className="p-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
              <div className="flex items-center gap-2 mb-4">
                <FolderOpen size={18} className="text-[var(--color-primary)]" />
                <h2 className="font-semibold text-[14px]">{t('settings.workspace')}</h2>
              </div>

              <div className="p-3 rounded-xl">
                <div className="text-[13px] font-medium mb-1">{t('settings.workspaceDir')}</div>
                <div className="text-[12px] text-[var(--color-text-muted)] mb-3">{t('settings.workspaceDirDesc')}</div>
                {isEditing ? (
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={editingPath}
                      onChange={(e) => setEditingPath(e.target.value)}
                      className="flex-1 px-3 py-2 rounded-xl text-[13px] font-mono focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50"
                      style={{ background: 'var(--color-bg)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
                      autoFocus
                      onKeyDown={(e) => { if (e.key === 'Enter') handleSaveWorkspace(); if (e.key === 'Escape') { setIsEditing(false); setEditingPath(workspacePath); } }}
                      placeholder="/Users/you/Documents/YiYi"
                    />
                    <button
                      onClick={handleSaveWorkspace}
                      className="px-3.5 py-2 rounded-xl text-[13px] font-medium transition-colors"
                      style={{ background: 'var(--color-primary)', color: '#FFFFFF' }}
                    >
                      {t('common.save')}
                    </button>
                    <button
                      onClick={() => { setIsEditing(false); setEditingPath(workspacePath); }}
                      className="px-3 py-2 rounded-xl text-[13px] transition-colors"
                      style={{ color: 'var(--color-text-muted)' }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      {t('common.cancel')}
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <div
                      className="flex-1 px-3 py-2 rounded-xl text-[13px] font-mono truncate cursor-pointer"
                      style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-secondary)' }}
                      onClick={() => setIsEditing(true)}
                      title={workspacePath}
                    >
                      {workspacePath || '~/Documents/YiYi'}
                    </div>
                    <button
                      onClick={() => setIsEditing(true)}
                      className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[13px] font-medium transition-colors shrink-0"
                      style={{ background: 'var(--color-primary)', color: '#FFFFFF' }}
                    >
                      {workspaceSaved ? <Check size={14} /> : <FolderOpen size={14} />}
                      {t('settings.workspaceSelect')}
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Appearance */}
            <div className="p-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
              <div className="flex items-center gap-2 mb-4">
                <Palette size={18} className="text-[var(--color-primary)]" />
                <h2 className="font-semibold text-[14px]">{t('settings.appearance')}</h2>
              </div>

              <div className="space-y-1">
                {/* Language */}
                <div className="flex items-center justify-between p-3 rounded-xl hover:bg-[var(--color-bg-subtle)] transition-colors">
                  <div>
                    <div className="text-[13px] font-medium">{t('settings.language')}</div>
                    <div className="text-[12px] text-[var(--color-text-muted)]">{t('settings.languageDesc')}</div>
                  </div>
                  <LanguageSwitcher />
                </div>
              </div>
            </div>

            {/* Meditation */}
            <div className="p-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
              <div className="flex items-center gap-2 mb-1">
                <Brain size={18} className="text-[var(--color-primary)]" />
                <h2 className="font-semibold text-[14px]">{t('settings.meditation')}</h2>
              </div>
              <p className="text-[12px] text-[var(--color-text-muted)] mb-4 ml-[26px]">
                {t('settings.meditationDesc')}
              </p>

              <div className="space-y-3">
                {/* Enable toggle */}
                <div className="flex items-center justify-between p-3 rounded-xl hover:bg-[var(--color-bg-subtle)] transition-colors">
                  <div className="text-[13px] font-medium">{t('settings.meditationEnabled')}</div>
                  <button
                    onClick={() => {
                      const next = !meditationEnabled;
                      setMeditationEnabled(next);
                      saveMeditationConfig(next, meditationStart, meditationNotify);
                    }}
                    className="relative w-9 h-5 rounded-full transition-colors shrink-0"
                    style={{ background: meditationEnabled ? 'var(--color-success)' : 'var(--color-bg-muted)' }}
                  >
                    <div
                      className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform"
                      style={{ transform: meditationEnabled ? 'translateX(18px)' : 'translateX(2px)' }}
                    />
                  </button>
                </div>

                {meditationEnabled && (
                  <>
                    {/* Start time */}
                    <div className="flex items-center justify-between p-3 rounded-xl hover:bg-[var(--color-bg-subtle)] transition-colors">
                      <div className="text-[13px] font-medium">{t('settings.meditationStartTime')}</div>
                      <input
                        type="time"
                        value={meditationStart}
                        onChange={(e) => {
                          setMeditationStart(e.target.value);
                        }}
                        onBlur={() => saveMeditationConfig()}
                        className="px-3 py-1.5 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50"
                        style={{ background: 'var(--color-bg)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
                      />
                    </div>

                    {/* Notify toggle */}
                    <div className="flex items-center justify-between p-3 rounded-xl hover:bg-[var(--color-bg-subtle)] transition-colors">
                      <div className="text-[13px] font-medium">{t('settings.meditationNotify')}</div>
                      <button
                        onClick={() => {
                          const next = !meditationNotify;
                          setMeditationNotify(next);
                          saveMeditationConfig(meditationEnabled, meditationStart, next);
                        }}
                        className="relative w-9 h-5 rounded-full transition-colors shrink-0"
                        style={{ background: meditationNotify ? 'var(--color-success)' : 'var(--color-bg-muted)' }}
                      >
                        <div
                          className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform"
                          style={{ transform: meditationNotify ? 'translateX(18px)' : 'translateX(2px)' }}
                        />
                      </button>
                    </div>
                  </>
                )}

                {/* Last meditation session */}
                <div className="p-3 rounded-xl" style={{ background: 'var(--color-bg-subtle)' }}>
                  <div className="text-[12px] font-medium mb-2" style={{ color: 'var(--color-text-muted)' }}>
                    {t('settings.meditationLastSession')}
                  </div>
                  {meditationLast ? (
                    <div className="space-y-1">
                      <div className="text-[13px]" style={{ color: 'var(--color-text)' }}>
                        {meditationLast.date} &middot; {meditationLast.duration_minutes} min
                      </div>
                      <div className="text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>
                        {meditationLast.summary}
                      </div>
                      {meditationLast.journal_path && (
                        <button
                          className="flex items-center gap-1 mt-1 text-[12px] font-medium transition-colors"
                          style={{ color: 'var(--color-primary)' }}
                          onClick={() => {
                            // Navigate to workspace or open journal
                            invoke('open_path', { path: meditationLast.journal_path }).catch(() => {});
                          }}
                        >
                          <FileText size={12} />
                          {t('settings.meditationJournal')}
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
                      {t('settings.meditationNoSession')}
                    </div>
                  )}
                </div>

                {/* Trigger button */}
                <button
                  onClick={handleTriggerMeditation}
                  disabled={meditationTriggering}
                  className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-xl text-[13px] font-medium transition-colors disabled:opacity-50"
                  style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-primary)' }}
                  onMouseEnter={(e) => { if (!meditationTriggering) e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
                >
                  {meditationTriggering ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Play size={14} />
                  )}
                  {meditationTriggering ? t('settings.meditationRunning') : t('settings.meditationTrigger')}
                </button>
              </div>
            </div>

            {/* Memory Engine */}
            <div className="p-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
              <div className="mb-4">
                <h2 className="font-semibold text-[14px] mb-1">{t('settings.memoryTitle', '记忆引擎')}</h2>
                <p className="text-[12px] text-[var(--color-text-muted)]">
                  {t('settings.memoryDesc', '配置 MemMe 记忆引擎的 Embedding、知识图谱和遗忘曲线参数')}
                </p>
              </div>
              <div className="space-y-3">
                {/* Embedding Provider */}
                <div className="flex items-center justify-between">
                  <div className="text-[13px] font-medium">Embedding 提供商</div>
                  <select
                    value={memmeConfig?.embedding_provider ?? 'mock'}
                    onChange={async (e) => {
                      const next = { ...memmeConfig!, embedding_provider: e.target.value };
                      setMemmeConfig(next);
                      await saveMemmeConfigFull(next);
                    }}
                    className="text-[13px] px-2.5 py-1.5 rounded-lg"
                    style={{ background: 'var(--color-bg-muted)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
                  >
                    <option value="mock">Mock（默认，无语义搜索）</option>
                    <option value="openai">OpenAI</option>
                  </select>
                </div>
                {/* API Key (OpenAI only) */}
                {memmeConfig?.embedding_provider === 'openai' && (
                  <div className="flex items-center justify-between">
                    <div className="text-[13px] font-medium">Embedding API Key</div>
                    <input
                      type="password"
                      placeholder="留空则使用当前 LLM Provider 的 Key"
                      value={memmeConfig?.embedding_api_key ?? ''}
                      onChange={(e) => {
                        const next = { ...memmeConfig!, embedding_api_key: e.target.value };
                        setMemmeConfig(next);
                      }}
                      onBlur={async () => {
                        if (memmeConfig) await saveMemmeConfigFull(memmeConfig);
                      }}
                      className="text-[13px] px-2.5 py-1.5 rounded-lg w-[200px]"
                      style={{ background: 'var(--color-bg-muted)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
                    />
                  </div>
                )}
                {/* Embedding Model */}
                {memmeConfig?.embedding_provider !== 'mock' && (
                  <div className="flex items-center justify-between">
                    <div className="text-[13px] font-medium">Embedding 模型</div>
                    <select
                      value={memmeConfig?.embedding_model ?? 'text-embedding-3-small'}
                      onChange={async (e) => {
                        const dims = e.target.value.includes('large') ? 3072 : 1536;
                        const next = { ...memmeConfig!, embedding_model: e.target.value, embedding_dims: dims };
                        setMemmeConfig(next);
                        await saveMemmeConfigFull(next);
                      }}
                      className="text-[13px] px-2.5 py-1.5 rounded-lg"
                      style={{ background: 'var(--color-bg-muted)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
                    >
                      <option value="text-embedding-3-small">text-embedding-3-small (1536d)</option>
                      <option value="text-embedding-3-large">text-embedding-3-large (3072d)</option>
                    </select>
                  </div>
                )}
                {/* Knowledge Graph */}
                <div className="flex items-center justify-between">
                  <div className="text-[13px] font-medium">知识图谱</div>
                  <button
                    onClick={async () => {
                      const next = { ...memmeConfig!, enable_graph: !memmeConfig?.enable_graph };
                      setMemmeConfig(next);
                      await saveMemmeConfigFull(next);
                    }}
                    className="relative w-[40px] h-[22px] rounded-full transition-colors"
                    style={{ background: memmeConfig?.enable_graph ? 'var(--color-success)' : 'var(--color-bg-muted)' }}
                  >
                    <div className="absolute top-[2px] w-[18px] h-[18px] rounded-full bg-white shadow transition-transform"
                      style={{ transform: memmeConfig?.enable_graph ? 'translateX(18px)' : 'translateX(2px)' }} />
                  </button>
                </div>
                {/* Forgetting Curve */}
                <div className="flex items-center justify-between">
                  <div className="text-[13px] font-medium">遗忘曲线衰减</div>
                  <button
                    onClick={async () => {
                      const next = { ...memmeConfig!, enable_forgetting_curve: !memmeConfig?.enable_forgetting_curve };
                      setMemmeConfig(next);
                      await saveMemmeConfigFull(next);
                    }}
                    className="relative w-[40px] h-[22px] rounded-full transition-colors"
                    style={{ background: memmeConfig?.enable_forgetting_curve ? 'var(--color-success)' : 'var(--color-bg-muted)' }}
                  >
                    <div className="absolute top-[2px] w-[18px] h-[18px] rounded-full bg-white shadow transition-transform"
                      style={{ transform: memmeConfig?.enable_forgetting_curve ? 'translateX(18px)' : 'translateX(2px)' }} />
                  </button>
                </div>
                {/* Extraction Depth */}
                <div className="flex items-center justify-between">
                  <div className="text-[13px] font-medium">提取深度</div>
                  <select
                    value={memmeConfig?.extraction_depth ?? 'standard'}
                    onChange={async (e) => {
                      const next = { ...memmeConfig!, extraction_depth: e.target.value };
                      setMemmeConfig(next);
                      await saveMemmeConfigFull(next);
                    }}
                    className="text-[13px] px-2.5 py-1.5 rounded-lg"
                    style={{ background: 'var(--color-bg-muted)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
                  >
                    <option value="standard">标准</option>
                    <option value="thorough">深入</option>
                  </select>
                </div>
              </div>
            </div>

            {/* About & Update */}
            <div className="p-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="font-semibold text-[14px] mb-1">{t('settings.about')}</h2>
                  <p className="text-[12px] text-[var(--color-text-muted)]">YiYi v0.0.1</p>
                </div>
                <div className="text-[12px] text-[var(--color-text-muted)]">
                  © 2024 YiYi
                </div>
              </div>
              <UpdateChecker />
            </div>
          </div>
        )}

        {activeTab === 'models' && (
          <ModelsPage embedded />
        )}

        {activeTab === 'environments' && (
          <EnvironmentsPage embedded />
        )}

        {activeTab === 'workspace' && (
          <div className="space-y-4">
            {/* Authorized Folders */}
            <div className="p-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
              <div className="flex items-center gap-2 mb-1">
                <FolderOpen size={18} className="text-[var(--color-primary)]" />
                <h2 className="font-semibold text-[14px]">{t('settings.authorizedFolders')}</h2>
              </div>
              <p className="text-[12px] text-[var(--color-text-muted)] mb-4 ml-[26px]">
                {t('settings.authorizedFoldersDesc')}
              </p>

              {foldersLoading ? (
                <div className="py-8 text-center text-[13px] text-[var(--color-text-muted)]">
                  {t('common.loading')}
                </div>
              ) : (
                <div className="space-y-1">
                  {folders.map((folder) => {
                    const displayPath = folder.path.replace(/^\/Users\/[^/]+/, '~');
                    return (
                      <div
                        key={folder.id}
                        className="group flex items-center gap-3 p-3 rounded-xl hover:bg-[var(--color-bg-subtle)] transition-colors"
                      >
                        <FolderOpen size={16} className="text-[var(--color-primary)] shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-[13px] font-medium truncate" style={{ color: 'var(--color-text)' }}>
                              {folder.label || folder.path.split('/').pop() || folder.path}
                            </span>
                            {folder.is_default && (
                              <span
                                className="px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0"
                                style={{ background: 'var(--color-primary)', color: '#FFFFFF', opacity: 0.85 }}
                              >
                                {t('settings.default')}
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] font-mono truncate" style={{ color: 'var(--color-text-muted)' }}>
                            {displayPath}
                          </div>
                        </div>
                        <button
                          onClick={() => handleTogglePermission(folder)}
                          className="px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors shrink-0"
                          style={{
                            background: folder.permission === 'read_write' ? 'var(--color-success)' : 'var(--color-bg-subtle)',
                            color: folder.permission === 'read_write' ? '#FFFFFF' : 'var(--color-text-muted)',
                            opacity: folder.permission === 'read_write' ? 0.85 : 1,
                          }}
                        >
                          {folder.permission === 'read_write' ? t('settings.readWrite') : t('settings.readOnly')}
                        </button>
                        {!folder.is_default && (
                          <button
                            onClick={() => handleRemoveFolder(folder.id)}
                            className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg transition-all hover:bg-[var(--color-bg-muted)]"
                            style={{ color: 'var(--color-error)' }}
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              <button
                onClick={handleAddFolder}
                className="mt-3 flex items-center gap-2 px-4 py-2.5 rounded-xl text-[13px] font-medium transition-colors w-full justify-center"
                style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-primary)' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
              >
                <Plus size={15} />
                {t('settings.addFolder')}
              </button>
            </div>

            {/* Sensitive File Protection */}
            <div className="p-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
              <div className="flex items-center gap-2 mb-1">
                <Shield size={18} className="text-[var(--color-primary)]" />
                <h2 className="font-semibold text-[14px]">{t('settings.sensitiveFiles')}</h2>
              </div>
              <p className="text-[12px] text-[var(--color-text-muted)] mb-4 ml-[26px]">
                {t('settings.sensitiveFilesDesc')}
              </p>

              {patternsLoading ? (
                <div className="py-8 text-center text-[13px] text-[var(--color-text-muted)]">
                  {t('common.loading')}
                </div>
              ) : (
                <div className="space-y-1">
                  {patterns.map((pat) => (
                    <div
                      key={pat.id}
                      className="group flex items-center gap-3 p-3 rounded-xl hover:bg-[var(--color-bg-subtle)] transition-colors"
                    >
                      {pat.is_builtin ? (
                        <Lock size={14} className="shrink-0" style={{ color: 'var(--color-text-muted)' }} />
                      ) : (
                        <Unlock size={14} className="shrink-0" style={{ color: 'var(--color-text-muted)' }} />
                      )}
                      <code
                        className="flex-1 text-[13px] font-mono truncate"
                        style={{ color: 'var(--color-text)' }}
                      >
                        {pat.pattern}
                      </code>
                      <button
                        onClick={() => handleTogglePattern(pat.id, !pat.enabled)}
                        className="relative w-9 h-5 rounded-full transition-colors shrink-0"
                        style={{
                          background: pat.enabled ? 'var(--color-success)' : 'var(--color-bg-muted)',
                        }}
                      >
                        <div
                          className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform"
                          style={{
                            transform: pat.enabled ? 'translateX(18px)' : 'translateX(2px)',
                          }}
                        />
                      </button>
                      {pat.is_builtin ? (
                        <span
                          className="px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0"
                          style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-muted)' }}
                        >
                          {t('settings.builtin')}
                        </span>
                      ) : (
                        <button
                          onClick={() => handleRemovePattern(pat.id)}
                          className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg transition-all hover:bg-[var(--color-bg-muted)]"
                          style={{ color: 'var(--color-error)' }}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="mt-3 flex gap-2">
                <input
                  type="text"
                  value={newPattern}
                  onChange={(e) => setNewPattern(e.target.value)}
                  className="flex-1 px-3 py-2 rounded-xl text-[13px] font-mono focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50"
                  style={{ background: 'var(--color-bg)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
                  placeholder="**/*.secret"
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAddPattern(); }}
                />
                <button
                  onClick={handleAddPattern}
                  className="px-4 py-2 rounded-xl text-[13px] font-medium transition-colors shrink-0"
                  style={{ background: 'var(--color-primary)', color: '#FFFFFF' }}
                >
                  {t('settings.addPattern')}
                </button>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'cli' && (
          <CliProvidersSection />
        )}
      </div>
    </div>
  );
}

/** CLI Providers management section */
function CliProvidersSection() {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<CliProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [editCredentials, setEditCredentials] = useState<Record<string, string>>({});
  const [visibleCreds, setVisibleCreds] = useState<Set<string>>(new Set());
  const [showAddForm, setShowAddForm] = useState(false);
  const [newCredField, setNewCredField] = useState('');
  const [newProvider, setNewProvider] = useState({ key: '', binary: '', install_command: '', auth_command: '', check_command: '--version' });

  const load = async () => {
    setLoading(true);
    try {
      const data = await listCliProviders();
      setProviders(data);
    } catch (error) {
      console.error('Failed to load CLI providers:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleToggle = async (provider: CliProviderInfo) => {
    try {
      const { key, installed, ...config } = provider;
      await saveCliProviderConfig(key, { ...config, enabled: !provider.enabled });
      await load();
    } catch (error) {
      toast.error(String(error));
    }
  };

  const handleInstall = async (key: string) => {
    setInstalling(key);
    try {
      const result = await installCliProvider(key);
      toast.success(result);
      await load();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setInstalling(null);
    }
  };

  const handleExpand = (provider: CliProviderInfo) => {
    if (expandedKey === provider.key) {
      setExpandedKey(null);
    } else {
      setExpandedKey(provider.key);
      const creds = { ...provider.credentials };
      if (provider.key === 'feishu') {
        if (!('app_id' in creds)) creds['app_id'] = '';
        if (!('app_secret' in creds)) creds['app_secret'] = '';
      }
      setEditCredentials(creds);
    }
  };

  const handleSaveCredentials = async (provider: CliProviderInfo) => {
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(editCredentials)) {
      if (k.trim()) cleaned[k.trim()] = v;
    }
    try {
      const { key, installed, ...config } = provider;
      await saveCliProviderConfig(key, { ...config, credentials: cleaned });
      toast.success(t('common.saved') || 'Saved');
      await load();
      setExpandedKey(null);
    } catch (error) {
      toast.error(String(error));
    }
  };

  const handleCredChange = (field: string, value: string) => {
    setEditCredentials(prev => ({ ...prev, [field]: value }));
  };

  const handleRemoveCredField = (field: string) => {
    setEditCredentials(prev => {
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  const handleAddCredField = () => {
    const key = newCredField.trim();
    if (!key || key in editCredentials) return;
    setEditCredentials(prev => ({ ...prev, [key]: '' }));
    setNewCredField('');
  };

  const toggleCredVisibility = (field: string) => {
    const next = new Set(visibleCreds);
    if (next.has(field)) next.delete(field); else next.add(field);
    setVisibleCreds(next);
  };

  const handleDelete = async (key: string) => {
    if (!(await confirm(t('settings.cliDeleteConfirm', { name: key })))) return;
    try {
      await deleteCliProvider(key);
      await load();
    } catch (error) {
      toast.error(String(error));
    }
  };

  const handleAddProvider = async () => {
    const key = newProvider.key.trim();
    if (!key || !newProvider.binary.trim()) {
      toast.error(t('settings.cliKeyLabel') + ' & ' + t('settings.cliBinaryLabel') + ' required');
      return;
    }
    try {
      await saveCliProviderConfig(key, {
        enabled: false,
        binary: newProvider.binary.trim(),
        install_command: newProvider.install_command.trim(),
        auth_command: newProvider.auth_command.trim(),
        check_command: newProvider.check_command.trim() || '--version',
        credentials: {},
        auth_status: 'unknown',
      });
      setShowAddForm(false);
      setNewProvider({ key: '', binary: '', install_command: '', auth_command: '', check_command: '--version' });
      await load();
    } catch (error) {
      toast.error(String(error));
    }
  };

  const statusBadge = (provider: CliProviderInfo) => {
    if (!provider.installed) return null;
    const map: Record<string, { label: string; bg: string; color: string }> = {
      authenticated: {
        label: t('settings.cliAuthenticated'),
        bg: 'var(--color-success)',
        color: '#FFFFFF',
      },
      not_authenticated: {
        label: t('settings.cliNotAuthenticated'),
        bg: 'var(--color-bg-subtle)',
        color: 'var(--color-warning, var(--color-text-muted))',
      },
    };
    const info = map[provider.auth_status] || {
      label: t('settings.cliUnknown'),
      bg: 'var(--color-bg-subtle)',
      color: 'var(--color-text-muted)',
    };
    return (
      <span
        className="text-[10px] font-medium px-2 py-0.5 rounded-md"
        style={{ background: info.bg, color: info.color, opacity: provider.auth_status === 'authenticated' ? 0.85 : 1 }}
      >
        {info.label}
      </span>
    );
  };

  if (loading) {
    return (
      <div className="py-16 text-center text-[13px] text-[var(--color-text-muted)]">
        <Loader2 size={24} className="mx-auto mb-2 animate-spin" />
        {t('common.loading')}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Provider List */}
      <div className="p-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
        <div className="flex items-center gap-2 mb-1">
          <SlidersHorizontal size={18} className="text-[var(--color-primary)]" />
          <h2 className="font-semibold text-[14px]">{t('settings.cliTitle')}</h2>
        </div>
        <p className="text-[12px] text-[var(--color-text-muted)] mb-4 ml-[26px]">
          {t('settings.cliDesc')}
        </p>

        {providers.length === 0 && !showAddForm ? (
          <div className="py-10 text-center text-[13px] text-[var(--color-text-muted)]">
            {t('settings.cliNoProviders')}
          </div>
        ) : (
          <div className="space-y-1">
            {providers.map((provider) => (
              <div key={provider.key}>
                {/* Provider Row */}
                <div className="group flex items-center gap-3 p-3 rounded-xl hover:bg-[var(--color-bg-subtle)] transition-colors">
                  {/* Toggle */}
                  <button
                    onClick={() => handleToggle(provider)}
                    className="relative w-9 h-5 rounded-full transition-colors shrink-0"
                    style={{ background: provider.enabled ? 'var(--color-success)' : 'var(--color-bg-muted)' }}
                  >
                    <div
                      className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform"
                      style={{ transform: provider.enabled ? 'translateX(18px)' : 'translateX(2px)' }}
                    />
                  </button>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium" style={{ color: 'var(--color-text)' }}>
                        {provider.key}
                      </span>
                      {provider.installed ? (
                        <span
                          className="px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0"
                          style={{ background: 'var(--color-success)', color: '#FFFFFF', opacity: 0.85 }}
                        >
                          {t('settings.cliInstalled')}
                        </span>
                      ) : (
                        <span
                          className="px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0"
                          style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-muted)' }}
                        >
                          {t('settings.cliNotInstalled')}
                        </span>
                      )}
                      {statusBadge(provider)}
                    </div>
                    <div className="text-[11px] font-mono truncate" style={{ color: 'var(--color-text-muted)' }}>
                      {provider.binary}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 shrink-0">
                    {!provider.installed && (
                      <button
                        onClick={() => handleInstall(provider.key)}
                        disabled={installing === provider.key}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-colors disabled:opacity-50"
                        style={{ background: 'var(--color-primary)', color: '#FFFFFF' }}
                      >
                        {installing === provider.key
                          ? <><Loader2 size={12} className="animate-spin" /> {t('settings.cliInstalling')}</>
                          : <><Download size={12} /> {t('settings.cliInstall')}</>
                        }
                      </button>
                    )}
                    <button
                      onClick={() => handleExpand(provider)}
                      className={`p-1.5 rounded-lg transition-colors ${expandedKey === provider.key ? 'bg-[var(--color-bg-muted)]' : 'hover:bg-[var(--color-bg-muted)]'}`}
                      style={{ color: expandedKey === provider.key ? 'var(--color-primary)' : 'var(--color-text-secondary)' }}
                      title={t('settings.cliCredentials')}
                    >
                      <Key size={14} />
                    </button>
                    <button
                      onClick={() => handleDelete(provider.key)}
                      className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg transition-all hover:bg-[var(--color-bg-muted)]"
                      style={{ color: 'var(--color-error)' }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                {/* Expanded Credentials */}
                {expandedKey === provider.key && (
                  <div className="ml-12 mr-3 mb-2 p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]">
                    <div className="text-[12px] font-medium mb-1">{t('settings.cliCredentials')}</div>
                    <div className="text-[11px] text-[var(--color-text-muted)] mb-3">
                      {provider.key === 'feishu'
                        ? t('settings.cliCredentialsFeishuHint')
                        : t('settings.cliCredentialsHint')}
                    </div>

                    <div className="space-y-2">
                      {Object.keys(editCredentials).map((field) => (
                        <div key={field} className="flex gap-2 items-center">
                          <span className="w-28 px-2 py-1.5 rounded-lg text-[12px] font-mono truncate shrink-0" style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-muted)' }}>
                            {field}
                          </span>
                          <div className="flex-1 relative">
                            <input
                              type={visibleCreds.has(field) ? 'text' : 'password'}
                              value={editCredentials[field] || ''}
                              onChange={(e) => handleCredChange(field, e.target.value)}
                              className="w-full px-2 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[12px] font-mono pr-8 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50"
                            />
                            <button
                              onClick={() => toggleCredVisibility(field)}
                              className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors"
                            >
                              {visibleCreds.has(field) ? <EyeOff size={12} /> : <Eye size={12} />}
                            </button>
                          </div>
                          <button
                            onClick={() => handleRemoveCredField(field)}
                            className="p-1 rounded-lg hover:bg-[var(--color-bg-muted)] transition-colors"
                            style={{ color: 'var(--color-error)' }}
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      ))}
                    </div>

                    {/* Add credential field */}
                    <div className="mt-3 flex gap-2">
                      <input
                        type="text"
                        value={newCredField}
                        onChange={(e) => setNewCredField(e.target.value)}
                        className="flex-1 px-2 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[12px] font-mono focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50"
                        placeholder="field_name"
                        onKeyDown={(e) => { if (e.key === 'Enter') handleAddCredField(); }}
                      />
                      <button
                        onClick={handleAddCredField}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-colors"
                        style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-primary)' }}
                      >
                        <Plus size={12} /> {t('settings.cliAddCredField')}
                      </button>
                    </div>

                    <div className="flex justify-end mt-3">
                      <button
                        onClick={() => handleSaveCredentials(provider)}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-[12px] font-medium transition-colors"
                        style={{ background: 'var(--color-primary)', color: '#FFFFFF' }}
                      >
                        <Check size={12} /> {t('common.save') || t('common.saved') || 'Save'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Add provider button / form */}
        {showAddForm ? (
          <div className="mt-3 p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]">
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[11px] text-[var(--color-text-muted)] mb-1 block">{t('settings.cliKeyLabel')} *</label>
                  <input
                    type="text"
                    value={newProvider.key}
                    onChange={(e) => setNewProvider(p => ({ ...p, key: e.target.value }))}
                    placeholder="e.g. feishu"
                    className="w-full px-2.5 py-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[12px] font-mono focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50"
                  />
                </div>
                <div>
                  <label className="text-[11px] text-[var(--color-text-muted)] mb-1 block">{t('settings.cliBinaryLabel')} *</label>
                  <input
                    type="text"
                    value={newProvider.binary}
                    onChange={(e) => setNewProvider(p => ({ ...p, binary: e.target.value }))}
                    placeholder="e.g. lark-cli"
                    className="w-full px-2.5 py-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[12px] font-mono focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50"
                  />
                </div>
                <div>
                  <label className="text-[11px] text-[var(--color-text-muted)] mb-1 block">{t('settings.cliInstallCmdLabel')}</label>
                  <input
                    type="text"
                    value={newProvider.install_command}
                    onChange={(e) => setNewProvider(p => ({ ...p, install_command: e.target.value }))}
                    placeholder="e.g. npm install -g @larksuite/cli"
                    className="w-full px-2.5 py-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[12px] font-mono focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50"
                  />
                </div>
                <div>
                  <label className="text-[11px] text-[var(--color-text-muted)] mb-1 block">{t('settings.cliAuthCmdLabel')}</label>
                  <input
                    type="text"
                    value={newProvider.auth_command}
                    onChange={(e) => setNewProvider(p => ({ ...p, auth_command: e.target.value }))}
                    placeholder="e.g. auth login --recommend"
                    className="w-full px-2.5 py-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[12px] font-mono focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 mt-2">
                <button
                  onClick={() => { setShowAddForm(false); setNewProvider({ key: '', binary: '', install_command: '', auth_command: '', check_command: '--version' }); }}
                  className="px-3 py-1.5 rounded-lg text-[12px] font-medium hover:bg-[var(--color-bg-subtle)] transition-colors"
                >
                  {t('common.cancel') || 'Cancel'}
                </button>
                <button
                  onClick={handleAddProvider}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-[12px] font-medium transition-colors"
                  style={{ background: 'var(--color-primary)', color: '#FFFFFF' }}
                >
                  <Check size={12} /> {t('settings.cliAddProvider')}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowAddForm(true)}
            className="mt-3 flex items-center gap-2 px-4 py-2.5 rounded-xl text-[13px] font-medium transition-colors w-full justify-center"
            style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-primary)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
          >
            <Plus size={15} />
            {t('settings.cliAddProvider')}
          </button>
        )}
      </div>

      {/* Info Tip */}
      <div
        className="flex items-start gap-3 p-4 rounded-2xl border"
        style={{ background: 'var(--color-bg-subtle)', borderColor: 'var(--color-border)' }}
      >
        <Info size={16} className="mt-0.5 flex-shrink-0" style={{ color: 'var(--color-primary)' }} />
        <div className="text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>
          {t('settings.cliInfoTip')}
        </div>
      </div>
    </div>
  );
}
