/**
 * Shell API
 */

import { invoke } from '@tauri-apps/api/core';

export interface ShellResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * 执行 shell 命令
 */
export async function execute_shell(
  command: string,
  args?: string[],
  cwd?: string
): Promise<ShellResult> {
  return await invoke<ShellResult>('execute_shell', {
    command,
    args,
    cwd,
  });
}

/**
 * 流式执行 shell 命令
 */
export async function execute_shell_stream(
  command: string,
  args?: string[],
  cwd?: string
): Promise<string> {
  return await invoke<string>('execute_shell_stream', {
    command,
    args,
    cwd,
  });
}
