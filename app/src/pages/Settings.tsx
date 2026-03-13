/**
 * Settings Page
 * Apple-inspired Design with Tabs
 */

import { useState, useEffect } from 'react';
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
} from 'lucide-react';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { PageHeader } from '../components/PageHeader';
import { ModelsPage } from './Models';
import { EnvironmentsPage } from './Environments';
import { getUserWorkspace, setUserWorkspace } from '../api/system';
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

type SettingsTab = 'general' | 'models' | 'environments' | 'workspace';

export function SettingsPage() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [workspacePath, setWorkspacePath] = useState('');
  const [editingPath, setEditingPath] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [workspaceSaved, setWorkspaceSaved] = useState(false);

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
    { id: 'environments', labelKey: 'settings.tabEnvs', icon: Key },
    { id: 'workspace', labelKey: 'settings.tabWorkspace', icon: Shield },
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
                      placeholder="/Users/you/Documents/YiYiClaw"
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
                      {workspacePath || '~/Documents/YiYiClaw'}
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

            {/* About */}
            <div className="p-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-semibold text-[14px] mb-1">{t('settings.about')}</h2>
                  <p className="text-[12px] text-[var(--color-text-muted)]">YiYiClaw v0.1.0</p>
                </div>
                <div className="text-[12px] text-[var(--color-text-muted)]">
                  © 2024 YiYiClaw
                </div>
              </div>
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
      </div>
    </div>
  );
}
