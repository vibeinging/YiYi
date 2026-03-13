import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { listen } from '@tauri-apps/api/event';
import { ptyWrite, ptyResize, ptyClose } from '../api/pty';
import '@xterm/xterm/css/xterm.css';

interface PtyTerminalProps {
  sessionId: string;
  onClose?: () => void;
}

export default function PtyTerminal({ sessionId, onClose }: PtyTerminalProps) {
  const termRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const handleClose = useCallback(async () => {
    try {
      await ptyClose(sessionId);
    } catch { /* ignore */ }
    onClose?.();
  }, [sessionId, onClose]);

  useEffect(() => {
    if (!termRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
      theme: {
        background: '#1a1a2e',
        foreground: '#e0e0e0',
        cursor: '#a78bfa',
        selectionBackground: '#a78bfa40',
      },
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());

    terminal.open(termRef.current);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Listen for PTY output
    const unlistenOutput = listen<{ sessionId: string; data: string }>(
      'pty://output',
      (event) => {
        if (event.payload.sessionId === sessionId) {
          const bytes = Uint8Array.from(atob(event.payload.data), (c) => c.charCodeAt(0));
          terminal.write(bytes);
        }
      }
    );

    // Listen for PTY close
    const unlistenClosed = listen<{ sessionId: string }>(
      'pty://closed',
      (event) => {
        if (event.payload.sessionId === sessionId) {
          terminal.write('\r\n\x1b[90m[Process exited]\x1b[0m\r\n');
        }
      }
    );

    // Send user input to PTY
    const onData = terminal.onData(async (data) => {
      try {
        const b64 = btoa(data);
        await ptyWrite(sessionId, b64);
      } catch { /* ignore */ }
    });

    // Handle resize
    const observer = new ResizeObserver(() => {
      fitAddon.fit();
      const { cols, rows } = terminal;
      ptyResize(sessionId, cols, rows).catch(() => {});
    });
    observer.observe(termRef.current);

    return () => {
      observer.disconnect();
      onData.dispose();
      unlistenOutput.then((f) => f());
      unlistenClosed.then((f) => f());
      terminal.dispose();
    };
  }, [sessionId]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-1.5 bg-[var(--color-bg-elevated)] border-b border-[var(--color-border)]">
        <span className="text-xs text-[var(--color-text-secondary)] font-mono">
          Terminal
        </span>
        <button
          onClick={handleClose}
          className="text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
        >
          Close
        </button>
      </div>
      <div ref={termRef} className="flex-1 min-h-0" />
    </div>
  );
}
