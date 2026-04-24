/**
 * MCP (Model Context Protocol) Management Page
 * Swiss Minimalism · Clean · Precise
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Zap,
  Plus,
  Trash2,
  Edit,
  RefreshCw,
  Terminal,
  Globe,
  ToggleLeft,
  ToggleRight,
  Server,
  X,
  Loader2,
} from 'lucide-react';
import { Select } from '../components/Select';
import {
  listMCPClients,
  createMCPClient,
  updateMCPClient,
  toggleMCPClient,
  deleteMCPClient,
  type MCPClientInfo,
  type MCPClientCreateRequest,
  type MCPTransport,
} from '../api/mcp';
import { PageHeader } from '../components/PageHeader';
import { toast, confirm } from '../components/Toast';

interface MCPDialog {
  open: boolean;
  mode: 'create' | 'edit';
  client?: MCPClientInfo;
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  transport: MCPTransport;
  url: string;
  command: string;
  args: string;
  env: string;
  cwd: string;
}

export function MCPPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useTranslation();
  const [clients, setClients] = useState<MCPClientInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<MCPDialog>({
    open: false,
    mode: 'create',
    key: '',
    name: '',
    description: '',
    enabled: true,
    transport: 'stdio',
    url: '',
    command: '',
    args: '[]',
    env: '{}',
    cwd: '',
  });

  // Load data
  const loadClients = async () => {
    setLoading(true);
    try {
      const data = await listMCPClients();
      setClients(data);
    } catch (error) {
      console.error('Failed to load MCP clients:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadClients();
  }, []);

  // Open create dialog
  const openCreateDialog = () => {
    setDialog({
      open: true,
      mode: 'create',
      key: '',
      name: '',
      description: '',
      enabled: true,
      transport: 'stdio',
      url: '',
      command: '',
      args: '[]',
      env: '{}',
      cwd: '',
    });
  };

  // Open edit dialog
  const openEditDialog = (client: MCPClientInfo) => {
    setDialog({
      open: true,
      mode: 'edit',
      client,
      key: client.key,
      name: client.name,
      description: client.description,
      enabled: client.enabled,
      transport: client.transport,
      url: client.url,
      command: client.command,
      args: JSON.stringify(client.args),
      env: JSON.stringify(client.env),
      cwd: client.cwd,
    });
  };

  // Save client
  const handleSave = async () => {
    if (!dialog.name.trim()) {
      toast.info(t('mcp.name'));
      return;
    }
    if (!dialog.key.trim() && dialog.mode === 'create') {
      toast.info(t('mcp.clientKey'));
      return;
    }

    // Validate JSON
    let args: string[] = [];
    let env: Record<string, string> = {};
    try {
      args = JSON.parse(dialog.args);
    } catch {
      toast.error(t('mcp.args') + ' error');
      return;
    }
    try {
      env = JSON.parse(dialog.env);
    } catch {
      toast.error(t('mcp.env') + ' error');
      return;
    }

    const clientData: MCPClientCreateRequest = {
      name: dialog.name,
      description: dialog.description,
      enabled: dialog.enabled,
      transport: dialog.transport,
      url: dialog.url,
      command: dialog.command,
      args,
      env,
      cwd: dialog.cwd,
    };

    try {
      if (dialog.mode === 'create') {
        await createMCPClient(dialog.key, clientData);
      } else {
        await updateMCPClient(dialog.client!.key, clientData);
      }
      await loadClients();
      setDialog({ ...dialog, open: false });
    } catch (error) {
      console.error('Failed to save MCP client:', error);
      toast.error(`${t('mcp.save')}: ${String(error)}`);
    }
  };

  // Toggle enable
  const handleToggle = async (key: string) => {
    try {
      await toggleMCPClient(key);
      await loadClients();
    } catch (error) {
      console.error('Failed to toggle MCP client:', error);
      toast.error(`${t('mcp.enableClient')}: ${String(error)}`);
    }
  };

  // Delete client
  const handleDelete = async (key: string, name: string) => {
    if (!(await confirm(`${t('common.delete')} "${name}"?`))) return;
    try {
      await deleteMCPClient(key);
      await loadClients();
    } catch (error) {
      console.error('Failed to delete MCP client:', error);
      toast.error(`${t('common.delete')}: ${String(error)}`);
    }
  };

  // Get transport icon
  const getTransportIcon = (transport: MCPTransport) => {
    switch (transport) {
      case 'stdio':
        return <Terminal size={16} />;
      case 'streamable_http':
      case 'sse':
        return <Globe size={16} />;
      default:
        return <Server size={16} />;
    }
  };

  // Get transport label
  const getTransportLabel = (transport: MCPTransport) => {
    switch (transport) {
      case 'stdio':
        return t('mcp.transportTypes.stdio');
      case 'streamable_http':
        return t('mcp.transportTypes.http');
      case 'sse':
        return t('mcp.transportTypes.sse');
      default:
        return transport;
    }
  };

  return (
    <div className={embedded ? '' : 'h-full overflow-y-auto'}>
      <div className={embedded ? 'w-full px-8 py-4' : 'w-full px-8 py-8'}>
        {!embedded ? (
          <PageHeader
            title={t('mcp.title')}
            description={t('mcp.description')}
            actions={<>
              <button onClick={loadClients} disabled={loading} className="w-9 h-9 flex items-center justify-center rounded-xl transition-colors disabled:opacity-50" style={{ color: 'var(--color-text-secondary)' }} onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-elevated)'; }} onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }} title={t('mcp.refresh')}>
                <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
              </button>
              <button onClick={openCreateDialog} className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-[13px] font-medium transition-colors" style={{ background: 'var(--color-primary)', color: '#FFFFFF' }}>
                <Plus size={15} />
                {t('mcp.add')}
              </button>
            </>}
          />
        ) : (
          <div className="flex items-center justify-end gap-2 mb-4">
            <button onClick={loadClients} disabled={loading}
              className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors"
              style={{ color: 'var(--color-text-muted)' }}>
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
            <button onClick={openCreateDialog}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium"
              style={{ background: 'var(--color-primary)', color: '#fff' }}>
              <Plus size={13} /> {t('mcp.add')}
            </button>
          </div>
        )}

        {/* Clients list */}
        {clients.length === 0 && !loading ? (
          <div className="text-center py-20 border border-dashed border-[var(--color-border)] rounded-2xl">
            <Zap size={48} className="mx-auto mb-4 opacity-30 text-[var(--color-primary)]" />
            <p className="text-[var(--color-text-secondary)] mb-4 font-medium text-[15px]">{t('mcp.noClients')}</p>
            <button
              onClick={openCreateDialog}
              className="text-[var(--color-primary)] hover:underline text-[14px] font-medium"
            >
              {t('mcp.clickToAdd')}
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {clients.map((client) => (
              <div
                key={client.key}
                className={`p-5 rounded-2xl border transition-all ${
                  client.enabled
                    ? 'border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-sm hover:shadow-lg hover:-translate-y-0.5'
                    : 'border-[var(--color-border)] bg-[var(--color-bg-elevated)] opacity-60'
                }`}
              >
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => handleToggle(client.key)}
                      className="text-[var(--color-primary)] hover:opacity-80 transition-opacity"
                    >
                      {client.enabled ? <ToggleRight size={24} /> : <ToggleLeft size={24} />}
                    </button>
                    <div>
                      <h3 className="font-semibold text-[15px]">{client.name}</h3>
                      <p className="text-[13px] text-[var(--color-text-muted)] font-mono mt-0.5">{client.key}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => openEditDialog(client)}
                      className="p-2.5 hover:bg-[var(--color-info)]/10 text-[var(--color-info)] rounded-xl transition-all"
                      title={t('cronjobs.edit')}
                    >
                      <Edit size={16} />
                    </button>
                    <button
                      onClick={() => handleDelete(client.key, client.name)}
                      className="p-2.5 hover:bg-[var(--color-error)]/10 text-[var(--color-error)] rounded-xl transition-all"
                      title={t('common.delete')}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>

                {client.description && (
                  <p className="text-[14px] text-[var(--color-text-secondary)] mb-4 line-clamp-2">
                    {client.description}
                  </p>
                )}

                <div className="flex items-center gap-2 text-[14px] text-[var(--color-text-muted)]">
                  {getTransportIcon(client.transport)}
                  <span>{getTransportLabel(client.transport)}</span>
                </div>

                {client.transport === 'stdio' && client.command && (
                  <div className="mt-4 p-3 bg-[var(--color-bg-muted)] rounded-xl text-[13px] font-mono truncate border border-[var(--color-border)]">
                    {client.command} {client.args.join(' ')}
                  </div>
                )}

                {(client.transport === 'streamable_http' || client.transport === 'sse') && client.url && (
                  <div className="mt-4 p-3 bg-[var(--color-bg-muted)] rounded-xl text-[13px] font-mono truncate border border-[var(--color-border)]">
                    {client.url}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Info section */}
        <div className="mt-8 p-6 rounded-2xl bg-[var(--color-bg-elevated)] border border-[var(--color-border)] shadow-sm">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-xl bg-[var(--color-primary)]/10 flex items-center justify-center flex-shrink-0">
              <Zap size={20} className="text-[var(--color-primary)]" />
            </div>
            <div className="text-[14px] text-[var(--color-text-secondary)]">
              <p className="font-medium mb-1 text-[var(--color-text)]">{t('mcp.whatIsMCP')}</p>
              <p className="text-[13px] opacity-80">
                {t('mcp.whatIsMCPDesc')}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Create/Edit dialog */}
      {dialog.open && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 overflow-y-auto p-4 animate-fade-in">
          <div className="bg-[var(--color-bg-elevated)] rounded-3xl p-6 w-full max-w-lg shadow-2xl border border-[var(--color-border)] my-8 animate-slide-up">
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-semibold text-[15px]">
                {dialog.mode === 'create' ? t('mcp.createTitle') : t('mcp.editTitle')}
              </h2>
              <button
                onClick={() => setDialog({ ...dialog, open: false })}
                className="p-2 hover:bg-[var(--color-bg-muted)] rounded-xl transition-all"
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-2">
              {dialog.mode === 'create' && (
                <div>
                  <label className="block text-[14px] font-medium mb-2 text-[var(--color-text-secondary)]">
                    {t('mcp.clientKey')} *
                  </label>
                  <input
                    type="text"
                    value={dialog.key}
                    onChange={(e) => setDialog({ ...dialog, key: e.target.value })}
                    placeholder={t('mcp.clientKeyPlaceholder')}
                    className="w-full px-4 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] focus:outline-none focus:ring-4 focus:ring-[var(--color-primary-subtle)] font-mono text-[14px]"
                  />
                </div>
              )}

              <div>
                <label className="block text-[14px] font-medium mb-2 text-[var(--color-text-secondary)]">
                  {t('mcp.name')} *
                </label>
                <input
                  type="text"
                  value={dialog.name}
                  onChange={(e) => setDialog({ ...dialog, name: e.target.value })}
                  placeholder={t('mcp.namePlaceholder')}
                  className="w-full px-4 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] focus:outline-none focus:ring-4 focus:ring-[var(--color-primary-subtle)] text-[14px]"
                />
              </div>

              <div>
                <label className="block text-[14px] font-medium mb-2 text-[var(--color-text-secondary)]">
                  {t('mcp.desc_label')}
                </label>
                <input
                  type="text"
                  value={dialog.description}
                  onChange={(e) => setDialog({ ...dialog, description: e.target.value })}
                  placeholder={t('mcp.descPlaceholder')}
                  className="w-full px-4 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] focus:outline-none focus:ring-4 focus:ring-[var(--color-primary-subtle)] text-[14px]"
                />
              </div>

              <div>
                <label className="block text-[14px] font-medium mb-2 text-[var(--color-text-secondary)]">
                  {t('mcp.selectTransport')}
                </label>
                <Select
                  value={dialog.transport}
                  onChange={(v) => setDialog({ ...dialog, transport: v as MCPTransport })}
                  options={[
                    { value: 'stdio', label: t('mcp.transportTypes.stdio') },
                    { value: 'streamable_http', label: t('mcp.transportTypes.http') },
                    { value: 'sse', label: t('mcp.transportTypes.sse') },
                  ]}
                  fullWidth
                />
              </div>

              {dialog.transport === 'stdio' ? (
                <>
                  <div>
                    <label className="block text-[14px] font-medium mb-2 text-[var(--color-text-secondary)]">
                      {t('mcp.stdioCommand')}
                    </label>
                    <input
                      type="text"
                      value={dialog.command}
                      onChange={(e) => setDialog({ ...dialog, command: e.target.value })}
                      placeholder={t('mcp.stdioCommandPlaceholder')}
                      className="w-full px-4 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] focus:outline-none focus:ring-4 focus:ring-[var(--color-primary-subtle)] font-mono text-[14px]"
                    />
                  </div>
                  <div>
                    <label className="block text-[14px] font-medium mb-2 text-[var(--color-text-secondary)]">
                      {t('mcp.args')}
                    </label>
                    <input
                      type="text"
                      value={dialog.args}
                      onChange={(e) => setDialog({ ...dialog, args: e.target.value })}
                      placeholder={t('mcp.argsPlaceholder')}
                      className="w-full px-4 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] focus:outline-none focus:ring-4 focus:ring-[var(--color-primary-subtle)] font-mono text-[14px]"
                    />
                  </div>
                </>
              ) : (
                <div>
                  <label className="block text-[14px] font-medium mb-2 text-[var(--color-text-secondary)]">
                    {t('mcp.url')}
                  </label>
                  <input
                    type="text"
                    value={dialog.url}
                    onChange={(e) => setDialog({ ...dialog, url: e.target.value })}
                    placeholder={t('mcp.urlPlaceholder')}
                    className="w-full px-4 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] focus:outline-none focus:ring-4 focus:ring-[var(--color-primary-subtle)] font-mono text-[14px]"
                  />
                </div>
              )}

              <div>
                <label className="block text-[14px] font-medium mb-2 text-[var(--color-text-secondary)]">
                  {t('mcp.env')}
                </label>
                <input
                  type="text"
                  value={dialog.env}
                  onChange={(e) => setDialog({ ...dialog, env: e.target.value })}
                  placeholder={t('mcp.envPlaceholder')}
                  className="w-full px-4 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] focus:outline-none focus:ring-4 focus:ring-[var(--color-primary-subtle)] font-mono text-[14px]"
                />
              </div>

              <div>
                <label className="block text-[14px] font-medium mb-2 text-[var(--color-text-secondary)]">
                  {t('mcp.cwd')}
                </label>
                <input
                  type="text"
                  value={dialog.cwd}
                  onChange={(e) => setDialog({ ...dialog, cwd: e.target.value })}
                  placeholder={t('mcp.cwdPlaceholder')}
                  className="w-full px-4 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] focus:outline-none focus:ring-4 focus:ring-[var(--color-primary-subtle)] font-mono text-[14px]"
                />
              </div>

              <div className="flex items-center gap-3 pt-2">
                <input
                  type="checkbox"
                  id="enabled"
                  checked={dialog.enabled}
                  onChange={(e) => setDialog({ ...dialog, enabled: e.target.checked })}
                  className="accent-[var(--color-primary)]"
                />
                <label htmlFor="enabled" className="text-[14px]">
                  {t('mcp.enableClient')}
                </label>
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={() => setDialog({ ...dialog, open: false })}
                className="px-4 py-2.5 text-[14px] font-medium hover:bg-[var(--color-bg-muted)] rounded-xl transition-all"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleSave}
                className="px-5 py-2.5 bg-gradient-to-br from-[var(--color-primary)] to-[var(--color-primary-hover)] hover:shadow-lg text-white rounded-xl text-[14px] font-medium transition-all shadow-md hover:-translate-y-0.5"
              >
                {dialog.mode === 'create' ? t('common.add') : t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
