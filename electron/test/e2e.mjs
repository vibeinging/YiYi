// Electron 端到端测试(CDP 驱动真实渲染层)—— 可复用 harness。
//
// 它连进真 Electron 渲染进程,在真实 window 上执行 JS,把「渲染层 → ipc → 主进程 → 进程通道 → 后端 Express」
// 全链路跑一遍,不从外部打 HTTP。这套同时是「新 eval 框架」的形态:驱动真 app 全栈做功能/准确率验证。
//
// 用法:
//   node test/e2e.mjs              # 自启一个 Electron 实例(端口 9333),测完自杀;与你正在跑的 app 并存
//   CDP_PORT=9223 node test/e2e.mjs # 连已在跑的实例(app 需带 --remote-debugging-port=9223)
//
// 零依赖(Node v18+ 自带 fetch,v22+ 自带 WebSocket)。

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ELECTRON_DIR = path.resolve(__dirname, '..');
const PORT = Number(process.env.CDP_PORT || 9333);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child = null;
async function ensureApp() {
  try { await (await fetch(`http://localhost:${PORT}/json/version`)).json(); return; } catch { /* 没在跑,自启 */ }
  console.log(`启动测试用 Electron 实例(:${PORT})…`);
  child = spawn('./node_modules/.bin/electron', ['.', `--remote-debugging-port=${PORT}`], { cwd: ELECTRON_DIR, stdio: 'ignore' });
}

async function connect() {
  const deadline = Date.now() + 40000;
  let page;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://localhost:${PORT}/json`)).json();
      page = targets.find((t) => t.type === 'page' && /localhost:57131|index\.html/.test(t.url || ''));
      if (page) break;
    } catch { /* not up */ }
    await sleep(400);
  }
  if (!page) throw new Error(`连不上 CDP(:${PORT})`);
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
    if (r.exceptionDetails) throw new Error('渲染层异常: ' + String(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)).slice(0, 300));
    return r.result.value;
  };
  // 等前端 electronAPI 就绪
  const d2 = Date.now() + 20000;
  while (Date.now() < d2) { try { if (await evalJs(`return !!(window.electronAPI&&window.electronAPI.apiRequest)`)) break; } catch { /* loading */ } await sleep(300); }
  return { evalJs, close: () => ws.close() };
}

// ── 迷你测试框架 ──
let pass = 0; let fail = 0; const fails = [];
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; fails.push(name); console.log(`  ✗ ${name} — ${e?.message || e}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert failed'); }

// ── 跑 ──
await ensureApp();
const s = await connect();
const api = (req) => s.evalJs(`return await window.electronAPI.apiRequest(${JSON.stringify(req)})`);
const stream = (req) => s.evalJs(`return await new Promise((resolve)=>{let c='';let st=0;window.electronAPI.streamStart(${JSON.stringify(req)},(m)=>{if(m.type==='head')st=m.status;else if(m.type==='data')c+=m.chunk;else if(m.type==='end')resolve({status:st,body:c});else if(m.type==='error')resolve({status:st,error:m.error});});})`);

console.log('\n=== Electron e2e(CDP · 真渲染层 · 全走进程通道)===');
let token = '';
try {
  await test('electronAPI 暴露 ipc 桥', async () => {
    const keys = await s.evalJs(`return Object.keys(window.electronAPI||{})`);
    assert(keys.includes('apiRequest') && keys.includes('streamStart'), `keys=${keys}`);
  });
  await test('REST ipc:builtin-login → 200 + token', async () => {
    const r = await api({ method: 'GET', url: '/api/user/builtin-login', headers: {} });
    assert(r.status === 200, `status ${r.status}`);
    token = r.json?.data?.access_token || '';
    assert(token, 'no token');
  });
  await test('鉴权(经 shim):无 token → 401', async () => {
    const r = await api({ method: 'GET', url: '/api/projects/_/databases/meta/supported-types', headers: {} });
    assert(r.status === 401, `status ${r.status}`);
  });
  await test('鉴权(经 shim):带 token → 200', async () => {
    const r = await api({ method: 'GET', url: '/api/projects/_/databases/meta/supported-types', headers: { Authorization: `Bearer ${token}` } });
    assert(r.status === 200, `status ${r.status}`);
  });
  await test('axios 适配器(真实前端 axios 层 → ipc)', async () => {
    const r = await s.evalJs(`const m=await import('/src/utils/axios-req.ts'); return await m.default({url:'/api/user/builtin-login',method:'get'})`);
    assert(r.success === true && r.data?.access_token, 'adapter 未生效');
  });
  await test('streamStart 流式桥 → 200', async () => {
    const r = await stream({ url: '/api/user/builtin-login', method: 'GET', headers: {} });
    assert(r.status === 200 && String(r.body).includes('access_token'), `status ${r.status} err=${r.error || ''}`);
  });

  // ── 真实业务流(驱动真前端 api 模块;鉴权来自注入 store 的 token)──
  await test('注入登录态(token → 前端 store)', async () => {
    assert(token, '需先登录拿 token');
    const t = await s.evalJs(`const {useBasicStore}=await import('/src/store/basic.ts'); useBasicStore.setState({token:${JSON.stringify(token)}}); return useBasicStore.getState().token`);
    assert(t === token, 'token 未注入 store');
  });
  await test('功能·列项目(真实 axios 业务端点 → ipc)', async () => {
    const r = await s.evalJs(`const m=await import('/src/api/project.ts'); return await m.getMyProjectsReq()`);
    assert(r && r.success !== false, `resp ${JSON.stringify(r).slice(0, 140)}`);
  });
  await test('功能·真 agent 对话(__chat__ 发「你好」,收流式内容)', async () => {
    const r = await s.evalJs(`
      const yiw=await import('/src/api/yiw.ts');
      const {subscribeStream}=await import('/src/utils/api-stream.ts');
      const sess=await yiw.createAgentSession('__chat__','e2e-'+Date.now());
      const sid=sess?.data?.session_id||sess?.data?.id||sess?.data;
      if(!sid) return {err:'no session: '+JSON.stringify(sess).slice(0,120)};
      const req=yiw.sendMessageToAgent('__chat__',sid,'你好',undefined,{});
      let got=''; let evts=0;
      const blocks = new Map();
      await subscribeStream(req,(line)=>{ if(line.startsWith('data:')){const p=line.slice(5).trim(); if(p&&p!=='[DONE]'){try{const e=JSON.parse(p); evts++; if(e.v===1&&e.type==='message.delta'){const payload=e.payload||{}; const id=String(payload.block_id||('b'+blocks.size)); const prev=blocks.get(id)||''; const c=typeof payload.content==='string'?payload.content:JSON.stringify(payload.content??''); blocks.set(id,payload.mode==='append'?prev+c:c);}}catch{}}}});
      got=[...blocks.values()].join('\\n');
      return {sid, evts, len: got.length, sample: got.slice(0,60)};
    `);
    assert(r && r.len > 0, `agent 无流式内容: ${JSON.stringify(r).slice(0, 180)}`);
    console.log(`     ↳ agent 回了 ${r.len} 字(${r.evts} 事件):「${r.sample}…」`);
  });
} finally {
  console.log(`\n结果:${pass} 通过, ${fail} 失败` + (fails.length ? ` — ${fails.join(' / ')}` : ''));
  s.close();
  if (child) { try { child.kill(); } catch { /* ignore */ } }
}
process.exit(fail ? 1 : 0);
