/**
 * TerminalView — Embedded terminal using xterm.js + tauri-plugin-pty.
 * Used in task detail views to show real-time command execution logs.
 * NOT a standalone terminal page — only renders within task/agent contexts.
 */

import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'
import { FitAddon } from '@xterm/addon-fit'
import { spawn } from 'tauri-pty'
import { useTheme } from '../hooks/useTheme'
import '@xterm/xterm/css/xterm.css'

interface TerminalViewProps {
  /** Initial command to execute. If not provided, spawns an interactive shell. */
  command?: string
  /** Command arguments */
  args?: string[]
  /** Working directory */
  cwd?: string
  /** Terminal height in pixels. If undefined, fills parent container. */
  height?: number
  /** Called when the PTY process exits */
  onExit?: (code: number) => void
  /** If true, terminal is read-only (no user input) */
  readOnly?: boolean
}

export function TerminalView({
  command,
  args = [],
  cwd,
  height = 300,
  onExit,
  readOnly = false,
}: TerminalViewProps) {
  const { appliedTheme } = useTheme()
  const isDark = appliedTheme === 'dark'
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const ptyRef = useRef<any>(null)
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit
  const [exited, setExited] = useState(false)

  const initTerminal = useCallback(async () => {
    if (!containerRef.current) return

    const term = new Terminal({
      fontSize: 13,
      fontFamily: 'var(--font-mono, "SF Mono", "Fira Code", monospace)',
      theme: isDark ? {
        // Soft dark — warm charcoal, not pure black
        background: '#242630',
        foreground: '#b4bcd0',
        cursor: '#8b95a8',
        cursorAccent: '#242630',
        selectionBackground: '#3a3f52',
        selectionForeground: '#dde1ec',
        black: '#2c2e3a',
        red: '#e88388',
        green: '#a0cc8f',
        yellow: '#dbbc7f',
        blue: '#7fb4e0',
        magenta: '#c49eda',
        cyan: '#70c9c4',
        white: '#b4bcd0',
        brightBlack: '#4a4e5e',
        brightRed: '#f0999d',
        brightGreen: '#b5d9a5',
        brightYellow: '#e5ce98',
        brightBlue: '#99c8ed',
        brightMagenta: '#d4b5e8',
        brightCyan: '#8dd8d3',
        brightWhite: '#d5dae6',
      } : {
        // Soft light — warm ivory tones
        background: '#f5f3ef',
        foreground: '#4a4458',
        cursor: '#7c7490',
        cursorAccent: '#f5f3ef',
        selectionBackground: '#d8d4e8',
        selectionForeground: '#2e2a38',
        black: '#e8e5e0',
        red: '#c24a53',
        green: '#5a8a4a',
        yellow: '#9a7b3e',
        blue: '#4a78a8',
        magenta: '#8a5ea0',
        cyan: '#3a8a86',
        white: '#4a4458',
        brightBlack: '#9a95a5',
        brightRed: '#d45a63',
        brightGreen: '#6a9a5a',
        brightYellow: '#aa8b4e',
        brightBlue: '#5a88b8',
        brightMagenta: '#9a6eb0',
        brightCyan: '#4a9a96',
        brightWhite: '#2e2a38',
      },
      cursorBlink: !readOnly,
      disableStdin: readOnly,
      scrollback: 5000,
      convertEol: true,
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)

    // Try WebGL, fallback to canvas
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      // WebGL not available, canvas renderer is fine
    }

    fit.fit()
    termRef.current = term
    fitRef.current = fit

    // Spawn PTY
    const isWin = navigator.userAgent.includes('Windows')
    const shell = command || (isWin ? 'powershell.exe' : '/bin/zsh')
    const shellArgs = command ? args : []

    try {
      const pty = await spawn(shell, shellArgs, {
        cols: term.cols,
        rows: term.rows,
        cwd: cwd || undefined,
      })
      ptyRef.current = pty

      // PTY → Terminal
      pty.onData((data: string) => {
        term.write(data)
      })

      // Terminal → PTY (if not read-only)
      if (!readOnly) {
        term.onData((data: string) => {
          pty.write(data)
        })
      }

      // Handle PTY exit
      pty.onExit(({ exitCode }: { exitCode: number }) => {
        setExited(true)
        term.write(`\r\n\x1b[90m[进程退出，代码: ${exitCode}]\x1b[0m\r\n`)
        onExitRef.current?.(exitCode)
      })

      // Resize handling
      term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        pty.resize(cols, rows)
      })
    } catch (err) {
      term.write(`\x1b[31mFailed to spawn PTY: ${err}\x1b[0m\r\n`)
    }
  }, [command, cwd, readOnly, isDark]) // args and onExit via refs to avoid teardown

  useEffect(() => {
    initTerminal()

    return () => {
      ptyRef.current?.kill()
      termRef.current?.dispose()
    }
  }, [initTerminal])

  // Resize on container change
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      fitRef.current?.fit()
    })
    if (containerRef.current) observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="relative rounded-lg overflow-hidden" style={{ height: height ?? '100%' }}>
      <div
        ref={containerRef}
        className="w-full h-full"
      />
      {exited && (
        <div
          className="absolute top-2 right-2 text-[10px] px-2 py-0.5 rounded-full"
          style={{ background: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.5)' }}
        >
          已结束
        </div>
      )}
    </div>
  )
}
