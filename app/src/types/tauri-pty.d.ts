declare module 'tauri-pty' {
  interface PtyOptions {
    cols?: number
    rows?: number
    cwd?: string
    env?: Record<string, string>
  }

  interface PtyExitEvent {
    exitCode: number
  }

  interface PtyProcess {
    onData(callback: (data: string) => void): void
    onExit(callback: (event: PtyExitEvent) => void): void
    write(data: string): void
    resize(cols: number, rows: number): void
    kill(): void
  }

  export function spawn(
    file: string,
    args?: string[],
    options?: PtyOptions,
  ): Promise<PtyProcess>
}
