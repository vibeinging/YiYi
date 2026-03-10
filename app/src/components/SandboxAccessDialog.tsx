/**
 * SandboxAccessDialog - Prompt user when agent tries to access paths outside workspace.
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldAlert, FolderOpen, Clock, Pin, X } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

interface AccessRequest {
  id: string;
  path: string;
}

export function SandboxAccessDialog() {
  const { t } = useTranslation();
  const [request, setRequest] = useState<AccessRequest | null>(null);
  const [responding, setResponding] = useState(false);

  useEffect(() => {
    const unlisten = listen<AccessRequest>('sandbox://access_request', (event) => {
      setRequest(event.payload);
      setResponding(false);
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  const respond = async (response: 'allow_once' | 'allow_permanent' | 'deny') => {
    if (!request) return;
    setResponding(true);
    try {
      await invoke('sandbox_respond', { reqId: request.id, response });
    } catch (e) {
      console.error('Sandbox respond failed:', e);
    }
    setRequest(null);
    setResponding(false);
  };

  if (!request) return null;

  // Extract display-friendly path
  const displayPath = request.path.replace(/^\/Users\/[^/]+/, '~');

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[100] p-4 animate-fade-in">
      <div
        className="rounded-2xl w-full max-w-lg shadow-2xl animate-scale-in overflow-hidden"
        style={{ background: 'var(--color-bg-elevated)' }}
      >
        {/* Header */}
        <div className="px-6 pt-6 pb-4 flex items-start gap-4">
          <div
            className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: 'var(--color-warning)', opacity: 0.9 }}
          >
            <ShieldAlert size={22} color="#FFFFFF" />
          </div>
          <div className="min-w-0">
            <h2 className="font-semibold text-[16px] mb-1" style={{ color: 'var(--color-text)' }}>
              {t('sandbox.title')}
            </h2>
            <p className="text-[13px]" style={{ color: 'var(--color-text-muted)' }}>
              {t('sandbox.description')}
            </p>
          </div>
        </div>

        {/* Path display */}
        <div className="mx-6 mb-5 px-4 py-3 rounded-xl" style={{ background: 'var(--color-bg-subtle)' }}>
          <div className="flex items-center gap-2.5">
            <FolderOpen size={16} style={{ color: 'var(--color-primary)' }} className="shrink-0" />
            <code className="text-[13px] font-mono truncate" style={{ color: 'var(--color-text)' }}>
              {displayPath}
            </code>
          </div>
        </div>

        {/* Actions */}
        <div className="px-6 pb-6 flex flex-col gap-2">
          <button
            onClick={() => respond('allow_once')}
            disabled={responding}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-[13px] font-medium transition-all disabled:opacity-50"
            style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
          >
            <Clock size={16} style={{ color: 'var(--color-text-muted)' }} />
            <div className="text-left">
              <div>{t('sandbox.allowOnce')}</div>
              <div className="text-[11px] font-normal" style={{ color: 'var(--color-text-muted)' }}>
                {t('sandbox.allowOnceDesc')}
              </div>
            </div>
          </button>

          <button
            onClick={() => respond('allow_permanent')}
            disabled={responding}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-[13px] font-medium transition-all disabled:opacity-50"
            style={{ background: 'var(--color-bg-subtle)', color: 'var(--color-text)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
          >
            <Pin size={16} style={{ color: 'var(--color-primary)' }} />
            <div className="text-left">
              <div>{t('sandbox.allowPermanent')}</div>
              <div className="text-[11px] font-normal" style={{ color: 'var(--color-text-muted)' }}>
                {t('sandbox.allowPermanentDesc')}
              </div>
            </div>
          </button>

          <button
            onClick={() => respond('deny')}
            disabled={responding}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-[13px] font-medium transition-all disabled:opacity-50"
            style={{ background: 'transparent', color: 'var(--color-error)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            <X size={16} />
            <div className="text-left">
              <div>{t('sandbox.deny')}</div>
              <div className="text-[11px] font-normal" style={{ color: 'var(--color-text-muted)' }}>
                {t('sandbox.denyDesc')}
              </div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
