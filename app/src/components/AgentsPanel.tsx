/**
 * AgentsPanel — Agent management UI for Settings page.
 * Lists agent definitions, supports create/edit/delete for custom agents.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Bot,
  Plus,
  Trash2,
  Pencil,
  Loader2,
  Wrench,
  X,
  Check,
} from 'lucide-react';
import {
  listAgents,
  getAgent,
  saveAgent,
  deleteAgent,
  type AgentSummary,
  type AgentDefinition,
} from '../api/agents';
import { toast } from './Toast';

interface AgentFormState {
  name: string;
  description: string;
  model: string;
  instructions: string;
}

const emptyForm: AgentFormState = {
  name: '',
  description: '',
  model: '',
  instructions: '',
};

/** Build AGENT.md content from form state */
function buildAgentMd(form: AgentFormState): string {
  const lines: string[] = ['---'];
  lines.push(`name: "${form.name}"`);
  if (form.description) lines.push(`description: "${form.description}"`);
  if (form.model) lines.push(`model: "${form.model}"`);
  lines.push('---');
  lines.push('');
  if (form.instructions) {
    lines.push(form.instructions);
  }
  return lines.join('\n');
}

export function AgentsPanel() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [form, setForm] = useState<AgentFormState>({ ...emptyForm });
  const [saving, setSaving] = useState(false);
  const [deletingName, setDeletingName] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listAgents();
      setAgents(data);
    } catch (e) {
      console.error('Failed to load agents:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleNew = () => {
    setEditingName(null);
    setForm({ ...emptyForm });
    setShowForm(true);
  };

  const handleEdit = async (name: string) => {
    try {
      const def = await getAgent(name);
      if (!def) {
        toast.error(`未找到 Agent: ${name}`);
        return;
      }
      setEditingName(name);
      setForm({
        name: def.name,
        description: def.description,
        model: def.model || '',
        instructions: def.instructions,
      });
      setShowForm(true);
    } catch (e) {
      toast.error(String(e));
    }
  };

  const handleDelete = async (name: string) => {
    if (!confirm(`确定删除 Agent "${name}"？此操作不可恢复。`)) return;
    setDeletingName(name);
    try {
      await deleteAgent(name);
      toast.success(`已删除 Agent: ${name}`);
      await load();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setDeletingName(null);
    }
  };

  const handleSave = async () => {
    if (!form.name.trim()) {
      toast.error('Agent 名称不能为空');
      return;
    }
    setSaving(true);
    try {
      const content = buildAgentMd(form);
      await saveAgent(content);
      toast.success(editingName ? `已更新 Agent: ${form.name}` : `已创建 Agent: ${form.name}`);
      setShowForm(false);
      setEditingName(null);
      setForm({ ...emptyForm });
      await load();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setShowForm(false);
    setEditingName(null);
    setForm({ ...emptyForm });
  };

  if (loading) {
    return (
      <div className="py-16 text-center text-[13px] text-[var(--color-text-muted)]">
        <Loader2 size={24} className="mx-auto mb-2 animate-spin" />
        加载中...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Agent List */}
      <div className="p-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <Bot size={18} className="text-[var(--color-primary)]" />
            <h2 className="font-semibold text-[14px]">智能体列表</h2>
          </div>
        </div>
        <p className="text-[12px] text-[var(--color-text-muted)] mb-4 ml-[26px]">
          管理内置和自定义的 Agent 智能体
        </p>

        {agents.length === 0 && !showForm ? (
          <div className="py-10 text-center">
            <Bot size={32} className="mx-auto mb-3 opacity-20" style={{ color: 'var(--color-text-muted)' }} />
            <div className="text-[13px] text-[var(--color-text-muted)]">
              暂无 Agent 定义
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            {agents.map((agent) => (
              <div
                key={agent.name}
                className="group flex items-center gap-3 p-3 rounded-xl hover:bg-[var(--color-bg-subtle)] transition-colors"
              >
                {/* Emoji */}
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-[16px] shrink-0"
                  style={{ background: agent.color || 'var(--color-bg-subtle)' }}
                >
                  {agent.emoji || '🤖'}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium" style={{ color: 'var(--color-text)' }}>
                      {agent.name}
                    </span>
                    {agent.is_builtin && (
                      <span
                        className="px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0"
                        style={{ background: 'var(--color-primary)', color: '#FFFFFF', opacity: 0.85 }}
                      >
                        内置
                      </span>
                    )}
                    {agent.model && (
                      <span
                        className="px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0"
                        style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-muted)' }}
                      >
                        {agent.model}
                      </span>
                    )}
                  </div>
                  <div className="text-[12px] truncate" style={{ color: 'var(--color-text-muted)' }}>
                    {agent.description || '无描述'}
                  </div>
                </div>

                {/* Badges & Actions */}
                <div className="flex items-center gap-2 shrink-0">
                  {agent.tool_count != null && agent.tool_count > 0 && (
                    <span
                      className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium"
                      style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-secondary)' }}
                      title={`${agent.tool_count} 个工具`}
                    >
                      <Wrench size={10} />
                      {agent.tool_count}
                    </span>
                  )}

                  {!agent.is_builtin && (
                    <>
                      <button
                        onClick={() => handleEdit(agent.name)}
                        className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg transition-all hover:bg-[var(--color-bg-muted)]"
                        style={{ color: 'var(--color-text-secondary)' }}
                        title="编辑"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        onClick={() => handleDelete(agent.name)}
                        disabled={deletingName === agent.name}
                        className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg transition-all hover:bg-[var(--color-bg-muted)] disabled:opacity-50"
                        style={{ color: 'var(--color-error)' }}
                        title="删除"
                      >
                        {deletingName === agent.name ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Trash2 size={14} />
                        )}
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* New / Edit Agent Form */}
        {showForm ? (
          <div className="mt-3 p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[13px] font-medium" style={{ color: 'var(--color-text)' }}>
                {editingName ? `编辑 Agent: ${editingName}` : '新建 Agent'}
              </span>
              <button
                onClick={handleCancel}
                className="p-1 rounded-lg hover:bg-[var(--color-bg-muted)] transition-colors"
                style={{ color: 'var(--color-text-muted)' }}
              >
                <X size={14} />
              </button>
            </div>

            <div className="space-y-3">
              {/* Name */}
              <div>
                <label className="text-[11px] text-[var(--color-text-muted)] mb-1 block">名称 *</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="例如: code-reviewer"
                  disabled={!!editingName}
                  className="w-full px-3 py-2 rounded-xl text-[13px] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50 disabled:opacity-60"
                  style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
                />
              </div>

              {/* Description */}
              <div>
                <label className="text-[11px] text-[var(--color-text-muted)] mb-1 block">描述</label>
                <input
                  type="text"
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="简要描述该 Agent 的功能"
                  className="w-full px-3 py-2 rounded-xl text-[13px] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50"
                  style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
                />
              </div>

              {/* Model */}
              <div>
                <label className="text-[11px] text-[var(--color-text-muted)] mb-1 block">模型（留空使用默认）</label>
                <input
                  type="text"
                  value={form.model}
                  onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
                  placeholder="例如: gpt-4o, claude-3-5-sonnet-20241022"
                  className="w-full px-3 py-2 rounded-xl text-[13px] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50"
                  style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
                />
              </div>

              {/* Instructions */}
              <div>
                <label className="text-[11px] text-[var(--color-text-muted)] mb-1 block">系统指令</label>
                <textarea
                  value={form.instructions}
                  onChange={(e) => setForm((f) => ({ ...f, instructions: e.target.value }))}
                  placeholder="Agent 的系统指令 / System Prompt..."
                  rows={6}
                  className="w-full px-3 py-2 rounded-xl text-[13px] leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/50"
                  style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}
                />
              </div>

              {/* Actions */}
              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={handleCancel}
                  className="px-3 py-1.5 rounded-lg text-[12px] font-medium hover:bg-[var(--color-bg-subtle)] transition-colors"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  取消
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving || !form.name.trim()}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-[12px] font-medium transition-colors disabled:opacity-50"
                  style={{ background: 'var(--color-primary)', color: '#FFFFFF' }}
                >
                  {saving ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Check size={12} />
                  )}
                  {saving ? '保存中...' : '保存'}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <button
            onClick={handleNew}
            className="mt-3 flex items-center gap-2 px-4 py-2.5 rounded-xl text-[13px] font-medium transition-colors w-full justify-center"
            style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-primary)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
          >
            <Plus size={15} />
            新建 Agent
          </button>
        )}
      </div>
    </div>
  );
}
