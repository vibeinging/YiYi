/**
 * ChatInput — Message input area with slash commands, @mentions, task picker, attachments.
 */

import { useState, useRef, useCallback, useEffect, forwardRef, useImperativeHandle } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Send, X, Paperclip, FileText, Square, Loader2, Sparkles, FolderOpen,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { QuickActionsOverlay } from './QuickActionsOverlay';
import { MentionPicker, buildMentionList } from '../MentionPicker';
import { MentionInput, type MentionInputHandle, type MentionTag } from '../MentionInput';
import { SlashCommandPicker, filterCommands, SLASH_COMMANDS, type SlashCommand } from '../SlashCommandPicker';
import { VoiceButton } from '../voice/VoiceButton';
import { listAllTasksBrief } from '../../api/tasks';
import { listAgents, type AgentSummary } from '../../api/agents';
import type { Attachment } from '../../api/agent';
import type { WorkspaceFile } from '../../api/workspace';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface TaskSuggestion {
  id: string;
  title: string;
  status: string;
  sessionId: string;
}

interface ChatInputProps {
  loading: boolean;
  workspaceFiles: WorkspaceFile[];
  onSend: (plainText: string, mentions: MentionTag[], attachments: Attachment[]) => void;
  onStop: () => void;
  onSelectCommand: (cmd: SlashCommand, args?: string) => void;
  onSelectTask: (task: TaskSuggestion) => void;
  onFileSelect: (file: WorkspaceFile) => void;
  onFetchWorkspaceFiles: () => void;
}

export interface ChatInputHandle {
  focus: () => void;
  insertText: (text: string) => void;
  clear: () => void;
  shake: () => void;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const COMPRESS_THRESHOLD = 1024 * 1024;
const MAX_DIMENSION = 1920;
const COMPRESS_QUALITY = 0.85;

const isImageMime = (mime: string) => mime.startsWith('image/');

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
  {
    loading,
    workspaceFiles,
    onSend,
    onStop,
    onSelectCommand,
    onSelectTask,
    onFileSelect,
    onFetchWorkspaceFiles,
  },
  ref,
) {
  const { t } = useTranslation();
  const inputRef = useRef<MentionInputHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [message, setMessage] = useState('');
  const [pendingImages, setPendingImages] = useState<Attachment[]>([]);
  const [shaking, setShaking] = useState(false);

  // Pickers
  const [showQuickActions, setShowQuickActions] = useState(false);

  const [showCommandPicker, setShowCommandPicker] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [commandPickerIndex, setCommandPickerIndex] = useState(0);

  const [showFilePicker, setShowFilePicker] = useState(false);
  const [filePickerQuery, setFilePickerQuery] = useState('');
  const [filePickerIndex, setFilePickerIndex] = useState(0);

  const [showTaskPicker, setShowTaskPicker] = useState(false);
  const [taskPickerQuery, setTaskPickerQuery] = useState('');
  const [taskPickerIndex, setTaskPickerIndex] = useState(0);
  const [taskSuggestions, setTaskSuggestions] = useState<TaskSuggestion[]>([]);
  const skipTaskPickerCloseRef = useRef(false);

  // Agents for @mention
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  useEffect(() => {
    listAgents().then(setAgents).catch(() => setAgents([]));
  }, []);

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
    insertText: (text: string) => inputRef.current?.insertText(text),
    clear: () => { inputRef.current?.clear(); setMessage(''); setPendingImages([]); },
    shake: () => {
      setShaking(true);
      setTimeout(() => setShaking(false), 800);
    },
  }));

  // --- Attachment handling ---
  const compressImage = (file: File): Promise<{ base64: string; mimeType: string } | null> => {
    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        let { width, height } = img;
        if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
          const ratio = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(null); return; }
        ctx.drawImage(img, 0, 0, width, height);
        const outputMime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        const quality = outputMime === 'image/jpeg' ? COMPRESS_QUALITY : undefined;
        const dataUrl = canvas.toDataURL(outputMime, quality);
        const base64 = dataUrl.split(',')[1];
        resolve(base64 ? { base64, mimeType: outputMime } : null);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  };

  const readFileAsAttachment = async (file: File): Promise<Attachment | null> => {
    if (file.size > MAX_FILE_SIZE) return null;
    if (isImageMime(file.type) && file.size > COMPRESS_THRESHOLD) {
      const compressed = await compressImage(file);
      if (compressed) return { mimeType: compressed.mimeType, data: compressed.base64, name: file.name };
    }
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const base64 = dataUrl.split(',')[1];
        resolve(base64 ? { mimeType: file.type || 'application/octet-stream', data: base64, name: file.name } : null);
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  };

  const addAttachments = async (files: FileList | File[]) => {
    const remaining = MAX_ATTACHMENTS - pendingImages.length;
    const toProcess = Array.from(files).slice(0, remaining);
    const results = await Promise.all(toProcess.map(readFileAsAttachment));
    const valid = results.filter((r): r is Attachment => r !== null);
    if (valid.length > 0) setPendingImages((prev) => [...prev, ...valid]);
  };

  const removeImage = (idx: number) => setPendingImages((prev) => prev.filter((_, i) => i !== idx));

  // --- Input callbacks ---
  const handleMentionInput = useCallback((text: string) => {
    setMessage(text);
    const trimmed = text.trimStart();

    if (trimmed.startsWith('/') && !trimmed.includes(' ') && !trimmed.includes('\n')) {
      setCommandQuery(trimmed.slice(1));
      setCommandPickerIndex(0);
      setShowCommandPicker(true);
      setShowTaskPicker(false);
      return;
    }
    setShowCommandPicker(false);

    const focusMatch = trimmed.match(/^\/task\s(.*)$/i);
    if (focusMatch) {
      const q = focusMatch[1];
      setTaskPickerQuery(q);
      setTaskPickerIndex(0);
      setShowTaskPicker(true);
      listAllTasksBrief().then((tasks) => {
        const filtered = q ? tasks.filter((t) => t.title.toLowerCase().includes(q.toLowerCase())) : tasks;
        setTaskSuggestions(filtered.map((t) => ({ id: t.id, title: t.title, status: t.status, sessionId: t.sessionId })));
      }).catch(() => setTaskSuggestions([]));
      return;
    }

    if (!skipTaskPickerCloseRef.current) setShowTaskPicker(false);
  }, []);

  const handleMentionTrigger = useCallback((query: string) => {
    setShowFilePicker(true);
    setFilePickerQuery(query);
    setFilePickerIndex(0);
    if (workspaceFiles.length === 0) onFetchWorkspaceFiles();
  }, [workspaceFiles.length, onFetchWorkspaceFiles]);

  const handleMentionDismiss = useCallback(() => setShowFilePicker(false), []);

  const selectCommand = useCallback((cmd: SlashCommand) => {
    setShowCommandPicker(false);
    if (cmd.name === 'task') {
      skipTaskPickerCloseRef.current = true;
      inputRef.current?.clear();
      setTimeout(() => {
        inputRef.current?.insertText(`/${cmd.name} `);
        inputRef.current?.focus();
        setTimeout(() => { skipTaskPickerCloseRef.current = false; }, 50);
      }, 0);
      setMessage(`/${cmd.name} `);
      setTaskPickerQuery('');
      setTaskPickerIndex(0);
      setShowTaskPicker(true);
      listAllTasksBrief().then((tasks) => {
        setTaskSuggestions(tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, sessionId: t.sessionId })));
      }).catch(() => setTaskSuggestions([]));
      return;
    }
    inputRef.current?.clear();
    setTimeout(() => {
      inputRef.current?.insertText(`/${cmd.name} `);
      inputRef.current?.focus();
    }, 0);
    setMessage(`/${cmd.name} `);
  }, []);

  const handleSend = useCallback(() => {
    const plainText = inputRef.current?.getPlainText() || '';
    const mentions = inputRef.current?.getMentions() || [];
    const inputEmpty = inputRef.current?.isEmpty() ?? true;
    if ((inputEmpty && pendingImages.length === 0) || loading) return;

    // Check for /command
    const trimmed = plainText.trim();
    const cmdMatch = trimmed.match(/^\/(\S+)(?:\s+(.*))?$/);
    if (cmdMatch) {
      const cmd = SLASH_COMMANDS.find(c => c.name === cmdMatch[1]);
      if (cmd) {
        onSelectCommand(cmd, cmdMatch[2]);
        inputRef.current?.clear();
        setMessage('');
        return;
      }
    }

    const attachments = pendingImages.length > 0 ? [...pendingImages] : [];
    inputRef.current?.clear();
    setMessage('');
    setPendingImages([]);
    onSend(plainText, mentions, attachments);
  }, [loading, pendingImages, onSend, onSelectCommand]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showCommandPicker) {
      const cmds = filterCommands(commandQuery);
      const maxIdx = cmds.length - 1;
      if (e.key === 'ArrowDown') { e.preventDefault(); setCommandPickerIndex(prev => Math.min(prev + 1, maxIdx)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCommandPickerIndex(prev => Math.max(prev - 1, 0)); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); const s = cmds[commandPickerIndex]; if (s) selectCommand(s); return; }
      if (e.key === 'Escape') { e.preventDefault(); setShowCommandPicker(false); return; }
    }
    if (showTaskPicker && taskSuggestions.length > 0) {
      const maxIdx = taskSuggestions.length - 1;
      if (e.key === 'ArrowDown') { e.preventDefault(); setTaskPickerIndex(prev => Math.min(prev + 1, maxIdx)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setTaskPickerIndex(prev => Math.max(prev - 1, 0)); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const selected = taskSuggestions[taskPickerIndex];
        if (selected) { inputRef.current?.clear(); setMessage(''); setShowTaskPicker(false); onSelectTask(selected); }
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); setShowTaskPicker(false); return; }
    }
    if (showFilePicker) {
      const items = buildMentionList([], workspaceFiles, filePickerQuery, agents);
      const maxIdx = items.length - 1;
      if (e.key === 'ArrowDown') { e.preventDefault(); setFilePickerIndex(prev => Math.min(prev + 1, maxIdx)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setFilePickerIndex(prev => Math.max(prev - 1, 0)); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const selected = items[filePickerIndex];
        if (selected) {
          if (selected.type === 'agent') {
            const tag: MentionTag = { type: 'agent', id: selected.agent.name, name: selected.agent.name };
            inputRef.current?.insertMention(tag);
            setShowFilePicker(false);
          } else if (selected.type === 'file') {
            onFileSelect(selected.file);
          }
        }
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); setShowFilePicker(false); return; }
    }
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    const fileItems = items.filter((item) => item.kind === 'file');
    if (fileItems.length > 0) {
      e.preventDefault();
      const files = fileItems.map((item) => item.getAsFile()).filter((f): f is File => f !== null);
      await addAttachments(files);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) await addAttachments(files);
  };

  const handleDragOver = (e: React.DragEvent) => e.preventDefault();

  return (
    <div className="shrink-0 px-3 sm:px-6 py-4" style={{ background: 'var(--color-bg)', borderTop: '1px solid var(--color-border)' }}>
      <form onSubmit={(e) => { e.preventDefault(); handleSend(); }} className="w-full">
        <div
          className={`relative rounded-2xl transition-all${shaking ? ' animate-input-shake' : ''}`}
          style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)' }}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
        >
          {showCommandPicker && (
            <SlashCommandPicker query={commandQuery} selectedIndex={commandPickerIndex} onSelect={selectCommand} t={t} />
          )}

          {showTaskPicker && !showCommandPicker && taskSuggestions.length > 0 && (
            <div
              className="absolute left-0 right-0 bottom-full mb-1 rounded-xl overflow-hidden z-50"
              style={{
                background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-strong)',
                boxShadow: 'var(--shadow-lg)', maxHeight: '240px', overflowY: 'auto',
              }}
            >
              <div className="px-3 pt-2 pb-1">
                <span className="text-[11px] font-medium uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>选择任务</span>
              </div>
              {taskSuggestions.map((task, i) => {
                const isActive = i === taskPickerIndex;
                const statusIcon = task.status === 'running' ? '●' : task.status === 'completed' ? '✓' : task.status === 'failed' ? '✗' : '○';
                return (
                  <div key={task.id}
                    onClick={() => { inputRef.current?.clear(); setMessage(''); setShowTaskPicker(false); onSelectTask(task); }}
                    className="flex items-center gap-2.5 px-3 py-2 mx-1 rounded-lg cursor-pointer transition-colors"
                    style={{ background: isActive ? 'var(--color-primary-subtle)' : 'transparent' }}
                    onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = isActive ? 'var(--color-primary-subtle)' : 'transparent'; }}
                  >
                    <span className="text-[13px]" style={{ color: 'var(--color-text-muted)' }}>{statusIcon}</span>
                    <span className="text-[13px] font-medium" style={{ color: isActive ? 'var(--color-text)' : 'var(--color-text-secondary)' }}>
                      {task.title}
                    </span>
                  </div>
                );
              })}
              <div className="px-3 pt-1 pb-2">
                <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>↑↓ 导航 · Enter 选择 · Esc 关闭</span>
              </div>
            </div>
          )}

          {showFilePicker && !showCommandPicker && (
            <MentionPicker
              bots={[]}
              files={workspaceFiles}
              query={filePickerQuery}
              selectedIndex={filePickerIndex}
              onSelectBot={() => {}}
              onSelectFile={onFileSelect}
              agents={agents}
              onSelectAgent={(agent) => {
                const tag: MentionTag = { type: 'agent', id: agent.name, name: agent.name };
                inputRef.current?.insertMention(tag);
                setShowFilePicker(false);
              }}
            />
          )}

          {pendingImages.length > 0 && (
            <div className="flex gap-2 px-3 pt-3 pb-1 flex-wrap">
              {pendingImages.map((att, i) => (
                <div key={i} className="relative group/img" style={{ border: '1px solid var(--color-border)', borderRadius: '8px', overflow: 'hidden' }}>
                  {isImageMime(att.mimeType) ? (
                    <img src={`data:${att.mimeType};base64,${att.data}`} className="w-16 h-16 object-cover" alt={att.name || 'image'} />
                  ) : (
                    <div className="flex items-center gap-1.5 px-2.5 py-2 h-16" style={{ background: 'var(--color-bg-muted)', minWidth: '100px' }}>
                      <FileText size={16} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
                      <span className="text-[11px] truncate" style={{ color: 'var(--color-text-secondary)', maxWidth: '80px' }}>{att.name || 'file'}</span>
                    </div>
                  )}
                  <button type="button" onClick={() => removeImage(i)}
                    className="absolute top-0 right-0 w-5 h-5 flex items-center justify-center rounded-bl-md opacity-0 group-hover/img:opacity-100 transition-opacity"
                    style={{ background: 'rgba(0,0,0,0.6)', color: 'var(--color-bg)' }}>
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {showQuickActions && (
            <QuickActionsOverlay
              onSelectPrompt={(prompt) => {
                inputRef.current?.clear();
                setTimeout(() => {
                  inputRef.current?.insertText(prompt);
                  inputRef.current?.focus();
                }, 0);
                setMessage(prompt);
                setShowQuickActions(false);
              }}
              onClose={() => setShowQuickActions(false)}
            />
          )}

          <div className="flex items-end gap-2 p-2">
            <input ref={fileInputRef} type="file" multiple className="hidden"
              onChange={(e) => { if (e.target.files) addAttachments(e.target.files); e.target.value = ''; }} />
            <button type="button" onClick={() => fileInputRef.current?.click()}
              aria-label={t('chat.addFile', 'Add file')}
              disabled={loading || pendingImages.length >= MAX_ATTACHMENTS}
              className="w-9 h-9 flex items-center justify-center rounded-xl shrink-0 transition-all disabled:opacity-30"
              style={{ color: 'var(--color-text-muted)' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              title={t('chat.addFile')}>
              <Paperclip size={18} />
            </button>

            <button type="button" aria-label={t('chat.addFolder', 'Choose folder')} onClick={async () => {
                try {
                  const path = await invoke<string | null>('pick_folder');
                  if (path) inputRef.current?.insertText(path);
                } catch { /* user cancelled */ }
              }}
              disabled={loading}
              className="w-9 h-9 flex items-center justify-center rounded-xl shrink-0 transition-all disabled:opacity-30"
              style={{ color: 'var(--color-text-muted)' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              title={t('chat.addFolder', '选择文件夹')}>
              <FolderOpen size={18} />
            </button>

            <button type="button" aria-label={t('chat.quick.title', 'Quick actions')} onClick={() => setShowQuickActions((v) => !v)}
              disabled={loading}
              className="w-9 h-9 flex items-center justify-center rounded-xl shrink-0 transition-all disabled:opacity-30"
              style={{ color: showQuickActions ? 'var(--color-primary)' : 'var(--color-text-muted)' }}
              onMouseEnter={(e) => { if (!showQuickActions) e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
              onMouseLeave={(e) => { if (!showQuickActions) e.currentTarget.style.background = 'transparent'; }}
              title={t('chat.quick.title', '快速操作')}>
              <Sparkles size={16} />
            </button>

            {/* VoiceButton hidden — requires OpenAI Realtime API key, will enable in future */}

            <MentionInput
              ref={inputRef}
              placeholder={t('chat.placeholder')}
              disabled={loading}
              onInput={handleMentionInput}
              onMentionTrigger={handleMentionTrigger}
              onMentionDismiss={handleMentionDismiss}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
            />

            {loading ? (
              <button type="button" onClick={onStop}
                className="w-9 h-9 flex items-center justify-center rounded-xl shrink-0 transition-all"
                style={{ background: 'var(--color-error)', color: 'var(--color-bg)' }}
                title={t('chat.stop', '停止')}>
                <Square size={14} fill="currentColor" />
              </button>
            ) : (
              <button type="submit"
                disabled={!message.trim() && pendingImages.length === 0}
                className="w-9 h-9 flex items-center justify-center rounded-xl shrink-0 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                style={{
                  background: (message.trim() || pendingImages.length > 0) ? 'var(--color-primary)' : 'transparent',
                  color: (message.trim() || pendingImages.length > 0) ? '#FFFFFF' : 'var(--color-text-muted)',
                }}>
                <Send size={16} />
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
});
