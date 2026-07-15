// eval-via-CDP(新 eval 框架种子):可复现地建项目 + 导数据 + 真问数 + 比 gold 打分。
// 全程驱动真 app(渲染层 → ipc → 进程通道 → 后端),零 HTTP —— 这就是新 eval 框架的运行形态。
//
// 用法:CDP_PORT=9223 node test/eval-cdp.mjs

import { writeFileSync } from 'node:fs';
import { openSession } from './cdp.mjs';

const PORT = Number(process.env.CDP_PORT || 9223);

// ── 任务定义(= 一条 eval task:fixture 数据 + 问题 + gold)──
const FIXTURE = '/tmp/eval_fixture.csv';
writeFileSync(FIXTURE, 'region,amount\nEast,100\nWest,200\nNorth,150\nSouth,250\n');
const QUERY = 'eval_fixture 表里一共有多少行数据?';
const GOLD = { rows: 4 }; // 已知答案:4 行(总额 700)

const s = await openSession({ port: PORT });
const log = (...a) => console.log(...a);
try {
  // 0) app 本地自动鉴权,不登录,直接读现成会话 token
  const token = await s.evalJs(`const {useBasicStore}=await import('/src/store/basic'); return useBasicStore.getState().token || '';`);
  log('① 用 app 现成会话(不登录):', token ? 'OK' : '无 token');
  if (!token) throw new Error('app 会话无 token');

  // 经 ipc 的 authed 调用助手(也顺带在测这些 CRUD 端点)
  const call = async (method, url, body) =>
    s.evalJs(`return await window.electronAPI.apiRequest({method:${JSON.stringify(method)},url:${JSON.stringify(url)},headers:{'Authorization':'Bearer '+${JSON.stringify(token)},'Content-Type':'application/json'},body:${body ? JSON.stringify(JSON.stringify(body)) : 'null'}})`);

  // 1) 建项目
  const proj = await call('POST', '/api/projects', { name: 'eval-' + Date.now(), description: 'eval-via-cdp' });
  const pid = proj.json?.data?.id || proj.json?.data?.project_id;
  log('② 建项目:', proj.status, '| pid:', pid);
  if (!pid) throw new Error('建项目失败: ' + JSON.stringify(proj.json).slice(0, 160));

  // 2) 建结构化数据源
  const ds = await call('POST', `/api/projects/${pid}/structured-datasources`, { name: 'eval-ds' });
  const dsid = ds.json?.data?.id;
  log('③ 建数据源:', ds.status, '| dsid:', dsid);
  if (!dsid) throw new Error('建数据源失败: ' + JSON.stringify(ds.json).slice(0, 160));

  // 3) 按本地路径登记 fixture + 4) 解析进 DuckDB
  const reg = await call('POST', `/api/projects/${pid}/structured-documents/create`, { data_source_id: dsid, file_paths: [FIXTURE] });
  log('④ 登记文档:', reg.status, '| count:', reg.json?.data?.count);
  const proc = await call('POST', `/api/projects/${pid}/structured-documents/process`, { data_source_id: dsid });
  const connId = proc.json?.data?.database_connection_id;
  log('⑤ 导入 DuckDB:', proc.status, '| connId:', connId, '|', JSON.stringify(proc.json?.data?.processed || proc.json?.data).slice(0, 130));
  if (!connId) throw new Error('导入未返回 database_connection_id');

  // 5) 真问数:走「问数引擎路径」(chat.js POST /sessions 建会话+流式,= Python eval 那条),按 content_id 收终态块
  log(`⑥ 提问(问数引擎):「${QUERY}」(走 LLM + NL2SQL,稍等)…`);
  const out = await s.evalJs(`
    const { subscribeStream } = await import('/src/utils/api-stream.ts');
    const { createAPIURL } = await import('/src/utils/url-helper.ts');
    const { useBasicStore } = await import('/src/store/basic');
    const token = useBasicStore.getState().token;
    const req = {
      url: createAPIURL('/api/projects/${pid}/sessions'),
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Accept-Language': 'zh-CN' },
      body: JSON.stringify({ message: ${JSON.stringify(QUERY)}, title: 'eval', source_type: 'database_connection', source_id: ${JSON.stringify(connId)} }),
    };
    const blocks = new Map();
    let raw = 0; const samples = [];
    await subscribeStream(req, (line) => {
      if (!line.startsWith('data:')) return;
      const p = line.slice(5).trim(); if (!p || p === '[DONE]') return;
      let e; try { e = JSON.parse(p); } catch { return; }
      raw++;
      if (samples.length < 10) samples.push(JSON.stringify(e).slice(0, 260));
      // 问数引擎事件格式可能与 yiw 略异:凡带 content 的都收,按 content_id 取终态
      const cid = e.content_id != null ? String(e.content_id) : ('_' + blocks.size);
      const prev = blocks.get(cid) || { content: '' };
      const c = (e.content == null) ? '' : (typeof e.content === 'string' ? e.content : JSON.stringify(e.content));
      blocks.set(cid, { type: e.content_type || e.type, title: e.title, content: e.replace_content ? c : (prev.content + c) });
    });
    return { raw, samples, blocks: [...blocks.values()].map(b => ({ type: b.type, title: b.title, content: b.content || '' })).filter(b => b.content) };
  `);
  if (out.err) throw new Error('问数失败: ' + out.err);

  log(`⑦ 收到 ${out.raw} 个原始事件;终态块 ${out.blocks.length} 个`);
  if (out.samples?.length) { log('   原始事件样本:'); for (const x of out.samples) log('     ' + x); }
  for (const b of out.blocks) log(`   · [${b.type}${b.title ? '/' + b.title : ''}] ${b.content.length}字: ${b.content.slice(0, 120).replace(/\n/g, ' ')}`);

  // 6) 打分:比 gold(行数=4)。先看 SQL/结果块是否产出 + 文本是否含 gold 答案。
  const allText = out.blocks.map((b) => b.content).join(' ');
  const hasSql = out.blocks.some((b) => /sql/i.test(b.type || '') || /\bSELECT\b/i.test(b.content));
  const hitGold = new RegExp(`\\b${GOLD.rows}\\b`).test(allText);
  log('\n=== 评分 ===');
  log(`  产出 SQL: ${hasSql ? '✓' : '✗'}`);
  log(`  命中 gold(${GOLD.rows} 行): ${hitGold ? '✓' : '✗'}`);
  log(`  → ${hasSql && hitGold ? 'PASS ✅' : 'FAIL ❌(看上面终态块判断是 agent 没数据 / 块类型对不上 / 答案错)'}`);
} catch (e) {
  log('✗ 任务异常:', e?.message || e);
} finally {
  s.close();
}
process.exit(0);
