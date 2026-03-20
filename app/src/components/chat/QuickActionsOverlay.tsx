/**
 * QuickActionsOverlay — Floating panel above ChatInput that shows quick action cards.
 * Mirrors ChatWelcome's card UX so users can discover prompts at any time.
 * Supports custom user-defined quick actions with inline add/edit form.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Pencil, Trash2, Check, X } from 'lucide-react';
import { getQuickActions, mergeWithCustomActions, getIconNames, ICON_MAP, type QuickAction } from './chatActions';
import {
  listQuickActions,
  addQuickAction,
  updateQuickAction,
  deleteQuickAction,
  type CustomQuickAction,
} from '../../api/system';

const PRESET_COLORS = [
  '#6366F1', // indigo
  '#8b5cf6', // violet
  '#059669', // emerald
  '#d97706', // amber
  '#e11d48', // rose
  '#0891b2', // cyan
];

interface QuickActionsOverlayProps {
  onSelectPrompt: (prompt: string) => void;
  onClose: () => void;
}

interface FormState {
  mode: 'add' | 'edit';
  id?: string;
  label: string;
  description: string;
  prompt: string;
  icon: string;
  color: string;
}

export function QuickActionsOverlay({ onSelectPrompt, onClose }: QuickActionsOverlayProps) {
  const { t } = useTranslation();
  const [expandedAction, setExpandedAction] = useState<number | null>(null);
  const [customActions, setCustomActions] = useState<CustomQuickAction[]>([]);
  const [formState, setFormState] = useState<FormState | null>(null);
  const [showIconPicker, setShowIconPicker] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);

  const builtinActions = getQuickActions(t);

  const loadCustomActions = useCallback(async () => {
    try {
      const actions = await listQuickActions();
      setCustomActions(actions);
    } catch (e) {
      console.error('Failed to load custom quick actions:', e);
    }
  }, []);

  useEffect(() => {
    loadCustomActions();
  }, [loadCustomActions]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (overlayRef.current && !overlayRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (formState) {
          setFormState(null);
        } else {
          onClose();
        }
      }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose, formState]);

  const allActions = mergeWithCustomActions(builtinActions, customActions);

  const handleAddNew = (e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedAction(null);
    setFormState({
      mode: 'add',
      label: '',
      description: '',
      prompt: '',
      icon: 'Zap',
      color: PRESET_COLORS[0],
    });
  };

  const handleEdit = (e: React.MouseEvent, action: QuickAction) => {
    e.stopPropagation();
    const custom = customActions.find((c) => c.id === action.customId);
    if (!custom) return;
    setExpandedAction(null);
    setFormState({
      mode: 'edit',
      id: custom.id,
      label: custom.label,
      description: custom.description,
      prompt: custom.prompt,
      icon: custom.icon,
      color: custom.color,
    });
  };

  const handleDelete = async (e: React.MouseEvent, action: QuickAction) => {
    e.stopPropagation();
    if (!action.customId) return;
    try {
      await deleteQuickAction(action.customId);
      await loadCustomActions();
    } catch (err) {
      console.error('Failed to delete quick action:', err);
    }
  };

  const handleSave = async () => {
    if (!formState || !formState.label.trim() || !formState.prompt.trim()) return;
    try {
      if (formState.mode === 'add') {
        await addQuickAction(
          formState.label.trim(),
          formState.description.trim(),
          formState.prompt.trim(),
          formState.icon,
          formState.color,
        );
      } else if (formState.mode === 'edit' && formState.id) {
        await updateQuickAction(
          formState.id,
          formState.label.trim(),
          formState.description.trim(),
          formState.prompt.trim(),
          formState.icon,
          formState.color,
        );
      }
      setFormState(null);
      await loadCustomActions();
    } catch (err) {
      console.error('Failed to save quick action:', err);
    }
  };

  return (
    <div
      ref={overlayRef}
      className="absolute left-0 right-0 bottom-full mb-2 rounded-2xl z-50 overflow-hidden"
      style={{
        background: 'var(--color-bg-elevated)',
        border: '1px solid var(--color-border-strong)',
        boxShadow: 'var(--shadow-lg)',
      }}
      onClick={() => {
        if (expandedAction !== null) setExpandedAction(null);
        if (showIconPicker) setShowIconPicker(false);
      }}
    >
      <div className="p-3">
        {/* Header */}
        <div className="flex items-center justify-between mb-3 px-1">
          <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
            {t('chat.quick.title', '快速操作')}
          </span>
          <button
            onClick={onClose}
            className="text-[11px] px-2 py-0.5 rounded-md transition-colors"
            style={{ color: 'var(--color-text-muted)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            Esc
          </button>
        </div>

        {/* Inline form */}
        {formState && (
          <div
            className="mb-3 p-3 rounded-xl space-y-2"
            style={{ background: 'var(--color-bg-subtle)', border: '1px solid var(--color-border)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              {/* Icon picker button */}
              <div className="relative">
                <button
                  className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors"
                  style={{ background: `${formState.color}18` }}
                  onClick={(e) => { e.stopPropagation(); setShowIconPicker(!showIconPicker); }}
                  title="Choose icon"
                >
                  {(() => {
                    const IconComp = ICON_MAP[formState.icon];
                    return IconComp ? <IconComp size={14} style={{ color: formState.color }} /> : null;
                  })()}
                </button>
                {showIconPicker && (
                  <div
                    className="absolute bottom-full mb-1 left-0 p-2 rounded-lg grid grid-cols-6 gap-1 z-50"
                    style={{
                      background: 'var(--color-bg-elevated)',
                      border: '1px solid var(--color-border-strong)',
                      boxShadow: 'var(--shadow-lg)',
                    }}
                  >
                    {getIconNames().map((name) => {
                      const IconComp = ICON_MAP[name];
                      if (!IconComp) return null;
                      return (
                        <button
                          key={name}
                          className="w-7 h-7 rounded-md flex items-center justify-center transition-colors"
                          style={{
                            background: formState.icon === name ? `${formState.color}20` : 'transparent',
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setFormState({ ...formState, icon: name });
                            setShowIconPicker(false);
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = formState.icon === name ? `${formState.color}20` : 'transparent';
                          }}
                          title={name}
                        >
                          <IconComp size={13} style={{ color: formState.color }} />
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <input
                type="text"
                placeholder={t('chat.quick.formLabelPlaceholder', 'Action name')}
                value={formState.label}
                onChange={(e) => setFormState({ ...formState, label: e.target.value })}
                className="flex-1 text-[12px] px-2 py-1.5 rounded-lg bg-transparent outline-none"
                style={{
                  border: '1px solid var(--color-border)',
                  color: 'var(--color-text)',
                }}
                autoFocus
              />
            </div>
            <input
              type="text"
              placeholder={t('chat.quick.formDescPlaceholder', 'Brief description (optional)')}
              value={formState.description}
              onChange={(e) => setFormState({ ...formState, description: e.target.value })}
              className="w-full text-[12px] px-2 py-1.5 rounded-lg bg-transparent outline-none"
              style={{
                border: '1px solid var(--color-border)',
                color: 'var(--color-text)',
              }}
            />
            <textarea
              placeholder={t('chat.quick.formPromptPlaceholder', 'Prompt text...')}
              value={formState.prompt}
              onChange={(e) => setFormState({ ...formState, prompt: e.target.value })}
              rows={2}
              className="w-full text-[12px] px-2 py-1.5 rounded-lg bg-transparent outline-none resize-none"
              style={{
                border: '1px solid var(--color-border)',
                color: 'var(--color-text)',
              }}
            />
            {/* Color picker */}
            <div className="flex items-center gap-1.5">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  className="w-5 h-5 rounded-full transition-all"
                  style={{
                    background: c,
                    outline: formState.color === c ? `2px solid ${c}` : 'none',
                    outlineOffset: '2px',
                    opacity: formState.color === c ? 1 : 0.6,
                  }}
                  onClick={(e) => { e.stopPropagation(); setFormState({ ...formState, color: c }); }}
                />
              ))}
              <div className="flex-1" />
              <button
                onClick={(e) => { e.stopPropagation(); setFormState(null); }}
                className="text-[11px] px-2.5 py-1 rounded-md transition-colors flex items-center gap-1"
                style={{ color: 'var(--color-text-muted)' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <X size={11} />
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); handleSave(); }}
                disabled={!formState.label.trim() || !formState.prompt.trim()}
                className="text-[11px] px-2.5 py-1 rounded-md transition-colors flex items-center gap-1"
                style={{
                  background: formState.label.trim() && formState.prompt.trim() ? formState.color : 'var(--color-bg-muted)',
                  color: formState.label.trim() && formState.prompt.trim() ? '#fff' : 'var(--color-text-muted)',
                  opacity: formState.label.trim() && formState.prompt.trim() ? 1 : 0.5,
                }}
              >
                <Check size={11} />
                {t('common.save', 'Save')}
              </button>
            </div>
          </div>
        )}

        {/* Cards grid */}
        {!formState && (
          <div className="grid grid-cols-3 gap-2">
            {allActions.map((action, idx) => {
              const Icon = action.icon;
              const isExpanded = expandedAction === idx;
              const isHidden = expandedAction !== null && !isExpanded;
              const isCustom = !!action.customId;

              return (
                <div
                  key={action.customId || idx}
                  className="transition-all duration-500 ease-out group relative"
                  style={{
                    gridColumn: isExpanded ? '1 / -1' : undefined,
                    opacity: isHidden ? 0 : 1,
                    transform: isHidden ? 'scale(0.95)' : 'scale(1)',
                    pointerEvents: isHidden ? 'none' : 'auto',
                    maxHeight: isHidden ? 0 : '400px',
                    overflow: 'hidden',
                  }}
                >
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpandedAction(isExpanded ? null : idx);
                    }}
                    className="w-full text-left rounded-xl transition-all duration-300"
                    style={{
                      background: 'var(--color-bg-subtle)',
                      boxShadow: isExpanded
                        ? `0 4px 16px ${action.color}15, 0 0 0 1px ${action.color}25`
                        : 'none',
                    }}
                    onMouseEnter={(e) => {
                      if (!isExpanded) {
                        e.currentTarget.style.background = 'var(--color-bg-muted)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!isExpanded) {
                        e.currentTarget.style.background = 'var(--color-bg-subtle)';
                      }
                    }}
                  >
                    <div className="flex items-center gap-2 p-2.5">
                      <div
                        className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 transition-all duration-500"
                        style={{ background: isExpanded ? `${action.color}18` : `${action.color}0C` }}
                      >
                        <Icon size={13} style={{ color: action.color }} />
                      </div>
                      <span className="text-[12px] font-semibold flex-1 truncate" style={{ color: 'var(--color-text)' }}>
                        {action.label}
                      </span>
                      {/* Edit/Delete for custom actions */}
                      {isCustom && !isExpanded && (
                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <span
                            className="p-1 rounded-md cursor-pointer transition-colors"
                            style={{ color: 'var(--color-text-muted)' }}
                            onClick={(e) => handleEdit(e, action)}
                            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                          >
                            <Pencil size={11} />
                          </span>
                          <span
                            className="p-1 rounded-md cursor-pointer transition-colors"
                            style={{ color: 'var(--color-text-muted)' }}
                            onClick={(e) => handleDelete(e, action)}
                            onMouseEnter={(e) => { e.currentTarget.style.color = '#e11d48'; e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-text-muted)'; e.currentTarget.style.background = 'transparent'; }}
                          >
                            <Trash2 size={11} />
                          </span>
                        </div>
                      )}
                      <div
                        className="transition-transform duration-500 shrink-0"
                        style={{ transform: isExpanded ? 'rotate(45deg)' : 'rotate(0)', color: 'var(--color-text-tertiary)' }}
                      >
                        <Plus size={12} />
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="px-2.5 pb-2.5 space-y-1">
                        {action.desc && (
                          <p className="text-[11px] px-1 mb-2" style={{ color: 'var(--color-text-muted)' }}>
                            {action.desc}
                          </p>
                        )}
                        {action.examples.map((ex, eidx) => (
                          <div
                            key={eidx}
                            className="flex items-center gap-2 px-2.5 py-2 rounded-lg text-[12px] transition-all duration-150 cursor-pointer"
                            style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-secondary)' }}
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectPrompt(ex);
                              onClose();
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.background = `${action.color}0E`;
                              e.currentTarget.style.color = 'var(--color-text)';
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.background = 'var(--color-bg-subtle)';
                              e.currentTarget.style.color = 'var(--color-text-secondary)';
                            }}
                          >
                            <span className="w-1 h-1 rounded-full shrink-0" style={{ background: action.color, opacity: 0.5 }} />
                            <span>{ex}</span>
                          </div>
                        ))}
                        {/* Edit/Delete buttons for custom actions in expanded view */}
                        {isCustom && (
                          <div className="flex items-center gap-1 pt-1 px-1">
                            <button
                              className="text-[11px] px-2 py-1 rounded-md transition-colors flex items-center gap-1"
                              style={{ color: 'var(--color-text-muted)' }}
                              onClick={(e) => handleEdit(e, action)}
                              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
                              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                            >
                              <Pencil size={10} />
                              {t('common.edit', 'Edit')}
                            </button>
                            <button
                              className="text-[11px] px-2 py-1 rounded-md transition-colors flex items-center gap-1"
                              style={{ color: 'var(--color-text-muted)' }}
                              onClick={(e) => handleDelete(e, action)}
                              onMouseEnter={(e) => { e.currentTarget.style.color = '#e11d48'; e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
                              onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-text-muted)'; e.currentTarget.style.background = 'transparent'; }}
                            >
                              <Trash2 size={10} />
                              {t('common.delete', 'Delete')}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </button>
                </div>
              );
            })}

            {/* Add new action button */}
            <div>
              <button
                onClick={handleAddNew}
                className="w-full text-left rounded-xl transition-all duration-300 h-full min-h-[44px]"
                style={{ background: 'var(--color-bg-subtle)', border: '1px dashed var(--color-border)' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
              >
                <div className="flex items-center justify-center gap-1.5 p-2.5">
                  <Plus size={13} style={{ color: 'var(--color-text-muted)' }} />
                  <span className="text-[12px] font-medium" style={{ color: 'var(--color-text-muted)' }}>
                    {t('chat.quick.addCustom', 'Add Action')}
                  </span>
                </div>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
