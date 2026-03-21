/**
 * Colored dot indicating bot connection status
 */

import type { BotConnectionState } from '../../api/bots';

interface StatusDotProps {
  state: BotConnectionState;
  message?: string | null;
}

export function StatusDot({ state, message }: StatusDotProps) {
  const dotStyle: Record<BotConnectionState, { bg: string; pulse: boolean; label: string }> = {
    connected:    { bg: 'var(--color-success)',      pulse: true,  label: 'Connected' },
    connecting:   { bg: 'var(--color-warning, #EAB308)', pulse: false, label: 'Connecting' },
    reconnecting: { bg: 'var(--color-warning, #EAB308)', pulse: false, label: 'Reconnecting' },
    error:        { bg: 'var(--color-error)',         pulse: false, label: 'Error' },
    disconnected: { bg: 'var(--color-text-muted)',    pulse: false, label: 'Disconnected' },
  };
  const info = dotStyle[state] || dotStyle.disconnected;
  const title = message ? `${info.label}: ${message}` : info.label;

  return (
    <span className="relative inline-flex items-center" title={title}>
      {info.pulse && (
        <span
          className="absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping"
          style={{ background: info.bg }}
        />
      )}
      <span
        className="relative inline-block w-2 h-2 rounded-full"
        style={{ background: info.bg }}
      />
    </span>
  );
}
