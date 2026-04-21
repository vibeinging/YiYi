/**
 * Extensions Page — Unified extension marketplace.
 *
 * Combines Skills, Plugins, and MCP servers into one view.
 * Inspired by GlobalToolRegistry pattern — one place for all extensions.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Puzzle, Blocks, Zap } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { SkillsPage } from './Skills';
import { MCPPage } from './MCP';
import { PluginsPanel } from '../components/PluginsPanel';

type ExtensionTab = 'skills' | 'plugins' | 'mcp';

export function ExtensionsPage() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<ExtensionTab>('skills');

  const tabs: { id: ExtensionTab; label: string; icon: React.ComponentType<any>; desc: string }[] = [
    { id: 'skills', label: t('extensions.skills', '技能'), icon: Puzzle, desc: t('extensions.skillsDesc', '知识与指令') },
    { id: 'plugins', label: t('extensions.plugins', '插件'), icon: Blocks, desc: t('extensions.pluginsDesc', '可执行工具') },
    { id: 'mcp', label: t('extensions.mcp', 'MCP'), icon: Zap, desc: t('extensions.mcpDesc', '协议服务') },
  ];

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header + Tab bar */}
      <div className="shrink-0 px-8 pt-8 pb-0">
        <PageHeader
          title={t('extensions.title', '扩展市场')}
          description={t('extensions.description', '管理技能、插件和 MCP 服务')}
        />

        {/* Tab pills */}
        <div className="flex gap-1.5 mt-4 p-1 rounded-xl bg-[var(--color-bg-subtle)] w-fit">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-medium transition-all"
                style={{
                  background: isActive ? 'var(--color-bg-elevated)' : 'transparent',
                  color: isActive ? 'var(--color-text)' : 'var(--color-text-muted)',
                  boxShadow: isActive ? 'var(--shadow-sm)' : 'none',
                }}
              >
                <Icon size={15} />
                {tab.label}
                <span className="text-[10px] opacity-50 hidden sm:inline">{tab.desc}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'skills' && (
          <div className="h-full overflow-y-auto">
            <SkillsPage embedded />
          </div>
        )}
        {activeTab === 'plugins' && (
          <div className="h-full overflow-y-auto px-8 py-6">
            <PluginsPanel />
          </div>
        )}
        {activeTab === 'mcp' && (
          <div className="h-full overflow-y-auto">
            <MCPPage embedded />
          </div>
        )}
      </div>
    </div>
  );
}
