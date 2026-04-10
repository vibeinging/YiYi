/**
 * PluginsPanel — Plugin management UI for Settings page.
 * Lists all plugins with toggle, tool count, and reload action.
 */

import { useState, useEffect, useCallback } from 'react';
import { Puzzle, RefreshCw, Loader2, Wrench, Zap } from 'lucide-react';
import { listPlugins, enablePlugin, disablePlugin, reloadPlugins, type PluginInfo } from '../api/plugins';
import { toast } from './Toast';

export function PluginsPanel() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloading, setReloading] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listPlugins();
      setPlugins(data);
    } catch (e) {
      console.error('Failed to load plugins:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleToggle = async (plugin: PluginInfo) => {
    setTogglingId(plugin.id);
    try {
      if (plugin.enabled) {
        await disablePlugin(plugin.id);
      } else {
        await enablePlugin(plugin.id);
      }
      await load();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setTogglingId(null);
    }
  };

  const handleReload = async () => {
    setReloading(true);
    try {
      const count = await reloadPlugins();
      toast.success(`已重新加载 ${count} 个插件`);
      await load();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setReloading(false);
    }
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
      {/* Plugin List */}
      <div className="p-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <Puzzle size={18} className="text-[var(--color-primary)]" />
            <h2 className="font-semibold text-[14px]">插件列表</h2>
          </div>
          <button
            onClick={handleReload}
            disabled={reloading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors disabled:opacity-50"
            style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-primary)' }}
            onMouseEnter={(e) => { if (!reloading) e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
          >
            {reloading ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <RefreshCw size={13} />
            )}
            {reloading ? '重新加载中...' : '重新加载'}
          </button>
        </div>
        <p className="text-[12px] text-[var(--color-text-muted)] mb-4 ml-[26px]">
          管理已安装的插件，启用或禁用功能扩展
        </p>

        {plugins.length === 0 ? (
          <div className="py-10 text-center">
            <Puzzle size={32} className="mx-auto mb-3 opacity-20" style={{ color: 'var(--color-text-muted)' }} />
            <div className="text-[13px] text-[var(--color-text-muted)]">
              暂无已安装的插件
            </div>
            <div className="text-[12px] text-[var(--color-text-muted)] mt-1 opacity-70">
              将插件放入 ~/.yiyi/plugins/ 目录后点击"重新加载"
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            {plugins.map((plugin) => (
              <div
                key={plugin.id}
                className="group flex items-center gap-3 p-3 rounded-xl hover:bg-[var(--color-bg-subtle)] transition-colors"
              >
                {/* Toggle */}
                <button
                  onClick={() => handleToggle(plugin)}
                  disabled={togglingId === plugin.id}
                  className="relative w-9 h-5 rounded-full transition-colors shrink-0 disabled:opacity-50"
                  style={{ background: plugin.enabled ? 'var(--color-success)' : 'var(--color-bg-muted)' }}
                >
                  <div
                    className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform"
                    style={{ transform: plugin.enabled ? 'translateX(18px)' : 'translateX(2px)' }}
                  />
                </button>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium" style={{ color: 'var(--color-text)' }}>
                      {plugin.name}
                    </span>
                    <span
                      className="px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0"
                      style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-muted)' }}
                    >
                      v{plugin.version}
                    </span>
                  </div>
                  <div className="text-[12px] truncate" style={{ color: 'var(--color-text-muted)' }}>
                    {plugin.description || '无描述'}
                  </div>
                </div>

                {/* Badges */}
                <div className="flex items-center gap-2 shrink-0">
                  {plugin.tool_count > 0 && (
                    <span
                      className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium"
                      style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-secondary)' }}
                      title={`${plugin.tool_count} 个工具`}
                    >
                      <Wrench size={10} />
                      {plugin.tool_count}
                    </span>
                  )}
                  {plugin.has_hooks && (
                    <span
                      className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium"
                      style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-secondary)' }}
                      title="包含生命周期钩子"
                    >
                      <Zap size={10} />
                      Hooks
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
