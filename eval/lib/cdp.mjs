// CDP harness:连进(或自启)Electron 渲染进程,在真实 window 上执行 JS。零依赖(Node v18+ fetch / v22+ WebSocket)。
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import { tmpdir } from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ELECTRON_DIR = path.resolve(__dirname, '..', '..', 'electron'); // eval/lib → electron
const RENDERER_DIR = path.resolve(__dirname, '..', '..', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APP_PAGE_RE = /(?:localhost|127\.0\.0\.1):\d+|index\.html|file:\/\//;
const DEFAULT_RENDERER_PORT = Number(process.env.YIW_RENDERER_PORT || 57131);
const SERVER_NATIVE_SQLITE = path.resolve(__dirname, '..', '..', 'server', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function createEvalEnv(rendererUrl) {
  const base = {
    ...process.env,
    YIW_DEV_URL: rendererUrl,
    YIW_NODE_BIN: resolveBackendNode(),
  };

  const shouldIsolate = isTruthy(process.env.YIW_EVAL_ISOLATED) || !!process.env.YIW_EVAL_HOME;
  if (!shouldIsolate) {
    const env = { ...base };
    if (process.env.YIW_EVAL_DB_SQLITE_PATH) env.DB_SQLITE_PATH = process.env.YIW_EVAL_DB_SQLITE_PATH;
    env.YIW_EVAL_MODE = process.env.YIW_EVAL_DB_SQLITE_PATH ? 'custom-db' : 'normal';
    return env;
  }

  const evalHome = process.env.YIW_EVAL_HOME || mkdtempSync(path.join(tmpdir(), 'yiw-app-eval-'));
  const yiwDir = path.join(evalHome, '.yiw');
  mkdirSync(yiwDir, { recursive: true });
  return {
    ...base,
    HOME: evalHome,
    USERPROFILE: evalHome,
    XDG_CONFIG_HOME: path.join(evalHome, '.config'),
    APPDATA: path.join(evalHome, 'AppData', 'Roaming'),
    DB_SQLITE_PATH: process.env.YIW_EVAL_DB_SQLITE_PATH || path.join(yiwDir, 'local.db'),
    YIW_EVAL_HOME: evalHome,
    YIW_EVAL_MODE: 'isolated',
  };
}

function nativeArch(filePath) {
  if (!existsSync(filePath)) return '';
  try {
    const out = execFileSync('file', [filePath], { encoding: 'utf8' });
    if (out.includes('arm64')) return 'arm64';
    if (out.includes('x86_64')) return 'x64';
  } catch {
    // ignore
  }
  return '';
}

function nodeArch(nodePath) {
  try {
    return execFileSync(nodePath, ['-p', 'process.arch'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function resolveBackendNode() {
  if (process.env.YIW_NODE_BIN && existsSync(process.env.YIW_NODE_BIN)) return process.env.YIW_NODE_BIN;
  const targetArch = nativeArch(SERVER_NATIVE_SQLITE);
  if (!targetArch) return process.execPath;
  const candidates = [
    process.execPath,
    ...String(process.env.PATH || '').split(path.delimiter).map((dir) => path.join(dir, 'node')),
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
  ].filter((p, i, arr) => p && existsSync(p) && arr.indexOf(p) === i);
  return candidates.find((p) => nodeArch(p) === targetArch) || process.execPath;
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForPort(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) return true;
    await sleep(250);
  }
  return false;
}

async function fetchJson(url, { timeoutMs = 1500 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, { timeoutMs = 1500 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function isYiWRenderer(port) {
  try {
    const text = await fetchText(`http://127.0.0.1:${port}/src/store/basic.ts`);
    return text.includes('useBasicStore');
  } catch {
    return false;
  }
}

async function findFreePort(start) {
  let port = Number(start) || 57131;
  for (let i = 0; i < 50; i++) {
    if (!(await isPortOpen(port))) return port;
    port += 1;
  }
  throw new Error(`找不到可用 renderer 端口(从 ${start} 起试了 50 个)`);
}

/** 已有调试端口在服务则连它,否则自启一个 Electron 实例(测完 close 自杀)。返回 { evalJs, cdp, close }。 */
export async function openSession({ port = 9333 } = {}) {
  let child = null;
  let rendererChild = null;
  let rendererUrl = process.env.YIW_DEV_URL || `http://127.0.0.1:${DEFAULT_RENDERER_PORT}`;
  try {
    await fetchJson(`http://localhost:${port}/json/version`);
  } catch {
    if (!process.env.YIW_DEV_URL) {
      let rendererPort = DEFAULT_RENDERER_PORT;
      const rendererReady = await isYiWRenderer(rendererPort);
      if (!rendererReady && (await isPortOpen(rendererPort))) {
        rendererPort = await findFreePort(rendererPort + 1);
      }
      rendererUrl = `http://127.0.0.1:${rendererPort}`;
      if (!rendererReady) {
        rendererChild = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1'], {
          cwd: RENDERER_DIR,
          env: {
            ...process.env,
            VITE_APP_DEV_PORT: String(rendererPort),
            VITE_DEV_PORT: String(rendererPort),
          },
          stdio: 'ignore',
          shell: process.platform === 'win32',
        });
        const ready = await waitForPort(rendererPort);
        if (!ready) {
          try { rendererChild.kill(); } catch { /* ignore */ }
          throw new Error(`renderer 未能在 ${rendererPort} 端口启动`);
        }
      }
    }
    const env = createEvalEnv(rendererUrl);
    console.info(`[eval] 启动 Electron: mode=${env.YIW_EVAL_MODE || 'normal'} HOME=${env.HOME || process.env.HOME || ''} DB=${env.DB_SQLITE_PATH || '(default ~/.yiw/local.db)'}`);
    child = spawn('./node_modules/.bin/electron', ['.', `--remote-debugging-port=${port}`], {
      cwd: ELECTRON_DIR,
      env,
      stdio: 'ignore',
    });
  }
  const deadline = Date.now() + 45000;
  let page;
  while (Date.now() < deadline) {
    try {
      const ts = await fetchJson(`http://localhost:${port}/json`);
      page = ts.find((t) => t.type === 'page' && APP_PAGE_RE.test(t.url || ''));
      if (page) break;
    } catch { /* not up */ }
    await sleep(400);
  }
  if (!page) {
    try { child?.kill(); } catch { /* ignore */ }
    try { rendererChild?.kill(); } catch { /* ignore */ }
    throw new Error(`连不上 CDP(:${port})`);
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  });
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`CDP WebSocket 打开超时(:${port})`)), 10000);
    ws.addEventListener('open', () => { clearTimeout(timer); res(); }, { once: true });
    ws.addEventListener('error', (e) => { clearTimeout(timer); rej(e); }, { once: true });
  });
  const cmd = (method, params, opts = {}) => new Promise((res, rej) => {
    const i = ++id;
    let timer = null;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        pending.delete(i);
        rej(new Error(`CDP 命令超时: ${method}`));
      }, opts.timeoutMs);
    }
    pending.set(i, {
      res: (v) => { if (timer) clearTimeout(timer); res(v); },
      rej: (e) => { if (timer) clearTimeout(timer); rej(e); },
    });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await cmd('Runtime.enable', {}, { timeoutMs: 5000 });
  await cmd('Page.enable', {}, { timeoutMs: 5000 }).catch(() => {});

  const evalJs = async (expr, opts = {}) => {
    const r = await cmd('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true }, opts);
    if (r.exceptionDetails) throw new Error('渲染层异常: ' + String(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)).slice(0, 400));
    return r.result.value;
  };
  const d2 = Date.now() + 20000;
  let ready = false;
  while (Date.now() < d2) {
    try {
      if (await evalJs(`return !!(window.electronAPI&&window.electronAPI.apiRequest)`, { timeoutMs: 1500 })) {
        ready = true;
        break;
      }
    } catch { /* loading */ }
    await sleep(300);
  }
  if (!ready) {
    try { ws.close(); } catch { /* ignore */ }
    if (child) { try { child.kill(); } catch { /* ignore */ } }
    if (rendererChild) { try { rendererChild.kill(); } catch { /* ignore */ } }
    throw new Error(`渲染层未就绪: window.electronAPI.apiRequest 不可用(:${port})`);
  }

  return {
    evalJs,
    cdp: cmd,
    close: () => {
      try { ws.close(); } catch { /* ignore */ }
      if (child) { try { child.kill(); } catch { /* ignore */ } }
      if (rendererChild) { try { rendererChild.kill(); } catch { /* ignore */ } }
    },
  };
}
