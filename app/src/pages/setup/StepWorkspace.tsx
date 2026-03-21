/**
 * Setup Wizard - Workspace setup step
 */

import { FolderOpen, Loader2, Shield } from 'lucide-react';
import type { AuthorizedFolder } from '../../api/workspace';
import type { Lang } from './setupWizardData';

export interface StepWorkspaceProps {
  lang: Lang;
  workspacePath: string;
  authorizedFolders: AuthorizedFolder[];
  workspaceLoading: boolean;
  onPickFolder: () => void;
  onRemoveFolder: (id: string) => void;
}

export function StepWorkspace({
  lang,
  workspacePath,
  authorizedFolders,
  workspaceLoading,
  onPickFolder,
  onRemoveFolder,
}: StepWorkspaceProps) {
  return (
    <div className="pt-10">
      <div className="text-center mb-10">
        <div className="w-20 h-20 rounded-3xl bg-[var(--color-primary-subtle)] flex items-center justify-center mx-auto mb-8">
          <FolderOpen size={36} className="text-[var(--color-primary)]" />
        </div>
        <h1 className="text-4xl font-extrabold mb-4 tracking-tight" style={{ color: 'var(--color-text)' }}>
          {lang === 'zh' ? '工作空间设置' : 'Workspace Setup'}
        </h1>
        <p className="text-[16px]" style={{ color: 'var(--color-text-secondary)' }}>
          {lang === 'zh'
            ? 'Agent 生成的文件将保存到默认工作目录，你也可以授权额外的文件夹'
            : 'Agent-generated files are saved to the default workspace. You can also authorize additional folders.'}
        </p>
      </div>

      {/* Default workspace */}
      <div className="mb-8 sw-stagger-1">
        <div className="text-[13px] font-semibold mb-3 uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
          {lang === 'zh' ? '默认工作目录' : 'Default Workspace'}
        </div>
        <div
          className="flex items-center gap-4 px-5 py-4 rounded-xl"
          style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)' }}
        >
          <FolderOpen size={20} style={{ color: 'var(--color-primary)' }} />
          <code className="text-[14px] flex-1 truncate" style={{ color: 'var(--color-text)' }}>
            {workspacePath || '~/Documents/YiYi'}
          </code>
          <div
            className="px-3 py-1 rounded-lg text-[11px] font-semibold"
            style={{ background: 'var(--color-success)', color: '#fff' }}
          >
            {lang === 'zh' ? '读写' : 'R/W'}
          </div>
        </div>
        <p className="text-[12px] mt-2" style={{ color: 'var(--color-text-tertiary)' }}>
          {lang === 'zh'
            ? '此目录由系统管理，Agent 会将产物（代码、文档、图片等）保存到这里'
            : 'Managed by the system. Agent saves generated files (code, docs, images) here.'}
        </p>
      </div>

      {/* Authorized folders */}
      <div className="mb-6 sw-stagger-2">
        <div className="flex items-center justify-between mb-2">
          <div className="text-[12px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
            {lang === 'zh' ? '授权文件夹' : 'Authorized Folders'}
          </div>
          <button
            onClick={onPickFolder}
            disabled={workspaceLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors"
            style={{ background: 'var(--color-primary)', color: '#fff' }}
          >
            {workspaceLoading ? <Loader2 size={12} className="animate-spin" /> : <>+ {lang === 'zh' ? '添加文件夹' : 'Add Folder'}</>}
          </button>
        </div>

        {authorizedFolders.filter(f => !f.is_default).length === 0 ? (
          <div
            className="px-4 py-6 rounded-xl text-center text-[13px]"
            style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-tertiary)', border: '1px dashed var(--color-border)' }}
          >
            {lang === 'zh'
              ? '暂无额外授权文件夹。Agent 仅能访问默认工作目录。'
              : 'No extra folders authorized. Agent can only access the default workspace.'}
          </div>
        ) : (
          <div className="space-y-2">
            {authorizedFolders.filter(f => !f.is_default).map(folder => (
              <div
                key={folder.id}
                className="flex items-center gap-3 px-4 py-2.5 rounded-xl group"
                style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)' }}
              >
                <FolderOpen size={16} style={{ color: 'var(--color-text-muted)' }} />
                <code className="text-[12px] flex-1 truncate" style={{ color: 'var(--color-text)' }}>
                  {folder.path}
                </code>
                <div
                  className="px-2 py-0.5 rounded text-[10px] font-medium"
                  style={{
                    background: folder.permission === 'read_write' ? 'var(--color-success)' : 'var(--color-warning)',
                    color: '#fff',
                  }}
                >
                  {folder.permission === 'read_write' ? (lang === 'zh' ? '读写' : 'R/W') : (lang === 'zh' ? '只读' : 'R/O')}
                </div>
                <button
                  onClick={() => onRemoveFolder(folder.id)}
                  className="opacity-0 group-hover:opacity-100 text-[12px] px-1.5 py-0.5 rounded transition-opacity"
                  style={{ color: 'var(--color-danger)' }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        <p className="text-[11px] mt-1.5" style={{ color: 'var(--color-text-tertiary)' }}>
          {lang === 'zh'
            ? '授权后 Agent 可读写这些文件夹。可随时在设置中修改。'
            : 'Agent can read/write these folders once authorized. Adjustable in Settings anytime.'}
        </p>
      </div>

      {/* Security note */}
      <div
        className="flex items-start gap-3 px-4 py-3 rounded-xl sw-stagger-3"
        style={{ background: 'var(--color-bg-subtle)', border: '1px solid var(--color-border)' }}
      >
        <Shield size={18} className="shrink-0 mt-0.5" style={{ color: 'var(--color-warning)' }} />
        <div>
          <div className="text-[12px] font-semibold mb-0.5" style={{ color: 'var(--color-text)' }}>
            {lang === 'zh' ? '敏感文件保护' : 'Sensitive File Protection'}
          </div>
          <div className="text-[11px] leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
            {lang === 'zh'
              ? '系统内置了 .env、.ssh、.pem 等敏感文件的保护规则，即使在授权文件夹中也会被拦截。可在设置中查看和管理。'
              : 'Built-in protection rules for .env, .ssh, .pem and other sensitive files. These are blocked even in authorized folders. Manage in Settings.'}
          </div>
        </div>
      </div>
    </div>
  );
}
