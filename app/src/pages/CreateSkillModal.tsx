/**
 * Create Custom Skill Modal
 * Swiss Minimalism · Clean · Precise
 * Supports AI-assisted generation
 */

import { useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Plus, Trash2, FileText, Code, Loader2, Puzzle, Sparkles, Send } from 'lucide-react';
import { createSkill, generateSkillAI } from '../api/skills';
import { toast } from '../components/Toast';

interface ReferenceFile {
  name: string;
  content: string;
}

interface ScriptFile {
  name: string;
  content: string;
}

interface CreateSkillModalProps {
  onClose: () => void;
  onSuccess: () => void;
}

/** Parse YAML frontmatter from generated SKILL.md content */
function parseGeneratedSkill(content: string) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)/);
  if (!match) return { name: '', description: '', emoji: '', tags: [] as string[], author: '', version: '1.0.0', instructions: content };

  const yaml = match[1];
  const instructions = match[2].trim();

  const get = (key: string): string => {
    const m = yaml.match(new RegExp(`^${key}:\\s*"?([^"\\n]*)"?`, 'm'));
    return m ? m[1].trim().replace(/^"|"$/g, '') : '';
  };

  const emojiMatch = yaml.match(/"emoji":\s*"([^"]+)"/);
  const tagsMatch = yaml.match(/tags:\s*\n((?:\s+-\s+.+\n?)*)/);
  const tags = tagsMatch
    ? tagsMatch[1].split('\n').map(l => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean)
    : [];

  return {
    name: get('name'),
    description: get('description'),
    emoji: emojiMatch ? emojiMatch[1] : '',
    tags,
    author: get('author'),
    version: get('version') || '1.0.0',
    instructions,
  };
}

export function CreateSkillModal({ onClose, onSuccess }: CreateSkillModalProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [emoji, setEmoji] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [author, setAuthor] = useState('');
  const [version, setVersion] = useState('1.0.0');
  const [instructions, setInstructions] = useState('');

  const [references, setReferences] = useState<ReferenceFile[]>([]);
  const [scripts, setScripts] = useState<ScriptFile[]>([]);

  const [activeTab, setActiveTab] = useState<'ai' | 'content' | 'references' | 'scripts'>('ai');
  const [saving, setSaving] = useState(false);

  // AI generation state
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiPreview, setAiPreview] = useState('');
  const [aiDone, setAiDone] = useState(false);
  const unlistenRef = useRef<(() => void) | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Add tag
  const handleAddTag = () => {
    const tag = tagInput.trim();
    if (tag && !tags.includes(tag)) {
      setTags([...tags, tag]);
      setTagInput('');
    }
  };

  // Remove tag
  const handleRemoveTag = (tag: string) => {
    setTags(tags.filter(t => t !== tag));
  };

  // Add reference file
  const handleAddReference = () => {
    setReferences([...references, { name: `doc${references.length + 1}.md`, content: '' }]);
  };

  // Update reference file
  const handleUpdateReference = (index: number, content: string) => {
    const updated = [...references];
    updated[index].content = content;
    setReferences(updated);
  };

  // Remove reference file
  const handleRemoveReference = (index: number) => {
    setReferences(references.filter((_, i) => i !== index));
  };

  // Add script file
  const handleAddScript = () => {
    setScripts([...scripts, { name: `script${scripts.length + 1}.py`, content: '' }]);
  };

  // Update script file
  const handleUpdateScript = (index: number, content: string) => {
    const updated = [...scripts];
    updated[index].content = content;
    setScripts(updated);
  };

  // Remove script file
  const handleRemoveScript = (index: number) => {
    setScripts(scripts.filter((_, i) => i !== index));
  };

  // Generate SKILL.md content
  const generateSkillContent = (): string => {
    let content = '---\n';
    content += `name: ${name}\n`;
    content += `description: "${description}"\n`;
    if (author) content += `author: ${author}\n`;
    if (version) content += `version: ${version}\n`;
    if (tags.length > 0) content += `tags:\n${tags.map(t => `  - ${t}`).join('\n')}\n`;
    content += 'metadata:\n';
    content += '  {\n';
    content += '    "yiyiclaw":\n';
    content += '      {\n';
    content += `        "emoji": "${emoji || '🔧'}",\n`;
    content += '        "requires": {}\n';
    content += '      }\n';
    content += '  }\n';
    content += '---\n\n';
    content += instructions;
    return content;
  };

  // AI generate skill
  const handleAIGenerate = useCallback(async () => {
    if (!aiPrompt.trim()) {
      toast.info(t('skills.aiDescribeFirst'));
      return;
    }

    setAiGenerating(true);
    setAiPreview('');
    setAiDone(false);

    try {
      const unlisten = await generateSkillAI(
        aiPrompt,
        (chunk) => {
          setAiPreview(prev => prev + chunk);
        },
        (fullContent) => {
          setAiGenerating(false);
          setAiDone(true);
          // Parse and fill form fields
          const parsed = parseGeneratedSkill(fullContent);
          setName(parsed.name);
          setDescription(parsed.description);
          setEmoji(parsed.emoji);
          setTags(parsed.tags);
          setAuthor(parsed.author);
          setVersion(parsed.version);
          setInstructions(parsed.instructions);
        },
        (error) => {
          setAiGenerating(false);
          toast.error(`${t('skills.aiGenerateFailed')}: ${error}`);
        },
      );
      unlistenRef.current = unlisten;
    } catch (error) {
      setAiGenerating(false);
      toast.error(`${t('skills.aiGenerateFailed')}: ${String(error)}`);
    }
  }, [aiPrompt, t]);

  // Apply AI result to form and switch to manual tab
  const handleApplyAIResult = useCallback(() => {
    setActiveTab('content');
  }, []);

  // Save
  const handleSave = async () => {
    if (!name.trim() || !description.trim() || !instructions.trim()) {
      toast.info(t('skills.fillRequiredFields'));
      return;
    }

    setSaving(true);
    try {
      const content = generateSkillContent();

      // Build reference files object
      const referencesObj: Record<string, string> = {};
      references.forEach(ref => {
        if (ref.name && ref.content) {
          referencesObj[ref.name] = ref.content;
        }
      });

      // Build script files object
      const scriptsObj: Record<string, string> = {};
      scripts.forEach(script => {
        if (script.name && script.content) {
          scriptsObj[script.name] = script.content;
        }
      });

      await createSkill(name, content, referencesObj, scriptsObj);

      onSuccess();
      onClose();
    } catch (error) {
      console.error('Failed to create skill:', error);
      toast.error(`${t('skills.createFailed')}: ${String(error)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-fade-in">
      <div className="bg-[var(--color-bg-elevated)] rounded-3xl w-full max-w-4xl max-h-[90vh] shadow-2xl border border-[var(--color-border)] flex flex-col animate-slide-up">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[var(--color-primary)]/20 to-[var(--color-primary)]/10 flex items-center justify-center shadow-lg">
              <Puzzle className="text-[var(--color-primary)]" size={24} />
            </div>
            <h2 className="font-semibold text-[17px] tracking-tight" style={{ fontFamily: 'var(--font-display)' }}>{t('skills.createCustomSkill')}</h2>
          </div>
          <button
            onClick={onClose}
            className="p-2.5 hover:bg-[var(--color-bg-muted)] rounded-xl transition-all"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden flex flex-col">
          {/* Tabs */}
          <div className="flex border-b border-[var(--color-border)]">
            <button
              onClick={() => setActiveTab('ai')}
              className={`px-6 py-4 text-[14px] font-medium transition-colors border-b-2 flex items-center gap-2 ${
                activeTab === 'ai'
                  ? 'text-[var(--color-primary)] border-[var(--color-primary)]'
                  : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text)] border-transparent'
              }`}
            >
              <Sparkles size={15} />
              {t('skills.aiGenerate')}
            </button>
            <button
              onClick={() => setActiveTab('content')}
              className={`px-6 py-4 text-[14px] font-medium transition-colors border-b-2 ${
                activeTab === 'content'
                  ? 'text-[var(--color-primary)] border-[var(--color-primary)]'
                  : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text)] border-transparent'
              }`}
            >
              {t('skills.basicInfo')}
            </button>
            <button
              onClick={() => setActiveTab('references')}
              className={`px-6 py-4 text-[14px] font-medium transition-colors border-b-2 ${
                activeTab === 'references'
                  ? 'text-[var(--color-primary)] border-[var(--color-primary)]'
                  : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text)] border-transparent'
              }`}
            >
              {t('skills.referenceFiles')} ({references.length})
            </button>
            <button
              onClick={() => setActiveTab('scripts')}
              className={`px-6 py-4 text-[14px] font-medium transition-colors border-b-2 ${
                activeTab === 'scripts'
                  ? 'text-[var(--color-primary)] border-[var(--color-primary)]'
                  : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text)] border-transparent'
              }`}
            >
              {t('skills.scriptFiles')} ({scripts.length})
            </button>
          </div>

          {/* Tab Content */}
          <div className="flex-1 overflow-y-auto p-6">
            {/* AI Generate Tab */}
            {activeTab === 'ai' && (
              <div className="space-y-5 max-w-3xl">
                {/* AI Description Input */}
                <div>
                  <label className="block text-[14px] font-medium mb-2 text-[var(--color-text)]">
                    {t('skills.aiDescribeSkill')}
                  </label>
                  <div className="relative">
                    <textarea
                      value={aiPrompt}
                      onChange={(e) => setAiPrompt(e.target.value)}
                      placeholder={t('skills.aiPlaceholder')}
                      rows={4}
                      disabled={aiGenerating}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !aiGenerating) {
                          handleAIGenerate();
                        }
                      }}
                      className="w-full resize-none px-4 py-3 pr-14 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] focus:outline-none focus:ring-4 focus:ring-[var(--color-primary-subtle)] text-[14px] disabled:opacity-60"
                    />
                    <button
                      onClick={handleAIGenerate}
                      disabled={aiGenerating || !aiPrompt.trim()}
                      className="absolute right-3 bottom-3 p-2.5 bg-gradient-to-br from-[var(--color-primary)] to-[var(--color-primary-hover)] text-white rounded-xl disabled:opacity-40 transition-all hover:shadow-lg hover:-translate-y-0.5 disabled:hover:translate-y-0"
                    >
                      {aiGenerating ? (
                        <Loader2 size={18} className="animate-spin" />
                      ) : (
                        <Send size={18} />
                      )}
                    </button>
                  </div>
                  <p className="text-[13px] text-[var(--color-text-muted)] mt-2">
                    {t('skills.aiHint')}
                  </p>
                </div>

                {/* AI Preview */}
                {(aiPreview || aiGenerating) && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-[14px] font-medium text-[var(--color-text)]">
                        <Sparkles size={15} className="text-[var(--color-primary)]" />
                        {t('skills.aiPreview')}
                        {aiGenerating && (
                          <span className="text-[var(--color-text-muted)] font-normal text-[13px]">
                            {t('skills.aiGenerating')}
                          </span>
                        )}
                      </div>
                      {aiDone && (
                        <button
                          onClick={handleApplyAIResult}
                          className="flex items-center gap-2 px-4 py-2 bg-gradient-to-br from-[var(--color-primary)] to-[var(--color-primary-hover)] hover:shadow-lg text-white rounded-xl text-[13px] font-medium transition-all shadow-md hover:-translate-y-0.5"
                        >
                          {t('skills.aiApplyAndEdit')}
                        </button>
                      )}
                    </div>
                    <div className="relative rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] overflow-hidden">
                      <pre className="p-4 text-[13px] font-mono whitespace-pre-wrap break-words max-h-[400px] overflow-y-auto leading-relaxed text-[var(--color-text-secondary)]">
                        {aiPreview}
                        {aiGenerating && <span className="inline-block w-2 h-4 bg-[var(--color-primary)] animate-pulse ml-0.5 rounded-sm" />}
                      </pre>
                    </div>
                  </div>
                )}

                {/* Empty state */}
                {!aiPreview && !aiGenerating && (
                  <div className="text-center py-12 text-[var(--color-text-muted)]">
                    <Sparkles size={48} className="mx-auto mb-4 opacity-20" />
                    <p className="font-medium text-[15px]">{t('skills.aiEmptyTitle')}</p>
                    <p className="text-[14px] mt-1">{t('skills.aiEmptyDesc')}</p>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'content' && (
              <div className="space-y-5 max-w-2xl">
                {/* Name */}
                <div>
                  <label className="block text-[14px] font-medium mb-2 text-[var(--color-text)]">
                    {t('skills.name')} <span className="text-[var(--color-error)]">*</span>
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t('skills.namePlaceholder')}
                    className="w-full px-4 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] focus:outline-none focus:ring-4 focus:ring-[var(--color-primary-subtle)] font-mono text-[14px]"
                  />
                  <p className="text-[13px] text-[var(--color-text-muted)] mt-1.5">
                    {t('skills.nameHint')}
                  </p>
                </div>

                {/* Description */}
                <div>
                  <label className="block text-[14px] font-medium mb-2 text-[var(--color-text)]">
                    {t('skills.description')} <span className="text-[var(--color-error)]">*</span>
                  </label>
                  <input
                    type="text"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={t('skills.descriptionPlaceholder')}
                    className="w-full px-4 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] focus:outline-none focus:ring-4 focus:ring-[var(--color-primary-subtle)] text-[14px]"
                  />
                </div>

                {/* Emoji */}
                <div>
                  <label className="block text-[14px] font-medium mb-2 text-[var(--color-text)]">{t('skills.emojiOptional')}</label>
                  <input
                    type="text"
                    value={emoji}
                    onChange={(e) => setEmoji(e.target.value)}
                    placeholder={t('skills.emojiPlaceholder')}
                    className="w-28 px-4 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] focus:outline-none focus:ring-4 focus:ring-[var(--color-primary-subtle)] text-[14px]"
                  />
                </div>

                {/* Tags */}
                <div>
                  <label className="block text-[14px] font-medium mb-2 text-[var(--color-text)]">{t('skills.tags')}</label>
                  <div className="flex gap-3 mb-4">
                    <input
                      type="text"
                      value={tagInput}
                      onChange={(e) => setTagInput(e.target.value)}
                      onKeyPress={(e) => e.key === 'Enter' && handleAddTag()}
                      placeholder={t('skills.addTagPlaceholder')}
                      className="flex-1 px-4 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] focus:outline-none focus:ring-4 focus:ring-[var(--color-primary-subtle)] text-[14px]"
                    />
                    <button
                      onClick={handleAddTag}
                      className="px-5 py-2.5 bg-[var(--color-bg-muted)] hover:bg-[var(--color-border)] rounded-xl text-[14px] font-medium transition-all hover:shadow-md"
                    >
                      {t('skills.addTag')}
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {tags.map((tag) => (
                      <span
                        key={tag}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[var(--color-bg-muted)] rounded-xl text-[14px] shadow-sm"
                      >
                        {tag}
                        <button
                          onClick={() => handleRemoveTag(tag)}
                          className="hover:text-[var(--color-error)] transition-colors"
                        >
                          <X size={14} />
                        </button>
                      </span>
                    ))}
                  </div>
                </div>

                {/* Author */}
                <div>
                  <label className="block text-[14px] font-medium mb-2 text-[var(--color-text)]">{t('skills.authorOptional')}</label>
                  <input
                    type="text"
                    value={author}
                    onChange={(e) => setAuthor(e.target.value)}
                    placeholder={t('skills.authorPlaceholder')}
                    className="w-full px-4 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] focus:outline-none focus:ring-4 focus:ring-[var(--color-primary-subtle)] text-[14px]"
                  />
                </div>

                {/* Version */}
                <div>
                  <label className="block text-[14px] font-medium mb-2 text-[var(--color-text)]">{t('skills.version')}</label>
                  <input
                    type="text"
                    value={version}
                    onChange={(e) => setVersion(e.target.value)}
                    placeholder={t('skills.versionPlaceholder')}
                    className="w-36 px-4 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] focus:outline-none focus:ring-4 focus:ring-[var(--color-primary-subtle)] font-mono text-[14px]"
                  />
                </div>

                {/* Instructions */}
                <div>
                  <label className="block text-[14px] font-medium mb-2 text-[var(--color-text)]">
                    {t('skills.instructions')} <span className="text-[var(--color-error)]">*</span>
                  </label>
                  <textarea
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    placeholder={t('skills.instructionsPlaceholder')}
                    rows={10}
                    className="w-full resize-none px-4 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] focus:outline-none focus:ring-4 focus:ring-[var(--color-primary-subtle)] font-mono text-[14px]"
                  />
                  <p className="text-[13px] text-[var(--color-text-muted)] mt-1.5">
                    {t('skills.instructionsHint')}
                  </p>
                </div>
              </div>
            )}

            {activeTab === 'references' && (
              <div className="space-y-5">
                <div className="flex justify-between items-center">
                  <p className="text-[14px] text-[var(--color-text-secondary)]">
                    {t('skills.referenceFilesHint')}
                  </p>
                  <button
                    onClick={handleAddReference}
                    className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-br from-[var(--color-primary)] to-[var(--color-primary-hover)] hover:shadow-lg text-white rounded-xl text-[14px] font-medium transition-all shadow-md hover:-translate-y-0.5"
                  >
                    <Plus size={16} />
                    {t('skills.addFile')}
                  </button>
                </div>

                {references.length === 0 ? (
                  <div className="text-center py-16 text-[var(--color-text-muted)]">
                    <FileText size={48} className="mx-auto mb-4 opacity-30" />
                    <p className="font-medium text-[15px]">{t('skills.noReferenceFiles')}</p>
                    <p className="text-[14px] mt-1">{t('skills.noReferenceFilesDesc')}</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {references.map((ref, idx) => (
                      <div key={idx} className="p-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] shadow-sm hover:shadow-md transition-shadow">
                        <div className="flex justify-between items-center mb-4">
                          <input
                            type="text"
                            value={ref.name}
                            onChange={(e) => {
                              const updated = [...references];
                              updated[idx].name = e.target.value;
                              setReferences(updated);
                            }}
                            className="px-4 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[14px] font-medium font-mono focus:outline-none focus:ring-4 focus:ring-[var(--color-primary-subtle)]"
                          />
                          <button
                            onClick={() => handleRemoveReference(idx)}
                            className="p-2.5 hover:bg-[var(--color-error)]/10 text-[var(--color-error)] rounded-xl transition-all"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                        <textarea
                          value={ref.content}
                          onChange={(e) => handleUpdateReference(idx, e.target.value)}
                          placeholder={t('skills.fileContentPlaceholder')}
                          rows={6}
                          className="w-full resize-none px-4 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] focus:outline-none focus:ring-4 focus:ring-[var(--color-primary-subtle)] font-mono text-[14px]"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'scripts' && (
              <div className="space-y-5">
                <div className="flex justify-between items-center">
                  <p className="text-[14px] text-[var(--color-text-secondary)]">
                    {t('skills.scriptFilesHint')}
                  </p>
                  <button
                    onClick={handleAddScript}
                    className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-br from-[var(--color-primary)] to-[var(--color-primary-hover)] hover:shadow-lg text-white rounded-xl text-[14px] font-medium transition-all shadow-md hover:-translate-y-0.5"
                  >
                    <Plus size={16} />
                    {t('skills.addScript')}
                  </button>
                </div>

                {scripts.length === 0 ? (
                  <div className="text-center py-16 text-[var(--color-text-muted)]">
                    <Code size={48} className="mx-auto mb-4 opacity-30" />
                    <p className="font-medium text-[15px]">{t('skills.noScriptFiles')}</p>
                    <p className="text-[14px] mt-1">{t('skills.noScriptFilesDesc')}</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {scripts.map((script, idx) => (
                      <div key={idx} className="p-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] shadow-sm hover:shadow-md transition-shadow">
                        <div className="flex justify-between items-center mb-4">
                          <input
                            type="text"
                            value={script.name}
                            onChange={(e) => {
                              const updated = [...scripts];
                              updated[idx].name = e.target.value;
                              setScripts(updated);
                            }}
                            className="px-4 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[14px] font-medium font-mono focus:outline-none focus:ring-4 focus:ring-[var(--color-primary-subtle)]"
                          />
                          <button
                            onClick={() => handleRemoveScript(idx)}
                            className="p-2.5 hover:bg-[var(--color-error)]/10 text-[var(--color-error)] rounded-xl transition-all"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                        <textarea
                          value={script.content}
                          onChange={(e) => handleUpdateScript(idx, e.target.value)}
                          placeholder={t('skills.scriptPlaceholder')}
                          rows={8}
                          className="w-full resize-none px-4 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] focus:outline-none focus:ring-4 focus:ring-[var(--color-primary-subtle)] font-mono text-[14px]"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 p-6 border-t border-[var(--color-border)]">
          <button
            onClick={onClose}
            className="px-6 py-3 text-[14px] font-medium hover:bg-[var(--color-bg-muted)] rounded-xl transition-all"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-6 py-3 bg-gradient-to-br from-[var(--color-primary)] to-[var(--color-primary-hover)] hover:shadow-lg text-white rounded-xl text-[14px] font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-2 shadow-md hover:-translate-y-0.5"
          >
            {saving ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                {t('skills.creating')}
              </>
            ) : (
              t('skills.createSkill')
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
