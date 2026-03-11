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
} from 'lucide-react';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { PageHeader } from '../components/PageHeader';
import { ModelsPage } from './Models';
import { EnvironmentsPage } from './Environments';
import { getUserWorkspace, setUserWorkspace } from '../api/system';
import { toast } from '../components/Toast';

type SettingsTab = 'general' | 'models' | 'environments';

export function SettingsPage() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [workspacePath, setWorkspacePath] = useState('');
  const [editingPath, setEditingPath] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [workspaceSaved, setWorkspaceSaved] = useState(false);

  useEffect(() => {
    getUserWorkspace().then((p) => {
      setWorkspacePath(p);
      setEditingPath(p);
    }).catch(() => {});
  }, []);

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
                      placeholder="/Users/you/Documents/YiClaw"
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
                      {workspacePath || '~/Documents/YiClaw'}
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
                  <p className="text-[12px] text-[var(--color-text-muted)]">YiClaw v0.1.0</p>
                </div>
                <div className="text-[12px] text-[var(--color-text-muted)]">
                  © 2024 YiClaw
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
      </div>
    </div>
  );
}
