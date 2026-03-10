// Browser API
import { invoke } from '@tauri-apps/api/core';
import type { BrowserInfo } from './types';

export async function launchBrowser(headless: boolean = false): Promise<BrowserInfo> {
  return await invoke('launch_browser', { headless });
}

export async function navigate(browserId: string, url: string): Promise<void> {
  await invoke('browser_navigate', { browserId, url });
}

export async function screenshot(browserId: string, fullPage: boolean = false): Promise<string> {
  return await invoke('browser_screenshot', { browserId, fullPage });
}

export async function closeBrowser(browserId: string): Promise<void> {
  await invoke('close_browser', { browserId });
}
