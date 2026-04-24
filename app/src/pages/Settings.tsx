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
  FileText,
  BarChart3,
  Eye,
  EyeOff,
  Info,
  Database,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { PageHeader } from '../components/PageHeader';
import { Select } from '../components/Select';
import { ModelsPage } from './Models';
import { EnvironmentsPage } from './Environments';
import { getUserWorkspace, setUserWorkspace, getMemmeConfig, saveMemmeConfig, type MemmeConfig } from '../api/system';
import { getActiveLlm, listProviders, type ActiveModelsInfo } from '../api/models';
import { exportConversations, exportMemories, exportSettings } from '../api/export';
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
import { UsagePanel } from '../components/UsagePanel';

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

type SettingsTab = 'general' | 'buddy' | 'models' | 'memory' | 'environments' | 'workspace' | 'cli' | 'plugins' | 'agents' | 'usage';

const VALID_TABS: SettingsTab[] = ['general', 'buddy', 'models', 'environments', 'workspace', 'cli', 'plugins', 'agents', 'usage'];

export function SettingsPage() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');

  // Accept tab hints from tray-menu navigation (App.tsx dispatches settings:set-tab)
  useEffect(() => {
    const handler = (e: Event) => {
      const tab = (e as CustomEvent).detail as string | undefined;
      if (tab && (VALID_TABS as string[]).includes(tab)) {
        setActiveTab(tab as SettingsTab);
      }
    };
    window.addEventListener('settings:set-tab', handler);
    return () => window.removeEventListener('settings:set-tab', handler);
  }, []);
  const [workspacePath, setWorkspacePath] = useState('');
  const [editingPath, setEditingPath] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [workspaceSaved, setWorkspaceSaved] = useState(false);

  // Export state
  const [exportingConversations, setExportingConversations] = useState(false);
  const [exportingMemories, setExportingMemories] = useState(false);

  // Memory engine config state
  const [memmeConfig, setMemmeConfigState] = useState<MemmeConfig | null>(null);
  const [memmeConfigSaved, setMemmeConfigSaved] = useState<MemmeConfig | null>(null); // last-saved snapshot for dirty check
  const [memmeSaving, setMemmeSaving] = useState<boolean>(false);
  const [activeLlmInfo, setActiveLlmInfo] = useState<ActiveModelsInfo | null>(null);
  useEffect(() => {
    if (activeTab === 'memory') {
      Promise.all([getMemmeConfig(), getActiveLlm()]).then(([cfg, active]) => {
        setActiveLlmInfo(active);
        if (!cfg) return;
        setMemmeConfigState(cfg);
        setMemmeConfigSaved(cfg);
      }).catch(() => {});
    }
  }, [activeTab]);

  const llmKeys: (keyof MemmeConfig)[] = ['memory_llm_base_url', 'memory_llm_api_key', 'memory_llm_model'];

  const llmDirty = !!(memmeConfig && memmeConfigSaved &&
    llmKeys.some(k => (memmeConfig as any)[k] !== (memmeConfigSaved as any)[k]));

  const handleSaveMemmeLlm = async () => {
    if (!memmeConfig || !memmeConfigSaved) return;
    setMemmeSaving(true);
    try {
      const patch: MemmeConfig = { ...memmeConfigSaved };
      for (const k of llmKeys) {
        (patch as any)[k] = (memmeConfig as any)[k];
      }
      const result = await saveMemmeConfig(patch);
      setMemmeConfigSaved(patch);
      if (result?.warning) {
        toast.error(result.warning);
      } else {
        toast.success('已保存');
      }
    } catch (e) {
      console.error(e);
      toast.error('保存失败: ' + String(e));
    } finally { setMemmeSaving(false); }
  };

  const memoryPresets: Record<string, { label: string; chatUrl: string; llmModel: string }> = {
    'dashscope':    { label: '阿里云通义', chatUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', llmModel: 'qwen-turbo' },
    'coding-plan':  { label: '阿里云百炼', chatUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', llmModel: 'qwen-turbo' },
    'openai':       { label: 'OpenAI',    chatUrl: 'https://api.openai.com/v1/chat/completions',                          llmModel: 'gpt-4o-mini' },
    'zhipu':        { label: '智谱 AI',   chatUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',                llmModel: 'glm-4-flash' },
  };
  const activePreset = activeLlmInfo?.provider_id ? memoryPresets[activeLlmInfo.provider_id] : undefined;

  const applyMemoryPreset = async () => {
    if (!activePreset || !memmeConfig) return;
    const next: MemmeConfig = {
      ...memmeConfig,
      memory_llm_base_url: activePreset.chatUrl,
      memory_llm_api_key: '',
      memory_llm_model: activePreset.llmModel,
    };
    setMemmeConfigState(next);
    setMemmeSaving(true);
    try {
      await saveMemmeConfig(next);
      setMemmeConfigSaved(next);
      toast.success(`已填入并保存：${activePreset.llmModel}`);
    } catch (e) {
      toast.error('保存失败：' + String(e));
    } finally {
      setMemmeSaving(false);
    }
  };

  const presetAlreadyApplied = !!(activePreset && memmeConfig &&
    memmeConfig.memory_llm_base_url === activePreset.chatUrl &&
    memmeConfig.memory_llm_model === activePreset.llmModel);

  // Read pending tab from sessionStorage on mount (set by BuddyPanel before navigating here)
  useEffect(() => {
    const pending = sessionStorage.getItem('settings_pending_tab');
    if (pending) {
      sessionStorage.removeItem('settings_pending_tab');
      setActiveTab(pending as SettingsTab);
    }
  }, []);
  const [exportingSettings, setExportingSettings] = useState(false);
  const [lastExportPath, setLastExportPath] = useState<string | null>(null);

  const revealExportFile = async (filePath: string) => {
    try {
      // Open the containing folder (cross-platform)
      const dir = filePath.substring(0, filePath.lastIndexOf('/'));
      const { open } = await import('@tauri-apps/plugin-shell');
      await open(dir);
    } catch { /* ignore */ }
  };

  const handleExportConversations = async (format: 'markdown' | 'json') => {
    setExportingConversations(true);
    try {
      const path = await exportConversations(format);
      setLastExportPath(path);
      toast.success('导出成功');
    } catch (e) {
      toast.error('导出失败: ' + String(e));
    } finally {
      setExportingConversations(false);
    }
  };

  const handleExportMemories = async () => {
    setExportingMemories(true);
    try {
      const path = await exportMemories();
      setLastExportPath(path);
      toast.success('导出成功');
    } catch (e) {
      toast.error('导出失败: ' + String(e));
    } finally {
      setExportingMemories(false);
    }
  };

  const handleExportSettings = async () => {
    setExportingSettings(true);
    try {
      const path = await exportSettings();
      setLastExportPath(path);
      toast.success('导出成功');
    } catch (e) {
      toast.error('导出失败: ' + String(e));
    } finally {
      setExportingSettings(false);
    }
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
  }, []);

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
    { id: 'memory', labelKey: 'settings.tabMemory', icon: Database },
    { id: 'environments', labelKey: 'settings.tabEnvs', icon: Key },
    { id: 'workspace', labelKey: 'settings.tabWorkspace', icon: Shield },
    { id: 'cli', labelKey: 'settings.tabCli', icon: FileText },
    { id: 'usage', labelKey: 'settings.tabUsage', icon: BarChart3 },
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

            {/* Data Export */}
            <div className="p-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
              <div className="flex items-center gap-2 mb-1">
                <Download size={18} className="text-[var(--color-primary)]" />
                <h2 className="font-semibold text-[14px]">{t('settings.exportTitle', '数据导出')}</h2>
              </div>
              <p className="text-[12px] text-[var(--color-text-muted)] mb-4 ml-[26px]">
                导出数据到 ~/Documents/YiYi/exports/
              </p>

              <div className="space-y-2">
                {/* Export conversations */}
                <div className="flex items-center justify-between p-3 rounded-xl hover:bg-[var(--color-bg-subtle)] transition-colors">
                  <div>
                    <div className="text-[13px] font-medium">{t('settings.exportConversations', '导出对话')}</div>
                    <div className="text-[12px] text-[var(--color-text-muted)]">
                      {t('settings.exportConversationsDesc', '导出所有聊天会话和消息')}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleExportConversations('markdown')}
                      disabled={exportingConversations}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors disabled:opacity-50"
                      style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text)' }}
                      onMouseEnter={(e) => { if (!exportingConversations) e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
                    >
                      {exportingConversations ? <Loader2 size={12} className="animate-spin" /> : <FileText size={12} />}
                      Markdown
                    </button>
                    <button
                      onClick={() => handleExportConversations('json')}
                      disabled={exportingConversations}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors disabled:opacity-50"
                      style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text)' }}
                      onMouseEnter={(e) => { if (!exportingConversations) e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
                    >
                      {exportingConversations ? <Loader2 size={12} className="animate-spin" /> : <FileText size={12} />}
                      JSON
                    </button>
                  </div>
                </div>

                {/* Export memories */}
                <div className="flex items-center justify-between p-3 rounded-xl hover:bg-[var(--color-bg-subtle)] transition-colors">
                  <div>
                    <div className="text-[13px] font-medium">{t('settings.exportMemories', '导出记忆')}</div>
                    <div className="text-[12px] text-[var(--color-text-muted)]">
                      {t('settings.exportMemoriesDesc', '导出 MemMe 记忆引擎中的所有记忆')}
                    </div>
                  </div>
                  <button
                    onClick={handleExportMemories}
                    disabled={exportingMemories}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors disabled:opacity-50"
                    style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text)' }}
                    onMouseEnter={(e) => { if (!exportingMemories) e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
                  >
                    {exportingMemories ? <Loader2 size={12} className="animate-spin" /> : <Brain size={12} />}
                    JSON
                  </button>
                </div>

                {/* Export settings */}
                <div className="flex items-center justify-between p-3 rounded-xl hover:bg-[var(--color-bg-subtle)] transition-colors">
                  <div>
                    <div className="text-[13px] font-medium">{t('settings.exportSettings', '导出设置')}</div>
                    <div className="text-[12px] text-[var(--color-text-muted)]">
                      {t('settings.exportSettingsDesc', '导出应用设置（不含 API 密钥）')}
                    </div>
                  </div>
                  <button
                    onClick={handleExportSettings}
                    disabled={exportingSettings}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors disabled:opacity-50"
                    style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text)' }}
                    onMouseEnter={(e) => { if (!exportingSettings) e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
                  >
                    {exportingSettings ? <Loader2 size={12} className="animate-spin" /> : <SlidersHorizontal size={12} />}
                    JSON
                  </button>
                </div>

                {/* Last export path + open folder */}
                {lastExportPath && (
                  <div className="flex items-center gap-2 mt-3 p-2.5 rounded-lg" style={{ background: 'var(--color-bg-subtle)' }}>
                    <CheckCircle size={14} style={{ color: 'var(--color-primary)', flexShrink: 0 }} />
                    <span className="text-[11px] truncate flex-1" style={{ color: 'var(--color-text-muted)' }}>
                      {lastExportPath.split('/').slice(-2).join('/')}
                    </span>
                    <button
                      onClick={() => revealExportFile(lastExportPath)}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium whitespace-nowrap transition-colors"
                      style={{ background: 'var(--color-primary)', color: '#fff' }}
                    >
                      <FolderOpen size={12} />
                      打开文件夹
                    </button>
                  </div>
                )}
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

        {activeTab === 'memory' && (
          <div className="space-y-4">
            <div className="p-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
              <div className="flex items-center gap-2 mb-4">
                <Cpu size={18} className="text-[var(--color-primary)]" />
                <h2 className="font-semibold text-[14px]">向量化模型 (Embedding)</h2>
              </div>
              <div className="ml-[26px] space-y-2">
                <div className="text-[13px]">
                  <span className="text-[var(--color-text-muted)]">模型：</span>
                  <span className="font-mono font-medium">bge-small-zh-v1.5</span>
                  <span className="text-[var(--color-text-muted)] ml-2">· 512 维 · 本地 ONNX</span>
                </div>
                <p className="text-[12px] leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
                  记忆向量化已内置，完全离线运行、无 API 费用。首次启动会自动下载约 100MB 的模型文件到 <span className="font-mono">~/.yiyi/models/</span>。
                </p>
              </div>
            </div>

            {/* Memory LLM model — dedicated cheap model for background memory ops */}
            <div className="p-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
              <div className="flex items-center gap-2 mb-2">
                <Brain size={18} className="text-[var(--color-primary)]" />
                <h2 className="font-semibold text-[14px]">语言模型</h2>
              </div>
              <p className="text-[12px] text-[var(--color-text-muted)] mb-3 ml-[26px] leading-relaxed">
                用于记忆提取、冥想分析、知识图谱构建等后台任务。
              </p>

              {/* Cost warning */}
              <div className="mb-4 ml-[26px] p-3 rounded-xl flex items-start gap-2.5" style={{ background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)' }}>
                <AlertCircle size={14} className="shrink-0 mt-0.5" style={{ color: 'var(--color-warning)' }} />
                <div className="text-[12px] leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
                  <div className="font-medium mb-0.5" style={{ color: 'var(--color-text)' }}>为什么需要单独配置？</div>
                  记忆操作在后台频繁运行（每次对话后提取、每晚冥想、知识图谱构建）。如果用主模型（Claude Opus、GPT-4 等），API 成本会显著增加。建议在这里配置一个便宜快速的模型（如 GPT-4o-mini、DeepSeek、Qwen-Turbo）专门给记忆用。
                </div>
              </div>

              {activePreset && (
                <div className="mb-4 ml-[26px] p-3 rounded-xl flex items-start gap-2.5" style={{ background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)' }}>
                  <Info size={14} className="shrink-0 mt-0.5" style={{ color: 'var(--color-primary)' }} />
                  <div className="flex-1 min-w-0 text-[12px] leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
                    <div className="font-medium mb-0.5" style={{ color: 'var(--color-text)' }}>
                      你的主模型是 <span style={{ color: 'var(--color-primary)' }}>{activePreset.label}</span>
                    </div>
                    一键填入它旗下便宜的 <span className="font-mono">{activePreset.llmModel}</span>，API Key 自动复用主模型的。
                  </div>
                  <button
                    onClick={applyMemoryPreset}
                    disabled={memmeSaving || presetAlreadyApplied}
                    className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium text-white disabled:cursor-not-allowed"
                    style={{ background: presetAlreadyApplied ? 'var(--color-text-muted)' : 'var(--color-primary)', opacity: presetAlreadyApplied ? 0.6 : 1 }}
                  >
                    {memmeSaving && <Loader2 size={12} className="animate-spin" />}
                    {presetAlreadyApplied ? '已填入' : '一键填入'}
                  </button>
                </div>
              )}

              <div className="space-y-3 p-3 rounded-xl">
                {[
                  { key: 'memory_llm_base_url', label: 'API 完整地址', placeholder: 'https://api.openai.com/v1/chat/completions', type: 'text' },
                  { key: 'memory_llm_api_key', label: 'API Key', placeholder: '留空则使用主模型的 Key', type: 'password' },
                  { key: 'memory_llm_model', label: '模型名称', placeholder: 'gpt-4o-mini', type: 'text' },
                ].map(field => (
                  <div key={field.key} className="flex items-center justify-between">
                    <div className="text-[13px] font-medium">{field.label}</div>
                    <input type={field.type} placeholder={field.placeholder}
                      value={(memmeConfig as any)?.[field.key] ?? ''}
                      onChange={e => setMemmeConfigState({ ...memmeConfig!, [field.key]: e.target.value })}
                      className="text-[13px] px-3 py-2 rounded-xl w-[280px]"
                      style={{ background: 'var(--color-bg-muted)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }} />
                  </div>
                ))}
              </div>

              {/* Status hint */}
              <div className="mt-3 ml-[26px] text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                {(memmeConfig?.memory_llm_model && memmeConfig?.memory_llm_api_key)
                  ? <>✓ 当前使用独立模型 <span className="font-medium" style={{ color: 'var(--color-success)' }}>{memmeConfig.memory_llm_model}</span> 处理记忆</>
                  : <>留空则使用主模型（在 <span className="font-medium" style={{ color: 'var(--color-primary)' }}>模型</span> 标签配置）</>}
              </div>

              {/* Per-card save */}
              <div className="flex items-center justify-end gap-3 mt-4">
                {llmDirty && (
                  <span className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>有未保存的修改</span>
                )}
                <button
                  onClick={handleSaveMemmeLlm}
                  onMouseDown={(e) => e.preventDefault()}
                  disabled={!llmDirty || memmeSaving}
                  className="flex items-center justify-center gap-2 px-5 py-2 rounded-xl text-[13px] font-medium text-white disabled:opacity-40 min-w-[88px]"
                  style={{ background: 'var(--color-primary)', boxShadow: 'none' }}>
                  {memmeSaving && <Loader2 size={14} className="animate-spin" />}
                  保存
                </button>
              </div>
            </div>
          </div>
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

        {activeTab === 'usage' && (
          <UsagePanel />
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
