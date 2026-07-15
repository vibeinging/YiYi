// 可复用 CDP harness:连进(或自启)Electron 渲染进程,在真实 window 上执行 JS。
// 零依赖(Node v18+ fetch、v22+ WebSocket)。e2e.mjs / eval-cdp.mjs 共用。

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ELECTRON_DIR = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 打开一个会话:端口已有调试实例则连它,否则自启一个(测完 close 自杀)。返回 { evalJs, close }。 */
export async function openSession({ port = 9333 } = {}) {
  let child = null;
  try {
    await (await fetch(`http://localhost:${port}/json/version`)).json();
  } catch {
    child = spawn('./node_modules/.bin/electron', ['.', `--remote-debugging-port=${port}`], { cwd: ELECTRON_DIR, stdio: 'ignore' });
  }
  const deadline = Date.now() + 40000;
  let page;
  while (Date.now() < deadline) {
    try {
      const ts = await (await fetch(`http://localhost:${port}/json`)).json();
      page = ts.find((t) => t.type === 'page' && /localhost:57131|index\.html/.test(t.url || ''));
      if (page) break;
    } catch { /* not up */ }
    await sleep(400);
  }
  if (!page) { try { child?.kill(); } catch { /* ignore */ } throw new Error(`连不上 CDP(:${port})`); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cmd = (method, params) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  await cmd('Runtime.enable', {});

  const evalJs = async (expr) => {
    const r = await cmd('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('渲染层异常: ' + String(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)).slice(0, 400));
    return r.result.value;
  };
  const d2 = Date.now() + 20000;
  while (Date.now() < d2) { try { if (await evalJs(`return !!(window.electronAPI&&window.electronAPI.apiRequest)`)) break; } catch { /* loading */ } await sleep(300); }

  return { evalJs, close: () => { try { ws.close(); } catch { /* ignore */ } if (child) { try { child.kill(); } catch { /* ignore */ } } } };
}
