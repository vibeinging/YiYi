/**
 * Global toast notification & confirm dialog system.
 *
 * Usage:
 *   import { toast, confirm } from '../components/Toast';
 *   toast.success('Saved!');
 *   toast.error('Something went wrong');
 *   toast.info('Hint message');
 *   const ok = await confirm('Delete this item?');
 */

import { useState, useEffect, useCallback, createContext, useContext } from 'react';
import { Check, X, Info, AlertTriangle } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ToastType = 'success' | 'error' | 'info' | 'warning';

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
}

interface ConfirmState {
  message: string;
  resolve: (value: boolean) => void;
}

interface ToastContextValue {
  showToast: (type: ToastType, message: string) => void;
  showConfirm: (message: string) => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const ToastContext = createContext<ToastContextValue | null>(null);

let _globalToast: ToastContextValue | null = null;

// ---------------------------------------------------------------------------
// Imperative API (usable outside React components)
// ---------------------------------------------------------------------------

export const toast = {
  success: (msg: string) => _globalToast?.showToast('success', msg),
  error: (msg: string) => _globalToast?.showToast('error', msg),
  info: (msg: string) => _globalToast?.showToast('info', msg),
  warning: (msg: string) => _globalToast?.showToast('warning', msg),
};

export const confirm = (message: string): Promise<boolean> => {
  return _globalToast?.showConfirm(message) ?? Promise.resolve(false);
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

let nextId = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);

  const showToast = useCallback((type: ToastType, message: string) => {
    const id = ++nextId;
    setToasts(prev => [...prev, { id, type, message }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3500);
  }, []);

  const showConfirm = useCallback((message: string): Promise<boolean> => {
    return new Promise(resolve => {
      setConfirmState({ message, resolve });
    });
  }, []);

  const handleConfirm = (value: boolean) => {
    confirmState?.resolve(value);
    setConfirmState(null);
  };

  const ctx: ToastContextValue = { showToast, showConfirm };

  useEffect(() => {
    _globalToast = ctx;
    return () => { _globalToast = null; };
  });

  return (
    <ToastContext.Provider value={ctx}>
      {children}

      {/* Toast container */}
      <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none" style={{ maxWidth: 380 }}>
        {toasts.map(t => (
          <ToastNotification key={t.id} item={t} onDismiss={() => setToasts(prev => prev.filter(x => x.id !== t.id))} />
        ))}
      </div>

      {/* Confirm dialog */}
      {confirmState && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 animate-fade-in">
          <div
            className="rounded-2xl p-6 w-full max-w-sm shadow-xl animate-scale-in"
            style={{ background: 'var(--color-bg-elevated)' }}
          >
            <div className="flex items-start gap-3 mb-5">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ background: 'rgba(251,191,36,0.12)' }}>
                <AlertTriangle size={18} style={{ color: 'var(--color-warning, #F59E0B)' }} />
              </div>
              <p className="text-[14px] leading-relaxed pt-1.5" style={{ color: 'var(--color-text)' }}>
                {confirmState.message}
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => handleConfirm(false)}
                className="px-4 py-2 rounded-xl text-[13px] font-medium transition-colors"
                style={{ color: 'var(--color-text-secondary)' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
              >
                取消
              </button>
              <button
                onClick={() => handleConfirm(true)}
                className="px-4 py-2 rounded-xl text-[13px] font-medium transition-colors"
                style={{ background: 'var(--color-primary)', color: '#FFFFFF' }}
              >
                确认
              </button>
            </div>
          </div>
        </div>
      )}
    </ToastContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Single toast notification
// ---------------------------------------------------------------------------

const iconMap = {
  success: Check,
  error: X,
  info: Info,
  warning: AlertTriangle,
};

const colorMap: Record<ToastType, { bg: string; icon: string; border: string }> = {
  success: { bg: 'rgba(34,197,94,0.08)', icon: 'var(--color-success, #22C55E)', border: 'rgba(34,197,94,0.2)' },
  error: { bg: 'rgba(239,68,68,0.08)', icon: 'var(--color-error, #EF4444)', border: 'rgba(239,68,68,0.2)' },
  info: { bg: 'rgba(59,130,246,0.08)', icon: 'var(--color-info, #3B82F6)', border: 'rgba(59,130,246,0.2)' },
  warning: { bg: 'rgba(251,191,36,0.08)', icon: 'var(--color-warning, #F59E0B)', border: 'rgba(251,191,36,0.2)' },
};

function ToastNotification({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const Icon = iconMap[item.type];
  const colors = colorMap[item.type];

  return (
    <div
      className="pointer-events-auto flex items-center gap-2.5 px-4 py-3 rounded-xl text-[13px] font-medium shadow-lg animate-slide-in-right"
      style={{
        background: 'var(--color-bg-elevated)',
        border: `1px solid ${colors.border}`,
        backdropFilter: 'blur(20px)',
        color: 'var(--color-text)',
      }}
    >
      <div className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: colors.bg }}>
        <Icon size={14} style={{ color: colors.icon }} />
      </div>
      <span className="flex-1 min-w-0 break-words">{item.message}</span>
      <button onClick={onDismiss} className="flex-shrink-0 p-0.5 rounded opacity-40 hover:opacity-100 transition-opacity">
        <X size={12} />
      </button>
    </div>
  );
}
