// DeepSeek platform integration API.
//
// Two surfaces:
//   1. `getDeepSeekBalance()` — calls the backend, which queries
//      https://api.deepseek.com/user/balance with the saved API key. The key
//      never leaves Rust.
//   2. `openDeepSeekWindow(target)` — spawns a sandboxed Tauri WebviewWindow
//      pointed at platform.deepseek.com. The window has zero IPC permissions
//      (see `capabilities/deepseek-window.json`) so the loaded third-party
//      page cannot call any YiYi command.
//   3. `tryReadClipboardKey()` — user-initiated clipboard read with strict
//      regex validation. Only matches DeepSeek key shape (`sk-` + 32+ hex/
//      base64 chars). Never auto-fires.

import { invoke } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

export interface DeepSeekBalanceInfo {
  currency: string;
  total_balance: string;
  granted_balance: string;
  topped_up_balance: string;
}

export interface DeepSeekBalance {
  is_available: boolean;
  balance_infos: DeepSeekBalanceInfo[];
}

export async function getDeepSeekBalance(): Promise<DeepSeekBalance> {
  return await invoke<DeepSeekBalance>('get_deepseek_balance');
}

export type DeepSeekWindowTarget = 'keys' | 'top_up' | 'usage' | 'login';

const TARGET_URLS: Record<DeepSeekWindowTarget, string> = {
  keys: 'https://platform.deepseek.com/api_keys',
  top_up: 'https://platform.deepseek.com/top_up',
  usage: 'https://platform.deepseek.com/usage',
  login: 'https://platform.deepseek.com/sign_in',
};

const TITLE_ZH: Record<DeepSeekWindowTarget, string> = {
  keys: 'DeepSeek · 创建 API Key',
  top_up: 'DeepSeek · 充值',
  usage: 'DeepSeek · 用量与账单',
  login: 'DeepSeek · 登录',
};

/**
 * Open a sandboxed in-app webview pointed at platform.deepseek.com.
 *
 * Security:
 *   - Window label `deepseek-{target}` is matched by the `deepseek-window`
 *     capability, which grants only `core:default` and explicitly NOT shell,
 *     filesystem, or any custom YiYi commands.
 *   - URL is hardcoded to platform.deepseek.com — caller cannot inject.
 *   - If the window already exists, it's focused instead of duplicated.
 */
export async function openDeepSeekWindow(target: DeepSeekWindowTarget): Promise<void> {
  const label = `deepseek-${target}`;

  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.show();
    await existing.setFocus();
    return;
  }

  const win = new WebviewWindow(label, {
    url: TARGET_URLS[target],
    title: TITLE_ZH[target],
    width: 1024,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    resizable: true,
    center: true,
    decorations: true,
    alwaysOnTop: false,
    focus: true,
  });

  // Don't block on the create event — the window opens fine. We only listen
  // for failures so we can surface a clear error.
  win.once('tauri://error', (e) => {
    console.error('DeepSeek webview failed to open:', e);
  });
}

/** Strict DeepSeek API key shape: `sk-` + 32+ alphanumeric chars. */
const KEY_REGEX = /^sk-[A-Za-z0-9]{32,}$/;

/**
 * Read the OS clipboard once and return the contents IF they look like a
 * DeepSeek API key, else `null`. User-initiated only — never poll.
 *
 * Implementation note: uses the browser clipboard API (which the WebView
 * exposes), not a Tauri plugin, so no extra permissions are needed and the
 * user's OS prompts for clipboard access on first call (then auto-grants).
 */
export async function tryReadClipboardKey(): Promise<string | null> {
  if (!navigator.clipboard?.readText) return null;
  let text: string;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    // Permission denied or unavailable.
    return null;
  }
  const trimmed = text.trim();
  return KEY_REGEX.test(trimmed) ? trimmed : null;
}
