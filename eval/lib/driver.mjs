// 高层 app 驱动:把"登录 / 建项目 / 导数据 / 绑业务 / 问数取终态块"等真实 app 操作封成可复用 API。
// 全部经 CDP 在真渲染层执行 → window.electronAPI(ipc)→ 进程通道 → registry 用例。零 HTTP。
// 任务文件只用这些高层动作写断言,不碰 CDP/ipc 细节。

import { makeUiDriver } from './ui-driver.mjs';

const DEFAULT_STREAM_TIMEOUT_MS = 360000;
const DEFAULT_QUERY_MODEL_TIMEOUT_MS = 120000;
const DEFAULT_QUERY_MAX_TURNS = 20;

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function makeDriver(session) {
  const ev = session.evalJs;
  const ui = makeUiDriver(session);
  let token = '';

  // 在渲染层发一个 authed apiRequest(一元)
  const api = (method, url, body) =>
    ev(
      `return await window.electronAPI.apiRequest({method:${JSON.stringify(method)},url:${JSON.stringify(url)},` +
        `headers:{'Authorization':'Bearer '+${JSON.stringify(token)},'Content-Type':'application/json'},` +
        `body:${body != null ? JSON.stringify(JSON.stringify(body)) : 'null'}})`,
    );

  const activateProject = async (projectOrId) => {
    let project = typeof projectOrId === 'object' ? projectOrId : null;
    if (!project?.id) {
      const pid = String(projectOrId || '');
      if (!pid) return;
      const detail = await api('GET', `/api/projects/${pid}`).catch(() => null);
      project = detail?.json?.data;
    }
    if (!project?.id) return;

    await ev(`
      const project = ${JSON.stringify(project)};
      const { useProjectStore } = await import('/src/store/project');
      const { eventBus, EVENT_TYPES } = await import('/src/utils/eventBus');
      const store = useProjectStore.getState();
      const projects = store.projects || [];
      if (!projects.some(p => p.id === project.id)) {
        useProjectStore.setState({ projects: [project, ...projects] });
      }
      useProjectStore.getState().setCurrentProject(project);
      eventBus.emit(EVENT_TYPES.REFRESH_HISTORY);
    `).catch(() => {});
  };

  const notifySessionCreated = async (sid, question = '') => {
    if (!sid) return;
    await ev(`
      const { eventBus, EVENT_TYPES } = await import('/src/utils/eventBus');
      eventBus.emit(EVENT_TYPES.NEW_session_CREATED, {
        sessionId: ${JSON.stringify(sid)},
        question: ${JSON.stringify(question || '')},
      });
      eventBus.emit(EVENT_TYPES.REFRESH_HISTORY);
    `).catch(() => {});
  };

  // 驱动真实前端 subscribeStream 取流,按 v1 事件收"终态块"。
  // message.delta 仍按 block_id 合并;工具/Skill 事件保留为语义块,供 runtime eval 断言。
  const streamBlocks = (url, body, { timeoutMs = DEFAULT_STREAM_TIMEOUT_MS } = {}) => {
    const safeTimeoutMs = positiveInt(timeoutMs, DEFAULT_STREAM_TIMEOUT_MS);
    return ev(`
      const { subscribeStream } = await import('/src/utils/api-stream.ts');
      const { createAPIURL } = await import('/src/utils/url-helper.ts');
      const blocks = new Map(); let raw = 0;
      const normalizeToolStatus = (type, payload) => {
        if (payload?.status) return payload.status;
        if (type === 'tool.started') return 'running';
        if (type === 'tool.failed') return 'error';
        return 'done';
      };
      const timeoutMs = ${safeTimeoutMs};
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const req = { url: createAPIURL(${JSON.stringify(url)}), method: 'POST',
        headers: { 'Authorization': 'Bearer ' + ${JSON.stringify(token)}, 'Content-Type': 'application/json', 'Accept-Language': 'zh-CN' },
        body: JSON.stringify(${JSON.stringify(body)}),
        signal: controller.signal };
      try {
        await subscribeStream(req, (line) => {
          if (!line.startsWith('data:')) return;
          const p = line.slice(5).trim(); if (!p || p === '[DONE]') return;
          let e; try { e = JSON.parse(p); } catch { return; }
          raw++;
          if (e.v !== 1 || e.visibility === 'hidden') return;
          const payload = e.payload || {};
          if (e.type === 'message.delta') {
            const cid = payload.block_id != null ? String(payload.block_id) : ('_' + blocks.size);
            const prev = blocks.get(cid) || { content: '' };
            const c = payload.content == null ? '' : (typeof payload.content === 'string' ? payload.content : JSON.stringify(payload.content));
            const mode = payload.mode || 'replace';
            const format = payload.format || (payload.channel === 'thinking' ? 'thinking' : 'text');
            const type = payload.channel === 'thinking' ? 'thinking' : format;
            blocks.set(cid, {
              id: cid,
              type,
              title: payload.title,
              content: mode === 'append' ? (prev.content + c) : c,
              metadata: {
                channel: payload.channel,
                visibility: e.visibility,
                msg_category: payload.msg_category || '',
                usage: payload.usage || null,
                model: payload.model || null,
                ...(payload.metadata || {}),
              },
            });
            return;
          }
          if (e.type === 'tool.started' || e.type === 'tool.completed' || e.type === 'tool.failed') {
            const cid = 'tool:' + String(payload.tool_call_id || blocks.size);
            const name = String(payload.name || '');
            const args = payload.args_preview == null ? '' : String(payload.args_preview);
            const result = payload.result_preview == null ? '' : String(payload.result_preview);
            const status = normalizeToolStatus(e.type, payload);
            blocks.set(cid, {
              id: cid,
              type: 'tool',
              title: status,
              content: [name, args, result].filter(Boolean).join(' '),
              metadata: {
                channel: 'tool',
                visibility: e.visibility,
                tool_name: name,
                skill_name: payload.skill || null,
                status,
                trace_input: payload.input || '',
                trace_output: result,
              },
            });
            return;
          }
          if (e.type === 'tool.output') {
            const cid = 'result:' + String(payload.tool_call_id || blocks.size);
            const name = String(payload.name || '');
            const content = payload.result_preview == null ? '' : String(payload.result_preview);
            blocks.set(cid, {
              id: cid,
              type: 'tool_result',
              title: name,
              content,
              metadata: { channel: 'tool_result', visibility: e.visibility, tool_name: name, trace_output: content },
            });
            return;
          }
          if (e.type === 'skill.selected') {
            const name = String(payload.name || '');
            if (!name) return;
            const cid = 'skill:' + name;
            blocks.set(cid, {
              id: cid,
              type: 'skill',
              title: payload.status || 'selected',
              content: name,
              metadata: { channel: 'skill', visibility: e.visibility, skill_name: name, runtime: payload.runtime || null, reason: payload.reason || '' },
            });
          }
        });
      } catch (err) {
        if (controller.signal.aborted) throw new Error('流式请求超时(' + timeoutMs + 'ms): ' + ${JSON.stringify(url)});
        throw err;
      } finally {
        clearTimeout(timer);
      }
      return { raw, blocks: [...blocks.values()].map(b => ({ id: b.id, type: b.type, title: b.title, content: b.content || '', metadata: b.metadata || {} })).filter(b => b.content) };
    `, { timeoutMs: safeTimeoutMs + 10000 });
  };

  const sleepInPage = (ms) => ev(`await new Promise(r=>setTimeout(r, ${Number(ms) || 0}))`, { timeoutMs: (Number(ms) || 0) + 1000 });

  const poll = async (fn, { timeoutMs = 30000, intervalMs = 500, label = 'condition' } = {}) => {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() <= deadline) {
      try {
        const value = await fn();
        if (value) return value;
      } catch (err) {
        lastError = err;
      }
      await sleepInPage(intervalMs);
    }
    throw new Error(`等待超时: ${label}${lastError ? ` (${lastError.message || lastError})` : ''}`);
  };

  const parseArray = (value) => {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  };

  const parseDataSourceBindings = (payload) => {
    if (Array.isArray(payload?.items)) return payload.items;
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') return [];
    const sourceTypes = {
      database_connections: 'database_connection',
      structured_data_sources: 'structured_data_source',
      unstructured_data_sources: 'unstructured_data_source',
      web_search_models: 'web_search_model',
    };
    return Object.entries(sourceTypes).flatMap(([key, sourceType]) => {
      const items = Array.isArray(payload[key]) ? payload[key] : [];
      return items.map((item) => ({ ...item, source_type: item.source_type || sourceType, source_id: item.source_id || item.id }));
    });
  };

  const projectStoreCurrent = () =>
    ev(`
      const { useProjectStore } = await import('/src/store/project');
      return useProjectStore.getState().currentProject || null;
    `).catch(() => null);

  const listProjects = async () => {
    const list = await api('GET', '/api/projects?per_page=100');
    return list.json?.data?.items || list.json?.data || [];
  };

  const findProjectByName = async (name) => {
    const items = await listProjects();
    return items.find((p) => p.name === name) || null;
  };

  const selectProjectInUi = async (project) => {
    await activateProject(project);
    await poll(
      async () => {
        const cur = await projectStoreCurrent();
        return cur?.id === project.id ? cur : null;
      },
      { timeoutMs: 15000, label: `当前项目 ${project.name}` },
    );
    await ui.goto('/agent');
    await ui.waitFor('[data-testid="agent-message-input"]', { timeout: 15000 }).catch(() => {});
    await ev(`
      const { eventBus, EVENT_TYPES } = await import('/src/utils/eventBus');
      eventBus.emit(EVENT_TYPES.REFRESH_HISTORY);
    `).catch(() => {});
  };

  const createProjectInUi = async (name) => {
    await api('POST', '/api/projects', { name, description: `eval project ${name}` });
    const project = await poll(
      async () => findProjectByName(name),
      { timeoutMs: 20000, label: `创建项目 ${name}` },
    );
    await activateProject(project);
    await poll(
      async () => {
        const cur = await projectStoreCurrent();
        return cur?.id === project.id ? cur : null;
      },
      { timeoutMs: 15000, label: `进入项目 ${name}` },
    );
    await ui.goto('/agent');
    await ui.waitFor('[data-testid="agent-message-input"]', { timeout: 15000 }).catch(() => {});
    return project;
  };

  const firstEmbeddingModelName = () =>
    ev(`
      const { embeddingModelsReq } = await import('/src/api/models');
      const res = await embeddingModelsReq();
      const payload = res?.data;
      const list = Array.isArray(payload) ? payload : payload?.items || payload?.data || [];
      const first = Array.isArray(list) ? list[0] : null;
      return first ? String(first.name || first.model_name || '') : '';
    `).catch(() => '');

  const createStructuredDataSource = async (pid, dsName) => {
    await activateProject(pid);
    const existing = await api('GET', `/api/projects/${pid}/structured-datasources`).catch(() => null);
    const existingItems = existing?.json?.data?.items || existing?.json?.data || [];
    const found = existingItems.find((item) => item.name === dsName);
    if (found?.id) return found.id;

    const embedding = await firstEmbeddingModelName();
    const body = {
      name: dsName,
      description: `eval structured datasource ${dsName}`,
    };
    if (embedding) body.embedding_model_name = embedding;
    const created = await api('POST', `/api/projects/${pid}/structured-datasources`, body);
    const row = created?.json?.data;
    if (!row?.id) throw new Error('创建结构化数据源失败: ' + JSON.stringify(created?.json).slice(0, 160));
    return row.id;
  };

  const createUnstructuredDataSource = async (pid, name) => {
    await activateProject(pid);
    const existing = await api('GET', `/api/projects/${pid}/unstructured-datasources`).catch(() => null);
    const existingItems = existing?.json?.data?.items || existing?.json?.data || [];
    const found = existingItems.find((item) => item.name === name);
    if (found?.id) return found.id;

    const embedding = await firstEmbeddingModelName();
    const body = {
      name,
      description: `eval unstructured datasource ${name}`,
    };
    if (embedding) body.embedding_model_name = embedding;
    const created = await api('POST', `/api/projects/${pid}/unstructured-datasources`, body);
    const row = created?.json?.data;
    if (!row?.id) throw new Error('创建非结构化数据源失败: ' + JSON.stringify(created?.json).slice(0, 160));
    return row.id;
  };

  const readMessages = async (pid, sid) => {
    const mr = await api('GET', `/api/projects/${pid}/sessions/${sid}/messages`);
    const data = mr.json?.data;
    return Array.isArray(data) ? data : (data?.messages || data?.items || []);
  };

  const normalizeBlocks = (items) =>
    parseArray(items).map((b) => ({
      id: b.id || b.content_id,
      type: b.type || b.content_type || b.display_type,
      title: b.title,
      content: b.content == null ? '' : (typeof b.content === 'string' ? b.content : JSON.stringify(b.content)),
      display_type: b.display_type,
      metadata: b.metadata || {},
    })).filter((b) => b.content);

  const lastAssistantBlocks = (messages) => {
    const assistant = messages.filter((m) => m.role === 'assistant').pop();
    if (!assistant) return [];
    return normalizeBlocks(assistant.content_items);
  };

  const waitForAssistantResult = async (pid, sid, { minAssistantCount = 1, timeoutMs = 180000 } = {}) => {
    return poll(
      async () => {
        const messages = await readMessages(pid, sid).catch(() => []);
        const assistants = messages.filter((m) => m.role === 'assistant');
        if (assistants.length < minAssistantCount) return null;
        const blocks = lastAssistantBlocks(messages);
        return blocks.length ? { raw: messages.length, blocks } : null;
      },
      { timeoutMs, intervalMs: 1000, label: `会话 ${sid} assistant 结果` },
    );
  };

  const ensureAgentPage = async () => {
    await ui.goto('/agent');
    await ui.waitFor('[data-testid="agent-message-input"]', { timeout: 15000 }).catch(() => {});
  };

  const createQuerySession = async (pid, question) => {
    await activateProject(pid);
    await ensureAgentPage();
    const session = await api('POST', `/api/projects/${pid}/sessions`, {
      source_type: 'agent',
      source_id: pid,
      action_type: 'agentic_chat',
      title: String(question || '').slice(0, 50) || 'eval',
      description: question,
    });
    const sid = session.json?.data?.id || session.json?.data?.session_id;
    if (!sid) throw new Error('创建问数会话失败: ' + JSON.stringify(session.json).slice(0, 180));
    return sid;
  };

  const runQueryTurn = async (pid, sid, question, { minAssistantCount = 1, timeoutMs = DEFAULT_STREAM_TIMEOUT_MS } = {}) => {
    const out = await streamBlocks(
      `/api/agent/projects/${pid}/sessions/${sid}/chat`,
      {
        message: question,
        settings: {
          timeoutMs: DEFAULT_QUERY_MODEL_TIMEOUT_MS,
          maxQueryTurns: DEFAULT_QUERY_MAX_TURNS,
        },
      },
      { timeoutMs },
    );
    if (out.blocks?.length) return out;
    return waitForAssistantResult(pid, sid, { minAssistantCount });
  };

  return {
    ui,
    raw: { api, streamBlocks, ev, cdp: session.cdp },

    /** app 本地自动鉴权:强制 builtin-login 拿固定 owner token(全零 DESKTOP_USER_ID)。
     *  不读前端 store 缓存的 token —— 它可能对应历史孤儿用户(随机 UUID),
     *  导致建项目/会话用错 userId → owner 看不到数据(desktop_ids.js 注释的回归)。 */
    async login() {
      token = await ev(
        `const r=await window.electronAPI.apiRequest({method:'GET',url:'/api/user/builtin-login',headers:{}}); ` +
          `const t=r.json?.data?.access_token||''; ` +
          `const ui=r.json?.data?.user_info||{}; ` +
          `const {useBasicStore}=await import('/src/store/basic'); ` +
          `useBasicStore.setState({token:t,userInfo:{userId:ui.user_id,username:ui.username,email:ui.email,avatar:ui.avatar_url,is_admin:ui.is_admin||false,can_create_project:ui.can_create_project||false}}); ` +
          `const raw=localStorage.getItem('tour-options'); let tour={}; try{tour=raw?JSON.parse(raw):{}}catch{}; ` +
          `const uid=String(ui.user_id||''); if(uid){tour['admin-project-mode-onboarding']={...(tour['admin-project-mode-onboarding']||{}),[uid]:true}; localStorage.setItem('tour-options',JSON.stringify(tour));} ` +
          `return t;`,
        { timeoutMs: 10000 },
      );
      if (!token) throw new Error('login 失败:无 token');
      return token;
    },

    /**
     * 获取或创建项目(同名复用)。eval 每次跑同一个 task 应复用同一项目,不堆积工作区。
     * 先按 name 查找已有项目(未删除),有就清理旧数据源后返回;无则新建。
     */
    async ensureProject(name) {
      const existing = await findProjectByName(name);
      if (existing) {
        // 清理旧数据源(避免重复导入冲突)
        await this._cleanDataSources(existing.id).catch(() => {});
        await selectProjectInUi(existing);
        return existing.id;
      }
      // 新建
      return this.createProject(name);
    },

    /** 只准备项目记录,不导航前端页面。适合模型/集成等纯配置类 eval。 */
    async ensureProjectRecord(name) {
      const existing = await findProjectByName(name);
      if (existing?.id) return existing.id;
      const created = await api('POST', '/api/projects', { name, description: `eval project ${name}` });
      const row = created?.json?.data;
      if (row?.id) return row.id;
      const project = await poll(
        async () => findProjectByName(name),
        { timeoutMs: 20000, label: `创建项目记录 ${name}` },
      );
      return project.id;
    },

    /** 清理项目下的数据源绑定(structured/db/unstructured),让导入从干净状态开始 */
    async _cleanDataSources(pid) {
      // 软删旧数据源绑定(business_data_sources)
      const ds = await api('GET', `/api/projects/${pid}/data-sources`).catch(() => null);
      const bindings = parseDataSourceBindings(ds?.json?.data);
      for (const b of bindings) {
        const st = b.source_type || '';
        const si = b.source_id || b.id || '';
        await api('DELETE', `/api/projects/${pid}/data-sources`, { source_type: st, source_id: si }).catch(() => {});
      }
    },

    async createProject(name) {
      const project = await createProjectInUi(name);
      return project.id;
    },

    /**
     * 导入结构化文件到项目。后端 process 自动把数据源绑到项目(business_data_sources.project_id),
     * 故「导入即可问数」,无需任何「业务」步骤。fixturePath 是后端可读的本地绝对路径。
     * 返回 { dsid, connId, table }。
     */
    async importTable(pid, fixturePath, { dsName = 'eval-ds' } = {}) {
      const dsid = await createStructuredDataSource(pid, dsName);
      const paths = Array.isArray(fixturePath) ? fixturePath : [fixturePath];

      const created = await api('POST', `/api/projects/${pid}/structured-documents/create`, {
        data_source_id: dsid,
        file_paths: paths,
      });
      const createdDocs = created?.json?.data?.created_documents || [];
      const documentIds = createdDocs.map((d) => d.document_id).filter(Boolean);
      const processBody = { data_source_id: dsid };
      if (documentIds.length) processBody.document_ids = documentIds;
      const processed = await api('POST', `/api/projects/${pid}/structured-documents/process`, processBody);
      const failed = (processed?.json?.data?.processed || []).filter((d) => /failed/i.test(d.status || ''));
      if (failed.length) {
        throw new Error(`结构化导入失败: ${failed.map((d) => d.error || d.document_id).join(', ')}`);
      }

      let connId = processed?.json?.data?.database_connection_id;
      if (!connId) {
        const detail = await poll(
          async () => {
            const ds = await api('GET', `/api/projects/${pid}/structured-datasources/${dsid}`).catch(() => null);
            return ds?.json?.data?.database_connection_id ? ds.json.data : null;
          },
          { timeoutMs: 60000, intervalMs: 1000, label: `结构化导入 ${dsName}` },
        );
        connId = detail.database_connection_id;
      }
      const tableRows = await poll(
        async () => {
          const tr = await api('GET', `/api/projects/${pid}/databases/${connId}/tables?per_page=100`).catch(() => null);
          const items = tr?.json?.data?.items || [];
          return items.length ? items : null;
        },
        { timeoutMs: 60000, intervalMs: 1000, label: `结构化表 ${dsName}` },
      );
      const tables = tableRows.map((t) => t.table_name || t.name).filter(Boolean);
      const table = tables[0];
      return { dsid, connId, table, tables, jobs: processed?.json?.data?.job ? [processed.json.data.job] : [] };
    },

    /** 问数引擎(NL2SQL):建会话(指向数据源)→ 流式 chat → 返回终态块。 */
    async askQuery(pid, connId, question) {
      void connId;
      const sid = await createQuerySession(pid, question);
      await notifySessionCreated(sid, question);
      const out = await runQueryTurn(pid, sid, question);
      await notifySessionCreated(sid, question);
      return { sid, ...out };
    },

    /** yiw 通用 agent:建 __chat__ 或项目会话 → 流式 → 返回终态块。 */
    async askAgent(pid, message, { title = 'eval', approval = null } = {}) {
      const sess = await api('POST', `/api/projects/${pid}/sessions`, {
        title,
        source_type: 'agent',
        source_id: pid,
        action_type: 'agentic_chat',
      });
      const sid = sess.json?.data?.id || sess.json?.data?.session_id || sess.json?.data;
      if (!sid) throw new Error('建 agent 会话失败: ' + JSON.stringify(sess.json).slice(0, 150));
      await notifySessionCreated(sid, message);
      const body = { message };
      if (approval) body.approval = approval;
      const out = await streamBlocks(`/api/agent/projects/${pid}/sessions/${sid}/chat`, body);
      await notifySessionCreated(sid, message);
      return { sid, ...out };
    },

    /**
     * yiw 通用 agent 多轮:同一 session 内连续 chat,不显式传 skill。
     * 用于验证项目 chat 的自动 Skill 选择和多轮上下文链路。
     */
    async askAgentMultiTurn(pid, questions, { title = 'eval-multiturn' } = {}) {
      const list = Array.isArray(questions) ? questions : [questions].filter(Boolean);
      const sess = await api('POST', `/api/projects/${pid}/sessions`, {
        title,
        source_type: 'agent',
        source_id: pid,
        action_type: 'agentic_chat',
      });
      const sid = sess.json?.data?.id || sess.json?.data?.session_id || sess.json?.data;
      if (!sid) throw new Error('建 agent 多轮会话失败: ' + JSON.stringify(sess.json).slice(0, 150));

      const firstMessage = list.find(Boolean) || title;
      await notifySessionCreated(sid, firstMessage);
      const results = [];
      let assistantCount = 0;
      for (const message of list) {
        if (!message) {
          results.push({ sid, raw: 0, blocks: [] });
          continue;
        }
        assistantCount += 1;
        const out = await streamBlocks(`/api/agent/projects/${pid}/sessions/${sid}/chat`, { message });
        const result = out.blocks?.length
          ? out
          : await waitForAssistantResult(pid, sid, { minAssistantCount: assistantCount });
        results.push({ sid, ...result });
      }
      await notifySessionCreated(sid, list.filter(Boolean).at(-1) || firstMessage);
      return results;
    },

    // ═══════════════════════════════════════════════════════
    // KDD Cup 导入方法(复刻 Python importer 的 project 级端点链,去 business)
    // ═══════════════════════════════════════════════════════

    /**
     * 导入数据库文件(sqlite/duckdb)到项目。复刻 Python _import_database 7 步链。
     * dbPath = 后端可读的本地绝对路径;extraNotes = knowledge.md 文本(注入列描述)。
     * 返回 { connId, tables }。
     */
    async importDatabase(pid, dbPath, { name, extraNotes = '' } = {}) {
      const stem = name || dbPath.replace(/.*\//, '').replace(/\.\w+$/, '');
      const isSqlite = /\.sqlite3?$|\.db$/i.test(dbPath);
      const dbType = isSqlite ? 'SQLite' : 'DuckDB';

      await activateProject(pid);
      const uploaded = await api('POST', `/api/projects/${pid}/databases/upload-db-file`, { file_path: dbPath });
      const databasePath = uploaded?.json?.data?.path || dbPath;
      const conn = await api('POST', `/api/projects/${pid}/databases`, {
        name: stem,
        db_type: dbType,
        host: databasePath,
        database: databasePath,
        description: `eval database ${stem}`,
      });
      const connId = conn?.json?.data?.id;
      if (!connId) throw new Error('创建数据库连接失败: ' + JSON.stringify(conn?.json).slice(0, 160));

      const synced = await api('POST', `/api/projects/${pid}/databases/${connId}/sync-schema`, {});
      const tableRows = await poll(
        async () => {
          const tr = await api('GET', `/api/projects/${pid}/databases/${connId}/tables?per_page=100`).catch(() => null);
          const items = tr?.json?.data?.items || [];
          return items.length ? items : null;
        },
        { timeoutMs: 60000, intervalMs: 1000, label: `数据库表同步 ${stem}` },
      );

      const tables = tableRows.map(t => ({ id: t.id, name: t.table_name || t.name }));
      // 生成列描述/示例值/向量,与页面同步后的后台增强保持一致;失败不阻断导入。
      const tableIds = tables.map(t => t.id);
      const descBody = { connection_id: connId, table_ids: tableIds, only_pending: false };
      if (extraNotes) descBody.extra_notes = extraNotes;
      await api('POST', `/api/projects/${pid}/databases/generate-columns-descriptions`, descBody).catch(e => console.warn('  [importDatabase] generate-desc 跳过:', e?.message?.slice(0,80)));
      await ev('await new Promise(r=>setTimeout(r,5000))');
      await api('POST', `/api/projects/${pid}/databases/${connId}/tables/batch_sync_example_values`, { table_ids: tableIds, limit: 3 }).catch(() => {});
      await api('POST', `/api/projects/${pid}/databases/${connId}/tables/store-vectors`, { table_ids: tableIds, only_pending: false }).catch(() => {});
      await ev('await new Promise(r=>setTimeout(r,3000))');
      return { connId, tables, jobs: synced?.json?.data?.job ? [synced.json.data.job] : [] };
    },

    /**
     * 导入非结构化文档(doc/*.md 等)。复刻 Python _import_unstructured。
     * files = 后端可读的本地绝对路径数组。返回 { dsid }。
     */
    async importUnstructured(pid, files, { name = 'eval-docs' } = {}) {
      const dsid = await createUnstructuredDataSource(pid, name);
      const paths = Array.isArray(files) ? files : [files];

      const documentIds = [];
      const jobs = [];
      for (const filePath of paths) {
        const created = await api('POST', `/api/projects/${pid}/unstructured-datasources/${dsid}/documents`, {
          file_path: filePath,
        });
        const docId = created?.json?.data?.document?.id;
        if (docId) documentIds.push(docId);
        if (created?.json?.data?.job) jobs.push(created.json.data.job);
      }

      await poll(
        async () => {
          const lr = await api('GET', `/api/projects/${pid}/unstructured-datasources/${dsid}/documents?per_page=100`).catch(() => null);
          const docs = lr?.json?.data?.items || lr?.json?.data || [];
          const currentDocs = documentIds.length ? docs.filter((d) => documentIds.includes(d.id)) : docs.slice(0, paths.length);
          if (currentDocs.length < paths.length) return null;
          const terminal = currentDocs.every(d => /completed|done|ready|failed/i.test(d.status || ''));
          if (!terminal) return null;
          const failed = currentDocs.filter(d => /failed/i.test(d.status || ''));
          if (failed.length) throw new Error(`非结构化文档处理失败: ${failed.map(d => d.error_msg || d.title || d.id).join(', ')}`);
          return currentDocs;
        },
        { timeoutMs: 180000, intervalMs: 3000, label: `非结构化导入 ${name}` },
      );
      return { dsid, documentIds, jobs };
    },

    /**
     * 问数并抽取列向量(用于 column_match 断言)。
     * 优先从 streamBlocks 的 table 块抽;若 stream 没收到 table,降级从持久化 messages 读。
     * 返回 { sid, blocks, raw, columns: [[v1,v2,...], ...] }。
     */
    async askQueryColumns(pid, connId, question) {
      const r = await this.askQuery(pid, connId, question);
      let columns = extractColumnsFromBlocks(r.blocks || []);
      // 降级:stream 没收到 table 块时,从持久化 messages 读
      if (!columns.length && r.sid) {
        const mr = await api('GET', `/api/projects/${pid}/sessions/${r.sid}/messages`);
        const data = mr.json?.data;
        const msgs = Array.isArray(data) ? data : (data?.items || data?.messages || []);
        const lastAssistant = msgs.filter(m => m.role === 'assistant').pop();
        if (lastAssistant) {
          const items = typeof lastAssistant.content_items === 'string'
            ? JSON.parse(lastAssistant.content_items) : lastAssistant.content_items;
          columns = extractColumnsFromBlocks(items || []);
        }
      }
      return { ...r, columns };
    },

    /**
     * 多轮问数(同一 session 内连续问,对齐 Python send_question 的多 turn 逻辑)。
     * @param {string} pid
     * @param {string} connId
     * @param {string[]} questions 多轮问题
     * @returns {Promise<Array>} 每轮的 { sid, blocks, raw, columns }
     */
    async askQueryMultiTurn(pid, connId, questions) {
      void connId;
      const firstQuestion = questions.find(Boolean) || '';
      if (!firstQuestion) return questions.map(() => ({ sid: '', blocks: [], raw: 0, columns: [] }));
      const sid = await createQuerySession(pid, firstQuestion);
      const results = [];
      let assistantCount = 0;
      await notifySessionCreated(sid, firstQuestion);

      for (const q of questions) {
        if (!q) {
          results.push({ sid, blocks: [], raw: 0, columns: [] });
          continue;
        }

        assistantCount += 1;
        const out = await runQueryTurn(pid, sid, q, { minAssistantCount: assistantCount });
        // 列向量抽取(同 askQueryColumns 逻辑,含 messages 降级)
        let columns = extractColumnsFromBlocks(out.blocks || []);
        if (!columns.length) {
          const mr = await api('GET', `/api/projects/${pid}/sessions/${sid}/messages`);
          const data = mr.json?.data;
          const msgs = Array.isArray(data) ? data : (data?.items || data?.messages || []);
          const lastAssistant = msgs.filter(m => m.role === 'assistant').pop();
          if (lastAssistant) {
            const items = typeof lastAssistant.content_items === 'string' ? JSON.parse(lastAssistant.content_items) : lastAssistant.content_items;
            columns = extractColumnsFromBlocks(items || []);
          }
        }
        results.push({ sid, ...out, columns });
      }
      await notifySessionCreated(sid, questions.filter(Boolean).at(-1) || '');
      return results;
    },

    /**
     * 应用人工 schema 描述(表描述 + 列描述 + 重建向量)。
     * 对齐 Python _apply_schema_descriptions。descriptions 格式:{tables:[{table,description,columns:{col:desc}}]}
     */
    async applySchemaDescriptions(pid, connId, descriptions) {
      const tables = (descriptions.tables || []);
      if (!tables.length) return;
      // 1. 取现有表列表(建 table_name → table_id 映射)
      const tr = await api('GET', `/api/projects/${pid}/databases/${connId}/tables?per_page=200`);
      const tableItems = tr.json?.data?.items || [];
      const tableMap = {};
      for (const t of tableItems) {
        const name = (t.table_name || t.name || '').toLowerCase();
        if (name && t.id) tableMap[name] = t.id;
      }
      const touchedIds = [];
      for (const spec of tables) {
        const tname = (spec.table || '').trim().toLowerCase();
        const tableId = tableMap[tname];
        if (!tableId) continue;
        // 2. 写表描述
        if (spec.description) {
          await api('PUT', `/api/projects/${pid}/databases/${connId}/tables/${tableId}`, { description: spec.description }).catch(() => {});
        }
        // 3. 批量写列描述
        const colDescs = spec.columns || {};
        if (Object.keys(colDescs).length) {
          // 取列列表
          const cr = await api('GET', `/api/projects/${pid}/databases/${connId}/tables/${tableId}/columns`).catch(() => null);
          const cols = cr?.json?.data?.items || cr?.json?.data || [];
          const payload = [];
          for (const col of cols) {
            const cname = (col.column_name || col.name || '').toLowerCase();
            if (cname && colDescs[cname]) {
              payload.push({ column_id: col.id, description: colDescs[cname] });
            }
          }
          if (payload.length) {
            await api('PUT', `/api/projects/${pid}/databases/${connId}/tables/${tableId}/columns`, { columns: payload }).catch(() => {});
            touchedIds.push(tableId);
          }
        }
      }
      // 4. 重建向量(异步,不阻塞——zszq 12 张大表向量化要几分钟)
      if (touchedIds.length) {
        await api('POST', `/api/projects/${pid}/databases/${connId}/tables/store-vectors`, { table_ids: touchedIds, only_pending: false }).catch(() => {});
        console.log(`  [applySchemaDescriptions] 向量重建已触发(${touchedIds.length} 表,后台异步)`);
      }
    },

    /** 注册实体列配置。该配置目前没有稳定前端入口,作为 eval 数据布置动作留在 driver 内部。 */
    async registerEntityColumn(pid, connId, ec) {
      const tables = await api('GET', `/api/projects/${pid}/databases/${connId}/tables?per_page=100`);
      const items = tables.json?.data?.items || [];
      const tbl = items.find((t) => (t.table_name || t.name) === ec.table);
      if (!tbl) return;
      await api('POST', `/api/projects/${pid}/databases/${connId}/entity_mapping_configs`, {
        table_id: tbl.id,
        column_name: ec.column,
        rule: ec.rule || null,
      }).catch(() => {});
    },

    /** 创建指标视图。属于不可见的评测数据准备,任务层不直接访问后端。 */
    async createMetricView(pid, mv) {
      await api('POST', `/api/projects/${pid}/metric-views`, {
        name: mv.name,
        description: mv.description || '',
        aliases: mv.aliases || [],
        tables: mv.tables || [],
        projections: mv.projections || [],
        fixed_predicates: mv.fixed_predicates || [],
        query_dimensions: mv.query_dimensions || [],
        time_dimension: mv.time_dimension || null,
        group_by: mv.group_by || [],
        sort_spec: mv.sort_spec || null,
        source_id: mv.source_id || null,
        status: mv.status || 'active',
      }).catch(() => {});
    },

    /** 注入 knowledge.md 到 agent rules。前端暂无对应配置流,所以作为 driver 内部准备步骤。 */
    async injectKnowledge(pid, knowledge) {
      if (!knowledge) return;
      for (const agentType of ['super_agent', 'nl2sql']) {
        try {
          const cur = await api('GET', `/api/agents/projects/${pid}/agents/config/${agentType}`);
          const curData = cur.json?.data || {};
          await api('POST', `/api/agents/projects/${pid}/agents/config`, {
            name: `eval_${agentType}`,
            agent_type: agentType,
            rules: knowledge,
            model_id: curData.model_id || null,
            system_prompt: curData.system_prompt || '',
            user_prompt_template: curData.user_prompt_template || '',
          });
        } catch (e) {
          console.warn(`  [injectKnowledge] 注入 ${agentType} rules 失败(忽略):`, e?.message?.slice(0, 80));
        }
      }
    },

    close: session.close,
  };
}

/** 从块数组(items/blocks)抽取列向量。
 * 优先最终结构化表块,再退到最终 Markdown 答案,最后回退到普通非中间表格块。
 */
export function extractColumnsFromBlocks(blocks) {
  const list = Array.isArray(blocks) ? blocks.filter(Boolean) : [];
  const finalTableBlocks = list
    .filter((b) => isFinalAnswerBlock(b) && !isIntermediateBlock(b) && isTableLikeBlock(b))
    .reverse();
  for (const b of finalTableBlocks) {
    const cols = extractColumnsFromBlock(b);
    if (cols.length) return cols;
  }

  const finalBlocks = list
    .filter((b) => isFinalAnswerBlock(b) && !isIntermediateBlock(b))
    .reverse();
  for (const b of finalBlocks) {
    const cols = extractColumnsFromBlock(b);
    if (cols.length) return cols;
  }

  const markdownBlocks = list
    .filter((b) => /markdown|text/i.test(b.type || '') && String(b.content || '').includes('|'))
    .reverse();
  for (const b of markdownBlocks) {
    const cols = extractColumnsFromMarkdown(String(b.content || ''));
    if (cols.length) return cols;
  }

  const tableBlocks = list.filter((b) => isTableLikeBlock(b) && !isIntermediateBlock(b)).reverse();
  for (const b of tableBlocks) {
    const cols = extractColumnsFromBlock(b);
    if (cols.length) return cols;
  }
  return [];
}

function isFinalAnswerBlock(block) {
  const category = block?.metadata?.msg_category || block?.msg_category || '';
  const meta = block?.metadata || {};
  if (meta.savable_to_panel || meta.recall) return true;
  if (/final_(result|answer)|answer_table/i.test(category)) return true;
  if (/回答|最终|final/i.test(block?.title || '')) return true;
  return false;
}

function isIntermediateBlock(block) {
  const category = block?.metadata?.msg_category || block?.msg_category || '';
  if (/intermediate|tool_(result|detail)/i.test(category)) return true;
  if (/中间结果|空结果诊断/i.test(block?.title || '')) return true;
  return false;
}

function isTableLikeBlock(block) {
  return /table/i.test(block?.type || '') || /table/i.test(block?.display_type || '') || /table/i.test(block?.title || '');
}

function extractColumnsFromBlock(block) {
  const jsonCols = extractColumnsFromJsonContent(block?.content);
  if (jsonCols.length) return jsonCols;
  if (/markdown|text/i.test(block?.type || '') || String(block?.content || '').includes('|')) {
    return extractColumnsFromMarkdown(String(block?.content || ''));
  }
  return [];
}

function extractColumnsFromJsonContent(content) {
  let obj = content;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); }
    catch { return []; }
  }
  if (!obj || typeof obj !== 'object') return [];

  const rows = Array.isArray(obj.data)
    ? obj.data
    : Array.isArray(obj.rows)
      ? obj.rows
      : Array.isArray(obj.table?.data)
        ? obj.table.data
        : [];
  if (!rows.length) return [];

  if (typeof rows[0] === 'object' && !Array.isArray(rows[0])) {
    const colNames = columnNamesFromMetadata(obj).filter((name) => Object.prototype.hasOwnProperty.call(rows[0], name));
    const names = colNames.length ? colNames : [...new Set(rows.flatMap((r) => Object.keys(r)))];
    return names.map((name) => rows.map((r) => r[name]));
  }

  if (Array.isArray(rows[0])) {
    const ncol = Math.max(...rows.map((row) => Array.isArray(row) ? row.length : 0));
    const columns = [];
    for (let c = 0; c < ncol; c++) columns.push(rows.map((row) => row?.[c]));
    return columns;
  }

  return [rows];
}

function columnNamesFromMetadata(obj) {
  const candidates = [];
  if (Array.isArray(obj.fields)) candidates.push(...obj.fields);
  if (Array.isArray(obj.columns)) candidates.push(...obj.columns);
  if (Array.isArray(obj.table?.columns)) candidates.push(...obj.table.columns);
  return candidates
    .map((field) => {
      if (typeof field === 'string') return field;
      if (!field || typeof field !== 'object') return '';
      return field.name || field.key || field.dataIndex || field.field || field.column_name || field.id || '';
    })
    .filter(Boolean);
}

function extractColumnsFromMarkdown(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  let lastRows = null;
  for (let i = 0; i < lines.length - 1; i++) {
    const header = parseMarkdownTableRow(lines[i]);
    const separator = parseMarkdownTableRow(lines[i + 1]);
    if (!header.length || !isMarkdownSeparatorRow(separator)) continue;

    const rows = [];
    for (let j = i + 2; j < lines.length; j++) {
      const row = parseMarkdownTableRow(lines[j]);
      if (!row.length) break;
      rows.push(row);
    }
    if (rows.length) {
      lastRows = rows;
      i += rows.length + 1;
    }
  }
  if (!lastRows?.length) return [];
  const ncol = Math.max(...lastRows.map((row) => row.length));
  const columns = [];
  for (let c = 0; c < ncol; c++) columns.push(lastRows.map((row) => row[c] ?? ''));
  return columns;
}

function parseMarkdownTableRow(line) {
  const raw = String(line || '').trim();
  if (!raw.includes('|')) return [];
  const trimmed = raw.replace(/^\|/, '').replace(/\|$/, '');
  const cells = trimmed.split('|').map(cleanMarkdownCell);
  return cells.some((cell) => cell !== '') ? cells : [];
}

function cleanMarkdownCell(cell) {
  return String(cell ?? '')
    .trim()
    .replace(/^`([^`]*)`$/g, '$1')
    .replace(/^\*\*([^*]*)\*\*$/g, '$1')
    .trim();
}

function isMarkdownSeparatorRow(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(String(cell || '').replace(/\s+/g, '')));
}
