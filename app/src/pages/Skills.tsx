/**
 * Skills Management Page
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-shell';
import { CreateSkillModal } from './CreateSkillModal';
import {
  Puzzle,
  Plus,
  Download,
  RefreshCw,
  Search,
  Power,
  PowerOff,
  FileText,
  ExternalLink,
  Loader2,
  X,
  Pencil,
  Save,
  ShieldAlert,
  ShieldX,
} from 'lucide-react';
import { Select } from '../components/Select';
import { PageHeader } from '../components/PageHeader';
import { toast } from '../components/Toast';
import {
  listSkills,
  enableSkill,
  disableSkill,
  reloadSkills,
  importSkill,
  getSkillContent,
  updateSkill,
  hubSearchSkills,
  hubListSkills,
  hubInstallSkill,
  type Skill,
  type HubSkill,
} from '../api/skills';

type SourceFilter = 'all' | 'builtin' | 'customized' | 'hub' | 'openclaw';

export function SkillsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useTranslation();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [showEnabledOnly, setShowEnabledOnly] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [importUrl, setImportUrl] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [importing, setImporting] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [skillContent, setSkillContent] = useState<string>('');
  const [contentLoading, setContentLoading] = useState(false);
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const [showCreate, setShowCreate] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  // Hub browsing state
  const [hubSkills, setHubSkills] = useState<HubSkill[]>([]);
  const [hubLoading, setHubLoading] = useState(false);
  const [hubSearch, setHubSearch] = useState('');
  const [hubCursor, setHubCursor] = useState<string | null>(null);
  const [hubSort, setHubSort] = useState<string>('downloads');
  const [installingSlug, setInstallingSlug] = useState<string | null>(null);
  const [hubUrl, setHubUrl] = useState<string>('https://clawhub.ai');
  const [showHubSettings, setShowHubSettings] = useState(false);
  const [hubUrlDraft, setHubUrlDraft] = useState<string>('https://clawhub.ai');

  const getSourceLabel = (source: SourceFilter): string => {
    return t(`skills.sourceFilter.${source}` as any);
  };

  const loadSkills = async () => {
    setLoading(true);
    try {
      const data = await listSkills({
        source: sourceFilter === 'all' ? undefined : sourceFilter,
        enabledOnly: showEnabledOnly,
      });
      // Hide internal system skills from the UI
      const HIDDEN_SKILLS = ['auto_continue', 'task_proposer'];
      setSkills(data.filter((s: any) => !HIDDEN_SKILLS.includes(s.name)));
    } catch (error) {
      console.error('Failed to load skills:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadHubSkills = async (searchQuery?: string) => {
    setHubLoading(true);
    try {
      const url = hubUrl || undefined;
      if (searchQuery && searchQuery.trim()) {
        const results = await hubSearchSkills(searchQuery, 30, url);
        setHubSkills(results);
        setHubCursor(null);
      } else {
        const result = await hubListSkills(30, undefined, hubSort, url);
        setHubSkills(result.items);
        setHubCursor(result.nextCursor);
      }
    } catch (error) {
      console.error('Failed to load hub skills:', error);
      toast.error(`Hub: ${String(error)}`);
    } finally {
      setHubLoading(false);
    }
  };

  const loadMoreHubSkills = async () => {
    if (!hubCursor || hubLoading) return;
    setHubLoading(true);
    try {
      const url = hubUrl || undefined;
      const result = await hubListSkills(30, hubCursor, hubSort, url);
      setHubSkills(prev => [...prev, ...result.items]);
      setHubCursor(result.nextCursor);
    } catch (error) {
      console.error('Failed to load more hub skills:', error);
    } finally {
      setHubLoading(false);
    }
  };

  const handleHubInstall = async (skill: HubSkill) => {
    if (!skill.source_url) return;
    setInstallingSlug(skill.slug);
    try {
      const url = hubUrl || undefined;
      await hubInstallSkill(skill.source_url, { enable: true, overwrite: false, hubUrl: url });
      toast.success(`${skill.name} ${t('skills.toggleEnable')}`);
      await loadSkills();
    } catch (error) {
      console.error('Failed to install hub skill:', error);
      toast.error(`${t('skills.importFailed')}: ${String(error)}`);
    } finally {
      setInstallingSlug(null);
    }
  };

  useEffect(() => {
    if (sourceFilter === 'openclaw' || sourceFilter === 'hub') {
      loadHubSkills();
    }
  }, [sourceFilter, hubSort]);

  useEffect(() => {
    loadSkills();
  }, [sourceFilter, showEnabledOnly]);

  // Listen for skill changes from agent tool calls
  useEffect(() => {
    const unlisten = listen('skills://changed', () => {
      loadSkills();
    });
    return () => { unlisten.then(fn => fn()); };
  }, [sourceFilter, showEnabledOnly]);

  const handleToggle = async (skill: Skill) => {
    setToggling(prev => new Set(prev).add(skill.name));
    try {
      if (skill.enabled) {
        await disableSkill(skill.name);
      } else {
        await enableSkill(skill.name);
      }
      await loadSkills();
    } catch (error) {
      console.error('Failed to toggle skill:', error);
    } finally {
      setToggling(prev => {
        const next = new Set(prev);
        next.delete(skill.name);
        return next;
      });
    }
  };

  const handleReload = async () => {
    setReloading(true);
    try {
      await reloadSkills();
      await loadSkills();
    } catch (error) {
      console.error('Failed to reload skills:', error);
    } finally {
      setReloading(false);
    }
  };

  const handleImport = async () => {
    if (!importUrl.trim()) return;
    setImporting(true);
    try {
      await importSkill(importUrl);
      setImportUrl('');
      setShowImport(false);
      await loadSkills();
    } catch (error) {
      console.error('Failed to import skill:', error);
      toast.error(`${t('skills.importFailed')}: ${String(error)}`);
    } finally {
      setImporting(false);
    }
  };

  const handleViewContent = async (skill: Skill, editMode = false) => {
    setSelectedSkill(skill);
    setContentLoading(true);
    setIsEditing(false);
    try {
      const content = await getSkillContent(skill.name);
      setSkillContent(content);
      if (editMode) {
        setEditContent(content);
        setIsEditing(true);
      }
    } catch (error) {
      console.error('Failed to load skill content:', error);
      setSkillContent('Failed to load content');
    } finally {
      setContentLoading(false);
    }
  };

  const handleStartEdit = () => {
    setIsEditing(true);
    setEditContent(skillContent);
  };

  const handleSaveEdit = async () => {
    if (!selectedSkill) return;
    setSaving(true);
    try {
      await updateSkill(selectedSkill.name, editContent);
      setSkillContent(editContent);
      setIsEditing(false);
      toast.success(t('skills.saveSuccess'));
      await loadSkills();
    } catch (error) {
      console.error('Failed to save skill:', error);
      toast.error(`${t('skills.saveFailed')}: ${String(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleCloseContent = () => {
    setSelectedSkill(null);
    setSkillContent('');
    setIsEditing(false);
    setEditContent('');
  };

  /** Get localized description for a skill: use i18n key for builtins, fallback to frontmatter */
  const getSkillDescription = (skill: Skill): string => {
    if (skill.source === 'builtin') {
      const key = `skills.skillDesc.${skill.name}` as any;
      const localized = t(key);
      if (localized !== key) return localized;
    }
    return skill.description || '';
  };

  const filteredSkills = skills.filter(skill => {
    const desc = getSkillDescription(skill);
    return skill.name.toLowerCase().includes(search.toLowerCase()) ||
      desc.toLowerCase().includes(search.toLowerCase());
  });

  return (
    <div className={embedded ? '' : 'h-full overflow-y-auto'}>
      <div className={embedded ? 'w-full px-8 py-4' : 'w-full px-8 py-8'}>

        {!embedded && <PageHeader
          title={t('skills.title')}
          description={t('skills.description')}
          actions={<>
            <button
              onClick={handleReload}
              disabled={reloading}
              className="w-9 h-9 flex items-center justify-center rounded-xl transition-colors disabled:opacity-50"
              style={{ color: 'var(--color-text-secondary)' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-elevated)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              title={t('skills.reload')}
            >
              <RefreshCw size={16} className={reloading ? 'animate-spin' : ''} />
            </button>
            <button
              onClick={() => setShowImport(true)}
              className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-[13px] font-medium transition-colors"
              style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-text)' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-bg-elevated)'; }}
            >
              <Download size={15} />
              {t('skills.import')}
            </button>
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-[13px] font-medium transition-all"
              style={{ background: 'var(--color-primary)', color: '#FFFFFF' }}
            >
              <Plus size={15} />
              {t('skills.create')}
            </button>
          </>}
        />}

        {/* Filters + actions (single row) */}
        <div className="flex items-center gap-3 mb-6">
          <div className="relative flex-1 max-w-xs">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--color-text-tertiary)' }} />
            <input
              type="text"
              value={(sourceFilter === 'openclaw' || sourceFilter === 'hub') ? hubSearch : search}
              onChange={(e) => {
                if (sourceFilter === 'openclaw' || sourceFilter === 'hub') {
                  setHubSearch(e.target.value);
                } else {
                  setSearch(e.target.value);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (sourceFilter === 'openclaw' || sourceFilter === 'hub')) {
                  loadHubSkills(hubSearch);
                }
              }}
              placeholder={(sourceFilter === 'openclaw' || sourceFilter === 'hub')
                ? t('skills.hubSearchPlaceholder')
                : t('skills.searchPlaceholder')}
              className="w-full pl-9 pr-4 py-2 rounded-xl text-[13px]"
              style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-text)' }}
            />
          </div>
          <Select
            value={sourceFilter}
            onChange={(v) => setSourceFilter(v as SourceFilter)}
            options={(['all', 'builtin', 'customized', 'hub', 'openclaw'] as SourceFilter[]).map((value) => ({
              value,
              label: getSourceLabel(value),
            }))}
            variant="inline"
          />
          {(sourceFilter === 'openclaw' || sourceFilter === 'hub') ? (
            <>
              <Select
                value={hubSort}
                onChange={(v) => setHubSort(v)}
                options={[
                  { value: 'downloads', label: t('skills.hubSortDownloads') },
                  { value: 'updated', label: t('skills.hubSortUpdated') },
                  { value: 'stars', label: t('skills.hubSortStars') },
                  { value: 'trending', label: t('skills.hubSortTrending') },
                ]}
                variant="inline"
              />
              <div className="relative">
                <button
                  onClick={() => { setShowHubSettings(!showHubSettings); setHubUrlDraft(hubUrl); }}
                  className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors"
                  style={{ color: 'var(--color-text-tertiary)' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-elevated)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  title="Hub Settings"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                </button>
                {showHubSettings && (
                  <div
                    className="absolute right-0 top-10 z-50 p-3 rounded-xl shadow-lg min-w-[320px]"
                    style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)' }}
                  >
                    <label className="block text-[11px] font-medium mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
                      Hub URL
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={hubUrlDraft}
                        onChange={(e) => setHubUrlDraft(e.target.value)}
                        placeholder="https://clawhub.ai"
                        className="flex-1 px-2.5 py-1.5 rounded-lg text-[12px]"
                        style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text)' }}
                      />
                      <button
                        onClick={() => {
                          setHubUrl(hubUrlDraft.trim() || 'https://clawhub.ai');
                          setShowHubSettings(false);
                          setHubSkills([]);
                          setHubCursor(null);
                          setTimeout(() => loadHubSkills(), 100);
                        }}
                        className="px-3 py-1.5 rounded-lg text-[12px] font-medium"
                        style={{ background: 'var(--color-primary)', color: '#FFFFFF' }}
                      >
                        {t('common.save')}
                      </button>
                    </div>
                    <p className="text-[10px] mt-1.5" style={{ color: 'var(--color-text-muted)' }}>
                      ClawHub: https://clawhub.ai
                    </p>
                  </div>
                )}
              </div>
            </>
          ) : (
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showEnabledOnly}
                onChange={(e) => setShowEnabledOnly(e.target.checked)}
                className="accent-[var(--color-primary)] w-3.5 h-3.5"
              />
              <span className="text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>{t('skills.enabledOnly')}</span>
            </label>
          )}

          {/* Action buttons (embedded mode: inline with filters; standalone: in PageHeader) */}
          {embedded && (
            <div className="flex items-center gap-2 ml-auto shrink-0">
              <button onClick={handleReload} disabled={reloading}
                className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors"
                style={{ color: 'var(--color-text-muted)' }}>
                <RefreshCw size={14} className={reloading ? 'animate-spin' : ''} />
              </button>
              <button onClick={() => setShowImport(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium"
                style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-text)' }}>
                <Download size={13} /> {t('skills.import')}
              </button>
              <button onClick={() => setShowCreate(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium"
                style={{ background: 'var(--color-primary)', color: '#fff' }}>
                <Plus size={13} /> {t('skills.create')}
              </button>
            </div>
          )}
        </div>

        {/* Skills grid — local skills or hub browsing */}
        {(sourceFilter === 'openclaw' || sourceFilter === 'hub') ? (
          /* Hub / OpenClaw browsing view */
          hubLoading && hubSkills.length === 0 ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 size={28} className="animate-spin" style={{ color: 'var(--color-primary)' }} />
            </div>
          ) : hubSkills.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 rounded-2xl" style={{ background: 'var(--color-bg-elevated)' }}>
              <Puzzle size={40} className="mb-3" style={{ color: 'var(--color-text-muted)' }} />
              <p className="text-[14px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                {t('skills.hubEmpty')}
              </p>
              <p className="text-[12px] mt-1" style={{ color: 'var(--color-text-muted)' }}>
                {t('skills.hubEmptyHint')}
              </p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {hubSkills.map((hs) => (
                  <div
                    key={hs.slug}
                    className="group p-3.5 rounded-xl transition-all duration-200 hover:-translate-y-0.5"
                    style={{ background: 'var(--color-bg-elevated)' }}
                  >
                    {/* Header */}
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <div
                          className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                          style={{ background: 'var(--color-bg-subtle)' }}
                        >
                          <Puzzle size={14} style={{ color: 'var(--color-text-tertiary)' }} />
                        </div>
                        <div className="min-w-0">
                          <h3 className="font-semibold text-[13px] truncate" style={{ color: 'var(--color-text)' }}>{hs.name || hs.slug}</h3>
                          <p className="text-[10px] truncate" style={{ color: 'var(--color-text-muted)' }}>{hs.slug}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {hs.security_verdict === 'suspicious' && (
                          <span title={t('skills.securitySuspicious')}>
                            <ShieldAlert size={14} style={{ color: 'var(--color-warning, #f59e0b)' }} />
                          </span>
                        )}
                        {hs.security_verdict === 'malicious' && (
                          <span title={t('skills.securityMalicious')}>
                            <ShieldX size={14} style={{ color: 'var(--color-danger, #ef4444)' }} />
                          </span>
                        )}
                        <button
                          onClick={() => handleHubInstall(hs)}
                          disabled={installingSlug === hs.slug || hs.security_verdict === 'malicious'}
                          className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium transition-colors"
                          style={{
                            background: hs.security_verdict === 'malicious' ? 'var(--color-bg-subtle)' : 'var(--color-primary)',
                            color: hs.security_verdict === 'malicious' ? 'var(--color-text-muted)' : '#FFFFFF',
                            cursor: hs.security_verdict === 'malicious' ? 'not-allowed' : undefined,
                          }}
                        >
                          {installingSlug === hs.slug ? (
                            <Loader2 size={11} className="animate-spin" />
                          ) : (
                            <Download size={11} />
                          )}
                          {t('skills.hubInstall')}
                        </button>
                      </div>
                    </div>

                    {/* Description */}
                    <p className="text-[12px] leading-relaxed line-clamp-2 mb-2" style={{ color: 'var(--color-text-secondary)' }}>
                      {hs.description}
                    </p>

                    {/* Requires */}
                    {hs.requires && (hs.requires.env?.length || hs.requires.bins?.length) ? (
                      <div className="flex flex-wrap gap-1 mb-2">
                        {hs.requires.env?.map((v) => (
                          <span
                            key={`env-${v}`}
                            className="px-1.5 py-0.5 text-[10px] rounded"
                            style={{ background: 'rgba(59,130,246,0.1)', color: 'var(--color-text-secondary)' }}
                            title={t('skills.requiresEnv')}
                          >
                            ${v}
                          </span>
                        ))}
                        {hs.requires.bins?.map((v) => (
                          <span
                            key={`bin-${v}`}
                            className="px-1.5 py-0.5 text-[10px] rounded"
                            style={{ background: 'rgba(168,85,247,0.1)', color: 'var(--color-text-secondary)' }}
                            title={t('skills.requiresBin')}
                          >
                            {v}
                          </span>
                        ))}
                      </div>
                    ) : null}

                    {/* Tags */}
                    {hs.tags && hs.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mb-2">
                        {(hs.tags as string[]).slice(0, 3).map((tag: string) => (
                          <span
                            key={tag}
                            className="px-1.5 py-0.5 text-[10px] rounded"
                            style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-tertiary)' }}
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Footer */}
                    <div className="flex items-center justify-between pt-2" style={{ borderTop: '1px solid var(--color-bg-subtle)' }}>
                      <div className="flex items-center gap-2 text-[10px]" style={{ color: 'var(--color-text-tertiary)' }}>
                        {hs.author && <span>{hs.author}</span>}
                        {hs.version && <span>v{hs.version}</span>}
                      </div>
                      <div className="flex items-center gap-0.5">
                        {hs.source_url && (
                          <button
                            onClick={() => open(hs.source_url!)}
                            className="w-6 h-6 flex items-center justify-center rounded-md transition-colors"
                            style={{ color: 'var(--color-text-tertiary)' }}
                            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-bg-subtle)'; }}
                            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                          >
                            <ExternalLink size={11} />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              {/* Load more */}
              {hubCursor && (
                <div className="flex justify-center mt-4">
                  <button
                    onClick={loadMoreHubSkills}
                    disabled={hubLoading}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl text-[13px] font-medium transition-colors"
                    style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-text-secondary)' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-bg-elevated)'; }}
                  >
                    {hubLoading && <Loader2 size={14} className="animate-spin" />}
                    {t('skills.hubLoadMore')}
                  </button>
                </div>
              )}
            </>
          )
        ) : (
          /* Local skills view */
          loading ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 size={28} className="animate-spin" style={{ color: 'var(--color-primary)' }} />
            </div>
          ) : filteredSkills.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 rounded-2xl" style={{ background: 'var(--color-bg-elevated)' }}>
              <Puzzle size={40} className="mb-3" style={{ color: 'var(--color-text-muted)' }} />
              <p className="text-[14px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>{t('skills.noSkills')}</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {filteredSkills.map((skill) => (
                <div
                  key={skill.name}
                  className="group p-3.5 rounded-xl transition-all duration-200 hover:-translate-y-0.5"
                  style={{ background: 'var(--color-bg-elevated)' }}
                >
                  {/* Header */}
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2 min-w-0">
                      {skill.emoji ? (
                        <span className="text-lg shrink-0">{skill.emoji}</span>
                      ) : (
                        <div
                          className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                          style={{ background: 'var(--color-bg-subtle)' }}
                        >
                          <Puzzle size={14} style={{ color: 'var(--color-text-tertiary)' }} />
                        </div>
                      )}
                      <div className="min-w-0">
                        <h3 className="font-semibold text-[13px] truncate" style={{ color: 'var(--color-text)' }}>{skill.name}</h3>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {skill.system ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded font-medium" style={{ color: 'var(--color-primary)', background: 'rgba(var(--color-primary-rgb, 99, 102, 241), 0.1)' }}>
                          {t('skills.system')}
                        </span>
                      ) : (
                        <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: 'var(--color-text-muted)', background: 'var(--color-bg-subtle)' }}>
                          {getSourceLabel(skill.source || 'builtin')}
                        </span>
                      )}
                      {!skill.system && (
                        <button
                          onClick={() => handleToggle(skill)}
                          disabled={toggling.has(skill.name)}
                          className="w-6 h-6 rounded-md flex items-center justify-center transition-colors"
                          style={{
                            background: skill.enabled ? 'rgba(74, 222, 128, 0.1)' : 'var(--color-bg-subtle)',
                            color: skill.enabled ? 'var(--color-success)' : 'var(--color-text-tertiary)',
                          }}
                          title={skill.enabled ? t('skills.toggleDisable') : t('skills.toggleEnable')}
                        >
                          {toggling.has(skill.name) ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : skill.enabled ? (
                            <Power size={12} />
                          ) : (
                            <PowerOff size={12} />
                          )}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Description */}
                  <p className="text-[12px] leading-relaxed line-clamp-2 mb-2" style={{ color: 'var(--color-text-secondary)' }}>
                    {getSkillDescription(skill)}
                  </p>

                  {/* Tags */}
                  {skill.tags && skill.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-2">
                      {skill.tags.slice(0, 3).map((tag) => (
                        <span
                          key={tag}
                          className="px-1.5 py-0.5 text-[10px] rounded"
                          style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-tertiary)' }}
                        >
                          {tag}
                        </span>
                      ))}
                      {skill.tags.length > 3 && (
                        <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
                          +{skill.tags.length - 3}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Footer */}
                  <div className="flex items-center justify-between pt-2" style={{ borderTop: '1px solid var(--color-bg-subtle)' }}>
                    <div className="flex items-center gap-2 text-[10px]" style={{ color: 'var(--color-text-tertiary)' }}>
                      {skill.author && <span>{skill.author}</span>}
                      {skill.version && <span>v{skill.version}</span>}
                    </div>
                    <div className="flex items-center gap-0.5">
                      <button
                        onClick={() => handleViewContent(skill)}
                        className="w-6 h-6 flex items-center justify-center rounded-md transition-colors"
                        style={{ color: 'var(--color-text-tertiary)' }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                        title={t('skills.viewContent')}
                      >
                        <FileText size={12} />
                      </button>
                      {!skill.system && (
                        <button
                          onClick={() => handleViewContent(skill, true)}
                          className="w-6 h-6 flex items-center justify-center rounded-md transition-colors"
                          style={{ color: 'var(--color-text-tertiary)' }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                          title={t('common.edit')}
                        >
                          <Pencil size={11} />
                        </button>
                      )}
                      {skill.url && (
                        <button
                          onClick={() => open(skill.url!)}
                          className="w-6 h-6 flex items-center justify-center rounded-md transition-colors"
                          style={{ color: 'var(--color-text-tertiary)' }}
                          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-bg-subtle)'; }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                        >
                          <ExternalLink size={11} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )
        )}
      </div>

      {/* Import Modal */}
      {showImport && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 animate-fade-in">
          <div className="rounded-2xl p-6 w-full max-w-md animate-scale-in" style={{ background: 'var(--color-bg-elevated)' }}>
            <h2 className="text-lg font-bold mb-1" style={{ fontFamily: 'var(--font-display)' }}>
              {t('skills.importTitle')}
            </h2>
            <p className="text-[13px] mb-5 leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
              {t('skills.importDesc')}
            </p>
            <input
              type="text"
              value={importUrl}
              onChange={(e) => setImportUrl(e.target.value)}
              placeholder={t('skills.importPlaceholder')}
              className="w-full mb-5 rounded-xl"
              style={{ background: 'var(--color-bg-subtle)' }}
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setShowImport(false); setImportUrl(''); }}
                className="px-4 py-2 text-[13px] font-medium rounded-xl transition-colors"
                style={{ color: 'var(--color-text-secondary)' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleImport}
                disabled={importing || !importUrl.trim()}
                className="px-4 py-2 text-[13px] font-medium rounded-xl disabled:opacity-50 transition-all flex items-center gap-2"
                style={{ background: 'var(--color-primary)', color: '#FFFFFF' }}
              >
                {importing && <Loader2 size={14} className="animate-spin" />}
                {importing ? t('skills.importing') : t('skills.import')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Content Modal */}
      {selectedSkill && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 animate-fade-in">
          <div className="rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col animate-scale-in" style={{ background: 'var(--color-bg-elevated)' }}>
            <div className="flex items-center justify-between gap-3 p-5">
              <div className="flex items-center gap-3 min-w-0 flex-1">
                {selectedSkill.emoji && <span className="text-2xl shrink-0">{selectedSkill.emoji}</span>}
                <div className="min-w-0">
                  <h2 className="font-bold text-[16px] truncate" style={{ fontFamily: 'var(--font-display)' }}>
                    {selectedSkill.name}
                  </h2>
                  <p className="text-[12px] truncate" style={{ color: 'var(--color-text-secondary)' }}>{selectedSkill.description}</p>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {!isEditing ? (
                  <button
                    onClick={handleStartEdit}
                    className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors"
                    style={{ color: 'var(--color-text-tertiary)' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                    title={t('common.edit')}
                  >
                    <Pencil size={14} />
                  </button>
                ) : (
                  <button
                    onClick={handleSaveEdit}
                    disabled={saving}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors"
                    style={{ background: 'var(--color-primary)', color: '#FFFFFF' }}
                    title={t('common.save')}
                  >
                    {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                    {t('common.save')}
                  </button>
                )}
                <button
                  onClick={handleCloseContent}
                  className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors"
                  style={{ color: 'var(--color-text-tertiary)' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <X size={16} />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-5 pb-5">
              {contentLoading ? (
                <div className="flex items-center justify-center h-32">
                  <Loader2 size={24} className="animate-spin" style={{ color: 'var(--color-primary)' }} />
                  <span className="ml-3 text-[13px]" style={{ color: 'var(--color-text-secondary)' }}>
                    {t('skills.loadingContent')}
                  </span>
                </div>
              ) : isEditing ? (
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  className="w-full h-full min-h-[400px] text-[13px] p-4 rounded-xl leading-relaxed resize-none focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30"
                  style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text)', fontFamily: 'var(--font-mono)' }}
                  spellCheck={false}
                />
              ) : (
                <pre
                  className="text-[13px] p-4 rounded-xl overflow-x-auto whitespace-pre-wrap leading-relaxed"
                  style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text)', fontFamily: 'var(--font-mono)' }}
                >
                  {skillContent}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Create Modal */}
      {showCreate && (
        <CreateSkillModal
          onClose={() => setShowCreate(false)}
          onSuccess={async () => { await loadSkills(); }}
        />
      )}
    </div>
  );
}
