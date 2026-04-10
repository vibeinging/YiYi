/**
 * Inline permission request card — renders in the chat stream when
 * the agent needs user authorization to proceed.
 */

import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Shield, ShieldAlert, ShieldCheck, ShieldX, FolderOpen, Terminal, FileWarning, Monitor } from 'lucide-react';
import { useChatStreamStore, type PermissionRequestState } from '../../stores/chatStreamStore';

const TYPE_CONFIG: Record<string, {
  icon: typeof Shield;
  label: string;
  color: string;
}> = {
  folder_access: { icon: FolderOpen, label: '文件夹访问', color: 'var(--color-primary)' },
  folder_write: { icon: FolderOpen, label: '写入权限', color: 'var(--color-warning, #f59e0b)' },
  shell_block: { icon: Terminal, label: '危险命令', color: 'var(--color-error)' },
  shell_warn: { icon: Terminal, label: '可疑命令', color: 'var(--color-warning, #f59e0b)' },
  sensitive_path: { icon: FileWarning, label: '敏感文件', color: 'var(--color-error)' },
  permission_mode: { icon: ShieldAlert, label: '需要授权', color: 'var(--color-warning, #f59e0b)' },
  computer_control: { icon: Monitor, label: '电脑控制', color: 'var(--color-error)' },
};

function truncatePath(path: string, max: number = 80): string {
  if (path.length <= max) return path;
  return '…' + path.slice(path.length - max + 1);
}

export function PermissionCard({ request }: { request: PermissionRequestState }) {
  const [responding, setResponding] = useState(false);
  const resolvePermission = useChatStreamStore((s) => s.resolvePermission);

  const config = TYPE_CONFIG[request.permissionType] || {
    icon: Shield,
    label: '权限请求',
    color: 'var(--color-text-muted)',
  };
  const Icon = config.icon;
  const isResolved = request.status !== 'pending';

  const handleResponse = async (approved: boolean) => {
    if (responding || isResolved) return;
    setResponding(true);

    const status = approved ? 'approved' : 'denied';
    resolvePermission(status);

    let addFolder: string | null = null;
    let upgradePermission: string | null = null;

    if (approved) {
      if (request.permissionType === 'folder_access' && request.parentFolder) {
        addFolder = request.parentFolder;
      } else if (request.permissionType === 'folder_write' && request.parentFolder) {
        upgradePermission = request.parentFolder;
      }
    }

    try {
      await invoke('respond_permission_request', {
        requestId: request.requestId,
        approved,
        addFolder,
        upgradePermission,
      });
    } catch {
      // Backend may have timed out
    }
    setResponding(false);
  };

  return (
    <div
      className="my-2 rounded-xl border overflow-hidden transition-all"
      style={{
        borderColor: isResolved ? 'var(--color-border)' : config.color,
        background: 'var(--color-bg-elevated)',
        opacity: isResolved ? 0.7 : 1,
      }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-2 text-[12px] font-medium"
        style={{ background: isResolved ? 'var(--color-bg-subtle)' : `color-mix(in srgb, ${config.color} 10%, var(--color-bg-elevated))` }}
      >
        <Icon size={14} style={{ color: config.color }} />
        <span style={{ color: config.color }}>{config.label}</span>
        {isResolved && (
          <span className="ml-auto flex items-center gap-1 text-[11px]" style={{ color: request.status === 'approved' ? 'var(--color-success)' : 'var(--color-error)' }}>
            {request.status === 'approved' ? <ShieldCheck size={12} /> : <ShieldX size={12} />}
            {request.status === 'approved' ? '已授权' : '已拒绝'}
          </span>
        )}
      </div>

      {/* Body */}
      <div className="px-3 py-2">
        <div className="text-[12px] truncate" style={{ color: 'var(--color-text)' }} title={request.path}>
          {request.path}
        </div>
        {request.reason && (
          <div className="text-[11px] mt-1" style={{ color: 'var(--color-text-muted)' }}>
            {request.reason}
          </div>
        )}
        {request.parentFolder && request.permissionType === 'folder_access' && (
          <div className="text-[11px] mt-1" style={{ color: 'var(--color-text-secondary)' }}>
            将授权文件夹: {truncatePath(request.parentFolder, 60)}
          </div>
        )}
      </div>

      {/* Actions */}
      {!isResolved && (
        <div className="flex gap-2 px-3 pb-2">
          <button
            onClick={() => handleResponse(true)}
            disabled={responding}
            className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[12px] font-medium transition-colors disabled:opacity-50"
            style={{ background: 'var(--color-primary)', color: '#FFFFFF' }}
          >
            <ShieldCheck size={12} />
            允许
          </button>
          <button
            onClick={() => handleResponse(false)}
            disabled={responding}
            className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[12px] font-medium transition-colors disabled:opacity-50"
            style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text-secondary)' }}
          >
            <ShieldX size={12} />
            拒绝
          </button>
        </div>
      )}
    </div>
  );
}
