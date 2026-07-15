import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const MCP_TOOL_PREFIX = "mcp_";
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_IDLE_TTL_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const FAILED_PROVIDER_RETRY_MS = 60 * 1000;
const MAX_TOOL_NAME_LENGTH = 64;

const sessionRuntimes = new Map();
let sweepTimer = null;

export function isMcpToolName(name) {
  return typeof name === "string" && name.startsWith(MCP_TOOL_PREFIX);
}

function parseJson(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toBool(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function boolFrom(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return toBool(value);
}

export function normalizeMcpProviderRow(row) {
  if (!row) return null;
  const isActive = boolFrom(row.is_active, true);
  const defaultEnabled = boolFrom(row.default_enabled ?? row.is_enabled, true);
  const enabledOverride =
    row.enabled_override === undefined || row.enabled_override === null ? null : toBool(row.enabled_override);
  const effectiveEnabled =
    row.effective_enabled === undefined || row.effective_enabled === null
      ? isActive && (enabledOverride === null ? defaultEnabled : enabledOverride)
      : toBool(row.effective_enabled);
  return {
    ...row,
    app_provider_id: row.app_provider_id || row.provider_id || row.id,
    transport: row.transport || "stdio",
    args: normalizeArgs(row.args),
    env: normalizeEnv(row.env),
    is_active: isActive,
    default_enabled: defaultEnabled,
    enabled_override: enabledOverride,
    effective_enabled: effectiveEnabled,
    is_enabled: effectiveEnabled,
    last_discovered_at: row.last_discovered_at || null,
    last_error: row.last_error || null,
  };
}

function normalizeArgs(args) {
  const parsed = Array.isArray(args) ? args : parseJson(args, []);
  return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
}

function normalizeEnv(env) {
  const parsed = env && typeof env === "object" && !Array.isArray(env) ? env : parseJson(env, {});
  const out = {};
  for (const [key, value] of Object.entries(parsed || {})) {
    if (!key) continue;
    out[String(key)] = value == null ? "" : String(value);
  }
  return out;
}

function mergedProcessEnv(extraEnv) {
  const merged = {};
  for (const [key, value] of Object.entries({ ...process.env, ...normalizeEnv(extraEnv) })) {
    if (value == null) continue;
    merged[key] = String(value);
  }
  return merged;
}

function isRegularProject(projectId) {
  const s = String(projectId || "");
  return s && s !== "__chat__" && !s.startsWith("folder:");
}

function isMcpWorkspace(projectId) {
  return !!String(projectId || "");
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时(${timeoutMs}ms)`)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function safeToolName(providerName, toolName) {
  const raw = `${MCP_TOOL_PREFIX}${providerName}_${toolName}`;
  const safe = raw
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (safe.length <= MAX_TOOL_NAME_LENGTH) return safe || `${MCP_TOOL_PREFIX}tool`;
  const hash = createHash("sha1").update(raw).digest("hex").slice(0, 8);
  return `${safe.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

function normalizeInputSchema(schema) {
  if (schema && typeof schema === "object" && schema.type === "object") return schema;
  return { type: "object", properties: {}, additionalProperties: true };
}

function formatUnknownContent(part) {
  if (!part) return "";
  if (part.type === "resource") {
    const res = part.resource || {};
    if (typeof res.text === "string") return res.text;
    if (typeof res.uri === "string") return `[resource] ${res.uri}`;
  }
  if (part.type === "resource_link" && typeof part.uri === "string") {
    const label = part.title || part.name;
    return label ? `[${label}] ${part.uri}` : part.uri;
  }
  if (part.type === "audio") {
    return `[audio ${part.mimeType || "unknown"}]`;
  }
  try {
    return JSON.stringify(part);
  } catch {
    return String(part);
  }
}

function normalizeToolResult(result) {
  const structured = result?.structuredContent;
  if (structured !== undefined) {
    return [{ type: "text", text: `structuredContent:\n${JSON.stringify(structured, null, 2)}` }];
  }

  const content = [];
  for (const part of result?.content || []) {
    if (!part) continue;
    if (part.type === "text" && typeof part.text === "string") {
      content.push({ type: "text", text: part.text });
    } else if (part.type === "image" && typeof part.data === "string" && part.data) {
      content.push({ type: "image", data: part.data, mimeType: part.mimeType || "image/png" });
    } else {
      const text = formatUnknownContent(part);
      if (text) content.push({ type: "text", text });
    }
  }
  if (!content.length) content.push({ type: "text", text: "MCP 工具已执行,未返回文本内容。" });
  return content;
}

async function listAllTools(connection) {
  const allTools = [];
  let cursor;
  do {
    const result = await connection.client.listTools(cursor ? { cursor } : undefined, {
      timeout: connection.timeoutMs,
    });
    allTools.push(...(result.tools || []));
    cursor = result.nextCursor;
  } while (cursor);
  return allTools;
}

function resultErrorText(result) {
  const parts = normalizeToolResult(result)
    .map((part) => (part.type === "text" ? part.text : `[${part.mimeType || "image"}]`))
    .join("\n")
    .trim();
  return parts || "MCP 工具返回错误";
}

function stderrTail(chunks) {
  const text = chunks.join("").trim();
  return text.length > 1200 ? text.slice(-1200) : text;
}

function runtimeKey(projectId, sessionId) {
  return `${String(projectId || "")}::${String(sessionId || "__default__")}`;
}

function providerFingerprint(provider) {
  const p = normalizeMcpProviderRow(provider);
  return {
    id: p?.app_provider_id || p?.id,
    provider_name: p?.provider_name,
    transport: p?.transport,
    command: p?.command,
    args: p?.args || [],
    env: p?.env || {},
    is_active: p?.is_active,
    default_enabled: p?.default_enabled,
    enabled_override: p?.enabled_override,
    is_enabled: p?.effective_enabled ?? p?.is_enabled,
    updated_at: p?.updated_at || null,
    deleted_at: p?.deleted_at || null,
  };
}

function providersFingerprint(rows) {
  const stable = (rows || [])
    .map(providerFingerprint)
    .sort((a, b) => String(a.id || a.provider_name).localeCompare(String(b.id || b.provider_name)));
  return createHash("sha1").update(JSON.stringify(stable)).digest("hex");
}

function ensureSweeper() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, runtime] of sessionRuntimes.entries()) {
      if (runtime.activeLeases() > 0) continue;
      if (now - runtime.lastUsedAt() < DEFAULT_IDLE_TTL_MS) continue;
      void runtime.dispose().finally(() => {
        if (sessionRuntimes.get(key) === runtime) sessionRuntimes.delete(key);
      });
    }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

async function loadEnabledProviders(db, projectId) {
  return (await listEffectiveMcpProviders(db, projectId)).filter((provider) => provider.effective_enabled);
}

function bindingOverride(row) {
  if (!row) return null;
  if (Object.prototype.hasOwnProperty.call(row, "enabled_override")) {
    return row.enabled_override === null || row.enabled_override === undefined ? null : toBool(row.enabled_override);
  }
  if (row.is_enabled !== undefined && row.is_enabled !== null) return toBool(row.is_enabled);
  return null;
}

function bindingPayload(row) {
  if (!row) return null;
  return {
    id: row.id,
    project_id: row.project_id,
    provider_id: row.provider_id || null,
    provider_name: row.provider_name,
    enabled_override: bindingOverride(row),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function applyMcpProjectBinding(providerRow, bindingRow, projectId) {
  const base = normalizeMcpProviderRow({
    ...providerRow,
    app_provider_id: providerRow?.id,
    enabled_override: null,
    effective_enabled: null,
  });
  const override = bindingOverride(bindingRow);
  const inherited = override === null || override === undefined;
  const enabledByBinding = inherited ? !!base.default_enabled : !!override;
  const blocked = !base.is_active;
  const effectiveEnabled = !blocked && enabledByBinding;
  return {
    ...base,
    project_id: projectId || null,
    app_provider_id: providerRow?.id || base.app_provider_id || base.id,
    binding: bindingPayload(bindingRow),
    enabled_override: inherited ? null : !!override,
    effective_enabled: effectiveEnabled,
    is_enabled: effectiveEnabled,
    availability: blocked ? "blocked" : effectiveEnabled ? "enabled" : "disabled",
    disabled_reason: blocked ? "App 级总开关已关闭" : effectiveEnabled ? "" : "未启用",
  };
}

export async function listAppMcpProviderRows(db) {
  return await db.query(
    `SELECT id, provider_name, transport, command, args, env, is_active, default_enabled,
            last_discovered_at, last_error, created_at, updated_at
       FROM app_mcp_providers
      WHERE deleted_at IS NULL
      ORDER BY created_at DESC`,
  );
}

async function listProjectMcpBindingRows(db, projectId) {
  if (!isRegularProject(projectId)) return [];
  return await db.query(
    `SELECT id, project_id, provider_id, provider_name, is_enabled, enabled_override, created_at, updated_at
       FROM project_mcp_providers
      WHERE project_id=$1 AND deleted_at IS NULL
      ORDER BY created_at DESC`,
    [projectId],
  ).catch(async () =>
    db.query(
      `SELECT id, project_id, provider_name, is_enabled, created_at, updated_at
         FROM project_mcp_providers
        WHERE project_id=$1 AND deleted_at IS NULL
        ORDER BY created_at DESC`,
      [projectId],
    ).catch(() => []),
  );
}

export async function listEffectiveMcpProviders(db, projectId) {
  const appRows = await listAppMcpProviderRows(db).catch(() => []);
  const bindingRows = await listProjectMcpBindingRows(db, projectId);
  const byProviderId = new Map(bindingRows.filter((row) => row.provider_id).map((row) => [row.provider_id, row]));
  const byName = new Map(bindingRows.map((row) => [row.provider_name, row]));
  return appRows.map((provider) => applyMcpProjectBinding(provider, byProviderId.get(provider.id) || byName.get(provider.provider_name), projectId));
}

export async function connectMcpProvider(provider, options = {}) {
  const normalized = normalizeMcpProviderRow(provider);
  if (!normalized?.command) throw new Error("MCP Provider 缺少 command");
  if (normalized.transport !== "stdio") throw new Error(`暂不支持的 MCP transport: ${normalized.transport}`);

  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const client = new Client({ name: "yiw", version: "0.0.1" });
  const stderrChunks = [];
  const transport = new StdioClientTransport({
    command: normalized.command,
    args: normalizeArgs(normalized.args),
    env: mergedProcessEnv(normalized.env),
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => {
    stderrChunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    if (stderrChunks.length > 20) stderrChunks.shift();
  });

  try {
    await withTimeout(client.connect(transport, { timeout: timeoutMs }), timeoutMs + 1000, "MCP 连接");
    return { client, transport, provider: normalized, timeoutMs, stderrChunks, disposed: false };
  } catch (e) {
    await closeMcpConnection({ client, transport }).catch(() => {});
    const tail = stderrTail(stderrChunks);
    throw new Error(tail ? `${e?.message || e}\n${tail}` : e?.message || String(e));
  }
}

export async function closeMcpConnection(connection) {
  if (!connection || connection.disposed) return;
  connection.disposed = true;
  await Promise.allSettled([connection.client?.close?.(), connection.transport?.close?.()]);
}

export async function discoverMcpProviderTools(provider, options = {}) {
  const connection = await connectMcpProvider(provider, options);
  try {
    const allTools = await listAllTools(connection);
    return {
      provider: connection.provider,
      tools: allTools.map((tool) => ({
        name: tool.name,
        description: tool.description || "",
        inputSchema: normalizeInputSchema(tool.inputSchema),
      })),
    };
  } finally {
    await closeMcpConnection(connection);
  }
}

function createMcpAgentTool({ provider, connection, tool, safeName }) {
  return {
    name: safeName,
    label: `MCP ${provider.provider_name}/${tool.name}`,
    description: `MCP Provider「${provider.provider_name}」工具「${tool.name}」。${tool.description || ""}`.trim(),
    parameters: normalizeInputSchema(tool.inputSchema),
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      if (connection.disposed) throw new Error(`MCP Provider「${provider.provider_name}」连接已释放,请重试。`);
      const result = await connection.client.callTool(
        { name: tool.name, arguments: params || {} },
        undefined,
        {
          signal,
          timeout: connection.timeoutMs,
          resetTimeoutOnProgress: true,
          maxTotalTimeout: Math.max(connection.timeoutMs * 6, 60000),
        },
      );
      if (result?.isError) throw new Error(resultErrorText(result));
      return {
        content: normalizeToolResult(result),
        details: {
          provider_id: provider.app_provider_id || provider.id,
          provider_name: provider.provider_name,
          tool_name: tool.name,
          mcp_tool_name: safeName,
          structuredContent: result?.structuredContent,
          untrustedMcpOutput: true,
        },
      };
    },
  };
}

async function updateMcpProviderDiscoveryState(db, provider, patch) {
  const appProviderId = provider?.app_provider_id || provider?.provider_id || provider?.id;
  if (!appProviderId) return;
  if (patch.ok) {
    await db
      .query(`UPDATE app_mcp_providers SET last_discovered_at=now(), last_error=NULL, updated_at=now() WHERE id=$1`, [appProviderId])
      .catch(() =>
        db
          .query(`UPDATE project_mcp_providers SET last_discovered_at=now(), last_error=NULL, updated_at=now() WHERE id=$1`, [provider?.id])
          .catch(() => {}),
      );
    return;
  }
  await db
    .query(`UPDATE app_mcp_providers SET last_error=$1, updated_at=now() WHERE id=$2`, [patch.error || "", appProviderId])
    .catch(() =>
      db
        .query(`UPDATE project_mcp_providers SET last_error=$1, updated_at=now() WHERE id=$2`, [patch.error || "", provider?.id])
        .catch(() => {}),
    );
}

function createSessionMcpRuntime({ db, projectId, sessionId, timeoutMs, streamCallback }) {
  let currentDb = db;
  let currentTimeoutMs = timeoutMs;
  let currentStreamCallback = streamCallback;
  let currentFingerprint = null;
  let tools = [];
  let connections = [];
  let catalogPromise = null;
  let disposed = false;
  let leases = 0;
  let lastUsed = Date.now();
  let nextRetryAt = 0;

  const markUsed = () => {
    lastUsed = Date.now();
  };

  async function closeConnections() {
    const closing = connections;
    connections = [];
    await Promise.allSettled(closing.map((connection) => closeMcpConnection(connection)));
  }

  async function rebuildCatalog(rows, fingerprint) {
    await closeConnections();
    const nextTools = [];
    const usedToolNames = new Set();
    let providerRetryAt = 0;

    for (const providerRow of rows || []) {
      if (disposed) throw new Error("MCP runtime 已释放");
      const provider = normalizeMcpProviderRow(providerRow);
      try {
        const connection = await connectMcpProvider(provider, { timeoutMs: currentTimeoutMs });
        connections.push(connection);
        const discoveredTools = await listAllTools(connection);
        for (const tool of discoveredTools) {
          let safeName = safeToolName(provider.provider_name, tool.name);
          if (usedToolNames.has(safeName)) {
            const hash = createHash("sha1").update(`${provider.provider_name}:${tool.name}`).digest("hex").slice(0, 8);
            safeName = `${safeName.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
          }
          usedToolNames.add(safeName);
          nextTools.push(createMcpAgentTool({ provider, connection, tool, safeName }));
        }
        await updateMcpProviderDiscoveryState(currentDb, provider, { ok: true });
      } catch (e) {
        const error = e?.message || String(e);
        providerRetryAt = providerRetryAt ? Math.min(providerRetryAt, Date.now() + FAILED_PROVIDER_RETRY_MS) : Date.now() + FAILED_PROVIDER_RETRY_MS;
        console.error("[mcp provider connect]", provider?.provider_name, error);
        await updateMcpProviderDiscoveryState(currentDb, provider, { ok: false, error });
        if (typeof currentStreamCallback === "function") {
          await currentStreamCallback(`MCP Provider「${provider?.provider_name || "unknown"}」连接失败:${error}`, {
            content_type: "thinking",
            title: "MCP",
          }).catch(() => {});
        }
      }
    }

    tools = nextTools;
    currentFingerprint = fingerprint;
    nextRetryAt = providerRetryAt;
    return tools;
  }

  async function getTools() {
    if (disposed) throw new Error("MCP runtime 已释放");
    markUsed();
    if (catalogPromise) return await catalogPromise;

    catalogPromise = (async () => {
      const rows = await loadEnabledProviders(currentDb, projectId).catch((e) => {
        console.error("[mcp tools list]", e?.message || e);
        return [];
      });
      const fingerprint = providersFingerprint(rows);
      const shouldRetryFailedProvider = nextRetryAt > 0 && Date.now() >= nextRetryAt;
      if (fingerprint === currentFingerprint && !shouldRetryFailedProvider) return tools;
      return await rebuildCatalog(rows, fingerprint);
    })().finally(() => {
      catalogPromise = null;
    });
    return await catalogPromise;
  }

  return {
    projectId,
    sessionId,
    updateOptions(options = {}) {
      currentDb = options.db || currentDb;
      currentTimeoutMs = options.timeoutMs;
      currentStreamCallback = options.streamCallback;
    },
    acquireLease() {
      if (disposed) return () => {};
      leases += 1;
      markUsed();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        leases = Math.max(0, leases - 1);
        markUsed();
      };
    },
    activeLeases() {
      return leases;
    },
    lastUsedAt() {
      return lastUsed;
    },
    getTools,
    async dispose() {
      if (disposed) return;
      disposed = true;
      tools = [];
      currentFingerprint = null;
      await closeConnections();
    },
  };
}

function getOrCreateSessionMcpRuntime({ db, projectId, sessionId, timeoutMs, streamCallback }) {
  ensureSweeper();
  const key = runtimeKey(projectId, sessionId);
  let runtime = sessionRuntimes.get(key);
  if (!runtime) {
    runtime = createSessionMcpRuntime({ db, projectId, sessionId, timeoutMs, streamCallback });
    sessionRuntimes.set(key, runtime);
  } else {
    runtime.updateOptions({ db, timeoutMs, streamCallback });
  }
  return runtime;
}

export async function disposeProjectMcpRuntimes(projectId) {
  const prefix = `${String(projectId || "")}::`;
  const targets = [];
  for (const [key, runtime] of sessionRuntimes.entries()) {
    if (!key.startsWith(prefix)) continue;
    sessionRuntimes.delete(key);
    targets.push(runtime.dispose());
  }
  await Promise.allSettled(targets);
}

export async function disposeAllMcpRuntimes() {
  const targets = [];
  for (const [, runtime] of sessionRuntimes.entries()) {
    targets.push(runtime.dispose());
  }
  sessionRuntimes.clear();
  await Promise.allSettled(targets);
}

export async function disposeSessionMcpRuntime({ projectId, sessionId }) {
  const key = runtimeKey(projectId, sessionId);
  const runtime = sessionRuntimes.get(key);
  if (!runtime) return;
  sessionRuntimes.delete(key);
  await runtime.dispose();
}

export async function acquireMcpToolsForSession({ db, projectId, sessionId, streamCallback, timeoutMs } = {}) {
  if (!db?.query || !isMcpWorkspace(projectId)) return { tools: [], release: async () => {} };

  const runtime = getOrCreateSessionMcpRuntime({ db, projectId, sessionId, timeoutMs, streamCallback });
  const release = runtime.acquireLease();
  try {
    return {
      tools: await runtime.getTools(),
      release: async () => release(),
    };
  } catch (e) {
    release();
    const error = e?.message || String(e);
    console.error("[mcp runtime]", error);
    if (typeof streamCallback === "function") {
      await streamCallback(`MCP 工具加载失败:${error}`, {
        content_type: "thinking",
        title: "MCP",
      }).catch(() => {});
    }
    return { tools: [], release: async () => {} };
  }
}
