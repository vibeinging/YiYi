// Entity disambiguation memory:静态契约回归。
// 避免直接 import server runtime,否则会拉起 native sqlite 依赖,在不同 Node 架构下不稳定。
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '../..');
const SERVER_NATIVE_SQLITE = path.join(APP_ROOT, 'server/node_modules/better-sqlite3/build/Release/better_sqlite3.node');

function readAppFile(rel) {
  return readFileSync(path.join(APP_ROOT, rel), 'utf8');
}

function between(source, start, end) {
  const i = source.indexOf(start);
  if (i < 0) return '';
  const j = end ? source.indexOf(end, i + start.length) : -1;
  return j < 0 ? source.slice(i) : source.slice(i, j);
}

export default {
  id: 'agent-disambiguation-memory',
  desc: 'align_value 歧义询问、前端确认与记忆写入契约',
  async run({ driver, assert }) {
    const queryTools = readAppFile('server/src/engine/agents/query_tool_adapter.js');
    const queryAgent = readAppFile('server/src/engine/agents/query_agent.js');
    const suspendedRuntime = readAppFile('server/src/engine/agents/suspended_run_runtime.js');
    const agentChat = readAppFile('server/src/app/chat/agent_chat.js');
    const pendingActions = readAppFile('server/src/app/agent_actions/pending_actions.js');
    const chatRegistry = readAppFile('server/src/transport/registry.chat.js');
    const actionRegistry = readAppFile('server/src/transport/registry.agent_actions.js');
    const registry = readAppFile('server/src/transport/registry.js');
    const lifecycle = readAppFile('server/src/engine/semantic/conversation_lifecycle.js');
    const disambig = readAppFile('server/src/engine/semantic/disambiguation_service.js');
    const streamProtocol = readAppFile('server/src/engine/stream/agent_stream_protocol.js');
    const contentAdapter = readAppFile('server/src/engine/stream/agent_content_adapter.js');
    const conversation = readAppFile('renderer/src/views/agent/YiWConversation.tsx');
    const reducer = readAppFile('renderer/src/views/agent/stream/reducer.ts');
    const styles = readAppFile('renderer/src/views/agent/yiw.module.scss');

    assert.ok(queryTools.includes('build_disambiguation_context'), 'ask_user 可带出 disambiguation_context');
    assert.ok(queryTools.includes('export function recordQueryToolHistory'), 'query 工具调用会进入 tool_history');
    assert.ok(queryTools.includes('export function buildAskUserPayload'), 'ask_user payload 有统一构造入口');

    const alignParams = between(queryTools, 'const AlignValueParams = Type.Object({', '});\n  const SemanticScanParams');
    assert.ok(alignParams.includes('table_name'), 'align_value schema 要求 table_name');
    assert.ok(alignParams.includes('column_name'), 'align_value schema 要求 column_name');
    assert.ok(alignParams.includes('keyword'), 'align_value schema 要求 keyword');
    assert.ok(alignParams.includes('limit'), 'align_value schema 支持 limit');

    const infoOperator = between(queryTools, 'async function runInfoOperator', 'const wrapData');
    assert.ok(infoOperator.includes('recordQueryToolHistory'), 'grep/align 信息类工具写入 tool_history');
    assert.ok(infoOperator.includes('hasEmbeddedError'), '信息类工具能把 data.error 当失败处理');

    const askUser = between(queryTools, 'const askUserTool = {', '  // ── 按能力门控装配');
    assert.ok(askUser.includes('buildAskUserPayload'), 'ask_user 使用统一 payload');
    assert.ok(askUser.includes('runtime.requestUserInput'), 'ask_user 通过运行时创建 pending action');
    assert.ok(askUser.includes('_suspended_by_ask_user'), 'ask_user 会标记本轮挂起');
    assert.ok(askUser.includes('original_user_message'), 'ask_user checkpoint 会记录原始问题');
    assert.ok(askUser.includes('tool_call_id: _id'), 'ask_user checkpoint 会记录 tool_call_id 供 transcript resume');
    assert.ok(askUser.includes('recordQueryToolHistory'), 'ask_user 写入 tool_history');
    assert.ok(askUser.includes('content_type: "user_input"'), 'ask_user 发出 user_input 控制流内容');
    assert.ok(queryAgent.includes('return { success: true, suspended: true }'), 'QueryAgent 将 ask_user 挂起视为正常暂停');
    assert.ok(queryAgent.includes('loadTranscript'), 'QueryAgent resume 时读取 transcript');
    assert.ok(queryAgent.includes('agent.continue()'), 'QueryAgent 支持 transcript continue');
    assert.ok(queryAgent.includes('appendMessages'), 'QueryAgent 会追加原始 transcript');
    assert.ok(suspendedRuntime.includes('createResumeHandle'), 'runtime 暴露 resume handle 构造');
    assert.ok(suspendedRuntime.includes('resolvePendingUserInput'), 'runtime 能消费 pending user input');
    assert.ok(suspendedRuntime.includes('buildUserInputContinuationMessage'), 'runtime 能构造用户选择后的 continuation prompt');
    assert.ok(suspendedRuntime.includes('applyUserInputToolResultResume'), 'runtime 能把用户选择写回 ask_user toolResult');
    assert.ok(streamProtocol.includes('RUN_SUSPENDED'), 'Agent Stream 定义 run.suspended');
    assert.ok(streamProtocol.includes('RUN_RESUMED'), 'Agent Stream 定义 run.resumed');
    assert.ok(streamProtocol.includes('USER_INPUT_REQUESTED'), 'Agent Stream 定义 user_input.requested');
    assert.ok(streamProtocol.includes('USER_INPUT_RESOLVED'), 'Agent Stream 定义 user_input.resolved');
    assert.ok(contentAdapter.includes('StreamEventType.USER_INPUT_REQUESTED'), 'user_input 内容映射为 action 事件');
    assert.ok(agentChat.includes('on_round_start'), 'agentChat 普通聊天入口也会消费上一轮消歧选择');
    assert.ok(agentChat.includes('recordPendingDisambiguationChoice'), 'agentChat 有独立消歧选择落库入口');
    assert.ok(!agentChat.includes('user_input_response'), 'agentChat 不读取普通请求 body.user_input_response');
    assert.ok(agentChat.includes('input.pendingUserInputResponse'), 'agentChat 仅消费内部 pendingUserInputResponse');
    assert.ok(agentChat.includes('resolvedInput?.status !== "answered"'), 'pending action missing/mismatched 不会被当作成功选择');
    assert.ok(agentChat.includes('stream.userInputResolved'), 'agentChat 消费选择后发 user_input.resolved');
    assert.ok(agentChat.includes('emitDisambiguationAck'), 'agentChat 可对已消费的消歧选择返回确认');
    assert.ok(agentChat.includes('continueResolvedUserInput'), 'agentChat 可将真实 pending action 继续执行');
    assert.ok(agentChat.includes('resume_run_id'), 'agentChat continuation 复用原 run id');
    assert.ok(agentChat.includes('input.resumeIntent?.continueFromTranscript'), 'agentChat 只接受内部 resume intent');
    assert.ok(pendingActions.includes('resolveAgentPendingAction'), 'pending action 有独立 control-plane usecase');
    assert.ok(pendingActions.includes('controlPlaneAction'), 'pending action resolver 标记控制面动作');
    assert.ok(pendingActions.includes('pendingUserInputResponse'), 'pending action resolver 通过内部字段传递用户选择');
    assert.ok(!pendingActions.includes('user_input_response'), 'pending action resolver 不再伪造旧 chat body 协议');
    assert.ok(!agentChat.includes('body.resume_continue'), '普通 chat body 不能触发 resume_continue');
    assert.ok(!queryAgent.includes('body.resume_continue'), 'queryChat body 不能触发 resume_continue');
    assert.ok(!chatRegistry.includes('pending-actions/:requestId/resolve'), 'pending action 不再挂在 chat registry');
    assert.ok(actionRegistry.includes('pending-actions/:requestId/resolve'), 'pending action 注册在 agent actions registry');
    assert.ok(registry.includes('agentActionRoutes'), 'agent actions registry 汇总到 IPC registry');

    assert.ok(lifecycle.includes('memoryValues'), 'on_round_start 读取 memory_values');
    assert.ok(lifecycle.includes('recorded: true'), 'on_round_start 会返回消歧选择是否已消费');
    assert.ok(lifecycle.includes('Array.isArray(disambig.candidates)'), 'on_round_start 对 candidates 做类型保护');
    assert.ok(lifecycle.includes('Array.isArray(disambig.memory_values)'), 'on_round_start 对 memory_values 做类型保护');
    assert.ok(
      lifecycle.includes('const allowed = [...new Set([...candidates, ...memoryValues])]'),
      'on_round_start 合并候选值与记忆候选',
    );
    assert.ok(lifecycle.includes('candidates: allowed.map'), 'record_resolution 使用合并后的候选集合');

    assert.ok(
      disambig.includes('VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9, $8, $8)'),
      'disambiguation_resolutions INSERT 占位符与参数数量匹配',
    );

    assert.ok(conversation.includes('function parseUserInputPayload'), '前端可解析 user_input payload');
    assert.ok(conversation.includes('const seenOptions = new Set<string>()'), '前端候选合并后会去重');
    assert.ok(conversation.includes('...(Array.isArray(payload.options) ? payload.options : [])'), '前端保留模型显式 options');
    assert.ok(conversation.includes('...(Array.isArray(context.memory_values) ? context.memory_values : [])'), '前端补充记忆候选');
    assert.ok(conversation.includes('...(Array.isArray(context.candidates) ? context.candidates : [])'), '前端补充库存候选');
    assert.ok(conversation.includes('function UserInputBlock'), '前端有 user_input 确认组件');
    assert.ok(conversation.includes("b.type === 'user_input'"), '消息流会渲染 user_input 块');
    assert.ok(conversation.includes('pickUserInputOption'), '点击候选会发送精确候选值');
    assert.ok(conversation.includes('resolveAgentPendingAction'), '点击候选通过 pending action control-plane resolver');
    assert.ok(conversation.includes('resumeHandle'), '点击候选会携带 resume handle');
    assert.ok(reducer.includes("event.type === 'user_input.requested'"), '前端 reducer 消费 user_input.requested');
    assert.ok(reducer.includes("event.type === 'user_input.resolved'"), '前端 reducer 消费 user_input.resolved');
    assert.ok(reducer.includes("payload.status === 'answered' ? 'resolved'"), '只有 answered 才把 user_input 标为已解决');
    assert.ok(styles.includes('.userInputCard'), 'user_input 卡片样式存在');
    assert.ok(styles.includes('.userInputOption'), 'user_input 候选按钮样式存在');

    const payload = { disambiguation_context: { candidates: [], memory_values: [{ value: '宏远科技有限公司' }] } };
    const candidates = payload.disambiguation_context.candidates || [];
    const memoryValues = (payload.disambiguation_context.memory_values || [])
      .map((v) => (v && typeof v === 'object' && !Array.isArray(v) ? v.value : v))
      .filter(Boolean);
    const allowed = [...new Set([...candidates, ...memoryValues])];
    assert.ok(allowed.includes('宏远科技有限公司'), '仅来自记忆的候选也会被允许写入 resolution');

    await driver.login();
    const pid = await driver.ensureProject('agent-disambiguation-memory-eval');
    const api = driver.raw.api;
    await cleanupEvalSessions(api, pid);
    const title = `entity-disambiguation-e2e-${Date.now()}`;
    const table = 'eval_customers';
    const column = 'customer_name';
    const keyword = `eval-keyword-${Date.now()}`;
    const chosen = `AlphaMemoryChoice-${Date.now()}`;
    const requestId = `eval_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    let sid = '';

    try {
      const sess = await api('POST', `/api/projects/${pid}/sessions`, {
        title,
        source_type: 'agent',
        source_id: pid,
        action_type: 'agentic_chat',
      });
      assert.status(sess, 200, '可创建包含 user_input 的 agent 会话');
      sid = sess.json?.data?.id || sess.json?.data?.session_id;
      assert.ok(!!sid, 'agent 会话返回 session id');
      if (!sid) return;

      const userInputPayload = {
        request_id: requestId,
        prompt: '请选择要写入 WHERE 条件的客户名称',
        options: [{ label: '非记忆候选' }],
        allow_multiple: false,
        disambiguation_context: {
          source_table: table,
          source_column: column,
          keyword,
          candidates: ['非记忆候选'],
          memory_values: [{ value: chosen, memory_id: 'eval-memory-row', hit_count: 2 }],
        },
      };

      const dbResult = runServerDbLifecycle({
        pid,
        sid,
        table,
        column,
        keyword,
        chosen,
        userInputPayload,
      });
      assert.ok(dbResult.written?.chosen_value === chosen, '用户选择记忆候选后会写入 disambiguation_resolutions');
      assert.ok(
        Array.isArray(dbResult.reused) && dbResult.reused.some((row) => row.chosen_value === chosen),
        '后续 align_value lookup 能复用之前选择',
      );

      const missingPending = await driver.raw.ev(`
        const { resolveAgentPendingAction } = await import('/src/api/yiw.ts');
        const { subscribeStream } = await import('/src/utils/api-stream.ts');
        const req = resolveAgentPendingAction(
          ${JSON.stringify(pid)},
          ${JSON.stringify(sid)},
          'missing-pending-action-eval',
          { value: ${JSON.stringify(chosen)} }
        );
        const events = [];
        const chunks = [];
        await subscribeStream(req, (line) => {
          if (!line.startsWith('data:')) return;
          const raw = line.slice(5).trim();
          if (!raw || raw === '[DONE]') return;
          let event;
          try { event = JSON.parse(raw); } catch { return; }
          events.push(event);
          if (event.type === 'message.delta') chunks.push(String(event.payload?.content || ''));
        });
        return {
          text: chunks.join('\\n'),
          statuses: events
            .filter((event) => event.type === 'user_input.resolved')
            .map((event) => event.payload?.status),
          runStatuses: events
            .filter((event) => event.type === 'run.completed' || event.type === 'run.failed')
            .map((event) => event.payload?.status || event.type),
        };
      `, { timeoutMs: 10000 });
      assert.ok(
        missingPending?.statuses?.includes('failed'),
        '不存在的 pending action 返回 failed user_input.resolved',
      );
      assert.ok(
        !String(missingPending?.text || '').includes('已选择'),
        '不存在的 pending action 不会显示已选择',
      );
      assert.ok(
        String(missingPending?.text || '').includes('失效') || String(missingPending?.text || '').includes('不存在'),
        '不存在的 pending action 会提示确认已失效',
      );

      await driver.ensureProject('agent-disambiguation-memory-eval');
      await driver.raw.ev(`
        const pid = ${JSON.stringify(pid)};
        const { useProjectStore } = await import('/src/store/project');
        useProjectStore.setState({ currentProject: null });
        await new Promise((r) => setTimeout(r, 50));
        useProjectStore.getState().setCurrentProject({ id: pid, project_id: pid, name: 'agent-disambiguation-memory-eval' });
        return true;
      `);
      const clicked = await driver.raw.ev(`
        const selector = '[data-agent-conv-id="${sid}"]';
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          const hit = document.querySelector(selector);
          if (hit) {
            hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            return true;
          }
          await new Promise((r) => setTimeout(r, 150));
        }
        return false;
      `, { timeoutMs: 10000 });
      assert.ok(clicked, '可在聊天左栏打开包含 user_input 的会话');
      const rendered = await driver.raw.ev(`
        const deadline = Date.now() + 8000;
        const chosen = ${JSON.stringify(chosen)};
        while (Date.now() < deadline) {
          const text = document.body.innerText || '';
          const hasPrompt = text.includes('需要确认') || text.includes('请选择要写入 WHERE 条件的客户名称');
          const hasButton = [...document.querySelectorAll('button')].some((button) => (button.textContent || '').includes(chosen));
          if (hasPrompt && hasButton) return true;
          await new Promise((r) => setTimeout(r, 150));
        }
        return false;
      `, { timeoutMs: 10000 });
      assert.ok(rendered, '聊天详情页会弹出候选选择框并展示记忆候选按钮');
      const picked = await driver.raw.ev(`
        const chosen = ${JSON.stringify(chosen)};
        const button = [...document.querySelectorAll('button')]
          .find((item) => (item.textContent || '').includes(chosen));
        if (!button) return false;
        button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
      `, { timeoutMs: 10000 });
      assert.ok(picked, '可点击记忆候选按钮');
      const clickResult = await driver.raw.ev(`
        const deadline = Date.now() + 10000;
        const chosen = ${JSON.stringify(chosen)};
        while (Date.now() < deadline) {
          const text = document.body.innerText || '';
          if (text.includes('尚未绑定数据源') || text.includes('尚未绑定任何数据源')) {
            return { ok: false, reason: 'unexpected_datasource_warning', text };
          }
          if (text.includes('已选择「' + chosen + '」')) return { ok: true };
          await new Promise((r) => setTimeout(r, 150));
        }
        const cards = [...document.querySelectorAll('[class*="userInput"]')]
          .map((node) => (node.textContent || '').trim())
          .filter(Boolean)
          .slice(0, 8);
        const buttons = [...document.querySelectorAll('button')]
          .map((button) => ({ text: (button.textContent || '').trim(), disabled: button.disabled }))
          .filter((item) => item.text.includes(chosen) || item.text.includes('非记忆候选'))
          .slice(0, 8);
        return { ok: false, reason: 'missing_ack', text: document.body.innerText || '', cards, buttons };
      `, { timeoutMs: 12000 });
      if (!clickResult?.ok) {
        assert.ok(false, `点击记忆候选后只记录选择,不触发无数据源问数错误: ${clickResult?.reason || ''} ${JSON.stringify({
          cards: clickResult?.cards,
          buttons: clickResult?.buttons,
          text: String(clickResult?.text || '').slice(0, 1000),
        })}`);
      }
      assert.ok(clickResult?.ok, '点击记忆候选后只记录选择,不触发无数据源问数错误');
    } finally {
      if (sid) await api('DELETE', `/api/projects/${pid}/sessions/${sid}`).catch(() => {});
      await cleanupEvalSessions(api, pid);
      await driver.raw.ev(`
        const pid = ${JSON.stringify(pid)};
        const { eventBus, EVENT_TYPES } = await import('/src/utils/eventBus');
        eventBus.emit(EVENT_TYPES.REFRESH_HISTORY, { workspaceId: pid });
      `).catch(() => {});
    }
  },
};

async function cleanupEvalSessions(api, pid) {
  const list = await api('GET', `/api/agent/projects/${pid}/sessions`).catch(() => null);
  const items = list?.json?.data?.items || list?.json?.data || [];
  for (const item of items) {
    const title = String(item?.title || '');
    if (!item?.id || !title.startsWith('entity-disambiguation-e2e-')) continue;
    await api('DELETE', `/api/projects/${pid}/sessions/${item.id}`).catch(() => {});
  }
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

function resolveServerNode() {
  const targetArch = nativeArch(SERVER_NATIVE_SQLITE);
  const candidates = [
    process.env.YIW_NODE_BIN,
    process.execPath,
    ...String(process.env.PATH || '').split(path.delimiter).map((dir) => path.join(dir, 'node')),
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
  ].filter((p, i, arr) => p && existsSync(p) && arr.indexOf(p) === i);
  return candidates.find((p) => !targetArch || nodeArch(p) === targetArch) || process.execPath;
}

function runServerDbLifecycle(payload) {
  const script = `
    import { randomUUID } from 'node:crypto';
    const input = JSON.parse(process.env.EVAL_PAYLOAD || '{}');
    const db = await import('./server/src/db.js');
    const lifecycle = await import('./server/src/engine/semantic/conversation_lifecycle.js');
    const disambig = await import('./server/src/engine/semantic/disambiguation_service.js');
    const ctx = { query: db.query, queryOne: db.queryOne };
    const normalized = disambig.normalize_keyword(input.keyword);
    await ctx.query(
      \`DELETE FROM disambiguation_resolutions
        WHERE project_id=$1 AND source_table=$2 AND source_column=$3 AND normalized_keyword=$4\`,
      [input.pid, input.table, input.column, normalized],
    ).catch(() => {});
    await ctx.query(
      \`DELETE FROM session_messages WHERE session_id=$1\`,
      [input.sid],
    ).catch(() => {});
    await ctx.query(
      \`INSERT INTO session_messages (id,session_id,role,content_items,sequence_number,created_at,updated_at)
       VALUES ($1,$2,'user',$3,1,now(),now())\`,
      [
        randomUUID(),
        input.sid,
        JSON.stringify([{ id: randomUUID(), type: 'text', content: \`查询 \${input.keyword}\`, metadata: {}, is_complete: true, display_type: 'text' }]),
      ],
    );
    const runId = 'eval-run-' + randomUUID();
    const resumeHandle = {
      type: 'user_input_resume',
      run_id: runId,
      session_id: input.sid,
      request_id: input.userInputPayload.request_id,
      version: 1,
    };
    const userInputPayload = {
      ...input.userInputPayload,
      run_id: runId,
      resume_handle: resumeHandle,
    };
    await ctx.query(
      \`INSERT INTO session_messages (id,session_id,role,content_items,sequence_number,created_at,updated_at)
       VALUES ($1,$2,'assistant',$3,2,now(),now())\`,
      [
        randomUUID(),
        input.sid,
        JSON.stringify([{
          id: randomUUID(),
          type: 'user_input',
          content: JSON.stringify(userInputPayload),
          title: '需要确认',
          metadata: { display: true },
          is_complete: true,
          display_type: 'text',
        }]),
      ],
    );
    await ctx.query(
      \`DELETE FROM agent_pending_inputs WHERE session_id=$1 AND request_id=$2\`,
      [input.sid, input.userInputPayload.request_id],
    ).catch(() => {});
    await ctx.query(
      \`INSERT INTO agent_pending_inputs (
          id, run_id, session_id, project_id, user_id, request_id,
          input_type, status, payload_json, response_json, resume_handle_json,
          resume_expires_at, record_expires_at, created_at, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,'user_input','pending',$7,NULL,$8,$9,$10,now(),now())\`,
      [
        randomUUID(),
        runId,
        input.sid,
        input.pid,
        'eval-user',
        input.userInputPayload.request_id,
        JSON.stringify(userInputPayload),
        JSON.stringify(resumeHandle),
        new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000).toISOString(),
      ],
    );
    await lifecycle.on_round_start(ctx, {
      session_id: input.sid,
      user_message: input.chosen,
      project_id: input.pid,
      user_id: 'eval-user',
    });
    const written = await ctx.queryOne(
      \`SELECT chosen_value, hit_count
         FROM disambiguation_resolutions
        WHERE project_id=$1 AND source_table=$2 AND source_column=$3
          AND normalized_keyword=$4 AND chosen_value=$5 AND deleted_at IS NULL\`,
      [input.pid, input.table, input.column, normalized, input.chosen],
    );
    const reused = await disambig.DisambiguationService.lookup_by_keyword(ctx, input.pid, input.table, input.column, input.keyword);
    console.log('EVAL_RESULT:' + JSON.stringify({ written, reused }));
  `;
  const child = spawnSync(resolveServerNode(), ['--input-type=module', '-e', script], {
    cwd: APP_ROOT,
    env: { ...process.env, EVAL_PAYLOAD: JSON.stringify(payload) },
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 8,
  });
  if (child.status !== 0) {
    throw new Error(`server db lifecycle failed: ${child.stderr || child.stdout}`);
  }
  const line = String(child.stdout || '').split(/\r?\n/).find((item) => item.startsWith('EVAL_RESULT:'));
  if (!line) throw new Error(`server db lifecycle missing result: ${child.stdout || child.stderr}`);
  return JSON.parse(line.slice('EVAL_RESULT:'.length));
}
