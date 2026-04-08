/**
 * PermissionGuide — macOS permission check overlay.
 *
 * Checks Accessibility, Screen Recording, and Microphone permissions.
 * If all granted, renders children transparently.
 * If any missing, shows a modal with status and request buttons.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Shield,
  Monitor,
  Mic,
  CheckCircle2,
  XCircle,
  RefreshCw,
  ExternalLink,
  Loader2,
  RotateCcw,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import {
  checkPermissions,
  requestAccessibility,
  requestScreenRecording,
  requestMicrophone,
  type PermissionStatus,
} from '../../api/permissions';

interface PermissionGuideProps {
  /** Which permissions to require. Defaults to all three. */
  require?: ('accessibility' | 'screen_recording' | 'microphone')[];
  /** Called when all required permissions are granted. */
  onAllGranted?: () => void;
  /** Called when user dismisses the guide without all permissions. */
  onDismiss?: () => void;
  children?: React.ReactNode;
}

interface PermissionItem {
  key: keyof PermissionStatus;
  label: string;
  description: string;
  icon: React.ReactNode;
  request: () => Promise<void>;
}

export function PermissionGuide({
  require = ['accessibility', 'screen_recording', 'microphone'],
  onAllGranted,
  onDismiss,
  children,
}: PermissionGuideProps) {
  const [status, setStatus] = useState<PermissionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [requesting, setRequesting] = useState<string | null>(null);
  // Accessibility and Screen Recording need app restart after granting
  const [needsRestart, setNeedsRestart] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const s = await checkPermissions();
      setStatus(s);
    } catch (err) {
      console.error('Failed to check permissions:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Check if all required permissions are granted
  const allGranted =
    status != null &&
    require.every((key) => status[key]);

  // Use ref to avoid re-firing when callback reference changes
  const onAllGrantedRef = useRef(onAllGranted);
  onAllGrantedRef.current = onAllGranted;

  useEffect(() => {
    if (allGranted) {
      onAllGrantedRef.current?.();
    }
  }, [allGranted]);

  // If all granted, render children transparently
  if (allGranted) {
    return <>{children}</>;
  }

  const permissions: PermissionItem[] = [
    {
      key: 'accessibility',
      label: 'Accessibility',
      description:
        'Required for keyboard/mouse control and UI automation.',
      icon: <Shield size={20} />,
      request: async () => {
        setRequesting('accessibility');
        try {
          await requestAccessibility();
          setNeedsRestart(true);
        } finally {
          setRequesting(null);
        }
      },
    },
    {
      key: 'screen_recording',
      label: 'Screen Recording',
      description:
        'Required for taking screenshots and reading screen content.',
      icon: <Monitor size={20} />,
      request: async () => {
        setRequesting('screen_recording');
        try {
          await requestScreenRecording();
          setNeedsRestart(true);
        } finally {
          setRequesting(null);
        }
      },
    },
    {
      key: 'microphone',
      label: 'Microphone',
      description:
        'Required for voice input and speech recognition.',
      icon: <Mic size={20} />,
      request: async () => {
        setRequesting('microphone');
        try {
          await requestMicrophone();
        } finally {
          setRequesting(null);
        }
      },
    },
  ];

  const visiblePermissions = permissions.filter((p) =>
    require.includes(p.key),
  );

  return (
    <div
      className="permission-backdrop-enter"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        className="permission-modal-enter"
        style={{
          background: 'var(--color-bg-elevated, #1a1a2e)',
          border: '1px solid var(--color-border, rgba(255,255,255,0.1))',
          borderRadius: 'var(--radius-xl, 18px)',
          padding: 32,
          maxWidth: 480,
          width: '90vw',
          boxShadow: '0 24px 48px rgba(0, 0, 0, 0.3)',
        }}
      >
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              background: 'var(--color-primary, #6366f1)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 16,
            }}
          >
            <Shield size={28} color="white" />
          </div>
          <h2
            style={{
              fontSize: 20,
              fontWeight: 600,
              color: 'var(--color-text, #e2e8f0)',
              margin: '0 0 8px 0',
            }}
          >
            Permissions Required
          </h2>
          <p
            style={{
              fontSize: 14,
              color: 'var(--color-text-secondary, #94a3b8)',
              margin: 0,
              lineHeight: 1.5,
            }}
          >
            YiYi needs the following permissions to enable voice control
            and computer automation features.
          </p>
        </div>

        {/* Permission list */}
        {loading ? (
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              padding: 24,
            }}
          >
            <Loader2
              size={24}
              className="animate-spin"
              style={{ color: 'var(--color-primary, #6366f1)' }}
            />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {visiblePermissions.map((perm) => {
              const granted = status?.[perm.key] ?? false;
              const isRequesting = requesting === perm.key;

              return (
                <div
                  key={perm.key}
                  className="permission-item"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '12px 16px',
                    borderRadius: 12,
                    border: `1px solid ${
                      granted
                        ? 'rgba(34, 197, 94, 0.3)'
                        : 'var(--color-border, rgba(255,255,255,0.1))'
                    }`,
                    background: granted
                      ? 'rgba(34, 197, 94, 0.05)'
                      : 'var(--color-bg-secondary, rgba(255,255,255,0.03))',
                    transition: 'all 0.2s ease',
                  }}
                >
                  {/* Icon */}
                  <div
                    style={{
                      flexShrink: 0,
                      color: granted
                        ? '#22c55e'
                        : 'var(--color-text-secondary, #94a3b8)',
                    }}
                  >
                    {perm.icon}
                  </div>

                  {/* Text */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 500,
                        color: 'var(--color-text, #e2e8f0)',
                      }}
                    >
                      {perm.label}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: 'var(--color-text-secondary, #94a3b8)',
                        marginTop: 2,
                      }}
                    >
                      {perm.description}
                    </div>
                  </div>

                  {/* Status / Action */}
                  {granted ? (
                    <CheckCircle2
                      size={20}
                      style={{ flexShrink: 0, color: '#22c55e' }}
                    />
                  ) : (
                    <button
                      onClick={perm.request}
                      disabled={isRequesting}
                      style={{
                        flexShrink: 0,
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        padding: '6px 12px',
                        borderRadius: 8,
                        border: 'none',
                        background: 'var(--color-primary, #6366f1)',
                        color: 'white',
                        fontSize: 12,
                        fontWeight: 500,
                        cursor: isRequesting ? 'wait' : 'pointer',
                        opacity: isRequesting ? 0.7 : 1,
                        transition: 'opacity 0.15s',
                      }}
                    >
                      {isRequesting ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <ExternalLink size={14} />
                      )}
                      Grant
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Restart hint */}
        {needsRestart && (
          <div
            className="restart-hint-enter"
            style={{
              marginTop: 16,
              padding: '10px 14px',
              borderRadius: 10,
              background: 'rgba(234, 179, 8, 0.1)',
              border: '1px solid rgba(234, 179, 8, 0.3)',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              fontSize: 13,
              color: 'var(--color-text, #e2e8f0)',
              lineHeight: 1.4,
            }}
          >
            <RotateCcw size={16} style={{ flexShrink: 0, color: '#eab308' }} />
            <span>
              辅助功能和屏幕录制权限需要<strong>重启 App</strong> 才能生效。
              在系统设置中授权后，请点击重启。
            </span>
          </div>
        )}

        {/* Footer actions */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: needsRestart ? 16 : 24,
            paddingTop: 16,
            borderTop:
              '1px solid var(--color-border, rgba(255,255,255,0.1))',
          }}
        >
          {onDismiss && (
            <button
              onClick={onDismiss}
              style={{
                padding: '8px 16px',
                borderRadius: 8,
                border: '1px solid var(--color-border, rgba(255,255,255,0.1))',
                background: 'transparent',
                color: 'var(--color-text-secondary, #94a3b8)',
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              稍后再说
            </button>
          )}

          <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
            <button
              onClick={refresh}
              disabled={loading}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 16px',
                borderRadius: 8,
                border: 'none',
                background: 'var(--color-bg-secondary, rgba(255,255,255,0.06))',
                color: 'var(--color-text, #e2e8f0)',
                fontSize: 13,
                fontWeight: 500,
                cursor: loading ? 'wait' : 'pointer',
              }}
            >
              <RefreshCw
                size={14}
                className={loading ? 'animate-spin' : ''}
              />
              刷新
            </button>

            {needsRestart && (
              <button
                onClick={async () => {
                  try {
                    await invoke('relaunch', {});
                  } catch {
                    // tauri-plugin-process relaunch
                    const { relaunch } = await import('@tauri-apps/plugin-process')
                    await relaunch()
                  }
                }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '8px 16px',
                  borderRadius: 8,
                  border: 'none',
                  background: 'var(--color-primary, #6366f1)',
                  color: 'white',
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                <RotateCcw size={14} />
                重启 App
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Hook to check permissions imperatively.
 * Returns { status, allGranted, refresh, loading }.
 */
export function usePermissions(
  required: (keyof PermissionStatus)[] = [
    'accessibility',
    'screen_recording',
    'microphone',
  ],
) {
  const [status, setStatus] = useState<PermissionStatus | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const s = await checkPermissions();
      setStatus(s);
      return s;
    } catch {
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const allGranted =
    status != null && required.every((key) => status[key]);

  return { status, allGranted, refresh, loading };
}
